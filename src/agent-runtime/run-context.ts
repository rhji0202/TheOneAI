import type { ExecutionPolicy, MemoryPolicy } from '../agents/agent-policies.js';
import { uuidv7 } from '../common/uuid.js';
import { toMessageView } from '../conversations/message-views.js';
import type { TaskEventEnvelope, TaskEventsService } from '../events/task-events.service.js';
import type { Prisma, StepType } from '../generated/prisma/client.js';
import type { PrismaService, TenantTx } from '../infrastructure/database/prisma.service.js';
import type { PlanStep, StoredPlan } from '../tasks/plan.js';
import { RuntimeError, TaskCancelledError, TaskPausedError } from './agent-runtime.js';

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
  /** false 면 planIndex 를 기록만 하고 계획 카드 상태 · 진행률은 바꾸지 않는다 (작업 단계 안의 Tool 호출) */
  trackPlan?: boolean;
}

export interface StepOutcome<T> {
  value: T;
  summary?: string;
  output?: Record<string, unknown>;
  evaluation?: Record<string, unknown>;
  /** true 면 단계 완료 후 재개용 checkpoint 를 저장한다 */
  checkpoint?: boolean;
  usage?: { inputTokens: number; outputTokens: number };
  /** 예외 없이 끝났지만 실행하지 않았거나(skipped) 실패로 남길 때 (예: 거부된 Tool 호출) */
  status?: 'succeeded' | 'failed' | 'skipped';
}

/** docs/data-model.md §4.3 — task_steps.checkpoint */
export interface Checkpoint {
  planVersion: number;
  plan: PlanStep[];
  nextPlanIndex: number;
  workingMemory: Record<string, unknown>;
  artifactRefs: string[];
  approvalsGranted: unknown[];
  conversationCursor: string | null;
  usage: { inputTokens: number; outputTokens: number };
}

/** 재개할 때 Worker 가 넘겨 주는 상태 */
export interface ResumeState {
  checkpoint: Checkpoint;
  /** checkpoint 를 저장한 단계 */
  fromStepId: string;
  reason: 'resume' | 'recover';
}

/** RunContext.record 안에서 이벤트를 남기는 함수 */
export type EmitEvent = (type: string, data: unknown) => Promise<void>;

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
  /** 재개면 checkpoint (Agent Loop 가 계획 · 노트 · 다음 단계를 여기서 이어받는다) */
  readonly resume: ResumeState | null;
  /** 이전 실행들이 이미 쓴 토큰 (토큰 예산은 작업 전체 기준) */
  private readonly priorUsage: { inputTokens: number; outputTokens: number };

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: TaskEventsService,
    readonly task: TaskRunInfo,
    private readonly controller: AbortController,
    init: {
      nextSeq: number;
      plan: StoredPlan | null;
      resume?: ResumeState | null;
      priorUsage?: { inputTokens: number; outputTokens: number };
    },
  ) {
    this.nextSeq = init.nextSeq;
    this.plan = init.plan;
    this.resume = init.resume ?? null;
    this.priorUsage = init.priorUsage ?? { inputTokens: 0, outputTokens: 0 };
    if (this.resume) Object.assign(this.workingMemory, this.resume.checkpoint.workingMemory);
  }

  /** 지금 계획 (재개 시 checkpoint 와 비교) */
  get currentPlan(): StoredPlan | null {
    return this.plan;
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
    const used =
      this.priorUsage.inputTokens +
      this.priorUsage.outputTokens +
      this.usage.inputTokens +
      this.usage.outputTokens;
    if (used >= this.task.executionPolicy.tokenBudget) {
      throw new RuntimeError(
        'TOKEN_BUDGET_EXCEEDED',
        `작업당 토큰 예산(${this.task.executionPolicy.tokenBudget})을 모두 썼습니다`,
      );
    }
    const startedAt = new Date();
    const stepId = uuidv7();
    const tracked = def.trackPlan === false ? undefined : def.planIndex;

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
      await this.setPlanStepStatus(tx, tracked, 'running');
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
        await this.setPlanStepStatus(tx, tracked, status);
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
    const status = outcome.status ?? 'succeeded';

    await this.commit(async (tx) => {
      await tx.taskStep.update({
        where: { id: stepId },
        data: {
          status,
          finishedAt,
          durationMs,
          summary: outcome.summary ?? null,
          output: (outcome.output ?? undefined) as Prisma.InputJsonValue | undefined,
          evaluation: (outcome.evaluation ?? undefined) as Prisma.InputJsonValue | undefined,
          inputTokens: outcome.usage?.inputTokens ?? 0,
          outputTokens: outcome.usage?.outputTokens ?? 0,
          ...(checkpoint
            ? {
                checkpoint: checkpoint as unknown as Prisma.InputJsonValue,
                checkpointAt: finishedAt,
              }
            : {}),
        },
      });
      await this.setPlanStepStatus(tx, tracked, status);
      await tx.task.update({
        where: { id: this.task.id },
        data: {
          ...(tracked
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
          status,
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

  /** DB 변경과 이벤트를 한 트랜잭션으로 기록하고, 커밋 후 이벤트를 발행한다 (Tool 실행 기록 등). */
  async record(fn: (tx: TenantTx, emit: EmitEvent) => Promise<void>): Promise<void> {
    await this.commit(async (tx) => {
      const envelopes: TaskEventEnvelope[] = [];
      await fn(tx, async (type, data) => {
        envelopes.push(await this.append(tx, type, data));
      });
      return envelopes;
    });
  }

  /**
   * 중지 · 일시정지 요청 확인: AbortSignal 즉시 + DB 를 최대 0.5초 간격으로.
   * 일시정지는 단계 사이에서만 멈춘다 (실행 중인 Tool 은 끝까지).
   */
  async throwIfCancelled(): Promise<void> {
    if (this.controller.signal.aborted) throw this.abortError();
    const now = Date.now();
    if (now - this.lastCancelPoll < CANCEL_POLL_MS) return;
    this.lastCancelPoll = now;
    const row = await this.prisma.withTenant(this.task.tenantId, (tx) =>
      tx.task.findUnique({
        where: { id: this.task.id },
        select: { cancelRequestedAt: true, pauseRequestedAt: true, pausedReason: true },
      }),
    );
    if (row?.cancelRequestedAt) {
      this.controller.abort(new TaskCancelledError());
      throw new TaskCancelledError();
    }
    if (row?.pauseRequestedAt) throw new TaskPausedError(row.pausedReason ?? 'pause_requested');
  }

  private abortError(): Error {
    const reason: unknown = this.controller.signal.reason;
    return reason instanceof Error ? reason : new TaskCancelledError();
  }

  /** docs/data-model.md §4.3 Checkpoint */
  private buildCheckpoint(planIndex: number | undefined): Checkpoint {
    return {
      planVersion: this.plan?.version ?? 0,
      plan: this.plan?.steps ?? [],
      nextPlanIndex: (planIndex ?? 0) + 1,
      workingMemory: this.workingMemory,
      artifactRefs: [],
      approvalsGranted: [],
      conversationCursor:
        typeof this.workingMemory.steerCursor === 'string'
          ? this.workingMemory.steerCursor
          : this.task.triggerMessageId,
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
