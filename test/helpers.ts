import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { SerializedPrismaPg } from '../src/infrastructure/database/serialized-pg-adapter.js';
import { SignJWT } from 'jose';
import { type SeededTenant, type SeedLlmInput, seedTenant } from '../prisma/seed.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap/configure-app.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { WorkerModule } from '../src/worker.module.js';
import { type FakeLlm, startFakeLlm } from './fake-llm-server.js';
import { FAKE_LLM_KEY, TEST_OWNER_URL, WIDGET_A, WIDGET_B, WIDGET_C } from './test-env.js';

export interface TestContext {
  app: INestApplication;
  baseUrl: string;
  owner: PrismaClient;
  llm: FakeLlm;
  tenantA: SeededTenant;
  tenantB: SeededTenant;
  /** 모델 API Key 가 없는 테넌트 */
  tenantC: SeededTenant;
  /** 이번 실행에서 쓰는 위젯 (공개 키에 실행별 접미사가 붙는다) */
  widgets: { A: TestWidget; B: TestWidget; C: TestWidget };
  /** 테넌트 slug (콘솔 로그인용) */
  slugs: { A: string; B: string; C: string };
  close(): Promise<void>;
}

export type TestWidget = typeof WIDGET_A;

/** 역할별 모델을 가짜 LLM 서버로 연결 (provider 종류는 deepseek — 요청 파라미터 매핑까지 확인) */
function fakeLlmConfig(baseUrl: string, secretRef = FAKE_LLM_KEY.ref): SeedLlmInput {
  return {
    provider: { name: 'fake-deepseek', kind: 'deepseek', baseUrl, secretRef },
    models: {
      planner: { model: 'fake-planner', maxOutputTokens: 1_000, reasoningEffort: 'low' },
      executor: {
        model: 'fake-executor',
        maxOutputTokens: 1_000,
        temperature: 0.3,
        reasoningEffort: 'off',
      },
      evaluator: { model: 'fake-evaluator', maxOutputTokens: 500 },
    },
  };
}

/** 가짜 LLM 서버 + API + Worker 를 한 프로세스에서 띄우고, 테넌트 3개(A · B · C)를 만든다. */
export async function startTestApp(): Promise<TestContext> {
  const llm = await startFakeLlm();
  const owner = new PrismaClient({
    adapter: new SerializedPrismaPg({ connectionString: TEST_OWNER_URL }),
  });
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const widgets = {
    A: { ...WIDGET_A, publicKey: `${WIDGET_A.publicKey}_${suffix}` },
    B: { ...WIDGET_B, publicKey: `${WIDGET_B.publicKey}_${suffix}` },
    C: { ...WIDGET_C, publicKey: `${WIDGET_C.publicKey}_${suffix}` },
  };
  const slugs = { A: `e2e-a-${suffix}`, B: `e2e-b-${suffix}`, C: `e2e-c-${suffix}` };
  const tenantA = await seedTenant(owner, {
    slug: slugs.A,
    members: Object.values(CONSOLE_MEMBERS),
    name: '테넌트 A',
    widget: {
      publicKey: widgets.A.publicKey,
      secretRef: widgets.A.secretRef,
      allowedOrigins: [widgets.A.origin],
    },
    llm: fakeLlmConfig(llm.baseUrl),
  });
  const tenantB = await seedTenant(owner, {
    slug: slugs.B,
    members: [CONSOLE_MEMBERS.owner],
    name: '테넌트 B',
    widget: {
      publicKey: widgets.B.publicKey,
      secretRef: widgets.B.secretRef,
      allowedOrigins: [widgets.B.origin],
    },
    llm: fakeLlmConfig(llm.baseUrl),
  });
  const tenantC = await seedTenant(owner, {
    slug: slugs.C,
    name: '테넌트 C',
    widget: {
      publicKey: widgets.C.publicKey,
      secretRef: widgets.C.secretRef,
      allowedOrigins: [widgets.C.origin],
    },
    llm: fakeLlmConfig(llm.baseUrl, 'vault://providers/missing'),
  });

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule, WorkerModule],
  }).compile();
  const app = configureApp(
    moduleRef.createNestApplication<NestExpressApplication>({ logger: ['error'] }),
  );
  await app.listen(0, '127.0.0.1');
  const baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');

  return {
    app,
    baseUrl,
    owner,
    llm,
    tenantA,
    tenantB,
    tenantC,
    widgets,
    slugs,
    async close() {
      await app.close();
      await owner.$disconnect();
      await llm.close();
    },
  };
}

/** 테넌트 A 의 콘솔 멤버 (B 에는 owner 만) */
export const CONSOLE_MEMBERS = {
  owner: { email: 'owner@e2e.test', name: 'Owner', role: 'owner', password: 'owner-pass-1234' },
  admin: { email: 'admin@e2e.test', name: 'Admin', role: 'admin', password: 'admin-pass-1234' },
  viewer: {
    email: 'viewer@e2e.test',
    name: 'Viewer',
    role: 'viewer',
    password: 'viewer-pass-1234',
  },
} as const;

/** 콘솔 로그인 → access token */
export async function adminLogin(
  baseUrl: string,
  tenantSlug: string,
  member: { email: string; password: string },
): Promise<string> {
  const res = await api<{ accessToken: string }>(baseUrl, 'POST', '/v1/admin/auth/login', {
    body: { tenantSlug, email: member.email, password: member.password },
  });
  if (res.status !== 200)
    throw new Error(`콘솔 로그인 실패: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.accessToken;
}

export async function identityToken(
  widget: { publicKey: string; secret: string },
  sub: string,
  options: { secret?: string } = {},
): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setAudience(widget.publicKey)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(options.secret ?? widget.secret));
}

export interface ApiResponse<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Headers;
}

export async function api<T = Record<string, unknown>>(
  baseUrl: string,
  method: string,
  path: string,
  options: {
    token?: string;
    body?: unknown;
    origin?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<ApiResponse<T>> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.origin ? { Origin: options.origin } : {}),
      ...options.headers,
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T, headers: res.headers };
}

/** 위젯 세션 발급 */
export async function startSession(
  baseUrl: string,
  widget: { publicKey: string; secret: string; origin: string },
  sub: string,
): Promise<string> {
  const res = await api<{ sessionToken: string }>(baseUrl, 'POST', '/v1/widget/bootstrap', {
    origin: widget.origin,
    body: { publicKey: widget.publicKey, identityToken: await identityToken(widget, sub) },
  });
  if (res.status !== 200)
    throw new Error(`bootstrap 실패: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.sessionToken;
}

export interface SseEvent {
  id: string | null;
  event: string;
  data: unknown;
}

/** 서버가 스트림을 닫을 때까지 SSE 이벤트를 모은다. */
export async function readSse(
  url: string,
  token: string,
  options: {
    lastEventId?: string;
    timeoutMs?: number;
    /** 이 이벤트를 받으면 연결을 끊고 돌려준다 (끝나지 않는 상태 — 승인 대기 등) */
    until?: (event: SseEvent) => boolean;
  } = {},
): Promise<SseEvent[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'text/event-stream',
        ...(options.lastEventId ? { 'Last-Event-ID': options.lastEventId } : {}),
      },
      signal: controller.signal,
    });
    if (res.status !== 200 || !res.body)
      throw new Error(`SSE 연결 실패: ${res.status} ${await res.text()}`);

    const events: SseEvent[] = [];
    const decoder = new TextDecoder();
    let buffer = '';
    stream: for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let index: number;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const event = parseBlock(block);
        if (event) events.push(event);
        if (event && options.until?.(event)) break stream; // 스트림을 닫고(연결 해제) 돌려준다
      }
    }
    return events;
  } finally {
    clearTimeout(timer);
  }
}

function parseBlock(block: string): SseEvent | null {
  let id: string | null = null;
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('id: ')) id = line.slice(4);
    else if (line.startsWith('event: ')) event = line.slice(7);
    else if (line.startsWith('data: ')) data.push(line.slice(6));
  }
  if (data.length === 0) return null;
  return { id, event, data: JSON.parse(data.join('\n')) };
}

export async function waitFor<T>(
  fn: () => Promise<T | null | undefined>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor 시간 초과');
    await new Promise((r) => setTimeout(r, 100));
  }
}
