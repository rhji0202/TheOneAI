import { Injectable } from '@nestjs/common';
import { AppError } from '../common/errors/app-error.js';
import { isUniqueViolation } from '../common/errors/prisma-errors.js';
import { uuidv7 } from '../common/uuid.js';
import { type TaskEventEnvelope, TaskEventsService } from '../events/task-events.service.js';
import type { TaskStatus } from '../generated/prisma/client.js';
import { PrismaService, type TenantTx } from '../infrastructure/database/prisma.service.js';
import { TaskQueueService } from '../infrastructure/queue/task-queue.service.js';
import { BillingService } from '../billing/billing.service.js';
import {
  isBudgetExhausted,
  taskSummarySelect,
  toTaskSummary,
  type TaskSummaryView,
} from './task-views.js';

/** 위젯(사용자 본인) 또는 콘솔(테넌트 전체)의 작업 제어 범위 */
export interface ControlScope {
  /** 위젯: 이 사용자의 작업만 */
  endUserId?: string;
}

const STEERABLE: TaskStatus[] = ['queued', 'running', 'waiting_approval', 'recovering', 'paused'];

/**
 * 작업 제어 (docs/api-spec.md §2.4 · §4.2) — 중지 · 일시정지 · 재개 · 추가 지시.
 * 상태를 읽는 순간부터 행을 잠가 Worker 의 claim · 완료와 경쟁하지 않는다.
 */
@Injectable()
export class TaskControlService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: TaskEventsService,
    private readonly queue: TaskQueueService,
    private readonly billing: BillingService,
  ) {}

  async cancel(
    tenantId: string,
    taskId: string,
    scope: ControlScope,
    reason = 'user_cancelled',
  ): Promise<TaskSummaryView> {
    const outcome = await this.prisma.withTenant(tenantId, async (tx) => {
      const task = await this.lock(tx, taskId, scope);
      const now = new Date();
      const events: TaskEventEnvelope[] = [];
      switch (task.status) {
        case 'queued':
        case 'waiting_approval':
        case 'paused': {
          await tx.task.update({
            where: { id: taskId },
            data: { status: 'cancelled', cancelRequestedAt: now, finishedAt: now },
          });
          // 대기 중인 승인은 취소 — 위젯 승인 카드를 닫는다
          const pending = await tx.approval.findMany({
            where: { taskId, status: 'pending' },
            select: { id: true },
          });
          await tx.approval.updateMany({
            where: { taskId, status: 'pending' },
            data: { status: 'cancelled', resolvedAt: now },
          });
          await tx.taskStep.updateMany({
            where: { taskId, status: 'waiting_approval' },
            data: { status: 'cancelled', finishedAt: now },
          });
          for (const approval of pending) {
            events.push(
              await this.events.append(tx, tenantId, taskId, 'approval.resolved', {
                approvalId: approval.id,
                status: 'cancelled',
                decidedBy: 'system',
              }),
            );
          }
          events.push(
            await this.events.append(tx, tenantId, taskId, 'task.status', {
              status: 'cancelled',
              reason,
            }),
          );
          break;
        }
        case 'running':
        case 'recovering':
          // 실행 중이면 Worker 가 현재 단계를 안전하게 끝낸 뒤 cancelled 로 바꾼다
          await tx.task.update({ where: { id: taskId }, data: { cancelRequestedAt: now } });
          break;
        default:
          throw new AppError(409, 'TASK_NOT_ACTIVE');
      }
      return {
        summary: await this.summary(tx, taskId),
        events,
        removeJob: task.status === 'queued',
      };
    });
    await this.events.publish(taskId, ...outcome.events);
    // 대기 중인 시작 Job 은 지운다 (재개 Job 은 claim 에서 상태를 보고 건너뛴다)
    if (outcome.removeJob) await this.queue.remove(taskId);
    return toTaskSummary(outcome.summary);
  }

  /** 일시정지 — 실행 중이면 현재 단계를 마친 뒤 멈춘다 (checkpoint 유지) */
  async pause(
    tenantId: string,
    taskId: string,
    scope: ControlScope,
    reason = 'operator_paused',
  ): Promise<TaskSummaryView> {
    const outcome = await this.prisma.withTenant(tenantId, async (tx) => {
      const task = await this.lock(tx, taskId, scope);
      let event: TaskEventEnvelope | null = null;
      switch (task.status) {
        case 'queued':
        case 'waiting_approval':
          await tx.task.update({
            where: { id: taskId },
            data: { status: 'paused', pausedReason: reason },
          });
          event = await this.events.append(tx, tenantId, taskId, 'task.status', {
            status: 'paused',
            reason,
          });
          break;
        case 'running':
        case 'recovering':
          await tx.task.update({
            where: { id: taskId },
            data: { pauseRequestedAt: new Date(), pausedReason: reason },
          });
          break;
        default:
          throw new AppError(409, 'TASK_NOT_ACTIVE');
      }
      return { summary: await this.summary(tx, taskId), event };
    });
    if (outcome.event) await this.events.publish(taskId, outcome.event);
    return toTaskSummary(outcome.summary);
  }

  /**
   * 재개 (failed · paused). checkpoint = 마지막(또는 지정한) checkpoint 부터, restart = 계획부터 다시.
   * 같은 대화에 진행 중인 다른 작업이 있으면 TASK_ALREADY_ACTIVE.
   */
  async resume(
    tenantId: string,
    taskId: string,
    scope: ControlScope,
    opts: { mode: 'checkpoint' | 'restart'; fromStepId?: string },
  ): Promise<TaskSummaryView> {
    let outcome: {
      summary: Awaited<ReturnType<TaskControlService['summary']>>;
      event: TaskEventEnvelope;
      fromStepId?: string;
    };
    try {
      outcome = await this.prisma.withTenant(tenantId, async (tx) => {
        const task = await this.lock(tx, taskId, scope);
        if (task.status !== 'failed' && task.status !== 'paused')
          throw new AppError(409, 'TASK_NOT_RESUMABLE');
        if (isBudgetExhausted(task.failure_code)) throw new AppError(409, 'TASK_BUDGET_EXHAUSTED');
        await this.billing.assertWithinBudget(tx, tenantId);
        let fromStepId: string | undefined;
        if (opts.mode === 'checkpoint') {
          fromStepId = opts.fromStepId ?? task.last_checkpoint_step_id ?? undefined;
          const step = fromStepId
            ? await tx.taskStep.findFirst({
                where: { id: fromStepId, taskId, checkpointAt: { not: null } },
                select: { id: true },
              })
            : null;
          if (!step) throw new AppError(409, 'CHECKPOINT_NOT_FOUND');
        }
        await tx.task.update({
          where: { id: taskId },
          data: {
            status: 'queued',
            failureCode: null,
            failureMessage: null,
            finishedAt: null,
            pauseRequestedAt: null,
            pausedReason: null,
            cancelRequestedAt: null,
            workerId: null,
            queuedAt: new Date(),
          },
        });
        const event = await this.events.append(tx, tenantId, taskId, 'task.status', {
          status: 'queued',
          reason: opts.mode === 'restart' ? 'restart_requested' : 'resume_requested',
        });
        return { summary: await this.summary(tx, taskId), event, fromStepId };
      });
    } catch (err) {
      if (isUniqueViolation(err, 'tasks_one_active_per_conversation'))
        throw new AppError(409, 'TASK_ALREADY_ACTIVE');
      throw err;
    }
    await this.events.publish(taskId, outcome.event);
    await this.queue.enqueueResume(
      { tenantId, taskId, fromStepId: outcome.fromStepId, restart: opts.mode === 'restart' },
      { kind: 'resume', n: uuidv7() },
    );
    return toTaskSummary(outcome.summary);
  }

  /** 실행 중 추가 지시 — 메시지로 남기고, Agent Loop 가 다음 단계부터 반영한다 */
  async steer(
    tenantId: string,
    taskId: string,
    scope: ControlScope,
    text: string,
  ): Promise<{ messageId: string }> {
    const outcome = await this.prisma.withTenant(tenantId, async (tx) => {
      const task = await this.lock(tx, taskId, scope);
      if (!STEERABLE.includes(task.status)) throw new AppError(409, 'TASK_NOT_ACTIVE');
      const message = await tx.message.create({
        data: {
          id: uuidv7(),
          tenantId,
          conversationId: task.conversation_id,
          role: 'user',
          content: [{ type: 'text', text }],
          taskId,
        },
      });
      await tx.conversation.update({
        where: { id: task.conversation_id },
        data: { lastMessageAt: message.createdAt },
      });
      const event = await this.events.append(tx, tenantId, taskId, 'task.steered', {
        messageId: message.id,
        text,
      });
      return { messageId: message.id, event };
    });
    await this.events.publish(taskId, outcome.event);
    return { messageId: outcome.messageId };
  }

  private async lock(tx: TenantTx, taskId: string, scope: ControlScope) {
    const rows = scope.endUserId
      ? await tx.$queryRaw<LockedTask[]>`
          SELECT status, conversation_id, last_checkpoint_step_id, failure_code FROM tasks
          WHERE id = ${taskId}::uuid AND end_user_id = ${scope.endUserId}::uuid FOR UPDATE`
      : await tx.$queryRaw<LockedTask[]>`
          SELECT status, conversation_id, last_checkpoint_step_id, failure_code FROM tasks
          WHERE id = ${taskId}::uuid FOR UPDATE`;
    const task = rows[0];
    if (!task) throw AppError.notFound('작업을 찾을 수 없습니다');
    return task;
  }

  private summary(tx: TenantTx, taskId: string) {
    return tx.task.findUniqueOrThrow({ where: { id: taskId }, select: taskSummarySelect });
  }
}

interface LockedTask {
  status: TaskStatus;
  conversation_id: string;
  last_checkpoint_step_id: string | null;
  failure_code: string | null;
}
