import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ChevronLeftIcon,
  ListIcon,
  MessageCircleIcon,
  MinusIcon,
  PlusIcon,
  SparklesIcon,
  XIcon,
} from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { PortalContainerContext } from '@/lib/portal';
import { cn } from '@/lib/utils';
import { ApiError, type Bootstrap, type TaskSummary, WidgetApi } from './api';
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

/** 헤더 상태 줄 색 — 키는 작업 상태 (홈은 online) */
const TONE: Record<string, { text: string; dot: string }> = {
  online: { text: 'text-emerald-700 dark:text-emerald-400', dot: 'bg-emerald-500' },
  completed: { text: 'text-muted-foreground', dot: 'bg-emerald-500' },
  queued: { text: 'text-sky-700 dark:text-sky-300', dot: 'bg-sky-500' },
  running: { text: 'text-sky-700 dark:text-sky-300', dot: 'animate-pulse bg-sky-500' },
  waiting_approval: { text: 'text-amber-700 dark:text-amber-300', dot: 'bg-amber-500' },
  failed: { text: 'text-destructive', dot: 'bg-destructive' },
};
const IDLE_TONE = { text: 'text-muted-foreground', dot: 'bg-muted-foreground' };

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
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const store = options.storage;
  const viewKey = `theonewidget:${options.widgetKey}:view`;

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
        <Launcher label="상담 위젯 다시 연결" onClick={() => void boot()}>
          <MessageCircleIcon />
        </Launcher>
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
  const tone = view.name === 'chat' ? (TONE[header.status ?? ''] ?? IDLE_TONE) : TONE.online!;
  // 콘솔에서 올린 위젯 아이콘 — 위젯 헤더에 쓴다 (없으면 Agent 아바타 · 기본 아이콘). 런처 버튼은 늘 기본 아이콘
  const icon = b.theme.iconUrl ? `${api.base}${b.theme.iconUrl}` : null;

  return (
    <PortalContainerContext value={rootEl}>
      <div
        ref={setRootEl}
        className="tw-root"
        data-position={b.theme.position}
        data-theme={dark ? 'dark' : 'light'}
        style={{ ['--brand' as string]: brand, ['--on-brand' as string]: onBrand }}
      >
        {open && (
          <div
            ref={panelRef}
            tabIndex={-1}
            role="dialog"
            aria-label={`${b.agent.name} 상담`}
            className="fixed inset-0 z-[2147483000] flex flex-col overflow-hidden bg-background outline-none min-[481px]:inset-auto min-[481px]:right-5 min-[481px]:bottom-[88px] min-[481px]:h-[min(720px,calc(100vh-112px))] min-[481px]:w-[384px] min-[481px]:rounded-2xl min-[481px]:border min-[481px]:shadow-2xl min-[481px]:in-data-[position=bottom-left]:right-auto min-[481px]:in-data-[position=bottom-left]:left-5"
          >
            <header className="flex flex-none items-center gap-0.5 border-b py-2 pr-2 pl-3">
              {view.name === 'home' ? (
                <Avatar className="mr-2 size-9" aria-hidden="true">
                  {(icon ?? b.agent.avatarUrl) && (
                    <AvatarImage src={(icon ?? b.agent.avatarUrl)!} alt="" />
                  )}
                  <AvatarFallback className="bg-primary text-primary-foreground">
                    <SparklesIcon className="size-4.5" />
                  </AvatarFallback>
                </Avatar>
              ) : (
                <HeaderButton label="홈으로" onClick={() => setView({ name: 'home' })}>
                  <ChevronLeftIcon />
                </HeaderButton>
              )}
              <div className="min-w-0 flex-1 px-1">
                <p className="truncate text-[15px] leading-tight font-semibold">
                  {view.name === 'home'
                    ? b.agent.name
                    : view.name === 'tasks'
                      ? '작업'
                      : header.title || '대화'}
                </p>
                {view.name === 'tasks' ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">최근 30일</p>
                ) : (
                  <p className={cn('mt-0.5 flex items-center gap-1.5 text-xs', tone.text)}>
                    <span className={cn('size-1.5 shrink-0 rounded-full', tone.dot)} />
                    {view.name === 'home'
                      ? '연결됨'
                      : header.connection === 'reconnecting'
                        ? '다시 연결하는 중'
                        : statusLine(header.status, header.progress)}
                  </p>
                )}
              </div>
              {view.name === 'home' && (
                <HeaderButton label="작업 목록" onClick={() => setView({ name: 'tasks' })}>
                  <ListIcon />
                </HeaderButton>
              )}
              <HeaderButton label="새 대화" onClick={() => setView({ name: 'home' })}>
                <PlusIcon />
              </HeaderButton>
              <HeaderButton label="최소화" onClick={() => setOpen(false)}>
                <MinusIcon />
              </HeaderButton>
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
        <Launcher
          label={open ? '위젯 닫기' : `${b.agent.name} 열기`}
          expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={cn(open && 'max-[481px]:hidden')}
        >
          {open ? <XIcon /> : <MessageCircleIcon />}
          {badge > 0 && !open && (
            <span className="absolute -top-0.5 -right-0.5 flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-white bg-red-700 px-1 text-[11px] font-bold text-white">
              {badge}
            </span>
          )}
        </Launcher>
      </div>
    </PortalContainerContext>
  );
}

function Launcher({
  label,
  expanded,
  onClick,
  className,
  children,
}: {
  label: string;
  expanded?: boolean;
  onClick: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'fixed right-5 bottom-5 z-[2147483000] in-data-[position=bottom-left]:right-auto in-data-[position=bottom-left]:left-5',
        className,
      )}
    >
      <Button
        className="relative size-14 rounded-full shadow-lg [&_svg:not([class*='size-'])]:size-6"
        aria-label={label}
        aria-expanded={expanded}
        onClick={onClick}
      >
        {children}
      </Button>
    </div>
  );
}

function HeaderButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="text-muted-foreground [&_svg:not([class*='size-'])]:size-5"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function anonymousId(store: Storage | null | undefined, key: string): string {
  const name = `theonewidget:${key}:anon`;
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
