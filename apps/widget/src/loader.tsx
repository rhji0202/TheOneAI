import { createRoot, type Root } from 'react-dom/client';
import { App, type WidgetOptions } from './App';
import css from './styles.css?inline';

// Shadow DOM 안의 @property 는 무시된다 — Tailwind 변수(테두리 · 그림자 등)의 초기값이 빠지지 않게 문서에 등록한다.
const PROPERTY_RULE = /@property\s+[\w-]+\s*\{[^}]*\}/g;
const propertyCss = (css.match(PROPERTY_RULE) ?? []).join('\n');
// rem 은 호스트 페이지 html 글자 크기를 따른다 — 어느 사이트에서도 같은 크기로 보이게 px 로 고정한다.
const shadowCss = css
  .replace(PROPERTY_RULE, '')
  .replace(/(-?\d*\.?\d+)rem\b/g, (_, n: string) => `${Number(n) * 16}px`);

/**
 * 위젯 로더 — 고객사 페이지에 한 줄로 넣는다.
 *   <script src="https://<API>/widget/v1/loader.js" data-widget-key="wk_pub_..." async></script>
 * 로그인 사용자 연동: 고객사 서버가 Widget Secret 으로 서명한 identity token 을 넘긴다.
 *   window.TheOneWidget.identify({ token })   또는   window.TheOneWidgetSettings = { identityToken } (로더보다 먼저)
 * 위젯은 Shadow DOM 안에 그려 호스트 페이지 CSS 와 섞이지 않는다.
 */
interface PublicApi {
  init(options: Partial<WidgetOptions> & { widgetKey: string }): void;
  identify(input: { token: string }): void;
  destroy(): void;
}

declare global {
  interface Window {
    TheOneWidget?: PublicApi;
    TheOneWidgetSettings?: Partial<WidgetOptions>;
  }
}

const script = document.currentScript as HTMLScriptElement | null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let properties: HTMLStyleElement | null = null;
let options: WidgetOptions | null = null;
let identityVersion = 0;

function render() {
  if (!options) return;
  if (!host) {
    host = document.createElement('div');
    host.id = 'theonewidget';
    host.style.all = 'initial';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = shadowCss;
    const mount = document.createElement('div');
    shadow.append(style, mount);
    document.body.appendChild(host);
    if (propertyCss && !properties) {
      properties = document.createElement('style');
      properties.dataset.theonewidget = 'properties';
      properties.textContent = propertyCss;
      document.head.appendChild(properties);
    }
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
    properties?.remove();
    root = null;
    host = null;
    properties = null;
  },
};

function defaultBase(): string {
  if (script?.dataset.apiBase) return script.dataset.apiBase.replace(/\/$/, '');
  if (script?.src) return new URL(script.src).origin;
  return window.location.origin;
}

window.TheOneWidget = api;
const preset = window.TheOneWidgetSettings ?? {};
const key = preset.widgetKey ?? script?.dataset.widgetKey;
if (key) api.init({ ...preset, widgetKey: key });
