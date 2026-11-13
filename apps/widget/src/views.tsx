import { useCallback, useEffect, useMemo, useState } from 'react';
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
  Bubble,
  Composer,
  FailureCard,
  isSimplePlan,
  PlanCard,
  ResultCard,
  StatusBadge,
  StreamingBubble,
} from './components';
import { File as FileIcon, Refresh, Search, Spark } from './icons';
import { useTaskRun } from './run';

const SUGGESTION_ICONS = [Search, FileIcon, Refresh];

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
      <div className="body home">
        <div className="greeting">
          <h2>
            {welcome.split('\n').map((line, i) => (
              <span key={i}>
                {i > 0 && <br />}
                {line}
              </span>
            ))}
          </h2>
          <p>
            요청을 남기면 필요한 단계를 스스로 계획하고 연결된 도구로 실행해요. 중요한 작업은 실행
            전에 꼭 확인을 받아요.
          </p>
        </div>
        {active.length > 0 && (
          <section className="card list-card" aria-label="진행 중인 작업">
            <p className="list-head">진행 중인 작업 {active.length}</p>
            {active.map((t) => (
              <button key={t.id} type="button" className="task-row" onClick={() => onOpenTask(t)}>
                <span className="task-row-top">
                  <span className="task-title">{t.title}</span>
                  <StatusBadge status={t.status} />
                </span>
                {t.progress.total ? (
                  <span className="progress-line">
                    <span className="progress">
                      <span
                        style={{
                          width: `${Math.round((t.progress.completed / t.progress.total) * 100)}%`,
                        }}
                      />
                    </span>
                    <span className="mono muted">
                      {t.progress.completed}/{t.progress.total}
                    </span>
                  </span>
                ) : null}
              </button>
            ))}
          </section>
        )}
        {boot.suggestions.length > 0 && (
          <section className="suggestions" aria-label="추천 작업">
            <p className="section-label">이런 일을 맡길 수 있어요</p>
            {boot.suggestions.map((s, i) => {
              const Icon = SUGGESTION_ICONS[i % SUGGESTION_ICONS.length]!;
              return (
                <button
                  key={s.skillName}
                  type="button"
                  className="suggestion"
                  onClick={() => setText(s.prompt || s.title)}
                >
                  <span className="suggestion-icon">
                    <Icon />
                  </span>
                  <span className="suggestion-text">
                    <span className="suggestion-title">{s.title}</span>
                    <span className="muted">{s.description}</span>
                  </span>
                </button>
              );
            })}
          </section>
        )}
      </div>
      <footer className="foot">
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
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

export function Notice({ boot }: { boot: Bootstrap }) {
  return (
    <p className="notice-line">
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

  // 계획 카드 · 승인 · 결과는 그 작업의 첫 요청 바로 뒤에 둔다
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

  return (
    <>
      <div className="body chat" aria-live="off">
        {run.connection === 'reconnecting' && (
          <p className="banner" role="status">
            연결이 끊겨 다시 연결하는 중이에요. 작업은 서버에서 계속 실행돼요.
          </p>
        )}
        {before.map((m) => (
          <Bubble key={m.id} message={m} api={api} />
        ))}
        {taskId && run.loaded && <PlanCard run={run} />}
        {after.map((m) => (
          <Bubble key={m.id} message={m} api={api} />
        ))}
        {run.stream && <StreamingBubble text={run.stream.text} />}
        {taskId && run.status === 'queued' && !run.plan && (
          <p className="thinking">요청을 받았어요. 곧 시작해요…</p>
        )}
        {taskId && run.status === 'running' && !run.plan && (
          <p className="thinking">어떻게 진행할지 계획하고 있어요…</p>
        )}
        {taskId && run.status === 'running' && isSimplePlan(run.plan) && !run.stream && (
          <p className="thinking">답변을 준비하고 있어요…</p>
        )}
        {run.status === 'recovering' && (
          <p className="notice">
            실행 서버가 바뀌어 마지막 체크포인트부터 자동으로 이어서 진행해요.
          </p>
        )}
        {run.approval && taskId && (
          <ApprovalCard approval={run.approval} api={api} onDecided={(a) => setApproval(a)} />
        )}
        {run.status === 'completed' && run.result && taskId && (
          <ResultCard result={run.result} api={api} />
        )}
        {(run.status === 'failed' || run.status === 'paused') && (
          <FailureCard
            failure={run.failure}
            status={run.status}
            reason={run.statusReason}
            onResume={(mode) => void resume(mode)}
          />
        )}
        {run.status === 'cancelled' && <p className="notice">작업을 중지했어요.</p>}
      </div>
      <footer className="foot">
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
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

/** W-05 — 작업 목록 · 복구 */
export function TasksView({
  api,
  onOpen,
}: {
  api: WidgetApi;
  onOpen: (task: TaskSummary) => void;
}) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['key']>('all');
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
    <div className="body tasks">
      <div className="tabs" role="tablist" aria-label="작업 상태">
        {FILTERS.map((f) => {
          const count = f.key === 'all' ? all.length : groups[f.key].length;
          return (
            <button
              key={f.key}
              role="tab"
              type="button"
              aria-selected={filter === f.key}
              className={filter === f.key ? 'tab active' : 'tab'}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
              {count > 0 && f.key !== 'completed' ? ` ${count}` : ''}
            </button>
          );
        })}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <div className="skeleton-list" aria-label="불러오는 중">
          <span className="skeleton" />
          <span className="skeleton" />
          <span className="skeleton" />
        </div>
      ) : list.length === 0 ? (
        <p className="empty">아직 작업이 없어요.</p>
      ) : (
        <ul className="task-cards">
          {list.map((t) => (
            <li key={t.id} className="task-card">
              <button type="button" className="task-card-main" onClick={() => onOpen(t)}>
                <span className="task-row-top">
                  <span className="task-title">{t.title}</span>
                  <StatusBadge status={t.status} />
                </span>
                <span className="muted small">
                  {t.status === 'waiting_approval' && t.pendingApproval
                    ? `승인 대기 · ${formatRemaining(t.pendingApproval.expiresAt)}`
                    : t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled'
                      ? formatDateTime(t.finishedAt ?? t.createdAt)
                      : `${t.progress.total ? `${t.progress.completed}/${t.progress.total} · ` : ''}${formatRelative(t.createdAt)}`}
                </span>
              </button>
              {t.status === 'recovering' && (
                <p className="card-note">
                  실행 서버가 바뀌어 마지막 체크포인트부터 자동으로 이어서 진행해요.
                </p>
              )}
              {t.status === 'waiting_approval' && (
                <div className="card-actions">
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    onClick={() => onOpen(t)}
                  >
                    확인하기
                  </button>
                </div>
              )}
              {t.status === 'paused' && (
                <div className="card-actions">
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    onClick={() => void resume(t, 'checkpoint')}
                  >
                    이어서 진행
                  </button>
                </div>
              )}
              {t.status === 'failed' && t.failure && (
                <>
                  <p className="card-note">{t.failure.message}</p>
                  <div className="card-actions">
                    {t.failure.resumable && (
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        onClick={() => void resume(t, 'checkpoint')}
                      >
                        멈춘 단계부터 재개
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => void resume(t, 'restart')}
                    >
                      처음부터
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function statusLine(status: string | null, progress: string | null): string {
  if (!status) return '연결됨';
  const label = statusOf(status).label;
  return progress && ['running', 'waiting_approval', 'recovering'].includes(status)
    ? `${label} · ${progress}`
    : label;
}

export { Spark };
