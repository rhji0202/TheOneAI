import { z } from 'zod';

const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url().default('redis://localhost:6379'),
  SECRETS_BACKEND: z.enum(['local']).default('local'),
  DEV_SECRETS: z.string().default('{}'),
  WIDGET_SESSION_PRIVATE_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  WIDGET_SESSION_TTL_SEC: z.coerce.number().int().min(60).max(86_400).default(3_600),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
  AGENT_RUNTIME: z.enum(['loop', 'placeholder']).default('loop'),
  LLM_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
  LLM_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(60_000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  PLACEHOLDER_STREAM_DELAY_MS: z.coerce.number().int().min(0).max(5_000).default(40),
});

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  redisUrl: string;
  secrets: { backend: 'local'; devSecrets: Record<string, string> };
  widgetSession: { privateKeyPem: string | undefined; ttlSec: number };
  worker: { concurrency: number };
  /** loop = Agent Loop(LLM), placeholder = 파이프라인 확인용 고정 응답 */
  agentRuntime: 'loop' | 'placeholder';
  llm: { requestTimeoutMs: number; idleTimeoutMs: number; maxRetries: number };
  placeholderRuntime: { streamDelayMs: number };
}

export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`환경 변수가 올바르지 않습니다:\n${lines.join('\n')}`);
  }
  const env = parsed.data;

  let devSecrets: Record<string, string>;
  try {
    devSecrets = z.record(z.string(), z.string()).parse(JSON.parse(env.DEV_SECRETS));
  } catch {
    throw new Error('DEV_SECRETS 는 {"vault://…": "값"} 형식의 JSON 이어야 합니다.');
  }

  if (env.NODE_ENV === 'production') {
    if (env.SECRETS_BACKEND === 'local') {
      throw new Error(
        'production 에서는 SECRETS_BACKEND=local 을 사용할 수 없습니다 (Vault 연동 필요).',
      );
    }
    if (!env.WIDGET_SESSION_PRIVATE_KEY) {
      throw new Error('production 에서는 WIDGET_SESSION_PRIVATE_KEY 가 필요합니다.');
    }
  }

  return {
    env: env.NODE_ENV,
    port: env.PORT,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    secrets: { backend: env.SECRETS_BACKEND, devSecrets },
    widgetSession: {
      privateKeyPem: env.WIDGET_SESSION_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      ttlSec: env.WIDGET_SESSION_TTL_SEC,
    },
    worker: { concurrency: env.WORKER_CONCURRENCY },
    agentRuntime: env.AGENT_RUNTIME,
    llm: {
      requestTimeoutMs: env.LLM_REQUEST_TIMEOUT_MS,
      idleTimeoutMs: env.LLM_IDLE_TIMEOUT_MS,
      maxRetries: env.LLM_MAX_RETRIES,
    },
    placeholderRuntime: { streamDelayMs: env.PLACEHOLDER_STREAM_DELAY_MS },
  };
}
