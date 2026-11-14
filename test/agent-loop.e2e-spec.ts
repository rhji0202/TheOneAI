import { BUDGET_NOTE_PREFIX, type RecordedRequest } from './fake-llm-server.js';
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
  it('간단한 요청은 모델 차례 한 번에 답변을 스트리밍하고 끝난다 (계획 · 검증 호출 없음)', async () => {
    const { events, detail } = await run('간단 질문 #simple');
    expect(started(events)).toEqual(['context.build', 'agent.turn']);
    expect(events.some((e) => e.event === 'plan.created')).toBe(false);
    expect(events.some((e) => e.event === 'message.delta')).toBe(true);
    expect(events.at(-1)?.event).toBe('task.completed');
    expect(detail.status).toBe('completed');
    expect(requestsFor('#simple').map((r) => r.role)).toEqual(['Agent']);
  });

  it('[분석] todo 로 할 일 목록을 만들고 상태를 고친 뒤 답한다 — 대화는 checkpoint 에 남는다', async () => {
    const { taskId, events, detail } = await run('[분석] 요금제 비교 #analysis');
    expect(started(events)).toEqual(['context.build', 'agent.turn', 'agent.turn', 'agent.turn']);
    const created = events.find((e) => e.event === 'plan.created')!.data as {
      planVersion: number;
      steps: Array<{ index: number; kind: string; title: string; status: string }>;
    };
    expect(created.steps).toEqual([
      expect.objectContaining({
        index: 1,
        kind: 'reason',
        title: '요구사항 분석',
        status: 'running',
      }),
      expect.objectContaining({ index: 2, title: '답변 작성', status: 'pending' }),
    ]);
    const updated = events.find((e) => e.event === 'plan.updated')!.data as {
      planVersion: number;
      steps: Array<{ status: string }>;
    };
    expect(updated.planVersion).toBe(created.planVersion);
    expect(updated.steps.map((s) => s.status)).toEqual(['succeeded', 'succeeded']);
    expect(detail.progress).toEqual({ completed: 2, total: 2 });

    const [steps, task] = await tenantRows(
      async (tx) =>
        [
          await tx.taskStep.findMany({ where: { taskId }, orderBy: { seq: 'asc' } }),
          await tx.task.findUniqueOrThrow({ where: { id: taskId } }),
        ] as const,
    );
    // 할 일 목록은 Tool 실행 기록이 아니라 런타임이 직접 처리한다
    expect(steps.filter((s) => s.type === 'tool')).toHaveLength(0);
    const second = steps.filter((s) => s.name === 'agent.turn')[1]!;
    expect(second.planIndex).toBe(1);
    expect(second.checkpoint).toMatchObject({
      workingMemory: { loop: { turns: 2, messages: expect.any(Array) } },
    });
    // 가짜 LLM 은 호출마다 입력 100 · 출력 20 토큰 → 3회 호출
    expect(task.inputTokens).toBe(300);
    expect(task.outputTokens).toBe(60);
    expect(second.inputTokens).toBe(100);
  });

  it('[재계획] 할 일 목록의 단계 구성을 바꾸면 새 버전(plan.revised)으로 남는다', async () => {
    const { taskId, events } = await run('[재계획] 근거 보강 #replan');
    const revised = events.find((e) => e.event === 'plan.revised')!.data as {
      planVersion: number;
      steps: Array<{ title: string }>;
      diff: { changed: number[] };
    };
    expect(revised).toMatchObject({ planVersion: 2, diff: { changed: [1] } });
    expect(revised.steps.map((s) => s.title)).toEqual(['보완 분석', '답변 작성']);
    const completed = events.at(-1)!.data as { result: { summary: { replans: number } } };
    expect(completed.result.summary.replans).toBe(1);
    const task = await tenantRows((tx) => tx.task.findUniqueOrThrow({ where: { id: taskId } }));
    expect(task.replanCount).toBe(1);
    expect(task.planVersion).toBe(2);
  });

  it('[중간안내] Tool 호출과 함께 온 텍스트는 중간 메시지로 남고, 결과는 마지막 답변을 가리킨다', async () => {
    const { events } = await run('[중간안내] 계산해 주세요 #interim');
    const messages = events
      .filter((e) => e.event === 'message.completed')
      .map(
        (e) => (e.data as { message: { id: string; content: Array<{ text: string }> } }).message,
      );
    expect(messages).toHaveLength(2);
    expect(messages[0]!.content[0]!.text).toBe('확인해 볼게요.');
    expect(messages[1]!.content[0]!.text).toContain('42');
    const result = (events.at(-1)!.data as { result: { messageId: string } }).result;
    expect(result.messageId).toBe(messages[1]!.id);
  });

  it('[모델오류] 모델이 계속 실패하면 task.failed(MODEL_ERROR)', async () => {
    const { events, detail } = await run('[모델오류] 터져라 #modelerror');
    expect(events.at(-1)).toMatchObject({
      event: 'task.failed',
      data: { code: 'MODEL_ERROR', resumable: false },
    });
    expect((events.at(-1)!.data as { message: string }).message).toContain('fake-executor');
    expect(detail).toMatchObject({ status: 'failed', failure: { code: 'MODEL_ERROR' } });
    // LLM_MAX_RETRIES=1 → 최초 1회 + 재시도 1회
    expect(requestsFor('#modelerror').filter((r) => r.role === 'Agent')).toHaveLength(2);
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

/** 테넌트 A 의 배포 Agent 실행 정책을 잠시 바꿔 fn 을 돌린다 */
async function withExecutionPolicy<T>(
  patch: { maxSteps?: number; tokenBudget?: number; maxDurationSec?: number },
  fn: () => Promise<T>,
) {
  const versionId = (
    await tenantRows((tx) => tx.agent.findUniqueOrThrow({ where: { id: ctx.tenantA.agentId } }))
  ).publishedVersionId!;
  const original = await tenantRows((tx) =>
    tx.agentVersion.findUniqueOrThrow({ where: { id: versionId } }),
  );
  await tenantRows((tx) =>
    tx.agentVersion.update({
      where: { id: versionId },
      data: {
        executionPolicy: {
          ...(original.executionPolicy as Record<string, unknown> | null),
          ...patch,
        },
      },
    }),
  );
  try {
    return await fn();
  } finally {
    await tenantRows((tx) =>
      tx.agentVersion.update({
        where: { id: versionId },
        data: { executionPolicy: original.executionPolicy ?? {} },
      }),
    );
  }
}

describe('작업 예산', () => {
  /** 이 작업의 마지막 Agent 요청 — 예산 끝이면 Tool 없이 답하라는 지시와 tool_choice=none */
  const lastAgentRequest = (tag: string) =>
    requestsFor(tag)
      .filter((r) => r.role === 'Agent')
      .at(-1)!;
  const budgetNoted = (r: RecordedRequest) =>
    r.body.tool_choice === 'none' &&
    (r.body.messages.at(-1)!.content ?? '').startsWith(BUDGET_NOTE_PREFIX);

  it('[도구한도] 단계 상한 끝에서는 Tool 없이 답하고 실패로 끝나지 않는다', async () => {
    const { taskId, events, detail } = await withExecutionPolicy({ maxSteps: 12 }, () =>
      run('[도구한도] 상한 끝까지 #step-tail'),
    );
    expect(events.some((e) => e.event === 'message.completed')).toBe(true);
    expect(events.at(-1)?.event).toBe('task.completed');
    expect(detail.status).toBe('completed');
    const steps = await tenantRows((tx) => tx.taskStep.findMany({ where: { taskId } }));
    expect(steps.length).toBeLessThanOrEqual(12);
    expect(budgetNoted(lastAgentRequest('#step-tail'))).toBe(true);
  });

  it('[도구한도] 토큰 예산이 답변할 몫만 남으면 Tool 없이 답하고 완료한다', async () => {
    const { events, detail } = await withExecutionPolicy({ tokenBudget: 1_000 }, () =>
      run('[도구한도] 예산 끝에서 답변 #token-tail'),
    );
    expect(events.at(-1)?.event).toBe('task.completed');
    expect(detail.status).toBe('completed');
    expect(budgetNoted(lastAgentRequest('#token-tail'))).toBe(true);
  });

  it('[도구한도][토큰소모] 차례마다 토큰을 많이 쓰면 80% 에서 멈추고 답한다', async () => {
    const { events, detail } = await withExecutionPolicy({ tokenBudget: 10_000 }, () =>
      run('[도구한도] [토큰소모] 많이 쓰는 분석 #token-soft'),
    );
    expect(events.at(-1)?.event).toBe('task.completed');
    expect(detail.status).toBe('completed');
    // 3천 토큰씩 세 차례(9천 ≥ 8천) 뒤 마지막 차례
    expect(started(events).filter((n) => n === 'agent.turn')).toHaveLength(4);
    expect(budgetNoted(lastAgentRequest('#token-soft'))).toBe(true);
  });

  it('[도구한도][느린단계] 실행 시간이 답변할 몫만 남으면 Tool 없이 답한다', async () => {
    const { events, detail } = await withExecutionPolicy({ maxDurationSec: 12 }, () =>
      run('[도구한도] [느린단계] 오래 걸리는 분석 #time-soft'),
    );
    expect(events.at(-1)?.event).toBe('task.completed');
    expect(detail.status).toBe('completed');
    expect(started(events).filter((n) => n === 'agent.turn')).toHaveLength(4);
  }, 20_000);

  it('[도구한도][토큰소모] 한 차례가 토큰 예산을 넘기면 재개 · 다시 실행할 수 없는 실패로 끝난다', async () => {
    const { taskId, events, detail } = await withExecutionPolicy({ tokenBudget: 1_000 }, () =>
      run('[도구한도] [토큰소모] 예산 소진 #token-dead'),
    );
    expect(events.at(-1)).toMatchObject({
      event: 'task.failed',
      data: { code: 'TOKEN_BUDGET_EXCEEDED', resumable: false },
    });
    expect(detail.failure).toMatchObject({ code: 'TOKEN_BUDGET_EXCEEDED', resumable: false });
    for (const mode of ['checkpoint', 'restart']) {
      expect(
        await api(ctx.baseUrl, 'POST', `/v1/tasks/${taskId}/resume`, { token, body: { mode } }),
      ).toMatchObject({ status: 409, body: { code: 'TASK_BUDGET_EXHAUSTED' } });
    }
  });
});

describe('LLM 요청 내용', () => {
  it('플랫폼 지침 + 테넌트 지침, 모델 · 추론 파라미터, 인증 헤더, todo Tool', async () => {
    await run('[분석] 파라미터 확인 #params');
    const reqs = requestsFor('#params').filter((r) => r.role === 'Agent');
    expect(reqs).toHaveLength(3);
    for (const r of reqs) {
      expect(r.headers.authorization).toBe('Bearer e2e-llm-key');
      const system = r.body.messages[0]!.content!;
      expect(system).toContain('## Platform rules');
      expect(system).toContain('테넌트 A의 고객지원 에이전트');
      // executor: reasoning off → DeepSeek thinking disabled, temperature, 스트리밍
      expect(r.body).toMatchObject({
        model: 'fake-executor',
        stream: true,
        thinking: { type: 'disabled' },
        temperature: 0.3,
      });
      expect(r.body.tools!.map((t) => t.function.name)).toContain('todo');
    }
    // 앞 차례의 Tool 호출 · 결과가 다음 차례 대화에 이어진다
    expect(
      reqs
        .at(-1)!
        .body.messages.map((m) => m.role)
        .slice(-4),
    ).toEqual(['assistant', 'tool', 'assistant', 'tool']);
  });

  it('같은 대화의 이전 메시지가 다음 요청 Context 에 들어간다', async () => {
    const first = await run('첫 질문입니다 #history-1');
    await run('이어서 묻습니다 #history-2', first.conversationId);
    const agent = requestsFor('#history-2').find((r) => r.role === 'Agent')!;
    const roles = agent.body.messages.map((m) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'user']);
    expect(agent.body.messages[1]!.content).toContain('#history-1');
    expect(agent.body.messages[2]!.content).toContain('요청하신 내용에 대한 답변입니다');
    expect(agent.body.messages[3]!.content).toContain('#history-2');
  });
});
