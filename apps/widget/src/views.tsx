import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDownIcon,
  CircleDotIcon,
  CircleIcon,
  CirclePauseIcon,
  ListTodoIcon,
  type LucideIcon,
  RotateCwIcon,
  ShieldAlertIcon,
  WifiOffIcon,
} from 'lucide-react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemGroup,
  ItemTitle,
} from '@/components/ui/item';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ui/message-scroller';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@/components/ui/trace';
import { formatDateTime, formatRelative, formatRemaining } from '../../shared/format';
import { ACTIVE_STATUSES, statusOf } from '../../shared/status';
import {
  ApiError,
  type Bootstrap,
  type ContentBlock,
  type MessageView,
  type TaskSummary,
  type WidgetApi,
} from './api';
import {
  ApprovalCard,
  Artifacts,
  ChatMessage,
  Composer,
  FailureCard,
  isSimplePlan,
  PausedCard,
  PlanCard,
  StatusBadge,
  StreamingMessage,
} from './components';
import { useTaskRun } from './run';

const BODY = 'flex min-h-0 flex-1 flex-col overflow-y-auto';
const FOOTER = 'flex flex-none flex-col gap-2 border-t px-3 pt-3 pb-2';

export function HomeView({
  api,
  boot,
  onStart,
  onOpenTask,
}: {
  api: WidgetApi;
  boot: Bootstrap;
  onStart: (text: string, attachments: string[]) => Promise<void>;
  onOpenTask: (task: TaskSummary) => void;
}) {
  const [text, setText] = useState('');
  const [active, setActive] = useState<TaskSummary[]>(boot.activeTasks);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .tasks('active')
      .then((r) => setActive(r.items))
      .catch(() => undefined);
  }, [api]);
  const welcome = boot.agent.welcomeMessage.trim() || '안녕하세요,\n무엇을 도와드릴까요?';
  return (
    <>
      <div className={`${BODY} gap-5 p-5`}>
        <div>
          <h2 className="text-xl leading-snug font-bold">
            {welcome.split('\n').map((line, i) => (
              <span key={i}>
                {i > 0 && <br />}
                {line}
              </span>
            ))}
          </h2>
          <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
            요청을 남기면 필요한 단계를 스스로 계획하고 연결된 도구로 실행해요. 중요한 작업은 실행
            전에 꼭 확인을 받아요.
          </p>
        </div>
        {active.length > 0 && <TaskQueue tasks={active} onOpen={onOpenTask} />}
      </div>
      <footer className={FOOTER}>
        {boot.suggestions.length > 0 && (
          <div
            role="group"
            aria-label="추천 작업"
            className="flex scroll-fade-x scrollbar-none gap-2 overflow-x-auto overscroll-x-contain"
          >
            {boot.suggestions.map((s) => (
              <Button
                key={s.skillName}
                variant="outline"
                size="sm"
                className="shrink-0 rounded-full"
                title={s.description || undefined}
                onClick={() => setText(s.prompt || s.title)}
              >
                {s.title}
              </Button>
            ))}
          </div>
        )}
        <ErrorLine error={error} />
        <Composer
          api={api}
          value={text}
          onChange={setText}
          placeholder="무엇이든 요청하세요…"
          allowAttachments={boot.behavior.attachments.types.length > 0}
          accept={boot.behavior.attachments.types}
          maxMb={boot.behavior.attachments.maxMb}
          onSubmit={async (value, attachments) => {
            setError(null);
            try {
              await onStart(value, attachments);
              setText('');
            } catch (err) {
              setError(err instanceof Error ? err.message : '보내지 못했어요');
            }
          }}
        />
        <Notice boot={boot} />
      </footer>
    </>
  );
}

const QUEUE: Record<string, { icon: LucideIcon; status?: 'running' | 'pending'; tone?: string }> = {
  queued: { icon: CircleIcon, status: 'pending' },
  running: { icon: CircleDotIcon, status: 'running' },
  waiting_approval: { icon: ShieldAlertIcon, tone: 'text-amber-600 dark:text-amber-400' },
  paused: { icon: CirclePauseIcon },
  recovering: { icon: RotateCwIcon, status: 'running' },
};

/** Queue — 홈의 진행 중인 작업 */
function TaskQueue({ tasks, onOpen }: { tasks: TaskSummary[]; onOpen: (t: TaskSummary) => void }) {
  return (
    <section aria-label="진행 중인 작업" className="rounded-xl border bg-card p-3">
      <Trace>
        <TraceCollapsible defaultOpen>
          <TraceCollapsibleTrigger>
            <TraceLine>
              <TraceIcon>
                <ListTodoIcon />
              </TraceIcon>
              <TraceTitle className="font-medium text-foreground">진행 중인 작업</TraceTitle>
              <TraceDescription>{tasks.length}</TraceDescription>
            </TraceLine>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent>
            <Trace>
              {tasks.map((t) => {
                const q = QUEUE[t.status] ?? QUEUE.queued!;
                return (
                  <button key={t.id} type="button" onClick={() => onOpen(t)}>
                    <TraceLine status={q.status}>
                      <TraceIcon className={q.tone}>
                        <q.icon />
                      </TraceIcon>
                      <TraceTitle>{t.title}</TraceTitle>
                      <TraceDescription>
                        {statusOf(t.status).label}
                        {t.progress.total ? ` · ${t.progress.completed}/${t.progress.total}` : ''}
                      </TraceDescription>
                    </TraceLine>
                  </button>
                );
              })}
            </Trace>
          </TraceCollapsibleContent>
        </TraceCollapsible>
      </Trace>
    </section>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p className="text-xs text-destructive" role="alert">
      {error}
    </p>
  );
}

export function Notice({ boot }: { boot: Bootstrap }) {
  return (
    <p className="text-center text-[11px] text-muted-foreground">
      {boot.behavior.noticeText}
      {boot.behavior.showPoweredBy && ' · Powered by TheOneAI'}
    </p>
  );
}

/** W-02 ~ W-04 — 대화 · 실행 스트리밍 · 승인 · 결과 */
export function ChatView({
  api,
  boot,
  conversationId,
  focusTaskId,
  onHeader,
  onTaskEvent,
}: {
  api: WidgetApi;
  boot: Bootstrap;
  conversationId: string;
  focusTaskId: string | null;
  onHeader: (header: {
    title: string;
    status: string | null;
    progress: string | null;
    connection: string;
  }) => void;
  onTaskEvent: (kind: 'completed' | 'approval' | 'failed') => void;
}) {
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [taskId, setTaskId] = useState<string | null>(focusTaskId);
  const [runKey, setRunKey] = useState(0);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);

  const append = useCallback((m: MessageView) => {
    setMessages((list) => (list.some((x) => x.id === m.id) ? list : [...list, m]));
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .messages(conversationId)
      .then((r) => {
        if (cancelled) return;
        const list = [...r.items].reverse();
        setMessages(list);
        if (!focusTaskId) {
          const last = [...list].reverse().find((m) => m.role === 'user' && m.taskId);
          if (last?.taskId) setTaskId(last.taskId);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api, conversationId, focusTaskId]);

  const { state: run, setApproval } = useTaskRun(
    api,
    taskId ? `${taskId}` : null,
    {
      onMessage: append,
      onTerminal: (status) => {
        if (status === 'completed') onTaskEvent('completed');
        if (status === 'failed') onTaskEvent('failed');
        if (status === 'waiting_approval') onTaskEvent('approval');
      },
    },
    runKey,
  );

  const active = ACTIVE_STATUSES.includes(run.status as never) && run.loaded;
  const total = isSimplePlan(run.plan) ? 0 : (run.plan?.steps.length ?? 0);
  const done = run.plan?.steps.filter((s) => s.status === 'succeeded').length ?? 0;
  useEffect(() => {
    onHeader({
      title: run.title || '새 대화',
      status: taskId && run.loaded ? run.status : null,
      progress: total
        ? `${Math.min(done + (run.status === 'running' ? 1 : 0), total)}/${total} 단계`
        : null,
      connection: run.connection,
    });
  }, [onHeader, run.title, run.status, run.loaded, run.connection, taskId, total, done]);

  // 계획 · 승인 · 결과는 그 작업의 첫 요청 바로 뒤에 둔다
  const triggerIndex = useMemo(
    () => messages.findIndex((m) => m.role === 'user' && m.taskId === taskId),
    [messages, taskId],
  );
  const before = triggerIndex >= 0 ? messages.slice(0, triggerIndex + 1) : messages;
  const after = triggerIndex >= 0 ? messages.slice(triggerIndex + 1) : [];

  const send = async (value: string, attachments: string[]) => {
    setError(null);
    try {
      if (active && taskId) {
        const res = await api.steer(taskId, value);
        append({
          id: res.messageId,
          role: 'user',
          content: [{ type: 'text', text: value }],
          taskId,
          createdAt: new Date().toISOString(),
        });
        setText('');
        return;
      }
      const content: ContentBlock[] = [
        ...(value ? [{ type: 'text' as const, text: value }] : []),
        ...attachments.map((id) => ({ type: 'attachment' as const, artifactId: id })),
      ];
      const res = await api.send(conversationId, content);
      append(res.message);
      setTaskId(res.task.id);
      setText('');
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'TASK_ALREADY_ACTIVE'
          ? '진행 중인 작업이 끝난 뒤 보내 주세요'
          : err instanceof Error
            ? err.message
            : '보내지 못했어요',
      );
    }
  };

  const resume = async (mode: 'checkpoint' | 'restart') => {
    if (!taskId) return;
    setError(null);
    try {
      await api.resume(taskId, mode);
      setRunKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : '재개하지 못했어요');
    }
  };

  // 답변을 보낸 뒤에도 서버가 검증하는 동안은 running 이다 — 그때 대기 문구를 다시 띄우지 않는다
  const answered = after.some((m) => m.role === 'assistant');
  const waiting = !taskId
    ? null
    : run.status === 'queued' && !run.plan
      ? '요청을 받았어요. 곧 시작해요…'
      : run.status === 'running' && !run.plan
        ? '어떻게 진행할지 계획하고 있어요…'
        : run.status === 'running' && isSimplePlan(run.plan) && !run.stream && !answered
          ? '답변을 준비하고 있어요…'
          : null;

  const message = (m: MessageView) => (
    <MessageScrollerItem key={m.id} messageId={m.id} scrollAnchor={m.role === 'user'}>
      <ChatMessage message={m} api={api} />
    </MessageScrollerItem>
  );

  return (
    <>
      {run.connection === 'reconnecting' && (
        <Alert role="status" className="flex-none rounded-none border-x-0 border-t-0 py-2">
          <WifiOffIcon />
          <AlertTitle className="text-xs font-normal">
            연결이 끊겨 다시 연결하는 중이에요. 작업은 서버에서 계속 실행돼요.
          </AlertTitle>
        </Alert>
      )}
      <MessageScrollerProvider autoScroll>
        <MessageScroller className="flex-1">
          <MessageScrollerViewport aria-label="대화 내용">
            <MessageScrollerContent aria-busy={Boolean(run.stream)} className="gap-5 px-4 py-5">
              {before.map(message)}
              {taskId && run.loaded && run.plan && !isSimplePlan(run.plan) && (
                <MessageScrollerItem>
                  <PlanCard plan={run.plan} revisions={run.revisions} tools={run.tools} />
                </MessageScrollerItem>
              )}
              {after.map(message)}
              {run.stream && (
                <MessageScrollerItem messageId={run.stream.messageId}>
                  <StreamingMessage text={run.stream.text} />
                </MessageScrollerItem>
              )}
              {waiting && (
                <MessageScrollerItem>
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Spinner aria-hidden="true" />
                    <span className="shimmer">{waiting}</span>
                  </p>
                </MessageScrollerItem>
              )}
              {run.status === 'recovering' && (
                <MessageScrollerItem>
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <RotateCwIcon className="size-4" aria-hidden="true" />
                    실행 서버가 바뀌어 마지막 체크포인트부터 자동으로 이어서 진행해요.
                  </p>
                </MessageScrollerItem>
              )}
              {run.approval && taskId && (
                <MessageScrollerItem>
                  <ApprovalCard
                    approval={run.approval}
                    api={api}
                    onDecided={(a) => setApproval(a)}
                  />
                </MessageScrollerItem>
              )}
              {run.status === 'completed' && taskId && run.result?.artifacts.length ? (
                <MessageScrollerItem>
                  <Artifacts artifacts={run.result.artifacts} api={api} />
                </MessageScrollerItem>
              ) : null}
              {run.status === 'paused' && (
                <MessageScrollerItem>
                  <PausedCard
                    reason={run.statusReason}
                    onResume={() => void resume('checkpoint')}
                  />
                </MessageScrollerItem>
              )}
              {run.status === 'failed' && run.failure && (
                <MessageScrollerItem>
                  <FailureCard failure={run.failure} onResume={(mode) => void resume(mode)} />
                </MessageScrollerItem>
              )}
              {run.status === 'cancelled' && (
                <MessageScrollerItem>
                  <p className="text-sm text-muted-foreground">작업을 중지했어요.</p>
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton>
            <ArrowDownIcon />
            <span className="sr-only">최신 메시지로 이동</span>
          </MessageScrollerButton>
        </MessageScroller>
      </MessageScrollerProvider>
      <footer className={FOOTER}>
        <ErrorLine error={error} />
        <Composer
          api={api}
          value={text}
          onChange={setText}
          placeholder={active ? '실행 중에도 추가로 지시할 수 있어요' : '이어서 요청하세요…'}
          allowAttachments={boot.behavior.attachments.types.length > 0}
          accept={boot.behavior.attachments.types}
          maxMb={boot.behavior.attachments.maxMb}
          onSubmit={send}
          stopButton={
            active && taskId
              ? {
                  busy: stopping,
                  onStop: () => {
                    setStopping(true);
                    void api.cancel(taskId).finally(() => setStopping(false));
                  },
                }
              : undefined
          }
        />
        <Notice boot={boot} />
      </footer>
    </>
  );
}

const FILTERS = [
  { key: 'all', label: '전체' },
  { key: 'active', label: '진행 중' },
  { key: 'completed', label: '완료' },
  { key: 'failed', label: '실패' },
] as const;
type Filter = (typeof FILTERS)[number]['key'];

/** W-05 — 작업 목록 · 복구 */
export function TasksView({
  api,
  onOpen,
}: {
  api: WidgetApi;
  onOpen: (task: TaskSummary) => void;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [groups, setGroups] = useState<Record<'active' | 'completed' | 'failed', TaskSummary[]>>({
    active: [],
    completed: [],
    failed: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0);

  const load = useCallback(async () => {
    try {
      const [a, c, f] = await Promise.all([
        api.tasks('active'),
        api.tasks('completed'),
        api.tasks('failed'),
      ]);
      setGroups({ active: a.items, completed: c.items, failed: f.items });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '불러오지 못했어요');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      tick((n) => n + 1);
    }, 1_000);
    const refresh = setInterval(() => void load(), 10_000);
    return () => {
      clearInterval(timer);
      clearInterval(refresh);
    };
  }, [load]);

  const all = [...groups.active, ...groups.completed, ...groups.failed].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  const list = filter === 'all' ? all : groups[filter];
  const resume = async (t: TaskSummary, mode: 'checkpoint' | 'restart') => {
    try {
      await api.resume(t.id, mode);
      onOpen(t);
    } catch (err) {
      setError(err instanceof Error ? err.message : '재개하지 못했어요');
    }
  };

  return (
    <Tabs
      value={filter}
      onValueChange={(v) => setFilter(v as Filter)}
      className="min-h-0 flex-1 gap-0"
    >
      <TabsList variant="line" aria-label="작업 상태" className="w-full flex-none border-b px-3">
        {FILTERS.map((f) => {
          const count = f.key === 'all' ? all.length : groups[f.key].length;
          return (
            <TabsTrigger key={f.key} value={f.key}>
              {f.label}{' '}
              {count > 0 && f.key !== 'completed' && (
                <Badge variant="secondary" className="h-4 min-w-4 px-1 tabular-nums">
                  {count}
                </Badge>
              )}
            </TabsTrigger>
          );
        })}
      </TabsList>
      <TabsContent value={filter} className={`${BODY} gap-3 p-4`}>
        <ErrorLine error={error} />
        {loading ? (
          <div role="status" aria-label="불러오는 중" className="flex flex-col gap-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-16 animate-pulse rounded-md bg-muted" />
            ))}
          </div>
        ) : list.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">아직 작업이 없어요.</p>
        ) : (
          <ItemGroup className="gap-2">
            {list.map((t) => (
              <Item
                key={t.id}
                role="listitem"
                variant="outline"
                size="sm"
                className="relative bg-card hover:bg-muted/40"
              >
                <ItemContent className="min-w-0">
                  <ItemTitle className="w-full">
                    <button
                      type="button"
                      className="min-w-0 truncate text-left outline-none after:absolute after:inset-0 after:rounded-md focus-visible:after:ring-3 focus-visible:after:ring-ring/50"
                      onClick={() => onOpen(t)}
                    >
                      {t.title}
                    </button>
                  </ItemTitle>
                  <ItemDescription className="text-xs">
                    {t.status === 'waiting_approval' && t.pendingApproval
                      ? `승인 대기 · ${formatRemaining(t.pendingApproval.expiresAt)}`
                      : t.status === 'completed' ||
                          t.status === 'failed' ||
                          t.status === 'cancelled'
                        ? formatDateTime(t.finishedAt ?? t.createdAt)
                        : `${t.progress.total ? `${t.progress.completed}/${t.progress.total} · ` : ''}${formatRelative(t.createdAt)}`}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <StatusBadge status={t.status} />
                </ItemActions>
                {t.status === 'recovering' && (
                  <ItemFooter>
                    <p className="text-xs text-muted-foreground">
                      실행 서버가 바뀌어 마지막 체크포인트부터 자동으로 이어서 진행해요.
                    </p>
                  </ItemFooter>
                )}
                {t.status === 'failed' && t.failure && (
                  <ItemFooter>
                    <p className="text-xs text-destructive">{t.failure.message}</p>
                  </ItemFooter>
                )}
                <TaskActions task={t} onOpen={onOpen} onResume={resume} />
              </Item>
            ))}
          </ItemGroup>
        )}
      </TabsContent>
    </Tabs>
  );
}

function TaskActions({
  task: t,
  onOpen,
  onResume,
}: {
  task: TaskSummary;
  onOpen: (t: TaskSummary) => void;
  onResume: (t: TaskSummary, mode: 'checkpoint' | 'restart') => Promise<void>;
}) {
  if (t.status === 'waiting_approval')
    return (
      <ItemFooter className="relative z-10 justify-start">
        <Button size="sm" onClick={() => onOpen(t)}>
          확인하기
        </Button>
      </ItemFooter>
    );
  if (t.status === 'paused')
    return (
      <ItemFooter className="relative z-10 justify-start">
        <Button size="sm" onClick={() => void onResume(t, 'checkpoint')}>
          이어서 진행
        </Button>
      </ItemFooter>
    );
  if (t.status === 'failed' && t.failure)
    return (
      <ItemFooter className="relative z-10 justify-start">
        {t.failure.resumable && (
          <Button size="sm" onClick={() => void onResume(t, 'checkpoint')}>
            멈춘 단계부터 재개
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => void onResume(t, 'restart')}>
          처음부터
        </Button>
      </ItemFooter>
    );
  return null;
}

export function statusLine(status: string | null, progress: string | null): string {
  if (!status) return '연결됨';
  const label = statusOf(status).label;
  return progress && ['running', 'waiting_approval', 'recovering'].includes(status)
    ? `${label} · ${progress}`
    : label;
}
