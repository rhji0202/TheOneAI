import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, type Bootstrap, type TaskSummary, WidgetApi } from './api';
import { Back, ChatBubble, Close, ListIcon, Minus, Plus, Spark } from './icons';
import { ChatView, HomeView, statusLine, TasksView } from './views';

export interface WidgetOptions {
  widgetKey: string;
  apiBase: string;
  identityToken?: string;
  getIdentityToken?: () => Promise<string | null | undefined>;
  /** 페이지 이동 · 새로고침 뒤 마지막 화면을 다시 연다 */
  storage?: Storage | null;
}

type View =
  | { name: 'home' }
  | { name: 'tasks' }
  | { name: 'chat'; conversationId: string; taskId: string | null };

type BootState =
  | { status: 'loading' }
  | { status: 'ready'; boot: Bootstrap }
  | { status: 'hidden' }
  | { status: 'error'; message: string };

const DEFAULT_HEADER = {
  title: '',
  status: null as string | null,
  progress: null as string | null,
  connection: 'open',
};

/** 위젯 앱 — 런처 + 패널(홈 · 대화 · 작업 목록) */
export function App({
  options,
  identityVersion,
}: {
  options: WidgetOptions;
  identityVersion: number;
}) {
  const api = useMemo(
    () => new WidgetApi(options.apiBase, options.widgetKey),
    [options.apiBase, options.widgetKey],
  );
  const [state, setState] = useState<BootState>({ status: 'loading' });
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>({ name: 'home' });
  const [badge, setBadge] = useState(0);
  const [header, setHeader] = useState(DEFAULT_HEADER);
  const [dark, setDark] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const store = options.storage;
  const viewKey = `theoneai:${options.widgetKey}:view`;

  const boot = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const token = options.identityToken ?? (await options.getIdentityToken?.()) ?? undefined;
      const result = await api.bootstrap(
        token ? { identityToken: token } : { anonymousId: anonymousId(store, options.widgetKey) },
      );
      setState({ status: 'ready', boot: result });
      setBadge(result.activeTasks.filter((t) => t.status === 'waiting_approval').length);
      const saved = safeParse(store?.getItem(viewKey));
      if (saved?.open) setOpen(true);
      if (saved?.view) setView(saved.view);
      else if (result.behavior.autoOpen) setOpen(true);
    } catch (err) {
      // 허용되지 않은 도메인 · 로그인 전(서명 토큰 필요) · 꺼진 위젯은 아무것도 보이지 않는다
      if (err instanceof ApiError && [401, 403].includes(err.status))
        setState({ status: 'hidden' });
      else
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : '연결하지 못했어요',
        });
    }
  }, [api, options, store, viewKey]);

  useEffect(() => {
    void boot();
  }, [boot, identityVersion]);

  useEffect(() => {
    try {
      store?.setItem(viewKey, JSON.stringify({ open, view }));
    } catch {
      // 저장소를 못 쓰면 기억하지 않는다
    }
  }, [open, view, store, viewKey]);

  const darkMode = state.status === 'ready' ? state.boot.theme.darkMode : 'system';
  useEffect(() => {
    if (darkMode !== 'system') {
      setDark(darkMode === 'dark');
      return;
    }
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    setDark(Boolean(mq?.matches));
    const on = (e: MediaQueryListEvent) => setDark(e.matches);
    mq?.addEventListener('change', on);
    return () => mq?.removeEventListener('change', on);
  }, [darkMode]);

  useEffect(() => {
    if (open) {
      setBadge(0);
      panelRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (view.name !== 'chat') setHeader(DEFAULT_HEADER);
  }, [view.name]);

  if (state.status === 'hidden' || state.status === 'loading') return null;
  if (state.status === 'error') {
    return (
      <div className="tw-root" data-position="bottom-right">
        <div className="launcher-wrap">
          <button
            type="button"
            className="launcher"
            aria-label="상담 위젯 다시 연결"
            onClick={() => void boot()}
          >
            <ChatBubble />
          </button>
        </div>
      </div>
    );
  }

  const b = state.boot;
  const brand = b.theme.brandColor;
  const onBrand = contrast(brand, '#FFFFFF') >= 4.5 ? '#FFFFFF' : '#16181D';
  const startChat = async (text: string, attachments: string[]) => {
    const conversation = await api.createConversation();
    const res = await api.send(conversation.id, [
      ...(text ? [{ type: 'text' as const, text }] : []),
      ...attachments.map((id) => ({ type: 'attachment' as const, artifactId: id })),
    ]);
    setView({ name: 'chat', conversationId: conversation.id, taskId: res.task.id });
  };
  const openTask = (t: TaskSummary) =>
    setView({ name: 'chat', conversationId: t.conversationId, taskId: t.id });

  return (
    <div
      className="tw-root"
      data-position={b.theme.position}
      data-theme={dark ? 'dark' : 'light'}
      style={{ ['--brand' as string]: brand, ['--on-brand' as string]: onBrand }}
    >
      {open && (
        <div
          ref={panelRef}
          tabIndex={-1}
          className="panel"
          role="dialog"
          aria-label={`${b.agent.name} 상담`}
        >
          <header className="head">
            {view.name === 'home' ? (
              <>
                <span className="agent-avatar" aria-hidden="true">
                  {b.agent.avatarUrl ? <img src={b.agent.avatarUrl} alt="" /> : <Spark />}
                </span>
                <div className="head-text">
                  <p className="head-title">{b.agent.name}</p>
                  <p className="head-sub online">
                    <span className="dot" />
                    연결됨
                  </p>
                </div>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="작업 목록"
                  onClick={() => setView({ name: 'tasks' })}
                >
                  <ListIcon />
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="홈으로"
                  onClick={() => setView({ name: 'home' })}
                >
                  <Back />
                </button>
                <div className="head-text">
                  <p className="head-title">
                    {view.name === 'tasks' ? '작업' : header.title || '대화'}
                  </p>
                  {view.name === 'chat' && (
                    <p className={`head-sub st-${header.status ?? 'idle'}`}>
                      <span className="dot" />
                      {header.connection === 'reconnecting'
                        ? '다시 연결하는 중'
                        : statusLine(header.status, header.progress)}
                    </p>
                  )}
                  {view.name === 'tasks' && <p className="head-sub">최근 30일</p>}
                </div>
              </>
            )}
            <button
              type="button"
              className="icon-btn"
              aria-label="새 대화"
              onClick={() => setView({ name: 'home' })}
            >
              <Plus />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="최소화"
              onClick={() => setOpen(false)}
            >
              <Minus />
            </button>
          </header>
          {view.name === 'home' && (
            <HomeView api={api} boot={b} onStart={startChat} onOpenTask={openTask} />
          )}
          {view.name === 'tasks' && <TasksView api={api} onOpen={openTask} />}
          {view.name === 'chat' && (
            <ChatView
              key={view.conversationId}
              api={api}
              boot={b}
              conversationId={view.conversationId}
              focusTaskId={view.taskId}
              onHeader={setHeader}
              onTaskEvent={(kind) => {
                if (!open || kind === 'approval') setBadge((n) => n + (open ? 0 : 1));
              }}
            />
          )}
        </div>
      )}
      <div className="launcher-wrap">
        <button
          type="button"
          className="launcher"
          aria-label={open ? '위젯 닫기' : `${b.agent.name} 열기`}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <Close size={22} /> : <ChatBubble />}
          {badge > 0 && !open && <span className="launcher-badge">{badge}</span>}
        </button>
      </div>
    </div>
  );
}

function anonymousId(store: Storage | null | undefined, key: string): string {
  const name = `theoneai:${key}:anon`;
  try {
    const existing = store?.getItem(name);
    if (existing && /^[A-Za-z0-9_-]{16,64}$/.test(existing)) return existing;
  } catch {
    // 저장소를 못 쓰면 이번 페이지에서만 쓰는 ID
  }
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  const id = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  try {
    store?.setItem(name, id);
  } catch {
    // 무시
  }
  return id;
}

function safeParse(value: string | null | undefined): { open?: boolean; view?: View } | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as { open?: boolean; view?: View };
  } catch {
    return null;
  }
}

/** WCAG 대비 — 브랜드 색 위 글자색 자동 보정 */
export function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const n = hex.replace('#', '');
    const rgb = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
    const [r, g, bl] = rgb.map((c) =>
      c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
    ) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}
