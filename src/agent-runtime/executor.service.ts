import { Injectable } from '@nestjs/common';
import {
  addUsage,
  emptyUsage,
  type LlmMessage,
  type LlmStreamEvent,
  type LlmUsage,
} from '../llm/llm.types.js';
import { ToolDispatcherService } from '../tools/tool-dispatcher.service.js';
import type { ResolvedTool, Toolset } from '../tools/tool-registry.service.js';
import type { AgentContext } from './context-builder.js';
import type { ModelRouter } from './model-router.js';
import {
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
import type { RunContext } from './run-context.js';

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
      input.requiresApproval(tool) ? '[Not available in this version — do not call.]' : null,
    );
    const scope = new Set(definitions.map((d) => d.name));
    const role = input.skill
      ? `${EXECUTOR_WORK_ROLE}\n\n${skillSection(input.skill)}`
      : EXECUTOR_WORK_ROLE;
    const messages: LlmMessage[] = [
      { role: 'system', content: systemPrompt(context.tenantPrompt, role) },
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

    let usage = emptyUsage();
    let toolCalls = 0;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const res = await router.complete(
        'executor',
        { messages, tools: definitions.length > 0 ? definitions : undefined },
        ctx.signal,
      );
      usage = addUsage(usage, res.usage);
      if (res.toolCalls.length === 0) return { content: res.content.trim(), usage, toolCalls };

      messages.push({ role: 'assistant', content: res.content || null, toolCalls: res.toolCalls });
      const results = await this.dispatcher.dispatchAll(
        ctx,
        toolset,
        res.toolCalls,
        stepIndex,
        scope,
      );
      toolCalls += res.toolCalls.length;
      res.toolCalls.forEach((call, i) => {
        messages.push({ role: 'tool', toolCallId: call.id, content: results[i]!.content });
      });
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
          systemPrompt(context.tenantPrompt, respondRole(tools)) +
          (guidance.length ? `\n\n${guidance.join('\n\n')}` : ''),
      },
      ...context.history,
      { role: 'user', content: context.request },
    ];
    return router.stream('executor', { messages }, signal);
  }
}
