import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { AdminSession } from '../../admin/auth/admin-session.js';
import { AppError } from '../../common/errors/app-error.js';
import { type Page, toPage } from '../../common/http/pagination.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { toArtifactView } from '../../artifacts/artifact-views.js';
import { toMessageView } from '../../conversations/message-views.js';
import { type ApprovalView, taskScopeAllowed, toApprovalView } from '../approval-views.js';
import type { PlanStep } from '../plan.js';
import { taskSummarySelect, toTaskSummary, type TaskSummaryView } from '../task-views.js';

export const adminTaskQuerySchema = z.object({
  status: z
    .enum([
      'queued',
      'running',
      'waiting_approval',
      'paused',
      'recovering',
      'completed',
      'failed',
      'cancelled',
    ])
    .optional(),
  agentId: z.uuid().optional(),
  endUserId: z.uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.uuid().optional(),
});
export type AdminTaskQuery = z.infer<typeof adminTaskQuerySchema>;

export interface AdminTaskRow extends TaskSummaryView {
  agentName: string;
  /** 고객사 사용자 ID 를 그대로 보여 주지 않는다 */
  endUserPseudonym: string;
  elapsedMs: number;
  workerId: string | null;
  recoveryCount: number;
}

const rowSelect = {
  ...taskSummarySelect,
  agent: { select: { name: true } },
  endUserId: true,
  endUser: { select: { pseudonym: true } },
  startedAt: true,
  workerId: true,
  recoveryCount: true,
} satisfies Prisma.TaskSelect;

type Row = Prisma.TaskGetPayload<{ select: typeof rowSelect }>;

/** 단계 종류 → 모델 역할 (토큰 사용량 분해) */
const ROLE_OF_STEP: Record<string, 'planner' | 'executor' | 'evaluator' | null> = {
  context: null,
  plan: 'planner',
  reason: 'executor',
  tool: null,
  skill: 'executor',
  respond: 'executor',
  evaluate: 'evaluator',
};

/** 콘솔 작업 조회 (C-02) — 목록 · 실행 트레이스 · 단계 상세 */
@Injectable()
export class TasksAdminService {
  constructor(private readonly prisma: PrismaService) {}

  async list(admin: AdminSession, q: AdminTaskQuery): Promise<Page<AdminTaskRow>> {
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      const rows = await tx.task.findMany({
        where: {
          ...(q.status ? { status: q.status } : {}),
          ...(q.agentId ? { agentId: q.agentId } : {}),
          ...(q.endUserId ? { endUserId: q.endUserId } : {}),
          ...(q.from || q.to
            ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lt: q.to } : {}) } }
            : {}),
          ...(q.cursor ? { id: { lt: q.cursor } } : {}),
        },
        orderBy: { id: 'desc' },
        take: q.limit + 1,
        select: rowSelect,
      });
      return toPage(rows, q.limit, toRow);
    });
  }

  async trace(admin: AdminSession, taskId: string) {
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      const task = await tx.task.findUnique({
        where: { id: taskId },
        select: {
          ...rowSelect,
          traceId: true,
          triggerMessageId: true,
          inputTokens: true,
          outputTokens: true,
          costAmount: true,
          costCurrency: true,
          retryCount: true,
          replanCount: true,
          agentVersion: { select: { version: true } },
          registryVersion: { select: { version: true } },
        },
      });
      if (!task) throw AppError.notFound();
      // 한 트랜잭션(연결 하나)이므로 차례로 읽는다
      const steps = await tx.taskStep.findMany({ where: { taskId }, orderBy: { seq: 'asc' } });
      const planEvents = await tx.taskEvent.findMany({
        where: { taskId, type: { in: ['plan.created', 'plan.revised'] } },
        orderBy: { id: 'asc' },
      });
      const approvals = await tx.approval.findMany({
        where: { taskId },
        orderBy: { createdAt: 'asc' },
      });
      const toolStats = await tx.toolExecution.aggregate({
        where: { taskId },
        _count: { _all: true },
        _sum: { attempt: true },
      });
      const policies = await tx.toolPolicy.findMany({
        select: { level: true, allowTaskScope: true, mode: true },
      });
      const byRole = { planner: zero(), executor: zero(), evaluator: zero() };
      for (const step of steps) {
        const role = ROLE_OF_STEP[step.type];
        if (!role) continue;
        byRole[role].inputTokens += step.inputTokens;
        byRole[role].outputTokens += step.outputTokens;
      }
      const toolCalls = toolStats._count._all;
      return {
        task: {
          ...toRow(task),
          agentVersion: task.agentVersion.version,
          registryVersion: task.registryVersion.version,
          traceId: task.traceId,
          usage: { inputTokens: task.inputTokens, outputTokens: task.outputTokens, byRole },
          cost: { amount: task.costAmount.toString(), currency: task.costCurrency },
        },
        stats: {
          steps: { completed: task.completedSteps, total: task.totalSteps },
          toolCalls,
          retries: Math.max(0, (toolStats._sum.attempt ?? 0) - toolCalls),
          replans: task.replanCount,
          recoveries: task.recoveryCount,
        },
        plans: planEvents.map((e) => {
          const data = e.payload as { planVersion: number; steps: PlanStep[]; reason?: string };
          return {
            version: data.planVersion,
            steps: data.steps,
            reason: data.reason ?? null,
            createdAt: e.createdAt.toISOString(),
          };
        }),
        steps: steps.map((s) => ({
          id: s.id,
          seq: s.seq,
          planIndex: s.planIndex,
          type: s.type,
          name: s.name,
          status: s.status,
          summary: s.summary,
          parallelGroup: s.parallelGroup,
          durationMs: s.durationMs,
          checkpoint: s.checkpointAt
            ? { label: `cp-${s.seq}`, at: s.checkpointAt.toISOString() }
            : null,
        })),
        artifacts: (
          await tx.artifact.findMany({
            where: {
              uploadedAt: { not: null },
              OR: [
                { taskId },
                ...(task.triggerMessageId ? [{ messageId: task.triggerMessageId }] : []),
              ],
            },
            orderBy: { createdAt: 'asc' },
          })
        ).map((a) => ({ ...toArtifactView(a), origin: a.origin })),
        feedback: (
          await tx.feedback.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' } })
        ).map((f) => ({
          rating: f.rating,
          comment: f.comment,
          createdAt: f.createdAt.toISOString(),
        })),
        approvals: approvals.map((a): ApprovalView =>
          toApprovalView(
            a,
            taskScopeAllowed(a, policies.find((p) => p.level === a.permissionLevel) ?? null),
          ),
        ),
      };
    });
  }

  /** 대화 기록 (C-02 “대화 보기”) — 메시지와 그 대화의 작업 */
  async conversation(admin: AdminSession, conversationId: string) {
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      const conversation = await tx.conversation.findUnique({
        where: { id: conversationId },
        include: { endUser: { select: { pseudonym: true } }, agent: { select: { name: true } } },
      });
      if (!conversation) throw AppError.notFound();
      const messages = await tx.message.findMany({
        where: { conversationId },
        orderBy: { id: 'asc' },
        take: 500,
      });
      const tasks = await tx.task.findMany({
        where: { conversationId },
        orderBy: { id: 'asc' },
        select: { id: true, title: true, status: true, createdAt: true },
      });
      return {
        id: conversation.id,
        title: conversation.title,
        agentName: conversation.agent.name,
        endUserPseudonym: conversation.endUser.pseudonym,
        summary: conversation.summary,
        createdAt: conversation.createdAt.toISOString(),
        messages: messages.map(toMessageView),
        tasks: tasks.map((t) => ({ ...t, createdAt: t.createdAt.toISOString() })),
      };
    });
  }

  async step(admin: AdminSession, taskId: string, stepId: string) {
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      const step = await tx.taskStep.findFirst({ where: { id: stepId, taskId } });
      if (!step) throw AppError.notFound();
      const executions = await tx.toolExecution.findMany({
        where: { stepId },
        orderBy: { startedAt: 'asc' },
      });
      return {
        id: step.id,
        seq: step.seq,
        planVersion: step.planVersion,
        planIndex: step.planIndex,
        type: step.type,
        name: step.name,
        status: step.status,
        attempts: step.attempts,
        parallelGroup: step.parallelGroup,
        input: step.input,
        output: step.output,
        evaluation: step.evaluation,
        summary: step.summary,
        usage: { inputTokens: step.inputTokens, outputTokens: step.outputTokens },
        startedAt: step.startedAt?.toISOString() ?? null,
        finishedAt: step.finishedAt?.toISOString() ?? null,
        durationMs: step.durationMs,
        checkpoint: step.checkpointAt
          ? { at: step.checkpointAt.toISOString(), data: step.checkpoint }
          : null,
        toolExecutions: executions.map((e) => ({
          id: e.id,
          toolName: e.toolName,
          source: e.source,
          status: e.status,
          attempt: e.attempt,
          deniedReason: e.deniedReason,
          input: e.input,
          output: e.output,
          errorCode: e.errorCode,
          errorMessage: e.errorMessage,
          durationMs: e.durationMs,
        })),
      };
    });
  }
}

function toRow(task: Row): AdminTaskRow {
  const started = task.startedAt ?? task.createdAt;
  return {
    ...toTaskSummary(task),
    agentName: task.agent.name,
    endUserPseudonym: task.endUser.pseudonym,
    elapsedMs: (task.finishedAt ?? new Date()).getTime() - started.getTime(),
    workerId: task.workerId,
    recoveryCount: task.recoveryCount,
  };
}

function zero() {
  return { inputTokens: 0, outputTokens: 0 };
}
