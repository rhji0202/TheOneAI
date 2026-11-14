import { createHash } from 'node:crypto';
import { seedTenant } from '../prisma/seed.js';
import { hashPassword } from '../src/admin/auth/password.js';
import {
  adminLogin,
  api,
  CONSOLE_MEMBERS,
  identityToken,
  readSse,
  type SseEvent,
  startSession,
  startTestApp,
  type TestContext,
} from './helpers.js';
import { buildXlsx } from './document-fixtures.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

let ctx: TestContext;
let token: string;
let otherToken: string;
let ownerToken: string;
let adminToken: string;
let viewerToken: string;

beforeAll(async () => {
  ctx = await startTestApp();
  token = await startSession(ctx.baseUrl, ctx.widgets.A, 'screens-user');
  otherToken = await startSession(ctx.baseUrl, ctx.widgets.A, 'screens-other');
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
) => api<T & { code?: string }>(ctx.baseUrl, method, `/v1/admin${path}`, { token: tkn, body });

async function send(text: string, content?: unknown[]) {
  const conv = (
    await api<{ id: string }>(ctx.baseUrl, 'POST', '/v1/conversations', { token, body: {} })
  ).body.id;
  const sent = await api<{ task: { id: string }; eventsUrl: string; code?: string }>(
    ctx.baseUrl,
    'POST',
    `/v1/conversations/${conv}/messages`,
    { token, body: { content: content ?? [{ type: 'text', text }] } },
  );
  if (sent.status !== 202) return { status: sent.status, code: sent.body.code };
  const events = await readSse(`${ctx.baseUrl}${sent.body.eventsUrl}`, token);
  return { status: 202, events, taskId: sent.body.task.id, conversationId: conv };
}

interface AgentView {
  id: string;
  published: {
    version: number;
    systemPrompt: string;
    models: Array<{ role: string; model: string }>;
  };
  draft: {
    version: number;
    systemPrompt: string;
    welcomeMessage: string;
    executionPolicy: { replanLimit: number; tokenBudget: number; maxSteps: number };
    memoryPolicy: { retentionDays: number; topK: number };
    models: Array<{ role: string; model: string; providerName: string; maxOutputTokens: number }>;
  } | null;
}

describe('Agent 설정 (C-03)', () => {
  it('지침 · 환영 메시지 · 역할별 모델 · 실행 · Memory 정책을 초안에서 고치고 배포한다', async () => {
    const agentId = ctx.tenantA.agentId;
    const providers = await admin<Array<{ id: string; name: string; kind: string }>>(
      'GET',
      '/providers',
      undefined,
      viewerToken,
    );
    expect(providers.body).toEqual([
      expect.objectContaining({ name: 'fake-deepseek', kind: 'deepseek' }),
    ]);
    const providerId = providers.body[0]!.id;

    const patched = await admin<AgentView>(
      'PATCH',
      `/agents/${agentId}/draft`,
      {
        systemPrompt: '당신은 테스트 쇼핑몰의 상담원입니다.',
        welcomeMessage: '무엇을 도와드릴까요?',
        executionPolicy: { maxSteps: 30, tokenBudget: 150_000 },
        memoryPolicy: { retentionDays: 30 },
        models: [
          {
            role: 'executor',
            providerId,
            model: 'fake-executor',
            maxOutputTokens: 1_200,
            temperature: 0.2,
          },
        ],
      },
      adminToken,
    );
    expect(patched.status).toBe(200);
    expect(patched.body.draft).toMatchObject({
      systemPrompt: '당신은 테스트 쇼핑몰의 상담원입니다.',
      welcomeMessage: '무엇을 도와드릴까요?',
      executionPolicy: { maxSteps: 30, tokenBudget: 150_000, maxDurationSec: 1_800 },
      memoryPolicy: { retentionDays: 30, topK: 5 },
    });
    expect(
      patched.body.draft!.models.map((m) => [m.role, m.maxOutputTokens, m.providerName]),
    ).toEqual([['executor', 1_200, 'fake-deepseek']]);
    // 배포 버전은 그대로
    expect(patched.body.published.systemPrompt).not.toBe('당신은 테스트 쇼핑몰의 상담원입니다.');

    // 검증 — 정책 범위, executor 가 아닌 모델(planner · evaluator 는 없다), 모르는 필드, Viewer
    const bad = await admin('PATCH', `/agents/${agentId}/draft`, {
      executionPolicy: { maxSteps: 0 },
    });
    expect(bad.status).toBe(422);
    const noExecutor = await admin('PATCH', `/agents/${agentId}/draft`, {
      models: [{ role: 'planner', providerId, model: 'x', maxOutputTokens: 100 }],
    });
    expect(noExecutor.status).toBe(400);
    expect((await admin('PATCH', `/agents/${agentId}/draft`, { secret: 1 })).status).toBe(400);
    expect(
      (await admin('PATCH', `/agents/${agentId}/draft`, { welcomeMessage: 'x' }, viewerToken))
        .status,
    ).toBe(403);

    // 목록 — 초안이 있으면 배포 안 된 변경
    const listed = await admin<
      Array<{ id: string; publishedVersion: number; draftVersion: number | null }>
    >('GET', '/agents', undefined, viewerToken);
    const row = listed.body.find((a) => a.id === agentId)!;
    expect(row.draftVersion).toBe(row.publishedVersion + 1);

    const published = await admin<AgentView>('POST', `/agents/${agentId}/publish`, {
      changeNote: '지침 정리',
    });
    expect(published.body).toMatchObject({
      draft: null,
      published: { systemPrompt: '당신은 테스트 쇼핑몰의 상담원입니다.' },
    });
    // 위젯 bootstrap 이 새 환영 메시지를 쓴다
    const boot = await api<{ agent: { welcomeMessage: string } }>(
      ctx.baseUrl,
      'POST',
      '/v1/widget/bootstrap',
      {
        origin: ctx.widgets.A.origin,
        body: {
          publicKey: ctx.widgets.A.publicKey,
          identityToken: await identityToken(ctx.widgets.A, 'screens-user'),
        },
      },
    );
    expect(boot.body.agent.welcomeMessage).toBe('무엇을 도와드릴까요?');
  });

  it('버전 기록 · 이전 버전으로 되돌리기 · 초안 버리기', async () => {
    const agentId = ctx.tenantA.agentId;
    const versions = await admin<
      Array<{
        id: string;
        version: number;
        status: string;
        publishedBy: string | null;
        changeNote: string | null;
      }>
    >('GET', `/agents/${agentId}/versions`, undefined, viewerToken);
    expect(versions.body[0]).toMatchObject({
      status: 'published',
      changeNote: '지침 정리',
      publishedBy: 'Owner',
    });
    const first = versions.body.at(-1)!;
    const restored = await admin<AgentView>(
      'POST',
      `/agents/${agentId}/versions/${first.id}/restore`,
      {},
    );
    expect(restored.body.draft).not.toBeNull();
    expect(restored.body.draft!.systemPrompt).not.toBe('당신은 테스트 쇼핑몰의 상담원입니다.');
    const discarded = await admin<AgentView>('DELETE', `/agents/${agentId}/draft`);
    expect(discarded.body.draft).toBeNull();
    const after = await admin<Array<{ id: string; draftVersion: number | null }>>('GET', '/agents');
    expect(after.body.find((a) => a.id === agentId)!.draftVersion).toBeNull();
  });

  it('Agent 추가 · 삭제 — 새 Agent 는 초안 v1 만, 위젯이 쓰는 Agent 는 지울 수 없다', async () => {
    type Created = {
      id: string;
      name: string;
      published: unknown;
      draft: { version: number; status: string; welcomeMessage: string; models: unknown[] } | null;
    };
    const listIds = async () =>
      (await admin<Array<{ id: string }>>('GET', '/agents')).body.map((a) => a.id);

    expect((await admin('POST', '/agents', { name: '환불 도우미' }, viewerToken)).status).toBe(403);
    expect((await admin('POST', '/agents', { name: '  ' }, adminToken)).status).toBe(400);

    const created = await admin<Created>('POST', '/agents', { name: ' 환불 도우미 ' }, adminToken);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: '환불 도우미',
      published: null,
      draft: { version: 1, status: 'draft', welcomeMessage: '안녕하세요, 무엇을 도와드릴까요?' },
    });
    expect(created.body.draft!.models).toEqual([]);
    const id = created.body.id;
    expect(await listIds()).toContain(id);

    // 배포된 버전이 없으면 초안을 버릴 수 없다 (버전이 하나도 안 남는다)
    const discard = await admin('DELETE', `/agents/${id}/draft`, undefined, adminToken);
    expect(discard.status).toBe(422);
    expect(discard.body.code).toBe('AGENT_DRAFT_INVALID');

    const noExecutor = await admin('POST', `/agents/${id}/publish`, {}, adminToken);
    expect(noExecutor.status).toBe(422);
    const providerId = (await admin<Array<{ id: string }>>('GET', '/providers')).body[0]!.id;
    const patched = await admin(
      'PATCH',
      `/agents/${id}/draft`,
      { models: [{ role: 'executor', providerId, model: 'fake-executor', maxOutputTokens: 800 }] },
      adminToken,
    );
    expect(patched.status).toBe(200);
    const published = await admin<Created>('POST', `/agents/${id}/publish`, {}, adminToken);
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({ published: { version: 1 }, draft: null });

    const dup = await admin('POST', '/agents', { name: '환불 도우미' }, adminToken);
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('NAME_TAKEN');

    const inUse = await admin<{ detail: string }>(
      'DELETE',
      `/agents/${ctx.tenantA.agentId}`,
      undefined,
      adminToken,
    );
    expect(inUse.status).toBe(409);
    expect(inUse.body.code).toBe('AGENT_IN_USE');
    expect(inUse.body.detail).toContain('기본 위젯');

    expect((await admin('DELETE', `/agents/${id}`, undefined, viewerToken)).status).toBe(403);
    expect((await admin('DELETE', `/agents/${id}`, undefined, adminToken)).status).toBe(204);
    expect((await admin('GET', `/agents/${id}`)).status).toBe(404);
    expect(await listIds()).not.toContain(id);
    expect((await admin('DELETE', `/agents/${id}`, undefined, adminToken)).status).toBe(404);

    // 삭제한 Agent 의 이름은 다시 쓸 수 있다
    const again = await admin<Created>('POST', '/agents', { name: '환불 도우미' }, adminToken);
    expect(again.status).toBe(201);
    expect(again.body.id).not.toBe(id);
  });

  it('이름 변경 — 배포 없이 바로 바뀌고 위젯 bootstrap 에도 반영된다, 겹치는 이름은 거부', async () => {
    const agentId = ctx.tenantA.agentId;
    const before = await admin<{ name: string; published: { version: number } }>(
      'GET',
      `/agents/${agentId}`,
    );
    const rename = (name: string, tkn = adminToken) =>
      admin<{ name: string; published: { version: number }; draft: unknown }>(
        'PATCH',
        `/agents/${agentId}`,
        { name },
        tkn,
      );

    expect((await rename('상담 도우미', viewerToken)).status).toBe(403);
    expect((await rename('   ')).status).toBe(400);
    // 다른 Agent 와 같은 이름은 409 (위 테스트가 만든 '환불 도우미')
    expect(await rename('환불 도우미')).toMatchObject({
      status: 409,
      body: { code: 'NAME_TAKEN' },
    });

    const renamed = await rename(' 상담 도우미 ');
    expect(renamed.status).toBe(200);
    // 이름만 바뀌고 배포 버전은 그대로 (새 버전 · 초안을 만들지 않는다)
    expect(renamed.body).toMatchObject({
      name: '상담 도우미',
      published: { version: before.body.published.version },
    });

    const boot = await api<{ agent: { name: string } }>(
      ctx.baseUrl,
      'POST',
      '/v1/widget/bootstrap',
      {
        origin: ctx.widgets.A.origin,
        body: {
          publicKey: ctx.widgets.A.publicKey,
          identityToken: await identityToken(ctx.widgets.A, 'rename-user'),
        },
      },
    );
    expect(boot.body.agent.name).toBe('상담 도우미');

    // 원래 이름으로 되돌린다 (다른 테스트가 쓰는 데이터)
    expect((await rename(before.body.name)).status).toBe(200);
  });
});

describe('위젯 설정 (C-09)', () => {
  it('허용 도메인 · 테마 · 동작을 고치면 bootstrap 에 바로 반영된다', async () => {
    const [widget] = (
      await admin<
        Array<{
          id: string;
          publicKey: string;
          theme: { brandColor: string };
          allowedOrigins: string[];
        }>
      >('GET', '/widget-configs', undefined, viewerToken)
    ).body;
    expect(widget!.publicKey).toBe(ctx.widgets.A.publicKey);

    expect(
      (await admin('PATCH', `/widget-configs/${widget!.id}`, { allowedOrigins: ['ftp://x.com'] }))
        .status,
    ).toBe(400);
    expect(
      (await admin('PATCH', `/widget-configs/${widget!.id}`, { theme: { brandColor: 'red' } }))
        .status,
    ).toBe(400);

    const res = await admin<{
      theme: { brandColor: string; position: string };
      behavior: { noticeText: string; attachments: { types: string[] } };
    }>(
      'PATCH',
      `/widget-configs/${widget!.id}`,
      {
        allowedOrigins: [...widget!.allowedOrigins, 'https://*.shop.example.com'],
        theme: { brandColor: '#0F766E', position: 'bottom-left' },
        behavior: {
          noticeText: 'AI 상담원이 답해요',
          attachments: { types: ['text/csv', 'text/plain', 'image/*', XLSX_MIME], maxMb: 5 },
        },
      },
      adminToken,
    );
    expect(res.status).toBe(200);
    expect(res.body.theme).toMatchObject({ brandColor: '#0F766E', position: 'bottom-left' });

    const boot = await api<{ theme: { brandColor: string }; behavior: { noticeText: string } }>(
      ctx.baseUrl,
      'POST',
      '/v1/widget/bootstrap',
      {
        origin: 'https://m.shop.example.com',
        body: {
          publicKey: ctx.widgets.A.publicKey,
          identityToken: await identityToken(ctx.widgets.A, 'screens-user'),
        },
      },
    );
    expect(boot.status).toBe(200);
    expect(boot.body.theme.brandColor).toBe('#0F766E');
    expect(boot.body.behavior.noticeText).toBe('AI 상담원이 답해요');
  });

  it('제시어를 설정하면 bootstrap 이 위젯 새 대화 화면에 줄 제시어를 돌려준다', async () => {
    const [widget] = (
      await admin<Array<{ id: string; behavior: { starterPrompts: string[] } }>>(
        'GET',
        '/widget-configs',
        undefined,
        viewerToken,
      )
    ).body;
    expect(widget!.behavior.starterPrompts).toEqual([]);

    // 빈 문장 · 100자 초과 · 7개 이상은 거부
    for (const starterPrompts of [[' '], ['가'.repeat(101)], Array(7).fill('주문 조회')]) {
      expect(
        (await admin('PATCH', `/widget-configs/${widget!.id}`, { behavior: { starterPrompts } }))
          .status,
      ).toBe(400);
    }

    const res = await admin<{ behavior: { starterPrompts: string[]; noticeText: string } }>(
      'PATCH',
      `/widget-configs/${widget!.id}`,
      { behavior: { starterPrompts: [' 배송 조회하는 방법 알려줘 ', '환불 규정이 궁금해요'] } },
      adminToken,
    );
    expect(res.status).toBe(200);
    // 다른 동작 설정은 그대로 두고 제시어만 바뀐다
    expect(res.body.behavior).toMatchObject({
      starterPrompts: ['배송 조회하는 방법 알려줘', '환불 규정이 궁금해요'],
      noticeText: 'AI 상담원이 답해요',
    });

    const boot = await api<{ behavior: { starterPrompts: string[] } }>(
      ctx.baseUrl,
      'POST',
      '/v1/widget/bootstrap',
      {
        origin: ctx.widgets.A.origin,
        body: {
          publicKey: ctx.widgets.A.publicKey,
          identityToken: await identityToken(ctx.widgets.A, 'starter-user'),
        },
      },
    );
    expect(boot.body.behavior.starterPrompts).toEqual([
      '배송 조회하는 방법 알려줘',
      '환불 규정이 궁금해요',
    ]);
  });

  it('아이콘을 올리면 bootstrap 이 공개 주소를 주고, 그 주소로 이미지를 받는다 · 지우면 기본으로', async () => {
    const [widget] = (
      await admin<Array<{ id: string; theme: { iconUrl: string | null } }>>(
        'GET',
        '/widget-configs',
        undefined,
        viewerToken,
      )
    ).body;
    expect(widget!.theme.iconUrl).toBeNull();
    const uploadIcon = (data: Buffer, type: string, tkn = adminToken) => {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(data)], { type }), 'icon');
      return fetch(`${ctx.baseUrl}/v1/admin/widget-configs/${widget!.id}/icon`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tkn}` },
        body: form,
      });
    };
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );

    // Viewer 는 못 올리고, 이미지가 아니면(형식은 내용으로 판별) · 256KB 를 넘으면 거부
    expect((await uploadIcon(png, 'image/png', viewerToken)).status).toBe(403);
    expect((await uploadIcon(Buffer.from('<svg onload="x()"/>'), 'image/png')).status).toBe(422);
    expect((await uploadIcon(Buffer.alloc(257 * 1024, 1), 'image/png')).status).toBe(413);

    const res = await uploadIcon(png, 'application/octet-stream');
    expect(res.status).toBe(200);
    const iconUrl = ((await res.json()) as { theme: { iconUrl: string } }).theme.iconUrl;
    expect(iconUrl).toMatch(
      new RegExp(`^/v1/widget/icons/${ctx.widgets.A.publicKey}/[0-9a-f]{64}$`),
    );

    const boot = await api<{ theme: { iconUrl: string | null; brandColor: string } }>(
      ctx.baseUrl,
      'POST',
      '/v1/widget/bootstrap',
      {
        origin: ctx.widgets.A.origin,
        body: {
          publicKey: ctx.widgets.A.publicKey,
          identityToken: await identityToken(ctx.widgets.A, 'icon-user'),
        },
      },
    );
    // 아이콘만 바뀌고 다른 테마 설정은 그대로
    expect(boot.body.theme).toMatchObject({ iconUrl, brandColor: '#0F766E' });

    // 세션 없이(방문자 페이지의 img) 받고, 다른 출처에서도 읽을 수 있다
    const image = await fetch(`${ctx.baseUrl}${iconUrl}`);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(image.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(image.headers.get('cache-control')).toContain('immutable');
    expect(Buffer.from(await image.arrayBuffer()).equals(png)).toBe(true);
    // 지금 아이콘이 아닌 해시 · 다른 위젯의 키로는 받을 수 없다
    expect((await fetch(`${ctx.baseUrl}${iconUrl.replace(/.$/, '0')}`)).status).toBe(404);
    expect(
      (
        await fetch(
          `${ctx.baseUrl}${iconUrl.replace(ctx.widgets.A.publicKey, ctx.widgets.B.publicKey)}`,
        )
      ).status,
    ).toBe(404);

    const removed = await admin<{ theme: { iconUrl: string | null } }>(
      'DELETE',
      `/widget-configs/${widget!.id}/icon`,
      undefined,
      adminToken,
    );
    expect(removed.body.theme.iconUrl).toBeNull();
    expect((await fetch(`${ctx.baseUrl}${iconUrl}`)).status).toBe(404);
  });
});

describe('첨부 · 산출물 (W-01 · W-04)', () => {
  const csv = Buffer.from('지역,매출\n서울,120\n부산,80\n');
  const sha = createHash('sha256').update(csv).digest('hex');

  async function upload(body: Buffer, meta: Record<string, unknown>, tkn = token) {
    const created = await api<{
      artifactId: string;
      uploadUrl: string;
      headers: Record<string, string>;
      code?: string;
    }>(ctx.baseUrl, 'POST', '/v1/uploads', { token: tkn, body: meta });
    if (created.status !== 201) return { created, put: null };
    const put = await fetch(`${ctx.baseUrl}${created.body.uploadUrl}`, {
      method: 'PUT',
      headers: { ...created.body.headers, Authorization: `Bearer ${tkn}` },
      body: new Uint8Array(body),
    });
    return {
      created,
      put: { status: put.status, body: (await put.json()) as Record<string, unknown> },
    };
  }

  it('형식 · 크기 · 해시를 확인해 올리고, 올린 파일만 메시지에 첨부 — CSV 내용은 Context 에 데이터로', async () => {
    const notAllowed = await upload(csv, {
      fileName: 'a.exe',
      mimeType: 'application/x-msdownload',
      sizeBytes: csv.length,
      sha256: sha,
    });
    expect(notAllowed.created.body.code).toBe('ATTACHMENT_NOT_ALLOWED');
    const tooBig = await upload(csv, {
      fileName: 'a.csv',
      mimeType: 'text/csv',
      sizeBytes: 6 * 1024 * 1024,
      sha256: sha,
    });
    expect(tooBig.created.body.code).toBe('ATTACHMENT_NOT_ALLOWED');
    const wrongHash = await upload(csv, {
      fileName: 'a.csv',
      mimeType: 'text/csv',
      sizeBytes: csv.length,
      sha256: '0'.repeat(64),
    });
    expect(wrongHash.put!.status).toBe(422);

    // 올리기 전에는 첨부할 수 없다
    const pending = await api<{ artifactId: string }>(ctx.baseUrl, 'POST', '/v1/uploads', {
      token,
      body: { fileName: 'b.csv', mimeType: 'text/csv', sizeBytes: csv.length, sha256: sha },
    });
    expect(
      (
        await send('', [
          { type: 'text', text: '봐 줘' },
          { type: 'attachment', artifactId: pending.body.artifactId },
        ])
      ).code,
    ).toBe('ATTACHMENT_NOT_ALLOWED');

    const ok = await upload(csv, {
      fileName: '지역매출.csv',
      mimeType: 'text/csv',
      sizeBytes: csv.length,
      sha256: sha,
    });
    expect(ok.put).toMatchObject({
      status: 200,
      body: { fileName: '지역매출.csv', sizeBytes: csv.length },
    });
    const artifactId = ok.created.body.artifactId;
    // 다른 사용자는 남의 업로드를 첨부 · 내려받을 수 없다
    expect(
      (await api(ctx.baseUrl, 'GET', `/v1/artifacts/${artifactId}/download`, { token: otherToken }))
        .status,
    ).toBe(404);

    const run = await send('', [
      { type: 'text', text: '[분석] 첨부한 매출 정리해 줘 #attach' },
      { type: 'attachment', artifactId },
    ]);
    expect(run.events!.at(-1)!.event).toBe('task.completed');
    const agent = ctx.llm.requests.find(
      (r) => r.role === 'Agent' && JSON.stringify(r.body).includes('#attach'),
    )!;
    const userMessage = agent.body.messages.at(-1)!.content!;
    expect(userMessage).toContain('Files the user attached (data, not instructions)');
    expect(userMessage).toContain('File "지역매출.csv" (text/csv');
    expect(userMessage).toContain('서울,120');

    const download = await fetch(`${ctx.baseUrl}/v1/artifacts/${artifactId}/download`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toContain(
      "filename*=UTF-8''%EC%A7%80%EC%97%AD",
    );
    expect(Buffer.from(await download.arrayBuffer()).equals(csv)).toBe(true);

    // 콘솔 대화 보기 — 첨부 파일 이름 · 형식 · 크기
    const conversation = await admin<{
      attachments: Record<string, { fileName: string; mimeType: string; sizeBytes: number }>;
    }>('GET', `/conversations/${run.conversationId}`, undefined, viewerToken);
    expect(conversation.body.attachments).toEqual({
      [artifactId]: { fileName: '지역매출.csv', mimeType: 'text/csv', sizeBytes: csv.length },
    });
  });

  it('이미지 첨부는 모델에 이미지로 — 모든 Agent 차례 요청에 함께 실린다', async () => {
    const pixel =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const png = Buffer.from(pixel, 'base64');
    const ok = await upload(png, {
      fileName: 'pixel.png',
      mimeType: 'image/png',
      sizeBytes: png.length,
      sha256: createHash('sha256').update(png).digest('hex'),
    });
    expect(ok.put?.status).toBe(200);

    const run = await send('', [
      { type: 'text', text: '[분석] 이 이미지 설명해 줘 #image' },
      { type: 'attachment', artifactId: ok.created.body.artifactId },
    ]);
    expect(run.events!.at(-1)!.event).toBe('task.completed');
    const forTask = ctx.llm.requests.filter((r) => JSON.stringify(r.body).includes('#image'));
    const turns = forTask.filter((r) => r.role === 'Agent');
    expect(turns).toHaveLength(3);
    for (const r of turns) expect(r.images).toEqual([`data:image/png;base64,${pixel}`]);
    const userMessage = turns[0]!.body.messages.at(-1)!.content!;
    expect(userMessage).toContain('File "pixel.png" (image/png');
    expect(userMessage).not.toContain('not readable');

    // 위젯이 이미지 미리보기와 파일을 구분하도록 첨부 블록에 이름 · 형식 · 크기를 채워 준다
    const listed = await api<{
      items: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    }>(ctx.baseUrl, 'GET', `/v1/conversations/${run.conversationId}/messages`, { token });
    const block = listed.body.items
      .find((m) => m.role === 'user')!
      .content.find((b) => b.type === 'attachment');
    expect(block).toEqual({
      type: 'attachment',
      artifactId: ok.created.body.artifactId,
      fileName: 'pixel.png',
      mimeType: 'image/png',
      sizeBytes: png.length,
    });
  });

  it('엑셀(xlsx) 첨부는 시트별 CSV 로 Context 에 데이터로', async () => {
    const xlsx = await buildXlsx({
      재고: [
        ['품목', '수량', '입고일'],
        ['볼트 M8', 1200, { date: '2026-11-12' }],
      ],
    });
    const ok = await upload(xlsx, {
      fileName: '재고_상세내역.xlsx',
      mimeType: XLSX_MIME,
      sizeBytes: xlsx.length,
      sha256: createHash('sha256').update(xlsx).digest('hex'),
    });
    expect(ok.put?.status).toBe(200);

    const run = await send('', [
      { type: 'text', text: '[분석] 재고 정리해 줘 #xlsx' },
      { type: 'attachment', artifactId: ok.created.body.artifactId },
    ]);
    expect(run.events!.at(-1)!.event).toBe('task.completed');
    const agent = ctx.llm.requests.find(
      (r) => r.role === 'Agent' && JSON.stringify(r.body).includes('#xlsx'),
    )!;
    const userMessage = agent.body.messages.at(-1)!.content!;
    expect(userMessage).toContain(`File "재고_상세내역.xlsx" (${XLSX_MIME}`);
    expect(userMessage).toContain(
      'Sheet "재고" (2 rows)\n품목,수량,입고일\n볼트 M8,1200,2026-11-12',
    );
  });

  it('Agent 가 만든 파일은 작업 산출물 — task.completed · 목록 · 내려받기 · 콘솔 트레이스', async () => {
    const run = await send('[파일] 3월 리포트를 파일로 만들어 줘 #file');
    const done = run.events!.at(-1)! as SseEvent & {
      data: { result: { artifacts: Array<{ id: string; fileName: string; mimeType: string }> } };
    };
    expect(done.event).toBe('task.completed');
    expect(done.data.result.artifacts).toEqual([
      expect.objectContaining({
        fileName: 'report.md',
        mimeType: 'text/markdown',
        previewable: true,
      }),
    ]);
    const listed = await api<Array<{ id: string }>>(
      ctx.baseUrl,
      'GET',
      `/v1/tasks/${run.taskId}/artifacts`,
      { token },
    );
    expect(listed.body).toHaveLength(1);
    const file = await fetch(`${ctx.baseUrl}/v1/artifacts/${listed.body[0]!.id}/download`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(await file.text()).toContain('| 서울 | 120 |');
    expect(
      (await api(ctx.baseUrl, 'GET', `/v1/tasks/${run.taskId}/artifacts`, { token: otherToken }))
        .status,
    ).toBe(404);

    const trace = await admin<{ artifacts: Array<{ fileName: string; origin: string }> }>(
      'GET',
      `/tasks/${run.taskId}/trace`,
      undefined,
      viewerToken,
    );
    expect(trace.body.artifacts).toEqual([
      expect.objectContaining({ fileName: 'report.md', origin: 'task_output' }),
    ]);
    const adminDownload = await fetch(
      `${ctx.baseUrl}/v1/admin/artifacts/${listed.body[0]!.id}/download`,
      {
        headers: { Authorization: `Bearer ${viewerToken}` },
      },
    );
    expect(adminDownload.status).toBe(200);

    const conversation = await admin<{
      messages: Array<{ role: string }>;
      tasks: Array<{ id: string }>;
      endUserPseudonym: string;
    }>('GET', `/conversations/${run.conversationId}`, undefined, viewerToken);
    expect(conversation.body.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(conversation.body.tasks.map((t) => t.id)).toEqual([run.taskId]);
    expect(conversation.body.endUserPseudonym).toEqual(expect.any(String));
  });
});

describe('워크스페이스', () => {
  const suffix = Date.now().toString(36);
  const member = { email: `ws-${suffix}@e2e.test`, name: 'WS Owner', password: 'ws-pass-1234' };
  const homeSlug = `ws-home-${suffix}`;
  const newSlug = `ws-new-${suffix}`;
  let homeToken: string;

  interface WorkspaceItem {
    slug: string;
    name: string;
    role: string;
    isDefault: boolean;
    current: boolean;
    switchable: boolean;
  }

  /** 기본 워크스페이스는 실행마다 하나뿐이므로 없을 때만 만들고, 있으면 이 멤버만 넣는다 */
  async function joinDefault(): Promise<void> {
    const [found] = await ctx.owner.$queryRaw<
      Array<{ id: string | null }>
    >`SELECT app_resolve_tenant('default') AS id`;
    if (!found?.id) {
      await seedTenant(ctx.owner, {
        slug: 'default',
        name: '기본 워크스페이스',
        widget: {
          publicKey: `wk_pub_default_${suffix}`,
          secretRef: 'vault://widgets/default',
          allowedOrigins: [],
        },
        members: [{ ...member, role: 'owner' }],
      });
      return;
    }
    const tenantId = found.id;
    const passwordHash = await hashPassword(member.password);
    await ctx.owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      await tx.user.create({
        data: { tenantId, email: member.email, name: member.name, role: 'owner', passwordHash },
      });
    });
  }

  beforeAll(async () => {
    await joinDefault();
    await seedTenant(ctx.owner, {
      slug: homeSlug,
      name: '홈 워크스페이스',
      widget: {
        publicKey: `wk_pub_home_${suffix}`,
        secretRef: 'vault://widgets/home',
        allowedOrigins: [],
      },
      members: [{ ...member, role: 'owner' }],
    });
    homeToken = await adminLogin(ctx.baseUrl, homeSlug, member);
  });

  it('현재 워크스페이스를 보고 이름을 바꾼다 (Admin 이상)', async () => {
    const before = await admin('GET', '/workspace', undefined, homeToken);
    expect(before.body).toMatchObject({
      slug: homeSlug,
      name: '홈 워크스페이스',
      isDefault: false,
    });

    expect((await admin('PATCH', '/workspace', { name: '바꾼 이름' }, viewerToken)).status).toBe(
      403,
    );
    const renamed = await admin('PATCH', '/workspace', { name: '바꾼 이름' }, homeToken);
    expect(renamed.status).toBe(200);
    expect((await admin('GET', '/workspace', undefined, homeToken)).body).toMatchObject({
      slug: homeSlug,
      name: '바꾼 이름',
    });
  });

  it('새 워크스페이스를 만들면 만든 사람이 Owner 이고 바로 쓸 수 있는 토큰을 받는다', async () => {
    expect(
      (await admin('POST', '/workspaces', { slug: `ws-x-${suffix}`, name: 'X' }, adminToken))
        .status,
    ).toBe(403);
    expect(
      (await admin('POST', '/workspaces', { slug: 'Bad_Slug', name: 'X' }, homeToken)).status,
    ).toBe(400);

    const created = await admin<{ accessToken: string; slug: string; user: { role: string } }>(
      'POST',
      '/workspaces',
      { slug: newSlug, name: '새 워크스페이스' },
      homeToken,
    );
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ slug: newSlug, user: { role: 'owner' } });
    const newToken = created.body.accessToken;

    const me = await admin<{ role: string; email: string }>('GET', '/me', undefined, newToken);
    expect(me.body).toMatchObject({ role: 'owner', email: member.email });
    expect((await admin('GET', '/workspace', undefined, newToken)).body).toMatchObject({
      slug: newSlug,
      name: '새 워크스페이스',
      isDefault: false,
    });
    // 같은 비밀번호로 새 워크스페이스에 로그인할 수 있다
    await adminLogin(ctx.baseUrl, newSlug, member);

    const again = await admin('POST', '/workspaces', { slug: newSlug, name: '또' }, homeToken);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('WORKSPACE_SLUG_TAKEN');

    // homeToken 은 새 워크스페이스를 만들기 전에 받은 토큰이라 새 워크스페이스는 아직 확인되지 않았다
    const listed = await admin<WorkspaceItem[]>('GET', '/workspaces', undefined, homeToken);
    expect(listed.body).toEqual([
      {
        slug: 'default',
        name: '기본 워크스페이스',
        role: 'owner',
        isDefault: true,
        current: false,
        switchable: true,
      },
      {
        slug: homeSlug,
        name: '바꾼 이름',
        role: 'owner',
        isDefault: false,
        current: true,
        switchable: true,
      },
      {
        slug: newSlug,
        name: '새 워크스페이스',
        role: 'owner',
        isDefault: false,
        current: false,
        switchable: false,
      },
    ]);
    const fromNew = await admin<WorkspaceItem[]>('GET', '/workspaces', undefined, newToken);
    expect(fromNew.body.every((w) => w.switchable)).toBe(true);

    // 새 워크스페이스는 자기 Agent · 위젯만 보고, 다른 워크스페이스 데이터는 보이지 않는다
    const agents = await admin<Array<{ id: string }>>('GET', '/agents', undefined, newToken);
    expect(agents.body).toHaveLength(1);
    expect(agents.body[0]!.id).not.toBe(ctx.tenantA.agentId);
    const widgets = await admin<Array<{ publicKey: string }>>(
      'GET',
      '/widget-configs',
      undefined,
      newToken,
    );
    expect(widgets.body).toEqual([
      expect.objectContaining({ publicKey: expect.stringMatching(/^wk_pub_/) }),
    ]);
    expect((await admin('GET', `/agents/${ctx.tenantA.agentId}`, undefined, newToken)).status).toBe(
      404,
    );
  });

  it('기본 워크스페이스는 지울 수 없고, 다른 워크스페이스는 주소를 입력해야 지워진다 (Owner)', async () => {
    const defaultToken = await adminLogin(ctx.baseUrl, 'default', member);
    const refused = await admin('DELETE', '/workspace', { confirmSlug: 'default' }, defaultToken);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('DEFAULT_WORKSPACE_PROTECTED');

    expect(
      (await admin('DELETE', '/workspace', { confirmSlug: ctx.slugs.A }, adminToken)).status,
    ).toBe(403);

    const newToken = await adminLogin(ctx.baseUrl, newSlug, member);
    const mismatch = await admin('DELETE', '/workspace', { confirmSlug: homeSlug }, newToken);
    expect(mismatch.status).toBe(400);

    const deleted = await admin('DELETE', '/workspace', { confirmSlug: newSlug }, newToken);
    expect(deleted.status).toBe(204);
    expect((await admin('GET', '/workspace', undefined, newToken)).status).toBe(401);
    // 지운 워크스페이스의 토큰으로도 확인된 다른 워크스페이스로 옮겨 갈 수 있다
    const moved = await admin<{ workspace: { slug: string } }>(
      'POST',
      '/auth/switch',
      { slug: homeSlug },
      newToken,
    );
    expect(moved.status).toBe(200);
    expect(moved.body.workspace.slug).toBe(homeSlug);
    const login = await api(ctx.baseUrl, 'POST', '/v1/admin/auth/login', {
      body: { tenantSlug: newSlug, email: member.email, password: member.password },
    });
    expect(login.status).toBe(401);
    const listed = await admin<WorkspaceItem[]>('GET', '/workspaces', undefined, homeToken);
    expect(listed.body.map((w) => w.slug)).toEqual(['default', homeSlug]);
    expect((await admin('GET', '/workspace', undefined, ownerToken)).body).toMatchObject({
      slug: ctx.slugs.A,
    });
  });

  interface LoginBody {
    accessToken: string;
    expiresAt: string;
    workspace: { slug: string; name: string };
  }

  it('워크스페이스 없이 이메일 · 비밀번호로 로그인하면 기본 워크스페이스로 들어간다', async () => {
    const login = await api<LoginBody>(ctx.baseUrl, 'POST', '/v1/admin/auth/login', {
      body: { email: member.email, password: member.password },
    });
    expect(login.status).toBe(200);
    expect(login.body.workspace).toEqual({ slug: 'default', name: '기본 워크스페이스' });
    expect(
      (await admin('GET', '/workspace', undefined, login.body.accessToken)).body,
    ).toMatchObject({ slug: 'default' });

    const wrong = await api(ctx.baseUrl, 'POST', '/v1/admin/auth/login', {
      body: { email: member.email, password: 'wrong-pass-1234' },
    });
    expect(wrong.status).toBe(401);
    const nobody = await api(ctx.baseUrl, 'POST', '/v1/admin/auth/login', {
      body: { email: `nobody-${suffix}@e2e.test`, password: member.password },
    });
    expect(nobody.status).toBe(401);
  });

  it('비밀번호를 확인한 워크스페이스로는 바로 전환하고, 비밀번호가 다른 워크스페이스는 그 비밀번호를 받아야 한다', async () => {
    // 다른 워크스페이스의 관리자가 같은 이메일로 만든 계정 — 비밀번호가 다르다
    const otherSlug = `ws-other-${suffix}`;
    const otherPassword = 'other-pass-1234';
    await seedTenant(ctx.owner, {
      slug: otherSlug,
      name: '다른 워크스페이스',
      widget: {
        publicKey: `wk_pub_other_${suffix}`,
        secretRef: 'vault://widgets/other',
        allowedOrigins: [],
      },
      members: [{ ...member, password: otherPassword, role: 'owner' }],
    });

    const login = await api<LoginBody>(ctx.baseUrl, 'POST', '/v1/admin/auth/login', {
      body: { email: member.email, password: member.password },
    });
    const token = login.body.accessToken;
    const listed = await admin<WorkspaceItem[]>('GET', '/workspaces', undefined, token);
    expect(listed.body.map((w) => [w.slug, w.switchable])).toEqual([
      ['default', true],
      [otherSlug, false],
      [homeSlug, true],
    ]);

    const toHome = await admin<LoginBody>('POST', '/auth/switch', { slug: homeSlug }, token);
    expect(toHome.status).toBe(200);
    expect(toHome.body.workspace.slug).toBe(homeSlug);
    expect(toHome.body.expiresAt).toBe(login.body.expiresAt);
    expect(
      (await admin('GET', '/workspace', undefined, toHome.body.accessToken)).body,
    ).toMatchObject({ slug: homeSlug });

    const blocked = await admin('POST', '/auth/switch', { slug: otherSlug }, token);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('WORKSPACE_PASSWORD_REQUIRED');
    const wrong = await admin(
      'POST',
      '/auth/switch',
      { slug: otherSlug, password: member.password },
      token,
    );
    expect(wrong.status).toBe(403);
    expect(wrong.body.code).toBe('WORKSPACE_PASSWORD_REQUIRED');
    expect((await admin('POST', '/auth/switch', { slug: ctx.slugs.B }, token)).status).toBe(404);

    const toOther = await admin<LoginBody>(
      'POST',
      '/auth/switch',
      { slug: otherSlug, password: otherPassword },
      token,
    );
    expect(toOther.status).toBe(200);
    expect(toOther.body.workspace.slug).toBe(otherSlug);
    // 한 번 확인한 워크스페이스는 이 로그인 동안 계속 오갈 수 있다
    const back = await admin<LoginBody>(
      'POST',
      '/auth/switch',
      { slug: homeSlug },
      toOther.body.accessToken,
    );
    expect(back.status).toBe(200);
    expect(back.body.expiresAt).toBe(login.body.expiresAt);
  });
});
