import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import { SignJWT } from 'jose';
import { type SeededTenant, seedTenant } from '../prisma/seed.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap/configure-app.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { WorkerModule } from '../src/worker.module.js';
import { TEST_OWNER_URL, WIDGET_A, WIDGET_B } from './test-env.js';

export interface TestContext {
  app: INestApplication;
  baseUrl: string;
  owner: PrismaClient;
  tenantA: SeededTenant;
  tenantB: SeededTenant;
  close(): Promise<void>;
}

/** API + Worker 를 한 프로세스에서 띄우고, 테넌트 2개(A · B)를 만든다. */
export async function startTestApp(): Promise<TestContext> {
  const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_OWNER_URL }) });
  const suffix = Date.now().toString(36);
  const tenantA = await seedTenant(owner, {
    slug: `e2e-a-${suffix}`,
    name: '테넌트 A',
    widget: {
      publicKey: WIDGET_A.publicKey,
      secretRef: WIDGET_A.secretRef,
      allowedOrigins: [WIDGET_A.origin],
    },
  });
  const tenantB = await seedTenant(owner, {
    slug: `e2e-b-${suffix}`,
    name: '테넌트 B',
    widget: {
      publicKey: WIDGET_B.publicKey,
      secretRef: WIDGET_B.secretRef,
      allowedOrigins: [WIDGET_B.origin],
    },
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
    tenantA,
    tenantB,
    async close() {
      await app.close();
      await owner.$disconnect();
    },
  };
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
  options: { lastEventId?: string; timeoutMs?: number } = {},
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
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let index: number;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const event = parseBlock(block);
        if (event) events.push(event);
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
