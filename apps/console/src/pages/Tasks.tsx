import { useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { formatDuration, formatRemaining } from '../../../shared/format';
import { ACTIVE_STATUSES } from '../../../shared/status';
import { useApi } from '../auth';
import {
  Badge,
  Card,
  type Column,
  DataTable,
  ErrorNotice,
  MoreButton,
  type Page,
  PageHeader,
  ShortId,
  StatusBadge,
  Tabs,
  Time,
  Toolbar,
  usePaged,
  useQuery,
} from '../ui';
import { Button } from '@/components/ui/button';

/* ───────────── 타입 (src/tasks/admin/tasks-admin.service.ts) ───────────── */

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'paused'
  | 'recovering'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** GET /v1/admin/tasks 한 줄 */
export interface AdminTaskRow {
  id: string;
  title: string;
  status: TaskStatus;
  progress: { completed: number; total: number | null };
  conversationId: string;
  pendingApproval: { id: string; expiresAt: string } | null;
  failure: { code: string; message: string; resumable: boolean } | null;
  createdAt: string;
  finishedAt: string | null;
  agentName: string;
  endUserPseudonym: string;
  elapsedMs: number;
  workerId: string | null;
  recoveryCount: number;
  agentVersion: number;
  costAmount: number;
  costCurrency: string | null;
}

export interface AgentOption {
  id: string;
  name: string;
  publishedVersion: number | null;
}

/** 작업 비용 — 1 미만은 소수 넷째 자리까지 */
function formatCost(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('ko-KR', {
      style: 'currency',
      currency,
      maximumFractionDigits: amount !== 0 && Math.abs(amount) < 1 ? 4 : 2,
    }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

/** 끝나지 않은 작업 (일시정지 포함) */
export function isActive(status: string): boolean {
  return (ACTIVE_STATUSES as string[]).includes(status);
}

/** 스스로 상태가 바뀌는 작업 — 화면을 주기적으로 새로 고친다 (일시정지는 사람이 재개해야 바뀜) */
export function isLive(status: string): boolean {
  return ['queued', 'running', 'waiting_approval', 'recovering'].includes(status);
}

/** 소요 시간 — 한 시간이 넘으면 "3시간 12분", 하루가 넘으면 "2일 4시간" */
export function formatElapsed(ms: number): string {
  if (ms >= 86_400_000) {
    const d = Math.floor(ms / 86_400_000);
    const h = Math.floor((ms % 86_400_000) / 3_600_000);
    return h ? `${d}일 ${h}시간` : `${d}일`;
  }
  if (ms >= 3_600_000) {
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    return m ? `${h}시간 ${m}분` : `${h}시간`;
  }
  return formatDuration(ms);
}

/** 실패 코드 → 운영자용 설명 */
export const FAILURE_LABEL: Record<string, string> = {
  TOOL_TIMEOUT: 'Tool 시간 초과',
  INVALID_ARGUMENTS: '인자 검증 실패',
  TOKEN_BUDGET_EXCEEDED: '토큰 예산 초과',
  STEP_LIMIT_EXCEEDED: '단계 한도 초과',
  TIME_LIMIT_EXCEEDED: '시간 한도 초과',
  BUDGET_EXCEEDED: '월 비용 한도 초과',
  PERMISSION_DENIED: '권한 거부',
  APPROVAL_REJECTED: '승인 거절',
  APPROVAL_EXPIRED: '승인 만료',
  MODEL_ERROR: '모델 호출 실패',
  RUNTIME_ERROR: '실행 오류',
  RECOVERY_LIMIT_EXCEEDED: '복구 한도 초과',
};

export function failureLabel(code: string | null | undefined): string {
  if (!code) return '실행 오류';
  return FAILURE_LABEL[code] ?? code;
}

/** 진행률 막대 + n/m 단계 */
export function Progress({ completed, total }: { completed: number; total: number | null }) {
  const ratio = total ? Math.min(1, completed / total) : 0;
  return (
    <div className="tk-progress" title={total ? `${completed}/${total} 단계` : `${completed} 단계`}>
      <span className="tk-progress-track" aria-hidden="true">
        <span className="tk-progress-fill" style={{ width: `${Math.round(ratio * 100)}%` }} />
      </span>
      <span className="tk-progress-text">
        {completed}/{total ?? '?'}
      </span>
    </div>
  );
}

/** 상태 배지 + 보조 정보(승인 만료 · 실패 원인 · 복구 횟수) */
export function TaskStatusCell({ row }: { row: AdminTaskRow }) {
  return (
    <div className="tk-status-cell">
      <StatusBadge status={row.status} />
      {row.pendingApproval && (
        <span className="cell-sub">{formatRemaining(row.pendingApproval.expiresAt)}</span>
      )}
      {row.failure && <span className="cell-sub tk-danger">{failureLabel(row.failure.code)}</span>}
      {row.recoveryCount > 0 && <span className="cell-sub">복구 {row.recoveryCount}회</span>}
    </div>
  );
}

export function useAgents() {
  const api = useApi();
  return useQuery(() => api.get<AgentOption[]>('/v1/admin/agents'), []);
}

export function AgentSelect({
  value,
  onChange,
  agents,
}: {
  value: string;
  onChange: (id: string) => void;
  agents: AgentOption[] | undefined;
}) {
  return (
    <select
      className="input"
      aria-label="Agent"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">모든 Agent</option>
      {(agents ?? []).map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
        </option>
      ))}
    </select>
  );
}

/* ───────────── C-02 작업 목록 ───────────── */

type StatusTab = 'all' | TaskStatus;

const PAGE_SIZE = 25;

const TABS: { id: StatusTab; label: string }[] = [
  { id: 'all', label: '전체' },
  { id: 'running', label: '실행 중' },
  { id: 'waiting_approval', label: '승인 대기' },
  { id: 'paused', label: '일시정지' },
  { id: 'recovering', label: '복구 중' },
  { id: 'queued', label: '대기' },
  { id: 'completed', label: '완료' },
  { id: 'failed', label: '실패' },
  { id: 'cancelled', label: '취소' },
];

export function TasksPage() {
  const api = useApi();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = (params.get('status') as StatusTab | null) ?? 'all';
  const agentId = params.get('agentId') ?? '';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const agents = useAgents();

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const list = usePaged<AdminTaskRow>(
    (cursor) =>
      api.get<Page<AdminTaskRow>>('/v1/admin/tasks', {
        status: status === 'all' ? undefined : status,
        agentId: agentId || undefined,
        // 날짜는 사용자 시간대의 하루 시작 · 다음 날 시작으로
        from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
        to: to
          ? new Date(new Date(`${to}T00:00:00`).getTime() + 86_400_000).toISOString()
          : undefined,
        limit: PAGE_SIZE,
        cursor,
      }),
    [status, agentId, from, to],
  );

  // 실행 중인 작업이 보이면 10초마다 첫 페이지를 새로 고침 ("더 보기"로 펼쳤으면 멈춤)
  const anyLive = list.items.some((r) => isLive(r.status));
  const pollable = anyLive && list.items.length <= PAGE_SIZE;
  const { reload } = list;
  useEffect(() => {
    if (!pollable) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void reload();
    }, 10_000);
    return () => clearInterval(timer);
  }, [pollable, reload]);

  const columns: Column<AdminTaskRow>[] = [
    {
      key: 'title',
      header: '작업',
      render: (r) => (
        <div className="tk-task-cell">
          <Link
            to={`/tasks/${r.id}`}
            className="cell-title"
            onClick={(e) => e.stopPropagation()}
            title={r.title}
          >
            {r.title}
          </Link>
          <span className="cell-sub">
            <ShortId id={r.id} /> · {r.agentName} v{r.agentVersion}
          </span>
        </div>
      ),
    },
    { key: 'status', header: '상태', width: '150px', render: (r) => <TaskStatusCell row={r} /> },
    {
      key: 'user',
      header: '사용자',
      width: '120px',
      render: (r) => <span className="tk-mono">{r.endUserPseudonym}</span>,
    },
    {
      key: 'progress',
      header: '진행',
      width: '130px',
      render: (r) => <Progress completed={r.progress.completed} total={r.progress.total} />,
    },
    {
      key: 'elapsed',
      header: '소요',
      width: '90px',
      align: 'right',
      render: (r) => <span className="num tk-nowrap-text">{formatElapsed(r.elapsedMs)}</span>,
    },
    {
      key: 'cost',
      header: '비용',
      width: '100px',
      align: 'right',
      render: (r) => (
        <span className="num tk-nowrap-text">
          {r.costCurrency ? formatCost(r.costAmount, r.costCurrency) : '—'}
        </span>
      ),
    },
    {
      key: 'created',
      header: '시작',
      width: '110px',
      render: (r) => <Time iso={r.createdAt} />,
    },
  ];

  const filtered = Boolean(agentId || from || to);

  return (
    <>
      <PageHeader
        title="작업"
        description="위젯 사용자의 요청으로 시작된 Agent 실행 기록입니다. 행을 누르면 실행 트레이스를 봅니다."
      />
      <Tabs
        label="작업 상태"
        tabs={TABS}
        value={status}
        onChange={(id) => setParam('status', id === 'all' ? '' : id)}
      />
      <Toolbar>
        <AgentSelect
          agents={agents.data}
          value={agentId}
          onChange={(v) => setParam('agentId', v)}
        />
        <label className="tk-date-filter">
          <span>시작일</span>
          <input
            type="date"
            className="input"
            aria-label="시작일부터"
            value={from}
            max={to || undefined}
            onChange={(e) => setParam('from', e.target.value)}
          />
        </label>
        <span className="muted">~</span>
        <label className="tk-date-filter">
          <input
            type="date"
            className="input"
            aria-label="종료일까지"
            value={to}
            min={from || undefined}
            onChange={(e) => setParam('to', e.target.value)}
          />
        </label>
        {filtered && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const next = new URLSearchParams(params);
              ['agentId', 'from', 'to'].forEach((k) => next.delete(k));
              setParams(next, { replace: true });
            }}
          >
            필터 지우기
          </Button>
        )}
        <div className="spacer" />
        {pollable && <Badge tone="info">10초마다 새로 고침</Badge>}
        <Button
          variant="outline"
          size="sm"
          onClick={() => void list.reload()}
          loading={list.loading && !!list.items.length}
        >
          새로 고침
        </Button>
      </Toolbar>
      <ErrorNotice error={list.error} onRetry={() => void list.reload()} />
      <Card flush>
        <DataTable
          label="작업 목록"
          columns={columns}
          rows={list.items}
          rowKey={(r) => r.id}
          loading={list.loading}
          onRowClick={(r) => navigate(`/tasks/${r.id}`)}
          empty={
            status === 'all' && !filtered
              ? '아직 작업이 없어요. 위젯에서 요청이 들어오면 여기에 표시됩니다.'
              : '조건에 맞는 작업이 없어요.'
          }
        />
        <MoreButton
          hasMore={list.hasMore}
          loading={list.moreLoading}
          onClick={() => void list.loadMore()}
        />
      </Card>
    </>
  );
}
