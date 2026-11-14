import { z } from 'zod';
import { BuiltinToolCatalog } from '../src/tools/builtin-tool.catalog.js';
import { ApprovalExpiryService } from '../src/workers/approval-expiry.service.js';
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
} from './helpers.js';

interface ApprovalBody {
  id: string;
  taskId: string;
  toolName: string;
  status: string;
  requiredApprover: string;
  allowTaskScope: boolean;
  riskLevel: string;
  waitingFor: string | null;
  args: Array<{ label: string; value: string }>;
  summary: string;
}

let ctx: TestContext;
let token: string;
let otherToken: string;
let ownerToken: string;
let adminToken: string;
let viewerToken: string;
const sentNotes: Array<{ to: string; text: string }> = [];

beforeAll(async () => {
  ctx = await startTestApp();
  token = await startSession(ctx.baseUrl, ctx.widgets.A, 'approval-user');
  otherToken = await startSession(ctx.baseUrl, ctx.widgets.A, 'approval-other');
  ownerToken = await adminLogin(ctx.baseUrl, ctx.slugs.A, CONSOLE_MEMBERS.owner);
  adminToken = await adminLogin(ctx.baseUrl, ctx.slugs.A, CONSOLE_MEMBERS.admin);
  viewerToken = await adminLogin(ctx.baseUrl, ctx.slugs.A, CONSOLE_MEMBERS.viewer);
  ctx.app.get(BuiltinToolCatalog).register({
    name: 'test.send_note',
    description: '담당자에게 메모를 보낸다. 받는 사람 주소와 내용이 필요하다.',
    level: 'write',
    idempotent: false,
    input: z.object({ to: z.string(), text: z.string() }),
    execute: async (args) => {
      sentNotes.push(args as { to: string; text: string });
      return { sent: true };
    },
  });
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

const decide = (id: string, body: unknown, tkn = token) =>
  api<ApprovalBody & { code?: string }>(ctx.baseUrl, 'POST', `/v1/approvals/${id}/decision`, {
    token: tkn,
    body,
  });

async function tenantRows<T>(fn: (tx: TestContext['owner']) => Promise<T>) {
  return ctx.owner.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${ctx.tenantA.tenantId}, true)`;
    return fn(tx as unknown as TestContext['owner']);
  });
}

const isStatus = (status: string) => (e: SseEvent) =>
  e.event === 'task.status' && (e.data as { status: string }).status === status;

/** 작업 하나의 SSE — 승인 대기에서 멈추고, 결정 뒤에는 이어서 읽는다 */
class Run {
  events: SseEvent[] = [];
  constructor(
    readonly taskId: string,
    private readonly url: string,
  ) {}

  static async start(text: string, tkn = token): Promise<Run> {
    const conv = (
      await api<{ id: string }>(ctx.baseUrl, 'POST', '/v1/conversations', {
        token: tkn,
        body: {},
      })
    ).body.id;
    const sent = await api<{ task: { id: string }; eventsUrl: string }>(
      ctx.baseUrl,
      'POST',
      `/v1/conversations/${conv}/messages`,
      { token: tkn, body: { content: [{ type: 'text', text }] } },
    );
    expect(sent.status).toBe(202);
    return new Run(sent.body.task.id, `${ctx.baseUrl}${sent.body.eventsUrl}`);
  }

  /** 다음 승인 대기까지 — 새 승인 요청을 돌려준다 */
  async waiting(): Promise<ApprovalBody> {
    const before = this.approvals().length;
    await this.read(isStatus('waiting_approval'));
    const approvals = this.approvals();
    expect(approvals.length).toBe(before + 1);
    return approvals.at(-1)!;
  }

  /** 끝(완료 · 실패 · 중지)까지 또는 조건까지 */
  async read(until?: (e: SseEvent) => boolean): Promise<SseEvent[]> {
    const lastEventId = this.events.at(-1)?.id ?? undefined;
    const fresh = await readSse(this.url, token, { lastEventId, until, timeoutMs: 15_000 });
    this.events.push(...fresh);
    return fresh;
  }

  approvals(): ApprovalBody[] {
    return this.events
      .filter((e) => e.event === 'approval.required')
      .map((e) => (e.data as { approval: ApprovalBody }).approval);
  }

  of(type: string): unknown[] {
    return this.events.filter((e) => e.event === type).map((e) => e.data);
  }

  rows() {
    return tenantRows(
      async (tx) =>
        [
          await tx.task.findUniqueOrThrow({ where: { id: this.taskId } }),
          await tx.taskStep.findMany({ where: { taskId: this.taskId }, orderBy: { seq: 'asc' } }),
          await tx.toolExecution.findMany({
            where: { taskId: this.taskId },
            orderBy: { startedAt: 'asc' },
          }),
          await tx.approval.findMany({
            where: { taskId: this.taskId },
            orderBy: { createdAt: 'asc' },
          }),
        ] as const,
    );
  }
}

const workRequests = (tag: string): RecordedRequest[] =>
  ctx.llm.requests.filter(
    (r) => r.role === 'Agent' && r.body.messages.some((m) => (m.content ?? '').includes(tag)),
  );

describe('승인 흐름 (W-03)', () => {
  it('승인 필요 Tool 을 부르면 승인 요청 → waiting_approval, 승인하면 같은 호출(같은 인자)부터 이어서 완료', async () => {
    const run = await Run.start('[승인필요] 메모 보내줘 #ap-once');
    const approval = await run.waiting();
    expect(approval).toMatchObject({
      toolName: 'test.send_note',
      status: 'pending',
      requiredApprover: 'user',
      allowTaskScope: true,
      riskLevel: 'medium',
      waitingFor: 'user',
      summary: '담당자에게 메모를 보낸다.',
      args: [
        { label: 'to', value: 'ops@example.com' },
        { label: 'text', value: '안녕하세요' },
      ],
    });
    expect(sentNotes.filter((n) => n.text === '안녕하세요')).toHaveLength(0);

    // 작업 · 단계 상태
    const detail = await api<{ status: string; pendingApproval: ApprovalBody }>(
      ctx.baseUrl,
      'GET',
      `/v1/tasks/${run.taskId}`,
      { token },
    );
    expect(detail.body.status).toBe('waiting_approval');
    expect(detail.body.pendingApproval).toMatchObject({ id: approval.id, status: 'pending' });
    const [task, steps] = await run.rows();
    const work = steps.find((s) => s.name === 'agent.turn')!;
    expect(work).toMatchObject({ status: 'waiting_approval' });
    expect(task.lastCheckpointStepId).toBe(work.id);
    expect(task.workerId).toBeNull();
    expect(steps.find((s) => s.name === 'test.send_note')!.status).toBe('waiting_approval');

    // 다른 사용자는 결정할 수 없다
    expect((await decide(approval.id, { decision: 'approve' }, otherToken)).status).toBe(404);

    const res = await decide(approval.id, { decision: 'approve' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'approved', waitingFor: null });
    await run.read();

    expect(run.of('approval.resolved')).toEqual([
      { approvalId: approval.id, status: 'approved', decidedBy: 'user' },
    ]);
    expect(run.of('task.status')).toEqual(
      expect.arrayContaining([
        { status: 'queued', reason: 'approval_resolved' },
        { status: 'running', reason: 'resumed' },
      ]),
    );
    expect(run.events.at(-1)!.event).toBe('task.completed');
    expect(sentNotes.filter((n) => n.text === '안녕하세요')).toEqual([
      { to: 'ops@example.com', text: '안녕하세요' },
    ]);

    // 모델을 다시 부르지 않고 멈췄던 호출부터: Agent 요청은 호출 1번 + 결과 뒤 답변 1번
    const requests = workRequests('#ap-once');
    expect(requests).toHaveLength(2);
    expect(requests[1]!.body.messages.at(-1)).toMatchObject({ role: 'tool' });
    expect(requests[1]!.body.messages.at(-1)!.content).toContain('"ok":true');

    const [, after, executions, approvals] = await run.rows();
    expect(executions).toEqual([
      expect.objectContaining({
        toolName: 'test.send_note',
        status: 'succeeded',
        approvalId: approval.id,
      }),
    ]);
    expect(approvals[0]!.consumedAt).not.toBeNull();
    expect(
      after.find((s) => s.id === steps.find((x) => x.name === 'test.send_note')!.id),
    ).toMatchObject({
      status: 'succeeded',
      summary: '승인됨',
    });
    expect(after.find((s) => s.id === work.id)!.status).toBe('skipped');
    expect(after.filter((s) => s.status === 'waiting_approval')).toHaveLength(0);

    // 이미 처리한 승인
    const again = await decide(approval.id, { decision: 'reject' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('APPROVAL_ALREADY_RESOLVED');
  });

  it('거절하면 실행하지 않고, 거절 사유를 모델에게 데이터로 알린다', async () => {
    const run = await Run.start('[승인필요] 메모 보내줘 #ap-reject');
    const approval = await run.waiting();
    const res = await decide(approval.id, {
      decision: 'reject',
      comment: '지금은 보내지 마세요. 다음 주에 다시',
    });
    expect(res.body.status).toBe('rejected');
    await run.read();
    expect(run.events.at(-1)!.event).toBe('task.completed');
    expect(run.of('tool.denied')).toEqual([
      expect.objectContaining({ toolName: 'test.send_note', reason: 'approval_rejected' }),
    ]);
    const toolMessage = workRequests('#ap-reject')[1]!.body.messages.at(-1)!.content!;
    expect(toolMessage).toContain('APPROVAL_REJECTED');
    expect(toolMessage).toContain('지금은 보내지 마세요. 다음 주에 다시');
    const [, , executions] = await run.rows();
    expect(executions).toEqual([
      expect.objectContaining({
        status: 'denied',
        deniedReason: 'approval_rejected',
        approvalId: approval.id,
      }),
    ]);
  });

  it('“이 작업 동안 다시 묻지 않기”(task 범위)면 같은 Tool 의 다음 호출은 묻지 않는다', async () => {
    const before = sentNotes.length;
    const run = await Run.start('[승인두번] 메모 두 개 #ap-task');
    const approval = await run.waiting();
    await decide(approval.id, { decision: 'approve', scope: 'task' });
    await run.read();
    expect(run.events.at(-1)!.event).toBe('task.completed');
    expect(sentNotes.slice(before)).toEqual([
      { to: 'a@example.com', text: '첫 메모' },
      { to: 'b@example.com', text: '두 번째 메모' },
    ]);
    const [, , executions, approvals] = await run.rows();
    expect(approvals).toHaveLength(1);
    expect(executions.map((e) => e.approvalId)).toEqual([approval.id, approval.id]);
  });

  it('한 응답의 읽기 + 쓰기 호출: 읽기는 먼저 실행되고, 재개 때 다시 실행하지 않는다', async () => {
    const run = await Run.start('[승인혼합] 합계를 메모로 #ap-mixed');
    const approval = await run.waiting();
    const [, , beforeExecutions] = await run.rows();
    expect(beforeExecutions.map((e) => [e.toolName, e.status])).toEqual([
      ['builtin.calculate', 'succeeded'],
    ]);
    await decide(approval.id, { decision: 'approve' });
    await run.read();
    const [, , executions] = await run.rows();
    expect(executions.map((e) => [e.toolName, e.status])).toEqual([
      ['builtin.calculate', 'succeeded'],
      ['test.send_note', 'succeeded'],
    ]);
    // 모델에게는 호출 순서대로 두 결과
    const messages = workRequests('#ap-mixed')[1]!.body.messages;
    const tools = messages.filter((m) => m.role === 'tool');
    expect(tools).toHaveLength(2);
    expect(tools[0]!.content).toContain('"result":5');
    expect(tools[1]!.content).toContain('"sent":true');
  });

  it('승인 대기 checkpoint 에는 이어진 대화(Tool 호출 · 결과)만 남고, 재개할 때 지침 · 요청을 다시 만든다', async () => {
    const run = await Run.start('[승인혼합] 합계를 메모로 #ap-checkpoint');
    const approval = await run.waiting();
    const [task, steps] = await run.rows();
    const checkpoint = steps.find((s) => s.id === task.lastCheckpointStepId)!.checkpoint as {
      workingMemory: {
        loop: {
          messages: Array<{ role: string }>;
          pending: { results: Array<string | null> };
        };
      };
    };
    const saved = JSON.stringify(checkpoint);
    expect(saved).not.toContain('## Platform rules');
    expect(saved).not.toContain('테넌트 A의 고객지원 에이전트');
    expect(saved).not.toContain('합계를 메모로');
    expect(checkpoint.workingMemory.loop.messages.map((m) => m.role)).toEqual(['assistant']);
    // 읽기 호출은 끝났고(결과 저장), 승인을 기다리는 쓰기 호출만 남았다
    expect(checkpoint.workingMemory.loop.pending.results[0]).toContain('"result":5');
    expect(checkpoint.workingMemory.loop.pending.results[1]).toBeNull();

    await decide(approval.id, { decision: 'approve' });
    await run.read();
    expect(run.events.at(-1)!.event).toBe('task.completed');
    const resumed = workRequests('#ap-checkpoint')[1]!.body.messages;
    expect(resumed.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'tool']);
    expect(resumed[0]!.content).toContain('## Platform rules');
    expect(resumed[1]!.content).toContain('[승인혼합] 합계를 메모로 #ap-checkpoint');
  });

  it('작업을 중지하면 대기 중인 승인도 취소된다', async () => {
    const run = await Run.start('[승인필요] 메모 #ap-cancel');
    const approval = await run.waiting();
    const res = await api(ctx.baseUrl, 'POST', `/v1/tasks/${run.taskId}/cancel`, { token });
    expect(res.status).toBe(202);
    await run.read();
    expect(run.of('approval.resolved')).toEqual([
      { approvalId: approval.id, status: 'cancelled', decidedBy: 'system' },
    ]);
    const [task, steps, , approvals] = await run.rows();
    expect(task.status).toBe('cancelled');
    expect(approvals[0]!.status).toBe('cancelled');
    expect(steps.filter((s) => s.status === 'waiting_approval')).toHaveLength(0);
    expect((await decide(approval.id, { decision: 'approve' })).status).toBe(409);
  });
});

describe('승인 만료 (approval-expiry)', () => {
  it('만료되면 expired · 작업 paused → 재개하면 같은 호출로 새 승인을 요청한다', async () => {
    const before = sentNotes.length;
    const run = await Run.start('[승인필요] 메모 #ap-expire');
    const first = await run.waiting();
    await tenantRows((tx) =>
      tx.approval.update({
        where: { id: first.id },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      }),
    );
    expect(await ctx.app.get(ApprovalExpiryService).tick()).toBe(1);
    await run.read(isStatus('paused'));
    expect(run.of('approval.resolved')).toEqual([
      { approvalId: first.id, status: 'expired', decidedBy: 'system' },
    ]);
    const [task] = await run.rows();
    expect(task).toMatchObject({ status: 'paused', pausedReason: 'approval_expired' });
    expect((await decide(first.id, { decision: 'approve' })).status).toBe(409);

    // 재개 → 같은 Tool 호출 → 새 승인
    const resumed = await api(ctx.baseUrl, 'POST', `/v1/tasks/${run.taskId}/resume`, {
      token,
      body: {},
    });
    expect(resumed.status).toBe(202);
    const second = await run.waiting();
    expect(second.id).not.toBe(first.id);
    expect(second.args).toEqual(first.args);

    // 만료 직후(주기 잡 전)에 결정하면 410 — 만료 처리는 그대로 남는다
    await tenantRows((tx) =>
      tx.approval.update({
        where: { id: second.id },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      }),
    );
    const late = await decide(second.id, { decision: 'approve' });
    expect(late.status).toBe(410);
    expect(late.body.code).toBe('APPROVAL_EXPIRED');
    await run.read(isStatus('paused'));
    expect(await ctx.app.get(ApprovalExpiryService).tick()).toBe(0);

    await api(ctx.baseUrl, 'POST', `/v1/tasks/${run.taskId}/resume`, { token, body: {} });
    const third = await run.waiting();
    await decide(third.id, { decision: 'approve' });
    await run.read();
    expect(run.events.at(-1)!.event).toBe('task.completed');
    expect(sentNotes.length - before).toBe(1);
  });
});

describe('운영자 승인 · 권한 정책 (C-07)', () => {
  let policiesBefore: Array<Record<string, unknown>>;

  beforeAll(async () => {
    policiesBefore = (await admin<Array<Record<string, unknown>>>('GET', '/tool-policies')).body;
  });

  afterEach(async () => {
    // 정책을 테스트 전 상태로
    await admin('PUT', '/tool-policies', {
      policies: policiesBefore
        .filter((p) => !p.isDefault)
        .map(({ level, mode, approver, allowTaskScope, ttlSeconds }) => ({
          level,
          mode,
          approver,
          allowTaskScope,
          ttlSeconds,
        })),
    });
  });

  it('조건 규칙(require_operator) — 사용자 승인 뒤에도 운영자를 기다리고, 운영자가 사유와 함께 승인하면 이어서 실행', async () => {
    const rule = await admin<{ id: string }>('POST', '/tool-policy-rules', {
      name: '외부 도메인 메모',
      toolPattern: 'test.send_note',
      condition: { argDomainNotIn: 'to', domains: ['example.com'] },
      effect: 'require_operator',
    });
    expect(rule.status).toBe(201);

    const run = await Run.start('[운영자승인] 파트너에게 메모 #ap-operator');
    const approval = await run.waiting();
    expect(approval).toMatchObject({
      requiredApprover: 'user_and_operator',
      riskLevel: 'high',
      allowTaskScope: false,
    });
    // 규칙 때문에 생긴 승인은 task 범위 불가
    const scoped = await decide(approval.id, { decision: 'approve', scope: 'task' });
    expect(scoped.status).toBe(422);
    expect(scoped.body.code).toBe('APPROVAL_SCOPE_NOT_ALLOWED');

    const byUser = await decide(approval.id, { decision: 'approve' });
    expect(byUser.body).toMatchObject({ status: 'pending', waitingFor: 'operator' });
    await run.read((e) => e.event === 'approval.updated');
    expect((await decide(approval.id, { decision: 'approve' })).status).toBe(409);

    // 콘솔 목록 — 위험도 · 만료 순, 작업 · 사용자 정보
    const pending = await admin<{ items: Array<Record<string, unknown>> }>('GET', '/approvals');
    expect(pending.body.items[0]).toMatchObject({
      id: approval.id,
      taskTitle: expect.any(String),
      endUserPseudonym: expect.any(String),
      user: { decision: 'approve', comment: null, at: expect.any(String) },
      operator: null,
    });

    // Viewer 는 결정 불가, 사유는 필수
    expect(
      (
        await admin(
          'POST',
          `/approvals/${approval.id}/decision`,
          { decision: 'approve', comment: '확인' },
          viewerToken,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await admin(
          'POST',
          `/approvals/${approval.id}/decision`,
          { decision: 'approve' },
          adminToken,
        )
      ).status,
    ).toBe(400);
    const byOperator = await admin<ApprovalBody>(
      'POST',
      `/approvals/${approval.id}/decision`,
      { decision: 'approve', comment: '파트너 계약 건 확인함' },
      adminToken,
    );
    expect(byOperator.body.status).toBe('approved');
    await run.read();
    expect(run.events.at(-1)!.event).toBe('task.completed');
    expect(run.of('approval.resolved')).toEqual([
      { approvalId: approval.id, status: 'approved', decidedBy: 'operator' },
    ]);
    expect(sentNotes.at(-1)).toEqual({ to: 'ceo@partner.external.com', text: '계약 안내' });

    const history = await admin<{ items: Array<Record<string, unknown>> }>(
      'GET',
      '/approvals/history',
    );
    expect(history.body.items[0]).toMatchObject({
      id: approval.id,
      status: 'approved',
      operator: { decision: 'approve', comment: '파트너 계약 건 확인함', memberName: 'Admin' },
    });
    const audit = await tenantRows((tx) =>
      tx.auditLog.findFirst({ where: { action: 'approval.approve', targetId: approval.id } }),
    );
    expect(audit).toMatchObject({
      metadata: expect.objectContaining({ comment: '파트너 계약 건 확인함' }),
    });

    expect((await admin('DELETE', `/tool-policy-rules/${rule.body.id}`)).status).toBe(204);
  });

  it('운영자 전용 승인은 사용자가 결정할 수 없다 (FORBIDDEN_APPROVER) · 운영자가 거절하면 실행하지 않는다', async () => {
    await admin('PUT', '/tool-policies', {
      policies: [{ level: 'write', mode: 'require_approval', approver: 'operator' }],
    });
    const run = await Run.start('[승인필요] 메모 #ap-operator-only');
    const approval = await run.waiting();
    expect(approval).toMatchObject({ requiredApprover: 'operator', waitingFor: 'operator' });
    const byUser = await decide(approval.id, { decision: 'approve' });
    expect(byUser.status).toBe(403);
    expect(byUser.body.code).toBe('FORBIDDEN_APPROVER');
    await admin(
      'POST',
      `/approvals/${approval.id}/decision`,
      { decision: 'reject', comment: '불필요한 메모' },
      adminToken,
    );
    await run.read();
    expect(run.of('tool.denied')).toEqual([
      expect.objectContaining({ reason: 'approval_rejected' }),
    ]);
    expect(workRequests('#ap-operator-only')[1]!.body.messages.at(-1)!.content).toContain(
      '불필요한 메모',
    );
  });

  it('정책 강화는 실행 중 작업에도 바로 — 승인 대기 중 쓰기를 차단하면 승인해도 실행하지 않는다', async () => {
    const run = await Run.start('[승인필요] 메모 #ap-tighten');
    const approval = await run.waiting();
    await admin('PUT', '/tool-policies', {
      policies: policiesBefore
        .filter((p) => !p.isDefault)
        .map((p) =>
          p.level === 'write'
            ? { level: 'write', mode: 'block' }
            : {
                level: p.level,
                mode: p.mode,
                approver: p.approver,
                allowTaskScope: p.allowTaskScope,
                ttlSeconds: p.ttlSeconds,
              },
        ),
    });
    await decide(approval.id, { decision: 'approve' });
    await run.read();
    expect(run.of('tool.denied')).toEqual([
      expect.objectContaining({ toolName: 'test.send_note', reason: 'blocked_by_policy' }),
    ]);
    expect(sentNotes.some((n) => JSON.stringify(n).includes('ap-tighten'))).toBe(false);
  });

  it('정책 완화는 새 작업부터 — 대기 중에 자동 실행으로 바꿔도 이 작업의 다음 호출은 다시 묻는다', async () => {
    const run = await Run.start('[승인두번] 메모 두 개 #ap-relax');
    const first = await run.waiting();
    await admin('PUT', '/tool-policies', {
      policies: [
        { level: 'read', mode: 'auto' },
        { level: 'write', mode: 'auto' },
      ],
    });
    await decide(first.id, { decision: 'approve' }); // once
    const second = await run.waiting();
    expect(second.args).toEqual([
      { label: 'to', value: 'b@example.com' },
      { label: 'text', value: '두 번째 메모' },
    ]);
    await decide(second.id, { decision: 'approve' });
    await run.read();
    expect(run.events.at(-1)!.event).toBe('task.completed');

    // 새 작업은 완화된 정책 그대로 (승인 없이 실행)
    const fresh = await Run.start('[승인필요] 메모 #ap-relaxed-new');
    await fresh.read();
    expect(fresh.approvals()).toHaveLength(0);
    expect(fresh.events.at(-1)!.event).toBe('task.completed');
  });

  it('등급 정책 조회 · 교체 — 빠진 등급은 기본값, delete · financial 은 task 범위 불가 · 감사 로그', async () => {
    const res = await admin<
      Array<{ level: string; mode: string; allowTaskScope: boolean; isDefault: boolean }>
    >('PUT', '/tool-policies', {
      policies: [
        {
          level: 'write',
          mode: 'require_approval',
          approver: 'user',
          allowTaskScope: true,
          ttlSeconds: 600,
        },
        { level: 'delete', mode: 'require_approval', allowTaskScope: true },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.find((p) => p.level === 'delete')).toMatchObject({
      allowTaskScope: false,
      isDefault: false,
    });
    expect(res.body.find((p) => p.level === 'read')).toMatchObject({
      mode: 'auto',
      isDefault: true,
    });
    expect(res.body.find((p) => p.level === 'financial')).toMatchObject({
      mode: 'always_approval',
      isDefault: true,
    });
    expect(
      (
        await admin('PUT', '/tool-policies', {
          policies: [
            { level: 'write', mode: 'auto' },
            { level: 'write', mode: 'block' },
          ],
        })
      ).status,
    ).toBe(400);
    expect((await admin('PUT', '/tool-policies', { policies: [] }, viewerToken)).status).toBe(403);
    expect(
      await tenantRows((tx) => tx.auditLog.count({ where: { action: 'tool_policy.update' } })),
    ).toBeGreaterThan(0);

    // 조건 규칙 검증 · 수정
    const bad = await admin('POST', '/tool-policy-rules', {
      name: '잘못된 규칙',
      condition: { arg: 'amount', op: 'gt', value: 10 },
      effect: 'block',
    });
    expect(bad.status).toBe(400); // toolPattern · level 둘 다 없음
    const rule = await admin<{ id: string; enabled: boolean }>('POST', '/tool-policy-rules', {
      name: '큰 금액 환불',
      toolPattern: 'payment.*',
      condition: { arg: 'amount', op: 'gt', value: 100000 },
      effect: 'require_operator',
      priority: 10,
    });
    const patched = await admin<{ enabled: boolean }>(
      'PATCH',
      `/tool-policy-rules/${rule.body.id}`,
      { enabled: false },
    );
    expect(patched.body.enabled).toBe(false);
    const rules = await admin<Array<{ id: string }>>(
      'GET',
      '/tool-policy-rules',
      undefined,
      viewerToken,
    );
    expect(rules.body.map((r) => r.id)).toContain(rule.body.id);
    await admin('DELETE', `/tool-policy-rules/${rule.body.id}`);
  });
});
