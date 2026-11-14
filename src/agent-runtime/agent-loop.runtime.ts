import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { LlmMessage, LlmResponse, LlmToolCall, LlmUsage } from '../llm/llm.types.js';
import { SkillFileIntegrityError } from '../skills/skill-store.service.js';
import { SKILL_READ_FILE } from '../skills/skill-read-file.tool.js';
import { SkillRuntimeService, SkillUnavailableError } from '../skills/skill-runtime.service.js';
import type { PlanStep } from '../tasks/plan.js';
import { ToolAvailabilityService } from '../tools/tool-availability.service.js';
import { ToolDispatcherService } from '../tools/tool-dispatcher.service.js';
import { matchesToolPattern } from '../tools/tool-names.js';
import { type PolicySnapshot, ToolPermissionService } from '../tools/tool-permission.service.js';
import {
  type ResolvedTool,
  ToolRegistryService,
  type Toolset,
} from '../tools/tool-registry.service.js';
import type { SnapshotSkill } from '../tools/tool.types.js';
import {
  type AgentRuntime,
  RuntimeError,
  type RunResult,
  TaskWaitingApprovalError,
} from './agent-runtime.js';
import { type AgentContext, ContextBuilder } from './context-builder.js';
import { compactToolResults } from './context-compressor.js';
import { type ModelCall, type ModelRouter, ModelRouterFactory } from './model-router.js';
import {
  agentRole,
  BUDGET_REACHED_NOTE,
  LOAD_SKILL_TOOL,
  LOAD_SKILL_TOOL_DEFINITION,
  MAX_TODO_ITEMS,
  MAX_TOOL_CALLS_PER_TURN,
  skillSection,
  STEPS_RESERVED_FOR_ANSWER,
  systemPrompt,
  TODO_TOOL,
  TODO_TOOL_DEFINITION,
} from './prompts.js';
import type { RunContext } from './run-context.js';

/**
 * 진행 중인 대화 (checkpoint 의 workingMemory.loop).
 * 시스템 지침 · 대화 기록 · 요청(첨부 이미지)은 남기지 않고 차례마다 다시 만든다.
 */
interface LoopState {
  /** 요청 뒤에 이어진 대화 — assistant 의 Tool 호출 · Tool 결과 */
  messages: LlmMessage[];
  /** Tool 을 부른 모델 차례 수 */
  turns: number;
  /** load_skill 로 불러온 Skill — 이후 Tool 은 그 allowed-tools 로 좁힌다 */
  skill?: { name: string; allowedTools: string[] };
  /** 승인 대기로 멈춘 Tool 호출 묶음 — 재개하면 결과가 없는(null) 호출부터 승인한 인자 그대로 실행한다 */
  pending?: { calls: LlmToolCall[]; results: Array<string | null> };
}

type Answer = { id: string; text: string };

const CALL_NOT_RUN = JSON.stringify({
  error: 'not_run',
  message: 'The tool call limit for this turn or task was reached, so this call was not run.',
});

const TODO_STATUS = {
  pending: 'pending',
  in_progress: 'running',
  completed: 'succeeded',
  cancelled: 'skipped',
} as const;

const todoInput = z.object({
  items: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(200),
        status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']),
      }),
    )
    .min(1)
    .max(MAX_TODO_ITEMS),
});

const loadSkillInput = z.object({ name: z.string().min(1).max(64) });

/**
 * Agent Loop — 모델 하나가 한 대화 안에서 Tool 을 부르고 결과를 보며 이어 가다가,
 * Tool 없이 답하면 그 답을 최종 답변으로 스트리밍하고 끝난다 (별도 계획 · 평가 · 검증 호출 없음).
 *  - 계획: 여러 단계가 필요하면 모델이 todo Tool 로 할 일 목록을 만들고 고친다 → 위젯 계획 카드
 *  - Skill: 시스템 프롬프트에는 이름 · 설명만, 전체 지침은 모델이 load_skill 로 불러온다
 *  - Tool 은 서버의 Tool Dispatcher 가 검증 · 실행한다. 사용할 수 있는 Tool 은 작업 생성 시 고정한
 *    Registry 버전(tasks.registry_version_id)으로 정해진다.
 *  - 모델 차례마다 단계(agent.turn)로 기록하고 checkpoint 를 남긴다. 승인 대기 뒤에는 같은 Tool 호출부터 이어 간다.
 */
@Injectable()
export class AgentLoopRuntime implements AgentRuntime {
  constructor(
    private readonly routers: ModelRouterFactory,
    private readonly contextBuilder: ContextBuilder,
    private readonly registry: ToolRegistryService,
    private readonly permissions: ToolPermissionService,
    private readonly availability: ToolAvailabilityService,
    private readonly skills: SkillRuntimeService,
    private readonly dispatcher: ToolDispatcherService,
  ) {}

  async run(ctx: RunContext): Promise<RunResult> {
    const router = await this.routers.forTask(ctx.task, ctx.meter);

    // 1) Context — 지침 · 대화 · 사용할 수 있는 Tool · Skill
    const { context, toolset, policies, offered, skills } = await ctx.step(
      { type: 'context', name: 'context.build' },
      async () => {
        const {
          context: built,
          compression,
          usage,
        } = await this.contextBuilder.build(ctx.task, { router, signal: ctx.signal });
        const tools = await this.registry.loadToolset(
          ctx.task.tenantId,
          ctx.task.registryVersionId,
        );
        // 작업이 처음 읽은 정책과 지금 정책 중 엄격한 쪽 (완화는 새 작업부터)
        const { policies: policy, snapshot } = await this.permissions.forTask(
          ctx.task.tenantId,
          ctx.workingMemory.policySnapshot as PolicySnapshot | undefined,
        );
        ctx.workingMemory.policySnapshot = snapshot;
        // MCP Tool 은 이 Agent 버전의 허용 목록에 있고 서버 · Tool 이 지금 사용 가능한 것만 보여 준다
        const live = await this.availability.load(ctx.task.tenantId, ctx.task.agentVersionId);
        // Skill 전용 Tool(skill.*)은 Skill 이 있을 때만 따로 준다
        const usable = tools.available.filter(
          (t) =>
            policy.planningMode(t) !== 'blocked' &&
            live.check(t) === 'ok' &&
            !t.name.startsWith('skill.'),
        );
        const allowedSkills = await this.skills.available(
          ctx.task.tenantId,
          ctx.task.agentVersionId,
          tools.skills,
        );
        return {
          value: {
            context: built,
            toolset: tools,
            policies: policy,
            offered: usable,
            skills: allowedSkills,
          },
          summary: `최근 대화 ${built.history.length}개${compression ? ` · 이전 대화 ${compression.messages}개 요약` : ''} · Tool ${usable.length}개`,
          usage: stepUsage(usage),
          output: {
            historyMessages: built.history.length,
            conversationSummary: built.conversationSummary
              ? {
                  chars: built.conversationSummary.length,
                  ...(compression ? { mergedMessages: compression.messages } : {}),
                }
              : null,
            tenantPromptChars: built.tenantPrompt.length,
            registryVersionId: ctx.task.registryVersionId,
            tools: usable.map((t) => ({
              name: t.llmName,
              requiresApproval: policy.planningMode(t) === 'approval',
            })),
            memories: built.memoryHits.map((m) => ({
              id: m.id,
              type: m.type,
              ...(m.via ? { via: m.via } : { score: m.score }),
            })),
            skills: allowedSkills.map((k) => ({ name: k.name, version: k.version })),
          },
        };
      },
    );

    const baseRequest = context.request;
    const applySteers = () => this.applySteers(ctx, context, baseRequest);
    await applySteers();

    const state = loopState(ctx);
    if (ctx.resume) {
      // checkpoint 뒤에 할 일 목록을 고치다 멈춘 경우 — checkpoint 의 목록으로 되돌린다
      if (ctx.resume.checkpoint.plan.length) await ctx.updatePlan(ctx.resume.checkpoint.plan);
      await ctx.record(async (_tx, emit) => {
        await emit('task.resumed', {
          reason: ctx.resume!.reason,
          fromStepId: ctx.resume!.fromStepId,
          turn: state.turns,
          planVersion: ctx.currentPlan?.version ?? null,
        });
      });
    }
    // 답변까지 보낸 뒤 멈췄다면 남은 일이 없다
    const sent = ctx.workingMemory.answer as Answer | undefined;
    if (sent) return { messageId: sent.id };

    const system = systemPrompt(
      context.tenantPrompt,
      agentRole(skills.map((k) => ({ name: k.name, description: k.description }))),
      context.memories,
      context.conversationSummary,
    );
    const reader = skills.length
      ? toolset.tools.find((t) => t.name === SKILL_READ_FILE && t.builtin)
      : undefined;

    // 2) 모델 차례 반복 — Tool 을 부르면 실행해 결과를 붙이고, Tool 없이 답하면 그것이 최종 답변
    for (;;) {
      await applySteers();
      // 단계 수 · 토큰 · 시간이 답변할 몫만 남으면 Tool 없이 답하게 한다 (실패로 끝내지 않는다)
      const final = ctx.stepsLeft <= STEPS_RESERVED_FOR_ANSWER + 1 || ctx.budgetNearlySpent;
      const continued = state.pending !== undefined;
      const answer = await ctx.step<Answer | null>(
        {
          type: 'reason',
          name: 'agent.turn',
          planIndex: activePlanIndex(ctx),
          trackPlan: false,
          checkpointOnApproval: true,
          input: {
            model: router.describe(),
            turn: state.turns + 1,
            ...(final ? { final: true } : {}),
            ...(continued ? { continuedAfterApproval: true } : {}),
          },
        },
        async () => {
          let usage: LlmUsage | null = null;
          const tools = this.scopedTools(state, offered, reader);
          if (state.pending) {
            // 재개: 멈췄던 호출부터 (끝난 호출은 저장된 결과를 그대로 쓴다)
            const { calls, results } = state.pending;
            delete state.pending;
            await this.runCalls(ctx, toolset, skills, state, tools, calls, results, () => usage);
          }
          const definitions = [
            ...toolset.definitions(tools, (tool) =>
              policies.planningMode(tool) === 'approval'
                ? '[Requires approval: the user (or an operator) is asked before it runs. Call it normally when the request needs it.]'
                : null,
            ),
            TODO_TOOL_DEFINITION,
            ...(skills.length ? [LOAD_SKILL_TOOL_DEFINITION] : []),
          ];
          // Context Compression — 오래된 Tool 결과는 앞부분만 (모델은 이미 보고 판단했다)
          compactToolResults(state.messages);
          const { response, message } = await this.streamTurn(ctx, router, {
            messages: [
              { role: 'system', content: system },
              ...context.history,
              { role: 'user', content: context.request, images: context.images },
              ...state.messages,
              ...(final ? [{ role: 'user' as const, content: BUDGET_REACHED_NOTE }] : []),
            ],
            // Tool 정의는 그대로 보내고(이전 tool 메시지와 짝이 맞도록) 마지막 차례에는 호출만 막는다
            tools: definitions,
            ...(final ? { toolChoice: 'none' as const } : {}),
          });
          usage = response.usage;

          if (final || response.toolCalls.length === 0) {
            if (!message) {
              throw new RuntimeError('MODEL_EMPTY_RESPONSE', '모델이 빈 답변을 돌려주었습니다');
            }
            ctx.workingMemory.answer = message;
            return {
              value: message,
              summary: '답변 작성 완료',
              output: { messageId: message.id, chars: message.text.length },
              usage: stepUsage(response.usage),
              checkpoint: true,
            };
          }

          // Tool 호출 — 차례 · 작업 단계 수 한도를 넘는 호출은 실행하지 않고 그렇게 알린다
          const calls = response.toolCalls;
          state.messages.push({
            role: 'assistant',
            content: response.content || null,
            toolCalls: calls,
          });
          state.turns++;
          const allowed = Math.min(
            MAX_TOOL_CALLS_PER_TURN,
            ctx.stepsLeft - STEPS_RESERVED_FOR_ANSWER,
          );
          await this.runCalls(
            ctx,
            toolset,
            skills,
            state,
            tools,
            calls,
            calls.map((_, i) => (i < allowed ? null : CALL_NOT_RUN)),
            () => usage,
          );
          return {
            value: null,
            summary: `Tool ${calls.length}개 호출: ${[...new Set(calls.map((c) => c.name))].join(', ')}`,
            output: {
              toolCalls: calls.map((c) => c.name),
              ...(message ? { messageId: message.id, chars: message.text.length } : {}),
            },
            usage: stepUsage(response.usage),
            checkpoint: true,
          };
        },
      );
      if (answer) return { messageId: answer.id };
    }
  }

  /**
   * 모델 차례 하나를 스트리밍으로 받는다. 첫 텍스트가 나오면 그때 assistant 메시지를 열어 사용자에게 흘려보낸다
   * (Tool 만 부르는 차례는 메시지를 만들지 않는다. Tool 호출과 함께 온 텍스트는 중간 안내 메시지로 남는다).
   */
  private async streamTurn(
    ctx: RunContext,
    router: ModelRouter,
    call: ModelCall,
  ): Promise<{ response: LlmResponse; message: Answer | null }> {
    const events = router.stream(call, ctx.signal);
    const out: { response: LlmResponse | null } = { response: null };
    let first: string | null = null;
    for (;;) {
      const next = await events.next();
      if (next.done) break;
      if (next.value.type === 'done') out.response = next.value.response;
      // 앞쪽 공백만 있는 조각은 버린다 (Tool 만 부르는 차례에 빈 메시지를 만들지 않도록)
      else if (next.value.text.trim()) {
        first = next.value.text;
        break;
      }
    }
    let message: Answer | null = null;
    if (first !== null) {
      const head = first;
      message = await ctx.streamAssistantMessage(
        (async function* () {
          yield head;
          for (;;) {
            const next = await events.next();
            if (next.done) return;
            if (next.value.type === 'text') yield next.value.text;
            else out.response = next.value.response;
          }
        })(),
      );
    }
    if (!out.response) {
      throw new RuntimeError('MODEL_EMPTY_RESPONSE', '모델이 응답을 끝내지 않았습니다');
    }
    return { response: out.response, message };
  }

  /** 이번 차례에 모델에게 줄 Registry Tool — Skill 을 불러왔으면 그 allowed-tools 로 좁힌다 */
  private scopedTools(
    state: LoopState,
    offered: ResolvedTool[],
    reader: ResolvedTool | undefined,
  ): ResolvedTool[] {
    const allowed = state.skill
      ? offered.filter((t) =>
          state.skill!.allowedTools.some((p) => p === '*' || matchesToolPattern(t.name, p)),
        )
      : offered;
    return reader ? [...allowed, reader] : allowed;
  }

  /**
   * 모델이 한 번에 요청한 Tool 호출을 실행하고 결과를 대화에 붙인다.
   * todo · load_skill 은 런타임이 직접 처리하고, 나머지는 Tool Dispatcher 가 검증 · 실행한다.
   * 승인 대기로 멈추면 끝난 호출 결과와 함께 state.pending 에 남긴다 (차례 단계가 이것으로 checkpoint 를 저장한다).
   */
  private async runCalls(
    ctx: RunContext,
    toolset: Toolset,
    skills: SnapshotSkill[],
    state: LoopState,
    tools: ResolvedTool[],
    calls: LlmToolCall[],
    results: Array<string | null>,
    usage: () => LlmUsage | null,
  ): Promise<void> {
    for (const [i, call] of calls.entries()) {
      if (results[i] !== null) continue;
      if (call.name === TODO_TOOL) results[i] = await this.todo(ctx, call);
      else if (call.name === LOAD_SKILL_TOOL && skills.length)
        results[i] = await this.loadSkill(ctx, skills, state, call);
    }
    const todo = calls.flatMap((call, i) => (results[i] === null ? [{ call, i }] : []));
    try {
      const out = await this.dispatcher.dispatchAll(
        ctx,
        toolset,
        todo.map((t) => t.call),
        activePlanIndex(ctx),
        new Set(tools.map((t) => t.llmName)),
      );
      out.forEach((r, k) => (results[todo[k]!.i] = r.content));
    } catch (err) {
      if (err instanceof TaskWaitingApprovalError) {
        for (const d of err.dispatched) results[todo[d.index]!.i] = d.content;
        state.pending = { calls, results };
        const used = usage();
        if (used) err.usage = stepUsage(used);
      }
      throw err;
    }
    calls.forEach((call, i) => {
      state.messages.push({ role: 'tool', toolCallId: call.id, content: results[i]! });
    });
  }

  /** todo — 할 일 목록을 위젯 계획 카드(tasks.plan)에 반영한다 */
  private async todo(ctx: RunContext, call: LlmToolCall): Promise<string> {
    const parsed = parseArgs(call.arguments, todoInput);
    if (!parsed.ok) return invalid(parsed.message);
    const steps: PlanStep[] = parsed.value.items.map((item, i) => ({
      index: i + 1,
      title: truncate(item.title, 40),
      kind: 'reason',
      requiresApproval: false,
      status: TODO_STATUS[item.status],
    }));
    await ctx.updatePlan(steps);
    return JSON.stringify({ ok: true, items: parsed.value.items });
  }

  /**
   * load_skill — 지금도 쓸 수 있는가(비활성화 · 허용 목록 변경 반영) 확인 후 고정된 버전을 로딩한다.
   * 이후 차례의 Tool 은 그 Skill 의 allowed-tools 로 좁힌다 (권한 정책은 Dispatcher 가 그대로 적용).
   */
  private async loadSkill(
    ctx: RunContext,
    skills: SnapshotSkill[],
    state: LoopState,
    call: LlmToolCall,
  ): Promise<string> {
    const parsed = parseArgs(call.arguments, loadSkillInput);
    if (!parsed.ok) return invalid(parsed.message);
    const name = parsed.value.name;
    return ctx.step(
      {
        type: 'skill',
        name: `skill.${name}`,
        planIndex: activePlanIndex(ctx),
        trackPlan: false,
        input: { skill: name },
      },
      async () => {
        const pinned = skills.find((k) => k.name === name);
        const unavailable = (reason: string) => ({
          value: JSON.stringify({ ok: false, error: 'skill_unavailable', message: reason }),
          summary: 'Skill 을 쓸 수 없음',
          output: { error: reason },
          status: 'failed' as const,
        });
        if (!pinned) return unavailable(`'${name}' is not one of this agent's skills`);
        const [live] = await this.skills.available(ctx.task.tenantId, ctx.task.agentVersionId, [
          pinned,
        ]);
        if (!live) return unavailable('it was disabled by the operator');
        try {
          const loaded = await this.skills.load(ctx.task.tenantId, pinned);
          state.skill = { name: loaded.name, allowedTools: loaded.allowedTools };
          return {
            value: skillSection(loaded),
            summary: `Skill ${loaded.name} v${loaded.version} 로딩`,
            output: {
              skill: { name: loaded.name, version: loaded.version },
              allowedTools: loaded.allowedTools,
            },
          };
        } catch (err) {
          if (err instanceof SkillUnavailableError || err instanceof SkillFileIntegrityError) {
            return unavailable(err.message);
          }
          throw err;
        }
      },
    );
  }

  /**
   * 실행 중 추가 지시(steer) 반영 — 아직 반영하지 않은 지시를 요청 뒤에 붙여 다음 차례부터 쓴다.
   * 반영 위치(cursor)는 checkpoint 에 남아 재개 후에도 중복되지 않는다.
   */
  private async applySteers(
    ctx: RunContext,
    context: AgentContext,
    baseRequest: string,
  ): Promise<void> {
    const all = await this.contextBuilder.steers(ctx.task);
    const cursor =
      typeof ctx.workingMemory.steerCursor === 'string' ? ctx.workingMemory.steerCursor : null;
    const fresh = cursor ? all.filter((m) => m.id > cursor) : all;
    if (all.length) {
      context.request = `${baseRequest}\n\nAdditional instructions the user sent while this task was running (follow the latest when they conflict):\n${all.map((m) => `- ${m.text}`).join('\n')}`;
    }
    if (!fresh.length) return;
    ctx.workingMemory.steerCursor = fresh.at(-1)!.id;
    await ctx.record(async (_tx, emit) => {
      await emit('task.steer_applied', { messageIds: fresh.map((m) => m.id) });
    });
  }
}

/** checkpoint 의 대화 (재개) 또는 새 대화 — workingMemory 에 두어 checkpoint 와 함께 저장된다 */
function loopState(ctx: RunContext): LoopState {
  const saved = ctx.workingMemory.loop as LoopState | undefined;
  const state: LoopState =
    saved && Array.isArray(saved.messages) ? saved : { messages: [], turns: 0 };
  ctx.workingMemory.loop = state;
  return state;
}

/** 할 일 목록에서 진행 중인 항목 — 차례 · Tool 단계를 그 항목에 묶어 기록한다 */
function activePlanIndex(ctx: RunContext): number | undefined {
  return ctx.currentPlan?.steps.find((s) => s.status === 'running')?.index;
}

function parseArgs<T>(
  raw: string,
  schema: z.ZodType<T>,
): { ok: true; value: T } | { ok: false; message: string } {
  let value: unknown;
  try {
    value = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return { ok: false, message: 'Arguments are not valid JSON.' };
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    message: parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; '),
  };
}

function invalid(message: string): string {
  return JSON.stringify({ ok: false, error: 'INVALID_ARGUMENTS', message });
}

function stepUsage(usage: LlmUsage): { inputTokens: number; outputTokens: number } {
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
