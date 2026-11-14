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
    // 요약은 Agent 의 모든 차례 지침에 데이터로 들어간다
    const turns = requests('#conv-1', 'Agent');
    expect(turns).toHaveLength(3);
    for (const turn of turns) {
      const system = turn.body.messages[0]!.content!;
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

describe('Reflection — 기억 추출의 근거', () => {
  it('거부된 Tool 호출과 이 작업에서 부른 Tool 이 처리 요령 기억의 근거로 간다', async () => {
    const { events } = await send(await newConversation(), '[무단] 파일 내용 보여줘 #reflect');
    expect(last(events).event).toBe('task.completed');
    // 거부 결과는 다음 차례 대화에 그대로 이어진다 (모델이 같은 호출을 되풀이하지 않도록)
    const turns = requests('#reflect', 'Agent');
    expect(turns.at(-1)!.body.messages.at(-1)!.content).toContain('UNKNOWN_TOOL');

    const extract = await waitFor(async () => requests('#reflect', 'Memory:extract')[0]);
    const input = extract.body.messages[1]!.content!;
    expect(input).toContain('Tools the agent used:');
    expect(input).toContain('- Called shell__exec');
    expect(input).toContain('What went wrong or was corrected during the task');
    expect(input).toContain('Tool shell__exec was refused (unknown_tool)');
  });

  it('할 일 목록을 고친 작업은 그 사실을 근거로 남긴다', async () => {
    const { events } = await send(await newConversation(), '[재계획] 근거 보강 #reflect-plan');
    expect(last(events).event).toBe('task.completed');
    const extract = await waitFor(async () => requests('#reflect-plan', 'Memory:extract')[0]);
    expect(extract.body.messages[1]!.content).toContain(
      'The plan was revised: 할 일 목록을 고쳤어요',
    );
  });
});
