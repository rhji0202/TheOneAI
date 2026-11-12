import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import {
  MAX_PLAN_STEPS,
  PLANNER_ROLE,
  type PlanView,
  renderNotes,
  renderPlan,
  systemPrompt,
  type WorkNote,
} from '../agent-runtime/prompts.js';
import type { AgentContext } from '../agent-runtime/context-builder.js';
import type { ModelRouter } from '../agent-runtime/model-router.js';
import { parseJsonOutput } from '../llm/json-output.js';
import { addUsage, emptyUsage, type LlmMessage, type LlmUsage } from '../llm/llm.types.js';

export const plannerOutputSchema = z
  .object({
    goal: z.string().trim().min(1).max(500),
    steps: z
      .array(
        z.object({
          title: z.string().trim().min(1).max(120),
          kind: z.enum(['reason', 'respond']),
          instructions: z.string().max(4_000).default(''),
        }),
      )
      .min(1)
      .max(MAX_PLAN_STEPS),
  })
  .refine(
    (plan) =>
      plan.steps.filter((s) => s.kind === 'respond').length === 1 &&
      plan.steps.at(-1)?.kind === 'respond',
    { message: '"respond" step must appear exactly once, as the last step', path: ['steps'] },
  );

export interface PlannerResult {
  plan: PlanView;
  usage: LlmUsage;
  /** 모델 출력이 형식에 맞지 않아 기본 계획(답변 1단계)을 쓴 경우 */
  fallback: boolean;
}

export interface RevisionInput {
  previous: PlanView;
  notes: WorkNote[];
  feedback: string;
}

/** Plan — 계획 생성 · 수정. 출력이 형식에 맞지 않으면 한 번 고쳐 달라고 하고, 그래도 안 되면 기본 계획. */
@Injectable()
export class PlannerService {
  private readonly logger = new Logger(PlannerService.name);

  async plan(
    router: ModelRouter,
    context: AgentContext,
    revision: RevisionInput | null,
    signal: AbortSignal,
  ): Promise<PlannerResult> {
    const messages: LlmMessage[] = [
      { role: 'system', content: systemPrompt(context.tenantPrompt, PLANNER_ROLE) },
      ...context.history,
      { role: 'user', content: this.userMessage(context, revision) },
    ];

    let usage = emptyUsage();
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await router.complete('planner', { messages, json: true }, signal);
      usage = addUsage(usage, res.usage);
      const parsed = parseJsonOutput(res.content, plannerOutputSchema);
      if (parsed.ok) {
        return {
          plan: {
            goal: parsed.value.goal,
            steps: parsed.value.steps.map((s) => ({ ...s, title: truncate(s.title, 40) })),
          },
          usage,
          fallback: false,
        };
      }
      this.logger.warn(`계획 형식 오류 (시도 ${attempt + 1}): ${parsed.error}`);
      messages.push(
        { role: 'assistant', content: res.content },
        {
          role: 'user',
          content: `That output is invalid: ${parsed.error}. Respond again with only the JSON object in the required shape.`,
        },
      );
    }
    return { plan: fallbackPlan(context.request), usage, fallback: true };
  }

  private userMessage(context: AgentContext, revision: RevisionInput | null): string {
    const request = `User request:\n${context.request}`;
    if (!revision) return `${request}\n\nCreate the plan as JSON.`;
    return [
      request,
      `Previous plan:\n${renderPlan(revision.previous)}`,
      `Working notes so far:\n${renderNotes(revision.notes)}`,
      `Evaluator feedback:\n${revision.feedback}`,
      'Create a revised plan as JSON. Keep useful work from the notes; do not repeat steps that already produced what is needed.',
    ].join('\n\n');
  }
}

export function fallbackPlan(request: string): PlanView {
  return {
    goal: truncate(request, 200),
    steps: [{ title: '답변 작성', kind: 'respond', instructions: '' }],
  };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
