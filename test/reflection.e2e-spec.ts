import type { RecordedRequest } from './fake-llm-server.js';
import {
  api,
  readSse,
  type SseEvent,
  startSession,
  startTestApp,
  type TestContext,
  waitFor,
} from './helpers.js';

let ctx: TestContext;
let token: string;

beforeAll(async () => {
  ctx = await startTestApp();
  token = await startSession(ctx.baseUrl, ctx.widgets.A, 'reflection-user');
});

afterAll(async () => {
  await ctx?.close();
});

async function tenantRows<T>(fn: (tx: TestContext['owner']) => Promise<T>) {
  return ctx.owner.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${ctx.tenantA.tenantId}, true)`;
    return fn(tx as unknown as TestContext['owner']);
  });
}

const newConversation = async () =>
  (await api<{ id: string }>(ctx.baseUrl, 'POST', '/v1/conversations', { token, body: {} })).body
    .id;

async function send(conversationId: string, text: string) {
  const sent = await api<{ task: { id: string }; eventsUrl: string }>(
    ctx.baseUrl,
    'POST',
    `/v1/conversations/${conversationId}/messages`,
    { token, body: { content: [{ type: 'text', text }] } },
  );
  expect(sent.status).toBe(202);
  const events = await readSse(`${ctx.baseUrl}${sent.body.eventsUrl}`, token);
  const taskId = sent.body.task.id;
  const steps = await tenantRows((tx) =>
    tx.taskStep.findMany({ where: { taskId }, orderBy: { seq: 'asc' } }),
  );
  return { taskId, events, steps };
}

const requests = (tag: string, role?: string): RecordedRequest[] =>
  ctx.llm.requests.filter(
    (r) =>
      (!role || r.role === role) && r.body.messages.some((m) => (m.content ?? '').includes(tag)),
  );
const compressorCalls = () => ctx.llm.requests.filter((r) => r.role === 'Compressor:conversation');
const last = (events: SseEvent[]) => events.at(-1)!;

describe('Context Compression — 대화 요약', () => {
  it('최근 대화 창 밖의 메시지는 요약에 합치고, 다음 작업에서는 새로 밀려난 메시지만 더한다', async () => {
    const conversationId = await newConversation();
    // 오래된 대화 20개 (메시지 12개 · 1만2천 자 창을 넘는다)
    await tenantRows(async (tx) => {
      for (let i = 0; i < 20; i++) {
        await tx.message.create({
          data: {
            tenantId: ctx.tenantA.tenantId,
            conversationId,
            role: i % 2 === 0 ? 'user' : 'assistant',
            content: [
              {
                type: 'text',
                text: `${i}번째 메시지 — 요금제 A 와 배송지 부산 이야기. ${'내용 '.repeat(100)}`,
              },
            ],
          },
        });
      }
    });

    const before = compressorCalls().length;
    const first = await send(conversationId, '[분석] 지난번 이야기 이어서 #conv-1');
    expect(last(first.events).event).toBe('task.completed');
    const context = first.steps.find((s) => s.name === 'context.build')!;
    expect(context.output).toMatchObject({
      historyMessages: 12,
      conversationSummary: { mergedMessages: 8 },
    });
    expect(compressorCalls()).toHaveLength(before + 1);
    expect(compressorCalls().at(-1)!.body.messages[1]!.content).toContain(
      'Previous summary:\n(none)',
    );

    const conversation = await tenantRows((tx) =>
      tx.conversation.findUniqueOrThrow({ where: { id: conversationId } }),
    );
    expect(conversation.summary).toContain('이전 대화 메시지 8개 요약');
    expect(conversation.summaryThroughId).not.toBeNull();
    // 요약은 계획 · 작업 · 답변 프롬프트에 데이터로 들어간다
    for (const role of ['Planner', 'Executor (work step)', 'Executor (respond step)']) {
      const system = requests('#conv-1', role)[0]!.body.messages[0]!.content!;
      expect(system).toContain('## Earlier in this conversation');
      expect(system).toContain('이전 대화 메시지 8개 요약');
    }

    // 두 번째 작업: 이번 대화(요청 + 답변)가 창에 들어오며 밀려난 메시지만 이전 요약에 합친다
    const second = await send(conversationId, '[분석] 하나 더 #conv-2');
    expect(second.steps.find((s) => s.name === 'context.build')!.output).toMatchObject({
      conversationSummary: { mergedMessages: 2 },
    });
    const call = compressorCalls().at(-1)!.body.messages[1]!.content!;
    expect(call).toContain('이전 대화 메시지 8개 요약');
    expect(call.match(/^(User|Agent): /gm)).toHaveLength(2);
    expect(
      (
        await tenantRows((tx) =>
          tx.conversation.findUniqueOrThrow({ where: { id: conversationId } }),
        )
      ).summary,
    ).toContain('(이전 요약에 이어)');
  });

  it('짧은 대화는 요약하지 않는다', async () => {
    const before = compressorCalls().length;
    const { steps } = await send(await newConversation(), '[분석] 짧은 대화 #conv-short');
    expect(compressorCalls()).toHaveLength(before);
    expect(steps.find((s) => s.name === 'context.build')!.output).toMatchObject({
      conversationSummary: null,
    });
  });
});

describe('Context Compression — 작업 노트', () => {
  it('노트가 길어지면 앞 단계 노트를 하나로 줄이고(단계 기록), 이후 단계 · 답변은 줄인 노트를 쓴다', async () => {
    const { events, steps } = await send(await newConversation(), '[긴메모] 길게 분석해 줘 #notes');
    expect(last(events).event).toBe('task.completed');
    const compress = steps.filter((s) => s.name === 'context.compress_notes');
    expect(compress.length).toBeGreaterThanOrEqual(1);
    expect(compress[0]).toMatchObject({ status: 'succeeded', type: 'context' });
    expect(compress[0]!.output).toMatchObject({ before: { notes: 3 }, after: { notes: 3 } });
    expect(compress[0]!.inputTokens).toBeGreaterThan(0);

    const respond = requests('#notes', 'Executor (respond step)')[0]!.body.messages[0]!.content!;
    expect(respond).toContain('Earlier steps (');
    expect(respond).toContain('앞 단계 요약: 자료 정리 · 비교 분석 · 위험 검토 완료, 핵심 수치 42');
    // 4단계 메모가 모두 원문이었다면 2만 자가 넘는다
    expect(respond.length).toBeLessThan(16_000);
  });
});

describe('Reflection', () => {
  it('재계획할 때 이 작업에서 실패 · 거부된 Tool 호출을 알려 같은 시도를 반복하지 않게 한다', async () => {
    const { events, steps } = await send(
      await newConversation(),
      '[반성] 파일 내용 보여줘 #reflect',
    );
    expect(last(events).event).toBe('task.completed');
    const revise = requests('#reflect', 'Planner').find((r) =>
      (r.body.messages.at(-1)!.content ?? '').includes('Evaluator feedback'),
    )!;
    const content = revise.body.messages.at(-1)!.content!;
    expect(content).toContain('Problems so far');
    expect(content).toContain('shell__exec: refused (unknown_tool)');
    expect(steps.find((s) => s.name === 'planner.revise')!.output).toMatchObject({
      problems: [expect.stringContaining('shell__exec: refused (unknown_tool)')],
    });

    // 작업이 끝나면 잘못된 것들이 기억 추출(처리 요령)의 근거로 간다
    const extract = await waitFor(async () => requests('#reflect', 'Memory:extract')[0]);
    const input = extract.body.messages[1]!.content!;
    expect(input).toContain('What went wrong or was corrected during the task');
    expect(input).toContain('Tool shell__exec was refused (unknown_tool)');
    expect(input).toContain('The plan was revised: 근거가 부족합니다');
  });

  it('답변 검증에서 구체적인 오류가 나오면 정정 메시지를 한 번 보내고 다시 검증한다', async () => {
    const conversationId = await newConversation();
    const { taskId, events, steps } = await send(
      conversationId,
      '[검증실패] 환불 기한 알려줘 #correct',
    );
    const done = last(events);
    expect(done.event).toBe('task.completed');
    const result = (
      done.data as {
        result: { messageId: string; correctionMessageId: string; verification: unknown[] };
      }
    ).result;
    expect(result.correctionMessageId).toBeTruthy();
    expect(result.verification).toEqual([
      { label: '요청에 답함', passed: true },
      { label: '사용자 언어로 작성', passed: true },
    ]);
    expect(steps.map((s) => s.name).slice(-3)).toEqual([
      'evaluator.verify',
      'executor.correct',
      'evaluator.verify_correction',
    ]);
    expect(steps.find((s) => s.name === 'evaluator.verify')!.evaluation).toMatchObject({
      verdict: 'fail',
      issues: ['환불 기한을 14일이라고 했지만 노트에는 7일이다'],
    });

    const messages = await tenantRows((tx) =>
      tx.message.findMany({ where: { taskId, role: 'assistant' }, orderBy: { id: 'asc' } }),
    );
    expect(messages).toHaveLength(2);
    expect(messages[1]!.id).toBe(result.correctionMessageId);
    expect(JSON.stringify(messages[1]!.content)).toContain(
      '정정합니다: 환불 기한은 14일이 아니라 7일입니다.',
    );
    const correction = requests('#correct', 'Executor (correction)')[0]!.body.messages[1]!.content!;
    expect(correction).toContain('환불 기한을 14일이라고 했지만 노트에는 7일이다');
    expect(correction).toContain('Your previous answer:');
  });

  it('실행 정책 selfCorrection 이 꺼져 있으면 정정하지 않는다', async () => {
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
            selfCorrection: false,
          },
        },
      }),
    );
    try {
      const { steps, events } = await send(
        await newConversation(),
        '[검증실패] 환불 기한 #no-correct',
      );
      expect(steps.map((s) => s.name)).not.toContain('executor.correct');
      expect((last(events).data as { result: Record<string, unknown> }).result).not.toHaveProperty(
        'correctionMessageId',
      );
    } finally {
      await tenantRows((tx) =>
        tx.agentVersion.update({
          where: { id: versionId },
          data: { executionPolicy: original.executionPolicy ?? {} },
        }),
      );
    }
  });
});
