/**
 * C-07 승인 · 권한 정책 — 승인 대기 큐(대리 결정) · 처리 이력 · 등급별 기본 정책 · 조건 규칙.
 * API: docs/api-spec.md §4.7 (GET/POST /v1/admin/approvals…, tool-policies, tool-policy-rules)
 */
import {
  CheckIcon,
  ChevronRightIcon,
  ClockIcon,
  EllipsisIcon,
  FilterIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import { type ReactNode, type SyntheticEvent, useEffect, useId, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { formatDateTime, formatRemaining } from '../../../shared/format';
import { LEVEL, RISK } from '../../../shared/status';
import { ApiError } from '../api';
import { useApi, useAuth } from '../auth';
import {
  Badge,
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
  type Tone,
  Toolbar,
  useAction,
  usePaged,
  useQuery,
  useToast,
} from '../ui';
import { Button } from '@/components/ui/button';
import {
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  Card as UiCard,
} from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

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
/** 위험도 배지 색 · 카드 왼쪽 강조선 — 모르는 값은 중간으로 */
const RISK_STYLE: Record<ApprovalRow['riskLevel'], { tone: Tone; accent: string }> = {
  low: { tone: 'success', accent: 'border-l-emerald-500 dark:border-l-emerald-400' },
  medium: { tone: 'warning', accent: 'border-l-amber-500 dark:border-l-amber-400' },
  high: { tone: 'danger', accent: 'border-l-red-500 dark:border-l-red-400' },
};

const LINK_CLASS = 'font-medium text-primary underline-offset-4 hover:underline';
const SUB_CLASS = 'mt-0.5 text-xs text-muted-foreground';

/** 표 행 안의 컨트롤 — 클릭 · Enter 가 행 열기로 번지지 않게 */
const stop = (e: SyntheticEvent) => e.stopPropagation();
const STOP_ROW = { onClick: stop, onKeyDown: stop };

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
        <div className="grid gap-3">
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
            <div className="mb-4 grid gap-2 text-sm [&_[data-slot=alert]]:mb-0">
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
                <p className="text-muted-foreground">
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
  const risk = RISK_STYLE[row.riskLevel] ?? RISK_STYLE.medium;
  const remainingMs = new Date(row.expiresAt).getTime() - now;
  const urgent = remainingMs < 3 * 60_000;
  const needsOperator = row.waitingFor === 'operator' || row.waitingFor === 'user_and_operator';
  const shownArgs = row.args.slice(0, 6);
  return (
    <UiCard
      role="article"
      aria-label={`${row.toolName} 승인 요청`}
      className={cn('min-w-0 gap-4 border-l-4 py-4', risk.accent)}
    >
      <CardHeader className="gap-2 px-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={risk.tone}>위험도 {RISK[row.riskLevel]?.label ?? row.riskLevel}</Badge>
          <Badge>{LEVEL[row.permissionLevel] ?? row.permissionLevel}</Badge>
          <Badge>{SOURCE_LABEL[row.toolSource]}</Badge>
          <Mono>{row.toolName}</Mono>
        </div>
        <CardAction>
          <span
            className={cn(
              'inline-flex items-center gap-1 text-sm whitespace-nowrap tabular-nums',
              urgent ? 'font-semibold text-destructive' : 'text-muted-foreground',
            )}
            title={`만료 ${formatDateTime(row.expiresAt)}`}
          >
            <ClockIcon className="size-3.5" aria-hidden="true" />
            {formatRemaining(row.expiresAt, now)}
          </span>
        </CardAction>
        <h3 className="text-base leading-snug font-semibold">{row.summary}</h3>
        {row.reason && row.reason !== row.summary && (
          <CardDescription>{row.reason}</CardDescription>
        )}
      </CardHeader>
      <CardContent className="grid gap-4 px-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          {shownArgs.length > 0 ? (
            <dl className="divide-y rounded-lg border text-sm">
              {shownArgs.map((a) => (
                <div key={a.label} className="grid grid-cols-[120px_minmax(0,1fr)] gap-2 px-3 py-2">
                  <dt
                    className="truncate font-mono text-xs leading-5 text-muted-foreground"
                    title={a.label}
                  >
                    {a.label}
                  </dt>
                  <dd className="break-words whitespace-pre-wrap">{a.value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">인자 없음</p>
          )}
          {row.args.length > shownArgs.length && (
            <p className="mt-1.5 text-xs text-muted-foreground">
              외 {row.args.length - shownArgs.length}개 인자
            </p>
          )}
          <Collapsible className="mt-2">
            <CollapsibleTrigger asChild>
              <Button variant="link" size="xs" className="group px-0 has-[>svg]:px-0">
                <ChevronRightIcon
                  className="transition-transform group-data-[state=open]:rotate-90"
                  aria-hidden="true"
                />
                실행 인자 원문 (JSON)
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-1.5">
              <Json value={row.rawArgs} />
            </CollapsibleContent>
          </Collapsible>
        </div>
        <div className="min-w-0 text-sm">
          <KeyValue
            items={[
              [
                '작업',
                <Link to={`/tasks/${row.taskId}`} className={LINK_CLASS}>
                  {row.taskTitle || '제목 없음'}
                </Link>,
              ],
              ['요청 사용자', <Mono>{row.endUserPseudonym}</Mono>],
              [
                '결정',
                <span
                  className={
                    needsOperator
                      ? 'font-semibold text-amber-700 dark:text-amber-400'
                      : 'text-muted-foreground'
                  }
                >
                  {waitingLabel(row)}
                </span>,
              ],
              ...(row.user
                ? ([
                    [
                      '사용자 결정',
                      <>
                        {row.user.decision === 'approve' ? '승인' : '거절'} ·{' '}
                        <Time iso={row.user.at} />
                        {row.user.comment && (
                          <p className="text-muted-foreground">“{row.user.comment}”</p>
                        )}
                      </>,
                    ],
                  ] as [ReactNode, ReactNode][])
                : []),
              ['요청 시각', <Time iso={row.createdAt} />],
            ]}
          />
        </div>
      </CardContent>
      <CardFooter className="justify-end gap-2 border-t px-5 [.border-t]:pt-4">
        {can('operator') ? (
          <>
            <Button variant="destructive" onClick={() => onDecide('reject')}>
              <XIcon aria-hidden="true" />
              거절
            </Button>
            <Button onClick={() => onDecide('approve')}>
              <CheckIcon aria-hidden="true" />
              운영자로 승인
            </Button>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">
            대리 결정은 Operator 이상만 할 수 있어요
          </span>
        )}
      </CardFooter>
    </UiCard>
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
        <div>
          <Mono>{r.toolName}</Mono>
          <div className={SUB_CLASS}>
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
        <div>
          <Link
            to={`/tasks/${r.taskId}`}
            className={LINK_CLASS}
            onClick={(e) => e.stopPropagation()}
          >
            {r.taskTitle || '제목 없음'}
          </Link>
          <div className={SUB_CLASS}>{r.endUserPseudonym}</div>
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
      <div className="px-4 pt-3">
        <Toolbar>
          <form
            className="flex w-full flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setToolName(toolInput.trim());
            }}
          >
            <Input
              aria-label="Tool 이름으로 거르기"
              placeholder="Tool 이름 (정확히 일치)"
              value={toolInput}
              onChange={(e) => setToolInput(e.target.value)}
              className="sm:w-80"
            />
            <Button variant="outline" type="submit">
              <FilterIcon aria-hidden="true" />
              거르기
            </Button>
            {toolName && (
              <Button
                variant="ghost"
                onClick={() => {
                  setToolInput('');
                  setToolName('');
                }}
              >
                <XIcon aria-hidden="true" />
                전체 보기
              </Button>
            )}
          </form>
        </Toolbar>
        <ErrorNotice error={list.error} onRetry={() => void list.reload()} />
      </div>
      <DataTable
        label="승인 처리 이력"
        columns={columns}
        rows={list.items}
        rowKey={(r) => r.id}
        loading={list.loading}
        onRowClick={setOpen}
        empty={toolName ? `${toolName} 의 처리 이력이 없어요` : '처리된 승인 요청이 아직 없어요'}
      />
      <MoreButton hasMore={list.hasMore} loading={list.moreLoading} onClick={list.loadMore} />
      <Modal
        open={open !== null}
        wide
        title="승인 요청 상세"
        onClose={() => setOpen(null)}
        footer={
          <Button variant="outline" onClick={() => setOpen(null)}>
            닫기
          </Button>
        }
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
        {row.user.comment && <span className="text-muted-foreground"> — “{row.user.comment}”</span>}
      </div>,
    );
  if (row.operator)
    parts.push(
      <div key="o">
        {row.operator.memberName ?? '운영자'}{' '}
        {row.operator.decision === 'approve' ? '승인' : '거절'}
        {row.operator.comment && (
          <span className="text-muted-foreground"> — “{row.operator.comment}”</span>
        )}
      </div>,
    );
  if (parts.length === 0)
    return (
      <span className="text-muted-foreground">
        {row.status === 'expired'
          ? '응답 없이 만료'
          : row.status === 'cancelled'
            ? '작업 중지로 취소'
            : '—'}
      </span>
    );
  return <div className="grid gap-0.5 text-sm">{parts}</div>;
}

function ApprovalDetail({ row }: { row: ApprovalRow }) {
  return (
    <div className="grid gap-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</Badge>
        <Mono>{row.toolName}</Mono>
      </div>
      <p className="text-base leading-snug font-semibold">{row.summary}</p>
      <KeyValue
        items={[
          [
            '작업',
            <Link to={`/tasks/${row.taskId}`} className={LINK_CLASS}>
              {row.taskTitle || '제목 없음'}
            </Link>,
          ],
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
                variant="outline"
                disabled={changes.size === 0 || save.pending}
                onClick={() => setDraft(query.data!.map((p) => ({ ...p })))}
              >
                <RotateCcwIcon aria-hidden="true" />
                되돌리기
              </Button>
              <Button
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
        {save.error && (
          <div className="px-4 pt-3">
            <ErrorNotice error={save.error} />
          </div>
        )}
        <Table aria-label="등급별 기본 정책">
          <TableHeader className="bg-muted/50">
            <TableRow>
              {[
                '권한 등급',
                '실행 방식',
                '승인하는 사람',
                '작업 동안 다시 묻지 않기',
                '승인 대기 시간',
              ].map((h) => (
                <TableHead key={h} className="px-4 text-xs text-muted-foreground">
                  {h}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {draft.map((p) => {
              const approvalMode = p.mode === 'require_approval' || p.mode === 'always_approval';
              const scopeLocked = p.mode === 'always_approval' || ALWAYS_ASK.includes(p.level);
              const change = changes.get(p.level);
              return (
                <TableRow key={p.level}>
                  <TableCell className="min-w-60 px-4 py-3 align-top whitespace-normal">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <strong className="font-semibold">{LEVEL[p.level] ?? p.level}</strong>
                      <Mono>{p.level}</Mono>
                      {p.isDefault && change === undefined && <Badge>기본값</Badge>}
                      {change === 1 && <Badge tone="warning">강화 · 즉시 적용</Badge>}
                      {change === -1 && <Badge tone="info">완화 · 새 작업부터</Badge>}
                      {change === 2 && <Badge tone="neutral">변경됨</Badge>}
                    </div>
                    <div className={SUB_CLASS}>{LEVEL_HINT[p.level]}</div>
                  </TableCell>
                  <TableCell className="px-4 py-3 align-top">
                    <NativeSelect
                      containerClassName="min-w-40"
                      aria-label={`${LEVEL[p.level]} 실행 방식`}
                      value={p.mode}
                      disabled={!editable}
                      onChange={(e) => update(p.level, { mode: e.target.value as Mode })}
                    >
                      {(Object.keys(MODE_LABEL) as Mode[]).map((m) => (
                        <NativeSelectOption key={m} value={m}>
                          {MODE_LABEL[m]}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </TableCell>
                  <TableCell className="px-4 py-3 align-top">
                    <NativeSelect
                      containerClassName="min-w-40"
                      aria-label={`${LEVEL[p.level]} 승인하는 사람`}
                      value={p.approver ?? ''}
                      disabled={!editable || !approvalMode}
                      onChange={(e) =>
                        update(p.level, {
                          approver: (e.target.value || null) as Approver | null,
                        })
                      }
                    >
                      {!approvalMode && <NativeSelectOption value="">—</NativeSelectOption>}
                      {approvalMode && (
                        <NativeSelectOption value="">
                          기본 ({p.mode === 'always_approval' ? '사용자 + 운영자' : '사용자'})
                        </NativeSelectOption>
                      )}
                      {(Object.keys(APPROVER_LABEL) as Approver[]).map((a) => (
                        <NativeSelectOption key={a} value={a}>
                          {APPROVER_LABEL[a]}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </TableCell>
                  <TableCell className="px-4 py-3 align-top">
                    <Toggle
                      checked={p.allowTaskScope}
                      disabled={!editable || !approvalMode || scopeLocked}
                      onChange={(v) => update(p.level, { allowTaskScope: v })}
                      label={
                        scopeLocked ? (
                          <span className="text-xs">매번 묻는 등급</span>
                        ) : p.allowTaskScope ? (
                          '허용'
                        ) : (
                          '허용 안 함'
                        )
                      }
                    />
                  </TableCell>
                  <TableCell className="px-4 py-3 align-top">
                    <NativeSelect
                      containerClassName="min-w-32"
                      aria-label={`${LEVEL[p.level]} 승인 대기 시간`}
                      value={p.ttlSeconds}
                      disabled={!editable || !approvalMode}
                      onChange={(e) => update(p.level, { ttlSeconds: Number(e.target.value) })}
                    >
                      {[...new Set([...TTL_OPTIONS, p.ttlSeconds])]
                        .sort((a, b) => a - b)
                        .map((s) => (
                          <NativeSelectOption key={s} value={s}>
                            {ttlLabel(s)}
                          </NativeSelectOption>
                        ))}
                    </NativeSelect>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        <div className="grid gap-1 border-t px-4 py-3 text-xs text-muted-foreground">
          {!editable && <p>정책은 Admin 이상만 바꿀 수 있어요.</p>}
          <p>
            승인 대기 시간이 지나면 요청은 만료되고 작업은 일시정지돼요. 재개하면 다시 승인을
            요청합니다.
          </p>
        </div>
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
      render: (r) => <span className="tabular-nums">{r.priority}</span>,
    },
    {
      key: 'name',
      header: '규칙',
      render: (r) => (
        <div className="min-w-48 whitespace-normal">
          <div className="font-semibold">{r.name}</div>
          {r.description && <div className={SUB_CLASS}>{r.description}</div>}
        </div>
      ),
    },
    {
      key: 'target',
      header: '대상',
      render: (r) => (
        <div className="flex flex-wrap items-center gap-1.5">
          {r.toolPattern && <Mono>{r.toolPattern}</Mono>}
          {r.level && <Badge>{LEVEL[r.level] ?? r.level} 등급</Badge>}
        </div>
      ),
    },
    {
      key: 'condition',
      header: '조건',
      render: (r) => (
        <span className="block min-w-56 text-sm whitespace-normal text-muted-foreground">
          {describeCondition(r.condition)}
        </span>
      ),
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
        <span className="inline-flex" {...STOP_ROW}>
          <Switch
            checked={r.enabled}
            disabled={!editable || toggle.pending}
            aria-label={`${r.name} 사용`}
            onCheckedChange={(v) => {
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
            header: <span className="sr-only">작업</span>,
            width: '56px',
            align: 'right' as const,
            render: (r: ToolPolicyRule) => (
              <span className="inline-flex" {...STOP_ROW}>
                {/* 메뉴에서 대화상자를 열므로 modal 을 끈다 — 닫힌 뒤 body 포인터가 막히지 않게 */}
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={`${r.name} 작업`}>
                      <EllipsisIcon aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setEditing(r)}>
                      <PencilIcon aria-hidden="true" />
                      수정
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => {
                        remove.reset();
                        setDeleting(r);
                      }}
                    >
                      <Trash2Icon aria-hidden="true" />
                      삭제
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </span>
            ),
          },
        ]
      : []),
  ];

  const listError = query.error ?? toggle.error;
  return (
    <>
      <Card
        flush
        title="조건 규칙"
        description="인자 · 도메인 · 시간 조건에 맞으면 등급 정책보다 엄격하게 — 운영자 승인을 요구하거나 차단합니다. 규칙은 정책을 강화만 해요."
        actions={
          editable ? (
            <Button onClick={() => setEditing('new')}>
              <PlusIcon aria-hidden="true" />
              규칙 추가
            </Button>
          ) : undefined
        }
      >
        {listError && (
          <div className="px-4 pt-3">
            <ErrorNotice error={listError} onRetry={() => void query.reload()} />
          </div>
        )}
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
            <p className="mb-3 text-sm">
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

const EFFECT_OPTION: Record<ToolPolicyRule['effect'], { label: string; hint: string }> = {
  require_operator: { label: '운영자 승인 필요', hint: '사용자 승인만으로는 실행하지 않아요' },
  block: { label: '차단', hint: '조건에 맞으면 실행하지 않아요' },
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

function Section({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="mb-4 min-w-0 rounded-lg border px-4 pt-2">
      <legend className="px-1 text-sm font-semibold text-muted-foreground">{legend}</legend>
      {children}
    </fieldset>
  );
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
  const id = useId();
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
          <Button variant="outline" onClick={onClose}>
            취소
          </Button>
          <Button loading={save.pending} disabled={!name.trim()} onClick={() => void submit()}>
            {rule ? '저장' : '추가'}
          </Button>
        </>
      }
    >
      <div className="grid gap-x-4 gap-y-0 sm:grid-cols-2">
        <Field label="이름" required error={issueFor('name')}>
          <Input
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
          <Input
            type="number"
            min={0}
            max={10000}
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
          />
        </Field>
      </div>
      <Field label="설명" error={issueFor('description')}>
        <Input
          value={description}
          maxLength={500}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <Section legend="대상 — 하나 이상">
        <div className="grid gap-x-4 gap-y-0 sm:grid-cols-2">
          <Field
            label="Tool 이름 또는 패턴"
            hint="정확한 이름 또는 server.* (예: payments.*)"
            error={issueFor('toolPattern')}
          >
            <Input
              className="font-mono"
              value={toolPattern}
              onChange={(e) => setToolPattern(e.target.value)}
              placeholder="payments.refund"
            />
          </Field>
          <Field label="권한 등급" error={issueFor('level')}>
            <NativeSelect value={level} onChange={(e) => setLevel(e.target.value as Level | '')}>
              <NativeSelectOption value="">선택 안 함</NativeSelectOption>
              {LEVELS.map((l) => (
                <NativeSelectOption key={l} value={l}>
                  {LEVEL[l] ?? l}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
        </div>
      </Section>
      <Section legend="조건">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <ToggleGroup
            type="single"
            variant="outline"
            aria-label="조건 편집 방식"
            value={mode}
            onValueChange={(v) => {
              if (v) switchMode(v as 'builder' | 'json');
            }}
          >
            <ToggleGroupItem value="builder">빌더</ToggleGroupItem>
            <ToggleGroupItem value="json">JSON</ToggleGroupItem>
          </ToggleGroup>
          {mode === 'builder' && clauses.length > 1 && (
            <NativeSelect
              containerClassName="w-auto"
              aria-label="조건 결합"
              value={combinator}
              onChange={(e) => setCombinator(e.target.value as 'all' | 'any')}
            >
              <NativeSelectOption value="all">모두 만족할 때</NativeSelectOption>
              <NativeSelectOption value="any">하나라도 만족할 때</NativeSelectOption>
            </NativeSelect>
          )}
        </div>
        {mode === 'builder' ? (
          <div className="mb-4 grid gap-2">
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
              className="justify-self-start"
              onClick={() => setClauses((prev) => [...prev, { ...EMPTY_CLAUSE }])}
            >
              <PlusIcon aria-hidden="true" />
              조건 추가
            </Button>
            <p className="text-xs text-muted-foreground">
              미리 보기:{' '}
              {(() => {
                const c = buildCondition();
                return typeof c === 'string' ? c : describeCondition(c);
              })()}
            </p>
            {issueFor('condition') && (
              <p className="text-xs text-destructive">{issueFor('condition')}</p>
            )}
          </div>
        ) : (
          <Field
            label="조건 JSON"
            hint="all · any · {arg, op, value} · {argDomainNotIn, domains} · {timeOutside} 를 조합합니다"
            error={issueFor('condition')}
          >
            <Textarea
              className="font-mono"
              rows={8}
              value={json}
              onChange={(e) => setJson(e.target.value)}
              spellCheck={false}
            />
          </Field>
        )}
      </Section>
      <Section legend="효과">
        <RadioGroup
          aria-label="효과"
          value={effect}
          onValueChange={(v) => setEffect(v as ToolPolicyRule['effect'])}
          className="mb-4 grid gap-2 sm:grid-cols-2"
        >
          {(Object.keys(EFFECT_OPTION) as ToolPolicyRule['effect'][]).map((value) => (
            <Label
              key={value}
              htmlFor={`${id}-${value}`}
              className="flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 font-normal has-data-[state=checked]:border-primary has-data-[state=checked]:bg-primary/5"
            >
              <RadioGroupItem id={`${id}-${value}`} value={value} className="mt-0.5" />
              <span className="grid gap-0.5">
                <span className="font-semibold">{EFFECT_OPTION[value].label}</span>
                <span className="text-xs text-muted-foreground">{EFFECT_OPTION[value].hint}</span>
              </span>
            </Label>
          ))}
        </RadioGroup>
      </Section>
      <div className="mb-3">
        <Toggle checked={enabled} onChange={setEnabled} label="규칙 사용" />
      </div>
      {localError && <Notice tone="error">{localError}</Notice>}
      {otherIssues.map((i) => (
        <Notice key={i.path + i.message} tone="error">
          {i.path ? `${i.path}: ` : ''}
          {i.message}
        </Notice>
      ))}
      {save.error && issues.length === 0 && <ErrorNotice error={save.error} />}
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
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border bg-muted/40 p-2">
      <NativeSelect
        containerClassName="w-40 flex-none"
        className="bg-background"
        aria-label="조건 종류"
        value={clause.kind}
        onChange={(e) => onChange({ kind: e.target.value as ClauseKind })}
      >
        <NativeSelectOption value="arg">인자 값 비교</NativeSelectOption>
        <NativeSelectOption value="domain">허용 도메인 밖</NativeSelectOption>
        <NativeSelectOption value="time">업무 시간 밖</NativeSelectOption>
      </NativeSelect>
      {clause.kind === 'arg' && (
        <>
          <Input
            className="min-w-0 grow basis-30 bg-background font-mono"
            aria-label="인자 이름"
            placeholder="amount 또는 customer.tier"
            value={clause.arg}
            onChange={(e) => onChange({ arg: e.target.value })}
          />
          <NativeSelect
            containerClassName="w-30 flex-none"
            className="bg-background"
            aria-label="비교"
            value={clause.op}
            onChange={(e) => onChange({ op: e.target.value as CompareOp })}
          >
            {(Object.keys(OP_LABEL) as CompareOp[]).map((op) => (
              <NativeSelectOption key={op} value={op}>
                {OP_LABEL[op]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Input
            className="min-w-0 grow basis-30 bg-background"
            aria-label="값"
            placeholder={clause.op === 'in' ? 'a, b, c' : '1000000'}
            value={clause.value}
            onChange={(e) => onChange({ value: e.target.value })}
          />
        </>
      )}
      {clause.kind === 'domain' && (
        <>
          <Input
            className="min-w-0 grow basis-30 bg-background font-mono"
            aria-label="인자 이름"
            placeholder="to"
            value={clause.arg}
            onChange={(e) => onChange({ arg: e.target.value })}
          />
          <Input
            className="min-w-0 grow-3 basis-55 bg-background"
            aria-label="허용 도메인"
            placeholder="example.com, corp.example.com"
            value={clause.domains}
            onChange={(e) => onChange({ domains: e.target.value })}
          />
        </>
      )}
      {clause.kind === 'time' && (
        <>
          <ToggleGroup
            type="multiple"
            variant="outline"
            aria-label="업무 요일"
            value={clause.days.map(String)}
            onValueChange={(v) => onChange({ days: v.map(Number) })}
          >
            {DAY_LABEL.map((d, i) => (
              <ToggleGroupItem
                key={d}
                value={String(i)}
                className="bg-background data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
              >
                {d}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Input
            className="w-33 flex-none bg-background"
            type="time"
            aria-label="시작"
            value={clause.from}
            onChange={(e) => onChange({ from: e.target.value })}
          />
          <span className="text-muted-foreground">–</span>
          <Input
            className="w-33 flex-none bg-background"
            type="time"
            aria-label="끝"
            value={clause.to}
            onChange={(e) => onChange({ to: e.target.value })}
          />
          <Input
            className="min-w-0 grow basis-30 bg-background"
            aria-label="시간대"
            value={clause.tz}
            onChange={(e) => onChange({ tz: e.target.value })}
          />
        </>
      )}
      {onRemove && (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="ml-auto"
                aria-label="조건 삭제"
                onClick={onRemove}
              >
                <XIcon aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>조건 삭제</TooltipContent>
          </Tooltip>
        </>
      )}
    </div>
  );
}
