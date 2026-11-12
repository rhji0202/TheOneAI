import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/** 쓰는 만큼만 적은 Playwright 타입 (Playwright 는 전역 설치본을 require 로 쓴다) */
export interface Locator {
  click(options?: { timeout?: number }): Promise<void>;
  fill(value: string): Promise<void>;
  press(key: string): Promise<void>;
  textContent(): Promise<string | null>;
  innerText(): Promise<string>;
  count(): Promise<number>;
  first(): Locator;
  last(): Locator;
  nth(index: number): Locator;
  isVisible(): Promise<boolean>;
  waitFor(options?: {
    state?: 'visible' | 'hidden' | 'attached' | 'detached';
    timeout?: number;
  }): Promise<void>;
  getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): Locator;
  getByText(text: string | RegExp, options?: { exact?: boolean }): Locator;
  getByLabel(text: string | RegExp, options?: { exact?: boolean }): Locator;
  getByPlaceholder(text: string | RegExp): Locator;
  locator(selector: string): Locator;
  selectOption(value: string | string[]): Promise<void>;
  check(): Promise<void>;
  setInputFiles(
    files: string | string[] | { name: string; mimeType: string; buffer: Buffer },
  ): Promise<void>;
  screenshot(options?: { path?: string }): Promise<Buffer>;
}
export interface Page extends Pick<
  Locator,
  'getByRole' | 'getByText' | 'getByLabel' | 'getByPlaceholder' | 'locator'
> {
  goto(url: string, options?: { waitUntil?: string }): Promise<unknown>;
  screenshot(options?: { path?: string; fullPage?: boolean }): Promise<Buffer>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<T>(fn: string | (() => T)): Promise<T>;
  on(
    event: 'console' | 'pageerror',
    handler: (arg: { type?: () => string; text?: () => string; message?: string }) => void,
  ): void;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  url(): string;
  waitForURL(url: string | RegExp, options?: { timeout?: number }): Promise<void>;
  keyboard: { press(key: string): Promise<void> };
  context(): { addInitScript(script: string): Promise<void> };
}
export interface Browser {
  newPage(options?: {
    viewport?: { width: number; height: number };
    deviceScaleFactor?: number;
    locale?: string;
  }): Promise<Page>;
  close(): Promise<void>;
}

export async function launch(): Promise<Browser> {
  const require = createRequire(import.meta.url);
  const { chromium } = require('playwright') as { chromium: { launch(): Promise<Browser> } };
  return chromium.launch();
}

/** UI_SCREENSHOT_DIR 이 있으면 그곳에 화면을 남긴다 (사람이 보는 확인용) */
export async function snap(page: Page, name: string): Promise<void> {
  const dir = process.env.UI_SCREENSHOT_DIR;
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

export function requireBuild(path: string): void {
  if (!existsSync(path))
    throw new Error(`${path} 가 없습니다 — npm run build:ui 를 먼저 실행하세요`);
}
