import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import type { AgentContext } from '../agent-runtime/context-builder.js';
import type { ModelRouter } from '../agent-runtime/model-router.js';
import {
  MAX_PLAN_STEPS,
  plannerRole,
  type PromptSkill,
  type PlanView,
  type PromptTool,
  renderNotes,
  renderPlan,
  systemPrompt,
  type WorkNote,
} from '../agent-runtime/prompts.js';
import { parseJsonOutput } from '../llm/json-output.js';
import { addUsage, emptyUsage, type LlmMessage, type LlmUsage } from '../llm/llm.types.js';

/**
 * 계획 출력 스키마. Tool 단계는 실행 가능한(승인 불필요) Tool 만 가리킬 수 있다.
 * 형식이 틀리면 오류 내용을 모델에게 돌려줘 한 번 고치게 한다.
 */
export function plannerOutputSchema(runnableTools: string[], skills: string[] = []) {
  return z
    .object({
      goal: z.string().trim().min(1).max(500),
      steps: z
        .array(
          z.object({
            title: z.string().trim().min(1).max(120),
            kind: z.enum(['reason', 'tool', 'skill', 'respond']),
            tool: z.string().optional(),
            skill: z.string().optional(),
            instructions: z.string().max(4_000).default(''),
          }),
        )
        .min(1)
        .max(MAX_PLAN_STEPS),
    })
    .superRefine((plan, ctx) => {
      const responds = plan.steps.filter((s) => s.kind === 'respond').length;
      if (responds !== 1 || plan.steps.at(-1)?.kind !== 'respond') {
        ctx.addIssue({
          code: 'custom',
          path: ['steps'],
          message: '"respond" step must appear exactly once, as the last step',
        });
      }
      plan.steps.forEach((step, i) => {
        if (step.kind === 'tool' && (!step.tool || !runnableTools.includes(step.tool))) {
          ctx.addIssue({
            code: 'custom',
            path: ['steps', i, 'tool'],
            message: `"${step.tool ?? ''}" is not an available tool. Use one of: ${runnableTools.join(', ') || '(none — use "reason" or "respond")'}`,
          });
        }
        if (step.kind === 'skill' && (!step.skill || !skills.includes(step.skill))) {
          ctx.addIssue({
            code: 'custom',
            path: ['steps', i, 'skill'],
            message: `"${step.skill ?? ''}" is not an available skill. Use one of: ${skills.join(', ') || '(none — do not use "skill" steps)'}`,
          });
        }
      });
    });
}

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
  /** Reflection — 이 작업에서 실패 · 거부된 Tool 호출 */
  problems?: string[];
}

/** Plan — 계획 생성 · 수정. 출력이 형식에 맞지 않으면 한 번 고쳐 달라고 하고, 그래도 안 되면 기본 계획. */
@Injectable()
export class PlannerService {
  private readonly logger = new Logger(PlannerService.name);

  async plan(
    router: ModelRouter,
    context: AgentContext,
    tools: PromptTool[],
    skills: PromptSkill[],
    revision: RevisionInput | null,
    signal: AbortSignal,
  ): Promise<PlannerResult> {
    const schema = plannerOutputSchema(
      tools.map((t) => t.llmName),
      skills.map((s) => s.name),
    );
    const messages: LlmMessage[] = [
      {
        role: 'system',
        content: systemPrompt(
          context.tenantPrompt,
          plannerRole(tools, skills),
          context.memories,
          context.conversationSummary,
        ),
      },
      ...context.history,
      { role: 'user', content: this.userMessage(context, revision), images: context.images },
    ];

    let usage = emptyUsage();
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await router.complete('planner', { messages, json: true }, signal);
      usage = addUsage(usage, res.usage);
      const parsed = parseJsonOutput(res.content, schema);
      if (parsed.ok) {
        return {
          plan: {
            goal: parsed.value.goal,
            steps: parsed.value.steps.map((s) => ({
              title: truncate(s.title, 40),
              kind: s.kind,
              ...(s.kind === 'tool' && s.tool ? { tool: s.tool } : {}),
              ...(s.kind === 'skill' && s.skill ? { skill: s.skill } : {}),
              instructions: s.instructions,
            })),
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
      ...(revision.problems?.length
        ? [
            `Problems so far (tool calls in this task that failed or were refused — do not plan the same call again unless something changed):\n${revision.problems.map((p) => `- ${p}`).join('\n')}`,
          ]
        : []),
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
