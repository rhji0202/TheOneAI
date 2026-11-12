import type { RecordedRequest } from './fake-llm-server.js';
import {
  api,
  readSse,
  type SseEvent,
  startSession,
  startTestApp,
  type TestContext,
} from './helpers.js';

interface SendResponse {
  task: { id: string };
  eventsUrl: string;
}
interface TaskDetailBody {
  status: string;
  progress: { completed: number; total: number | null };
  failure: { code: string; message: string; resumable: boolean } | null;
}

let ctx: TestContext;
let token: string;

beforeAll(async () => {
  ctx = await startTestApp();
  token = await startSession(ctx.baseUrl, ctx.widgets.A, 'loop-user');
});

afterAll(async () => {
  await ctx?.close();
});

/** 새 대화에서 요청을 보내고 SSE 가 닫힐 때까지 기다린다. */
async function run(text: string, conversationId?: string, sessionToken = token) {
  const conv =
    conversationId ??
    (
      await api<{ id: string }>(ctx.baseUrl, 'POST', '/v1/conversations', {
        token: sessionToken,
        body: {},
      })
    ).body.id;
  const sent = await api<SendResponse>(ctx.baseUrl, 'POST', `/v1/conversations/${conv}/messages`, {
    token: sessionToken,
    body: { content: [{ type: 'text', text }] },
  });
  expect(sent.status).toBe(202);
  const events = await readSse(`${ctx.baseUrl}${sent.body.eventsUrl}`, sessionToken);
  const detail = await api<TaskDetailBody>(ctx.baseUrl, 'GET', `/v1/tasks/${sent.body.task.id}`, {
    token: sessionToken,
  });
  return { conversationId: conv, taskId: sent.body.task.id, events, detail: detail.body };
}

const started = (events: SseEvent[]) =>
  events
    .filter((e) => e.event === 'step.started')
    .map((e) => (e.data as { type: string; name: string }).name);

/** 이 작업의 요청 문구(고유 태그)가 들어간 LLM 호출만 */
const requestsFor = (tag: string): RecordedRequest[] =>
  ctx.llm.requests.filter((r) => r.body.messages.some((m) => (m.content ?? '').includes(tag)));

async function tenantRows<T>(
  fn: (tx: TestContext['owner']) => Promise<T>,
  tenantId = ctx.tenantA.tenantId,
) {
  return ctx.owner.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx as unknown as TestContext['owner']);
  });
}

describe('Agent Loop', () => {
  it('간단한 요청은 계획 1단계 → 답변 스트리밍 → 검증으로 끝난다', async () => {
    const { events, detail } = await run('간단 질문 #simple');
    expect(started(events)).toEqual([
      'context.build',
      'planner.create',
      'executor.respond',
      'evaluator.verify',
    ]);
    const plan = events.find((e) => e.event === 'plan.created')!.data as {
      steps: Array<{ kind: string }>;
    };
    expect(plan.steps.map((s) => s.kind)).toEqual(['respond']);
    expect(events.some((e) => e.event === 'message.delta')).toBe(true);
    expect(events.at(-1)?.event).toBe('task.completed');
    expect(detail).toMatchObject({ status: 'completed', progress: { completed: 1, total: 1 } });
  });

  it('[분석] reason 단계 → 중간 평가 → 답변 → 검증, reason 결과는 checkpoint 에 남는다', async () => {
    const { taskId, events, detail } = await run('[분석] 요금제 비교 #analysis');
    expect(started(events)).toEqual([
      'context.build',
      'planner.create',
      'executor.reason',
      'evaluator.assess',
      'executor.respond',
      'evaluator.verify',
    ]);
    const plan = events.find((e) => e.event === 'plan.created')!.data as {
      steps: Array<{ kind: string; title: string }>;
    };
    expect(plan.steps).toEqual([
      expect.objectContaining({ index: 1, kind: 'reason', title: '요구사항 분석' }),
      expect.objectContaining({ index: 2, kind: 'respond' }),
    ]);
    expect(detail.progress).toEqual({ completed: 2, total: 2 });

    const [steps, task] = await tenantRows(
      async (tx) =>
        [
          await tx.taskStep.findMany({ where: { taskId }, orderBy: { seq: 'asc' } }),
          await tx.task.findUniqueOrThrow({ where: { id: taskId } }),
        ] as const,
    );
    const reason = steps.find((s) => s.type === 'reason')!;
    expect(reason.planIndex).toBe(1);
    expect(reason.checkpoint).toMatchObject({
      nextPlanIndex: 2,
      workingMemory: {
        notes: [{ title: '요구사항 분석', content: expect.stringContaining('분석 메모') }],
      },
    });
    // 가짜 LLM 은 호출마다 입력 100 · 출력 20 토큰 → 5회 호출
    expect(task.inputTokens).toBe(500);
    expect(task.outputTokens).toBe(100);
    expect(steps.find((s) => s.name === 'executor.reason')!.inputTokens).toBe(100);
  });

  it('[재계획] 평가가 replan 이면 계획을 고쳐 다시 실행한다', async () => {
    const { taskId, events } = await run('[재계획] 근거 보강 #replan');
    const revised = events.find((e) => e.event === 'plan.revised')!.data as {
      planVersion: number;
      reason: string;
      steps: Array<{ title: string }>;
      diff: { changed: number[] };
    };
    expect(revised).toMatchObject({
      planVersion: 2,
      reason: '근거가 부족합니다',
      diff: { changed: [1] },
    });
    expect(revised.steps.map((s) => s.title)).toEqual(['보완 분석', '답변 작성']);
    expect(started(events)).toEqual([
      'context.build',
      'planner.create',
      'executor.reason',
      'evaluator.assess',
      'planner.revise',
      'executor.reason',
      'evaluator.assess',
      'executor.respond',
      'evaluator.verify',
    ]);
    const completed = events.at(-1)!.data as { result: { summary: { replans: number } } };
    expect(completed.result.summary.replans).toBe(1);
    const task = await tenantRows((tx) => tx.task.findUniqueOrThrow({ where: { id: taskId } }));
    expect(task.replanCount).toBe(1);
    expect(task.planVersion).toBe(2);
  });

  it('[형식오류] 계획 JSON 이 두 번 다 잘못되면 기본 계획으로 진행한다', async () => {
    const { events, detail } = await run('[형식오류] 아무거나 #badjson');
    const plan = events.find((e) => e.event === 'plan.created')!.data as {
      steps: Array<{ title: string; kind: string }>;
    };
    expect(plan.steps).toEqual([expect.objectContaining({ title: '답변 작성', kind: 'respond' })]);
    const planStep = events.find(
      (e) =>
        e.event === 'step.completed' &&
        (e.data as { summary: string }).summary?.includes('기본 계획'),
    );
    expect(planStep).toBeDefined();
    expect(requestsFor('#badjson').filter((r) => r.role === 'Planner')).toHaveLength(2);
    expect(detail.status).toBe('completed');
  });

  it('[모델오류] 답변 모델이 계속 실패하면 task.failed(MODEL_ERROR)', async () => {
    const { events, detail } = await run('[모델오류] 터져라 #modelerror');
    expect(events.at(-1)).toMatchObject({
      event: 'task.failed',
      data: { code: 'MODEL_ERROR', resumable: false },
    });
    expect((events.at(-1)!.data as { message: string }).message).toContain('executor');
    expect(detail).toMatchObject({ status: 'failed', failure: { code: 'MODEL_ERROR' } });
    // LLM_MAX_RETRIES=1 → 최초 1회 + 재시도 1회
    expect(
      requestsFor('#modelerror').filter((r) => r.role.startsWith('Executor (respond')),
    ).toHaveLength(2);
  });

  it('API Key 가 없는 provider 는 task.failed(MODEL_NOT_CONFIGURED)', async () => {
    const tokenC = await startSession(ctx.baseUrl, ctx.widgets.C, 'nokey-user');
    const { events, detail } = await run('키 없음 #nokey', undefined, tokenC);
    expect(events.at(-1)).toMatchObject({
      event: 'task.failed',
      data: { code: 'MODEL_NOT_CONFIGURED' },
    });
    expect((events.at(-1)!.data as { message: string }).message).toContain(
      'vault://providers/missing',
    );
    expect(detail.status).toBe('failed');
    expect(requestsFor('#nokey')).toHaveLength(0);
  });
});

describe('LLM 요청 내용', () => {
  it('플랫폼 지침 + 테넌트 지침, 역할별 모델 · 추론 파라미터, 인증 헤더', async () => {
    await run('[분석] 파라미터 확인 #params');
    const reqs = requestsFor('#params');
    const planner = reqs.find((r) => r.role === 'Planner')!;
    const respond = reqs.find((r) => r.role.startsWith('Executor (respond'))!;
    const verify = reqs.find((r) => r.role === 'Evaluator:verify')!;

    for (const r of [planner, respond, verify]) {
      expect(r.headers.authorization).toBe('Bearer e2e-llm-key');
      const system = r.body.messages[0]!.content!;
      expect(system).toContain('## Platform rules');
      expect(system).toContain('테넌트 A의 고객지원 에이전트');
    }
    // planner: reasoning low → reasoning_effort, JSON 모드
    expect(planner.body).toMatchObject({
      model: 'fake-planner',
      reasoning_effort: 'low',
      response_format: { type: 'json_object' },
      max_tokens: 1000,
    });
    expect(planner.body).not.toHaveProperty('thinking');
    // executor: reasoning off → DeepSeek thinking disabled, temperature, 스트리밍
    expect(respond.body).toMatchObject({
      model: 'fake-executor',
      stream: true,
      thinking: { type: 'disabled' },
      temperature: 0.3,
    });
    // reason 단계의 결과(작업 노트)가 답변 요청에 들어간다
    expect(respond.body.messages[0]!.content).toContain('분석 메모');
    // evaluator: 추론 설정 없음 → 관련 파라미터 없음
    expect(verify.body).not.toHaveProperty('reasoning_effort');
    expect(verify.body).not.toHaveProperty('thinking');
  });

  it('같은 대화의 이전 메시지가 다음 요청 Context 에 들어간다', async () => {
    const first = await run('첫 질문입니다 #history-1');
    await run('이어서 묻습니다 #history-2', first.conversationId);
    const respond = requestsFor('#history-2').find((r) => r.role.startsWith('Executor (respond'))!;
    const roles = respond.body.messages.map((m) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'user']);
    expect(respond.body.messages[1]!.content).toContain('#history-1');
    expect(respond.body.messages[2]!.content).toContain('요청하신 내용에 대한 답변입니다');
    expect(respond.body.messages[3]!.content).toContain('#history-2');
  });
});
