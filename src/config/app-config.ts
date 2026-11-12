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
  ADMIN_SESSION_PRIVATE_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  ADMIN_SESSION_TTL_SEC: z.coerce.number().int().min(60).max(86_400).default(900),
  /** 파일 저장소 (Skill 번들 · 이후 산출물). local = 디렉터리 (개발 · 테스트 전용), S3 는 산출물 단계에서 */
  STORAGE_BACKEND: z.enum(['local']).default('local'),
  OBJECT_STORAGE_DIR: z.string().default('.storage'),
  /** 개발 · 테스트용 파일 Secret 저장소 (API · Worker 가 함께 읽는다). 비우면 메모리에만 저장 */
  LOCAL_SECRETS_FILE: z.string().optional(),
  /** http:// MCP 엔드포인트 허용 (개발 · 테스트 전용, production 에서는 거부) */
  MCP_ALLOW_INSECURE_HTTP: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  MCP_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(10_000),
  MCP_TOOL_TIMEOUT_MS: z.coerce.number().int().min(500).max(600_000).default(30_000),
  /** 서버별 재탐색 주기 */
  MCP_SYNC_INTERVAL_SEC: z.coerce.number().int().min(60).max(604_800).default(3_600),
  /** heartbeat 가 끊긴 작업 확인 주기 (0 이면 주기 잡을 등록하지 않는다) · 끊겼다고 볼 시간 */
  RECOVERY_TICK_SEC: z.coerce.number().int().min(0).max(3_600).default(30),
  RECOVERY_STALE_SEC: z.coerce.number().int().min(20).max(3_600).default(60),
  RECOVERY_MAX_ATTEMPTS: z.coerce.number().int().min(0).max(10).default(3),
  /** 재탐색 대상 확인 주기. 0 이면 주기 잡을 등록하지 않는다 */
  MCP_SYNC_TICK_SEC: z.coerce.number().int().min(0).max(3_600).default(60),
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
  secrets: { backend: 'local'; devSecrets: Record<string, string>; localFile: string | null };
  storage: { backend: 'local'; dir: string };
  widgetSession: { privateKeyPem: string | undefined; ttlSec: number };
  adminSession: { privateKeyPem: string | undefined; ttlSec: number };
  mcp: {
    allowInsecureHttp: boolean;
    connectTimeoutMs: number;
    toolTimeoutMs: number;
    syncIntervalSec: number;
    syncTickSec: number;
  };
  worker: { concurrency: number };
  recovery: { tickSec: number; staleSec: number; maxAttempts: number };
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
    if (!env.ADMIN_SESSION_PRIVATE_KEY) {
      throw new Error('production 에서는 ADMIN_SESSION_PRIVATE_KEY 가 필요합니다.');
    }
    if (env.STORAGE_BACKEND === 'local') {
      throw new Error(
        'production 에서는 STORAGE_BACKEND=local 을 사용할 수 없습니다 (S3 연동 필요).',
      );
    }
    if (env.MCP_ALLOW_INSECURE_HTTP) {
      throw new Error('production 에서는 MCP_ALLOW_INSECURE_HTTP 를 켤 수 없습니다.');
    }
  }

  return {
    env: env.NODE_ENV,
    port: env.PORT,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    secrets: {
      backend: env.SECRETS_BACKEND,
      devSecrets,
      localFile:
        env.LOCAL_SECRETS_FILE !== undefined
          ? env.LOCAL_SECRETS_FILE.trim() || null
          : env.NODE_ENV === 'development'
            ? '.secrets.local.json'
            : null,
    },
    widgetSession: {
      privateKeyPem: env.WIDGET_SESSION_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      ttlSec: env.WIDGET_SESSION_TTL_SEC,
    },
    storage: { backend: env.STORAGE_BACKEND, dir: env.OBJECT_STORAGE_DIR },
    adminSession: {
      privateKeyPem: env.ADMIN_SESSION_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      ttlSec: env.ADMIN_SESSION_TTL_SEC,
    },
    mcp: {
      allowInsecureHttp: env.MCP_ALLOW_INSECURE_HTTP,
      connectTimeoutMs: env.MCP_CONNECT_TIMEOUT_MS,
      toolTimeoutMs: env.MCP_TOOL_TIMEOUT_MS,
      syncIntervalSec: env.MCP_SYNC_INTERVAL_SEC,
      syncTickSec: env.MCP_SYNC_TICK_SEC,
    },
    worker: { concurrency: env.WORKER_CONCURRENCY },
    recovery: {
      tickSec: env.RECOVERY_TICK_SEC,
      staleSec: env.RECOVERY_STALE_SEC,
      maxAttempts: env.RECOVERY_MAX_ATTEMPTS,
    },
    agentRuntime: env.AGENT_RUNTIME,
    llm: {
      requestTimeoutMs: env.LLM_REQUEST_TIMEOUT_MS,
      idleTimeoutMs: env.LLM_IDLE_TIMEOUT_MS,
      maxRetries: env.LLM_MAX_RETRIES,
    },
    placeholderRuntime: { streamDelayMs: env.PLACEHOLDER_STREAM_DELAY_MS },
  };
}
