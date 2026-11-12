import { Injectable } from '@nestjs/common';
import {
  addUsage,
  emptyUsage,
  type LlmMessage,
  type LlmStreamEvent,
  type LlmToolCall,
  type LlmUsage,
} from '../llm/llm.types.js';
import { ToolDispatcherService } from '../tools/tool-dispatcher.service.js';
import type { ResolvedTool, Toolset } from '../tools/tool-registry.service.js';
import type { AgentContext } from './context-builder.js';
import type { ModelRouter } from './model-router.js';
import {
  EXECUTOR_CORRECTION_ROLE,
  EXECUTOR_WORK_ROLE,
  MAX_TOOL_ROUNDS,
  type PlanView,
  type PromptTool,
  renderNotes,
  renderPlan,
  respondRole,
  skillSection,
  systemPrompt,
  type WorkNote,
} from './prompts.js';
import { TaskWaitingApprovalError } from './agent-runtime.js';
import { compactToolResults } from './context-compressor.js';
import type { RunContext } from './run-context.js';

/**
 * 승인 대기로 멈춘 작업 단계의 대화 (checkpoint 의 workingMemory.pendingWork).
 * 재개하면 모델을 다시 부르지 않고, 결과가 없는 Tool 호출부터 그대로 이어 간다 — 승인한 인자 그대로 실행된다.
 */
export interface PendingWork {
  planIndex: number;
  /** 마지막 assistant 메시지(Tool 호출)까지의 대화 */
  messages: LlmMessage[];
  calls: LlmToolCall[];
  /** 호출별 결과 (null = 아직 실행 안 함) */
  results: Array<string | null>;
  round: number;
  toolCalls: number;
}

export interface WorkInput {
  ctx: RunContext;
  router: ModelRouter;
  context: AgentContext;
  plan: PlanView;
  stepIndex: number;
  notes: WorkNote[];
  toolset: Toolset;
  /** 모델에게 제공할 Tool (차단 정책 제외). approval 은 설명에 “승인 필요” 표시 */
  tools: ResolvedTool[];
  requiresApproval: (tool: ResolvedTool) => boolean;
  /** 승인 대기 뒤 재개 — 멈췄던 대화부터 이어 간다 */
  pending?: PendingWork;
  /** Skill 단계: 선택된 Skill 의 전체 지침 · 파일 목록 */
  skill?: {
    name: string;
    version: string;
    instructions: string;
    files: Array<{ path: string; kind: string; size: number }>;
  };
}

export interface WorkResult {
  content: string;
  usage: LlmUsage;
  toolCalls: number;
}

/**
 * Execute — 작업 단계(reason · tool · skill)와 최종 답변(respond).
 * 작업 단계는 모델이 Tool 을 부르고(서버가 검증 · 실행) 결과를 받아 다시 판단하는 반복이다.
 * 이 단계에서 준 Tool 밖의 호출은 서버가 거부한다 (Skill 의 allowed-tools 범위).
 */
@Injectable()
export class ExecutorService {
  constructor(private readonly dispatcher: ToolDispatcherService) {}

  async work(input: WorkInput): Promise<WorkResult> {
    const { ctx, router, context, plan, stepIndex, notes, toolset } = input;
    const step = plan.steps[stepIndex - 1]!;
    const definitions = toolset.definitions(input.tools, (tool) =>
      input.requiresApproval(tool)
        ? '[Requires approval: the user (or an operator) is asked before it runs. Call it normally when this step needs it.]'
        : null,
    );
    const scope = new Set(definitions.map((d) => d.name));
    const role = input.skill
      ? `${EXECUTOR_WORK_ROLE}\n\n${skillSection(input.skill)}`
      : EXECUTOR_WORK_ROLE;
    const messages: LlmMessage[] = input.pending
      ? [...input.pending.messages]
      : [
          {
            role: 'system',
            content: systemPrompt(
              context.tenantPrompt,
              role,
              context.memories,
              context.conversationSummary,
            ),
          },
          ...context.history,
          {
            role: 'user',
            content: [
              `User request:\n${context.request}`,
              `Goal: ${plan.goal}`,
              `Plan:\n${renderPlan(plan, stepIndex)}`,
              `Working notes from earlier steps:\n${renderNotes(notes)}`,
              `Current step ${stepIndex}: ${step.title}${step.tool ? `\nSuggested tool: ${step.tool}` : ''}${step.skill ? `\nSkill: ${step.skill}` : ''}\nInstructions: ${step.instructions || '(none)'}`,
            ].join('\n\n'),
          },
        ];

    // 이번 실행에서 쓴 토큰 (승인 대기 전에 쓴 토큰은 그때 단계 기록에 남겼다)
    let usage = emptyUsage();
    let toolCalls = input.pending?.toolCalls ?? 0;
    let round = 0;
    const run = async (calls: LlmToolCall[], results: Array<string | null>) => {
      toolCalls += await this.runCalls(
        input,
        scope,
        { messages, calls, results, round, toolCalls },
        () => usage,
      );
    };
    if (input.pending) {
      // 재개: 멈췄던 호출부터 (끝난 호출은 저장된 결과를 그대로 쓴다)
      delete ctx.workingMemory.pendingWork;
      round = input.pending.round;
      await run(input.pending.calls, [...input.pending.results]);
      round++;
    }
    for (; round < MAX_TOOL_ROUNDS; round++) {
      // Context Compression — 오래된 Tool 결과는 앞부분만 (모델은 이미 보고 판단했다)
      compactToolResults(messages);
      const res = await router.complete(
        'executor',
        { messages, tools: definitions.length > 0 ? definitions : undefined },
        ctx.signal,
      );
      usage = addUsage(usage, res.usage);
      if (res.toolCalls.length === 0) return { content: res.content.trim(), usage, toolCalls };

      messages.push({ role: 'assistant', content: res.content || null, toolCalls: res.toolCalls });
      await run(
        res.toolCalls,
        res.toolCalls.map(() => null),
      );
    }

    // Tool 왕복 한도 — 지금까지 얻은 것으로 정리하게 한다 (Tool 없이 호출)
    messages.push({
      role: 'user',
      content:
        'The tool call limit for this step has been reached. Write the notes for this step from what you have.',
    });
    // Tool 정의는 그대로 보내고(이전 tool 메시지와 짝이 맞도록) 호출만 막는다
    const final = await router.complete(
      'executor',
      { messages, tools: definitions.length > 0 ? definitions : undefined, toolChoice: 'none' },
      ctx.signal,
    );
    const content =
      final.content.trim() || 'Tool call limit reached before this step could be summarized.';
    return { content, usage: addUsage(usage, final.usage), toolCalls };
  }

  /**
   * 모델이 한 번에 요청한 Tool 호출을 실행하고 결과를 대화에 붙인다. 실행한 호출 수를 돌려준다.
   * 승인 대기로 멈추면 지금까지의 대화 · 끝난 호출 결과를 workingMemory.pendingWork 에 남긴다
   * (작업 단계가 이것으로 checkpoint 를 저장하고, 결정 후 재개하면 같은 호출부터 이어 간다).
   */
  private async runCalls(
    input: WorkInput,
    scope: ReadonlySet<string>,
    state: Omit<PendingWork, 'planIndex'>,
    usage: () => LlmUsage,
  ): Promise<number> {
    const { ctx, toolset, stepIndex } = input;
    const todo = state.calls.flatMap((call, i) => (state.results[i] === null ? [{ call, i }] : []));
    try {
      const out = await this.dispatcher.dispatchAll(
        ctx,
        toolset,
        todo.map((t) => t.call),
        stepIndex,
        scope,
      );
      out.forEach((r, k) => (state.results[todo[k]!.i] = r.content));
    } catch (err) {
      if (err instanceof TaskWaitingApprovalError) {
        for (const d of err.dispatched) state.results[todo[d.index]!.i] = d.content;
        const pending: PendingWork = {
          planIndex: stepIndex,
          messages: state.messages,
          calls: state.calls,
          results: state.results,
          round: state.round,
          toolCalls: state.toolCalls + err.dispatched.length,
        };
        ctx.workingMemory.pendingWork = pending;
        const used = usage();
        err.usage = { inputTokens: used.inputTokens, outputTokens: used.outputTokens };
      }
      throw err;
    }
    state.calls.forEach((call, i) => {
      state.messages.push({ role: 'tool', toolCallId: call.id, content: state.results[i]! });
    });
    return todo.length;
  }

  respond(
    router: ModelRouter,
    context: AgentContext,
    plan: PlanView,
    notes: WorkNote[],
    tools: PromptTool[],
    signal: AbortSignal,
  ): AsyncGenerator<LlmStreamEvent> {
    const respondStep = plan.steps.find((s) => s.kind === 'respond');
    const guidance = [
      notes.length > 0 ? `Working notes (not visible to the user):\n${renderNotes(notes)}` : null,
      respondStep?.instructions ? `Answer guidance: ${respondStep.instructions}` : null,
    ].filter((part): part is string => part !== null);

    const messages: LlmMessage[] = [
      {
        role: 'system',
        content:
          systemPrompt(
            context.tenantPrompt,
            respondRole(tools),
            context.memories,
            context.conversationSummary,
          ) + (guidance.length ? `\n\n${guidance.join('\n\n')}` : ''),
      },
      ...context.history,
      { role: 'user', content: context.request },
    ];
    return router.stream('executor', { messages }, signal);
  }

  /** Reflection — 검증에서 나온 오류를 바로잡는 짧은 후속 메시지 (스트리밍) */
  correct(
    router: ModelRouter,
    context: AgentContext,
    notes: WorkNote[],
    answer: string,
    issues: string[],
    signal: AbortSignal,
  ): AsyncGenerator<LlmStreamEvent> {
    const messages: LlmMessage[] = [
      {
        role: 'system',
        content: systemPrompt(
          context.tenantPrompt,
          EXECUTOR_CORRECTION_ROLE,
          '',
          context.conversationSummary,
        ),
      },
      {
        role: 'user',
        content: [
          `User request:\n${context.request}`,
          `Working notes (not visible to the user):\n${renderNotes(notes)}`,
          `Your previous answer:\n${answer}`,
          `Problems found:\n${issues.map((i) => `- ${i}`).join('\n')}`,
          'Write the correction message now.',
        ].join('\n\n'),
      },
    ];
    return router.stream('executor', { messages }, signal);
  }
}
