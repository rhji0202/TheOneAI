import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { AppError } from '../common/errors/app-error.js';
import { type Page, toPage } from '../common/http/pagination.js';
import type { ArtifactView } from '../artifacts/artifact-views.js';
import { toArtifactView } from '../artifacts/artifact-views.js';
import { PrismaService, type TenantTx } from '../infrastructure/database/prisma.service.js';
import type { WidgetSession } from '../widget/widget-session.js';
import { type ApprovalView, toApprovalView } from './approval-views.js';
import { parseStoredPlan, type PlanStep } from './plan.js';
import { TaskControlService } from './task-control.service.js';
import {
  TASK_GROUPS,
  type TaskGroup,
  taskSummarySelect,
  toTaskSummary,
  type TaskSummaryView,
} from './task-views.js';

export const resumeInputSchema = z.object({
  mode: z.enum(['checkpoint', 'restart']).default('checkpoint'),
});
export type ResumeInput = z.infer<typeof resumeInputSchema>;
export const steerInputSchema = z.object({ text: z.string().trim().min(1).max(2_000) });
export type SteerInput = z.infer<typeof steerInputSchema>;

export const taskListQuerySchema = z.object({
  group: z.enum(['active', 'completed', 'failed']).default('active'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.uuid().optional(),
});
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;

const verificationSchema = z.object({
  checks: z.array(z.object({ label: z.string(), passed: z.boolean() })).default([]),
});

/** docs/api-spec.md §2.3 TaskDetail */
export interface TaskDetailView extends Omit<TaskSummaryView, 'pendingApproval'> {
  plan: { version: number; steps: PlanStep[]; revisedReason: string | null } | null;
  pendingApproval: ApprovalView | null;
  result: {
    messageId: string | null;
    verification: Array<{ label: string; passed: boolean }>;
    summary: {
      steps: number;
      toolCalls: number;
      retries: number;
      replans: number;
      durationMs: number;
    };
    artifacts: ArtifactView[];
  } | null;
  lastEventId: string | null;
}

@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly control: TaskControlService,
  ) {}

  async list(session: WidgetSession, query: TaskListQuery): Promise<Page<TaskSummaryView>> {
    const rows = await this.prisma.withTenant(session.tenantId, (tx) =>
      tx.task.findMany({
        where: {
          endUserId: session.endUserId,
          agentId: session.agentId,
          status: { in: TASK_GROUPS[query.group as TaskGroup] },
          ...(query.cursor ? { id: { lt: query.cursor } } : {}),
        },
        select: taskSummarySelect,
        orderBy: { id: 'desc' },
        take: query.limit + 1,
      }),
    );
    return toPage(rows, query.limit, toTaskSummary);
  }

  async get(session: WidgetSession, taskId: string): Promise<TaskDetailView> {
    return this.prisma.withTenant(session.tenantId, async (tx) => {
      const task = await tx.task.findFirst({
        where: { id: taskId, endUserId: session.endUserId },
        select: {
          ...taskSummarySelect,
          plan: true,
          retryCount: true,
          replanCount: true,
          startedAt: true,
        },
      });
      if (!task) throw AppError.notFound('작업을 찾을 수 없습니다');

      const { pendingApproval: _, ...summary } = toTaskSummary(task);
      const lastEvent = await tx.taskEvent.findFirst({
        where: { taskId },
        orderBy: { id: 'desc' },
        select: { id: true },
      });

      return {
        ...summary,
        plan: parseStoredPlan(task.plan),
        pendingApproval: await this.pendingApproval(tx, taskId),
        result: task.status === 'completed' ? await this.result(tx, task) : null,
        lastEventId: lastEvent?.id.toString() ?? null,
      };
    });
  }

  /**
   * 중지 (docs/api-spec.md §2.4)
   *  - queued · waiting_approval · paused: 즉시 cancelled (실행 중인 Worker 없음)
   *  - running · recovering: cancel_requested_at 만 기록 → Worker 가 현재 단계를 마친 뒤 종료
   */
  /** 중지 · 재개 · 추가 지시는 TaskControlService 가 처리한다 (콘솔과 같은 규칙) */
  cancel(session: WidgetSession, taskId: string): Promise<TaskSummaryView> {
    return this.control.cancel(session.tenantId, taskId, { endUserId: session.endUserId });
  }

  resume(session: WidgetSession, taskId: string, input: ResumeInput): Promise<TaskSummaryView> {
    return this.control.resume(
      session.tenantId,
      taskId,
      { endUserId: session.endUserId },
      { mode: input.mode },
    );
  }

  steer(session: WidgetSession, taskId: string, input: SteerInput): Promise<{ messageId: string }> {
    return this.control.steer(
      session.tenantId,
      taskId,
      { endUserId: session.endUserId },
      input.text,
    );
  }

  /** SSE 구독 전 소유 확인 */
  async assertOwned(session: WidgetSession, taskId: string): Promise<void> {
    const task = await this.prisma.withTenant(session.tenantId, (tx) =>
      tx.task.findFirst({
        where: { id: taskId, endUserId: session.endUserId },
        select: { id: true },
      }),
    );
    if (!task) throw AppError.notFound('작업을 찾을 수 없습니다');
  }

  private async pendingApproval(tx: TenantTx, taskId: string): Promise<ApprovalView | null> {
    const approval = await tx.approval.findFirst({
      where: { taskId, status: 'pending' },
      orderBy: { createdAt: 'desc' },
    });
    if (!approval) return null;
    const policy = await tx.toolPolicy.findFirst({
      where: { level: approval.permissionLevel },
      select: { allowTaskScope: true },
    });
    return toApprovalView(approval, policy);
  }

  private async result(
    tx: TenantTx,
    task: {
      id: string;
      completedSteps: number;
      retryCount: number;
      replanCount: number;
      startedAt: Date | null;
      finishedAt: Date | null;
    },
  ): Promise<NonNullable<TaskDetailView['result']>> {
    // 인터랙티브 트랜잭션은 연결 하나를 쓰므로 순차 실행한다.
    const message = await tx.message.findFirst({
      where: { taskId: task.id, role: 'assistant' },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    const evaluation = await tx.taskStep.findFirst({
      where: { taskId: task.id, type: 'evaluate', status: 'succeeded' },
      orderBy: { seq: 'desc' },
      select: { evaluation: true },
    });
    const toolCalls = await tx.toolExecution.count({ where: { taskId: task.id } });
    const artifacts = await tx.artifact.findMany({
      where: { taskId: task.id, origin: 'task_output' },
      orderBy: { createdAt: 'asc' },
    });
    const durationMs =
      task.startedAt && task.finishedAt ? task.finishedAt.getTime() - task.startedAt.getTime() : 0;
    return {
      messageId: message?.id ?? null,
      verification: verificationSchema.catch({ checks: [] }).parse(evaluation?.evaluation ?? {})
        .checks,
      summary: {
        steps: task.completedSteps,
        toolCalls,
        retries: task.retryCount,
        replans: task.replanCount,
        durationMs,
      },
      artifacts: artifacts.map(toArtifactView),
    };
  }
}
