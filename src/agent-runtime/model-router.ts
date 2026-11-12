import { Injectable, Logger } from '@nestjs/common';
import type {
  ModelRole,
  ReasoningEffort as DbReasoningEffort,
} from '../generated/prisma/client.js';
import { PrismaService } from '../infrastructure/database/prisma.service.js';
import { LlmClientFactory, type ProviderRecord } from '../llm/llm-client.factory.js';
import {
  type LlmClient,
  LlmError,
  type LlmMessage,
  type LlmResponse,
  type LlmStreamEvent,
  type LlmToolDefinition,
  type ReasoningEffort,
} from '../llm/llm.types.js';
import type { UsageMeter } from '../billing/usage-meter.js';
import { RuntimeError } from './agent-runtime.js';
import type { TaskRunInfo } from './run-context.js';

export type { ModelRole };

export interface ModelCall {
  messages: LlmMessage[];
  json?: boolean;
  tools?: LlmToolDefinition[];
  toolChoice?: 'auto' | 'none';
  /** 역할 설정보다 작게 제한할 때 */
  maxOutputTokens?: number;
}

interface Target {
  client: LlmClient;
  label: string;
  model: string;
  providerKind: string;
}

interface RoleModel {
  primary: Target;
  fallback: Target | null;
  maxOutputTokens: number;
  temperature: number;
  reasoning: ReasoningEffort | undefined;
}

/**
 * 작업 1건의 역할별 모델 (C-03 모델 구성: model_configs).
 *  - executor 는 필수, planner · evaluator 가 없으면 executor 설정을 쓴다.
 *  - 기본 모델 호출이 재시도 후에도 실패하면 대체(fallback) 모델로 한 번 더 시도한다.
 */
export class ModelRouter {
  private readonly logger = new Logger(ModelRouter.name);

  constructor(
    private readonly roles: Record<ModelRole, RoleModel>,
    /** 호출마다 실제로 응답한 모델의 사용량을 센다 (비용 · 사용량 기록) */
    private readonly meter: UsageMeter | null = null,
  ) {}

  describe(role: ModelRole): string {
    return this.roles[role].primary.label;
  }

  async complete(role: ModelRole, call: ModelCall, signal: AbortSignal): Promise<LlmResponse> {
    const config = this.roles[role];
    try {
      return this.metered(
        role,
        config.primary,
        await config.primary.client.complete(this.request(config, config.primary, call, signal)),
      );
    } catch (err) {
      if (!this.shouldFallback(err, config, signal))
        throw toRuntimeError(err, config.primary, role);
      this.logger.warn(
        `${role} 기본 모델 실패 → 대체 모델 ${config.fallback!.label}: ${String(err)}`,
      );
      try {
        return this.metered(
          role,
          config.fallback!,
          await config.fallback!.client.complete(
            this.request(config, config.fallback!, call, signal),
          ),
        );
      } catch (fallbackErr) {
        throw toRuntimeError(fallbackErr, config.fallback!, role);
      }
    }
  }

  /** 첫 텍스트가 나오기 전에 실패하면 대체 모델로 전환한다. */
  async *stream(
    role: ModelRole,
    call: ModelCall,
    signal: AbortSignal,
  ): AsyncGenerator<LlmStreamEvent> {
    const config = this.roles[role];
    let started = false;
    try {
      for await (const event of config.primary.client.stream(
        this.request(config, config.primary, call, signal),
      )) {
        started = true;
        if (event.type === 'done') this.metered(role, config.primary, event.response);
        yield event;
      }
      return;
    } catch (err) {
      if (started || !this.shouldFallback(err, config, signal))
        throw toRuntimeError(err, config.primary, role);
      this.logger.warn(
        `${role} 기본 모델 스트림 실패 → 대체 모델 ${config.fallback!.label}: ${String(err)}`,
      );
    }
    try {
      for await (const event of config.fallback!.client.stream(
        this.request(config, config.fallback!, call, signal),
      )) {
        if (event.type === 'done') this.metered(role, config.fallback!, event.response);
        yield event;
      }
    } catch (err) {
      throw toRuntimeError(err, config.fallback!, role);
    }
  }

  private metered(role: ModelRole, target: Target, response: LlmResponse): LlmResponse {
    this.meter?.record(role, target, response.usage);
    return response;
  }

  private request(config: RoleModel, target: Target, call: ModelCall, signal: AbortSignal) {
    return {
      model: target.model,
      messages: call.messages,
      maxOutputTokens: Math.min(
        call.maxOutputTokens ?? config.maxOutputTokens,
        config.maxOutputTokens,
      ),
      temperature: config.temperature,
      reasoning: config.reasoning,
      json: call.json,
      tools: call.tools,
      toolChoice: call.toolChoice,
      signal,
    };
  }

  private shouldFallback(err: unknown, config: RoleModel, signal: AbortSignal): boolean {
    return (
      !signal.aborted &&
      config.fallback !== null &&
      err instanceof LlmError &&
      (err.retryable || err.code === 'auth' || err.code === 'invalid_response')
    );
  }
}

/** 모델 오류 → task.failed 의 code · message (사용자에게 보여 줄 수 있는 수준) */
function toRuntimeError(err: unknown, target: Target, role: ModelRole): unknown {
  if (!(err instanceof LlmError)) return err; // 취소 등은 그대로
  const where = `${role} 모델(${target.label})`;
  switch (err.code) {
    case 'not_configured':
      return new RuntimeError('MODEL_NOT_CONFIGURED', err.message);
    case 'auth':
      return new RuntimeError(
        'MODEL_AUTH_FAILED',
        `${where} 인증에 실패했습니다. API Key 를 확인하세요.`,
      );
    case 'rate_limit':
      return new RuntimeError(
        'MODEL_RATE_LIMITED',
        `${where} 호출 한도를 넘었습니다. 잠시 후 다시 시도하세요.`,
      );
    case 'timeout':
      return new RuntimeError('MODEL_TIMEOUT', `${where} 응답 시간이 초과되었습니다.`);
    default:
      return new RuntimeError('MODEL_ERROR', `${where} 호출에 실패했습니다: ${err.message}`);
  }
}

@Injectable()
export class ModelRouterFactory {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clients: LlmClientFactory,
  ) {}

  async forTask(task: TaskRunInfo, meter: UsageMeter | null = null): Promise<ModelRouter> {
    const configs = await this.prisma.withTenant(task.tenantId, (tx) =>
      tx.modelConfig.findMany({
        where: { agentVersionId: task.agentVersionId },
        include: { provider: true, fallbackProvider: true },
      }),
    );
    const byRole = new Map(configs.map((c) => [c.role, c]));
    const executor = byRole.get('executor');
    if (!executor) {
      throw new RuntimeError(
        'MODEL_NOT_CONFIGURED',
        'Agent 버전에 executor 모델 설정이 없습니다 (Agent 설정 › 모델 구성)',
      );
    }

    const build = async (config: typeof executor): Promise<RoleModel> => {
      const primary = await this.target(config.provider, config.model);
      const fallback =
        config.fallbackProvider && config.fallbackModel
          ? await this.target(config.fallbackProvider, config.fallbackModel).catch(() => null)
          : null;
      return {
        primary,
        fallback,
        maxOutputTokens: config.maxOutputTokens,
        temperature: config.temperature,
        reasoning: toReasoning(config.reasoningEffort),
      };
    };

    const executorModel = await build(executor);
    const planner = byRole.get('planner');
    const evaluator = byRole.get('evaluator');
    return new ModelRouter(
      {
        executor: executorModel,
        planner: planner ? await build(planner) : executorModel,
        evaluator: evaluator ? await build(evaluator) : executorModel,
      },
      meter,
    );
  }

  private async target(provider: ProviderRecord, model: string): Promise<Target> {
    try {
      return {
        client: await this.clients.create(provider),
        label: `${provider.name}/${model}`,
        model,
        providerKind: provider.kind,
      };
    } catch (err) {
      if (err instanceof LlmError) throw new RuntimeError('MODEL_NOT_CONFIGURED', err.message);
      throw err;
    }
  }
}

function toReasoning(value: DbReasoningEffort | null): ReasoningEffort | undefined {
  return value ?? undefined;
}
