import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import type { AgentContext } from '../agent-runtime/context-builder.js';
import type { ModelRouter } from '../agent-runtime/model-router.js';
import {
  EVALUATOR_ASSESS_ROLE,
  EVALUATOR_VERIFY_ROLE,
  type PlanView,
  renderNotes,
  renderPlan,
  systemPrompt,
  type WorkNote,
} from '../agent-runtime/prompts.js';
import { parseJsonOutput } from '../llm/json-output.js';
import { addUsage, emptyUsage, type LlmMessage, type LlmUsage } from '../llm/llm.types.js';

const assessSchema = z.object({
  verdict: z.enum(['proceed', 'replan']),
  reason: z.string().max(2_000).default(''),
});

const verifySchema = z.object({
  verdict: z.enum(['pass', 'fail']),
  checks: z
    .array(z.object({ label: z.string().trim().min(1).max(80), passed: z.boolean() }))
    .min(1)
    .max(6),
  summary: z.string().max(500).default(''),
  issues: z.array(z.string().trim().min(1).max(300)).max(5).default([]),
});

export interface Assessment {
  verdict: 'proceed' | 'replan';
  reason: string;
  usage: LlmUsage;
}

export interface Verification {
  verdict: 'pass' | 'fail' | 'unknown';
  checks: Array<{ label: string; passed: boolean }>;
  summary: string;
  /** 사용자에게 바로잡아 알려야 할 구체적인 오류 (Reflection — 정정 메시지) */
  issues: string[];
  usage: LlmUsage;
}

/** Evaluate — 중간 평가(재계획 여부)와 최종 답변 검증(W-04 “결과 검증”). */
@Injectable()
export class EvaluatorService {
  private readonly logger = new Logger(EvaluatorService.name);

  async assess(
    router: ModelRouter,
    context: AgentContext,
    plan: PlanView,
    notes: WorkNote[],
    signal: AbortSignal,
  ): Promise<Assessment> {
    const result = await this.ask(
      router,
      [
        { role: 'system', content: systemPrompt(context.tenantPrompt, EVALUATOR_ASSESS_ROLE) },
        {
          role: 'user',
          content: [
            `User request:\n${context.request}`,
            `Plan:\n${renderPlan(plan)}`,
            `Working notes:\n${renderNotes(notes)}`,
            'Assess as JSON.',
          ].join('\n\n'),
        },
      ],
      assessSchema,
      signal,
    );
    if (!result.value) return { verdict: 'proceed', reason: '', usage: result.usage };
    return { ...result.value, usage: result.usage };
  }

  async verify(
    router: ModelRouter,
    context: AgentContext,
    notes: WorkNote[],
    answer: string,
    signal: AbortSignal,
  ): Promise<Verification> {
    const result = await this.ask(
      router,
      [
        { role: 'system', content: systemPrompt(context.tenantPrompt, EVALUATOR_VERIFY_ROLE) },
        {
          role: 'user',
          content: [
            `User request:\n${context.request}`,
            `Working notes:\n${renderNotes(notes)}`,
            `Final answer sent to the user:\n${answer}`,
            'Verify as JSON.',
          ].join('\n\n'),
        },
      ],
      verifySchema,
      signal,
    );
    if (!result.value) {
      return {
        verdict: 'unknown',
        checks: [{ label: '자동 검증을 완료하지 못함', passed: false }],
        summary: '',
        issues: [],
        usage: result.usage,
      };
    }
    return { ...result.value, usage: result.usage };
  }

  /** JSON 출력 요청 — 형식 오류면 한 번 다시 묻고, 그래도 안 되면 null */
  private async ask<T>(
    router: ModelRouter,
    messages: LlmMessage[],
    schema: z.ZodType<T>,
    signal: AbortSignal,
  ): Promise<{ value: T | null; usage: LlmUsage }> {
    let usage = emptyUsage();
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await router.complete('evaluator', { messages, json: true }, signal);
      usage = addUsage(usage, res.usage);
      const parsed = parseJsonOutput(res.content, schema);
      if (parsed.ok) return { value: parsed.value, usage };
      this.logger.warn(`평가 형식 오류 (시도 ${attempt + 1}): ${parsed.error}`);
      messages.push(
        { role: 'assistant', content: res.content },
        {
          role: 'user',
          content: `That output is invalid: ${parsed.error}. Respond again with only the JSON object.`,
        },
      );
    }
    return { value: null, usage };
  }
}
