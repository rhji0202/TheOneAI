import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { executionPolicySchema, memoryPolicySchema } from '../agents/agent-policies.js';
import {
  AGENT_RUNTIME,
  type AgentRuntime,
  RuntimeError,
  type RunResult,
  TaskCancelledError,
  TaskPausedError,
  WorkerStopError,
} from '../agent-runtime/agent-runtime.js';
import {
  type Checkpoint,
  type ResumeState,
  RunContext,
  type TaskRunInfo,
} from '../agent-runtime/run-context.js';
import { contentBlockSchema } from '../conversations/message-views.js';
import { type TaskEventEnvelope, TaskEventsService } from '../events/task-events.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService, type TenantTx } from '../infrastructure/database/prisma.service.js';
import type { AgentTaskJobData } from '../infrastructure/queue/queues.js';
import { TaskQueueService } from '../infrastructure/queue/task-queue.service.js';
import { parseStoredPlan } from '../tasks/plan.js';

export const HEARTBEAT_MS = 15_000;

export type ExecutionOutcome =
  'completed' | 'cancelled' | 'failed' | 'paused' | 'handed_over' | 'skipped';

/**
 * 작업 1건의 실행 수명주기 (docs/api-spec.md §6)
 *   claim(queued|recovering → running) → (재개면 checkpoint 로드) → heartbeat → AgentRuntime.run
 *   → completed | cancelled | failed | paused | (Worker 종료 시) recovering 으로 넘기기
 */
@Injectable()
export class TaskExecutionService {
  private readonly logger = new Logger(TaskExecutionService.name);
  /** 이 Worker 에서 실행 중인 작업 — 종료 시 checkpoint 기준으로 넘긴다 */
  private readonly active = new Map<string, AbortController>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: TaskEventsService,
    private readonly queue: TaskQueueService,
    @Inject(AGENT_RUNTIME) private readonly runtime: AgentRuntime,
  ) {}

  /** Worker 종료 — 실행 중 작업을 멈추고(현재 단계는 실패로 남김) recovering 으로 넘긴다 */
  async shutdown(timeoutMs = 10_000): Promise<void> {
    const pending = [...this.active.values()];
    for (const controller of pending) controller.abort(new WorkerStopError('worker_shutdown'));
    const deadline = Date.now() + timeoutMs;
    while (this.active.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /**
   * 장애 시뮬레이션 · 운영 도구: 이 Worker 가 죽은 것처럼 작업을 놓는다.
   * 상태는 running 으로 남고(heartbeat 만 끊김), agent-recovery 가 찾아 재개한다.
   */
  abandon(taskId: string): boolean {
    const controller = this.active.get(taskId);
    if (!controller) return false;
    controller.abort(new WorkerStopError('ownership_lost'));
    return true;
  }

  isRunning(taskId: string): boolean {
    return this.active.has(taskId);
  }

  async execute(job: AgentTaskJobData, workerId: string): Promise<ExecutionOutcome> {
    const { tenantId, taskId } = job;
    const claim = await this.claim(job, workerId);
    if (claim.kind !== 'claimed') return claim.kind;

    const controller = new AbortController();
    this.active.set(taskId, controller);
    const ctx = new RunContext(this.prisma, this.events, claim.info, controller, {
      nextSeq: claim.nextSeq,
      plan: claim.plan,
      resume: claim.resume,
      priorUsage: claim.priorUsage,
    });

    const heartbeat = setInterval(
      () => void this.beat(tenantId, taskId, workerId, controller),
      HEARTBEAT_MS,
    );
    const deadline = setTimeout(
      () =>
        controller.abort(new RuntimeError('TIME_LIMIT_EXCEEDED', '최대 실행 시간을 넘었습니다')),
      claim.info.executionPolicy.maxDurationSec * 1_000,
    );

    try {
      const result = await this.runtime.run(ctx);
      await this.complete(ctx, result);
      return 'completed';
    } catch (err) {
      if (err instanceof TaskCancelledError) {
        await this.finishCancelled(ctx);
        return 'cancelled';
      }
      if (err instanceof TaskPausedError) {
        await this.finishPaused(ctx, err.reason);
        return 'paused';
      }
      if (err instanceof WorkerStopError) {
        if (err.reason === 'worker_shutdown') await this.handOver(ctx);
        return 'handed_over';
      }
      await this.finishFailed(ctx, err);
      return 'failed';
    } finally {
      clearInterval(heartbeat);
      clearTimeout(deadline);
      this.active.delete(taskId);
    }
  }

  private async claim(
    job: AgentTaskJobData,
    workerId: string,
  ): Promise<
    | {
        kind: 'claimed';
        info: TaskRunInfo;
        nextSeq: number;
        plan: ReturnType<typeof parseStoredPlan>;
        resume: ResumeState | null;
        priorUsage: { inputTokens: number; outputTokens: number };
      }
    | { kind: 'skipped' | 'cancelled' }
  > {
    const { tenantId, taskId } = job;
    const outcome = await this.prisma.withTenant(tenantId, async (tx) => {
      const task = await tx.task.findUnique({
        where: { id: taskId },
        include: {
          agentVersion: {
            select: { systemPrompt: true, executionPolicy: true, memoryPolicy: true },
          },
          triggerMessage: { select: { content: true } },
        },
      });
      if (!task || (task.status !== 'queued' && task.status !== 'recovering')) {
        return { kind: 'skipped' as const, events: [] as TaskEventEnvelope[] };
      }
      const now = new Date();
      if (task.cancelRequestedAt) {
        await tx.task.update({
          where: { id: taskId },
          data: { status: 'cancelled', finishedAt: now },
        });
        const event = await this.events.append(tx, tenantId, taskId, 'task.status', {
          status: 'cancelled',
          reason: 'user_cancelled',
        });
        return { kind: 'cancelled' as const, events: [event] };
      }
      const updated = await tx.task.updateMany({
        where: { id: taskId, status: task.status },
        data: {
          status: 'running',
          workerId,
          lastHeartbeatAt: now,
          startedAt: task.startedAt ?? now,
        },
      });
      if (updated.count === 0)
        return { kind: 'skipped' as const, events: [] as TaskEventEnvelope[] };

      const event = await this.events.append(tx, tenantId, taskId, 'task.status', {
        status: 'running',
        ...(job.mode === 'resume' ? { reason: job.restart ? 'restarted' : 'resumed' } : {}),
      });
      const resume =
        job.mode === 'resume' && !job.restart
          ? await this.loadCheckpoint(
              tx,
              taskId,
              job.fromStepId ?? task.lastCheckpointStepId,
              task.status,
            )
          : null;
      const lastStep = await tx.taskStep.findFirst({
        where: { taskId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      const info: TaskRunInfo = {
        id: task.id,
        tenantId,
        title: task.title,
        conversationId: task.conversationId,
        endUserId: task.endUserId,
        agentId: task.agentId,
        agentVersionId: task.agentVersionId,
        registryVersionId: task.registryVersionId,
        triggerMessageId: task.triggerMessageId,
        triggerText: textOf(task.triggerMessage?.content),
        systemPrompt: task.agentVersion.systemPrompt,
        executionPolicy: executionPolicySchema.parse(task.agentVersion.executionPolicy ?? {}),
        memoryPolicy: memoryPolicySchema.parse(task.agentVersion.memoryPolicy ?? {}),
      };
      return {
        kind: 'claimed' as const,
        events: [event],
        info,
        nextSeq: (lastStep?.seq ?? 0) + 1,
        plan: parseStoredPlan(task.plan),
        resume,
        priorUsage: { inputTokens: task.inputTokens, outputTokens: task.outputTokens },
      };
    });

    await this.events.publish(taskId, ...outcome.events);
    if (outcome.kind !== 'claimed') {
      this.logger.debug(`작업 ${taskId}: ${outcome.kind}`);
      return { kind: outcome.kind };
    }
    return {
      kind: 'claimed',
      info: outcome.info,
      nextSeq: outcome.nextSeq,
      plan: outcome.plan,
      resume: outcome.resume,
      priorUsage: outcome.priorUsage,
    };
  }

  /** 재개 기준 checkpoint (없거나 형식이 맞지 않으면 처음부터) */
  private async loadCheckpoint(
    tx: TenantTx,
    taskId: string,
    stepId: string | null,
    previousStatus: string,
  ): Promise<ResumeState | null> {
    if (!stepId) return null;
    const step = await tx.taskStep.findFirst({
      where: { id: stepId, taskId },
      select: { id: true, checkpoint: true },
    });
    const checkpoint = step?.checkpoint as Checkpoint | null | undefined;
    if (!step || !checkpoint || typeof checkpoint.nextPlanIndex !== 'number') return null;
    return {
      checkpoint,
      fromStepId: step.id,
      reason: previousStatus === 'recovering' ? 'recover' : 'resume',
    };
  }

  /**
   * heartbeat 갱신 + 긴 단계 실행 중에도 중지 요청을 감지한다.
   * 이 Worker 가 더 이상 작업의 주인이 아니면(복구 잡이 다른 Worker 에 넘김) 바로 멈춘다 — 두 Worker 가 같은 작업을 돌지 않도록.
   */
  private async beat(
    tenantId: string,
    taskId: string,
    workerId: string,
    controller: AbortController,
  ): Promise<void> {
    try {
      const row = await this.prisma.withTenant(tenantId, async (tx) => {
        const owned = await tx.task.updateMany({
          where: { id: taskId, status: 'running', workerId },
          data: { lastHeartbeatAt: new Date() },
        });
        const task = await tx.task.findUnique({
          where: { id: taskId },
          select: { cancelRequestedAt: true },
        });
        return { owned: owned.count > 0, cancelRequestedAt: task?.cancelRequestedAt ?? null };
      });
      if (controller.signal.aborted) return;
      if (row.cancelRequestedAt) controller.abort(new TaskCancelledError());
      else if (!row.owned) controller.abort(new WorkerStopError('ownership_lost'));
    } catch (err) {
      this.logger.warn(`heartbeat 실패 (${taskId}): ${String(err)}`);
    }
  }

  private async complete(ctx: RunContext, result: RunResult): Promise<void> {
    const { tenantId, id: taskId } = ctx.task;
    await this.commit(tenantId, taskId, async (tx) => {
      const now = new Date();
      const task = await tx.task.update({
        where: { id: taskId },
        data: {
          status: 'completed',
          finishedAt: now,
          inputTokens: { increment: ctx.usage.inputTokens },
          outputTokens: { increment: ctx.usage.outputTokens },
        },
        select: { startedAt: true, completedSteps: true, retryCount: true, replanCount: true },
      });
      const toolCalls = await tx.toolExecution.count({ where: { taskId } });
      return this.events.append(tx, tenantId, taskId, 'task.completed', {
        result: {
          messageId: result.messageId,
          verification: result.verification,
          summary: {
            steps: task.completedSteps,
            toolCalls,
            retries: task.retryCount,
            replans: task.replanCount,
            durationMs: task.startedAt ? now.getTime() - task.startedAt.getTime() : 0,
          },
          artifacts: [],
        },
      });
    });
  }

  private async finishCancelled(ctx: RunContext): Promise<void> {
    const { tenantId, id: taskId } = ctx.task;
    await this.commit(tenantId, taskId, async (tx) => {
      await tx.task.update({
        where: { id: taskId },
        data: { status: 'cancelled', finishedAt: new Date(), ...usageIncrement(ctx) },
      });
      await tx.taskStep.updateMany({
        where: { taskId, status: 'running' },
        data: { status: 'cancelled' },
      });
      return this.events.append(tx, tenantId, taskId, 'task.status', {
        status: 'cancelled',
        reason: 'user_cancelled',
      });
    });
  }

  /** 일시정지 — 현재 단계까지의 checkpoint 를 그대로 두고 멈춘다 (재개 API 로 이어서) */
  private async finishPaused(ctx: RunContext, reason: string): Promise<void> {
    const { tenantId, id: taskId } = ctx.task;
    await this.commit(tenantId, taskId, async (tx) => {
      await tx.task.update({
        where: { id: taskId },
        data: {
          status: 'paused',
          pausedReason: reason,
          pauseRequestedAt: null,
          workerId: null,
          ...usageIncrement(ctx),
        },
      });
      return this.events.append(tx, tenantId, taskId, 'task.status', { status: 'paused', reason });
    });
  }

  /** Worker 종료 — recovering 으로 바꾸고 곧바로 재개 Job 을 넣는다 (checkpoint 부터) */
  private async handOver(ctx: RunContext): Promise<void> {
    const { tenantId, id: taskId } = ctx.task;
    const count = await this.prisma.withTenant(tenantId, async (tx) => {
      const task = await tx.task.update({
        where: { id: taskId },
        data: {
          status: 'recovering',
          workerId: null,
          lastHeartbeatAt: new Date(),
          recoveryCount: { increment: 1 },
          ...usageIncrement(ctx),
        },
        select: { recoveryCount: true },
      });
      await tx.taskStep.updateMany({
        where: { taskId, status: 'running' },
        data: { status: 'failed', output: { error: 'worker_shutdown' } },
      });
      const event = await this.events.append(tx, tenantId, taskId, 'task.recovering', {
        reason: 'worker_shutdown',
        fromPlanIndex: null,
      });
      await this.events.publish(taskId, event);
      return task.recoveryCount;
    });
    await this.queue.enqueueResume({ tenantId, taskId }, { kind: 'recover', n: count });
    this.logger.warn(`작업 ${taskId}: Worker 종료로 다른 Worker 에 넘김`);
  }

  private async finishFailed(ctx: RunContext, err: unknown): Promise<void> {
    const { tenantId, id: taskId } = ctx.task;
    const code = err instanceof RuntimeError ? err.code : 'RUNTIME_ERROR';
    const message = err instanceof RuntimeError ? err.message : '작업 실행 중 오류가 발생했습니다';
    if (!(err instanceof RuntimeError)) {
      this.logger.error(
        `작업 ${taskId} 실패: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
    }
    await this.commit(tenantId, taskId, async (tx) => {
      const task = await tx.task.update({
        where: { id: taskId },
        data: {
          status: 'failed',
          failureCode: code,
          failureMessage: message,
          finishedAt: new Date(),
          ...usageIncrement(ctx),
        },
        select: { lastCheckpointStepId: true },
      });
      const checkpoint = task.lastCheckpointStepId
        ? await tx.taskStep.findUnique({
            where: { id: task.lastCheckpointStepId },
            select: { seq: true, planIndex: true },
          })
        : null;
      return this.events.append(tx, tenantId, taskId, 'task.failed', {
        code,
        message,
        resumable: checkpoint !== null,
        lastCheckpoint: checkpoint,
      });
    });
  }

  private async commit(
    tenantId: string,
    taskId: string,
    fn: (tx: TenantTx) => Promise<TaskEventEnvelope>,
  ): Promise<void> {
    const envelope = await this.prisma.withTenant(tenantId, fn);
    await this.events.publish(taskId, envelope);
  }
}

/** 이번 실행에서 쓴 토큰을 작업에 더한다 (완료뿐 아니라 실패 · 중지 · 일시정지에도) */
function usageIncrement(ctx: RunContext) {
  return {
    inputTokens: { increment: ctx.usage.inputTokens },
    outputTokens: { increment: ctx.usage.outputTokens },
  };
}

function textOf(content: Prisma.JsonValue | undefined): string {
  const parsed = z.array(contentBlockSchema).safeParse(content);
  if (!parsed.success) return '';
  return parsed.data
    .flatMap((b) => (b.type === 'text' ? [b.text] : []))
    .join('\n')
    .trim();
}
