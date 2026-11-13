import { TaskExecutionService } from '../src/workers/task-execution.service.js';
import { TaskRecoveryService } from '../src/workers/task-recovery.service.js';
import type { RecordedRequest } from './fake-llm-server.js';
import {
  adminLogin,
  api,
  CONSOLE_MEMBERS,
  readSse,
  type SseEvent,
  startSession,
  startTestApp,
  type TestContext,
  waitFor,
} from './helpers.js';

let ctx: TestContext;
let token: string;
let ownerToken: string;

beforeAll(async () => {
  ctx = await startTestApp();
  token = await startSession(ctx.baseUrl, ctx.widgets.A, 'recovery-user');
  ownerToken = await adminLogin(ctx.baseUrl, ctx.slugs.A, CONSOLE_MEMBERS.owner);
});

afterAll(async () => {
  await ctx?.close();
});

/** 작업을 보내고 id 만 돌려준다 (끝나기를 기다리지 않음) */
async function send(text: string): Promise<{ taskId: string; eventsUrl: string }> {
  const conv = (
    await api<{ id: string }>(ctx.baseUrl, 'POST', '/v1/conversations', { token, body: {} })
  ).body.id;
  const sent = await api<{ task: { id: string }; eventsUrl: string }>(
    ctx.baseUrl,
    'POST',
    `/v1/conversations/${conv}/messages`,
    { token, body: { content: [{ type: 'text', text }] } },
  );
  expect(sent.status).toBe(202);
  return { taskId: sent.body.task.id, eventsUrl: sent.body.eventsUrl };
}

const status = async (taskId: string) =>
  (
    await api<{ status: string; failure: { code: string; resumable: boolean } | null }>(
      ctx.baseUrl,
      'GET',
      `/v1/tasks/${taskId}`,
      { token },
    )
  ).body;

const waitStatus = (taskId: string, wanted: string[], timeoutMs = 15_000) =>
  waitFor(async () => {
    const s = await status(taskId);
    return wanted.includes(s.status) ? s : null;
  }, timeoutMs);

/** 이 작업의 이벤트 전부 (DB 의 task_events) */
async function events(
  taskId: string,
): Promise<Array<{ type: string; payload: Record<string, unknown> }>> {
  return tenantRows((tx) =>
    tx.taskEvent.findMany({
      where: { taskId },
      orderBy: { id: 'asc' },
      select: { type: true, payload: true },
    }),
  ) as Promise<Array<{ type: string; payload: Record<string, unknown> }>>;
}

async function steps(taskId: string) {
  return tenantRows((tx) => tx.taskStep.findMany({ where: { taskId }, orderBy: { seq: 'asc' } }));
}

const waitStep = (taskId: string, name: string, stepStatus = 'running') =>
  waitFor(
    async () =>
      (await steps(taskId)).find((s) => s.name === name && s.status === stepStatus) ?? null,
  );

async function tenantRows<T>(fn: (tx: TestContext['owner']) => Promise<T>) {
  return ctx.owner.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${ctx.tenantA.tenantId}, true)`;
    return fn(tx as unknown as TestContext['owner']);
  });
}

const requestsFor = (tag: string): RecordedRequest[] =>
  ctx.llm.requests.filter((r) => r.body.messages.some((m) => (m.content ?? '').includes(tag)));
const workCount = (tag: string) =>
  requestsFor(tag).filter((r) => r.role.startsWith('Executor (work')).length;

describe('일시정지 · checkpoint 재개', () => {
  it('실행 중 일시정지 → 현재 단계를 마치고 paused → 재개하면 끝난 단계는 건너뛴다', async () => {
    const { taskId } = await send('[느린분석] 일시정지 #pause');
    await waitStep(taskId, 'executor.reason');
    const paused = await api(ctx.baseUrl, 'POST', `/v1/admin/tasks/${taskId}/pause`, {
      token: ownerToken,
      body: { reason: '점검' },
    });
    expect(paused.status).toBe(202);
    const done = await waitStatus(taskId, ['paused']);
    expect(done.status).toBe('paused');
    // 일시정지 전에 시작한 단계는 끝까지 실행되어 checkpoint 를 남겼다
    expect((await steps(taskId)).find((s) => s.name === 'executor.reason')).toMatchObject({
      status: 'succeeded',
      checkpointAt: expect.any(Date),
    });

    const resumed = await api(ctx.baseUrl, 'POST', `/v1/tasks/${taskId}/resume`, {
      token,
      body: { mode: 'checkpoint' },
    });
    expect(resumed.status).toBe(202);
    await waitStatus(taskId, ['completed']);
    expect(workCount('#pause')).toBe(1);
    const evts = await events(taskId);
    expect(evts.find((e) => e.type === 'task.resumed')?.payload).toMatchObject({
      reason: 'resume',
      fromPlanIndex: 2,
    });
    expect(evts.filter((e) => e.type === 'task.status').map((e) => e.payload.status)).toEqual([
      'queued',
      'running',
      'paused',
      'queued',
      'running',
    ]);
    const names = (await steps(taskId)).map((s) => s.name);
    expect(names.filter((n) => n === 'executor.reason')).toHaveLength(1);
    expect(names.filter((n) => n === 'context.build')).toHaveLength(2);
  });

  it('[두번실패] 답변 단계에서 실패 → resumable → checkpoint 부터 재개하면 분석을 반복하지 않고 끝난다', async () => {
    const { taskId } = await send('[두번실패] 재개 #fail-twice');
    const failed = await waitStatus(taskId, ['failed']);
    expect(failed.failure).toMatchObject({ code: 'MODEL_ERROR', resumable: true });

    const res = await api(ctx.baseUrl, 'POST', `/v1/tasks/${taskId}/resume`, {
      token,
      body: { mode: 'checkpoint' },
    });
    expect(res.status).toBe(202);
    await waitStatus(taskId, ['completed']);
    expect(workCount('#fail-twice')).toBe(1);
    const task = await tenantRows((tx) => tx.task.findUniqueOrThrow({ where: { id: taskId } }));
    // 실패한 실행의 토큰도 작업 합계에 남는다
    expect(task.inputTokens).toBeGreaterThan(0);
    expect(task.failureCode).toBeNull();
  });

  it('재개 조건: 완료된 작업 · checkpoint 없는 작업', async () => {
    const { taskId, eventsUrl } = await send('간단 질문 #done');
    await readSse(`${ctx.baseUrl}${eventsUrl}`, token);
    expect(
      await api(ctx.baseUrl, 'POST', `/v1/tasks/${taskId}/resume`, { token, body: {} }),
    ).toMatchObject({ status: 409, body: { code: 'TASK_NOT_RESUMABLE' } });

    const noCp = await send('[모델오류] 체크포인트 없음 #nocp');
    await waitStatus(noCp.taskId, ['failed']);
    expect(
      await api(ctx.baseUrl, 'POST', `/v1/tasks/${noCp.taskId}/resume`, {
        token,
        body: { mode: 'checkpoint' },
      }),
    ).toMatchObject({ status: 409, body: { code: 'CHECKPOINT_NOT_FOUND' } });
    // 처음부터 다시는 가능 (같은 오류로 다시 실패)
    const restart = await api(ctx.baseUrl, 'POST', `/v1/tasks/${noCp.taskId}/resume`, {
      token,
      body: { mode: 'restart' },
    });
    expect(restart.status).toBe(202);
    await waitStatus(noCp.taskId, ['failed']);
    expect(
      (await events(noCp.taskId)).some(
        (e) => e.type === 'task.status' && e.payload.reason === 'restarted',
      ),
    ).toBe(true);
  });
});

describe('Worker 장애 복구', () => {
  it('답변 중 Worker 가 죽으면 복구 잡이 마지막 checkpoint 부터 다시 실행한다', async () => {
    const execution = ctx.app.get(TaskExecutionService);
    const { taskId } = await send('[느린답변] 복구 #recover');
    await waitStep(taskId, 'executor.respond');
    expect(execution.abandon(taskId)).toBe(true);
    await waitFor(async () => (!execution.isRunning(taskId) ? true : null));
    expect((await status(taskId)).status).toBe('running'); // 죽은 Worker 는 상태를 바꾸지 못한다

    expect(await ctx.app.get(TaskRecoveryService).recover(ctx.tenantA.tenantId, taskId, true)).toBe(
      'recovered',
    );
    await waitStatus(taskId, ['completed'], 20_000);

    const evts = await events(taskId);
    expect(evts.find((e) => e.type === 'task.recovering')?.payload).toMatchObject({
      reason: 'worker_lost',
      fromPlanIndex: 2,
    });
    expect(evts.find((e) => e.type === 'task.resumed')?.payload).toMatchObject({
      reason: 'recover',
      fromPlanIndex: 2,
    });
    expect(workCount('#recover')).toBe(1);
    expect(
      requestsFor('#recover').filter((r) => r.role.startsWith('Executor (respond')),
    ).toHaveLength(2);
    const task = await tenantRows((tx) => tx.task.findUniqueOrThrow({ where: { id: taskId } }));
    expect(task.recoveryCount).toBe(1);
    // 최종 답변 메시지는 하나만 저장된다
    expect(
      await tenantRows((tx) => tx.message.count({ where: { taskId, role: 'assistant' } })),
    ).toBe(1);
  });

  it('복구 한도를 넘으면 failed(RECOVERY_LIMIT_EXCEEDED) — 사용자가 재개할 수 있다', async () => {
    const execution = ctx.app.get(TaskExecutionService);
    const { taskId } = await send('[느린답변] 한도 #limit');
    await waitStep(taskId, 'executor.respond');
    execution.abandon(taskId);
    await waitFor(async () => (!execution.isRunning(taskId) ? true : null));
    await tenantRows((tx) => tx.task.update({ where: { id: taskId }, data: { recoveryCount: 3 } }));
    expect(await ctx.app.get(TaskRecoveryService).recover(ctx.tenantA.tenantId, taskId, true)).toBe(
      'failed',
    );
    expect(await status(taskId)).toMatchObject({
      status: 'failed',
      failure: { code: 'RECOVERY_LIMIT_EXCEEDED', resumable: true },
    });
  });

  it('heartbeat 가 살아 있는 작업은 복구하지 않는다', async () => {
    const { taskId } = await send('[느린분석] 살아 있음 #alive');
    await waitStep(taskId, 'executor.reason');
    expect(await ctx.app.get(TaskRecoveryService).recover(ctx.tenantA.tenantId, taskId)).toBe(
      'skipped',
    );
    await waitStatus(taskId, ['completed']);
  });

  it('Worker 종료 시 실행 중 작업을 recovering 으로 넘기고 이어서 끝낸다', async () => {
    const { taskId } = await send('[느린답변] 종료 #shutdown');
    await waitStep(taskId, 'executor.respond');
    await ctx.app.get(TaskExecutionService).shutdown();
    await waitStatus(taskId, ['completed'], 20_000);
    const evts = await events(taskId);
    expect(evts.find((e) => e.type === 'task.recovering')?.payload).toMatchObject({
      reason: 'worker_shutdown',
    });
    expect(workCount('#shutdown')).toBe(1);
  });
});

describe('실행 중 추가 지시 (steer)', () => {
  it('다음 단계부터 요청에 반영되고, 끝난 작업에는 보낼 수 없다', async () => {
    const { taskId, eventsUrl } = await send('[느린분석] 요금 비교 #steer');
    await waitStep(taskId, 'executor.reason');
    const steer = await api<{ messageId: string }>(
      ctx.baseUrl,
      'POST',
      `/v1/tasks/${taskId}/steer`,
      {
        token,
        body: { text: '표로 정리해 주세요 STEER-MARK' },
      },
    );
    expect(steer.status).toBe(202);
    const sse = await readSse(`${ctx.baseUrl}${eventsUrl}`, token);
    expect(sse.map((e: SseEvent) => e.event)).toEqual(
      expect.arrayContaining(['task.steered', 'task.steer_applied']),
    );
    const respond = requestsFor('#steer').find((r) => r.role.startsWith('Executor (respond'))!;
    expect(respond.body.messages.at(-1)!.content).toContain('STEER-MARK');
    const saved = await tenantRows((tx) =>
      tx.message.findUniqueOrThrow({ where: { id: steer.body.messageId } }),
    );
    expect(saved).toMatchObject({ taskId, role: 'user' });

    expect(
      await api(ctx.baseUrl, 'POST', `/v1/tasks/${taskId}/steer`, {
        token,
        body: { text: '늦은 지시' },
      }),
    ).toMatchObject({ status: 409, body: { code: 'TASK_NOT_ACTIVE' } });
  });
});

describe('콘솔 작업 조회 (C-02)', () => {
  it('목록 · 트레이스(계획 · 단계 · checkpoint · 역할별 토큰) · 단계 상세', async () => {
    const list = await api<{
      items: Array<{ id: string; status: string; agentName: string; endUserPseudonym: string }>;
    }>(ctx.baseUrl, 'GET', '/v1/admin/tasks?status=completed&limit=50', { token: ownerToken });
    expect(list.status).toBe(200);
    const recovered = list.body.items.find((t) => t.status === 'completed')!;
    expect(recovered.endUserPseudonym).toEqual(expect.any(String));
    expect(recovered).toMatchObject({ agentVersion: expect.any(Number), costAmount: 0 });

    // 상태 여러 개 (쉼표) — 대시보드의 진행 중 작업
    const multi = await api<{ items: Array<{ status: string }> }>(
      ctx.baseUrl,
      'GET',
      '/v1/admin/tasks?status=completed,failed&limit=100',
      { token: ownerToken },
    );
    expect(multi.status).toBe(200);
    expect(multi.body.items.every((t) => ['completed', 'failed'].includes(t.status))).toBe(true);
    expect(multi.body.items.length).toBeGreaterThan(0);
    expect(
      (
        await api(ctx.baseUrl, 'GET', '/v1/admin/tasks?status=completed,nope', {
          token: ownerToken,
        })
      ).status,
    ).toBe(400);

    const pauseTask = (await tenantRows((tx) =>
      tx.task.findFirst({ where: { title: { contains: '#pause' } }, select: { id: true } }),
    ))!;
    const trace = await api<{
      task: { usage: { byRole: Record<string, { inputTokens: number }> } };
      plans: unknown[];
      steps: Array<{ id: string; name: string; checkpoint: { label: string } | null }>;
    }>(ctx.baseUrl, 'GET', `/v1/admin/tasks/${pauseTask.id}/trace`, { token: ownerToken });
    expect(trace.status).toBe(200);
    expect(trace.body.plans.length).toBeGreaterThanOrEqual(1);
    expect(trace.body.task.usage.byRole.executor!.inputTokens).toBeGreaterThan(0);
    const cp = trace.body.steps.find((s) => s.checkpoint)!;
    expect(cp.checkpoint!.label).toMatch(/^cp-\d+$/);
    const detail = await api<{ checkpoint: { data: { nextPlanIndex: number } } }>(
      ctx.baseUrl,
      'GET',
      `/v1/admin/tasks/${pauseTask.id}/steps/${cp.id}`,
      { token: ownerToken },
    );
    expect(detail.body.checkpoint.data.nextPlanIndex).toBe(2);
  });
});
