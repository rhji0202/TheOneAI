import { z } from 'zod';
import { BuiltinToolCatalog } from '../src/tools/builtin-tool.catalog.js';
import { identityToken, startTestApp, type TestContext } from './helpers.js';
import { type Browser, launch, type Page, requireBuild, snap } from './ui/browser.js';

/**
 * 위젯 화면 (W-01 ~ W-05) — 빌드한 loader.js 를 데모 페이지에 넣고 실제 브라우저로 쓴다.
 * 먼저 npm run build:ui. 화면을 남기려면 UI_SCREENSHOT_DIR=<폴더>.
 */
let ctx: TestContext;
let browser: Browser;
let page: Page;
const sent: unknown[] = [];

beforeAll(async () => {
  requireBuild('apps/widget/dist/loader.js');
  ctx = await startTestApp();
  // 데모 페이지는 API 서버에서 열리므로 그 Origin 을 허용한다
  await ctx.owner.widgetConfig.updateMany({
    where: { publicKey: ctx.widgets.A.publicKey },
    data: { allowedOrigins: [ctx.widgets.A.origin, new URL(ctx.baseUrl).origin] },
  });
  ctx.app.get(BuiltinToolCatalog).register({
    name: 'test.send_note',
    description: '담당자에게 메모를 보낸다.',
    level: 'write',
    idempotent: false,
    input: z.object({ to: z.string(), text: z.string() }),
    execute: async (args) => {
      sent.push(args);
      return { sent: true };
    },
  });
  browser = await launch();
  page = await browser.newPage({
    viewport: { width: 1100, height: 860 },
    deviceScaleFactor: 1,
    locale: 'ko-KR',
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  const token = await identityToken(ctx.widgets.A, 'ui-user');
  await page.goto(
    `${ctx.baseUrl}/widget/v1/demo.html?key=${ctx.widgets.A.publicKey}&token=${token}`,
  );
  expect(errors).toEqual([]);
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await ctx?.close();
});

const panel = () => page.getByRole('dialog');

async function sendFromHome(text: string) {
  const input = panel().getByLabel('메시지 입력');
  await input.fill(text);
  await input.press('Enter');
}

describe('위젯 (W-01 ~ W-05)', () => {
  it('W-01 런처를 누르면 홈 — 인사 · 고지 문구 · 입력창', async () => {
    await page.getByRole('button', { name: /열기$/ }).click();
    await panel().waitFor();
    await panel().getByText('무엇을 도와드릴까요?').first().waitFor();
    expect(
      await panel().getByText('AI 응답은 부정확할 수 있어요 · Powered by TheOneAI').count(),
    ).toBe(1);
    await snap(page, 'w01-home');
  });

  it('W-02 · W-04 요청 → 실행 계획 · 스트리밍 답변 → 결과 검증 · 피드백', async () => {
    await sendFromHome('[분석] 할인 방식 정리해 줘 #ui-run');
    await panel().getByText('실행 계획 · 2단계').waitFor({ timeout: 15_000 });
    await panel().getByText('결과 검증 완료').waitFor({ timeout: 15_000 });
    expect(
      await panel()
        .getByText(/요청하신 내용에 대한 답변입니다/)
        .count(),
    ).toBe(1);
    expect(await panel().getByText('요구사항 분석').count()).toBe(1);
    await snap(page, 'w04-result');
    await panel()
      .getByRole('button', { name: /도움됨/ })
      .click();
    await panel().getByText('의견 고마워요.').waitFor();
    const feedback = await ctx.owner.feedback.findMany({ where: { rating: 'helpful' } });
    expect(feedback).toHaveLength(1);
  });

  it('W-03 승인 필요 Tool → 승인 카드(인자 · 위험도) → 승인하고 계속 → 실행 후 완료', async () => {
    await panel().getByRole('button', { name: '새 대화' }).click();
    await sendFromHome('[승인필요] 담당자에게 메모 보내줘 #ui-approval');
    const card = panel().getByRole('alertdialog');
    await card.waitFor({ timeout: 15_000 });
    expect(await card.getByText('담당자에게 메모를 보낸다.').count()).toBe(1);
    // 인자 목록 + 펼치기 전 원본 JSON(숨김) 두 곳에 있다
    expect(await card.getByText('ops@example.com', { exact: true }).first().isVisible()).toBe(true);
    expect(await card.getByText('위험도 중간').count()).toBe(1);
    await snap(page, 'w03-approval');
    await card.getByRole('button', { name: '승인하고 계속' }).click();
    await panel().getByText('결과 검증 완료').waitFor({ timeout: 15_000 });
    expect(sent).toEqual([{ to: 'ops@example.com', text: '안녕하세요' }]);
  });

  it('실패하면 원인과 재개 버튼 — 다시 실행하면 완료', async () => {
    await panel().getByRole('button', { name: '새 대화' }).click();
    await sendFromHome('[두번실패] 답변 실패 시험 #ui-fail');
    await panel().getByText('작업을 끝내지 못했어요').waitFor({ timeout: 20_000 });
    await snap(page, 'w05-failed-in-chat');
    await panel().getByRole('button', { name: '멈춘 단계부터 재개' }).click();
    await panel().getByText('결과 검증 완료').waitFor({ timeout: 20_000 });
  });

  it('W-05 작업 목록 — 상태 탭 · 항목을 누르면 그 대화로', async () => {
    await panel().getByRole('button', { name: '홈으로' }).click();
    await panel().getByRole('button', { name: '작업 목록' }).click();
    await panel().getByRole('tab', { name: /전체/ }).waitFor();
    await panel().getByText('할인 방식 정리해 줘 #ui-run').first().waitFor();
    await snap(page, 'w05-tasks');
    await panel().getByRole('tab', { name: '완료' }).click();
    await panel().getByText('[승인필요] 담당자에게 메모 보내줘 #ui-approval').first().click();
    await panel().getByText('결과 검증 완료').waitFor();
  });

  it('모바일 폭에서는 전체 화면, 최소화하면 런처만', async () => {
    await page.setViewportSize({ width: 390, height: 780 });
    await snap(page, 'w02-mobile');
    await panel().getByRole('button', { name: '최소화' }).click();
    await panel().waitFor({ state: 'hidden' });
    await page.setViewportSize({ width: 1100, height: 860 });
  });
});
