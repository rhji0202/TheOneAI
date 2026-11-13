import {
  ArrowRightIcon,
  ChartColumnIcon,
  TableIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import {
  formatNumber,
  formatPercent,
  formatRelative,
  formatRemaining,
} from '../../../shared/format';
import { RISK } from '../../../shared/status';
import { useApi } from '../auth';
import {
  Badge,
  Card,
  type Column,
  DataTable,
  ErrorNotice,
  Kpi,
  Loading,
  Mono,
  type Page,
  PageHeader,
  Time,
  type Tone,
  Toolbar,
  useQuery,
} from '../ui';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import { formatMoney } from './TaskDetail';
import {
  type AdminTaskRow,
  AgentSelect,
  failureLabel,
  formatElapsed,
  Progress,
  TaskStatusCell,
  useAgents,
} from './Tasks';

/* ───────────── 타입 (src/metrics/metrics.service.ts) ───────────── */

type Range = '24h' | '7d' | '30d';

interface KpiValue {
  value: number;
  previous: number;
  target?: number;
  higherIsBetter: boolean;
  status: 'ok' | 'warn';
}

type FailureCause =
  | 'tool_timeout'
  | 'schema_validation'
  | 'permission_denied'
  | 'sandbox_resource'
  | 'approval_rejected'
  | 'budget_exceeded'
  | 'model_error';

interface MetricsResponse {
  range: Range;
  period: { from: string; to: string };
  lastAggregatedAt: string | null;
  kpis: {
    taskSuccessRate: KpiValue;
    evalSuccessRate: KpiValue | null;
    toolSuccessRate: KpiValue;
    recoverySuccessRate: KpiValue;
    humanInterventionRate: KpiValue;
    unauthorizedToolCalls: KpiValue;
    avgCostPerTask: KpiValue & { currency: string };
    avgDurationMs: KpiValue;
    tasksTotal: KpiValue;
  };
  /** 기간 안 날짜별 추이 (UTC, 빈 날은 0) */
  daily: DailyPoint[];
  feedback: { helpful: number; notHelpful: number };
  recentFailures: {
    taskId: string;
    title: string;
    failedStep: string | null;
    cause: FailureCause;
    code: string | null;
    recovery: string;
    at: string;
  }[];
}

interface DailyPoint {
  date: string;
  tasksTotal: number;
  tasksSucceeded: number;
  tasksFailed: number;
  toolDenied: number;
  cost: number;
}

/** GET /v1/admin/approvals 한 줄 (필요한 필드만) */
interface PendingApproval {
  id: string;
  taskId: string;
  taskTitle: string;
  toolName: string;
  riskLevel: string;
  summary: string;
  requiredApprover: 'user' | 'operator' | 'user_and_operator';
  waitingFor: 'user' | 'operator' | 'user_and_operator' | null;
  endUserPseudonym: string;
  expiresAt: string;
}

const RANGES: { id: Range; label: string }[] = [
  { id: '24h', label: '오늘' },
  { id: '7d', label: '7일' },
  { id: '30d', label: '30일' },
];

const CAUSE_LABEL: Record<FailureCause, string> = {
  tool_timeout: 'Tool 시간 초과',
  schema_validation: '인자 · 스키마 검증 실패',
  permission_denied: '권한 거부',
  sandbox_resource: 'Sandbox 자원 초과',
  approval_rejected: '승인 거절',
  budget_exceeded: '예산 · 한도 초과',
  model_error: '모델 · 실행 오류',
};

const WAITING_LABEL: Record<NonNullable<PendingApproval['waitingFor']>, string> = {
  user: '사용자 응답 대기',
  operator: '운영자 결정 필요',
  user_and_operator: '사용자 · 운영자 결정 필요',
};

const RISK_TONE: Record<string, Tone> = { low: 'success', medium: 'warning', high: 'danger' };

const ACTIVE: AdminTaskRow['status'][] = [
  'running',
  'recovering',
  'waiting_approval',
  'queued',
  'paused',
];

/* ───────────── 델타 문구 ───────────── */

type Delta = { text: string; direction: 'up' | 'down' | 'flat' };

function direction(diff: number): Delta['direction'] {
  if (Math.abs(diff) < 1e-9) return 'flat';
  return diff > 0 ? 'up' : 'down';
}

/** 비율 KPI — 퍼센트포인트 차이 */
function rateDelta(k: KpiValue): Delta {
  const diff = k.value - k.previous;
  return {
    text: `${diff >= 0 ? '+' : ''}${(diff * 100).toFixed(1)}%p`,
    direction: direction(diff),
  };
}

/** 건수 KPI — 차이 */
function countDelta(k: KpiValue): Delta {
  const diff = k.value - k.previous;
  return { text: `${diff >= 0 ? '+' : ''}${formatNumber(diff)}`, direction: direction(diff) };
}

/** 금액 · 시간 KPI — 변화율 (직전 0 이면 차이 없음 표시) */
function changeDelta(k: KpiValue): Delta | null {
  if (k.previous === 0) return k.value === 0 ? { text: '변화 없음', direction: 'flat' } : null;
  const ratio = (k.value - k.previous) / k.previous;
  return {
    text: `${ratio >= 0 ? '+' : ''}${(ratio * 100).toFixed(1)}%`,
    direction: direction(ratio),
  };
}

function Target({ k, children }: { k: KpiValue; children: ReactNode }) {
  const missed = k.status === 'warn';
  return (
    <span className={missed ? 'font-semibold text-destructive' : undefined}>
      {children}
      {missed && ' · 미달'}
    </span>
  );
}

/* ───────────── C-01 대시보드 ───────────── */

export function DashboardPage() {
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const range = (params.get('range') as Range | null) ?? '7d';
  const agentId = params.get('agentId') ?? '';
  const agents = useAgents();
  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const metrics = useQuery(
    () => api.get<MetricsResponse>('/v1/admin/metrics', { range, agentId: agentId || undefined }),
    [range, agentId],
    { pollMs: 60_000 },
  );
  const m = metrics.data;

  return (
    <>
      <PageHeader
        title="대시보드"
        description={
          m ? (
            <>
              {m.period.from === m.period.to
                ? `${m.period.from} (UTC)`
                : `${m.period.from} ~ ${m.period.to} (UTC)`}{' '}
              · 직전 같은 기간과 비교 ·{' '}
              {m.lastAggregatedAt
                ? `마지막 집계 ${formatRelative(m.lastAggregatedAt)}`
                : '아직 집계 전'}
            </>
          ) : (
            '품질 지표 · 실행 중 작업 · 승인 대기 · 최근 실패'
          )
        }
      />
      <Toolbar>
        <ToggleGroup
          type="single"
          variant="outline"
          aria-label="기간"
          value={range}
          onValueChange={(v) => v && setParam('range', v)}
        >
          {RANGES.map((r) => (
            <ToggleGroupItem key={r.id} value={r.id}>
              {r.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <div>
          <AgentSelect
            agents={agents.data}
            value={agentId}
            onChange={(v) => setParam('agentId', v)}
          />
        </div>
      </Toolbar>

      <ErrorNotice error={metrics.error} onRetry={() => void metrics.reload()} />
      {m ? <KpiGrid m={m} /> : !metrics.error && <Loading />}
      {m && m.daily.length > 1 && <TrendCard daily={m.daily} />}

      <div className="grid items-start gap-x-4 gap-y-0 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0">
          <ActiveTasksCard agentId={agentId} />
          {m && <FailuresCard failures={m.recentFailures} />}
        </div>
        <div className="min-w-0">
          <PendingApprovalsCard />
          {m && <FeedbackCard feedback={m.feedback} />}
        </div>
      </div>
    </>
  );
}

function KpiGrid({ m }: { m: MetricsResponse }) {
  const k = m.kpis;
  // 직전 기간에 작업이 없으면 비율 비교는 의미가 없다
  const comparable = k.tasksTotal.previous > 0;
  const rate = (v: KpiValue) => (comparable ? rateDelta(v) : null);
  const noPrev = comparable ? undefined : '직전 기간 데이터 없음';
  return (
    <section aria-label="품질 지표">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          label="작업 수"
          value={formatNumber(k.tasksTotal.value)}
          delta={countDelta(k.tasksTotal)}
          goodWhenUp
          hint="직전 기간 대비"
        />
        <Kpi
          label="작업 성공률"
          value={k.tasksTotal.value ? formatPercent(k.taskSuccessRate.value) : '—'}
          delta={k.tasksTotal.value ? rate(k.taskSuccessRate) : null}
          goodWhenUp
          hint={noPrev}
          target={
            <Target k={k.taskSuccessRate}>
              목표 {formatPercent(k.taskSuccessRate.target ?? 0, 0)} 이상
            </Target>
          }
        />
        <Kpi
          label="Tool 성공률"
          value={formatPercent(k.toolSuccessRate.value)}
          delta={rate(k.toolSuccessRate)}
          goodWhenUp
          target={
            <Target k={k.toolSuccessRate}>
              목표 {formatPercent(k.toolSuccessRate.target ?? 0, 0)} 이상
            </Target>
          }
        />
        <Kpi
          label="무단 Tool 호출"
          value={formatNumber(k.unauthorizedToolCalls.value)}
          delta={countDelta(k.unauthorizedToolCalls)}
          goodWhenUp={false}
          target={<Target k={k.unauthorizedToolCalls}>목표 0건</Target>}
        />
        <Kpi
          label="사람 개입률"
          value={formatPercent(k.humanInterventionRate.value)}
          delta={rate(k.humanInterventionRate)}
          goodWhenUp={false}
          target={
            <Target k={k.humanInterventionRate}>
              목표 {formatPercent(k.humanInterventionRate.target ?? 0, 0)} 이하
            </Target>
          }
        />
        <Kpi
          label="복구 성공률"
          value={
            k.recoverySuccessRate.value || k.recoverySuccessRate.previous
              ? formatPercent(k.recoverySuccessRate.value)
              : '—'
          }
          delta={rate(k.recoverySuccessRate)}
          goodWhenUp
          target={
            <Target k={k.recoverySuccessRate}>
              목표 {formatPercent(k.recoverySuccessRate.target ?? 0, 0)} 이상
            </Target>
          }
        />
        <Kpi
          label="작업당 평균 비용"
          value={formatMoney(k.avgCostPerTask.value, k.avgCostPerTask.currency)}
          delta={comparable ? changeDelta(k.avgCostPerTask) : null}
          goodWhenUp={false}
          hint="단가를 등록한 모델 기준"
        />
        <Kpi
          label="평균 소요 시간"
          value={k.avgDurationMs.value ? formatElapsed(k.avgDurationMs.value) : '—'}
          delta={comparable ? changeDelta(k.avgDurationMs) : null}
          goodWhenUp={false}
          hint={noPrev ?? '끝난 작업 기준'}
        />
      </div>
      <p className="mt-2 mb-5 text-xs text-muted-foreground">
        {k.evalSuccessRate
          ? `평가셋 성공률 ${formatPercent(k.evalSuccessRate.value)}`
          : '평가셋 성공률은 Agent 설정에서 평가셋을 실행하면 표시됩니다.'}{' '}
        지표는 metrics-rollup 이 5분마다 집계합니다.
      </p>
    </section>
  );
}

/* ───────────── 날짜별 추이 (누적 막대: 완료 · 실패 · 기타) ───────────── */

const SERIES = [
  { key: 'ok', label: '완료', swatch: 'bg-emerald-500 dark:bg-emerald-400' },
  { key: 'fail', label: '실패', swatch: 'bg-red-500 dark:bg-red-400' },
  { key: 'other', label: '진행 · 취소', swatch: 'bg-zinc-400 dark:bg-zinc-500' },
] as const;

function Swatch({ className }: { className: string }) {
  return <span className={cn('size-2.5 shrink-0 rounded-[3px]', className)} aria-hidden="true" />;
}

function niceMax(n: number): number {
  if (n <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(n));
  const step = [1, 2, 2.5, 5, 10].find((m) => m * pow * 4 >= n)!;
  return step * pow * 4;
}

function TrendCard({ daily }: { daily: DailyPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const max = niceMax(Math.max(...daily.map((d) => d.tasksTotal), 0));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => Math.round(max * t));
  const labelEvery = daily.length > 14 ? 5 : daily.length > 7 ? 2 : 1;
  const total = daily.reduce((n, d) => n + d.tasksTotal, 0);
  const parts = (d: DailyPoint) => ({
    ok: d.tasksSucceeded,
    fail: d.tasksFailed,
    other: Math.max(d.tasksTotal - d.tasksSucceeded - d.tasksFailed, 0),
  });
  const h = hover !== null ? daily[hover] : null;
  return (
    <Card
      title="날짜별 작업"
      description={`기간 합계 ${formatNumber(total)}건 · UTC 날짜 기준`}
      actions={
        <Button size="sm" variant="ghost" onClick={() => setAsTable((v) => !v)}>
          {asTable ? <ChartColumnIcon aria-hidden="true" /> : <TableIcon aria-hidden="true" />}
          {asTable ? '차트로 보기' : '표로 보기'}
        </Button>
      }
    >
      {asTable ? (
        <Table aria-label="날짜별 작업">
          <TableHeader className="bg-muted/50 [&_th]:text-xs [&_th]:text-muted-foreground">
            <TableRow>
              <TableHead>날짜</TableHead>
              <TableHead className="text-right">전체</TableHead>
              <TableHead className="text-right">완료</TableHead>
              <TableHead className="text-right">실패</TableHead>
              <TableHead className="text-right">무단 Tool 호출</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {daily.map((d) => (
              <TableRow key={d.date}>
                <TableCell>{d.date}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNumber(d.tasksTotal)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNumber(d.tasksSucceeded)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNumber(d.tasksFailed)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNumber(d.toolDenied)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <>
          <ul className="mb-3 flex flex-wrap gap-4 text-xs text-muted-foreground" aria-label="범례">
            {SERIES.map((s) => (
              <li key={s.key} className="inline-flex items-center gap-1.5">
                <Swatch className={s.swatch} />
                {s.label}
              </li>
            ))}
          </ul>
          <div
            className="grid h-[200px] grid-cols-[36px_minmax(0,1fr)] gap-2"
            role="img"
            aria-label={`날짜별 작업 수, 기간 합계 ${total}건`}
          >
            <div
              className="flex flex-col justify-between pb-5 text-right text-[11.5px] text-muted-foreground tabular-nums"
              aria-hidden="true"
            >
              {[...ticks].reverse().map((t) => (
                <span key={t} className="leading-[0]">
                  {formatNumber(t)}
                </span>
              ))}
            </div>
            <div className="relative" onMouseLeave={() => setHover(null)}>
              {ticks.map((t) => (
                <div
                  key={t}
                  className={cn('absolute inset-x-0 h-px', t === 0 ? 'bg-border' : 'bg-border/60')}
                  style={{ bottom: `calc(20px + (100% - 20px) * ${t / max})` }}
                />
              ))}
              <div className="absolute inset-x-0 top-0 bottom-5 flex">
                {daily.map((d, i) => {
                  const p = parts(d);
                  return (
                    <div
                      key={d.date}
                      className={cn(
                        'relative flex min-w-0 flex-1 flex-col items-center justify-end rounded',
                        hover === i && 'bg-primary/5',
                      )}
                      onMouseEnter={() => setHover(i)}
                    >
                      <div
                        className="flex w-[min(28px,60%)] flex-col-reverse gap-0.5"
                        style={{ height: `${(d.tasksTotal / max) * 100}%` }}
                      >
                        {SERIES.map((s) =>
                          p[s.key] > 0 ? (
                            <div
                              key={s.key}
                              className={cn('min-h-0.5 basis-0 last:rounded-t', s.swatch)}
                              style={{ flexGrow: p[s.key] }}
                            />
                          ) : null,
                        )}
                      </div>
                      <span
                        className="absolute -bottom-5 h-4 text-[11.5px] whitespace-nowrap text-muted-foreground"
                        aria-hidden="true"
                      >
                        {i % labelEvery === 0 || i === daily.length - 1
                          ? d.date.slice(5).replace('-', '.')
                          : ''}
                      </span>
                    </div>
                  );
                })}
              </div>
              {h && hover !== null && (
                <div
                  className="pointer-events-none absolute top-0 z-10 min-w-36 space-y-0.5 rounded-md border bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-md"
                  style={{
                    left: `${((hover + 0.5) / daily.length) * 100}%`,
                    transform:
                      hover > daily.length / 2
                        ? 'translateX(calc(-100% - 12px))'
                        : 'translateX(12px)',
                  }}
                >
                  <p className="font-semibold">{h.date}</p>
                  <p>
                    전체 <b>{formatNumber(h.tasksTotal)}</b>
                  </p>
                  {SERIES.map((s) => (
                    <p key={s.key} className="flex items-center gap-1.5">
                      <Swatch className={s.swatch} />
                      {s.label} <b>{formatNumber(parts(h)[s.key])}</b>
                    </p>
                  ))}
                  {h.toolDenied > 0 && <p>무단 Tool 호출 {formatNumber(h.toolDenied)}</p>}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </Card>
  );
}

function ActiveTasksCard({ agentId }: { agentId: string }) {
  const api = useApi();
  const navigate = useNavigate();
  const active = useQuery(
    async () => {
      const page = await api.get<Page<AdminTaskRow>>('/v1/admin/tasks', {
        status: ACTIVE.join(','),
        agentId: agentId || undefined,
        limit: 20,
      });
      return { rows: page.items, more: Boolean(page.nextCursor) };
    },
    [agentId],
    { pollMs: 5_000 },
  );

  const columns: Column<AdminTaskRow>[] = [
    {
      key: 'title',
      header: '작업',
      render: (r) => (
        <div className="flex min-w-0 flex-col">
          <span className="max-w-[420px] truncate font-medium" title={r.title}>
            {r.title}
          </span>
          <span className="text-xs text-muted-foreground">
            {r.agentName} · {r.endUserPseudonym}
          </span>
        </div>
      ),
    },
    { key: 'status', header: '상태', width: '130px', render: (r) => <TaskStatusCell row={r} /> },
    {
      key: 'progress',
      header: '진행',
      width: '120px',
      render: (r) => <Progress completed={r.progress.completed} total={r.progress.total} />,
    },
    {
      key: 'elapsed',
      header: '경과',
      width: '80px',
      align: 'right',
      render: (r) => <span className="tabular-nums">{formatElapsed(r.elapsedMs)}</span>,
    },
  ];

  const rows = active.data?.rows ?? [];
  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          진행 중인 작업
          {active.data && <Badge tone={rows.length ? 'info' : 'neutral'}>{rows.length}</Badge>}
        </span>
      }
      description="5초마다 새로 고침"
      actions={
        <Button asChild size="sm" variant="ghost">
          <Link to="/tasks">
            전체 보기
            <ArrowRightIcon aria-hidden="true" />
          </Link>
        </Button>
      }
      flush
    >
      <ErrorNotice error={active.error} />
      <DataTable
        label="진행 중인 작업"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={active.loading && !active.data}
        onRowClick={(r) => navigate(`/tasks/${r.id}`)}
        empty="지금 실행 중인 작업이 없어요."
      />
      {active.data?.more && (
        <p className="border-t px-4 py-2.5 text-sm">
          <Link to="/tasks?status=running" className="text-primary hover:underline">
            더 많은 진행 중 작업 보기
          </Link>
        </p>
      )}
    </Card>
  );
}

function FailuresCard({ failures }: { failures: MetricsResponse['recentFailures'] }) {
  const navigate = useNavigate();
  const columns: Column<MetricsResponse['recentFailures'][number]>[] = [
    {
      key: 'title',
      header: '작업',
      render: (f) => (
        <div className="flex min-w-0 flex-col">
          <span className="max-w-[420px] truncate font-medium" title={f.title}>
            {f.title}
          </span>
          <span className="text-xs text-muted-foreground">
            {f.failedStep ? `실패 단계 ${f.failedStep}` : '실패 단계 기록 없음'}
          </span>
        </div>
      ),
    },
    {
      key: 'cause',
      header: '원인',
      width: '170px',
      render: (f) => (
        <div className="flex flex-col">
          <span>{CAUSE_LABEL[f.cause]}</span>
          {f.code && <span className="text-xs text-muted-foreground">{failureLabel(f.code)}</span>}
        </div>
      ),
    },
    {
      key: 'recovery',
      header: '복구',
      width: '190px',
      render: (f) => (
        <span className="text-xs whitespace-normal text-muted-foreground">{f.recovery}</span>
      ),
    },
    { key: 'at', header: '시각', width: '90px', render: (f) => <Time iso={f.at} /> },
  ];
  return (
    <Card
      title="최근 실패"
      description="기간 안에 실패한 작업 (최근 10건)"
      actions={
        <Button asChild size="sm" variant="ghost">
          <Link to="/tasks?status=failed">
            실패 작업
            <ArrowRightIcon aria-hidden="true" />
          </Link>
        </Button>
      }
      flush
    >
      <DataTable
        label="최근 실패"
        columns={columns}
        rows={failures}
        rowKey={(f) => f.taskId}
        onRowClick={(f) => navigate(`/tasks/${f.taskId}`)}
        empty="이 기간에 실패한 작업이 없어요."
      />
    </Card>
  );
}

function PendingApprovalsCard() {
  const api = useApi();
  const pending = useQuery(
    () => api.get<Page<PendingApproval>>('/v1/admin/approvals', { status: 'pending', limit: 20 }),
    [],
    { pollMs: 15_000 },
  );
  const items = pending.data?.items ?? [];
  // 15초마다 다시 받으므로 남은 시간 표시도 함께 갱신된다
  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          승인 대기
          {pending.data && (
            <Badge tone={items.length ? 'warning' : 'neutral'}>
              {items.length}
              {pending.data.nextCursor ? '+' : ''}
            </Badge>
          )}
        </span>
      }
      actions={
        <Button asChild size="sm" variant="ghost">
          <Link to="/approvals">
            승인 큐
            <ArrowRightIcon aria-hidden="true" />
          </Link>
        </Button>
      }
      flush
    >
      <ErrorNotice error={pending.error} />
      {!pending.data && pending.loading ? (
        <Loading />
      ) : items.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">기다리는 승인 요청이 없어요.</p>
      ) : (
        <ul className="divide-y">
          {items.slice(0, 6).map((a) => {
            const risk = RISK[a.riskLevel];
            return (
              <li key={a.id}>
                <Link
                  to="/approvals"
                  className="flex flex-col gap-1 px-4 py-3 text-foreground transition-colors hover:bg-muted/50 hover:no-underline"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <Mono>{a.toolName}</Mono>
                    {risk && (
                      <Badge tone={RISK_TONE[a.riskLevel] ?? 'neutral'}>위험도 {risk.label}</Badge>
                    )}
                  </span>
                  <span className="truncate font-medium" title={a.taskTitle}>
                    {a.taskTitle}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {a.waitingFor ? WAITING_LABEL[a.waitingFor] : ''} ·{' '}
                    {formatRemaining(a.expiresAt)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function FeedbackCard({ feedback }: { feedback: MetricsResponse['feedback'] }) {
  const total = feedback.helpful + feedback.notHelpful;
  const ratio = total ? feedback.helpful / total : 0;
  return (
    <Card title="사용자 피드백" description="결과 카드의 👍 · 👎">
      {total === 0 ? (
        <p className="text-sm text-muted-foreground">이 기간에 받은 피드백이 없어요.</p>
      ) : (
        <>
          <p className="text-2xl font-bold tabular-nums">
            {formatPercent(ratio, 0)}{' '}
            <span className="text-sm font-medium text-muted-foreground">도움됨</span>
          </p>
          <div
            className="my-2.5 flex h-2 gap-0.5"
            role="img"
            aria-label={`도움됨 ${feedback.helpful}건, 아쉬움 ${feedback.notHelpful}건`}
          >
            {feedback.helpful > 0 && (
              <span
                className="min-w-1 rounded-l-full bg-emerald-500 only:rounded-full dark:bg-emerald-400"
                style={{ flexGrow: feedback.helpful }}
              />
            )}
            {feedback.notHelpful > 0 && (
              <span
                className="min-w-1 rounded-r-full bg-red-500 only:rounded-full dark:bg-red-400"
                style={{ flexGrow: feedback.notHelpful }}
              />
            )}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <ThumbsUpIcon
                className="size-3.5 text-emerald-600 dark:text-emerald-400"
                aria-hidden="true"
              />
              도움됨 {formatNumber(feedback.helpful)}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <ThumbsDownIcon
                className="size-3.5 text-red-600 dark:text-red-400"
                aria-hidden="true"
              />
              아쉬움 {formatNumber(feedback.notHelpful)}
            </span>
          </div>
        </>
      )}
    </Card>
  );
}
