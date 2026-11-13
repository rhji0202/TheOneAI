/**
 * 사용량 · 비용 — 기간별 사용량 보고(합계 · 일별 · 모델별 · 용도별), 모델 단가 편집(Admin), 월 한도(Owner).
 * API: /v1/admin/billing/usage · model-prices · budget (src/billing/admin/*)
 */
import {
  ArrowUpIcon,
  ChartColumnIcon,
  PlusIcon,
  RotateCcwIcon,
  TableIcon,
  XIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatNumber, formatPercent } from '../../../shared/format';
import { ApiError } from '../api';
import { useApi, useAuth } from '../auth';
import {
  Badge,
  Card,
  type Column,
  DataTable,
  ErrorNotice,
  Field,
  Kpi,
  Loading,
  Mono,
  Notice,
  PageHeader,
  type Query,
  Time,
  useAction,
  useQuery,
  useToast,
} from '../ui';
import { Button } from '@/components/ui/button';
import { Card as UiCard } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/* ───────────── 타입 (src/billing/admin/billing-admin.service.ts) ───────────── */

type Range = '7d' | '30d' | 'month';
const PROVIDER_KINDS = [
  'openai',
  'deepseek',
  'gemini',
  'anthropic',
  'openai_compatible',
  'bedrock',
  'vertex',
] as const;
type ProviderKind = (typeof PROVIDER_KINDS)[number];

interface UsageTotals {
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  cost: number;
  unpricedCalls: number;
}
interface UsageReport {
  range: Range;
  from: string;
  currency: string;
  totals: UsageTotals;
  byDay: Array<UsageTotals & { date: string }>;
  byModel: Array<UsageTotals & { providerKind: string; model: string; priced: boolean }>;
  byPurpose: Array<UsageTotals & { purpose: string }>;
  budget: {
    monthlyBudget: number | null;
    currency: string;
    monthToDate: number;
    remaining: number | null;
  };
}
interface ModelPrice {
  providerKind: string;
  model: string;
  inputPerMtok: number;
  cachedInputPerMtok: number | null;
  outputPerMtok: number;
  currency: string;
  updatedAt: string;
}
interface AgentItem {
  id: string;
  name: string;
}

const RANGE_LABEL: Record<Range, string> = {
  '7d': '최근 7일',
  '30d': '최근 30일',
  month: '이번 달',
};
const PURPOSE_LABEL: Record<string, string> = { task: '작업 실행', memory: '기억 추출' };
const PROVIDER_LABEL: Record<string, string> = {
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  gemini: 'Gemini',
  anthropic: 'Anthropic',
  openai_compatible: 'OpenAI 호환',
  bedrock: 'Bedrock',
  vertex: 'Vertex',
};

function money(n: number, currency: string): string {
  const digits = n !== 0 && Math.abs(n) < 1 ? 4 : 2;
  try {
    return new Intl.NumberFormat('ko-KR', {
      style: 'currency',
      currency,
      minimumFractionDigits: currency === 'KRW' || currency === 'JPY' ? 0 : Math.min(2, digits),
      maximumFractionDigits: currency === 'KRW' || currency === 'JPY' ? 0 : digits,
    }).format(n);
  } catch {
    return `${formatNumber(n, digits)} ${currency}`;
  }
}

/** 큰 수 축약 — 1.2만 · 3.4억 (축 라벨 · 타일) */
function compact(n: number): string {
  return new Intl.NumberFormat('ko-KR', { notation: 'compact', maximumFractionDigits: 1 }).format(
    n,
  );
}

const tokensOf = (t: UsageTotals) => t.inputTokens + t.outputTokens;

/* ───────────── 페이지 ───────────── */

export function BillingPage() {
  const api = useApi();
  const [range, setRange] = useState<Range>('30d');
  const [agentId, setAgentId] = useState('');
  const agents = useQuery(() => api.get<AgentItem[]>('/v1/admin/agents'), []);
  const usage = useQuery(
    () => api.get<UsageReport>('/v1/admin/billing/usage', { range, agentId: agentId || undefined }),
    [range, agentId],
  );
  const prices = useQuery(() => api.get<ModelPrice[]>('/v1/admin/billing/model-prices'), []);
  const report = usage.data;

  return (
    <>
      <PageHeader
        title="사용량 · 비용"
        description="모델 호출 토큰과 비용입니다. 비용은 워크스페이스가 등록한 모델 단가로 계산해요 (기억 추출 호출도 포함)."
        actions={
          <>
            <NativeSelect
              containerClassName="w-auto"
              aria-label="Agent"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
            >
              <NativeSelectOption value="">모든 Agent</NativeSelectOption>
              {(agents.data ?? []).map((a) => (
                <NativeSelectOption key={a.id} value={a.id}>
                  {a.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <ToggleGroup
              type="single"
              variant="outline"
              aria-label="기간"
              value={range}
              onValueChange={(v) => v && setRange(v as Range)}
            >
              {(Object.keys(RANGE_LABEL) as Range[]).map((r) => (
                <ToggleGroupItem key={r} value={r}>
                  {RANGE_LABEL[r]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </>
        }
      />
      <ErrorNotice error={usage.error} onRetry={() => void usage.reload()} />
      {!report && usage.loading ? (
        <Loading />
      ) : report ? (
        <UsageSection report={report} range={range} />
      ) : null}
      <div className="mt-4 grid items-start gap-x-4 gap-y-0 xl:grid-cols-[minmax(0,1fr)_340px]">
        <PricesCard
          prices={prices}
          unpriced={(report?.byModel ?? []).filter((m) => !m.priced)}
          onSaved={() => void usage.reload()}
        />
        <BudgetCard report={report} onSaved={() => void usage.reload()} />
      </div>
    </>
  );
}

/* ───────────── 사용량 ───────────── */

function UsageSection({ report, range }: { report: UsageReport; range: Range }) {
  const { totals, currency, budget } = report;
  const exceeded = budget.monthlyBudget !== null && budget.monthToDate >= budget.monthlyBudget;
  const days = useMemo(() => fillDays(report), [report]);
  return (
    <>
      {exceeded && (
        <Notice tone="error">
          <span>
            <strong>월 한도를 넘었어요.</strong> 이번 달{' '}
            {money(budget.monthToDate, budget.currency)} / 한도{' '}
            {money(budget.monthlyBudget ?? 0, budget.currency)} — 새 작업 요청은{' '}
            <code className="rounded bg-muted px-1 font-mono text-xs">BUDGET_EXCEEDED</code>(402)로
            거부됩니다. Owner 가 한도를 올리거나 풀면 바로 재개돼요.
          </span>
        </Notice>
      )}
      {totals.unpricedCalls > 0 && (
        <Notice tone="warn">
          <span>
            단가가 없는 모델 호출 {formatNumber(totals.unpricedCalls)}건은 비용 0 으로 기록됐어요.
            아래 모델 단가에 등록하면 이후 호출부터 비용이 계산됩니다.
          </span>
        </Notice>
      )}
      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          label={`비용 · ${RANGE_LABEL[range]}`}
          value={money(totals.cost, currency)}
          hint={`일 평균 ${money(days.length ? totals.cost / days.length : 0, currency)}`}
        />
        <Kpi
          label="모델 호출"
          value={formatNumber(totals.calls)}
          hint={`${formatNumber(totals.unpricedCalls)}건 단가 없음`}
        />
        <Kpi
          label="토큰"
          value={compact(tokensOf(totals))}
          hint={`입력 ${compact(totals.inputTokens)} (캐시 ${compact(totals.cachedInputTokens)}) · 출력 ${compact(totals.outputTokens)}`}
        />
        <BudgetKpi budget={budget} />
      </div>
      <DailyCard days={days} currency={currency} />
      <div className="grid gap-x-4 gap-y-0 xl:grid-cols-[minmax(0,1fr)_340px]">
        <ByModelCard report={report} />
        <ByPurposeCard report={report} />
      </div>
    </>
  );
}

const METER_FILL = {
  ok: 'bg-primary',
  near: 'bg-amber-500 dark:bg-amber-400',
  over: 'bg-destructive',
} as const;

function BudgetKpi({ budget }: { budget: UsageReport['budget'] }) {
  if (budget.monthlyBudget === null)
    return (
      <Kpi
        label="이번 달 사용 · 한도 없음"
        value={money(budget.monthToDate, budget.currency)}
        hint="월 한도를 정하지 않았어요"
      />
    );
  const ratio = budget.monthlyBudget > 0 ? budget.monthToDate / budget.monthlyBudget : 1;
  const state = ratio >= 1 ? 'over' : ratio >= 0.8 ? 'near' : 'ok';
  return (
    <UiCard className="min-w-0 gap-1 px-4 py-3.5">
      <p className="text-sm text-muted-foreground">이번 달 사용 · 월 한도</p>
      <p className="text-2xl font-semibold tracking-tight tabular-nums">
        {formatPercent(Math.min(ratio, 9.99), 0)}
      </p>
      <div
        className="my-1 h-1.5 overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-label="월 한도 사용률"
        aria-valuemin={0}
        aria-valuemax={budget.monthlyBudget}
        aria-valuenow={budget.monthToDate}
      >
        <span
          className={cn('block h-full rounded-full', METER_FILL[state])}
          style={{ width: `${Math.min(100, ratio * 100)}%` }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span>
          {money(budget.monthToDate, budget.currency)} /{' '}
          {money(budget.monthlyBudget, budget.currency)}
        </span>
        {state === 'over' && (
          <span className="inline-flex items-center gap-0.5 font-semibold text-red-600 dark:text-red-400">
            <ArrowUpIcon className="size-3" aria-hidden="true" /> 한도 초과
          </span>
        )}
        {state === 'near' && (
          <span className="font-semibold text-red-600 dark:text-red-400">80% 넘음</span>
        )}
      </div>
    </UiCard>
  );
}

interface Day extends UsageTotals {
  date: string;
}

/** 기간의 모든 날짜를 채운다 (호출이 없는 날은 0) */
function fillDays(report: UsageReport): Day[] {
  const byDate = new Map(report.byDay.map((d) => [d.date, d]));
  const out: Day[] = [];
  const start = new Date(`${report.from.slice(0, 10)}T00:00:00Z`);
  const today = new Date();
  const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  for (let t = start.getTime(); t <= end; t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10);
    out.push(
      byDate.get(date) ?? {
        date,
        calls: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        cost: 0,
        unpricedCalls: 0,
      },
    );
  }
  return out;
}

type Metric = 'cost' | 'tokens' | 'calls';
const METRIC_LABEL: Record<Metric, string> = { cost: '비용', tokens: '토큰', calls: '호출' };

function DailyCard({ days, currency }: { days: Day[]; currency: string }) {
  const [metric, setMetric] = useState<Metric>('cost');
  const [asTable, setAsTable] = useState(false);
  const value = (d: Day) =>
    metric === 'cost' ? d.cost : metric === 'tokens' ? tokensOf(d) : d.calls;
  const format = (n: number) => (metric === 'cost' ? money(n, currency) : formatNumber(n));
  const empty = days.every((d) => value(d) === 0);
  return (
    <Card
      title={`일별 ${METRIC_LABEL[metric]}`}
      description="UTC 날짜 기준"
      actions={
        <>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            aria-label="지표"
            value={metric}
            onValueChange={(v) => v && setMetric(v as Metric)}
          >
            {(Object.keys(METRIC_LABEL) as Metric[]).map((m) => (
              <ToggleGroupItem key={m} value={m}>
                {METRIC_LABEL[m]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Button size="sm" variant="ghost" onClick={() => setAsTable((v) => !v)}>
            {asTable ? <ChartColumnIcon aria-hidden="true" /> : <TableIcon aria-hidden="true" />}
            {asTable ? '차트로 보기' : '표로 보기'}
          </Button>
        </>
      }
    >
      {asTable ? (
        <div className="max-h-80 overflow-auto">
          <Table aria-label="일별 사용량">
            <TableHeader className="bg-muted/50 [&_th]:text-xs [&_th]:text-muted-foreground">
              <TableRow>
                <TableHead>날짜</TableHead>
                <TableHead className="text-right">호출</TableHead>
                <TableHead className="text-right">입력 토큰</TableHead>
                <TableHead className="text-right">출력 토큰</TableHead>
                <TableHead className="text-right">비용</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...days].reverse().map((d) => (
                <TableRow key={d.date}>
                  <TableCell>{d.date}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(d.calls)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(d.inputTokens)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(d.outputTokens)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(d.cost, currency)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : empty ? (
        <div className="grid h-44 place-items-center rounded-lg border border-dashed text-sm text-muted-foreground">
          이 기간에 기록된 모델 호출이 없어요
        </div>
      ) : (
        <BarChart
          data={days.map((d) => ({
            key: d.date,
            label: d.date.slice(5).replace('-', '/'),
            value: value(d),
            detail: `호출 ${formatNumber(d.calls)} · 토큰 ${compact(tokensOf(d))} · ${money(d.cost, currency)}`,
          }))}
          format={format}
          axisFormat={(n) => (metric === 'cost' ? money(n, currency) : compact(n))}
          label={`일별 ${METRIC_LABEL[metric]}`}
        />
      )}
    </Card>
  );
}

/* 막대 차트 — 직접 그린 SVG. 축 하나 · 얇은 막대(위쪽만 4px 라운드) · 흐린 격자 · 막대 열 전체가 hover 영역 */

interface Bar {
  key: string;
  label: string;
  value: number;
  detail?: string;
}

function niceMax(max: number): { top: number; step: number } {
  if (max <= 0) return { top: 1, step: 0.25 };
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s * 4 >= max) ?? 10 * pow;
  return { top: step * 4, step };
}

function BarChart({
  data,
  format,
  axisFormat,
  label,
}: {
  data: Bar[];
  format: (n: number) => string;
  axisFormat: (n: number) => string;
  label: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(280, Math.floor(entry.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const height = 220;
  const pad = { top: 12, right: 8, bottom: 26, left: 64 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const max = Math.max(...data.map((d) => d.value));
  const { top, step } = niceMax(max);
  const band = plotW / Math.max(1, data.length);
  const barW = Math.max(2, Math.min(18, band - 2));
  const y = (v: number) => pad.top + plotH - (v / top) * plotH;
  const ticks = [0, 1, 2, 3, 4].map((i) => i * step);
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(plotW / 56))));
  const total = data.reduce((n, d) => n + d.value, 0);
  const h = hover !== null ? data[hover] : null;

  return (
    <div className="relative w-full overflow-hidden" ref={wrap}>
      <svg
        className="block"
        width={width}
        height={height}
        role="img"
        aria-label={`${label} 막대 차트 — ${data.length}일 합계 ${format(total)}, 최대 ${format(max)}`}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={pad.left}
              x2={width - pad.right}
              y1={y(t)}
              y2={y(t)}
              className={t === 0 ? 'stroke-muted-foreground/40' : 'stroke-border'}
            />
            <text
              x={pad.left - 8}
              y={y(t)}
              dy="0.32em"
              textAnchor="end"
              className="fill-muted-foreground text-[11px] tabular-nums"
            >
              {axisFormat(t)}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = pad.left + i * band + (band - barW) / 2;
          const bh = Math.max(0, y(0) - y(d.value));
          const r = Math.min(4, barW / 2, bh);
          const yTop = y(0) - bh;
          return (
            <g key={d.key}>
              {d.value > 0 && (
                <path
                  className={cn('fill-primary', hover === i ? 'opacity-100' : 'opacity-90')}
                  d={`M${x},${y(0)} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + barW - r} Q${x + barW},${yTop} ${x + barW},${yTop + r} V${y(0)} Z`}
                />
              )}
              {i % labelEvery === 0 && (
                <text
                  x={x + barW / 2}
                  y={height - 8}
                  textAnchor="middle"
                  className="fill-muted-foreground text-[11px] tabular-nums"
                >
                  {d.label}
                </text>
              )}
              <rect
                x={pad.left + i * band}
                y={pad.top}
                width={band}
                height={plotH}
                className={hover === i ? 'fill-foreground/5' : 'fill-transparent'}
                onMouseEnter={() => setHover(i)}
              />
            </g>
          );
        })}
      </svg>
      {h && hover !== null && (
        <div
          className="pointer-events-none absolute w-[190px] rounded-md border bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-md"
          style={{
            left: Math.min(width - 190, Math.max(0, pad.left + hover * band + band / 2 - 95)),
            top: Math.max(0, Math.min(y(h.value), pad.top + plotH * 0.6) - 78),
          }}
          role="status"
        >
          <p className="text-muted-foreground">{h.key}</p>
          <p className="text-[15px] font-bold tabular-nums">{format(h.value)}</p>
          {h.detail && <p className="text-muted-foreground">{h.detail}</p>}
        </div>
      )}
    </div>
  );
}

function ShareBar({ ratio }: { ratio: number }) {
  return (
    <span
      className="inline-flex w-full min-w-[110px] items-center gap-2"
      title={formatPercent(ratio)}
    >
      <span className="h-1.5 min-w-10 flex-1 overflow-hidden rounded-full bg-muted">
        <span
          className="block h-full rounded-full bg-primary"
          style={{ width: `${Math.min(100, ratio * 100)}%` }}
        />
      </span>
      <span className="w-9 text-right text-xs whitespace-nowrap text-muted-foreground tabular-nums">
        {formatPercent(ratio, 0)}
      </span>
    </span>
  );
}

function ByModelCard({ report }: { report: UsageReport }) {
  const totalCost = report.totals.cost;
  const totalTokens = tokensOf(report.totals);
  const share = (r: UsageTotals) =>
    totalCost > 0 ? r.cost / totalCost : totalTokens > 0 ? tokensOf(r) / totalTokens : 0;
  const rows = [...report.byModel].sort((a, b) => b.cost - a.cost || tokensOf(b) - tokensOf(a));
  const columns: Column<(typeof rows)[number]>[] = [
    {
      key: 'model',
      header: '모델',
      render: (r) => (
        <div>
          <div className="flex items-center gap-1.5 [&_code]:break-normal [&_code]:whitespace-nowrap">
            <Mono>{r.model}</Mono>
            {!r.priced && <Badge tone="warning">단가 없음</Badge>}
          </div>
          <div className="text-xs text-muted-foreground">
            {PROVIDER_LABEL[r.providerKind] ?? r.providerKind}
          </div>
        </div>
      ),
    },
    {
      key: 'calls',
      header: '호출',
      align: 'right',
      render: (r) => <span className="tabular-nums">{formatNumber(r.calls)}</span>,
    },
    {
      key: 'tokens',
      header: '토큰 (입력 · 출력)',
      align: 'right',
      render: (r) => (
        <span className="tabular-nums">
          {compact(r.inputTokens)} · {compact(r.outputTokens)}
        </span>
      ),
    },
    {
      key: 'cost',
      header: '비용',
      align: 'right',
      render: (r) => <span className="tabular-nums">{money(r.cost, report.currency)}</span>,
    },
    {
      key: 'share',
      header: totalCost > 0 ? '비용 비중' : '토큰 비중',
      width: '130px',
      render: (r) => <ShareBar ratio={share(r)} />,
    },
  ];
  return (
    <Card title="모델별" flush>
      <div className="[&_table]:min-w-[640px]">
        <DataTable
          label="모델별 사용량"
          columns={columns}
          rows={rows}
          rowKey={(r) => `${r.providerKind}|${r.model}`}
          empty="이 기간에 호출한 모델이 없어요"
        />
      </div>
    </Card>
  );
}

function ByPurposeCard({ report }: { report: UsageReport }) {
  const totalCost = report.totals.cost;
  const totalTokens = tokensOf(report.totals);
  const rows = [...report.byPurpose].sort((a, b) => b.cost - a.cost || tokensOf(b) - tokensOf(a));
  return (
    <Card title="용도별" description={totalCost > 0 ? '비용 비중' : '토큰 비중'}>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">이 기간에 기록이 없어요</p>
      ) : (
        <ul className="flex flex-col gap-3.5">
          {rows.map((r) => (
            <li key={r.purpose}>
              <div className="mb-1 flex justify-between gap-2">
                <span className="font-medium">{PURPOSE_LABEL[r.purpose] ?? r.purpose}</span>
                <span className="whitespace-nowrap tabular-nums">
                  {money(r.cost, report.currency)}
                </span>
              </div>
              <ShareBar
                ratio={
                  totalCost > 0
                    ? r.cost / totalCost
                    : totalTokens > 0
                      ? tokensOf(r) / totalTokens
                      : 0
                }
              />
              <p className="mt-0.5 text-xs text-muted-foreground">
                {r.purpose === 'memory'
                  ? '작업이 끝난 뒤 기억할 내용 추리기'
                  : '계획 · 실행 · 답변 · 검증'}{' '}
                · 호출 {formatNumber(r.calls)} · 토큰 {compact(tokensOf(r))}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ───────────── 모델 단가 ───────────── */

interface PriceRow {
  providerKind: ProviderKind;
  model: string;
  input: string;
  cached: string;
  output: string;
}

const toRow = (p: ModelPrice): PriceRow => ({
  providerKind: (PROVIDER_KINDS as readonly string[]).includes(p.providerKind)
    ? (p.providerKind as ProviderKind)
    : 'openai_compatible',
  model: p.model,
  input: String(p.inputPerMtok),
  cached: p.cachedInputPerMtok === null ? '' : String(p.cachedInputPerMtok),
  output: String(p.outputPerMtok),
});

function rowIssue(r: PriceRow): string | null {
  if (!r.model.trim()) return '모델 이름을 입력하세요';
  for (const [label, v, optional] of [
    ['입력 단가', r.input, false],
    ['캐시 입력 단가', r.cached, true],
    ['출력 단가', r.output, false],
  ] as const) {
    if (optional && v.trim() === '') continue;
    const n = Number(v);
    if (v.trim() === '' || !Number.isFinite(n) || n < 0) return `${label}는 0 이상의 숫자여야 해요`;
  }
  return null;
}

function PricesCard({
  prices,
  unpriced,
  onSaved,
}: {
  prices: Query<ModelPrice[]>;
  unpriced: Array<{ providerKind: string; model: string }>;
  onSaved: () => void;
}) {
  const api = useApi();
  const { can } = useAuth();
  const toast = useToast();
  const editable = can('admin');
  const [rows, setRows] = useState<PriceRow[]>([]);
  const [currency, setCurrency] = useState('USD');
  const [dirty, setDirty] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  useEffect(() => {
    if (!prices.data) return;
    setRows(prices.data.map(toRow));
    setCurrency(prices.data[0]?.currency ?? 'USD');
    setDirty(false);
  }, [prices.data]);
  const save = useAction((body: unknown) =>
    api.put<ModelPrice[]>('/v1/admin/billing/model-prices', body),
  );

  const change = (i: number, patch: Partial<PriceRow>) => {
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    setDirty(true);
  };
  const missing = unpriced.filter(
    (u) => !rows.some((r) => r.providerKind === u.providerKind && r.model === u.model),
  );
  const addRows = (list: Array<{ providerKind: string; model: string }>) => {
    setRows((prev) => [
      ...prev,
      ...list.map((u) => ({
        providerKind: ((PROVIDER_KINDS as readonly string[]).includes(u.providerKind)
          ? u.providerKind
          : 'openai_compatible') as ProviderKind,
        model: u.model,
        input: '',
        cached: '',
        output: '',
      })),
    ]);
    setDirty(true);
  };

  const submit = async () => {
    setLocalError(null);
    if (!/^[A-Z]{3}$/.test(currency)) {
      setLocalError('통화는 영문 대문자 3자리(USD · KRW 등)여야 해요');
      return;
    }
    for (const [i, r] of rows.entries()) {
      const issue = rowIssue(r);
      if (issue) {
        setLocalError(`${i + 1}번째 줄: ${issue}`);
        return;
      }
    }
    const keys = rows.map((r) => `${r.providerKind}|${r.model.trim()}`);
    if (new Set(keys).size !== keys.length) {
      setLocalError('같은 provider · 모델이 두 번 있어요');
      return;
    }
    const saved = await save.run({
      prices: rows.map((r) => ({
        providerKind: r.providerKind,
        model: r.model.trim(),
        inputPerMtok: Number(r.input),
        cachedInputPerMtok: r.cached.trim() === '' ? null : Number(r.cached),
        outputPerMtok: Number(r.output),
        currency,
      })),
    });
    if (saved) {
      prices.setData(saved);
      toast('모델 단가를 저장했어요 — 이후 호출부터 적용돼요');
      onSaved();
    }
  };

  const serverIssues =
    save.error instanceof ApiError && Array.isArray(save.error.body.errors)
      ? (save.error.body.errors as Array<{ path: string; message: string }>)
      : [];

  return (
    <Card
      title="모델 단가"
      description="100만 토큰당 가격. 바꾼 단가는 이후 호출부터 적용되고, 이미 기록된 비용은 바뀌지 않아요."
      actions={
        editable ? (
          <>
            <Button
              variant="outline"
              disabled={!dirty || save.pending}
              onClick={() => {
                setRows((prices.data ?? []).map(toRow));
                setCurrency(prices.data?.[0]?.currency ?? 'USD');
                setDirty(false);
                setLocalError(null);
                save.reset();
              }}
            >
              <RotateCcwIcon aria-hidden="true" />
              되돌리기
            </Button>
            <Button loading={save.pending} disabled={!dirty} onClick={() => void submit()}>
              저장
            </Button>
          </>
        ) : undefined
      }
    >
      {prices.loading && !prices.data ? (
        <Loading />
      ) : (
        <>
          <ErrorNotice error={prices.error} onRetry={() => void prices.reload()} />
          {editable && missing.length > 0 && (
            <Notice tone="warn">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  단가가 없는 모델 {missing.length}개: {missing.map((m) => m.model).join(', ')}
                </span>
                <Button variant="outline" size="sm" onClick={() => addRows(missing)}>
                  <PlusIcon aria-hidden="true" />줄 추가
                </Button>
              </div>
            </Notice>
          )}
          <Table aria-label="모델 단가" className="min-w-[620px]">
            <TableHeader className="bg-muted/50 [&_th]:text-xs [&_th]:text-muted-foreground">
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead>모델</TableHead>
                <TableHead className="text-right">입력</TableHead>
                <TableHead className="text-right">캐시 입력</TableHead>
                <TableHead className="text-right">출력</TableHead>
                {editable && <TableHead className="w-10" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={i} className="hover:bg-transparent">
                  <TableCell className="px-2 py-1.5">
                    <NativeSelect
                      containerClassName="min-w-[130px]"
                      aria-label={`${i + 1}번째 provider`}
                      value={r.providerKind}
                      disabled={!editable}
                      onChange={(e) => change(i, { providerKind: e.target.value as ProviderKind })}
                    >
                      {PROVIDER_KINDS.map((k) => (
                        <NativeSelectOption key={k} value={k}>
                          {PROVIDER_LABEL[k]}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </TableCell>
                  <TableCell className="px-2 py-1.5">
                    <Input
                      className="min-w-40 font-mono text-[12.5px]"
                      aria-label={`${i + 1}번째 모델`}
                      value={r.model}
                      disabled={!editable}
                      placeholder="deepseek-chat"
                      onChange={(e) => change(i, { model: e.target.value })}
                    />
                  </TableCell>
                  {(['input', 'cached', 'output'] as const).map((f) => (
                    <TableCell key={f} className="px-2 py-1.5">
                      <Input
                        className="min-w-20 text-right tabular-nums"
                        inputMode="decimal"
                        aria-label={`${i + 1}번째 ${f === 'input' ? '입력' : f === 'cached' ? '캐시 입력' : '출력'} 단가`}
                        value={r[f]}
                        disabled={!editable}
                        placeholder={f === 'cached' ? '없음' : '0.00'}
                        onChange={(e) => change(i, { [f]: e.target.value })}
                      />
                    </TableCell>
                  ))}
                  {editable && (
                    <TableCell className="px-2 py-1.5">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-muted-foreground"
                            aria-label={`${r.model || `${i + 1}번째`} 단가 삭제`}
                            onClick={() => {
                              setRows((prev) => prev.filter((_, j) => j !== i));
                              setDirty(true);
                            }}
                          >
                            <XIcon aria-hidden="true" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>단가 삭제</TooltipContent>
                      </Tooltip>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {rows.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              등록한 단가가 없어요 — 모든 호출이 비용 0 으로 기록됩니다.
            </div>
          )}
          <div className="my-2.5 flex items-center gap-2">
            {editable && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => addRows([{ providerKind: 'openai', model: '' }])}
              >
                <PlusIcon aria-hidden="true" />
                단가 추가
              </Button>
            )}
            <label className="ml-auto inline-flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">통화</span>
              <Input
                className="w-[70px] uppercase"
                value={currency}
                maxLength={3}
                disabled={!editable}
                aria-label="단가 통화"
                onChange={(e) => {
                  setCurrency(e.target.value.toUpperCase());
                  setDirty(true);
                }}
              />
            </label>
          </div>
          {localError && <Notice tone="error">{localError}</Notice>}
          {serverIssues.map((s) => (
            <Notice key={s.path + s.message} tone="error">
              {s.path ? `${s.path}: ` : ''}
              {s.message}
            </Notice>
          ))}
          {save.error && serverIssues.length === 0 && <ErrorNotice error={save.error} />}
          {!editable && (
            <p className="text-xs text-muted-foreground">단가는 Admin 이상만 바꿀 수 있어요.</p>
          )}
          {prices.data && prices.data.length > 0 && (
            <p className="text-xs text-muted-foreground">
              마지막 변경{' '}
              <Time
                iso={
                  prices.data
                    .map((p) => p.updatedAt)
                    .sort()
                    .at(-1) ?? null
                }
              />
            </p>
          )}
        </>
      )}
    </Card>
  );
}

/* ───────────── 월 한도 ───────────── */

function BudgetCard({ report, onSaved }: { report: UsageReport | undefined; onSaved: () => void }) {
  const api = useApi();
  const { can } = useAuth();
  const toast = useToast();
  const owner = can('owner');
  const budget = report?.budget;
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  useEffect(() => {
    if (!budget) return;
    setAmount(budget.monthlyBudget === null ? '' : String(budget.monthlyBudget));
    setCurrency(budget.currency);
  }, [budget]);
  const save = useAction((body: { monthlyBudget: number | null; currency: string }) =>
    api.put<UsageReport['budget']>('/v1/admin/billing/budget', body),
  );
  const parsed = amount.trim() === '' ? null : Number(amount.replace(/,/g, ''));
  const invalid = parsed !== null && (!Number.isFinite(parsed) || parsed < 0);
  const unchanged =
    budget !== undefined && parsed === budget.monthlyBudget && currency === budget.currency;

  const submit = async (value: number | null) => {
    const r = await save.run({ monthlyBudget: value, currency });
    if (r) {
      toast(value === null ? '월 한도를 풀었어요' : '월 한도를 저장했어요');
      onSaved();
    }
  };

  return (
    <Card
      title="월 한도"
      description="이번 달 비용이 한도에 닿으면 새 작업 요청을 402 BUDGET_EXCEEDED 로 거부해요. 실행 중인 작업은 끝까지 진행됩니다."
    >
      {!budget ? (
        <Loading />
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm">
            이번 달 <strong>{money(budget.monthToDate, budget.currency)}</strong>
            {budget.monthlyBudget !== null ? (
              <>
                {' '}
                / {money(budget.monthlyBudget, budget.currency)} ·{' '}
                {budget.remaining !== null && budget.remaining > 0
                  ? `${money(budget.remaining, budget.currency)} 남음`
                  : '한도 초과'}
              </>
            ) : (
              ' · 한도 없음'
            )}
          </p>
          {owner ? (
            <>
              <div className="grid grid-cols-[minmax(0,1fr)_90px] gap-x-2.5 gap-y-0">
                <Field
                  label="월 한도"
                  hint="비우면 한도 없음"
                  error={invalid ? '0 이상의 숫자여야 해요' : undefined}
                >
                  <Input
                    className="text-right tabular-nums"
                    inputMode="decimal"
                    value={amount}
                    placeholder="한도 없음"
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </Field>
                <Field label="통화">
                  <Input
                    className="uppercase"
                    value={currency}
                    maxLength={3}
                    onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                  />
                </Field>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  loading={save.pending}
                  disabled={invalid || unchanged || !/^[A-Z]{3}$/.test(currency)}
                  onClick={() => void submit(parsed)}
                >
                  저장
                </Button>
                {budget.monthlyBudget !== null && (
                  <Button
                    variant="outline"
                    disabled={save.pending}
                    onClick={() => void submit(null)}
                  >
                    한도 풀기
                  </Button>
                )}
              </div>
              <ErrorNotice error={save.error} />
            </>
          ) : (
            <p className="text-xs text-muted-foreground">월 한도는 Owner 만 바꿀 수 있어요.</p>
          )}
        </div>
      )}
    </Card>
  );
}
