import { MetricsRollupService } from '../src/workers/metrics-rollup.service.js';
import {
  adminLogin,
  api,
  CONSOLE_MEMBERS,
  readSse,
  startSession,
  startTestApp,
  type TestContext,
  waitFor,
} from './helpers.js';

let ctx: TestContext;
let token: string;
let otherToken: string;
let ownerToken: string;
let adminToken: string;
let viewerToken: string;

beforeAll(async () => {
  ctx = await startTestApp();
  token = await startSession(ctx.baseUrl, ctx.widgets.A, 'billing-user');
  otherToken = await startSession(ctx.baseUrl, ctx.widgets.A, 'billing-other');
  ownerToken = await adminLogin(ctx.baseUrl, ctx.slugs.A, CONSOLE_MEMBERS.owner);
  adminToken = await adminLogin(ctx.baseUrl, ctx.slugs.A, CONSOLE_MEMBERS.admin);
  viewerToken = await adminLogin(ctx.baseUrl, ctx.slugs.A, CONSOLE_MEMBERS.viewer);
});

afterAll(async () => {
  await ctx?.close();
});

const admin = <T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
  tkn = ownerToken,
) => api<T>(ctx.baseUrl, method, `/v1/admin${path}`, { token: tkn, body });

async function tenantRows<T>(fn: (tx: TestContext['owner']) => Promise<T>) {
  return ctx.owner.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${ctx.tenantA.tenantId}, true)`;
    return fn(tx as unknown as TestContext['owner']);
  });
}

async function send(text: string, tkn = token) {
  const conv = (
    await api<{ id: string }>(ctx.baseUrl, 'POST', '/v1/conversations', { token: tkn, body: {} })
  ).body.id;
  const sent = await api<{ task: { id: string }; eventsUrl: string; code?: string }>(
    ctx.baseUrl,
    'POST',
    `/v1/conversations/${conv}/messages`,
    { token: tkn, body: { content: [{ type: 'text', text }] } },
  );
  if (sent.status !== 202) return { status: sent.status, code: sent.body.code, taskId: null };
  const events = await readSse(`${ctx.baseUrl}${sent.body.eventsUrl}`, tkn);
  return { status: sent.status, events, taskId: sent.body.task.id };
}

let billedTaskId: string;
let failedTaskId: string;

describe('사용량 · 비용', () => {
  it('모델 단가 — Admin 이 전체 교체, Viewer 는 조회만, 중복은 거부', async () => {
    const prices = [
      { providerKind: 'deepseek', model: 'fake-planner', inputPerMtok: 1, outputPerMtok: 2 },
      { providerKind: 'deepseek', model: 'fake-executor', inputPerMtok: 2, outputPerMtok: 4 },
    ];
    expect((await admin('PUT', '/billing/model-prices', { prices }, viewerToken)).status).toBe(403);
    expect(
      (await admin('PUT', '/billing/model-prices', { prices: [prices[0], prices[0]] }, adminToken))
        .status,
    ).toBe(400);
    const res = await admin<Array<{ model: string; currency: string; cachedInputPerMtok: null }>>(
      'PUT',
      '/billing/model-prices',
      { prices },
      adminToken,
    );
    expect(res.status).toBe(200);
    expect(res.body.map((p) => p.model)).toEqual(['fake-executor', 'fake-planner']);
    expect(res.body[0]).toMatchObject({ currency: 'USD', cachedInputPerMtok: null });
    const listed = await admin<unknown[]>('GET', '/billing/model-prices', undefined, viewerToken);
    expect(listed.body).toHaveLength(2);
  });

  it('작업이 끝나면 모델별 사용량을 기록하고 단가로 계산한 비용을 작업에 더한다', async () => {
    const run = await send('[분석] 요금 비교 #bill');
    expect(run.events!.at(-1)!.event).toBe('task.completed');
    billedTaskId = run.taskId!;
    // 가짜 LLM 은 호출마다 입력 100 · 출력 20 토큰 — Agent 차례 3번 (호출당 0.00028 USD)
    const records = await tenantRows((tx) =>
      tx.usageRecord.findMany({ where: { taskId: billedTaskId, purpose: 'task' } }),
    );
    expect(
      records.map((r) => ({
        role: r.role,
        model: r.model,
        calls: r.calls,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cost: Number(r.costAmount),
        priced: r.priced,
      })),
    ).toEqual([
      {
        role: 'executor',
        model: 'fake-executor',
        calls: 3,
        inputTokens: 300,
        outputTokens: 60,
        cost: 0.00084,
        priced: true,
      },
    ]);

    // 작업 뒤 기억 추출도 같은 모델로, 그 작업의 사용량 · 비용으로
    const memory = await waitFor(() =>
      tenantRows((tx) =>
        tx.usageRecord.findFirst({ where: { taskId: billedTaskId, purpose: 'memory' } }),
      ),
    );
    expect(memory).toMatchObject({
      role: 'executor',
      model: 'fake-executor',
      calls: 1,
      priced: true,
    });
    const task = await tenantRows((tx) =>
      tx.task.findUniqueOrThrow({ where: { id: billedTaskId } }),
    );
    expect(Number(task.costAmount)).toBeCloseTo(0.00112, 8);
    expect(task.costCurrency).toBe('USD');
  });

  it('사용량 보고 — 합계 · 일별 · 모델별 · 용도별, 단가 없는 호출 수', async () => {
    const res = await admin<{
      currency: string;
      totals: { calls: number; cost: number; unpricedCalls: number; inputTokens: number };
      byDay: Array<{ date: string; calls: number }>;
      byModel: Array<{ model: string; priced: boolean; cost: number; calls: number }>;
      byPurpose: Array<{ purpose: string; calls: number }>;
      budget: { monthlyBudget: number | null; monthToDate: number };
    }>('GET', '/billing/usage?range=7d', undefined, viewerToken);
    expect(res.status).toBe(200);
    expect(res.body.totals).toMatchObject({ calls: 4, inputTokens: 400, unpricedCalls: 0 });
    expect(res.body.totals.cost).toBeCloseTo(0.00112, 8);
    expect(res.body.byDay).toHaveLength(1);
    expect(res.body.byModel).toEqual([
      expect.objectContaining({ model: 'fake-executor', priced: true, calls: 4 }),
    ]);
    expect(res.body.byPurpose).toEqual([
      expect.objectContaining({ purpose: 'memory', calls: 1 }),
      expect.objectContaining({ purpose: 'task', calls: 3 }),
    ]);
    expect(res.body.budget).toMatchObject({ monthlyBudget: null });
    expect(res.body.budget.monthToDate).toBeCloseTo(0.00112, 8);
  });

  it('월 한도 — Owner 만 설정, 넘으면 새 작업을 받지 않고(402), 풀면 다시 받는다 · 감사 로그', async () => {
    expect(
      (await admin('PUT', '/billing/budget', { monthlyBudget: 0.0001 }, adminToken)).status,
    ).toBe(403);
    const set = await admin<{ monthlyBudget: number; remaining: number }>(
      'PUT',
      '/billing/budget',
      { monthlyBudget: 0.0001 },
    );
    expect(set.body).toMatchObject({ monthlyBudget: 0.0001, remaining: 0 });
    const blocked = await send('[분석] 한도 초과 #over');
    expect(blocked).toMatchObject({ status: 402, code: 'BUDGET_EXCEEDED' });

    await admin('PUT', '/billing/budget', { monthlyBudget: null });
    const again = await send('[분석] 다시 #budget-ok');
    expect(again.status).toBe(202);
    expect(
      await tenantRows((tx) => tx.auditLog.count({ where: { action: 'billing.budget.update' } })),
    ).toBe(2);
  });
});

describe('피드백 (W-04)', () => {
  it('끝난 작업에 도움됨 · 개선 필요 — 다시 보내면 바꾸고, 다른 사용자는 못 한다', async () => {
    const first = await api<{ rating: string }>(
      ctx.baseUrl,
      'POST',
      `/v1/tasks/${billedTaskId}/feedback`,
      { token, body: { rating: 'helpful' } },
    );
    expect(first.status).toBe(200);
    const changed = await api<{ rating: string; comment: string }>(
      ctx.baseUrl,
      'POST',
      `/v1/tasks/${billedTaskId}/feedback`,
      { token, body: { rating: 'not_helpful', comment: '표로 보여 주면 좋겠어요' } },
    );
    expect(changed.body).toMatchObject({
      rating: 'not_helpful',
      comment: '표로 보여 주면 좋겠어요',
    });
    expect(await tenantRows((tx) => tx.feedback.count({ where: { taskId: billedTaskId } }))).toBe(
      1,
    );
    expect(
      (
        await api(ctx.baseUrl, 'POST', `/v1/tasks/${billedTaskId}/feedback`, {
          token: otherToken,
          body: { rating: 'helpful' },
        })
      ).status,
    ).toBe(404);
  });
});

describe('대시보드 지표 (C-01 · metrics-rollup)', () => {
  it('일별 집계 → 기간 KPI · 직전 기간 비교 · 최근 실패', async () => {
    const failed = await send('[모델오류] 답변 실패 #metric-fail');
    expect(failed.events!.at(-1)!.event).toBe('task.failed');
    failedTaskId = failed.taskId!;

    expect(await ctx.app.get(MetricsRollupService).tick()).toBeGreaterThan(0);
    const res = await admin<{
      period: { from: string; to: string };
      lastAggregatedAt: string;
      kpis: Record<
        string,
        { value: number; previous: number; status: string; target?: number; currency?: string }
      >;
      feedback: { helpful: number; notHelpful: number };
      daily: Array<{ date: string; tasksTotal: number; cost: number }>;
      recentFailures: Array<{
        taskId: string;
        failedStep: string;
        cause: string;
        code: string;
        recovery: string;
      }>;
    }>('GET', '/metrics?range=24h', undefined, viewerToken);
    expect(res.status).toBe(200);
    expect(res.body.period.from).toBe(res.body.period.to);
    expect(res.body.lastAggregatedAt).toEqual(expect.any(String));
    // 날짜별 추이 — 기간의 모든 날짜 (빈 날은 0)
    expect(res.body.daily).toEqual([
      expect.objectContaining({
        date: res.body.period.to,
        tasksTotal: 3,
        tasksSucceeded: 2,
        tasksFailed: 1,
        toolDenied: 0,
      }),
    ]);
    expect(res.body.daily[0]!.cost).toBeGreaterThan(0);
    // 작업 3개(완료 2 · 실패 1) — #bill, #budget-ok, #metric-fail
    expect(res.body.kpis.tasksTotal).toMatchObject({ value: 3, previous: 0 });
    expect(res.body.kpis.taskSuccessRate).toMatchObject({
      value: 0.6667,
      target: 0.9,
      status: 'warn',
    });
    expect(res.body.kpis.unauthorizedToolCalls).toMatchObject({
      value: 0,
      target: 0,
      status: 'ok',
    });
    expect(res.body.kpis.avgCostPerTask!.currency).toBe('USD');
    expect(res.body.kpis.avgCostPerTask!.value).toBeGreaterThan(0);
    expect(res.body.kpis.avgDurationMs!.value).toBeGreaterThan(0);
    expect(res.body.kpis.evalSuccessRate).toBeNull();
    expect(res.body.feedback).toEqual({ helpful: 0, notHelpful: 1 });
    expect(res.body.recentFailures).toEqual([
      expect.objectContaining({
        taskId: failedTaskId,
        failedStep: 'agent.turn',
        cause: 'model_error',
        code: 'MODEL_ERROR',
      }),
    ]);

    // Agent 필터 · 다른 Agent 는 비어 있다
    const other = await admin<{ kpis: { tasksTotal: { value: number } } }>(
      'GET',
      `/metrics?range=7d&agentId=${ctx.tenantB.agentId}`,
    );
    expect(other.body.kpis.tasksTotal.value).toBe(0);
    const mine = await admin<{ kpis: { tasksTotal: { value: number } }; daily: unknown[] }>(
      'GET',
      `/metrics?range=30d&agentId=${ctx.tenantA.agentId}`,
    );
    expect(mine.body.kpis.tasksTotal.value).toBe(3);
    expect(mine.body.daily).toHaveLength(30);
  });
});
