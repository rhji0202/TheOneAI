import { createRoot, type Root } from 'react-dom/client';
import { App, type WidgetOptions } from './App';
import css from './widget.css?inline';

/**
 * 위젯 로더 — 고객사 페이지에 한 줄로 넣는다.
 *   <script src="https://<API>/widget/v1/loader.js" data-widget-key="wk_pub_..." async></script>
 * 로그인 사용자 연동: 고객사 서버가 Widget Secret 으로 서명한 identity token 을 넘긴다.
 *   window.TheOneAI.identify({ token })   또는   window.TheOneAISettings = { identityToken } (로더보다 먼저)
 * 위젯은 Shadow DOM 안에 그려 호스트 페이지 CSS 와 섞이지 않는다.
 */
interface PublicApi {
  init(options: Partial<WidgetOptions> & { widgetKey: string }): void;
  identify(input: { token: string }): void;
  destroy(): void;
}

declare global {
  interface Window {
    TheOneAI?: PublicApi;
    TheOneAISettings?: Partial<WidgetOptions>;
  }
}

const script = document.currentScript as HTMLScriptElement | null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let options: WidgetOptions | null = null;
let identityVersion = 0;

function render() {
  if (!options) return;
  if (!host) {
    host = document.createElement('div');
    host.id = 'theoneai-widget';
    host.style.all = 'initial';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = css;
    const mount = document.createElement('div');
    shadow.append(style, mount);
    document.body.appendChild(host);
    root = createRoot(mount);
  }
  root!.render(<App options={options} identityVersion={identityVersion} />);
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const api: PublicApi = {
  init(input) {
    options = {
      apiBase: input.apiBase ?? defaultBase(),
      widgetKey: input.widgetKey,
      identityToken: input.identityToken,
      getIdentityToken: input.getIdentityToken,
      storage: input.storage === undefined ? storage() : input.storage,
    };
    if (document.body) render();
    else document.addEventListener('DOMContentLoaded', render, { once: true });
  },
  identify({ token }) {
    if (!options) return;
    options = { ...options, identityToken: token };
    identityVersion += 1;
    render();
  },
  destroy() {
    root?.unmount();
    host?.remove();
    root = null;
    host = null;
  },
};

function defaultBase(): string {
  if (script?.dataset.apiBase) return script.dataset.apiBase.replace(/\/$/, '');
  if (script?.src) return new URL(script.src).origin;
  return window.location.origin;
}

window.TheOneAI = api;
const preset = window.TheOneAISettings ?? {};
const key = preset.widgetKey ?? script?.dataset.widgetKey;
if (key) api.init({ ...preset, widgetKey: key });
