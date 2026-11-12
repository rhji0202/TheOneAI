import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { executionPolicySchema, memoryPolicySchema } from '../agents/agent-policies.js';
import {
  AGENT_RUNTIME,
  type AgentRuntime,
  RuntimeError,
  type RunResult,
  TaskCancelledError,
} from '../agent-runtime/agent-runtime.js';
import { RunContext, type TaskRunInfo } from '../agent-runtime/run-context.js';
import { contentBlockSchema } from '../conversations/message-views.js';
import { type TaskEventEnvelope, TaskEventsService } from '../events/task-events.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService, type TenantTx } from '../infrastructure/database/prisma.service.js';
import type { AgentTaskJobData } from '../infrastructure/queue/queues.js';
import { parseStoredPlan } from '../tasks/plan.js';

export const HEARTBEAT_MS = 15_000;

export type ExecutionOutcome = 'completed' | 'cancelled' | 'failed' | 'skipped';

/**
 * 작업 1건의 실행 수명주기 (docs/api-spec.md §6)
 *   claim(queued|recovering → running) → heartbeat → AgentRuntime.run → completed | cancelled | failed
 */
@Injectable()
export class TaskExecutionService {
  private readonly logger = new Logger(TaskExecutionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: TaskEventsService,
    @Inject(AGENT_RUNTIME) private readonly runtime: AgentRuntime,
  ) {}

  async execute(job: AgentTaskJobData, workerId: string): Promise<ExecutionOutcome> {
    const { tenantId, taskId } = job;
    const claim = await this.claim(tenantId, taskId, workerId);
    if (claim.kind !== 'claimed') return claim.kind;

    const controller = new AbortController();
    const ctx = new RunContext(this.prisma, this.events, claim.info, controller, {
      nextSeq: claim.nextSeq,
      plan: claim.plan,
    });

    const heartbeat = setInterval(() => void this.beat(tenantId, taskId, controller), HEARTBEAT_MS);
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
        await this.finishCancelled(tenantId, taskId);
        return 'cancelled';
      }
      await this.finishFailed(tenantId, taskId, err);
      return 'failed';
    } finally {
      clearInterval(heartbeat);
      clearTimeout(deadline);
    }
  }

  private async claim(
    tenantId: string,
    taskId: string,
    workerId: string,
  ): Promise<
    | {
        kind: 'claimed';
        info: TaskRunInfo;
        nextSeq: number;
        plan: ReturnType<typeof parseStoredPlan>;
      }
    | { kind: 'skipped' | 'cancelled' }
  > {
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
      });
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
      };
    });

    await this.events.publish(taskId, ...outcome.events);
    if (outcome.kind !== 'claimed') {
      this.logger.debug(`작업 ${taskId}: ${outcome.kind}`);
      return { kind: outcome.kind };
    }
    return { kind: 'claimed', info: outcome.info, nextSeq: outcome.nextSeq, plan: outcome.plan };
  }

  /** heartbeat 갱신 + 긴 단계 실행 중에도 중지 요청을 감지한다. */
  private async beat(tenantId: string, taskId: string, controller: AbortController): Promise<void> {
    try {
      const row = await this.prisma.withTenant(tenantId, async (tx) => {
        await tx.task.updateMany({
          where: { id: taskId, status: 'running' },
          data: { lastHeartbeatAt: new Date() },
        });
        return tx.task.findUnique({ where: { id: taskId }, select: { cancelRequestedAt: true } });
      });
      if (row?.cancelRequestedAt && !controller.signal.aborted)
        controller.abort(new TaskCancelledError());
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

  private async finishCancelled(tenantId: string, taskId: string): Promise<void> {
    await this.commit(tenantId, taskId, async (tx) => {
      await tx.task.update({
        where: { id: taskId },
        data: { status: 'cancelled', finishedAt: new Date() },
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

  private async finishFailed(tenantId: string, taskId: string, err: unknown): Promise<void> {
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

function textOf(content: Prisma.JsonValue | undefined): string {
  const parsed = z.array(contentBlockSchema).safeParse(content);
  if (!parsed.success) return '';
  return parsed.data
    .flatMap((b) => (b.type === 'text' ? [b.text] : []))
    .join('\n')
    .trim();
}
