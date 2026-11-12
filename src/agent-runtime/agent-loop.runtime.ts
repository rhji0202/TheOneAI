import { Injectable } from '@nestjs/common';
import { EvaluatorService } from '../evaluator/evaluator.service.js';
import type { LlmUsage } from '../llm/llm.types.js';
import { PlannerService } from '../planner/planner.service.js';
import { SkillFileIntegrityError } from '../skills/skill-store.service.js';
import { SKILL_READ_FILE } from '../skills/skill-read-file.tool.js';
import {
  type LoadedSkill,
  SkillRuntimeService,
  SkillUnavailableError,
} from '../skills/skill-runtime.service.js';
import { matchesToolPattern } from '../tools/tool-names.js';
import type { SnapshotSkill } from '../tools/tool.types.js';
import type { PlanStep } from '../tasks/plan.js';
import { ToolAvailabilityService } from '../tools/tool-availability.service.js';
import { type PolicySet, ToolPermissionService } from '../tools/tool-permission.service.js';
import {
  type ResolvedTool,
  ToolRegistryService,
  type Toolset,
} from '../tools/tool-registry.service.js';
import { type AgentRuntime, RuntimeError, type RunResult } from './agent-runtime.js';
import { ContextBuilder } from './context-builder.js';
import { ExecutorService } from './executor.service.js';
import { ModelRouterFactory } from './model-router.js';
import type { PlanView, PromptSkill, PromptTool, WorkNote } from './prompts.js';
import type { RunContext } from './run-context.js';

/**
 * Agent Loop — Context → Plan → Execute(reason · tool · skill …) → Observe → Evaluate → (재계획) → Respond → Verify
 *
 * 단일 Agent 가 역할별 모델(planner · executor · evaluator)을 번갈아 쓴다.
 * Tool 은 작업 단계에서 모델이 요청하고, 서버의 Tool Dispatcher 가 검증 · 실행한다.
 * 사용할 수 있는 Tool 은 작업 생성 시 고정한 Registry 버전(tasks.registry_version_id)으로 정해진다.
 */
@Injectable()
export class AgentLoopRuntime implements AgentRuntime {
  constructor(
    private readonly routers: ModelRouterFactory,
    private readonly contextBuilder: ContextBuilder,
    private readonly planner: PlannerService,
    private readonly executor: ExecutorService,
    private readonly evaluator: EvaluatorService,
    private readonly registry: ToolRegistryService,
    private readonly permissions: ToolPermissionService,
    private readonly availability: ToolAvailabilityService,
    private readonly skills: SkillRuntimeService,
  ) {}

  async run(ctx: RunContext): Promise<RunResult> {
    const router = await this.routers.forTask(ctx.task);
    const { signal } = ctx;

    // 1) Context — 지침 · 대화 · 사용할 수 있는 Tool
    const { context, toolset, policies, offered, promptTools, skills, promptSkills } =
      await ctx.step({ type: 'context', name: 'context.build' }, async () => {
        const built = await this.contextBuilder.build(ctx.task);
        const tools = await this.registry.loadToolset(
          ctx.task.tenantId,
          ctx.task.registryVersionId,
        );
        const policy = await this.permissions.load(ctx.task.tenantId);
        // MCP Tool 은 이 Agent 버전의 허용 목록에 있고 서버 · Tool 이 지금 사용 가능한 것만 보여 준다
        const live = await this.availability.load(ctx.task.tenantId, ctx.task.agentVersionId);
        // Skill 전용 Tool(skill.*)은 Skill 단계에서만 준다
        const usable = tools.available.filter(
          (t) =>
            policy.planningMode(t) !== 'blocked' &&
            live.check(t) === 'ok' &&
            !t.name.startsWith('skill.'),
        );
        // Skill 은 metadata(이름 · 설명)만 계획에 보여 준다 — 전체 지침은 Skill 단계에서 로딩
        const allowedSkills = await this.skills.available(
          ctx.task.tenantId,
          ctx.task.agentVersionId,
          tools.skills,
        );
        const skillsForPrompt: PromptSkill[] = allowedSkills.map((k) => ({
          name: k.name,
          description: k.description,
        }));
        const prompt: PromptTool[] = usable.map((t) => ({
          llmName: t.llmName,
          level: t.level,
          description: t.description,
          requiresApproval: policy.planningMode(t) === 'approval',
        }));
        return {
          value: {
            context: built,
            toolset: tools,
            policies: policy,
            offered: usable,
            promptTools: prompt,
            skills: allowedSkills,
            promptSkills: skillsForPrompt,
          },
          summary: `최근 대화 ${built.history.length}개 · Tool ${usable.length}개`,
          output: {
            historyMessages: built.history.length,
            tenantPromptChars: built.tenantPrompt.length,
            registryVersionId: ctx.task.registryVersionId,
            tools: prompt.map((t) => ({ name: t.llmName, requiresApproval: t.requiresApproval })),
            memories: 0,
            skills: allowedSkills.map((k) => ({ name: k.name, version: k.version })),
          },
        };
      });

    // 2) Plan
    let plan = await ctx.step(
      { type: 'plan', name: 'planner.create', input: { model: router.describe('planner') } },
      async () => {
        const result = await this.planner.plan(
          router,
          context,
          promptTools,
          promptSkills,
          null,
          signal,
        );
        await ctx.setPlan(toPlanSteps(result.plan, toolset, policies, skills));
        return {
          value: result.plan,
          summary: `${result.plan.steps.length}단계 계획${result.fallback ? ' (기본 계획 사용)' : ''}`,
          output: { goal: result.plan.goal, fallback: result.fallback },
          usage: stepUsage(result.usage),
        };
      },
    );

    // 3) Execute(reason · tool · skill) → Evaluate → 필요하면 재계획
    const notes: WorkNote[] = [];
    for (let revision = 0; ; revision++) {
      for (const [i, step] of plan.steps.entries()) {
        if (step.kind === 'respond') continue;
        const planIndex = i + 1;
        const pinned =
          step.kind === 'skill' ? skills.find((k) => k.name === step.skill) : undefined;
        await ctx.step(
          {
            type: step.kind === 'skill' ? 'skill' : 'reason',
            name: step.kind === 'skill' ? `skill.${step.skill}` : `executor.${step.kind}`,
            planIndex,
            input: {
              title: step.title,
              tool: step.tool ?? null,
              ...(step.kind === 'skill'
                ? { skill: step.skill, version: pinned?.version ?? null }
                : {}),
              model: router.describe('executor'),
            },
          },
          async () => {
            const prepared =
              step.kind === 'skill'
                ? await this.prepareSkill(ctx, pinned, offered, toolset)
                : { tools: offered, skill: undefined };
            if ('unavailable' in prepared) {
              // Skill 을 쓸 수 없으면 그 사실을 노트로 남기고 계속 (답변에서 한계를 밝힌다)
              const content = `Skill '${step.skill}' could not be used: ${prepared.unavailable}`;
              notes.push({ title: step.title, content });
              ctx.workingMemory.notes = notes;
              return {
                value: content,
                summary: 'Skill 을 쓸 수 없음',
                output: { error: prepared.unavailable },
                status: 'failed' as const,
                checkpoint: true,
              };
            }
            const res = await this.executor.work({
              ctx,
              router,
              context,
              plan,
              stepIndex: planIndex,
              notes,
              toolset,
              tools: prepared.tools,
              skill: prepared.skill,
              requiresApproval: (tool) => policies.planningMode(tool) === 'approval',
            });
            if (!res.content) {
              throw new RuntimeError('MODEL_EMPTY_RESPONSE', '모델이 빈 결과를 돌려주었습니다');
            }
            notes.push({ title: step.title, content: res.content });
            ctx.workingMemory.notes = notes;
            return {
              value: res.content,
              summary: firstLine(res.content),
              output: {
                preview: truncate(res.content, 2_000),
                chars: res.content.length,
                toolCalls: res.toolCalls,
                ...(prepared.skill
                  ? {
                      skill: { name: prepared.skill.name, version: prepared.skill.version },
                      tools: prepared.tools.map((t) => t.name),
                    }
                  : {}),
              },
              usage: stepUsage(res.usage),
              checkpoint: true,
            };
          },
        );
      }

      if (!plan.steps.some((s) => s.kind !== 'respond')) break;

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
            promptTools,
            promptSkills,
            { previous: plan, notes, feedback: assessment.reason },
            signal,
          );
          await ctx.setPlan(toPlanSteps(result.plan, toolset, policies, skills), assessment.reason);
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
        const stream = this.executor.respond(router, context, plan, notes, promptTools, signal);
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

  /**
   * Skill 단계 준비 — 지금도 쓸 수 있는가(비활성화 · 허용 목록 변경 반영) 확인 후 고정된 버전을 로딩하고,
   * 모델에게 줄 Tool 을 allowed-tools 로 좁힌다 (권한 정책은 Dispatcher 가 그대로 적용).
   */
  private async prepareSkill(
    ctx: RunContext,
    pinned: SnapshotSkill | undefined,
    offered: ResolvedTool[],
    toolset: Toolset,
  ): Promise<{ tools: ResolvedTool[]; skill: LoadedSkill } | { unavailable: string }> {
    if (!pinned) return { unavailable: "it is not one of this agent's skills" };
    const [live] = await this.skills.available(ctx.task.tenantId, ctx.task.agentVersionId, [
      pinned,
    ]);
    if (!live) return { unavailable: 'it was disabled by the operator' };
    let loaded: LoadedSkill;
    try {
      loaded = await this.skills.load(ctx.task.tenantId, pinned);
    } catch (err) {
      if (err instanceof SkillUnavailableError || err instanceof SkillFileIntegrityError) {
        return { unavailable: err.message };
      }
      throw err;
    }
    const allowed = offered.filter((t) =>
      loaded.allowedTools.some((p) => p === '*' || matchesToolPattern(t.name, p)),
    );
    const reader = toolset.tools.find((t) => t.name === SKILL_READ_FILE && t.builtin);
    return { tools: reader ? [...allowed, reader] : allowed, skill: loaded };
  }
}

function toPlanSteps(
  plan: PlanView,
  toolset: Toolset,
  policies: PolicySet,
  skills: SnapshotSkill[],
): Array<Omit<PlanStep, 'status'>> {
  return plan.steps.map((step, i) => {
    const tool: ResolvedTool | undefined = step.tool ? toolset.byLlmName(step.tool) : undefined;
    const skill = step.skill ? skills.find((k) => k.name === step.skill) : undefined;
    return {
      index: i + 1,
      title: step.title,
      kind: step.kind,
      ...(tool ? { toolName: tool.name } : {}),
      ...(skill ? { skill: { name: skill.name, version: skill.version } } : {}),
      requiresApproval: tool ? policies.planningMode(tool) === 'approval' : false,
    };
  });
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
