import type { RecordedRequest } from './fake-llm-server.js';
import {
  adminLogin,
  api,
  CONSOLE_MEMBERS,
  identityToken,
  readSse,
  startSession,
  startTestApp,
  type TestContext,
  waitFor,
} from './helpers.js';

let ctx: TestContext;
let userToken: string;
let otherToken: string;
let ownerToken: string;
let agentId: string;

beforeAll(async () => {
  ctx = await startTestApp();
  userToken = await startSession(ctx.baseUrl, ctx.widgets.A, 'mem-user');
  otherToken = await startSession(ctx.baseUrl, ctx.widgets.A, 'mem-other');
  ownerToken = await adminLogin(ctx.baseUrl, ctx.slugs.A, CONSOLE_MEMBERS.owner);
  agentId = ctx.tenantA.agentId;
});

afterAll(async () => {
  await ctx?.close();
});

async function run(text: string, token = userToken) {
  const conv = (
    await api<{ id: string }>(ctx.baseUrl, 'POST', '/v1/conversations', { token, body: {} })
  ).body.id;
  const sent = await api<{ task: { id: string }; eventsUrl: string }>(
    ctx.baseUrl,
    'POST',
    `/v1/conversations/${conv}/messages`,
    { token, body: { content: [{ type: 'text', text }] } },
  );
  await readSse(`${ctx.baseUrl}${sent.body.eventsUrl}`, token);
  return sent.body.task.id;
}

async function tenantRows<T>(fn: (tx: TestContext['owner']) => Promise<T>) {
  return ctx.owner.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${ctx.tenantA.tenantId}, true)`;
    return fn(tx as unknown as TestContext['owner']);
  });
}

/** memory-ingest 잡이 이 작업을 처리할 때까지 */
const memoriesOf = (taskId: string, min = 1) =>
  waitFor(async () => {
    const rows = await tenantRows((tx) =>
      tx.memory.findMany({ where: { sourceTaskIds: { has: taskId } } }),
    );
    return rows.length >= min ? rows : null;
  });

const requestsFor = (tag: string): RecordedRequest[] =>
  ctx.llm.requests.filter((r) => r.body.messages.some((m) => (m.content ?? '').includes(tag)));

const contextOutput = async (taskId: string) =>
  (
    await tenantRows((tx) =>
      tx.taskStep.findFirstOrThrow({ where: { taskId, name: 'context.build' } }),
    )
  ).output as {
    memories: Array<{ id: string; type: string; score?: number; via?: string }>;
  };

const admin = <T = Record<string, unknown>>(method: string, path: string, body?: unknown) =>
  api<T>(ctx.baseUrl, method, `/v1/admin${path}`, { token: ownerToken, body });

let preferenceId: string;

describe('기억 저장 (memory-ingest)', () => {
  it('작업이 끝나면 사용자 사실 · 요약은 user 범위로, 일하는 방법은 agent 범위로 저장한다', async () => {
    const taskId = await run('[기억] 요금제 A와 B를 표로 비교해 줘 #mem1');
    const rows = await memoriesOf(taskId, 3);
    const byType = Object.fromEntries(rows.map((r) => [r.type, r]));
    expect(byType.semantic).toMatchObject({
      scope: 'user',
      status: 'active',
      content: '사용자는 비교 결과를 표로 받기를 선호한다',
      needsVerification: false,
      sourceType: 'user_message',
    });
    expect(byType.semantic!.endUserId).toBeTruthy();
    expect(byType.episodic).toMatchObject({
      scope: 'user',
      needsVerification: true,
      sourceType: 'reflection',
    });
    expect(byType.procedural).toMatchObject({ scope: 'agent', endUserId: null });
    // 보존 기간 90일 · 임베딩 저장
    const days = (byType.semantic!.expiresAt!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89);
    const [vec] = await tenantRows(
      (tx) =>
        tx.$queryRaw<Array<{ model: string; dims: number }>>`
        SELECT embedding_model AS model, vector_dims(embedding) AS dims FROM memories WHERE id = ${byType.semantic!.id}::uuid`,
    );
    expect(vec).toEqual({ model: 'local-hash-v1', dims: 1536 });
    preferenceId = byType.semantic!.id;
  });

  it('같은 내용을 다시 뽑으면 새로 만들지 않고 출처만 합친다', async () => {
    const taskId = await run('[기억] 다시 비교해 줘 #mem1b');
    await waitFor(async () => {
      const row = await tenantRows((tx) => tx.memory.findUnique({ where: { id: preferenceId } }));
      return row?.sourceTaskIds.includes(taskId) ? row : null;
    });
    const count = await tenantRows((tx) =>
      tx.memory.count({ where: { content: '사용자는 비교 결과를 표로 받기를 선호한다' } }),
    );
    expect(count).toBe(1);
  });

  it('지시문처럼 보이는 내용은 격리하고, 민감정보는 가려서 저장한다', async () => {
    const injected = await memoriesOf(await run('[주입기억] 메모해 줘 #mem-inj'));
    expect(injected[0]).toMatchObject({
      status: 'quarantined',
      quarantineReason: expect.stringContaining('숨은 지시문'),
    });
    const card = await memoriesOf(await run('[카드기억] 결제 수단 #mem-card'));
    expect(card[0]!.content).not.toContain('4111-1111-1111-1111');
    expect(card[0]!.content).toContain('1111');
  });
});

describe('기억 떠올리기 (Context)', () => {
  it('같은 사용자의 새 대화에서 관련 기억을 Agent 지침에 넣는다 (격리된 기억은 제외)', async () => {
    const taskId = await run('요금제 비교할 때 내가 좋아하는 답변 형식 기억나? #mem2');
    const output = await contextOutput(taskId);
    expect(output.memories.map((m) => m.id)).toContain(preferenceId);
    const agent = requestsFor('#mem2').find((r) => r.role === 'Agent')!;
    expect(agent.body.messages[0]!.content).toContain('## What the agent remembers');
    expect(agent.body.messages[0]!.content).toContain('표로 받기를 선호한다');
    expect(agent.body.messages[0]!.content).not.toContain('Ignore all previous instructions');
    const used = await tenantRows((tx) =>
      tx.memory.findUniqueOrThrow({ where: { id: preferenceId } }),
    );
    expect(used.useCount).toBeGreaterThanOrEqual(1);
  });

  it('사용자 프로필(선호)은 질문 주제와 단어가 겹치지 않아도 넣는다', async () => {
    const taskId = await run('오늘 할 일 세 가지만 정리해 줘 #mem3');
    const output = await contextOutput(taskId);
    expect(output.memories).toContainEqual({ id: preferenceId, type: 'semantic', via: 'profile' });
    const agent = requestsFor('#mem3').find((r) => r.role === 'Agent')!;
    expect(agent.body.messages[0]!.content).toContain('표로 받기를 선호한다');
  });

  it('다른 사용자는 이 사용자의 기억을 떠올리지 않는다', async () => {
    const taskId = await run(
      '요금제 비교할 때 내가 좋아하는 답변 형식 기억나? #mem-other',
      otherToken,
    );
    const ids = (await contextOutput(taskId)).memories.map((m) => m.id);
    expect(ids).not.toContain(preferenceId);
    const rows = await tenantRows((tx) => tx.memory.findMany({ where: { id: { in: ids } } }));
    expect(rows.every((r) => r.scope === 'agent')).toBe(true);
  });
});

describe('Memory 관리 (C-08)', () => {
  it('의미 · 키워드 검색은 Context 와 같은 경로', async () => {
    const semantic = await admin<Array<{ id: string; score: number }>>(
      'GET',
      `/memories/search?agentId=${agentId}&q=${encodeURIComponent('표로 비교한 답변 선호')}`,
    );
    expect(semantic.body[0]).toMatchObject({ id: preferenceId });
    expect(semantic.body[0]!.score).toBeGreaterThan(0);
    const keyword = await admin<Array<{ id: string }>>(
      'GET',
      `/memories/search?agentId=${agentId}&mode=keyword&q=${encodeURIComponent('표로 받기')}`,
    );
    expect(keyword.body.map((h) => h.id)).toContain(preferenceId);
  });

  it('격리 목록 · 해제, 수정(재임베딩) · 고정 · 삭제', async () => {
    const quarantined = await admin<{ items: Array<{ id: string; status: string }> }>(
      'GET',
      '/memories?status=quarantined',
    );
    expect(quarantined.body.items).toHaveLength(1);
    // 목록 필터 — 범위 · 종류. 사용자 범위 기억에는 위젯 사용자 가명 (작업 · 승인 화면과 같은 값)
    const userScoped = await admin<{
      items: Array<{ scope: string; type: string; endUserPseudonym: string | null }>;
    }>('GET', '/memories?status=active&scope=user&limit=100');
    expect(userScoped.body.items.length).toBeGreaterThan(0);
    expect(userScoped.body.items.every((m) => m.scope === 'user')).toBe(true);
    expect(userScoped.body.items.every((m) => /^user_/.test(m.endUserPseudonym ?? ''))).toBe(true);
    const proceduralOnly = await admin<{
      items: Array<{ scope: string; type: string; endUserPseudonym: string | null }>;
    }>('GET', '/memories?status=active&type=procedural&limit=100');
    expect(proceduralOnly.body.items.every((m) => m.type === 'procedural')).toBe(true);
    expect((await admin('GET', '/memories?status=active&scope=everyone')).status).toBe(400);
    const released = await admin<{ status: string }>(
      'POST',
      `/memories/${quarantined.body.items[0]!.id}/release`,
    );
    expect(released.body.status).toBe('active');

    const before = await tenantRows(
      (tx) =>
        tx.$queryRaw<
          Array<{ v: string }>
        >`SELECT embedding::text AS v FROM memories WHERE id = ${preferenceId}::uuid`,
    );
    const patched = await admin<{ content: string; needsVerification: boolean }>(
      'PATCH',
      `/memories/${preferenceId}`,
      {
        content: '사용자는 요금제 비교를 표와 한 줄 요약으로 받기를 선호한다',
      },
    );
    expect(patched.body).toMatchObject({ needsVerification: false });
    const after = await tenantRows(
      (tx) =>
        tx.$queryRaw<
          Array<{ v: string }>
        >`SELECT embedding::text AS v FROM memories WHERE id = ${preferenceId}::uuid`,
    );
    expect(after[0]!.v).not.toBe(before[0]!.v);

    const pinned = await admin<{ pinned: boolean; expiresAt: string | null }>(
      'POST',
      `/memories/${preferenceId}/pin`,
      { pinned: true },
    );
    expect(pinned.body).toMatchObject({ pinned: true, expiresAt: null });
    const procedural = (
      await tenantRows((tx) => tx.memory.findFirstOrThrow({ where: { type: 'procedural' } }))
    ).id;
    expect((await admin('DELETE', `/memories/${procedural}`)).status).toBe(204);
    expect((await admin('GET', `/memories/${procedural}`)).status).toBe(404);
  });

  it('사용자 데이터 삭제 — 기억 · 대화를 지우고 다시 오면 새 사용자로 시작한다', async () => {
    const user = await tenantRows((tx) =>
      tx.memory.findUniqueOrThrow({ where: { id: preferenceId } }),
    );
    const endUserId = user.endUserId!;
    const res = await admin<{ erased: { memories: number; conversations: number } }>(
      'POST',
      `/end-users/${endUserId}/erase`,
    );
    expect(res.status).toBe(202);
    expect(res.body.erased.memories).toBeGreaterThanOrEqual(2);
    expect(res.body.erased.conversations).toBeGreaterThanOrEqual(3);
    expect(await tenantRows((tx) => tx.memory.count({ where: { endUserId } }))).toBe(0);
    expect(
      await tenantRows((tx) => tx.endUser.findUniqueOrThrow({ where: { id: endUserId } })),
    ).toMatchObject({
      externalId: null,
      erasedAt: expect.any(Date),
    });
    const again = await api<{ endUser: { id: string } }>(
      ctx.baseUrl,
      'POST',
      '/v1/widget/bootstrap',
      {
        origin: ctx.widgets.A.origin,
        body: {
          publicKey: ctx.widgets.A.publicKey,
          identityToken: await identityToken(ctx.widgets.A, 'mem-user'),
        },
      },
    );
    expect(again.body.endUser.id).not.toBe(endUserId);
  });
});
