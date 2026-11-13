/**
 * C-07 승인 · 권한 정책 — 승인 대기 큐(대리 결정) · 처리 이력 · 등급별 기본 정책 · 조건 규칙.
 * API: docs/api-spec.md §4.7 (GET/POST /v1/admin/approvals…, tool-policies, tool-policy-rules)
 */
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { formatDateTime, formatRemaining } from '../../../shared/format';
import { LEVEL, RISK } from '../../../shared/status';
import { ApiError } from '../api';
import { useApi, useAuth } from '../auth';
import {
  Badge,
  Button,
  Card,
  type Column,
  ConfirmModal,
  DataTable,
  Empty,
  ErrorNotice,
  Field,
  Json,
  KeyValue,
  Loading,
  Modal,
  MoreButton,
  Mono,
  Notice,
  type Page,
  PageHeader,
  Tabs,
  Time,
  Toggle,
  Toolbar,
  useAction,
  usePaged,
  useQuery,
  useToast,
} from '../ui';
import './approvals.css';

/* ───────────── 타입 (src/approvals/admin/*, src/tasks/approval-views.ts) ───────────── */

type Level = 'read' | 'write' | 'external_send' | 'delete' | 'financial';
type Approver = 'user' | 'operator' | 'user_and_operator';
type Mode = 'auto' | 'require_approval' | 'always_approval' | 'block';

interface ApprovalRow {
  id: string;
  taskId: string;
  toolName: string;
  toolSource: 'mcp' | 'sandbox' | 'builtin' | 'skill_script';
  permissionLevel: Level;
  riskLevel: 'low' | 'medium' | 'high';
  summary: string;
  args: Array<{ label: string; value: string }>;
  rawArgs: Record<string, unknown>;
  reason: string;
  requiredApprover: Approver;
  allowTaskScope: boolean;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';
  waitingFor: Approver | null;
  expiresAt: string;
  taskTitle: string;
  conversationId: string;
  endUserPseudonym: string;
  user: { decision: string; comment: string | null; at: string } | null;
  operator: {
    decision: string;
    comment: string | null;
    at: string;
    memberId: string | null;
    memberName: string | null;
  } | null;
  createdAt: string;
  resolvedAt: string | null;
}

interface ToolPolicy {
  level: Level;
  mode: Mode;
  approver: Approver | null;
  allowTaskScope: boolean;
  ttlSeconds: number;
  isDefault: boolean;
  updatedAt: string | null;
}

type CompareOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains' | 'matches';
type RuleCondition =
  | { all: RuleCondition[] }
  | { any: RuleCondition[] }
  | { arg: string; op: CompareOp; value: unknown }
  | { argDomainNotIn: string; domains: string[] }
  | { timeOutside: { days: number[]; from: string; to: string; tz: string } };

interface ToolPolicyRule {
  id: string;
  name: string;
  description: string | null;
  toolPattern: string | null;
  level: Level | null;
  condition: unknown;
  effect: 'require_operator' | 'block';
  priority: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

type TabId = 'pending' | 'history' | 'policies' | 'rules';
const TAB_IDS: TabId[] = ['pending', 'history', 'policies', 'rules'];

const LEVELS: Level[] = ['read', 'write', 'external_send', 'delete', 'financial'];
const LEVEL_HINT: Record<Level, string> = {
  read: '조회 · 검색처럼 아무것도 바꾸지 않는 Tool',
  write: '데이터를 만들거나 바꾸는 Tool',
  external_send: '메일 · 메시지 등 밖으로 보내는 Tool',
  delete: '데이터를 지우는 Tool — 매번 묻는다',
  financial: '결제 · 환불 등 돈이 오가는 Tool — 매번 묻는다',
};
const MODE_LABEL: Record<Mode, string> = {
  auto: '자동 실행',
  require_approval: '승인 필요',
  always_approval: '항상 승인 (범위 승인 불가)',
  block: '차단',
};
const MODE_RANK: Record<Mode, number> = {
  auto: 0,
  require_approval: 1,
  always_approval: 2,
  block: 3,
};
const APPROVER_LABEL: Record<Approver, string> = {
  user: '사용자',
  operator: '운영자',
  user_and_operator: '사용자 + 운영자',
};
const APPROVER_RANK: Record<Approver, number> = { user: 0, operator: 1, user_and_operator: 2 };
const ALWAYS_ASK: Level[] = ['delete', 'financial'];
const TTL_OPTIONS = [300, 900, 1800, 3600, 4 * 3600, 24 * 3600];
const SOURCE_LABEL: Record<ApprovalRow['toolSource'], string> = {
  mcp: 'MCP',
  sandbox: 'Sandbox',
  builtin: '내장',
  skill_script: 'Skill 스크립트',
};
const STATUS_TONE: Record<ApprovalRow['status'], 'warning' | 'success' | 'danger' | 'neutral'> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
  expired: 'neutral',
  cancelled: 'neutral',
};
const STATUS_LABEL: Record<ApprovalRow['status'], string> = {
  pending: '대기',
  approved: '승인됨',
  rejected: '거절됨',
  expired: '만료',
  cancelled: '취소됨',
};

/* ───────────── 페이지 ───────────── */

export function ApprovalsPage() {
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab') as TabId | null;
  const tab: TabId = raw && TAB_IDS.includes(raw) ? raw : 'pending';
  // 탭 배지 — 대기 건수 · 규칙 수
  const pendingCount = useQuery(
    () => api.get<Page<ApprovalRow>>('/v1/admin/approvals', { status: 'pending', limit: 100 }),
    [],
    { pollMs: 15_000 },
  );
  const setTab = (id: TabId) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (id === 'pending') next.delete('tab');
        else next.set('tab', id);
        return next;
      },
      { replace: true },
    );

  return (
    <>
      <PageHeader
        title="승인 · 권한 정책"
        description="Agent 가 위험한 Tool 을 쓰기 전에 받는 승인과, 어떤 Tool 에 승인이 필요한지 정합니다."
      />
      <Tabs<TabId>
        label="승인 · 권한 정책"
        value={tab}
        onChange={setTab}
        tabs={[
          {
            id: 'pending',
            label: '승인 대기',
            count: pendingCount.data?.items.length || undefined,
          },
          { id: 'history', label: '처리 이력' },
          { id: 'policies', label: '등급별 정책' },
          { id: 'rules', label: '조건 규칙' },
        ]}
      />
      {tab === 'pending' && <PendingTab onChanged={() => void pendingCount.reload()} />}
      {tab === 'history' && <HistoryTab />}
      {tab === 'policies' && <PoliciesTab />}
      {tab === 'rules' && <RulesTab />}
    </>
  );
}

/* ───────────── 승인 대기 ───────────── */

function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function PendingTab({ onChanged }: { onChanged: () => void }) {
  const api = useApi();
  const list = usePaged(
    (cursor) =>
      api.get<Page<ApprovalRow>>('/v1/admin/approvals', { status: 'pending', limit: 20, cursor }),
    [],
    { pollMs: 10_000 },
  );
  const now = useNow();
  const [deciding, setDeciding] = useState<{
    row: ApprovalRow;
    decision: 'approve' | 'reject';
  } | null>(null);
  const toast = useToast();
  const decide = useAction((id: string, decision: 'approve' | 'reject', comment: string) =>
    api.post<ApprovalRow>(`/v1/admin/approvals/${id}/decision`, { decision, comment }),
  );

  const submit = async (comment: string) => {
    if (!deciding) return;
    const result = await decide.run(deciding.row.id, deciding.decision, comment);
    if (!result) return;
    setDeciding(null);
    toast(
      result.status === 'pending'
        ? '운영자 승인을 기록했어요 — 사용자 승인을 기다립니다'
        : result.status === 'approved'
          ? '승인했어요 — 작업이 이어서 실행됩니다'
          : '거절했어요 — 사유가 Agent 에게 전달됩니다',
    );
    void list.reload();
    onChanged();
  };

  if (list.loading && list.items.length === 0) return <Loading />;
  return (
    <>
      <ErrorNotice error={list.error} onRetry={() => void list.reload()} />
      {list.items.length === 0 && !list.error ? (
        <Card>
          <Empty title="기다리는 승인 요청이 없어요">
            승인이 필요한 Tool 을 Agent 가 쓰려고 하면 여기에 나타나요. 10초마다 새로 확인합니다.
          </Empty>
        </Card>
      ) : (
        <div className="approval-queue">
          {list.items.map((row) => (
            <PendingCard
              key={row.id}
              row={row}
              now={now}
              onDecide={(decision) => {
                decide.reset();
                setDeciding({ row, decision });
              }}
            />
          ))}
        </div>
      )}
      <MoreButton hasMore={list.hasMore} loading={list.moreLoading} onClick={list.loadMore} />
      <ConfirmModal
        open={deciding !== null}
        title={deciding?.decision === 'approve' ? '운영자로 승인' : '운영자로 거절'}
        confirmLabel={deciding?.decision === 'approve' ? '승인' : '거절'}
        danger={deciding?.decision === 'reject'}
        requireReason
        reasonLabel={
          deciding?.decision === 'approve' ? '승인 메모 (감사 로그에 남아요)' : '거절 사유'
        }
        pending={decide.pending}
        error={decisionError(decide.error)}
        onClose={() => setDeciding(null)}
        onConfirm={(reason) => void submit(reason)}
        body={
          deciding && (
            <div className="decide-summary">
              <p>
                <Mono>{deciding.row.toolName}</Mono> — {deciding.row.summary}
              </p>
              {deciding.decision === 'approve' &&
                deciding.row.waitingFor === 'user_and_operator' && (
                  <Notice tone="info">
                    사용자와 운영자 모두 승인해야 하는 요청이에요. 운영자 승인을 남기면 사용자
                    승인을 기다립니다.
                  </Notice>
                )}
              {deciding.decision === 'approve' && deciding.row.waitingFor === 'operator' && (
                <Notice tone="info">승인하면 작업이 이 Tool 호출부터 바로 이어서 실행돼요.</Notice>
              )}
              {deciding.decision === 'approve' && deciding.row.requiredApprover === 'user' && (
                <Notice tone="info">
                  사용자 승인 요청이지만 운영자가 대신 승인할 수 있어요. 사용자 화면의 승인 카드는
                  닫힙니다.
                </Notice>
              )}
              {deciding.decision === 'reject' && (
                <p className="muted">
                  거절 사유는 Agent 에게 데이터로 전달돼 다른 방법을 찾게 해요.
                </p>
              )}
            </div>
          )
        }
      />
    </>
  );
}

function decisionError(error: Error | null): Error | null {
  if (!(error instanceof ApiError)) return error;
  const messages: Record<string, string> = {
    APPROVAL_EXPIRED:
      '승인 요청이 만료됐어요. 작업은 일시정지됐고, 재개하면 다시 승인을 요청합니다.',
    APPROVAL_ALREADY_RESOLVED: '이미 처리된 요청이에요. 목록을 새로 고칩니다.',
    FORBIDDEN_APPROVER: '이 요청을 결정할 권한이 없어요.',
    FORBIDDEN: '운영자(Operator) 이상만 대리 결정할 수 있어요.',
  };
  return messages[error.code] ? new Error(messages[error.code]) : error;
}

function waitingLabel(row: ApprovalRow): string {
  switch (row.waitingFor) {
    case 'operator':
      return row.requiredApprover === 'user_and_operator'
        ? '사용자 승인 완료 · 운영자 결정 필요'
        : '운영자 결정 필요';
    case 'user':
      return row.requiredApprover === 'user_and_operator'
        ? '운영자 승인 완료 · 사용자 결정 대기'
        : '사용자 결정 대기 (대리 결정 가능)';
    case 'user_and_operator':
      return '사용자 · 운영자 모두 결정 필요';
    default:
      return '—';
  }
}

function PendingCard({
  row,
  now,
  onDecide,
}: {
  row: ApprovalRow;
  now: number;
  onDecide: (decision: 'approve' | 'reject') => void;
}) {
  const { can } = useAuth();
  const risk = RISK[row.riskLevel] ?? { label: row.riskLevel, bg: '', fg: '' };
  const remainingMs = new Date(row.expiresAt).getTime() - now;
  const urgent = remainingMs < 3 * 60_000;
  const needsOperator = row.waitingFor === 'operator' || row.waitingFor === 'user_and_operator';
  const shownArgs = row.args.slice(0, 6);
  return (
    <article
      className={`approval-item risk-${row.riskLevel}${needsOperator ? ' needs-operator' : ''}`}
      aria-label={`${row.toolName} 승인 요청`}
    >
      <header className="approval-item-head">
        <div className="row">
          <span className="badge" style={{ background: risk.bg, color: risk.fg }}>
            위험도 {risk.label}
          </span>
          <Badge tone="neutral">{LEVEL[row.permissionLevel] ?? row.permissionLevel}</Badge>
          <Badge tone="neutral">{SOURCE_LABEL[row.toolSource]}</Badge>
          <Mono>{row.toolName}</Mono>
        </div>
        <span
          className={`approval-expiry${urgent ? ' urgent' : ''}`}
          title={`만료 ${formatDateTime(row.expiresAt)}`}
        >
          {formatRemaining(row.expiresAt, now)}
        </span>
      </header>
      <h3 className="approval-item-title">{row.summary}</h3>
      {row.reason && row.reason !== row.summary && <p className="approval-reason">{row.reason}</p>}
      <div className="approval-item-body">
        <div className="approval-args">
          {shownArgs.length > 0 ? (
            <dl>
              {shownArgs.map((a) => (
                <div key={a.label}>
                  <dt>{a.label}</dt>
                  <dd>{a.value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="muted">인자 없음</p>
          )}
          {row.args.length > shownArgs.length && (
            <p className="muted small">외 {row.args.length - shownArgs.length}개 인자</p>
          )}
          <details className="raw-args">
            <summary>실행 인자 원문 (JSON)</summary>
            <Json value={row.rawArgs} />
          </details>
        </div>
        <dl className="approval-meta">
          <div>
            <dt>작업</dt>
            <dd>
              <Link to={`/tasks/${row.taskId}`}>{row.taskTitle || '제목 없음'}</Link>
            </dd>
          </div>
          <div>
            <dt>요청 사용자</dt>
            <dd>
              <Mono>{row.endUserPseudonym}</Mono>
            </dd>
          </div>
          <div>
            <dt>결정</dt>
            <dd>
              <span className={needsOperator ? 'waiting operator' : 'waiting'}>
                {waitingLabel(row)}
              </span>
            </dd>
          </div>
          {row.user && (
            <div>
              <dt>사용자 결정</dt>
              <dd>
                {row.user.decision === 'approve' ? '승인' : '거절'} · <Time iso={row.user.at} />
                {row.user.comment && <p className="muted">“{row.user.comment}”</p>}
              </dd>
            </div>
          )}
          <div>
            <dt>요청 시각</dt>
            <dd>
              <Time iso={row.createdAt} />
            </dd>
          </div>
        </dl>
      </div>
      <footer className="approval-item-foot">
        {can('operator') ? (
          <>
            <Button variant="danger" onClick={() => onDecide('reject')}>
              거절
            </Button>
            <Button variant="primary" onClick={() => onDecide('approve')}>
              운영자로 승인
            </Button>
          </>
        ) : (
          <span className="muted small">대리 결정은 Operator 이상만 할 수 있어요</span>
        )}
      </footer>
    </article>
  );
}

/* ───────────── 처리 이력 ───────────── */

function HistoryTab() {
  const api = useApi();
  const [toolInput, setToolInput] = useState('');
  const [toolName, setToolName] = useState('');
  const [open, setOpen] = useState<ApprovalRow | null>(null);
  const list = usePaged(
    (cursor) =>
      api.get<Page<ApprovalRow>>('/v1/admin/approvals/history', {
        toolName: toolName || undefined,
        limit: 30,
        cursor,
      }),
    [toolName],
  );

  const columns: Column<ApprovalRow>[] = [
    {
      key: 'at',
      header: '처리 시각',
      width: '130px',
      render: (r) => <Time iso={r.resolvedAt ?? r.createdAt} />,
    },
    {
      key: 'tool',
      header: 'Tool',
      render: (r) => (
        <div className="ident">
          <Mono>{r.toolName}</Mono>
          <div className="cell-sub">
            {LEVEL[r.permissionLevel] ?? r.permissionLevel} · 위험도{' '}
            {RISK[r.riskLevel]?.label ?? r.riskLevel}
          </div>
        </div>
      ),
    },
    {
      key: 'task',
      header: '작업',
      render: (r) => (
        <div className="cell-title">
          <Link to={`/tasks/${r.taskId}`} onClick={(e) => e.stopPropagation()}>
            {r.taskTitle || '제목 없음'}
          </Link>
          <div className="cell-sub">{r.endUserPseudonym}</div>
        </div>
      ),
    },
    {
      key: 'status',
      header: '결과',
      width: '90px',
      render: (r) => <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>,
    },
    { key: 'by', header: '결정', render: (r) => <DecidedBy row={r} /> },
  ];

  return (
    <Card flush>
      <div className="card-toolbar">
        <Toolbar>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              setToolName(toolInput.trim());
            }}
          >
            <input
              className="input"
              aria-label="Tool 이름으로 거르기"
              placeholder="Tool 이름 (정확히 일치)"
              value={toolInput}
              onChange={(e) => setToolInput(e.target.value)}
              style={{ width: 320 }}
            />
            <Button type="submit">거르기</Button>
            {toolName && (
              <Button
                variant="ghost"
                onClick={() => {
                  setToolInput('');
                  setToolName('');
                }}
              >
                전체 보기
              </Button>
            )}
          </form>
        </Toolbar>
      </div>
      <ErrorNotice error={list.error} onRetry={() => void list.reload()} />
      <div className="wide-table history-table">
        <DataTable
          label="승인 처리 이력"
          columns={columns}
          rows={list.items}
          rowKey={(r) => r.id}
          loading={list.loading}
          onRowClick={setOpen}
          empty={toolName ? `${toolName} 의 처리 이력이 없어요` : '처리된 승인 요청이 아직 없어요'}
        />
      </div>
      <MoreButton hasMore={list.hasMore} loading={list.moreLoading} onClick={list.loadMore} />
      <Modal
        open={open !== null}
        wide
        title="승인 요청 상세"
        onClose={() => setOpen(null)}
        footer={<Button onClick={() => setOpen(null)}>닫기</Button>}
      >
        {open && <ApprovalDetail row={open} />}
      </Modal>
    </Card>
  );
}

function DecidedBy({ row }: { row: ApprovalRow }) {
  const parts: ReactNode[] = [];
  if (row.user)
    parts.push(
      <div key="u">
        사용자 {row.user.decision === 'approve' ? '승인' : '거절'}
        {row.user.comment && <span className="muted"> — “{row.user.comment}”</span>}
      </div>,
    );
  if (row.operator)
    parts.push(
      <div key="o">
        {row.operator.memberName ?? '운영자'}{' '}
        {row.operator.decision === 'approve' ? '승인' : '거절'}
        {row.operator.comment && <span className="muted"> — “{row.operator.comment}”</span>}
      </div>,
    );
  if (parts.length === 0)
    return (
      <span className="muted">
        {row.status === 'expired'
          ? '응답 없이 만료'
          : row.status === 'cancelled'
            ? '작업 중지로 취소'
            : '—'}
      </span>
    );
  return <div className="decided-by">{parts}</div>;
}

function ApprovalDetail({ row }: { row: ApprovalRow }) {
  return (
    <div className="stack">
      <div className="row">
        <Badge tone={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</Badge>
        <Mono>{row.toolName}</Mono>
      </div>
      <p className="approval-item-title">{row.summary}</p>
      <KeyValue
        items={[
          ['작업', <Link to={`/tasks/${row.taskId}`}>{row.taskTitle || '제목 없음'}</Link>],
          ['요청 사용자', <Mono>{row.endUserPseudonym}</Mono>],
          ['권한 등급', LEVEL[row.permissionLevel] ?? row.permissionLevel],
          ['위험도', RISK[row.riskLevel]?.label ?? row.riskLevel],
          ['필요한 승인', APPROVER_LABEL[row.requiredApprover]],
          ['요청 이유', row.reason || '—'],
          ['결정', <DecidedBy row={row} />],
          ['요청 시각', formatDateTime(row.createdAt)],
          ['처리 시각', formatDateTime(row.resolvedAt)],
          ['만료 시각', formatDateTime(row.expiresAt)],
        ]}
      />
      <Json value={row.rawArgs} />
    </div>
  );
}

/* ───────────── 등급별 정책 ───────────── */

function strictness(p: Pick<ToolPolicy, 'mode' | 'approver' | 'allowTaskScope'>): number[] {
  return [
    MODE_RANK[p.mode],
    p.mode === 'require_approval' || p.mode === 'always_approval'
      ? APPROVER_RANK[p.approver ?? (p.mode === 'always_approval' ? 'user_and_operator' : 'user')]
      : 0,
    p.allowTaskScope ? 0 : 1,
  ];
}

/** 같으면 0, 강화면 1, 완화면 -1, 섞이면 2 */
function compareStrictness(before: ToolPolicy, after: ToolPolicy): number {
  const a = strictness(before);
  const b = strictness(after);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return b[i]! > a[i]! ? 1 : -1;
  }
  return before.ttlSeconds === after.ttlSeconds ? 0 : 2;
}

function normalizePolicy(p: ToolPolicy): ToolPolicy {
  const approvalMode = p.mode === 'require_approval' || p.mode === 'always_approval';
  return {
    ...p,
    approver: approvalMode ? p.approver : null,
    allowTaskScope:
      p.allowTaskScope && p.mode !== 'always_approval' && !ALWAYS_ASK.includes(p.level),
  };
}

function ttlLabel(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}시간`;
  return `${Math.round(seconds / 60)}분`;
}

function PoliciesTab() {
  const api = useApi();
  const { can } = useAuth();
  const toast = useToast();
  const editable = can('admin');
  const query = useQuery(() => api.get<ToolPolicy[]>('/v1/admin/tool-policies'), []);
  const [draft, setDraft] = useState<ToolPolicy[] | null>(null);
  useEffect(() => {
    if (query.data) setDraft(query.data.map((p) => ({ ...p })));
  }, [query.data]);
  const save = useAction((policies: ToolPolicy[]) =>
    api.put<ToolPolicy[]>('/v1/admin/tool-policies', {
      policies: policies.map((p) => ({
        level: p.level,
        mode: p.mode,
        approver: p.approver,
        allowTaskScope: p.allowTaskScope,
        ttlSeconds: p.ttlSeconds,
      })),
    }),
  );

  const changes = useMemo(() => {
    if (!draft || !query.data) return new Map<Level, number>();
    const map = new Map<Level, number>();
    for (const p of draft) {
      const before = query.data.find((q) => q.level === p.level);
      if (before) {
        const c = compareStrictness(before, p);
        if (c !== 0) map.set(p.level, c);
      }
    }
    return map;
  }, [draft, query.data]);

  if (query.loading && !draft) return <Loading />;
  if (query.error) return <ErrorNotice error={query.error} onRetry={() => void query.reload()} />;
  if (!draft) return null;

  const update = (level: Level, patch: Partial<ToolPolicy>) =>
    setDraft((prev) =>
      prev ? prev.map((p) => (p.level === level ? normalizePolicy({ ...p, ...patch }) : p)) : prev,
    );

  const onSave = async () => {
    const result = await save.run(draft);
    if (result) {
      query.setData(result);
      toast('등급별 정책을 저장했어요');
    }
  };

  return (
    <>
      <Notice tone="info">
        <span>
          정책을 <strong>강화</strong>하면 실행 중인 작업에도 바로 적용되고, <strong>완화</strong>
          하면 새로 시작하는 작업부터 적용돼요. 작업은 시작할 때의 정책과 지금 정책 중 엄격한 쪽을
          씁니다.
        </span>
      </Notice>
      <Card
        flush
        title="등급별 기본 정책"
        description="Tool 은 MCP 등록 · 내장 정의에서 권한 등급을 받고, 등급마다 실행 방식이 정해집니다. 조건 규칙은 이 위에 더해져요."
        actions={
          editable ? (
            <>
              <Button
                disabled={changes.size === 0 || save.pending}
                onClick={() => setDraft(query.data!.map((p) => ({ ...p })))}
              >
                되돌리기
              </Button>
              <Button
                variant="primary"
                loading={save.pending}
                disabled={changes.size === 0}
                onClick={() => void onSave()}
              >
                저장
              </Button>
            </>
          ) : undefined
        }
      >
        <ErrorNotice error={save.error} />
        <div className="table-wrap">
          <table className="table policy-table" aria-label="등급별 기본 정책">
            <thead>
              <tr>
                <th>권한 등급</th>
                <th>실행 방식</th>
                <th>승인하는 사람</th>
                <th>작업 동안 다시 묻지 않기</th>
                <th>승인 대기 시간</th>
              </tr>
            </thead>
            <tbody>
              {draft.map((p) => {
                const approvalMode = p.mode === 'require_approval' || p.mode === 'always_approval';
                const scopeLocked = p.mode === 'always_approval' || ALWAYS_ASK.includes(p.level);
                const change = changes.get(p.level);
                return (
                  <tr key={p.level}>
                    <td>
                      <div className="policy-level">
                        <strong>{LEVEL[p.level] ?? p.level}</strong>
                        <Mono>{p.level}</Mono>
                        {p.isDefault && change === undefined && <Badge>기본값</Badge>}
                        {change === 1 && <Badge tone="warning">강화 · 즉시 적용</Badge>}
                        {change === -1 && <Badge tone="info">완화 · 새 작업부터</Badge>}
                        {change === 2 && <Badge tone="neutral">변경됨</Badge>}
                      </div>
                      <div className="cell-sub">{LEVEL_HINT[p.level]}</div>
                    </td>
                    <td>
                      <select
                        className="input"
                        aria-label={`${LEVEL[p.level]} 실행 방식`}
                        value={p.mode}
                        disabled={!editable}
                        onChange={(e) => update(p.level, { mode: e.target.value as Mode })}
                      >
                        {(Object.keys(MODE_LABEL) as Mode[]).map((m) => (
                          <option key={m} value={m}>
                            {MODE_LABEL[m]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        className="input"
                        aria-label={`${LEVEL[p.level]} 승인하는 사람`}
                        value={p.approver ?? ''}
                        disabled={!editable || !approvalMode}
                        onChange={(e) =>
                          update(p.level, {
                            approver: (e.target.value || null) as Approver | null,
                          })
                        }
                      >
                        {!approvalMode && <option value="">—</option>}
                        {approvalMode && (
                          <option value="">
                            기본 ({p.mode === 'always_approval' ? '사용자 + 운영자' : '사용자'})
                          </option>
                        )}
                        {(Object.keys(APPROVER_LABEL) as Approver[]).map((a) => (
                          <option key={a} value={a}>
                            {APPROVER_LABEL[a]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <Toggle
                        checked={p.allowTaskScope}
                        disabled={!editable || !approvalMode || scopeLocked}
                        onChange={(v) => update(p.level, { allowTaskScope: v })}
                        label={
                          scopeLocked ? (
                            <span className="muted small">매번 묻는 등급</span>
                          ) : p.allowTaskScope ? (
                            '허용'
                          ) : (
                            '허용 안 함'
                          )
                        }
                      />
                    </td>
                    <td>
                      <select
                        className="input"
                        aria-label={`${LEVEL[p.level]} 승인 대기 시간`}
                        value={p.ttlSeconds}
                        disabled={!editable || !approvalMode}
                        onChange={(e) => update(p.level, { ttlSeconds: Number(e.target.value) })}
                      >
                        {[...new Set([...TTL_OPTIONS, p.ttlSeconds])]
                          .sort((a, b) => a - b)
                          .map((s) => (
                            <option key={s} value={s}>
                              {ttlLabel(s)}
                            </option>
                          ))}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!editable && <p className="card-foot muted small">정책은 Admin 이상만 바꿀 수 있어요.</p>}
        <p className="card-foot muted small">
          승인 대기 시간이 지나면 요청은 만료되고 작업은 일시정지돼요. 재개하면 다시 승인을
          요청합니다.
        </p>
      </Card>
    </>
  );
}

/* ───────────── 조건 규칙 ───────────── */

const OP_LABEL: Record<CompareOp, string> = {
  eq: '=',
  neq: '≠',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  in: '중 하나',
  contains: '포함',
  matches: '정규식 일치',
};
const DAY_LABEL = ['일', '월', '화', '수', '목', '금', '토'];

function describeCondition(c: unknown): string {
  if (!c || typeof c !== 'object') return '형식 오류 (항상 일치로 처리)';
  const cond = c as RuleCondition;
  if ('all' in cond)
    return cond.all.length === 0 ? '항상' : cond.all.map(wrapDescribe).join(' 그리고 ');
  if ('any' in cond)
    return cond.any.length === 0 ? '없음' : cond.any.map(wrapDescribe).join(' 또는 ');
  if ('argDomainNotIn' in cond)
    return `${cond.argDomainNotIn} 의 도메인이 ${cond.domains.join(', ') || '(없음)'} 밖`;
  if ('timeOutside' in cond) {
    const t = cond.timeOutside;
    const days = t.days
      .slice()
      .sort()
      .map((d) => DAY_LABEL[d])
      .join('');
    return `업무 시간(${days} ${t.from}–${t.to}, ${t.tz}) 밖`;
  }
  if ('arg' in cond) {
    const v = Array.isArray(cond.value)
      ? cond.value.map((x) => String(x)).join(', ')
      : typeof cond.value === 'string'
        ? `“${cond.value}”`
        : JSON.stringify(cond.value);
    return cond.op === 'in' || cond.op === 'contains' || cond.op === 'matches'
      ? `${cond.arg} 가 ${v} ${OP_LABEL[cond.op]}`
      : `${cond.arg} ${OP_LABEL[cond.op]} ${v}`;
  }
  return '형식 오류 (항상 일치로 처리)';
}

function wrapDescribe(c: RuleCondition): string {
  const s = describeCondition(c);
  return 'all' in c || 'any' in c ? `(${s})` : s;
}

function RulesTab() {
  const api = useApi();
  const { can } = useAuth();
  const toast = useToast();
  const editable = can('admin');
  const query = useQuery(() => api.get<ToolPolicyRule[]>('/v1/admin/tool-policy-rules'), []);
  const [editing, setEditing] = useState<ToolPolicyRule | 'new' | null>(null);
  const [deleting, setDeleting] = useState<ToolPolicyRule | null>(null);
  const remove = useAction(async (id: string) => {
    await api.delete(`/v1/admin/tool-policy-rules/${id}`);
    return id;
  });
  const toggle = useAction((id: string, enabled: boolean) =>
    api.patch<ToolPolicyRule>(`/v1/admin/tool-policy-rules/${id}`, { enabled }),
  );

  const columns: Column<ToolPolicyRule>[] = [
    {
      key: 'priority',
      header: '우선순위',
      width: '80px',
      align: 'right',
      render: (r) => r.priority,
    },
    {
      key: 'name',
      header: '규칙',
      render: (r) => (
        <div>
          <div className="rule-name">{r.name}</div>
          {r.description && <div className="cell-sub">{r.description}</div>}
        </div>
      ),
    },
    {
      key: 'target',
      header: '대상',
      render: (r) => (
        <div className="row ident">
          {r.toolPattern && <Mono>{r.toolPattern}</Mono>}
          {r.level && <Badge>{LEVEL[r.level] ?? r.level} 등급</Badge>}
        </div>
      ),
    },
    {
      key: 'condition',
      header: '조건',
      render: (r) => <span className="rule-condition">{describeCondition(r.condition)}</span>,
    },
    {
      key: 'effect',
      header: '효과',
      width: '120px',
      render: (r) =>
        r.effect === 'block' ? (
          <Badge tone="danger">차단</Badge>
        ) : (
          <Badge tone="warning">운영자 승인 필요</Badge>
        ),
    },
    {
      key: 'enabled',
      header: '사용',
      width: '90px',
      render: (r) => (
        <span onClick={(e) => e.stopPropagation()}>
          <Toggle
            checked={r.enabled}
            disabled={!editable || toggle.pending}
            label={<span className="sr-only">{r.name} 사용</span>}
            onChange={(v) => {
              void toggle.run(r.id, v).then((updated) => {
                if (!updated) return;
                query.setData((prev) => (prev ?? []).map((x) => (x.id === r.id ? updated : x)));
                toast(v ? '규칙을 켰어요' : '규칙을 껐어요');
              });
            }}
          />
        </span>
      ),
    },
    ...(editable
      ? [
          {
            key: 'actions',
            header: '',
            width: '150px',
            align: 'right' as const,
            render: (r: ToolPolicyRule) => (
              <span className="row nowrap" onClick={(e) => e.stopPropagation()}>
                <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>
                  수정
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    remove.reset();
                    setDeleting(r);
                  }}
                >
                  삭제
                </Button>
              </span>
            ),
          },
        ]
      : []),
  ];

  return (
    <>
      <Card
        flush
        title="조건 규칙"
        description="인자 · 도메인 · 시간 조건에 맞으면 등급 정책보다 엄격하게 — 운영자 승인을 요구하거나 차단합니다. 규칙은 정책을 강화만 해요."
        actions={
          editable ? (
            <Button variant="primary" onClick={() => setEditing('new')}>
              규칙 추가
            </Button>
          ) : undefined
        }
      >
        <ErrorNotice error={query.error ?? toggle.error} onRetry={() => void query.reload()} />
        <div className="wide-table rules-table">
          <DataTable
            label="조건 규칙"
            columns={columns}
            rows={query.data ?? []}
            rowKey={(r) => r.id}
            loading={query.loading}
            onRowClick={editable ? (r) => setEditing(r) : undefined}
            empty={
              <Empty title="조건 규칙이 없어요">
                예: 금액이 100만 원을 넘는 결제 · 회사 밖 도메인으로 보내는 메일 · 업무 시간 밖 삭제
              </Empty>
            }
          />
        </div>
      </Card>
      {editing && (
        <RuleModal
          rule={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(saved, created) => {
            setEditing(null);
            query.setData((prev) =>
              created
                ? [...(prev ?? []), saved].sort((a, b) => a.priority - b.priority)
                : (prev ?? [])
                    .map((x) => (x.id === saved.id ? saved : x))
                    .sort((a, b) => a.priority - b.priority),
            );
            toast(created ? '규칙을 추가했어요' : '규칙을 저장했어요');
          }}
        />
      )}
      <ConfirmModal
        open={deleting !== null}
        title="규칙 삭제"
        confirmLabel="삭제"
        danger
        pending={remove.pending}
        error={remove.error}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return;
          void remove.run(deleting.id).then((id) => {
            if (!id) return;
            query.setData((prev) => (prev ?? []).filter((r) => r.id !== id));
            setDeleting(null);
            toast('규칙을 삭제했어요');
          });
        }}
        body={
          deleting && (
            <p>
              <strong>{deleting.name}</strong> 규칙을 지울까요? 이미 실행 중인 작업에는 시작 때의
              규칙이 계속 적용될 수 있어요.
            </p>
          )
        }
      />
    </>
  );
}

/* 규칙 편집 — 조건 빌더(인자 비교 · 도메인 · 업무 시간, 모두/하나라도) + JSON 직접 입력 */

type ClauseKind = 'arg' | 'domain' | 'time';
interface Clause {
  kind: ClauseKind;
  arg: string;
  op: CompareOp;
  value: string;
  domains: string;
  days: number[];
  from: string;
  to: string;
  tz: string;
}

const EMPTY_CLAUSE: Clause = {
  kind: 'arg',
  arg: '',
  op: 'gt',
  value: '',
  domains: '',
  days: [1, 2, 3, 4, 5],
  from: '09:00',
  to: '18:00',
  tz: 'Asia/Seoul',
};

function toClause(c: RuleCondition): Clause | null {
  if ('arg' in c)
    return {
      ...EMPTY_CLAUSE,
      kind: 'arg',
      arg: c.arg,
      op: c.op,
      value: Array.isArray(c.value)
        ? c.value.map((v) => String(v)).join(', ')
        : typeof c.value === 'string'
          ? c.value
          : JSON.stringify(c.value),
    };
  if ('argDomainNotIn' in c)
    return {
      ...EMPTY_CLAUSE,
      kind: 'domain',
      arg: c.argDomainNotIn,
      domains: c.domains.join(', '),
    };
  if ('timeOutside' in c)
    return {
      ...EMPTY_CLAUSE,
      kind: 'time',
      days: c.timeOutside.days,
      from: c.timeOutside.from,
      to: c.timeOutside.to,
      tz: c.timeOutside.tz,
    };
  return null;
}

/** 빌더로 표현할 수 있으면 (모두/하나라도 + 단일 조건들) */
function fromCondition(raw: unknown): { combinator: 'all' | 'any'; clauses: Clause[] } | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as RuleCondition;
  const list = 'all' in c ? c.all : 'any' in c ? c.any : [c];
  const clauses = list.map(toClause);
  if (clauses.some((x) => x === null) || clauses.length === 0) return null;
  return { combinator: 'any' in c ? 'any' : 'all', clauses: clauses as Clause[] };
}

function parseValue(op: CompareOp, text: string): unknown {
  const t = text.trim();
  if (op === 'in') return t.split(',').map((s) => parseScalar(s.trim()));
  if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
    const n = Number(t.replace(/,/g, ''));
    return Number.isFinite(n) && t !== '' ? n : t;
  }
  if (op === 'contains' || op === 'matches') return t;
  return parseScalar(t);
}

function parseScalar(t: string): unknown {
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (t !== '' && Number.isFinite(Number(t))) return Number(t);
  return t;
}

function clauseToCondition(c: Clause): RuleCondition {
  if (c.kind === 'domain')
    return {
      argDomainNotIn: c.arg.trim(),
      domains: c.domains
        .split(',')
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean),
    };
  if (c.kind === 'time')
    return {
      timeOutside: {
        days: [...c.days].sort(),
        from: c.from,
        to: c.to,
        tz: c.tz.trim() || 'Asia/Seoul',
      },
    };
  return { arg: c.arg.trim(), op: c.op, value: parseValue(c.op, c.value) };
}

function clauseIssue(c: Clause): string | null {
  if ((c.kind === 'arg' || c.kind === 'domain') && !c.arg.trim()) return '인자 이름을 입력하세요';
  if (c.kind === 'arg' && c.value.trim() === '' && c.op !== 'eq' && c.op !== 'neq')
    return '비교할 값을 입력하세요';
  if (c.kind === 'arg' && c.op === 'matches') {
    try {
      new RegExp(c.value);
    } catch {
      return '정규식 형식이 올바르지 않아요';
    }
  }
  if (c.kind === 'domain' && !c.domains.trim()) return '허용할 도메인을 하나 이상 입력하세요';
  if (c.kind === 'time') {
    if (c.days.length === 0) return '업무 요일을 하나 이상 고르세요';
    if (!/^\d{2}:\d{2}$/.test(c.from) || !/^\d{2}:\d{2}$/.test(c.to))
      return '시간은 HH:MM 형식이어야 해요';
  }
  return null;
}

interface FieldIssue {
  path: string;
  message: string;
}

function RuleModal({
  rule,
  onClose,
  onSaved,
}: {
  rule: ToolPolicyRule | null;
  onClose: () => void;
  onSaved: (rule: ToolPolicyRule, created: boolean) => void;
}) {
  const api = useApi();
  const initialBuilder = rule
    ? fromCondition(rule.condition)
    : { combinator: 'all' as const, clauses: [{ ...EMPTY_CLAUSE }] };
  const [name, setName] = useState(rule?.name ?? '');
  const [description, setDescription] = useState(rule?.description ?? '');
  const [toolPattern, setToolPattern] = useState(rule?.toolPattern ?? '');
  const [level, setLevel] = useState<Level | ''>(rule?.level ?? '');
  const [effect, setEffect] = useState<ToolPolicyRule['effect']>(
    rule?.effect ?? 'require_operator',
  );
  const [priority, setPriority] = useState(String(rule?.priority ?? 100));
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [mode, setMode] = useState<'builder' | 'json'>(initialBuilder ? 'builder' : 'json');
  const [combinator, setCombinator] = useState<'all' | 'any'>(initialBuilder?.combinator ?? 'all');
  const [clauses, setClauses] = useState<Clause[]>(
    initialBuilder?.clauses ?? [{ ...EMPTY_CLAUSE }],
  );
  const [json, setJson] = useState(() =>
    JSON.stringify(rule?.condition ?? { arg: 'amount', op: 'gt', value: 1000000 }, null, 2),
  );
  const [localError, setLocalError] = useState<string | null>(null);
  const save = useAction(async (body: Record<string, unknown>) =>
    rule
      ? api.patch<ToolPolicyRule>(`/v1/admin/tool-policy-rules/${rule.id}`, body)
      : api.post<ToolPolicyRule>('/v1/admin/tool-policy-rules', body),
  );

  const issues: FieldIssue[] =
    save.error instanceof ApiError && Array.isArray(save.error.body.errors)
      ? (save.error.body.errors as FieldIssue[])
      : [];
  const issueFor = (prefix: string) =>
    issues.find((i) => i.path === prefix || i.path.startsWith(`${prefix}.`))?.message;
  const otherIssues = issues.filter(
    (i) =>
      !['name', 'description', 'toolPattern', 'level', 'condition', 'effect', 'priority'].some(
        (p) => i.path === p || i.path.startsWith(`${p}.`),
      ),
  );

  const buildCondition = (): RuleCondition | string => {
    if (mode === 'json') {
      try {
        return JSON.parse(json) as RuleCondition;
      } catch {
        return '조건 JSON 형식이 올바르지 않아요';
      }
    }
    for (const c of clauses) {
      const issue = clauseIssue(c);
      if (issue) return issue;
    }
    const built = clauses.map(clauseToCondition);
    return built.length === 1 ? built[0]! : combinator === 'all' ? { all: built } : { any: built };
  };

  const switchMode = (next: 'builder' | 'json') => {
    setLocalError(null);
    if (next === 'json') {
      const cond = buildCondition();
      if (typeof cond !== 'string') setJson(JSON.stringify(cond, null, 2));
      setMode('json');
      return;
    }
    try {
      const parsed = fromCondition(JSON.parse(json));
      if (!parsed) {
        setLocalError('중첩된 조건은 빌더로 편집할 수 없어요 — JSON 으로 편집하세요');
        return;
      }
      setCombinator(parsed.combinator);
      setClauses(parsed.clauses);
      setMode('builder');
    } catch {
      setLocalError('조건 JSON 형식이 올바르지 않아요');
    }
  };

  const submit = async () => {
    setLocalError(null);
    if (!toolPattern.trim() && !level) {
      setLocalError('대상 Tool 패턴 또는 권한 등급 중 하나는 정해야 해요');
      return;
    }
    const condition = buildCondition();
    if (typeof condition === 'string') {
      setLocalError(condition);
      return;
    }
    const p = Number(priority);
    const body = {
      name: name.trim(),
      description: description.trim() || null,
      toolPattern: toolPattern.trim() || null,
      level: level || null,
      condition,
      effect,
      priority: Number.isInteger(p) ? p : 100,
      enabled,
    };
    const saved = await save.run(body);
    if (saved) onSaved(saved, !rule);
  };

  const updateClause = (i: number, patch: Partial<Clause>) =>
    setClauses((prev) => prev.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  return (
    <Modal
      open
      wide
      title={rule ? '규칙 수정' : '규칙 추가'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>취소</Button>
          <Button
            variant="primary"
            loading={save.pending}
            disabled={!name.trim()}
            onClick={() => void submit()}
          >
            {rule ? '저장' : '추가'}
          </Button>
        </>
      }
    >
      <div className="rule-form">
        <div className="grid grid-2">
          <Field label="이름" required error={issueFor('name')}>
            <input
              className="input"
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
              placeholder="예: 고액 결제는 운영자 승인"
            />
          </Field>
          <Field
            label="우선순위"
            hint="작을수록 먼저 평가해요 (0–10000)"
            error={issueFor('priority')}
          >
            <input
              className="input"
              type="number"
              min={0}
              max={10000}
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
            />
          </Field>
        </div>
        <Field label="설명" error={issueFor('description')}>
          <input
            className="input"
            value={description}
            maxLength={500}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <fieldset className="rule-section">
          <legend>대상 — 하나 이상</legend>
          <div className="grid grid-2">
            <Field
              label="Tool 이름 또는 패턴"
              hint="정확한 이름 또는 server.* (예: payments.*)"
              error={issueFor('toolPattern')}
            >
              <input
                className="input mono-input"
                value={toolPattern}
                onChange={(e) => setToolPattern(e.target.value)}
                placeholder="payments.refund"
              />
            </Field>
            <Field label="권한 등급" error={issueFor('level')}>
              <select
                className="input"
                value={level}
                onChange={(e) => setLevel(e.target.value as Level | '')}
              >
                <option value="">선택 안 함</option>
                {LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {LEVEL[l] ?? l}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </fieldset>
        <fieldset className="rule-section">
          <legend>조건</legend>
          <div className="row rule-mode">
            <div className="segmented" role="group" aria-label="조건 편집 방식">
              <button
                type="button"
                aria-pressed={mode === 'builder'}
                onClick={() => switchMode('builder')}
              >
                빌더
              </button>
              <button
                type="button"
                aria-pressed={mode === 'json'}
                onClick={() => switchMode('json')}
              >
                JSON
              </button>
            </div>
            {mode === 'builder' && clauses.length > 1 && (
              <select
                className="input combinator"
                aria-label="조건 결합"
                value={combinator}
                onChange={(e) => setCombinator(e.target.value as 'all' | 'any')}
              >
                <option value="all">모두 만족할 때</option>
                <option value="any">하나라도 만족할 때</option>
              </select>
            )}
          </div>
          {mode === 'builder' ? (
            <div className="clauses">
              {clauses.map((c, i) => (
                <ClauseEditor
                  key={i}
                  clause={c}
                  onChange={(patch) => updateClause(i, patch)}
                  onRemove={
                    clauses.length > 1
                      ? () => setClauses((prev) => prev.filter((_, j) => j !== i))
                      : undefined
                  }
                />
              ))}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setClauses((prev) => [...prev, { ...EMPTY_CLAUSE }])}
              >
                + 조건 추가
              </Button>
              <p className="muted small">
                미리 보기:{' '}
                {(() => {
                  const c = buildCondition();
                  return typeof c === 'string' ? c : describeCondition(c);
                })()}
              </p>
            </div>
          ) : (
            <Field
              label="조건 JSON"
              hint="all · any · {arg, op, value} · {argDomainNotIn, domains} · {timeOutside} 를 조합합니다"
              error={issueFor('condition')}
            >
              <textarea
                className="input code"
                rows={8}
                value={json}
                onChange={(e) => setJson(e.target.value)}
                spellCheck={false}
              />
            </Field>
          )}
          {mode === 'builder' && issueFor('condition') && (
            <p className="field-error">{issueFor('condition')}</p>
          )}
        </fieldset>
        <fieldset className="rule-section">
          <legend>효과</legend>
          <div className="effect-options">
            <label className={effect === 'require_operator' ? 'effect selected' : 'effect'}>
              <input
                type="radio"
                name="effect"
                checked={effect === 'require_operator'}
                onChange={() => setEffect('require_operator')}
              />
              <span>
                <strong>운영자 승인 필요</strong>
                <span className="muted small">사용자 승인만으로는 실행하지 않아요</span>
              </span>
            </label>
            <label className={effect === 'block' ? 'effect selected' : 'effect'}>
              <input
                type="radio"
                name="effect"
                checked={effect === 'block'}
                onChange={() => setEffect('block')}
              />
              <span>
                <strong>차단</strong>
                <span className="muted small">조건에 맞으면 실행하지 않아요</span>
              </span>
            </label>
          </div>
        </fieldset>
        <Toggle checked={enabled} onChange={setEnabled} label="규칙 사용" />
        {localError && <Notice tone="error">{localError}</Notice>}
        {otherIssues.map((i) => (
          <Notice key={i.path + i.message} tone="error">
            {i.path ? `${i.path}: ` : ''}
            {i.message}
          </Notice>
        ))}
        {save.error && issues.length === 0 && <ErrorNotice error={save.error} />}
      </div>
    </Modal>
  );
}

function ClauseEditor({
  clause,
  onChange,
  onRemove,
}: {
  clause: Clause;
  onChange: (patch: Partial<Clause>) => void;
  onRemove?: () => void;
}) {
  return (
    <div className="clause">
      <select
        className="input clause-kind"
        aria-label="조건 종류"
        value={clause.kind}
        onChange={(e) => onChange({ kind: e.target.value as ClauseKind })}
      >
        <option value="arg">인자 값 비교</option>
        <option value="domain">허용 도메인 밖</option>
        <option value="time">업무 시간 밖</option>
      </select>
      {clause.kind === 'arg' && (
        <>
          <input
            className="input mono-input"
            aria-label="인자 이름"
            placeholder="amount 또는 customer.tier"
            value={clause.arg}
            onChange={(e) => onChange({ arg: e.target.value })}
          />
          <select
            className="input clause-op"
            aria-label="비교"
            value={clause.op}
            onChange={(e) => onChange({ op: e.target.value as CompareOp })}
          >
            {(Object.keys(OP_LABEL) as CompareOp[]).map((op) => (
              <option key={op} value={op}>
                {OP_LABEL[op]}
              </option>
            ))}
          </select>
          <input
            className="input"
            aria-label="값"
            placeholder={clause.op === 'in' ? 'a, b, c' : '1000000'}
            value={clause.value}
            onChange={(e) => onChange({ value: e.target.value })}
          />
        </>
      )}
      {clause.kind === 'domain' && (
        <>
          <input
            className="input mono-input"
            aria-label="인자 이름"
            placeholder="to"
            value={clause.arg}
            onChange={(e) => onChange({ arg: e.target.value })}
          />
          <input
            className="input clause-wide"
            aria-label="허용 도메인"
            placeholder="example.com, corp.example.com"
            value={clause.domains}
            onChange={(e) => onChange({ domains: e.target.value })}
          />
        </>
      )}
      {clause.kind === 'time' && (
        <>
          <span className="days" role="group" aria-label="업무 요일">
            {DAY_LABEL.map((d, i) => (
              <label key={d} className={clause.days.includes(i) ? 'day on' : 'day'}>
                <input
                  type="checkbox"
                  checked={clause.days.includes(i)}
                  onChange={(e) =>
                    onChange({
                      days: e.target.checked
                        ? [...clause.days, i]
                        : clause.days.filter((x) => x !== i),
                    })
                  }
                />
                {d}
              </label>
            ))}
          </span>
          <input
            className="input clause-time"
            type="time"
            aria-label="시작"
            value={clause.from}
            onChange={(e) => onChange({ from: e.target.value })}
          />
          <span className="muted">–</span>
          <input
            className="input clause-time"
            type="time"
            aria-label="끝"
            value={clause.to}
            onChange={(e) => onChange({ to: e.target.value })}
          />
          <input
            className="input clause-tz"
            aria-label="시간대"
            value={clause.tz}
            onChange={(e) => onChange({ tz: e.target.value })}
          />
        </>
      )}
      {onRemove && (
        <button type="button" className="clause-remove" aria-label="조건 삭제" onClick={onRemove}>
          ×
        </button>
      )}
    </div>
  );
}
