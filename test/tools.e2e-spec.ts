import { z } from 'zod';
import { BuiltinToolCatalog } from '../src/tools/builtin-tool.catalog.js';
import { ToolRegistryService } from '../src/tools/tool-registry.service.js';
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
}
interface ToolEvent {
  seq: number;
  executionId: string;
  toolName: string;
  status?: string;
  attempt?: number;
  reason?: string;
  argsPreview?: string;
  resultPreview?: string | null;
}

let ctx: TestContext;
let token: string;
/** 테스트 Tool 을 등록하기 전 작업들이 고정한 Registry 버전 */
let builtinOnlyVersion: string;

beforeAll(async () => {
  ctx = await startTestApp();
  token = await startSession(ctx.baseUrl, ctx.widgets.A, 'tool-user');
});

afterAll(async () => {
  await ctx?.close();
});

async function run(text: string) {
  const conv = (
    await api<{ id: string }>(ctx.baseUrl, 'POST', '/v1/conversations', { token, body: {} })
  ).body.id;
  const sent = await api<SendResponse>(ctx.baseUrl, 'POST', `/v1/conversations/${conv}/messages`, {
    token,
    body: { content: [{ type: 'text', text }] },
  });
  expect(sent.status).toBe(202);
  const events = await readSse(`${ctx.baseUrl}${sent.body.eventsUrl}`, token);
  const detail = await api<TaskDetailBody>(ctx.baseUrl, 'GET', `/v1/tasks/${sent.body.task.id}`, {
    token,
  });
  const taskId = sent.body.task.id;
  const [task, steps, executions] = await tenantRows(
    async (tx) =>
      [
        await tx.task.findUniqueOrThrow({ where: { id: taskId } }),
        await tx.taskStep.findMany({ where: { taskId }, orderBy: { seq: 'asc' } }),
        await tx.toolExecution.findMany({ where: { taskId }, orderBy: { startedAt: 'asc' } }),
      ] as const,
  );
  return { taskId, events, detail: detail.body, task, steps, executions };
}

const started = (events: SseEvent[]) =>
  events.filter((e) => e.event === 'step.started').map((e) => (e.data as { name: string }).name);

const toolEvents = (events: SseEvent[], type: string) =>
  events.filter((e) => e.event === type).map((e) => e.data as ToolEvent);

const requestsFor = (tag: string): RecordedRequest[] =>
  ctx.llm.requests.filter((r) => r.body.messages.some((m) => (m.content ?? '').includes(tag)));

const workRequests = (tag: string) =>
  requestsFor(tag).filter((r) => r.role.startsWith('Executor (work'));

const offeredTools = (r: RecordedRequest) => (r.body.tools ?? []).map((t) => t.function.name);

async function tenantRows<T>(fn: (tx: TestContext['owner']) => Promise<T>) {
  return ctx.owner.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${ctx.tenantA.tenantId}, true)`;
    return fn(tx as unknown as TestContext['owner']);
  });
}

describe('내장 Tool', () => {
  it('[도구] 계획의 tool 단계 → 모델이 Tool 호출 → 서버 실행 → 결과로 답변', async () => {
    const { events, detail, task, steps, executions } = await run('[도구] 1234 곱하기 5678 #calc');
    builtinOnlyVersion = task.registryVersionId;

    expect(started(events)).toEqual([
      'context.build',
      'planner.create',
      'executor.tool',
      'builtin.calculate',
      'evaluator.assess',
      'executor.respond',
      'evaluator.verify',
    ]);
    const plan = events.find((e) => e.event === 'plan.created')!.data as {
      steps: Array<Record<string, unknown>>;
    };
    expect(plan.steps[0]).toMatchObject({
      kind: 'tool',
      toolName: 'builtin.calculate',
      requiresApproval: false,
    });
    // Tool 호출 단계는 계획 진행률에 들어가지 않는다
    expect(detail).toMatchObject({ status: 'completed', progress: { completed: 2, total: 2 } });

    const [called] = toolEvents(events, 'tool.called');
    const [result] = toolEvents(events, 'tool.result');
    expect(called).toMatchObject({ toolName: 'builtin.calculate' });
    expect(called!.argsPreview).toContain('1234*5678');
    expect(result).toMatchObject({
      toolName: 'builtin.calculate',
      status: 'succeeded',
      attempt: 1,
    });
    expect(result!.resultPreview).toContain('7006652');

    const toolStep = steps.find((s) => s.type === 'tool')!;
    expect(toolStep).toMatchObject({
      name: 'builtin.calculate',
      planIndex: 1,
      status: 'succeeded',
    });
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({
      toolName: 'builtin.calculate',
      source: 'builtin',
      status: 'succeeded',
      stepId: toolStep.id,
      registryVersionId: task.registryVersionId,
      output: { expression: '1234*5678', result: 7006652 },
    });

    // 모델에게 준 Tool 정의 · tool 메시지 · 다음 단계로 넘어간 결과
    const [first, second] = workRequests('#calc');
    expect(offeredTools(first!)).toEqual([
      'builtin__calculate',
      'builtin__create_file',
      'builtin__current_time',
      'builtin__query_table',
    ]);
    expect(second!.body.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_0_0' });
    expect(second!.body.messages.at(-1)!.content).toContain('7006652');
    const planner = requestsFor('#calc').find((r) => r.role === 'Planner')!;
    expect(planner.body.messages[0]!.content).toContain('builtin__calculate');
    const respond = requestsFor('#calc').find((r) => r.role.startsWith('Executor (respond'))!;
    expect(respond.body.messages[0]!.content).toContain('7006652');
    expect(respond.body).not.toHaveProperty('tools');
  });

  it('[병렬] 읽기 Tool 여러 개는 같은 parallelGroup 으로 동시에 실행하고 결과는 호출 순서대로 돌려준다', async () => {
    const { steps, executions } = await run('[병렬] 계산하고 시간도 #parallel');
    const toolSteps = steps.filter((s) => s.type === 'tool');
    expect(toolSteps.map((s) => s.name).sort()).toEqual([
      'builtin.calculate',
      'builtin.current_time',
    ]);
    expect(toolSteps[0]!.parallelGroup).toMatch(/^p-/);
    expect(toolSteps[1]!.parallelGroup).toBe(toolSteps[0]!.parallelGroup);
    expect(executions.every((e) => e.status === 'succeeded')).toBe(true);

    const toolMessages = workRequests('#parallel')[1]!.body.messages.filter(
      (m) => m.role === 'tool',
    );
    expect(toolMessages.map((m) => m.tool_call_id)).toEqual(['call_0_0', 'call_0_1']);
    expect(toolMessages[0]!.content).toContain('1024');
    expect(toolMessages[1]!.content).toContain('Asia/Seoul');
  });

  it('[잘못된인자] 인자 오류는 실패로 기록하고 모델에게 돌려줘 고치게 한다', async () => {
    const { steps, executions, detail } = await run('[잘못된인자] 1+1 #badargs');
    expect(steps.filter((s) => s.type === 'tool').map((s) => s.status)).toEqual([
      'failed',
      'failed',
      'succeeded',
    ]);
    expect(executions.map((e) => [e.status, e.errorCode])).toEqual([
      ['failed', 'INVALID_ARGUMENTS'],
      ['failed', 'INVALID_ARGUMENTS'],
      ['succeeded', null],
    ]);
    expect(executions[0]!.errorMessage).toContain('not valid JSON');
    expect(executions[1]!.errorMessage).toContain('expression');
    const second = workRequests('#badargs')[1]!;
    expect(second.body.messages.at(-1)!.content).toContain('INVALID_ARGUMENTS');
    expect(detail.status).toBe('completed');
  });

  it('[도구한도] Tool 왕복 한도에 닿으면 tool_choice=none 으로 정리시키고 다음 단계로 간다', async () => {
    const { steps, detail } = await run('[도구한도] 끝없이 #loop');
    expect(steps.filter((s) => s.type === 'tool')).toHaveLength(6);
    const work = workRequests('#loop');
    expect(work).toHaveLength(7);
    expect(work.at(-1)!.body).toMatchObject({ tool_choice: 'none' });
    expect(offeredTools(work.at(-1)!)).toContain('builtin__calculate');
    expect(steps.find((s) => s.name === 'executor.tool')!.output).toMatchObject({ toolCalls: 6 });
    expect(detail.status).toBe('completed');
  });

  it('[대량계산] 한 응답에 여러 호출을 몰아도 단계당 12번까지만 실행하고, 넘친 호출은 not_run 으로 알려 정리한다', async () => {
    const { steps, detail } = await run('[대량계산] 열마다 합계 #bulk');
    expect(steps.filter((s) => s.type === 'tool')).toHaveLength(12);
    const wrapUp = workRequests('#bulk').at(-1)!;
    expect(wrapUp.body).toMatchObject({ tool_choice: 'none' });
    const notRun = wrapUp.body.messages.filter(
      (m) => m.role === 'tool' && m.content?.includes('"not_run"'),
    );
    expect(notRun).toHaveLength(4);
    expect(detail.status).toBe('completed');
  });

  it('작업 단계 상한이 가까우면 실패하지 않고 남은 몫(답변 · 검증)을 남긴 채 Tool 을 멈춘다', async () => {
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
            maxSteps: 12,
          },
        },
      }),
    );
    try {
      const { steps, detail } = await run('[대량계산] 상한 가까이 #budget');
      // context · plan · 작업 단계 뒤 남은 9 단계 중 답변 몫 5 를 남기고 4 번만 실행
      expect(steps.filter((s) => s.type === 'tool')).toHaveLength(4);
      expect(steps.map((s) => s.name)).toEqual(
        expect.arrayContaining(['evaluator.assess', 'executor.respond', 'evaluator.verify']),
      );
      expect(detail.status).toBe('completed');
    } finally {
      await tenantRows((tx) =>
        tx.agentVersion.update({
          where: { id: versionId },
          data: { executionPolicy: original.executionPolicy ?? {} },
        }),
      );
    }
  });

  it('reason 단계에는 Tool 을 주지 않는다 (계획에서 Tool 없는 분석으로 정한 단계)', async () => {
    const { detail } = await run('[분석] 첨부 내용 요약 #reason');
    const work = workRequests('#reason');
    expect(work).toHaveLength(1);
    expect(offeredTools(work[0]!)).toEqual([]);
    expect(detail.status).toBe('completed');
  });
});

describe('Tool 호출 거부', () => {
  it('[무단] Registry 에 없는 Tool 은 unknown_tool 로 거부 · 기록하고 작업은 계속한다', async () => {
    const { events, steps, executions, detail } = await run('[무단] 비밀번호 파일 #unknown');
    expect(toolEvents(events, 'tool.denied')).toEqual([
      expect.objectContaining({ toolName: 'shell__exec', reason: 'unknown_tool' }),
    ]);
    expect(toolEvents(events, 'tool.called')).toHaveLength(0);
    expect(steps.find((s) => s.type === 'tool')).toMatchObject({
      name: 'shell__exec',
      status: 'skipped',
    });
    expect(executions).toEqual([
      expect.objectContaining({
        toolName: 'shell__exec',
        status: 'denied',
        deniedReason: 'unknown_tool',
      }),
    ]);
    expect(workRequests('#unknown')[1]!.body.messages.at(-1)!.content).toContain('UNKNOWN_TOOL');
    expect(detail.status).toBe('completed');
  });

  it('[규칙차단] 인자 조건 규칙(block)에 걸리면 blocked_by_rule, 일치한 규칙을 남긴다', async () => {
    const rule = await tenantRows((tx) =>
      tx.toolPolicyRule.create({
        data: {
          tenantId: ctx.tenantA.tenantId,
          name: '666 계산 금지',
          toolPattern: 'builtin.*',
          condition: { arg: 'expression', op: 'contains', value: '666' },
          effect: 'block',
          priority: 10,
        },
      }),
    );
    const { events, executions } = await run('[규칙차단] 666 더하기 1 #rule');
    expect(toolEvents(events, 'tool.denied')).toEqual([
      expect.objectContaining({ toolName: 'builtin.calculate', reason: 'blocked_by_rule' }),
    ]);
    expect(executions[0]).toMatchObject({
      status: 'denied',
      deniedReason: 'blocked_by_rule',
      output: { matchedRuleIds: [rule.id] },
    });
  });
});

describe('Registry 버전 · 승인 · 재시도 · 시간 제한', () => {
  const sentNotes: unknown[] = [];
  let flakyCalls = 0;

  beforeAll(() => {
    const catalog = ctx.app.get(BuiltinToolCatalog);
    catalog.register({
      name: 'test.send_note',
      description: '담당자에게 메모를 보낸다',
      level: 'write',
      idempotent: false,
      input: z.object({ to: z.string(), text: z.string() }),
      execute: async (args) => {
        sentNotes.push(args);
        return { sent: true };
      },
    });
    catalog.register({
      name: 'test.flaky',
      description: '가끔 실패하는 조회',
      level: 'read',
      idempotent: true,
      input: z.object({ key: z.string() }),
      execute: async ({ key }) => {
        flakyCalls++;
        if (flakyCalls === 1) throw new Error('일시적 오류');
        return { key, value: 42 };
      },
    });
    catalog.register({
      name: 'test.slow',
      description: '느린 조회',
      level: 'read',
      idempotent: false,
      timeoutMs: 100,
      input: z.object({}),
      execute: (_args, { signal }) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve({ done: true }), 5_000);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(signal.reason as Error);
          });
        }),
    });
  });

  it('내장 Tool 구성이 바뀌면 새 Registry 버전 — 이전 작업의 버전은 그대로, 승인 필요 Tool 은 표시와 함께 보인다', async () => {
    const { task, detail } = await run('[도구] 1234 곱하기 5678 #registry');

    // 새 버전 고정 · 이전 버전은 불변
    expect(task.registryVersionId).not.toBe(builtinOnlyVersion);
    const latest = await tenantRows((tx) =>
      tx.toolRegistryVersion.findUniqueOrThrow({ where: { id: task.registryVersionId } }),
    );
    expect(latest.changeSummary).toMatchObject({
      reason: 'builtin_tools_changed',
      added: ['test.flaky', 'test.send_note', 'test.slow'],
      removed: [],
    });
    const registry = ctx.app.get(ToolRegistryService);
    const before = await registry.loadToolset(ctx.tenantA.tenantId, builtinOnlyVersion);
    const after = await registry.loadToolset(ctx.tenantA.tenantId, task.registryVersionId);
    expect(before.tools.map((t) => t.name)).toEqual([
      'builtin.calculate',
      'builtin.create_file',
      'builtin.current_time',
      'builtin.query_table',
      'skill.read_file',
    ]);
    expect(after.tools.map((t) => t.name)).toContain('test.send_note');

    // 승인 필요 Tool 은 계획 · 작업 단계에 “승인 필요” 표시와 함께 보인다 (승인 흐름은 approvals.e2e-spec.ts)
    expect(
      requestsFor('#registry').find((r) => r.role === 'Planner')!.body.messages[0]!.content,
    ).toContain('test__send_note (write, requires approval)');
    const offered = workRequests('#registry')[0]!.body.tools!.find(
      (t) => t.function.name === 'test__send_note',
    )!;
    expect(offered.function.description).toContain('Requires approval');
    expect(sentNotes).toHaveLength(0);
    expect(detail.status).toBe('completed');
  });

  it('[재시도] 멱등 Tool 은 실패하면 실행 정책(toolRetry)대로 다시 시도한다', async () => {
    const { events, executions } = await run('[재시도] 재고 알려줘 #retry');
    expect(flakyCalls).toBe(2);
    expect(toolEvents(events, 'tool.result')).toEqual([
      expect.objectContaining({ toolName: 'test.flaky', status: 'succeeded', attempt: 2 }),
    ]);
    expect(executions[0]).toMatchObject({ status: 'succeeded', attempt: 2, output: { value: 42 } });
  });

  it('[시간초과] 시간 제한을 넘기면 timeout 으로 기록하고 모델에게 알린다', async () => {
    const { events, executions, detail } = await run('[시간초과] 느린 조회 #slow');
    expect(toolEvents(events, 'tool.result')).toEqual([
      expect.objectContaining({ toolName: 'test.slow', status: 'timeout', attempt: 1 }),
    ]);
    expect(executions[0]).toMatchObject({ status: 'timeout', errorCode: 'TOOL_TIMEOUT' });
    expect(workRequests('#slow')[1]!.body.messages.at(-1)!.content).toContain('TOOL_TIMEOUT');
    expect(detail.status).toBe('completed');
  });

  it('등급 정책이 block 이면 모델에게 보이지 않고, 호출해도 blocked_by_policy 로 거부한다', async () => {
    await tenantRows((tx) =>
      tx.toolPolicy.update({
        where: { tenantId_level: { tenantId: ctx.tenantA.tenantId, level: 'write' } },
        data: { mode: 'block' },
      }),
    );
    const { events, steps, executions } = await run('[승인필요] 막힌 메모 #blocked');
    expect(offeredTools(workRequests('#blocked')[0]!)).not.toContain('test__send_note');
    expect(steps.find((s) => s.name === 'context.build')!.output).toMatchObject({
      tools: expect.not.arrayContaining([expect.objectContaining({ name: 'test__send_note' })]),
    });
    expect(toolEvents(events, 'tool.denied')).toEqual([
      expect.objectContaining({ toolName: 'test.send_note', reason: 'blocked_by_policy' }),
    ]);
    expect(executions[0]).toMatchObject({ status: 'denied', deniedReason: 'blocked_by_policy' });
    expect(sentNotes).toHaveLength(0);
  });
});
