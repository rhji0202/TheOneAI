import type { ExecutionPolicy, MemoryPolicy } from '../agents/agent-policies.js';
import { uuidv7 } from '../common/uuid.js';
import { toMessageView } from '../conversations/message-views.js';
import type { TaskEventEnvelope, TaskEventsService } from '../events/task-events.service.js';
import type { Prisma, StepType } from '../generated/prisma/client.js';
import type { PrismaService, TenantTx } from '../infrastructure/database/prisma.service.js';
import type { PlanStep, StoredPlan } from '../tasks/plan.js';
import { RuntimeError, TaskCancelledError } from './agent-runtime.js';

export interface TaskRunInfo {
  id: string;
  tenantId: string;
  title: string;
  conversationId: string;
  endUserId: string;
  agentId: string;
  agentVersionId: string;
  registryVersionId: string;
  triggerMessageId: string | null;
  triggerText: string;
  systemPrompt: string;
  executionPolicy: ExecutionPolicy;
  memoryPolicy: MemoryPolicy;
}

export interface StepDefinition {
  type: StepType;
  name: string;
  /** 계획 상 단계 번호. context · plan · evaluate 단계는 생략 */
  planIndex?: number;
  input?: Record<string, unknown>;
  parallelGroup?: string;
}

export interface StepOutcome<T> {
  value: T;
  summary?: string;
  output?: Record<string, unknown>;
  evaluation?: Record<string, unknown>;
  /** true 면 단계 완료 후 재개용 checkpoint 를 저장한다 */
  checkpoint?: boolean;
  usage?: { inputTokens: number; outputTokens: number };
}

const CANCEL_POLL_MS = 500;

/**
 * Agent Runtime 이 작업 상태를 바꾸는 유일한 통로.
 * 모든 변경은 (1) DB 갱신 + task_events 저장을 한 트랜잭션으로, (2) 커밋 후 Redis 발행 순서로 처리한다.
 */
export class RunContext {
  readonly workingMemory: Record<string, unknown> = {};
  readonly usage = { inputTokens: 0, outputTokens: 0 };
  private plan: StoredPlan | null;
  private nextSeq: number;
  private lastCancelPoll = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: TaskEventsService,
    readonly task: TaskRunInfo,
    private readonly controller: AbortController,
    init: { nextSeq: number; plan: StoredPlan | null },
  ) {
    this.nextSeq = init.nextSeq;
    this.plan = init.plan;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** 계획 생성 · 수정 → plan.created / plan.revised */
  async setPlan(steps: Array<Omit<PlanStep, 'status'>>, revisedReason?: string): Promise<void> {
    const previous = this.plan;
    const next: StoredPlan = {
      version: (previous?.version ?? 0) + 1,
      steps: steps.map((s) => ({ ...s, status: 'pending' as const })),
      revisedReason: revisedReason ?? null,
    };
    await this.commit(async (tx) => {
      await tx.task.update({
        where: { id: this.task.id },
        data: {
          plan: next as unknown as Prisma.InputJsonValue,
          planVersion: next.version,
          totalSteps: next.steps.length,
          ...(previous ? { replanCount: { increment: 1 } } : {}),
        },
      });
      return previous
        ? [
            await this.append(tx, 'plan.revised', {
              planVersion: next.version,
              reason: revisedReason ?? '',
              steps: next.steps,
              diff: diffPlans(previous.steps, next.steps),
            }),
          ]
        : [await this.append(tx, 'plan.created', { planVersion: next.version, steps: next.steps })];
    });
    this.plan = next;
  }

  /** 단계 실행 → task_steps 기록, step.started / step.completed, 필요 시 checkpoint 저장 */
  async step<T>(
    def: StepDefinition,
    fn: (step: { id: string; seq: number }) => Promise<StepOutcome<T>>,
  ): Promise<T> {
    await this.throwIfCancelled();
    const seq = this.nextSeq++;
    if (seq > this.task.executionPolicy.maxSteps) {
      throw new RuntimeError(
        'STEP_LIMIT_EXCEEDED',
        `최대 단계 수(${this.task.executionPolicy.maxSteps})를 넘었습니다`,
      );
    }
    const used = this.usage.inputTokens + this.usage.outputTokens;
    if (used >= this.task.executionPolicy.tokenBudget) {
      throw new RuntimeError(
        'TOKEN_BUDGET_EXCEEDED',
        `작업당 토큰 예산(${this.task.executionPolicy.tokenBudget})을 모두 썼습니다`,
      );
    }
    const startedAt = new Date();
    const stepId = uuidv7();

    await this.commit(async (tx) => {
      await tx.taskStep.create({
        data: {
          id: stepId,
          tenantId: this.task.tenantId,
          taskId: this.task.id,
          seq,
          planVersion: this.plan?.version ?? 0,
          planIndex: def.planIndex ?? null,
          type: def.type,
          name: def.name,
          status: 'running',
          parallelGroup: def.parallelGroup ?? null,
          input: (def.input ?? undefined) as Prisma.InputJsonValue | undefined,
          attempts: 1,
          startedAt,
        },
      });
      await this.setPlanStepStatus(tx, def.planIndex, 'running');
      return [
        await this.append(tx, 'step.started', {
          seq,
          planIndex: def.planIndex ?? null,
          type: def.type,
          name: def.name,
          parallelGroup: def.parallelGroup ?? null,
        }),
      ];
    });

    let outcome: StepOutcome<T>;
    try {
      outcome = await fn({ id: stepId, seq });
    } catch (err) {
      const status = err instanceof TaskCancelledError ? 'cancelled' : 'failed';
      const finishedAt = new Date();
      await this.commit(async (tx) => {
        await tx.taskStep.update({
          where: { id: stepId },
          data: {
            status,
            finishedAt,
            durationMs: finishedAt.getTime() - startedAt.getTime(),
            output: { error: err instanceof RuntimeError ? err.code : status },
          },
        });
        await this.setPlanStepStatus(tx, def.planIndex, status);
        return [
          await this.append(tx, 'step.completed', {
            seq,
            planIndex: def.planIndex ?? null,
            status,
            durationMs: finishedAt.getTime() - startedAt.getTime(),
            summary: null,
            checkpointSaved: false,
          }),
        ];
      });
      throw err;
    }

    if (outcome.usage) {
      this.usage.inputTokens += outcome.usage.inputTokens;
      this.usage.outputTokens += outcome.usage.outputTokens;
    }
    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    const checkpoint = outcome.checkpoint ? this.buildCheckpoint(def.planIndex) : null;

    await this.commit(async (tx) => {
      await tx.taskStep.update({
        where: { id: stepId },
        data: {
          status: 'succeeded',
          finishedAt,
          durationMs,
          summary: outcome.summary ?? null,
          output: (outcome.output ?? undefined) as Prisma.InputJsonValue | undefined,
          evaluation: (outcome.evaluation ?? undefined) as Prisma.InputJsonValue | undefined,
          inputTokens: outcome.usage?.inputTokens ?? 0,
          outputTokens: outcome.usage?.outputTokens ?? 0,
          ...(checkpoint
            ? { checkpoint: checkpoint as Prisma.InputJsonValue, checkpointAt: finishedAt }
            : {}),
        },
      });
      await this.setPlanStepStatus(tx, def.planIndex, 'succeeded');
      await tx.task.update({
        where: { id: this.task.id },
        data: {
          ...(def.planIndex
            ? {
                completedSteps:
                  this.plan?.steps.filter((s) => s.status === 'succeeded').length ?? 0,
              }
            : {}),
          ...(checkpoint ? { lastCheckpointStepId: stepId } : {}),
        },
      });
      return [
        await this.append(tx, 'step.completed', {
          seq,
          planIndex: def.planIndex ?? null,
          status: 'succeeded',
          durationMs,
          summary: outcome.summary ?? null,
          checkpointSaved: checkpoint !== null,
        }),
      ];
    });
    return outcome.value;
  }

  /** 응답 스트리밍 → message.delta(저장 안 함) … message.completed(저장) */
  async streamAssistantMessage(
    chunks: AsyncIterable<string>,
  ): Promise<{ id: string; text: string }> {
    const messageId = uuidv7();
    let text = '';
    for await (const chunk of chunks) {
      await this.throwIfCancelled();
      text += chunk;
      await this.events.streamDelta(this.task.id, messageId, chunk);
    }
    await this.commit(async (tx) => {
      const message = await tx.message.create({
        data: {
          id: messageId,
          tenantId: this.task.tenantId,
          conversationId: this.task.conversationId,
          role: 'assistant',
          content: [{ type: 'text', text }],
          taskId: this.task.id,
        },
      });
      await tx.conversation.update({
        where: { id: this.task.conversationId },
        data: { lastMessageAt: message.createdAt },
      });
      return [await this.append(tx, 'message.completed', { message: toMessageView(message) })];
    });
    await this.events.clearStream(this.task.id, messageId);
    return { id: messageId, text };
  }

  /** 중지 요청 확인: AbortSignal 즉시 + DB 의 cancel_requested_at 을 최대 0.5초 간격으로 */
  async throwIfCancelled(): Promise<void> {
    if (this.controller.signal.aborted) throw this.abortError();
    const now = Date.now();
    if (now - this.lastCancelPoll < CANCEL_POLL_MS) return;
    this.lastCancelPoll = now;
    const row = await this.prisma.withTenant(this.task.tenantId, (tx) =>
      tx.task.findUnique({ where: { id: this.task.id }, select: { cancelRequestedAt: true } }),
    );
    if (row?.cancelRequestedAt) {
      this.controller.abort(new TaskCancelledError());
      throw new TaskCancelledError();
    }
  }

  private abortError(): Error {
    const reason: unknown = this.controller.signal.reason;
    return reason instanceof Error ? reason : new TaskCancelledError();
  }

  /** docs/data-model.md §4.3 Checkpoint */
  private buildCheckpoint(planIndex: number | undefined): Record<string, unknown> {
    return {
      planVersion: this.plan?.version ?? 0,
      plan: this.plan?.steps ?? [],
      nextPlanIndex: (planIndex ?? 0) + 1,
      workingMemory: this.workingMemory,
      artifactRefs: [],
      approvalsGranted: [],
      conversationCursor: this.task.triggerMessageId,
      usage: { ...this.usage },
    };
  }

  private async setPlanStepStatus(
    tx: TenantTx,
    planIndex: number | undefined,
    status: PlanStep['status'],
  ) {
    if (!planIndex || !this.plan) return;
    this.plan = {
      ...this.plan,
      steps: this.plan.steps.map((s) => (s.index === planIndex ? { ...s, status } : s)),
    };
    await tx.task.update({
      where: { id: this.task.id },
      data: { plan: this.plan as unknown as Prisma.InputJsonValue },
    });
  }

  private append(tx: TenantTx, type: string, data: unknown): Promise<TaskEventEnvelope> {
    return this.events.append(tx, this.task.tenantId, this.task.id, type, data);
  }

  private async commit(fn: (tx: TenantTx) => Promise<TaskEventEnvelope[]>): Promise<void> {
    const envelopes = await this.prisma.withTenant(this.task.tenantId, fn);
    await this.events.publish(this.task.id, ...envelopes);
  }
}

function diffPlans(before: PlanStep[], after: PlanStep[]) {
  const key = (s: PlanStep) => `${s.title}|${s.kind}|${s.toolName ?? ''}|${s.skill?.name ?? ''}`;
  const beforeByIndex = new Map(before.map((s) => [s.index, s]));
  const afterIndexes = new Set(after.map((s) => s.index));
  return {
    added: after.filter((s) => !beforeByIndex.has(s.index)).map((s) => s.index),
    removed: before.filter((s) => !afterIndexes.has(s.index)).map((s) => s.index),
    changed: after
      .filter((s) => {
        const prev = beforeByIndex.get(s.index);
        return prev !== undefined && key(prev) !== key(s);
      })
      .map((s) => s.index),
  };
}
