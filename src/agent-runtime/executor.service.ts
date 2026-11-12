import { Injectable } from '@nestjs/common';
import type { LlmMessage, LlmResponse, LlmStreamEvent } from '../llm/llm.types.js';
import type { AgentContext } from './context-builder.js';
import type { ModelRouter } from './model-router.js';
import {
  EXECUTOR_REASON_ROLE,
  EXECUTOR_RESPOND_ROLE,
  type PlanView,
  renderNotes,
  renderPlan,
  systemPrompt,
  type WorkNote,
} from './prompts.js';

/** Execute — reason 단계(내부 작업)와 respond 단계(사용자 답변 스트리밍). Tool 호출은 4단계에서 여기에 더한다. */
@Injectable()
export class ExecutorService {
  reason(
    router: ModelRouter,
    context: AgentContext,
    plan: PlanView,
    stepIndex: number,
    notes: WorkNote[],
    signal: AbortSignal,
  ): Promise<LlmResponse> {
    const step = plan.steps[stepIndex - 1]!;
    const messages: LlmMessage[] = [
      { role: 'system', content: systemPrompt(context.tenantPrompt, EXECUTOR_REASON_ROLE) },
      ...context.history,
      {
        role: 'user',
        content: [
          `User request:\n${context.request}`,
          `Goal: ${plan.goal}`,
          `Plan:\n${renderPlan(plan, stepIndex)}`,
          `Working notes from earlier steps:\n${renderNotes(notes)}`,
          `Current step ${stepIndex}: ${step.title}\nInstructions: ${step.instructions || '(none)'}`,
        ].join('\n\n'),
      },
    ];
    return router.complete('executor', { messages }, signal);
  }

  respond(
    router: ModelRouter,
    context: AgentContext,
    plan: PlanView,
    notes: WorkNote[],
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
          systemPrompt(context.tenantPrompt, EXECUTOR_RESPOND_ROLE) +
          (guidance.length ? `\n\n${guidance.join('\n\n')}` : ''),
      },
      ...context.history,
      { role: 'user', content: context.request },
    ];
    return router.stream('executor', { messages }, signal);
  }
}
