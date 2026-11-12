import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { AdminSession } from '../admin/auth/admin-session.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService, type TenantTx } from '../infrastructure/database/prisma.service.js';

export const metricsQuerySchema = z.object({
  agentId: z.uuid().optional(),
  range: z.enum(['24h', '7d', '30d']).default('7d'),
});
export type MetricsQuery = z.infer<typeof metricsQuerySchema>;

/** docs/api-spec.md §4.1 */
export interface Kpi {
  value: number;
  previous: number;
  target?: number;
  higherIsBetter: boolean;
  status: 'ok' | 'warn';
}

export type FailureCause =
  | 'tool_timeout'
  | 'schema_validation'
  | 'permission_denied'
  | 'sandbox_resource'
  | 'approval_rejected'
  | 'budget_exceeded'
  | 'model_error';

export interface MetricsResponse {
  range: MetricsQuery['range'];
  /** 집계 기간 (UTC 날짜, 포함) */
  period: { from: string; to: string };
  lastAggregatedAt: string | null;
  kpis: {
    taskSuccessRate: Kpi;
    evalSuccessRate: Kpi | null;
    toolSuccessRate: Kpi;
    recoverySuccessRate: Kpi;
    humanInterventionRate: Kpi;
    unauthorizedToolCalls: Kpi;
    avgCostPerTask: Kpi & { currency: string };
    avgDurationMs: Kpi;
    tasksTotal: Kpi;
  };
  feedback: { helpful: number; notHelpful: number };
  recentFailures: Array<{
    taskId: string;
    title: string;
    failedStep: string | null;
    cause: FailureCause;
    code: string | null;
    recovery: string;
    at: string;
  }>;
}

interface Sums {
  tasks_total: number;
  tasks_succeeded: number;
  tasks_failed: number;
  tool_calls: number;
  tool_succeeded: number;
  tool_denied: number;
  recoveries_attempted: number;
  recoveries_succeeded: number;
  human_interventions: number;
  cost: string;
  duration: number;
}

const DAYS = { '24h': 1, '7d': 7, '30d': 30 } as const;
/** KPI 목표 (C-01) — 없으면 상태는 늘 ok */
const TARGETS = {
  taskSuccessRate: 0.9,
  toolSuccessRate: 0.95,
  recoverySuccessRate: 0.8,
  humanInterventionRate: 0.2,
  unauthorizedToolCalls: 0,
} as const;

/**
 * 품질 지표 (C-01 대시보드). metrics_daily(metrics-rollup 이 5분마다 갱신)에서 기간 합계를 내고
 * 같은 길이의 직전 기간과 비교한다. 기간은 UTC 날짜 단위 — 24h = 오늘, 7d = 오늘 포함 7일.
 */
@Injectable()
export class MetricsService {
  constructor(private readonly prisma: PrismaService) {}

  async metrics(admin: AdminSession, q: MetricsQuery): Promise<MetricsResponse> {
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      const days = DAYS[q.range];
      const today = utcDate(new Date());
      const from = addDays(today, -(days - 1));
      const prevFrom = addDays(from, -days);
      const prevTo = addDays(from, -1);
      const cur = await this.sums(tx, from, today, q.agentId);
      const prev = await this.sums(tx, prevFrom, prevTo, q.agentId);
      const [agg] = await tx.$queryRaw<Array<{ at: Date | null }>>`
        SELECT max(aggregated_at) AS at FROM metrics_daily`;
      const price = await tx.modelPrice.findFirst({ select: { currency: true } });
      const tenant = await tx.tenant.findUnique({
        where: { id: admin.tenantId },
        select: { budgetCurrency: true },
      });

      const ratio = (n: number, d: number) => (d > 0 ? round(n / d) : 0);
      const finished = (s: Sums) => s.tasks_succeeded + s.tasks_failed;
      return {
        range: q.range,
        period: { from: isoDate(from), to: isoDate(today) },
        lastAggregatedAt: agg?.at?.toISOString() ?? null,
        kpis: {
          taskSuccessRate: kpi(
            ratio(cur.tasks_succeeded, cur.tasks_total),
            ratio(prev.tasks_succeeded, prev.tasks_total),
            true,
            TARGETS.taskSuccessRate,
            cur.tasks_total > 0,
          ),
          evalSuccessRate: null, // 고정 평가셋 실행(eval_runs)은 C-03 테스트 실행 단계
          toolSuccessRate: kpi(
            ratio(cur.tool_succeeded, cur.tool_calls),
            ratio(prev.tool_succeeded, prev.tool_calls),
            true,
            TARGETS.toolSuccessRate,
            cur.tool_calls > 0,
          ),
          recoverySuccessRate: kpi(
            ratio(cur.recoveries_succeeded, cur.recoveries_attempted),
            ratio(prev.recoveries_succeeded, prev.recoveries_attempted),
            true,
            TARGETS.recoverySuccessRate,
            cur.recoveries_attempted > 0,
          ),
          humanInterventionRate: kpi(
            ratio(cur.human_interventions, cur.tasks_total),
            ratio(prev.human_interventions, prev.tasks_total),
            false,
            TARGETS.humanInterventionRate,
            cur.tasks_total > 0,
          ),
          unauthorizedToolCalls: kpi(
            cur.tool_denied,
            prev.tool_denied,
            false,
            TARGETS.unauthorizedToolCalls,
            true,
          ),
          avgCostPerTask: {
            ...kpi(
              cur.tasks_total ? round(Number(cur.cost) / cur.tasks_total, 6) : 0,
              prev.tasks_total ? round(Number(prev.cost) / prev.tasks_total, 6) : 0,
              false,
            ),
            currency: price?.currency ?? tenant?.budgetCurrency ?? 'USD',
          },
          avgDurationMs: kpi(
            finished(cur) ? Math.round(cur.duration / finished(cur)) : 0,
            finished(prev) ? Math.round(prev.duration / finished(prev)) : 0,
            false,
          ),
          tasksTotal: kpi(cur.tasks_total, prev.tasks_total, true),
        },
        feedback: await this.feedback(tx, from, q.agentId),
        recentFailures: await this.recentFailures(tx, from, q.agentId),
      };
    });
  }

  private async sums(tx: TenantTx, from: Date, to: Date, agentId?: string): Promise<Sums> {
    const agent = agentId ? Prisma.sql`AND agent_id = ${agentId}::uuid` : Prisma.empty;
    const [row] = await tx.$queryRaw<Array<Record<keyof Sums, unknown>>>`
      SELECT coalesce(sum(tasks_total), 0)::int AS tasks_total,
             coalesce(sum(tasks_succeeded), 0)::int AS tasks_succeeded,
             coalesce(sum(tasks_failed), 0)::int AS tasks_failed,
             coalesce(sum(tool_calls), 0)::int AS tool_calls,
             coalesce(sum(tool_succeeded), 0)::int AS tool_succeeded,
             coalesce(sum(tool_denied), 0)::int AS tool_denied,
             coalesce(sum(recoveries_attempted), 0)::int AS recoveries_attempted,
             coalesce(sum(recoveries_succeeded), 0)::int AS recoveries_succeeded,
             coalesce(sum(human_interventions), 0)::int AS human_interventions,
             coalesce(sum(cost_amount), 0)::text AS cost,
             coalesce(sum(total_duration_ms), 0)::float8 AS duration
      FROM metrics_daily
      WHERE date BETWEEN ${from}::date AND ${to}::date ${agent}`;
    return {
      tasks_total: Number(row!.tasks_total),
      tasks_succeeded: Number(row!.tasks_succeeded),
      tasks_failed: Number(row!.tasks_failed),
      tool_calls: Number(row!.tool_calls),
      tool_succeeded: Number(row!.tool_succeeded),
      tool_denied: Number(row!.tool_denied),
      recoveries_attempted: Number(row!.recoveries_attempted),
      recoveries_succeeded: Number(row!.recoveries_succeeded),
      human_interventions: Number(row!.human_interventions),
      cost: String(row!.cost),
      duration: Number(row!.duration),
    };
  }

  private async feedback(tx: TenantTx, from: Date, agentId?: string) {
    const rows = await tx.feedback.groupBy({
      by: ['rating'],
      where: { createdAt: { gte: from }, ...(agentId ? { task: { agentId } } : {}) },
      _count: { _all: true },
    });
    const count = (rating: string) => rows.find((r) => r.rating === rating)?._count._all ?? 0;
    return { helpful: count('helpful'), notHelpful: count('not_helpful') };
  }

  private async recentFailures(tx: TenantTx, from: Date, agentId?: string) {
    const tasks = await tx.task.findMany({
      where: { status: 'failed', createdAt: { gte: from }, ...(agentId ? { agentId } : {}) },
      orderBy: { finishedAt: 'desc' },
      take: 10,
      select: {
        id: true,
        title: true,
        failureCode: true,
        lastCheckpointStepId: true,
        finishedAt: true,
        createdAt: true,
      },
    });
    const result: MetricsResponse['recentFailures'] = [];
    for (const t of tasks) {
      const step = await tx.taskStep.findFirst({
        where: { taskId: t.id, status: 'failed' },
        orderBy: { seq: 'desc' },
        select: { name: true },
      });
      result.push({
        taskId: t.id,
        title: t.title,
        failedStep: step?.name ?? null,
        cause: causeOf(t.failureCode),
        code: t.failureCode,
        recovery: t.lastCheckpointStepId
          ? '마지막 checkpoint 부터 재개 가능'
          : '처음부터 다시 실행해야 함',
        at: (t.finishedAt ?? t.createdAt).toISOString(),
      });
    }
    return result;
  }
}

/** 실패 코드 → 대시보드 원인 분류 */
export function causeOf(code: string | null): FailureCause {
  switch (code) {
    case 'TOOL_TIMEOUT':
      return 'tool_timeout';
    case 'INVALID_ARGUMENTS':
      return 'schema_validation';
    case 'TOKEN_BUDGET_EXCEEDED':
    case 'STEP_LIMIT_EXCEEDED':
    case 'TIME_LIMIT_EXCEEDED':
    case 'BUDGET_EXCEEDED':
      return 'budget_exceeded';
    case 'PERMISSION_DENIED':
      return 'permission_denied';
    case 'APPROVAL_REJECTED':
      return 'approval_rejected';
    default:
      return 'model_error';
  }
}

function kpi(
  value: number,
  previous: number,
  higherIsBetter: boolean,
  target?: number,
  hasData = true,
): Kpi {
  const met =
    target === undefined || !hasData || (higherIsBetter ? value >= target : value <= target);
  return {
    value,
    previous,
    ...(target !== undefined ? { target } : {}),
    higherIsBetter,
    status: met ? 'ok' : 'warn',
  };
}

function utcDate(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function round(n: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
