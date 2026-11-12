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
import {
  type PolicySet,
  type PolicySnapshot,
  ToolPermissionService,
} from '../tools/tool-permission.service.js';
import {
  type ResolvedTool,
  ToolRegistryService,
  type Toolset,
} from '../tools/tool-registry.service.js';
import { type AgentRuntime, RuntimeError, type RunResult } from './agent-runtime.js';
import { type AgentContext, ContextBuilder } from './context-builder.js';
import { ContextCompressor, NOTES_COMPRESS_CHARS } from './context-compressor.js';
import { ExecutorService, type PendingWork } from './executor.service.js';
import { type ModelRouter, ModelRouterFactory } from './model-router.js';
import {
  type PlanView,
  type PromptSkill,
  type PromptTool,
  renderNotes,
  type WorkNote,
} from './prompts.js';
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
    private readonly compressor: ContextCompressor,
  ) {}

  async run(ctx: RunContext): Promise<RunResult> {
    const router = await this.routers.forTask(ctx.task, ctx.meter);
    const { signal } = ctx;

    // 1) Context — 지침 · 대화 · 사용할 수 있는 Tool
    const { context, toolset, policies, offered, promptTools, skills, promptSkills } =
      await ctx.step({ type: 'context', name: 'context.build' }, async () => {
        const {
          context: built,
          compression,
          usage,
        } = await this.contextBuilder.build(ctx.task, {
          router,
          signal,
        });
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
            tools: prompt.map((t) => ({ name: t.llmName, requiresApproval: t.requiresApproval })),
            memories: built.memoryHits.map((m) => ({
              id: m.id,
              type: m.type,
              ...(m.via ? { via: m.via } : { score: m.score }),
            })),
            skills: allowedSkills.map((k) => ({ name: k.name, version: k.version })),
          },
        };
      });

    const baseRequest = context.request;
    const applySteers = () => this.applySteers(ctx, context, baseRequest);
    await applySteers();

    // 2) Plan — 재개면 마지막 checkpoint 의 계획 · 노트에서 이어 간다
    const resumed = readResume(ctx);
    let plan: PlanView;
    let notes: WorkNote[];
    if (resumed) {
      plan = resumed.plan;
      notes = resumed.notes;
      if (ctx.currentPlan?.version !== ctx.resume!.checkpoint.planVersion) {
        // checkpoint 뒤에 계획을 고치다 멈춘 경우 — checkpoint 의 계획으로 되돌린다
        await ctx.setPlan(
          toPlanSteps(plan, toolset, policies, skills),
          '마지막 checkpoint 의 계획으로 재개',
        );
      }
      await ctx.record(async (_tx, emit) => {
        await emit('task.resumed', {
          reason: ctx.resume!.reason,
          fromStepId: ctx.resume!.fromStepId,
          fromPlanIndex: resumed.nextPlanIndex,
          planVersion: ctx.currentPlan?.version ?? null,
        });
      });
    } else {
      plan = await ctx.step(
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
      notes = [];
    }
    ctx.workingMemory.planView = plan;

    // 3) Execute(reason · tool · skill) → Evaluate → 필요하면 재계획
    const startIndex = resumed?.nextPlanIndex ?? 1;
    // 답변까지 보낸 뒤 멈췄다면 검증만 남았다
    const sentAnswer = resumed?.answer ?? null;
    for (let revision = 0; sentAnswer === null; revision++) {
      for (const [i, step] of plan.steps.entries()) {
        if (step.kind === 'respond') continue;
        const planIndex = i + 1;
        // 재개: checkpoint 까지 끝난 단계는 다시 하지 않는다 (같은 계획일 때만)
        if (revision === 0 && planIndex < startIndex) continue;
        await applySteers();
        notes = await this.compressNotes(ctx, router, context, notes);
        const pinned =
          step.kind === 'skill' ? skills.find((k) => k.name === step.skill) : undefined;
        // 승인 대기 뒤 재개: 이 단계에서 멈췄던 대화부터 이어 간다
        const pendingWork = ctx.workingMemory.pendingWork as PendingWork | undefined;
        const pending =
          revision === 0 && planIndex === startIndex && pendingWork?.planIndex === planIndex
            ? pendingWork
            : undefined;
        await ctx.step(
          {
            type: step.kind === 'skill' ? 'skill' : 'reason',
            name: step.kind === 'skill' ? `skill.${step.skill}` : `executor.${step.kind}`,
            planIndex,
            checkpointOnApproval: true,
            input: {
              title: step.title,
              tool: step.tool ?? null,
              ...(step.kind === 'skill'
                ? { skill: step.skill, version: pinned?.version ?? null }
                : {}),
              model: router.describe('executor'),
              ...(pending ? { continuedAfterApproval: true } : {}),
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
              pending,
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
      notes = await this.compressNotes(ctx, router, context, notes);

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
          // Reflection — 이 작업에서 실패 · 거부된 Tool 호출을 재계획에 알려 같은 시도를 반복하지 않게 한다
          const problems = await this.problemsSoFar(ctx);
          const result = await this.planner.plan(
            router,
            context,
            promptTools,
            promptSkills,
            { previous: plan, notes, feedback: assessment.reason, problems },
            signal,
          );
          await ctx.setPlan(toPlanSteps(result.plan, toolset, policies, skills), assessment.reason);
          ctx.workingMemory.planView = result.plan;
          return {
            value: result.plan,
            summary: `계획 수정: ${result.plan.steps.length}단계`,
            output: { goal: result.plan.goal, fallback: result.fallback, problems },
            usage: stepUsage(result.usage),
          };
        },
      );
    }

    // 4) Respond — 최종 답변 스트리밍
    const respondIndex = plan.steps.findIndex((s) => s.kind === 'respond') + 1;
    if (!sentAnswer) {
      await applySteers();
      notes = await this.compressNotes(ctx, router, context, notes);
    }
    const answer =
      sentAnswer ??
      (await ctx.step(
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
          ctx.workingMemory.answer = { id: message.id, text: message.text };
          return {
            value: message,
            summary: '답변 작성 완료',
            output: { messageId: message.id, chars: message.text.length },
            usage: usage ? stepUsage(usage) : undefined,
            checkpoint: true,
          };
        },
      ));

    // 5) Verify — 결과 검증 (W-04)
    const verify = (text: string, name = 'evaluator.verify') =>
      ctx.step(
        { type: 'evaluate', name, input: { model: router.describe('evaluator') } },
        async () => {
          const result = await this.evaluator.verify(router, context, notes, text, signal);
          return {
            value: result,
            summary:
              result.summary || (result.verdict === 'pass' ? '검증 통과' : '검증 항목 확인 필요'),
            evaluation: {
              verdict: result.verdict,
              checks: result.checks,
              summary: result.summary,
              issues: result.issues,
            },
            usage: stepUsage(result.usage),
          };
        },
      );
    const sentCorrection =
      (ctx.workingMemory.correction as { id: string; text: string } | undefined) ?? null;
    let verification = sentCorrection ? null : await verify(answer.text);

    // 6) Reflection — 검증에서 구체적인 오류가 나오면 한 번 바로잡는 후속 메시지를 보내고 다시 검증한다
    let correction = sentCorrection;
    if (
      !correction &&
      verification?.verdict === 'fail' &&
      verification.issues.length > 0 &&
      ctx.task.executionPolicy.selfCorrection
    ) {
      const issues = verification.issues;
      correction = await ctx.step(
        {
          type: 'respond',
          name: 'executor.correct',
          planIndex: respondIndex,
          trackPlan: false,
          input: { model: router.describe('executor'), issues },
        },
        async () => {
          let usage: LlmUsage | null = null;
          const stream = this.executor.correct(router, context, notes, answer.text, issues, signal);
          async function* texts(): AsyncGenerator<string> {
            for await (const event of stream) {
              if (event.type === 'text') yield event.text;
              else usage = event.response.usage;
            }
          }
          const message = await ctx.streamAssistantMessage(texts());
          ctx.workingMemory.correction = { id: message.id, text: message.text };
          return {
            value: message,
            summary: '검증에서 나온 오류를 바로잡음',
            output: { messageId: message.id, chars: message.text.length, issues },
            usage: usage ? stepUsage(usage) : undefined,
            checkpoint: true,
          };
        },
      );
    }
    if (correction && (!verification || verification.verdict === 'fail')) {
      verification = await verify(
        `${answer.text}\n\n[Follow-up correction sent to the user]\n${correction.text}`,
        'evaluator.verify_correction',
      );
    }

    return {
      messageId: answer.id,
      verification: verification!.checks,
      ...(correction ? { correctionMessageId: correction.id } : {}),
    };
  }

  /** Context Compression — 작업 노트가 길어지면 앞 단계 노트를 하나로 줄인다 (단계로 기록) */
  private async compressNotes(
    ctx: RunContext,
    router: ModelRouter,
    context: AgentContext,
    notes: WorkNote[],
  ): Promise<WorkNote[]> {
    const before = renderNotes(notes).length;
    if (before <= NOTES_COMPRESS_CHARS) return notes;
    const compressed = await ctx.step(
      {
        type: 'context',
        name: 'context.compress_notes',
        input: { model: router.describe('evaluator'), notes: notes.length, chars: before },
      },
      async () => {
        const result = await this.compressor.compressNotes(
          router,
          context.request,
          notes,
          ctx.signal,
        );
        const next = result?.value ?? notes;
        const after = renderNotes(next).length;
        return {
          value: next,
          summary: result
            ? `작업 노트 ${notes.length}개 → ${next.length}개 (${before}자 → ${after}자)`
            : '줄이지 못함 — 그대로 진행',
          output: {
            before: { notes: notes.length, chars: before },
            after: { notes: next.length, chars: after },
          },
          usage: result ? stepUsage(result.usage) : undefined,
        };
      },
    );
    ctx.workingMemory.notes = compressed;
    return compressed;
  }

  /** Reflection — 이 작업에서 실패 · 거부 · 시간 초과된 Tool 호출 (재계획 입력) */
  private async problemsSoFar(ctx: RunContext): Promise<string[]> {
    const rows = await ctx.read((tx) =>
      tx.toolExecution.findMany({
        where: { taskId: ctx.task.id, status: { in: ['failed', 'timeout', 'denied'] } },
        orderBy: { startedAt: 'asc' },
        take: 20,
        select: {
          toolName: true,
          status: true,
          deniedReason: true,
          errorCode: true,
          errorMessage: true,
        },
      }),
    );
    return rows.map(
      (r) =>
        `${r.toolName}: ${r.status === 'denied' ? `refused (${r.deniedReason ?? 'denied'})` : r.status === 'timeout' ? 'timed out' : `failed (${r.errorCode ?? 'error'})`}${r.errorMessage ? ` — ${truncate(r.errorMessage, 200)}` : ''}`,
    );
  }

  /**
   * 실행 중 추가 지시(steer) 반영 — 아직 반영하지 않은 지시를 요청 뒤에 붙여 다음 단계부터 쓴다.
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

/** 재개 상태 — checkpoint 의 workingMemory 에서 계획 · 노트 · 다음 단계 · 보낸 답변 */
function readResume(ctx: RunContext): {
  plan: PlanView;
  notes: WorkNote[];
  nextPlanIndex: number;
  answer: { id: string; text: string } | null;
} | null {
  if (!ctx.resume) return null;
  const memory = ctx.workingMemory;
  const plan = memory.planView as PlanView | undefined;
  if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) return null;
  const answer = memory.answer as { id: string; text: string } | undefined;
  return {
    plan,
    notes: Array.isArray(memory.notes) ? (memory.notes as WorkNote[]) : [],
    nextPlanIndex: ctx.resume.checkpoint.nextPlanIndex,
    answer: answer && typeof answer.id === 'string' ? answer : null,
  };
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
