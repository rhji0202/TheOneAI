import {
  api,
  identityToken,
  readSse,
  type SseEvent,
  startSession,
  startTestApp,
  type TestContext,
  waitFor,
} from './helpers.js';
import { RedisService } from '../src/infrastructure/redis/redis.service.js';

interface TaskSummary {
  id: string;
  status: string;
  conversationId: string;
}
interface SendResponse {
  message: { id: string; taskId: string };
  task: TaskSummary;
  eventsUrl: string;
}
interface BootstrapBody {
  sessionToken: string;
  endUser: { id: string; anonymous: boolean };
  agent: { id: string; welcomeMessage: string };
  theme: { position: string };
  activeTasks: unknown[];
}
interface TaskDetailBody {
  status: string;
  lastEventId: string | null;
  result: {
    messageId: string | null;
    verification: Array<{ label: string; passed: boolean }>;
  } | null;
}

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startTestApp();
});

afterAll(async () => {
  await ctx?.close();
});

async function newConversation(token: string): Promise<string> {
  const res = await api<{ id: string }>(ctx.baseUrl, 'POST', '/v1/conversations', {
    token,
    body: {},
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function send(token: string, conversationId: string, text: string, idempotencyKey?: string) {
  return api<SendResponse & { code?: string }>(
    ctx.baseUrl,
    'POST',
    `/v1/conversations/${conversationId}/messages`,
    {
      token,
      body: { content: [{ type: 'text', text }] },
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {},
    },
  );
}

async function waitForStatus(token: string, taskId: string, statuses: string[]) {
  return waitFor(async () => {
    const res = await api<TaskSummary>(ctx.baseUrl, 'GET', `/v1/tasks/${taskId}`, { token });
    return statuses.includes(res.body.status) ? res.body : null;
  });
}

describe('POST /v1/widget/bootstrap', () => {
  it('허용 도메인 + 올바른 identity token 이면 세션과 위젯 초기 데이터를 준다', async () => {
    const res = await api<BootstrapBody>(ctx.baseUrl, 'POST', '/v1/widget/bootstrap', {
      origin: ctx.widgets.A.origin,
      body: {
        publicKey: ctx.widgets.A.publicKey,
        identityToken: await identityToken(ctx.widgets.A, 'user-boot'),
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.sessionToken).toEqual(expect.any(String));
    expect(res.body.endUser.anonymous).toBe(false);
    expect(res.body.agent).toMatchObject({
      id: ctx.tenantA.agentId,
      welcomeMessage: expect.any(String),
    });
    expect(res.body.theme.position).toBe('bottom-right');
    expect(res.body.activeTasks).toEqual([]);
  });

  it('같은 사용자는 같은 EndUser 로 이어진다', async () => {
    const boot = async () =>
      (
        await api<{ endUser: { id: string } }>(ctx.baseUrl, 'POST', '/v1/widget/bootstrap', {
          origin: ctx.widgets.A.origin,
          body: {
            publicKey: ctx.widgets.A.publicKey,
            identityToken: await identityToken(ctx.widgets.A, 'user-same'),
          },
        })
      ).body.endUser.id;
    expect(await boot()).toBe(await boot());
  });

  it('허용되지 않은 Origin 은 403 ORIGIN_NOT_ALLOWED', async () => {
    const res = await api(ctx.baseUrl, 'POST', '/v1/widget/bootstrap', {
      origin: 'https://evil.example.net',
      body: {
        publicKey: ctx.widgets.A.publicKey,
        identityToken: await identityToken(ctx.widgets.A, 'u'),
      },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(res.body).toMatchObject({ code: 'ORIGIN_NOT_ALLOWED', traceId: expect.any(String) });
  });

  it('다른 위젯 Secret 으로 서명한 토큰은 401 IDENTITY_TOKEN_INVALID', async () => {
    const res = await api(ctx.baseUrl, 'POST', '/v1/widget/bootstrap', {
      origin: ctx.widgets.A.origin,
      body: {
        publicKey: ctx.widgets.A.publicKey,
        identityToken: await identityToken(ctx.widgets.A, 'u', { secret: ctx.widgets.B.secret }),
      },
    });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'IDENTITY_TOKEN_INVALID' });
  });

  it('identity token 이 없으면 401 IDENTITY_TOKEN_REQUIRED', async () => {
    const res = await api(ctx.baseUrl, 'POST', '/v1/widget/bootstrap', {
      origin: ctx.widgets.A.origin,
      body: { publicKey: ctx.widgets.A.publicKey },
    });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'IDENTITY_TOKEN_REQUIRED' });
  });

  it('없는 공개 키는 403 WIDGET_DISABLED, 형식 오류는 400 VALIDATION_FAILED', async () => {
    const unknown = await api(ctx.baseUrl, 'POST', '/v1/widget/bootstrap', {
      origin: ctx.widgets.A.origin,
      body: { publicKey: 'wk_pub_unknown' },
    });
    expect(unknown.status).toBe(403);
    expect(unknown.body).toMatchObject({ code: 'WIDGET_DISABLED' });

    const invalid = await api(ctx.baseUrl, 'POST', '/v1/widget/bootstrap', {
      origin: ctx.widgets.A.origin,
      body: { publicKey: 'nope' },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [expect.objectContaining({ path: 'publicKey' })],
    });
  });
});

describe('Widget API 인증', () => {
  it('세션 토큰이 없으면 401', async () => {
    const res = await api(ctx.baseUrl, 'GET', '/v1/tasks');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('bootstrap 때와 다른 Origin 에서 온 요청은 403', async () => {
    const token = await startSession(ctx.baseUrl, ctx.widgets.A, 'user-origin');
    const res = await api(ctx.baseUrl, 'GET', '/v1/tasks', {
      token,
      origin: 'https://evil.example.net',
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'ORIGIN_NOT_ALLOWED' });
  });
});

describe('메시지 → 작업 → SSE', () => {
  let token: string;
  let taskId: string;
  let events: SseEvent[];

  beforeAll(async () => {
    token = await startSession(ctx.baseUrl, ctx.widgets.A, 'user-flow');
    const conversationId = await newConversation(token);
    const res = await send(token, conversationId, '3월 매출 리포트 만들어줘');
    expect(res.status).toBe(202);
    expect(res.body.task.status).toBe('queued');
    expect(res.body.message.taskId).toBe(res.body.task.id);
    taskId = res.body.task.id;
    events = await readSse(`${ctx.baseUrl}${res.body.eventsUrl}`, token);
  });

  it('Agent Loop 순서대로 이벤트가 오고 task.completed 로 끝난다', () => {
    const types = events.map((e) => e.event);
    expect(types[0]).toBe('task.status');
    expect(events[0]!.data).toEqual({ status: 'queued' });
    expect(types).toContain('plan.created');
    expect(types.indexOf('plan.created')).toBeLessThan(types.indexOf('message.completed'));
    expect(types.at(-1)).toBe('task.completed');
    expect(types.filter((t) => t === 'step.started').length).toBe(
      types.filter((t) => t === 'step.completed').length,
    );
  });

  it('저장된 이벤트 id 는 단조 증가하고, delta 는 id 가 없다', () => {
    const ids = events.filter((e) => e.id !== null).map((e) => BigInt(e.id!));
    expect(ids.length).toBeGreaterThan(5);
    ids.slice(1).forEach((id, i) => expect(id > ids[i]!).toBe(true));
    expect(events.filter((e) => e.event === 'message.delta').every((e) => e.id === null)).toBe(
      true,
    );
  });

  it('delta 를 이어 붙이면 최종 메시지와 같다', () => {
    const streamed = events
      .filter((e) => e.event === 'message.delta')
      .map((e) => (e.data as { text: string }).text)
      .join('');
    const completed = events.find((e) => e.event === 'message.completed')!.data as {
      message: { content: Array<{ text: string }> };
    };
    expect(streamed.length).toBeGreaterThan(0);
    expect(completed.message.content[0]!.text).toBe(streamed);
  });

  it('GET /v1/tasks/:id 는 완료 상태 · 계획 · 결과를 준다', async () => {
    const res = await api<TaskDetailBody>(ctx.baseUrl, 'GET', `/v1/tasks/${taskId}`, { token });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'completed',
      progress: { completed: 1, total: 1 },
      plan: { version: 1, steps: [expect.objectContaining({ index: 1, status: 'succeeded' })] },
      result: {
        verification: [
          { label: '요청에 답함', passed: true },
          { label: '사용자 언어로 작성', passed: true },
        ],
      },
    });
    const completed = events.find((e) => e.event === 'message.completed')!.data as {
      message: { id: string };
    };
    expect(res.body.result?.messageId).toBe(completed.message.id);
    expect(res.body.lastEventId).toBe(events.filter((e) => e.id).at(-1)!.id);
  });

  it('단계와 checkpoint 가 DB 에 저장된다', async () => {
    const steps = await ctx.owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${ctx.tenantA.tenantId}, true)`;
      return tx.taskStep.findMany({ where: { taskId }, orderBy: { seq: 'asc' } });
    });
    expect(steps.map((s) => s.type)).toEqual(['context', 'plan', 'respond', 'evaluate']);
    expect(steps.every((s) => s.status === 'succeeded')).toBe(true);
    const respond = steps.find((s) => s.type === 'respond')!;
    expect(respond.checkpoint).toMatchObject({ planVersion: 1, nextPlanIndex: 2 });

    const task = await ctx.owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${ctx.tenantA.tenantId}, true)`;
      return tx.task.findUniqueOrThrow({ where: { id: taskId } });
    });
    expect(task.lastCheckpointStepId).toBe(respond.id);
  });

  it('Last-Event-ID 로 다시 연결하면 그 이후 저장 이벤트만 중복 없이 받는다', async () => {
    const planCreated = events.find((e) => e.event === 'plan.created')!;
    const replay = await readSse(`${ctx.baseUrl}/v1/tasks/${taskId}/events`, token, {
      lastEventId: planCreated.id!,
    });
    const expected = events.filter((e) => e.id !== null && BigInt(e.id) > BigInt(planCreated.id!));
    expect(replay.map((e) => e.id)).toEqual(expected.map((e) => e.id));
    expect(replay.at(-1)!.event).toBe('task.completed');
  });

  it('완료 작업은 completed 그룹에 있다', async () => {
    const res = await api<{ items: TaskSummary[] }>(
      ctx.baseUrl,
      'GET',
      '/v1/tasks?group=completed',
      { token },
    );
    expect(res.body.items.map((t) => t.id)).toContain(taskId);
  });
});

describe('대화당 진행 작업은 하나', () => {
  it('진행 중이면 409 TASK_ALREADY_ACTIVE, 끝나면 다시 보낼 수 있다', async () => {
    const token = await startSession(ctx.baseUrl, ctx.widgets.A, 'user-active');
    const conversationId = await newConversation(token);
    const first = await send(token, conversationId, '첫 번째 요청');
    expect(first.status).toBe(202);

    const second = await send(token, conversationId, '두 번째 요청');
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('TASK_ALREADY_ACTIVE');

    await waitForStatus(token, first.body.task.id, ['completed']);
    const third = await send(token, conversationId, '세 번째 요청');
    expect(third.status).toBe(202);
    await waitForStatus(token, third.body.task.id, ['completed']);
  });

  it('동시에 보내도 하나만 작업이 된다 (DB 부분 유니크 인덱스)', async () => {
    const token = await startSession(ctx.baseUrl, ctx.widgets.A, 'user-race');
    const conversationId = await newConversation(token);
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => send(token, conversationId, `동시 요청 ${i}`)),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 202)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(4);
    const accepted = results.find((r) => r.status === 202)!;
    await waitForStatus(token, accepted.body.task.id, ['completed']);
  });
});

describe('Idempotency-Key', () => {
  it('같은 키 + 같은 본문이면 같은 작업을, 다른 본문이면 409 를 준다', async () => {
    const token = await startSession(ctx.baseUrl, ctx.widgets.A, 'user-idem');
    const conversationId = await newConversation(token);
    const first = await send(token, conversationId, '멱등 요청', 'idem-key-0001');
    const again = await send(token, conversationId, '멱등 요청', 'idem-key-0001');
    expect(first.status).toBe(202);
    expect(again.status).toBe(202);
    expect(again.body.task.id).toBe(first.body.task.id);

    const different = await send(token, conversationId, '다른 본문', 'idem-key-0001');
    expect(different.status).toBe(409);
    expect(different.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    await waitForStatus(token, first.body.task.id, ['completed']);
  });

  it('같은 키로 동시에 재시도해도 작업은 하나다', async () => {
    const token = await startSession(ctx.baseUrl, ctx.widgets.A, 'user-idem-race');
    const conversationId = await newConversation(token);
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        send(token, conversationId, '네트워크 재시도', 'idem-key-race-01'),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([202, 202, 202, 202]);
    expect(new Set(results.map((r) => r.body.task.id)).size).toBe(1);
    await waitForStatus(token, results[0]!.body.task.id, ['completed']);
  });
});

describe('SSE 연결 관리', () => {
  it('클라이언트가 끊으면 서버도 구독을 정리한다', async () => {
    const token = await startSession(ctx.baseUrl, ctx.widgets.A, 'user-disconnect');
    const conversationId = await newConversation(token);
    const sent = await send(token, conversationId, '연결을 끊어 볼게요');
    const channel = `task:${sent.body.task.id}`;
    const redis = ctx.app.get(RedisService);

    const controller = new AbortController();
    const res = await fetch(`${ctx.baseUrl}${sent.body.eventsUrl}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    await waitFor(async () => redis.listenerCount(channel) > 0);

    controller.abort();
    await waitFor(async () => redis.listenerCount(channel) === 0);
    await waitForStatus(token, sent.body.task.id, ['completed']);
  });
});

describe('중지', () => {
  it('실행 직후 중지하면 cancelled 로 끝나고 SSE 도 닫힌다', async () => {
    const token = await startSession(ctx.baseUrl, ctx.widgets.A, 'user-cancel');
    const conversationId = await newConversation(token);
    const sent = await send(token, conversationId, '오래 걸리는 요청을 처리해 줘');
    const cancel = await api<TaskSummary>(
      ctx.baseUrl,
      'POST',
      `/v1/tasks/${sent.body.task.id}/cancel`,
      { token },
    );
    expect(cancel.status).toBe(202);

    const events = await readSse(`${ctx.baseUrl}${sent.body.eventsUrl}`, token);
    expect(events.at(-1)).toMatchObject({ event: 'task.status', data: { status: 'cancelled' } });
    expect(events.some((e) => e.event === 'task.completed')).toBe(false);

    const task = await waitForStatus(token, sent.body.task.id, ['cancelled']);
    expect(task.status).toBe('cancelled');

    const again = await api(ctx.baseUrl, 'POST', `/v1/tasks/${sent.body.task.id}/cancel`, {
      token,
    });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'TASK_NOT_ACTIVE' });
  });
});

describe('테넌트 격리', () => {
  it('다른 테넌트의 대화 · 작업 · 이벤트에 접근할 수 없다 (404)', async () => {
    const tokenA = await startSession(ctx.baseUrl, ctx.widgets.A, 'user-iso');
    const conversationId = await newConversation(tokenA);
    const sent = await send(tokenA, conversationId, '테넌트 A 요청');
    await waitForStatus(tokenA, sent.body.task.id, ['completed']);

    const tokenB = await startSession(ctx.baseUrl, ctx.widgets.B, 'user-iso');
    expect(
      (await api(ctx.baseUrl, 'GET', `/v1/tasks/${sent.body.task.id}`, { token: tokenB })).status,
    ).toBe(404);
    expect(
      (await api(ctx.baseUrl, 'GET', `/v1/tasks/${sent.body.task.id}/events`, { token: tokenB }))
        .status,
    ).toBe(404);
    expect((await send(tokenB, conversationId, '남의 대화에 쓰기')).status).toBe(404);
    expect(
      (await api(ctx.baseUrl, 'POST', `/v1/tasks/${sent.body.task.id}/cancel`, { token: tokenB }))
        .status,
    ).toBe(404);

    const listB = await api<{ items: TaskSummary[] }>(
      ctx.baseUrl,
      'GET',
      '/v1/tasks?group=completed',
      { token: tokenB },
    );
    expect(listB.body.items).toEqual([]);
  });

  it('같은 테넌트라도 다른 사용자의 작업은 볼 수 없다', async () => {
    const owner = await startSession(ctx.baseUrl, ctx.widgets.A, 'user-owner');
    const other = await startSession(ctx.baseUrl, ctx.widgets.A, 'user-other');
    const conversationId = await newConversation(owner);
    const sent = await send(owner, conversationId, '내 작업');
    expect(
      (await api(ctx.baseUrl, 'GET', `/v1/tasks/${sent.body.task.id}`, { token: other })).status,
    ).toBe(404);
    expect(
      (
        await api(ctx.baseUrl, 'GET', `/v1/conversations/${conversationId}/messages`, {
          token: other,
        })
      ).status,
    ).toBe(404);
    await waitForStatus(owner, sent.body.task.id, ['completed']);
  });
});

describe('GET /health', () => {
  it('DB · Redis 상태를 알려 준다', async () => {
    const res = await api(ctx.baseUrl, 'GET', '/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'ok', redis: 'ok' });
  });
});
