import { Injectable } from '@nestjs/common';
import { EvaluatorService } from '../evaluator/evaluator.service.js';
import type { LlmUsage } from '../llm/llm.types.js';
import { PlannerService } from '../planner/planner.service.js';
import type { PlanStep } from '../tasks/plan.js';
import { type AgentRuntime, RuntimeError, type RunResult } from './agent-runtime.js';
import { ContextBuilder } from './context-builder.js';
import { ExecutorService } from './executor.service.js';
import { ModelRouterFactory } from './model-router.js';
import type { PlanView, WorkNote } from './prompts.js';
import type { RunContext } from './run-context.js';

/**
 * Agent Loop — Context → Plan → Execute(reason …) → Observe → Evaluate → (재계획) → Respond → Verify
 *
 * 단일 Agent 가 역할별 모델(planner · executor · evaluator)을 번갈아 쓴다.
 * 모든 단계는 RunContext.step 으로 기록되어 SSE 이벤트 · task_steps · checkpoint 가 남는다.
 * Tool · MCP · Skill 은 아직 없으므로 계획은 reason / respond 단계로만 이루어진다.
 */
@Injectable()
export class AgentLoopRuntime implements AgentRuntime {
  constructor(
    private readonly routers: ModelRouterFactory,
    private readonly contextBuilder: ContextBuilder,
    private readonly planner: PlannerService,
    private readonly executor: ExecutorService,
    private readonly evaluator: EvaluatorService,
  ) {}

  async run(ctx: RunContext): Promise<RunResult> {
    const router = await this.routers.forTask(ctx.task);
    const { signal } = ctx;

    // 1) Context
    const context = await ctx.step({ type: 'context', name: 'context.build' }, async () => {
      const built = await this.contextBuilder.build(ctx.task);
      return {
        value: built,
        summary: `최근 대화 ${built.history.length}개 · 지침 포함`,
        output: {
          historyMessages: built.history.length,
          tenantPromptChars: built.tenantPrompt.length,
          memories: 0,
          skills: 0,
          tools: 0,
        },
      };
    });

    // 2) Plan
    let plan = await ctx.step(
      { type: 'plan', name: 'planner.create', input: { model: router.describe('planner') } },
      async () => {
        const result = await this.planner.plan(router, context, null, signal);
        await ctx.setPlan(toPlanSteps(result.plan));
        return {
          value: result.plan,
          summary: `${result.plan.steps.length}단계 계획${result.fallback ? ' (기본 계획 사용)' : ''}`,
          output: { goal: result.plan.goal, fallback: result.fallback },
          usage: stepUsage(result.usage),
        };
      },
    );

    // 3) Execute(reason) → Evaluate → 필요하면 재계획
    const notes: WorkNote[] = [];
    for (let revision = 0; ; revision++) {
      for (const [i, step] of plan.steps.entries()) {
        if (step.kind !== 'reason') continue;
        const planIndex = i + 1;
        await ctx.step(
          {
            type: 'reason',
            name: 'executor.reason',
            planIndex,
            input: { title: step.title, model: router.describe('executor') },
          },
          async () => {
            const res = await this.executor.reason(router, context, plan, planIndex, notes, signal);
            const content = res.content.trim();
            if (!content) {
              throw new RuntimeError('MODEL_EMPTY_RESPONSE', '모델이 빈 결과를 돌려주었습니다');
            }
            notes.push({ title: step.title, content });
            ctx.workingMemory.notes = notes;
            return {
              value: content,
              summary: firstLine(content),
              output: { preview: truncate(content, 2_000), chars: content.length },
              usage: stepUsage(res.usage),
              checkpoint: true,
            };
          },
        );
      }

      if (!plan.steps.some((s) => s.kind === 'reason')) break;

      const assessment = await ctx.step(
        {
          type: 'evaluate',
          name: 'evaluator.assess',
          input: { model: router.describe('evaluator') },
        },
        async () => {
          const result = await this.evaluator.assess(router, context, plan, notes, signal);
          return {
            value: result,
            summary:
              result.verdict === 'replan' ? `재계획 필요: ${result.reason}` : '답변할 준비가 됨',
            evaluation: { verdict: result.verdict, reason: result.reason },
            usage: stepUsage(result.usage),
          };
        },
      );
      if (assessment.verdict !== 'replan' || revision >= ctx.task.executionPolicy.replanLimit)
        break;

      plan = await ctx.step(
        { type: 'plan', name: 'planner.revise', input: { model: router.describe('planner') } },
        async () => {
          const result = await this.planner.plan(
            router,
            context,
            { previous: plan, notes, feedback: assessment.reason },
            signal,
          );
          await ctx.setPlan(toPlanSteps(result.plan), assessment.reason);
          return {
            value: result.plan,
            summary: `계획 수정: ${result.plan.steps.length}단계`,
            output: { goal: result.plan.goal, fallback: result.fallback },
            usage: stepUsage(result.usage),
          };
        },
      );
    }

    // 4) Respond — 최종 답변 스트리밍
    const respondIndex = plan.steps.findIndex((s) => s.kind === 'respond') + 1;
    const answer = await ctx.step(
      {
        type: 'respond',
        name: 'executor.respond',
        planIndex: respondIndex,
        input: { model: router.describe('executor') },
      },
      async () => {
        let usage: LlmUsage | null = null;
        const stream = this.executor.respond(router, context, plan, notes, signal);
        async function* texts(): AsyncGenerator<string> {
          let produced = false;
          for await (const event of stream) {
            if (event.type === 'text') {
              produced = true;
              yield event.text;
            } else {
              usage = event.response.usage;
            }
          }
          if (!produced) {
            throw new RuntimeError('MODEL_EMPTY_RESPONSE', '모델이 빈 답변을 돌려주었습니다');
          }
        }
        const message = await ctx.streamAssistantMessage(texts());
        return {
          value: message,
          summary: '답변 작성 완료',
          output: { messageId: message.id, chars: message.text.length },
          usage: usage ? stepUsage(usage) : undefined,
          checkpoint: true,
        };
      },
    );

    // 5) Verify — 결과 검증 (W-04)
    const verification = await ctx.step(
      {
        type: 'evaluate',
        name: 'evaluator.verify',
        input: { model: router.describe('evaluator') },
      },
      async () => {
        const result = await this.evaluator.verify(router, context, notes, answer.text, signal);
        return {
          value: result,
          summary:
            result.summary || (result.verdict === 'pass' ? '검증 통과' : '검증 항목 확인 필요'),
          evaluation: { verdict: result.verdict, checks: result.checks, summary: result.summary },
          usage: stepUsage(result.usage),
        };
      },
    );

    return { messageId: answer.id, verification: verification.checks };
  }
}

function toPlanSteps(plan: PlanView): Array<Omit<PlanStep, 'status'>> {
  return plan.steps.map((step, i) => ({
    index: i + 1,
    title: step.title,
    kind: step.kind,
    requiresApproval: false,
  }));
}

function stepUsage(usage: LlmUsage): { inputTokens: number; outputTokens: number } {
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
}

function firstLine(text: string): string {
  return truncate(text.split('\n').find((line) => line.trim()) ?? '', 120);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
