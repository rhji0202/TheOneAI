import { Inject, Injectable, Logger } from '@nestjs/common';
import type { RunContext, StepOutcome } from '../agent-runtime/run-context.js';
import { uuidv7 } from '../common/uuid.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import type { Prisma, ToolExecutionStatus } from '../generated/prisma/client.js';
import type { LlmToolCall } from '../llm/llm.types.js';
import { McpConnectionService } from '../mcp/mcp-connection.service.js';
import { mcpResultToValue, ToolReportedError } from '../mcp/mcp-result.js';
import { validateAgainst } from './json-schema.js';
import { maskSensitive, preview } from './masking.js';
import { type ToolAvailability, ToolAvailabilityService } from './tool-availability.service.js';
import { ToolPermissionService } from './tool-permission.service.js';
import { isExecutable, type ResolvedTool, type Toolset } from './tool-registry.service.js';
import type { DeniedReason } from './tool.types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESULT_CHARS = 8_000;

export interface DispatchResult {
  /** 모델에게 돌려줄 tool 메시지 내용 (JSON 문자열) */
  content: string;
  status: ToolExecutionStatus;
  toolName: string;
}

interface DispatchOptions {
  planIndex?: number;
  parallelGroup?: string;
  /** 이 단계에서 모델에게 준 Tool (LLM 이름). 밖의 Tool 은 not_allowed (Skill 단계의 allowed-tools 범위 등) */
  scope?: ReadonlySet<string>;
}

class ToolTimeoutError extends Error {}

/**
 * Tool Dispatcher — 모델이 요청한 Tool 호출을 서버에서 검증하고 실행한다.
 *  1) 고정된 Registry 버전에 있는 Tool 인가 (없으면 unknown_tool 로 거부)
 *  2) MCP Tool: 이 Agent 의 허용 목록에 있는가(not_allowed) · 지금 서버 · Tool 이 사용 가능한가(tool_unavailable)
 *  3) 인자가 스키마에 맞는가 (내장: zod, MCP: JSON Schema — 아니면 실패를 모델에게 돌려줘 고치게 한다)
 *  4) 권한 정책 (거부 · 승인 필요 · 허용)
 *  5) 실행 (시간 제한 · 취소 전파 · 멱등 Tool 재시도) → tool_executions 기록, tool.called / tool.result 이벤트
 * 모든 호출은 결과와 무관하게 tool_executions 에 남는다 (거부 포함 → 무단 Tool 호출 지표).
 */
@Injectable()
export class ToolDispatcherService {
  private readonly logger = new Logger(ToolDispatcherService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly permissions: ToolPermissionService,
    private readonly availability: ToolAvailabilityService,
    private readonly mcp: McpConnectionService,
  ) {}

  /** 여러 호출: 모두 읽기 등급이고 병렬 실행이 켜져 있으면 동시에, 아니면 순서대로 (Agent 는 하나) */
  async dispatchAll(
    ctx: RunContext,
    toolset: Toolset,
    calls: LlmToolCall[],
    planIndex?: number,
    scope?: ReadonlySet<string>,
  ): Promise<DispatchResult[]> {
    const { parallelTools } = ctx.task.executionPolicy;
    const parallel =
      parallelTools.enabled &&
      calls.length > 1 &&
      calls.every((c) => toolset.byLlmName(c.name)?.level === 'read');
    if (!parallel) {
      const results: DispatchResult[] = [];
      for (const call of calls)
        results.push(await this.dispatch(ctx, toolset, call, { planIndex, scope }));
      return results;
    }
    const group = `p-${uuidv7().slice(-12)}`;
    const results: DispatchResult[] = [];
    for (let i = 0; i < calls.length; i += parallelTools.max) {
      const batch = calls.slice(i, i + parallelTools.max);
      results.push(
        ...(await Promise.all(
          batch.map((call) =>
            this.dispatch(ctx, toolset, call, { planIndex, parallelGroup: group, scope }),
          ),
        )),
      );
    }
    return results;
  }

  async dispatch(
    ctx: RunContext,
    toolset: Toolset,
    call: LlmToolCall,
    options: DispatchOptions = {},
  ): Promise<DispatchResult> {
    const tool = toolset.byLlmName(call.name);
    const toolName = tool?.name ?? call.name;
    const rawArgs = parseArguments(call.arguments);
    const maskedArgs = maskSensitive(rawArgs.ok ? rawArgs.value : call.arguments);

    return ctx.step<DispatchResult>(
      {
        type: 'tool',
        name: toolName,
        planIndex: options.planIndex,
        trackPlan: false,
        parallelGroup: options.parallelGroup,
        input: { arguments: maskedArgs as Prisma.InputJsonValue },
      },
      async (step) => {
        const executionId = uuidv7();
        const base = {
          id: executionId,
          tenantId: ctx.task.tenantId,
          taskId: ctx.task.id,
          stepId: step.id,
          registryVersionId: toolset.registryVersionId,
          source: tool?.source === 'mcp' ? ('mcp' as const) : ('builtin' as const),
          mcpToolId: tool?.mcpToolId ?? null,
          toolName,
          input: maskedArgs as Prisma.InputJsonValue,
        };

        // 1) Registry 확인
        if (!tool || !isExecutable(tool)) {
          await this.recordDenied(
            ctx,
            step.seq,
            base,
            'unknown_tool',
            '이 작업에 등록되지 않은 Tool 입니다',
          );
          return denial(
            toolName,
            'unknown_tool',
            `Tool '${call.name}' is not available. Use only the provided tools.`,
          );
        }

        // 2) MCP Tool — Agent 허용 목록 · 지금의 서버 · Tool 상태
        let availability: ToolAvailability | null = null;
        if (tool.source === 'mcp') {
          availability = await this.availability.load(ctx.task.tenantId, ctx.task.agentVersionId);
          const state = availability.check(tool);
          if (state === 'not_allowed') {
            await this.recordDenied(
              ctx,
              step.seq,
              base,
              'not_allowed',
              '이 Agent 에 허용되지 않은 MCP 서버의 Tool 입니다',
            );
            return denial(
              toolName,
              'not_allowed',
              `Tool '${call.name}' is not available. Use only the provided tools.`,
            );
          }
          if (state === 'unavailable') {
            await this.recordDenied(
              ctx,
              step.seq,
              base,
              'tool_unavailable',
              'MCP 서버 또는 Tool 을 지금 사용할 수 없습니다',
            );
            return denial(
              toolName,
              'tool_unavailable',
              'This tool is temporarily unavailable. Do not retry it; continue without it and tell the user if it matters.',
            );
          }
        }

        // 3) 인자 검증
        const parsed = validateArguments(tool, rawArgs);
        if (!parsed.ok) {
          const message = parsed.message;
          await this.recordFinished(ctx, step.seq, base, 'failed', {
            errorCode: 'INVALID_ARGUMENTS',
            errorMessage: message,
            durationMs: 0,
          });
          return {
            value: {
              content: JSON.stringify({ ok: false, error: 'INVALID_ARGUMENTS', message }),
              status: 'failed',
              toolName,
            },
            summary: '인자 오류',
            output: { error: 'INVALID_ARGUMENTS', message },
            status: 'failed',
          };
        }

        // 4) 권한
        const decision = (await this.permissions.load(ctx.task.tenantId)).decide(
          tool,
          parsed.value,
        );
        if (decision.decision === 'deny') {
          await this.recordDenied(
            ctx,
            step.seq,
            base,
            decision.deniedReason,
            decision.reason,
            decision.matchedRuleIds,
          );
          return denial(toolName, decision.deniedReason, `Not permitted: ${decision.reason}`);
        }
        if (decision.decision === 'require_approval') {
          // 승인 흐름(대기 → 결정 → 재개)은 개발 순서 10단계. 그 전까지는 실행하지 않고 모델에게 알린다.
          await this.recordDenied(
            ctx,
            step.seq,
            base,
            'approval_required',
            decision.reason,
            decision.matchedRuleIds,
          );
          return denial(
            toolName,
            'approval_required',
            'This action is not available in this version. Do not retry; tell the user it could not be performed.',
          );
        }

        // 이 단계에 주지 않은 Tool (Skill 의 allowed-tools 밖, 일반 단계의 Skill 전용 Tool 등)
        if (options.scope && !options.scope.has(call.name)) {
          await this.recordDenied(
            ctx,
            step.seq,
            base,
            'not_allowed',
            '이 단계에서 허용되지 않은 Tool 입니다',
          );
          return denial(
            toolName,
            'not_allowed',
            `Tool '${call.name}' is not available in this step. Use only the provided tools.`,
          );
        }

        // 5) 실행
        return this.execute(ctx, step.seq, tool, parsed.value, base, availability);
      },
    );
  }

  /** 실행. 멱등 Tool 은 실패 · 시간 초과 시 실행 정책(toolRetry)에 따라 지수 백오프로 다시 시도한다. */
  private async execute(
    ctx: RunContext,
    seq: number,
    tool: ResolvedTool,
    args: unknown,
    base: ExecutionBase,
    availability: ToolAvailability | null,
  ): Promise<StepOutcome<DispatchResult>> {
    const run = this.runner(ctx, tool, args, availability);
    const startedAt = new Date();
    await ctx.record(async (tx, emit) => {
      await tx.toolExecution.create({ data: { ...base, status: 'running', startedAt } });
      await emit('tool.called', {
        seq,
        executionId: base.id,
        toolName: tool.name,
        source: base.source,
        argsPreview: preview(base.input),
      });
    });

    const { toolRetry } = ctx.task.executionPolicy;
    const idempotent = tool.builtin?.idempotent ?? tool.idempotent ?? false;
    const maxAttempts = idempotent ? toolRetry.maxAttempts : 1;
    const timeoutMs =
      tool.builtin?.timeoutMs ??
      (tool.source === 'mcp' ? this.config.mcp.toolTimeoutMs : DEFAULT_TIMEOUT_MS);
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await runWithTimeout(run, ctx, timeoutMs);
        const masked = maskSensitive(result);
        await this.recordFinished(ctx, seq, base, 'succeeded', {
          output: masked,
          durationMs: Date.now() - startedAt.getTime(),
          attempt,
        });
        return {
          value: {
            content: truncate(JSON.stringify({ ok: true, result })),
            status: 'succeeded' as const,
            toolName: tool.name,
          },
          summary: preview(masked, 120),
          output: { result: masked as Prisma.InputJsonValue, attempts: attempt },
        };
      } catch (err) {
        if (ctx.signal.aborted) throw ctx.signal.reason ?? err; // 작업 취소 · 시간 제한은 작업 수준에서 처리
        const timedOut = err instanceof ToolTimeoutError;
        const message = timedOut
          ? `${timeoutMs}ms 안에 끝나지 않았습니다`
          : err instanceof Error
            ? err.message
            : String(err);
        // Tool 이 스스로 실패를 알린 경우(MCP isError)는 같은 결과가 나올 것이므로 다시 시도하지 않는다
        if (attempt < maxAttempts && !(err instanceof ToolReportedError)) {
          this.logger.warn(
            `Tool ${tool.name} 실패 (시도 ${attempt}/${maxAttempts}) — 다시 시도: ${message}`,
          );
          await sleep(toolRetry.baseMs * 2 ** (attempt - 1), ctx.signal);
          continue;
        }
        this.logger.warn(`Tool ${tool.name} 실패 (시도 ${attempt}/${maxAttempts}): ${message}`);
        const status: ToolExecutionStatus = timedOut ? 'timeout' : 'failed';
        const errorCode = timedOut ? 'TOOL_TIMEOUT' : 'TOOL_ERROR';
        await this.recordFinished(ctx, seq, base, status, {
          errorCode,
          errorMessage: message,
          durationMs: Date.now() - startedAt.getTime(),
          attempt,
        });
        return {
          value: {
            content: JSON.stringify({ ok: false, error: errorCode, message }),
            status,
            toolName: tool.name,
          },
          summary: timedOut ? '시간 초과' : '실행 실패',
          output: { error: message, attempts: attempt },
          status: 'failed' as const,
        };
      }
    }
  }

  /** 한 번 실행하는 함수 (내장: execute, MCP: tools/call → 결과 변환) */
  private runner(
    ctx: RunContext,
    tool: ResolvedTool,
    args: unknown,
    availability: ToolAvailability | null,
  ): (signal: AbortSignal) => Promise<unknown> {
    if (tool.builtin) {
      const builtin = tool.builtin;
      return (signal) =>
        builtin.execute(args, {
          tenantId: ctx.task.tenantId,
          taskId: ctx.task.id,
          endUserId: ctx.task.endUserId,
          conversationId: ctx.task.conversationId,
          registryVersionId: ctx.task.registryVersionId,
          agentVersionId: ctx.task.agentVersionId,
          signal,
        });
    }
    const target = availability?.target(tool.mcpServerId!);
    if (!target) throw new Error(`MCP 서버 정보를 찾을 수 없습니다: ${tool.name}`);
    const timeoutMs = this.config.mcp.toolTimeoutMs;
    return async (signal) =>
      mcpResultToValue(
        await this.mcp.callTool(
          target,
          tool.mcpToolName!,
          (args ?? {}) as Record<string, unknown>,
          {
            signal,
            // 응답 대기 상한은 Dispatcher 의 시간 제한이 먼저 걸리도록 조금 길게
            timeoutMs: timeoutMs + 1_000,
            inputSchema: tool.inputSchema,
          },
        ),
      );
  }

  private async recordDenied(
    ctx: RunContext,
    seq: number,
    base: ExecutionBase,
    reason: DeniedReason,
    message: string,
    matchedRuleIds: string[] = [],
  ): Promise<void> {
    await ctx.record(async (tx, emit) => {
      await tx.toolExecution.create({
        data: {
          ...base,
          status: 'denied',
          deniedReason: reason,
          errorMessage: message,
          output: matchedRuleIds.length ? { matchedRuleIds } : undefined,
          finishedAt: new Date(),
          durationMs: 0,
        },
      });
      await emit('tool.denied', {
        seq,
        executionId: base.id,
        toolName: base.toolName,
        reason,
        message,
      });
    });
  }

  private async recordFinished(
    ctx: RunContext,
    seq: number,
    base: ExecutionBase,
    status: ToolExecutionStatus,
    detail: {
      output?: unknown;
      errorCode?: string;
      errorMessage?: string;
      durationMs: number;
      attempt?: number;
    },
  ): Promise<void> {
    await ctx.record(async (tx, emit) => {
      await tx.toolExecution.upsert({
        where: { id: base.id },
        create: {
          ...base,
          status,
          attempt: detail.attempt ?? 1,
          output: detail.output as Prisma.InputJsonValue | undefined,
          errorCode: detail.errorCode,
          errorMessage: detail.errorMessage,
          finishedAt: new Date(),
          durationMs: detail.durationMs,
        },
        update: {
          status,
          attempt: detail.attempt ?? 1,
          output: detail.output as Prisma.InputJsonValue | undefined,
          errorCode: detail.errorCode,
          errorMessage: detail.errorMessage,
          finishedAt: new Date(),
          durationMs: detail.durationMs,
        },
      });
      await emit('tool.result', {
        seq,
        executionId: base.id,
        toolName: base.toolName,
        status,
        attempt: detail.attempt ?? 1,
        durationMs: detail.durationMs,
        resultPreview:
          detail.output !== undefined ? preview(detail.output) : (detail.errorMessage ?? null),
      });
    });
  }
}

interface ExecutionBase {
  id: string;
  tenantId: string;
  taskId: string;
  stepId: string;
  registryVersionId: string;
  source: 'builtin' | 'mcp';
  mcpToolId: string | null;
  toolName: string;
  input: Prisma.InputJsonValue;
}

function denial(
  toolName: string,
  reason: DeniedReason,
  message: string,
): StepOutcome<DispatchResult> {
  return {
    value: {
      content: JSON.stringify({ ok: false, error: reason.toUpperCase(), message }),
      status: 'denied' as const,
      toolName,
    },
    summary: reason === 'approval_required' ? '승인 필요 — 실행하지 않음' : '거부됨',
    output: { denied: reason },
    status: 'skipped' as const,
  };
}

/** 한 번 실행: 시간 제한 + 작업 취소 전파 */
async function runWithTimeout(
  run: (signal: AbortSignal) => Promise<unknown>,
  ctx: RunContext,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(ctx.signal.reason);
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(new ToolTimeoutError());
          reject(new ToolTimeoutError());
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener('abort', onAbort);
  }
}

/** 재시도 대기 (작업이 취소되면 바로 깨어난다) */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** 내장 Tool 은 zod, MCP Tool 은 Registry 에 고정된 JSON Schema 로 검증한다 */
function validateArguments(
  tool: ResolvedTool,
  raw: { ok: true; value: unknown } | { ok: false },
): { ok: true; value: unknown } | { ok: false; message: string } {
  if (!raw.ok) return { ok: false, message: 'arguments are not valid JSON' };
  if (tool.builtin) {
    const parsed = tool.builtin.input.safeParse(raw.value);
    return parsed.success
      ? { ok: true, value: parsed.data }
      : {
          ok: false,
          message: parsed.error.issues
            .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; '),
        };
  }
  if (!raw.value || typeof raw.value !== 'object' || Array.isArray(raw.value)) {
    return { ok: false, message: '(root): arguments must be a JSON object' };
  }
  const checked = validateAgainst(tool.inputSchema, raw.value);
  return checked.ok ? { ok: true, value: raw.value } : checked;
}

function parseArguments(raw: string): { ok: true; value: unknown } | { ok: false } {
  if (!raw.trim()) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

function truncate(text: string): string {
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}…(truncated)` : text;
}
