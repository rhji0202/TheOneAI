import { z } from 'zod';
import { BuiltinToolCatalog } from '../src/tools/builtin-tool.catalog.js';
import { type FakeMcp, startFakeMcp } from './fake-mcp-server.js';
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
import { type Browser, launch, type Page, requireBuild, snap } from './ui/browser.js';
import { makeZip } from './zip.js';
import { MetricsRollupService } from '../src/workers/metrics-rollup.service.js';

/**
 * 콘솔 화면 (C-01 ~ C-09 · 마켓플레이스 · 사용량) — 빌드한 콘솔을 실제 브라우저로 쓴다.
 * 먼저 npm run build:ui. 화면을 남기려면 UI_SCREENSHOT_DIR=<폴더>.
 */
let ctx: TestContext;
let browser: Browser;
let page: Page;
let mcp: FakeMcp;
let ownerToken: string;
let widgetToken: string;
const pageErrors: string[] = [];
const runs: Record<string, { taskId: string; conversationId: string }> = {};
const sentNotes: unknown[] = [];

/** 메시지만 보내고 끝나기를 기다리지 않는다 (승인 대기 작업) */
async function startTask(text: string) {
  const conv = (
    await api<{ id: string }>(ctx.baseUrl, 'POST', '/v1/conversations', {
      token: widgetToken,
      body: {},
    })
  ).body.id;
  const sent = await api<{ task: { id: string } }>(
    ctx.baseUrl,
    'POST',
    `/v1/conversations/${conv}/messages`,
    { token: widgetToken, body: { content: [{ type: 'text', text }] } },
  );
  return sent.body.task.id;
}

async function runTask(text: string) {
  const conv = (
    await api<{ id: string }>(ctx.baseUrl, 'POST', '/v1/conversations', {
      token: widgetToken,
      body: {},
    })
  ).body.id;
  const sent = await api<{ task: { id: string }; eventsUrl: string }>(
    ctx.baseUrl,
    'POST',
    `/v1/conversations/${conv}/messages`,
    { token: widgetToken, body: { content: [{ type: 'text', text }] } },
  );
  await readSse(`${ctx.baseUrl}${sent.body.eventsUrl}`, widgetToken);
  return { taskId: sent.body.task.id, conversationId: conv };
}

async function newPage(): Promise<Page> {
  const p = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: 'ko-KR',
  });
  p.on('pageerror', (e) => pageErrors.push(String(e.message)));
  // 멈춘 단계가 테스트 시간 제한보다 먼저 실패해 어느 요소인지 알려 주게
  p.setDefaultTimeout(10_000);
  return p;
}

async function login(p: Page, member: { email: string; password: string }) {
  await p.goto(`${ctx.baseUrl}/console/login`);
  await p.getByLabel('워크스페이스').fill(ctx.slugs.A);
  await p.getByLabel('이메일').fill(member.email);
  await p.getByLabel('비밀번호').fill(member.password);
  await p.getByRole('button', { name: '로그인' }).click();
  await p.getByRole('navigation').first().waitFor();
}

const go = (path: string, p: Page = page) => p.goto(`${ctx.baseUrl}/console${path}`);
const heading = (name: string | RegExp, p: Page = page) =>
  p.getByRole('heading', { name }).first().waitFor({ timeout: 10_000 });

beforeAll(async () => {
  requireBuild('apps/console/dist/index.html');
  ctx = await startTestApp();
  mcp = await startFakeMcp();
  ctx.app.get(BuiltinToolCatalog).register({
    name: 'test.send_note',
    description: '담당자에게 메모를 보낸다.',
    level: 'write',
    idempotent: false,
    input: z.object({ to: z.string(), text: z.string() }),
    execute: async (args) => {
      sentNotes.push(args);
      return { sent: true };
    },
  });
  ownerToken = await adminLogin(ctx.baseUrl, ctx.slugs.A, CONSOLE_MEMBERS.owner);
  widgetToken = await startSession(ctx.baseUrl, ctx.widgets.A, 'console-ui-user');
  runs.ok = await runTask('[분석] 콘솔 시험 작업 #console-ok');
  runs.fail = await runTask('[두번실패] 콘솔 실패 시험 #console-fail');
  await ctx.app.get(MetricsRollupService).tick();
  browser = await launch();
  page = await newPage();
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await mcp?.close();
  await ctx?.close();
});

afterEach(() => {
  expect(pageErrors).toEqual([]);
});

describe('콘솔 로그인 · 대시보드 (C-01)', () => {
  it('틀린 비밀번호는 오류, 맞으면 대시보드 — KPI · 날짜별 작업 · 최근 실패', async () => {
    await go('/tasks');
    await page.waitForURL(/\/console\/login$/);
    await page.getByLabel('워크스페이스').fill(ctx.slugs.A);
    await page.getByLabel('이메일').fill(CONSOLE_MEMBERS.owner.email);
    await page.getByLabel('비밀번호').fill('wrong-password');
    await page.getByRole('button', { name: '로그인' }).click();
    await page.getByRole('alert').waitFor();
    expect(await page.getByRole('alert').innerText()).toContain('확인해 주세요');

    await login(page, CONSOLE_MEMBERS.owner);
    // 로그인 전에 열려던 화면으로 돌아간다
    await page.waitForURL(/\/console\/tasks$/);
    await go('/');
    await heading('대시보드');
    await page.getByText('작업 성공률').first().waitFor();
    await page.getByText('콘솔 실패 시험 #console-fail').first().waitFor();
    expect(await page.getByText('Owner · owner@e2e.test').count()).toBe(1);
    await snap(page, 'c01-dashboard');
  });
});

describe('작업 (C-02)', () => {
  it('목록 → 실행 트레이스 → 단계 상세 → 대화 보기', async () => {
    await go('/tasks');
    await heading('작업');
    await page.getByRole('link', { name: '[분석] 콘솔 시험 작업 #console-ok' }).click();
    await page.waitForURL(new RegExp(`/tasks/${runs.ok!.taskId}$`));
    await page.getByText('실행 트레이스').first().waitFor();
    await page.getByText('실행 계획 생성').first().waitFor();
    await snap(page, 'c02-trace');

    await page.getByText('실행 계획 생성').first().click();
    await page.getByRole('dialog').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });

    await page.getByRole('link', { name: '대화 보기' }).click();
    await page.waitForURL(new RegExp(`/conversations/${runs.ok!.conversationId}$`));
    await page.getByText('대화 기록').first().waitFor();
    await page.getByText('[분석] 콘솔 시험 작업 #console-ok').first().waitFor();
  });

  it('실패한 작업 — 원인 표시 · checkpoint 부터 재개 → 완료', async () => {
    await go(`/tasks/${runs.fail!.taskId}`);
    await page.getByText('콘솔 실패 시험 #console-fail').first().waitFor();
    await page.getByRole('button', { name: /재개/ }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await dialog.getByRole('button', { name: /재개/ }).last().click();
    await page
      .getByText(/재개했어요/)
      .first()
      .waitFor();
    // 3초마다 새로 고침 — 완료 배지
    await page.getByText('완료', { exact: true }).first().waitFor({ timeout: 20_000 });
  });
});

describe('Agent 설정 (C-03)', () => {
  it('환영 문구 수정 → 초안 저장 → 배포 → 새 버전 배포 중', async () => {
    await go('/agents');
    await heading('Agent 설정');
    await page.getByText('v1 배포 중').first().waitFor();
    await go(`/agents/${ctx.tenantA.agentId}`);
    await page.getByLabel('환영 문구').fill('반가워요! 콘솔에서 바꾼 인사말');
    await page.getByRole('button', { name: /초안.*저장/ }).click();
    await page
      .getByText(/배포 안 된 변경/)
      .first()
      .waitFor();
    await snap(page, 'c03-agent-draft');

    await page.getByRole('button', { name: '배포', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('변경 메모').fill('인사말 변경');
    await dialog.getByRole('button', { name: /배포/ }).last().click();
    await page
      .getByText(/v2 배포 중/)
      .first()
      .waitFor();
    const agents = await api<Array<{ id: string; publishedVersion: number }>>(
      ctx.baseUrl,
      'GET',
      '/v1/admin/agents',
      { token: ownerToken },
    );
    expect(agents.body.find((a) => a.id === ctx.tenantA.agentId)!.publishedVersion).toBe(2);
  });
});

describe('위젯 설치 · 테마 (C-09)', () => {
  it('설치 코드에 공개 키 · 허용 도메인 검사 · 추가 후 저장', async () => {
    await go('/widget');
    await heading('위젯 설치 · 테마');
    await page.getByText(`data-widget-key="${ctx.widgets.A.publicKey}"`).first().waitFor();

    const input = page.getByLabel('도메인 추가');
    await input.fill('https://a.example.com/x');
    const add = page
      .getByRole('group', { name: '새 허용 도메인' })
      .getByRole('button', { name: '추가', exact: true });
    await add.click();
    expect(await page.getByText(/경로/).count()).toBeGreaterThan(0);
    await input.fill('https://a.example.com');
    await add.click();
    await page.getByRole('region', { name: '저장' }).getByRole('button', { name: '저장' }).click();
    await page.getByRole('region', { name: '저장' }).waitFor({ state: 'hidden' });
    const widget = await ctx.owner.widgetConfig.findFirst({
      where: { publicKey: ctx.widgets.A.publicKey },
    });
    expect(widget!.allowedOrigins).toContain('https://a.example.com');
    await snap(page, 'c09-widget');
  });
});

describe('MCP 서버 (C-04 · C-05)', () => {
  it('연결 마법사 4단계 — 연결 정보 → 연결 테스트 → Tool 탐색 → 등록 → 목록', async () => {
    await go('/mcp/new');
    await heading('MCP 서버 연결');
    await page.getByLabel('서버 이름').fill('uishop');
    await page.getByLabel('엔드포인트 URL').fill(mcp.url);
    await page.getByText('사설 네트워크(사내망 · localhost) 허용').click();
    await page.getByRole('button', { name: '저장하고 연결 테스트' }).click();
    await page.getByText('연결에 성공했어요').waitFor({ timeout: 15_000 });
    await page.getByRole('button', { name: /Tool 탐색하기/ }).click();
    await page.getByRole('table', { name: '탐색된 Tool' }).waitFor({ timeout: 15_000 });
    await snap(page, 'c05-discover');
    await page.getByRole('button', { name: /선택 저장/ }).click();
    await page.getByRole('button', { name: '등록하기' }).click();
    await page.getByText('uishop 을(를) 등록했어요').waitFor({ timeout: 15_000 });
    const server = await ctx.owner.mcpServer.findFirst({
      where: { tenantId: ctx.tenantA.tenantId, name: 'uishop' },
    });
    expect(server!.status).toBe('connected');

    await go('/mcp');
    await page.getByText('uishop').first().click();
    await heading('uishop');
    await snap(page, 'c04-mcp-detail');
  });
});

describe('Skill (C-06)', () => {
  it('zip 업로드 → 검증 결과 → 버전 상세 → 활성화', async () => {
    await go('/skills');
    await heading('Skill');
    await page.getByRole('button', { name: /Skill 업로드/ }).click();
    const zip = await makeZip([
      {
        path: 'SKILL.md',
        data: '---\nname: ui-helper\ndescription: 콘솔 시험용 Skill. 계산 문의에 사용.\nallowed-tools: builtin.calculate\nversion: 1.0.0\n---\n# 절차\n1. 계산한다.\n',
      },
    ]);
    await page
      .getByLabel('Skill zip 파일')
      .setInputFiles({ name: 'ui-helper.zip', mimeType: 'application/zip', buffer: zip });
    await page.getByRole('button', { name: '올리고 검증하기' }).click();
    await page.getByText('업로드 결과').waitFor({ timeout: 15_000 });
    await page.getByRole('button', { name: '버전 상세 보기' }).click();
    await heading('ui-helper');
    await page.getByRole('button', { name: '이 버전 활성화' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '활성화', exact: true }).click();
    await page
      .getByText(/활성화 · /)
      .first()
      .waitFor();
    const skill = await ctx.owner.skill.findFirst({
      where: { tenantId: ctx.tenantA.tenantId, name: 'ui-helper' },
    });
    expect(skill!.status).toBe('active');
    await snap(page, 'c06-skill');
  });
});

describe('승인 · 권한 정책 (C-07)', () => {
  it('승인 대기 → 운영자로 대리 승인(메모 필수) → Tool 실행 · 작업 완료 → 등급별 정책', async () => {
    const taskId = await startTask('[승인필요] 담당자에게 메모 보내줘 #console-approval');
    await waitFor(async () => {
      const t = await ctx.owner.task.findUnique({ where: { id: taskId } });
      return t?.status === 'waiting_approval';
    }, 20_000);

    await go('/approvals');
    await heading('승인 · 권한 정책');
    await page.getByText('test.send_note').first().waitFor();
    await snap(page, 'c07-approvals');
    await page.getByRole('button', { name: '운영자로 승인' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await dialog.getByLabel(/승인 메모/).fill('콘솔에서 확인함');
    await dialog.getByRole('button', { name: '승인', exact: true }).click();
    await page
      .getByText(/승인했어요/)
      .first()
      .waitFor();
    await waitFor(async () => {
      const t = await ctx.owner.task.findUnique({ where: { id: taskId } });
      return t?.status === 'completed';
    }, 20_000);
    expect(sentNotes).toEqual([{ to: 'ops@example.com', text: '안녕하세요' }]);

    await page.getByRole('tab', { name: /등급별 정책/ }).click();
    await page.getByRole('table', { name: '등급별 기본 정책' }).waitFor();
    await snap(page, 'c07-policies');
  });
});

describe('Memory · 마켓플레이스 · 사용량', () => {
  it('Memory 탐색 (C-08) — 활성 · 격리 탭', async () => {
    await go('/memory');
    await heading('Memory 탐색');
    await page.getByRole('tab', { name: /격리됨/ }).click();
    await snap(page, 'c08-memory');
  });

  it('마켓플레이스 — 목록 · 게시 버튼', async () => {
    await go('/marketplace');
    await heading('마켓플레이스');
    await snap(page, 'c10-marketplace');
  });

  it('사용량 · 비용 — 일별 차트 · 모델별 · 단가 편집', async () => {
    await go('/billing');
    await heading('사용량 · 비용');
    await page.getByText('일별 비용').first().waitFor();
    await page.getByText('모델 단가').first().waitFor();
    await snap(page, 'c11-billing');
  });
});

describe('역할 (Viewer)', () => {
  it('Viewer 는 보기만 — 배포 · 업로드 · 연결 버튼이 없다', async () => {
    const viewer = await newPage();
    await login(viewer, CONSOLE_MEMBERS.viewer);
    await go(`/agents/${ctx.tenantA.agentId}`, viewer);
    await viewer
      .getByText(/보기 전용/)
      .first()
      .waitFor();
    expect(await viewer.getByRole('button', { name: '배포', exact: true }).count()).toBe(0);
    await go('/skills', viewer);
    await heading('Skill', viewer);
    expect(await viewer.getByRole('button', { name: /Skill 업로드/ }).count()).toBe(0);
    await go('/mcp', viewer);
    await heading('MCP 서버', viewer);
    expect(await viewer.getByRole('link', { name: /MCP 서버 연결/ }).count()).toBe(0);
    expect(await viewer.getByRole('button', { name: /MCP 서버 연결/ }).count()).toBe(0);
  });
});
