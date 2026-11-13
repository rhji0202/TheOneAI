/**
 * 사용량 · 비용 — 기간별 사용량 보고(합계 · 일별 · 모델별 · 용도별), 모델 단가 편집(Admin), 월 한도(Owner).
 * API: /v1/admin/billing/usage · model-prices · budget (src/billing/admin/*)
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatNumber, formatPercent } from '../../../shared/format';
import { ApiError } from '../api';
import { useApi, useAuth } from '../auth';
import {
  Badge,
  Button,
  Card,
  type Column,
  DataTable,
  ErrorNotice,
  Field,
  Kpi,
  Loading,
  Notice,
  PageHeader,
  type Query,
  Time,
  useAction,
  useQuery,
  useToast,
} from '../ui';

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
          <div className="row">
            <select
              className="input"
              aria-label="Agent"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
            >
              <option value="">모든 Agent</option>
              {(agents.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <div className="segmented" role="group" aria-label="기간">
              {(Object.keys(RANGE_LABEL) as Range[]).map((r) => (
                <button
                  key={r}
                  type="button"
                  aria-pressed={range === r}
                  onClick={() => setRange(r)}
                >
                  {RANGE_LABEL[r]}
                </button>
              ))}
            </div>
          </div>
        }
      />
      <ErrorNotice error={usage.error} onRetry={() => void usage.reload()} />
      {!report && usage.loading ? (
        <Loading />
      ) : report ? (
        <UsageSection report={report} range={range} />
      ) : null}
      <div className="grid grid-main-side billing-settings">
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
            <code>BUDGET_EXCEEDED</code>(402)로 거부됩니다. Owner 가 한도를 올리거나 풀면 바로
            재개돼요.
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
      <div className="grid grid-4 kpi-row">
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
      <div className="grid grid-main-side">
        <ByModelCard report={report} />
        <ByPurposeCard report={report} />
      </div>
    </>
  );
}

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
    <div className="kpi">
      <p className="kpi-label">이번 달 사용 · 월 한도</p>
      <p className="kpi-value">{formatPercent(Math.min(ratio, 9.99), 0)}</p>
      <div
        className={`meter meter-${state}`}
        role="meter"
        aria-label="월 한도 사용률"
        aria-valuemin={0}
        aria-valuemax={budget.monthlyBudget}
        aria-valuenow={budget.monthToDate}
      >
        <span style={{ width: `${Math.min(100, ratio * 100)}%` }} />
      </div>
      <div className="kpi-foot">
        <span>
          {money(budget.monthToDate, budget.currency)} /{' '}
          {money(budget.monthlyBudget, budget.currency)}
        </span>
        {state === 'over' && <span className="kpi-delta bad">▲ 한도 초과</span>}
        {state === 'near' && <span className="kpi-delta bad">80% 넘음</span>}
      </div>
    </div>
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
        <div className="row">
          <div className="segmented" role="group" aria-label="지표">
            {(Object.keys(METRIC_LABEL) as Metric[]).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={metric === m}
                onClick={() => setMetric(m)}
              >
                {METRIC_LABEL[m]}
              </button>
            ))}
          </div>
          <Button size="sm" variant="ghost" onClick={() => setAsTable((v) => !v)}>
            {asTable ? '차트로 보기' : '표로 보기'}
          </Button>
        </div>
      }
    >
      {asTable ? (
        <div className="table-wrap daily-table">
          <table className="table">
            <thead>
              <tr>
                <th>날짜</th>
                <th className="num">호출</th>
                <th className="num">입력 토큰</th>
                <th className="num">출력 토큰</th>
                <th className="num">비용</th>
              </tr>
            </thead>
            <tbody>
              {[...days].reverse().map((d) => (
                <tr key={d.date}>
                  <td>{d.date}</td>
                  <td className="num">{formatNumber(d.calls)}</td>
                  <td className="num">{formatNumber(d.inputTokens)}</td>
                  <td className="num">{formatNumber(d.outputTokens)}</td>
                  <td className="num">{money(d.cost, currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : empty ? (
        <div className="chart-empty">이 기간에 기록된 모델 호출이 없어요</div>
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
    <div className="chart" ref={wrap}>
      <svg
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
              className={t === 0 ? 'chart-baseline' : 'chart-grid'}
            />
            <text x={pad.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="chart-axis">
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
                  className={hover === i ? 'chart-bar active' : 'chart-bar'}
                  d={`M${x},${y(0)} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + barW - r} Q${x + barW},${yTop} ${x + barW},${yTop + r} V${y(0)} Z`}
                />
              )}
              {i % labelEvery === 0 && (
                <text x={x + barW / 2} y={height - 8} textAnchor="middle" className="chart-axis">
                  {d.label}
                </text>
              )}
              <rect
                x={pad.left + i * band}
                y={pad.top}
                width={band}
                height={plotH}
                className={hover === i ? 'chart-hit active' : 'chart-hit'}
                onMouseEnter={() => setHover(i)}
              />
            </g>
          );
        })}
      </svg>
      {h && hover !== null && (
        <div
          className="chart-tip"
          style={{
            left: Math.min(width - 190, Math.max(0, pad.left + hover * band + band / 2 - 95)),
            top: Math.max(0, Math.min(y(h.value), pad.top + plotH * 0.6) - 78),
          }}
          role="status"
        >
          <p className="chart-tip-title">{h.key}</p>
          <p className="chart-tip-value">{format(h.value)}</p>
          {h.detail && <p className="chart-tip-detail">{h.detail}</p>}
        </div>
      )}
    </div>
  );
}

function ShareBar({ ratio }: { ratio: number }) {
  return (
    <span className="share" title={formatPercent(ratio)}>
      <span className="share-track">
        <span className="share-fill" style={{ width: `${Math.min(100, ratio * 100)}%` }} />
      </span>
      <span className="share-text">{formatPercent(ratio, 0)}</span>
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
          <div className="row model-name">
            <code className="mono">{r.model}</code>
            {!r.priced && <Badge tone="warning">단가 없음</Badge>}
          </div>
          <div className="cell-sub">{PROVIDER_LABEL[r.providerKind] ?? r.providerKind}</div>
        </div>
      ),
    },
    {
      key: 'calls',
      header: '호출',
      align: 'right',
      render: (r) => <span className="num">{formatNumber(r.calls)}</span>,
    },
    {
      key: 'tokens',
      header: '토큰 (입력 · 출력)',
      align: 'right',
      render: (r) => (
        <span className="num">
          {compact(r.inputTokens)} · {compact(r.outputTokens)}
        </span>
      ),
    },
    {
      key: 'cost',
      header: '비용',
      align: 'right',
      render: (r) => <span className="num">{money(r.cost, report.currency)}</span>,
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
      <div className="wide-table model-table">
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
        <p className="muted">이 기간에 기록이 없어요</p>
      ) : (
        <ul className="purpose-list">
          {rows.map((r) => (
            <li key={r.purpose}>
              <div className="purpose-head">
                <span className="purpose-name">{PURPOSE_LABEL[r.purpose] ?? r.purpose}</span>
                <span className="num">{money(r.cost, report.currency)}</span>
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
              <p className="cell-sub">
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
              disabled={!dirty || save.pending}
              onClick={() => {
                setRows((prices.data ?? []).map(toRow));
                setCurrency(prices.data?.[0]?.currency ?? 'USD');
                setDirty(false);
                setLocalError(null);
                save.reset();
              }}
            >
              되돌리기
            </Button>
            <Button
              variant="primary"
              loading={save.pending}
              disabled={!dirty}
              onClick={() => void submit()}
            >
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
              <span>
                단가가 없는 모델 {missing.length}개: {missing.map((m) => m.model).join(', ')}
              </span>
              <Button size="sm" onClick={() => addRows(missing)}>
                줄 추가
              </Button>
            </Notice>
          )}
          <div className="table-wrap">
            <table className="table price-table" aria-label="모델 단가">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>모델</th>
                  <th className="num">입력</th>
                  <th className="num">캐시 입력</th>
                  <th className="num">출력</th>
                  {editable && <th />}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td>
                      <select
                        className="input"
                        aria-label={`${i + 1}번째 provider`}
                        value={r.providerKind}
                        disabled={!editable}
                        onChange={(e) =>
                          change(i, { providerKind: e.target.value as ProviderKind })
                        }
                      >
                        {PROVIDER_KINDS.map((k) => (
                          <option key={k} value={k}>
                            {PROVIDER_LABEL[k]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        className="input mono-input"
                        aria-label={`${i + 1}번째 모델`}
                        value={r.model}
                        disabled={!editable}
                        placeholder="deepseek-chat"
                        onChange={(e) => change(i, { model: e.target.value })}
                      />
                    </td>
                    {(['input', 'cached', 'output'] as const).map((f) => (
                      <td key={f}>
                        <input
                          className="input num-input"
                          inputMode="decimal"
                          aria-label={`${i + 1}번째 ${f === 'input' ? '입력' : f === 'cached' ? '캐시 입력' : '출력'} 단가`}
                          value={r[f]}
                          disabled={!editable}
                          placeholder={f === 'cached' ? '없음' : '0.00'}
                          onChange={(e) => change(i, { [f]: e.target.value })}
                        />
                      </td>
                    ))}
                    {editable && (
                      <td>
                        <button
                          type="button"
                          className="row-remove"
                          aria-label={`${r.model || `${i + 1}번째`} 단가 삭제`}
                          onClick={() => {
                            setRows((prev) => prev.filter((_, j) => j !== i));
                            setDirty(true);
                          }}
                        >
                          ×
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && (
              <div className="table-empty">
                등록한 단가가 없어요 — 모든 호출이 비용 0 으로 기록됩니다.
              </div>
            )}
          </div>
          <div className="price-foot">
            {editable && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => addRows([{ providerKind: 'openai', model: '' }])}
              >
                + 단가 추가
              </Button>
            )}
            <span className="spacer" />
            <label className="currency">
              <span className="muted small">통화</span>
              <input
                className="input"
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
          {!editable && <p className="muted small">단가는 Admin 이상만 바꿀 수 있어요.</p>}
          {prices.data && prices.data.length > 0 && (
            <p className="muted small">
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
        <div className="stack">
          <p className="budget-now">
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
              <div className="budget-form">
                <Field
                  label="월 한도"
                  hint="비우면 한도 없음"
                  error={invalid ? '0 이상의 숫자여야 해요' : undefined}
                >
                  <input
                    className="input num-input"
                    inputMode="decimal"
                    value={amount}
                    placeholder="한도 없음"
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </Field>
                <Field label="통화">
                  <input
                    className="input"
                    value={currency}
                    maxLength={3}
                    onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                  />
                </Field>
              </div>
              <div className="row">
                <Button
                  variant="primary"
                  loading={save.pending}
                  disabled={invalid || unchanged || !/^[A-Z]{3}$/.test(currency)}
                  onClick={() => void submit(parsed)}
                >
                  저장
                </Button>
                {budget.monthlyBudget !== null && (
                  <Button disabled={save.pending} onClick={() => void submit(null)}>
                    한도 풀기
                  </Button>
                )}
              </div>
              <ErrorNotice error={save.error} />
            </>
          ) : (
            <p className="muted small">월 한도는 Owner 만 바꿀 수 있어요.</p>
          )}
        </div>
      )}
    </Card>
  );
}
