import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../../admin/audit/audit.service.js';
import type { AdminRequest, AdminSession } from '../../admin/auth/admin-session.js';
import { uuidv7 } from '../../common/uuid.js';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService, type TenantTx } from '../../infrastructure/database/prisma.service.js';
import { BillingService } from '../billing.service.js';

const providerKinds = [
  'anthropic',
  'openai_compatible',
  'bedrock',
  'vertex',
  'openai',
  'deepseek',
  'gemini',
] as const;
const money = z.number().min(0).max(1_000_000);
const currency = z
  .string()
  .regex(/^[A-Z]{3}$/)
  .default('USD');

export const modelPricesPutSchema = z.object({
  prices: z
    .array(
      z.object({
        providerKind: z.enum(providerKinds),
        model: z.string().trim().min(1).max(200),
        inputPerMtok: money,
        cachedInputPerMtok: money.nullable().optional(),
        outputPerMtok: money,
        currency,
      }),
    )
    .max(200)
    .refine(
      (list) => new Set(list.map((p) => `${p.providerKind}|${p.model}`)).size === list.length,
      { message: '같은 provider · 모델이 중복되었습니다' },
    )
    .refine((list) => new Set(list.map((p) => p.currency)).size <= 1, {
      message: '단가 통화는 하나로 맞춰야 합니다',
    }),
});
export type ModelPricesPut = z.infer<typeof modelPricesPutSchema>;

export const budgetPutSchema = z.object({
  monthlyBudget: money.nullable(),
  currency,
});
export type BudgetPut = z.infer<typeof budgetPutSchema>;

export const usageQuerySchema = z.object({
  range: z.enum(['7d', '30d', 'month']).default('30d'),
  agentId: z.uuid().optional(),
});
export type UsageQuery = z.infer<typeof usageQuerySchema>;

export interface ModelPriceView {
  providerKind: string;
  model: string;
  inputPerMtok: number;
  cachedInputPerMtok: number | null;
  outputPerMtok: number;
  currency: string;
  updatedAt: string;
}

interface UsageTotals {
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  cost: number;
  /** 단가가 없어 비용 0 으로 기록된 호출 */
  unpricedCalls: number;
}

export interface UsageReport {
  range: UsageQuery['range'];
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

/** 사용량 · 과금 (콘솔) — 모델 단가, 월 한도, 사용량 보고 */
@Injectable()
export class BillingAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    private readonly audit: AuditService,
  ) {}

  async prices(admin: AdminSession): Promise<ModelPriceView[]> {
    return this.prisma.withTenant(admin.tenantId, (tx) => this.readPrices(tx));
  }

  /** 전체 교체 — 다음 기록부터 적용 (이미 기록한 비용은 바꾸지 않는다) */
  async replacePrices(
    admin: AdminSession,
    input: ModelPricesPut,
    req?: AdminRequest,
  ): Promise<ModelPriceView[]> {
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      await tx.modelPrice.deleteMany({});
      if (input.prices.length) {
        await tx.modelPrice.createMany({
          data: input.prices.map((p) => ({
            id: uuidv7(),
            tenantId: admin.tenantId,
            providerKind: p.providerKind,
            model: p.model,
            inputPerMtok: p.inputPerMtok,
            cachedInputPerMtok: p.cachedInputPerMtok ?? null,
            outputPerMtok: p.outputPerMtok,
            currency: p.currency,
            updatedById: admin.userId,
          })),
        });
      }
      await this.audit.record(
        tx,
        admin,
        {
          action: 'billing.prices.update',
          targetType: 'model_price',
          metadata: { models: input.prices.map((p) => `${p.providerKind}/${p.model}`) },
        },
        req,
      );
      return this.readPrices(tx);
    });
  }

  async setBudget(admin: AdminSession, input: BudgetPut, req?: AdminRequest) {
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      const before = await tx.tenant.findUniqueOrThrow({
        where: { id: admin.tenantId },
        select: { monthlyBudget: true, budgetCurrency: true },
      });
      await tx.tenant.update({
        where: { id: admin.tenantId },
        data: { monthlyBudget: input.monthlyBudget, budgetCurrency: input.currency },
      });
      await this.audit.record(
        tx,
        admin,
        {
          action: 'billing.budget.update',
          targetType: 'tenant',
          targetId: admin.tenantId,
          metadata: {
            before: before.monthlyBudget === null ? null : Number(before.monthlyBudget),
            after: input.monthlyBudget,
            currency: input.currency,
          },
        },
        req,
      );
      return this.budget(tx, admin.tenantId);
    });
  }

  async usage(admin: AdminSession, q: UsageQuery): Promise<UsageReport> {
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      const now = new Date();
      const from =
        q.range === 'month'
          ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
          : new Date(
              Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
                (q.range === '7d' ? 6 : 29) * 86_400_000,
            );
      const agent = q.agentId ? Prisma.sql`AND agent_id = ${q.agentId}::uuid` : Prisma.empty;
      const sums = Prisma.sql`
        coalesce(sum(calls), 0)::int AS calls,
        coalesce(sum(input_tokens), 0)::bigint AS input_tokens,
        coalesce(sum(cached_input_tokens), 0)::bigint AS cached_input_tokens,
        coalesce(sum(output_tokens), 0)::bigint AS output_tokens,
        coalesce(sum(cost_amount), 0)::text AS cost,
        coalesce(sum(calls) FILTER (WHERE NOT priced), 0)::int AS unpriced_calls`;
      const byDay = await tx.$queryRaw<Array<RawTotals & { date: Date }>>`
        SELECT (created_at AT TIME ZONE 'UTC')::date AS date, ${sums}
        FROM usage_records WHERE created_at >= ${from} ${agent}
        GROUP BY 1 ORDER BY 1`;
      const byModel = await tx.$queryRaw<
        Array<RawTotals & { provider_kind: string; model: string; priced: boolean }>
      >`
        SELECT provider_kind::text AS provider_kind, model, bool_and(priced) AS priced, ${sums}
        FROM usage_records WHERE created_at >= ${from} ${agent}
        GROUP BY 1, 2 ORDER BY sum(cost_amount) DESC, sum(input_tokens) DESC`;
      const byPurpose = await tx.$queryRaw<Array<RawTotals & { purpose: string }>>`
        SELECT purpose, ${sums}
        FROM usage_records WHERE created_at >= ${from} ${agent}
        GROUP BY 1 ORDER BY 1`;
      const [totals] = await tx.$queryRaw<RawTotals[]>`
        SELECT ${sums} FROM usage_records WHERE created_at >= ${from} ${agent}`;
      const budget = await this.budget(tx, admin.tenantId);
      return {
        range: q.range,
        from: from.toISOString(),
        currency: budget.currency,
        totals: toTotals(totals!),
        byDay: byDay.map((r) => ({ date: r.date.toISOString().slice(0, 10), ...toTotals(r) })),
        byModel: byModel.map((r) => ({
          providerKind: r.provider_kind,
          model: r.model,
          priced: r.priced,
          ...toTotals(r),
        })),
        byPurpose: byPurpose.map((r) => ({ purpose: r.purpose, ...toTotals(r) })),
        budget,
      };
    });
  }

  private async budget(tx: TenantTx, tenantId: string): Promise<UsageReport['budget']> {
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { monthlyBudget: true, budgetCurrency: true },
    });
    const monthToDate = round(await this.billing.monthToDate(tx));
    const monthly = tenant.monthlyBudget === null ? null : Number(tenant.monthlyBudget);
    return {
      monthlyBudget: monthly,
      currency: tenant.budgetCurrency,
      monthToDate,
      remaining: monthly === null ? null : round(Math.max(0, monthly - monthToDate)),
    };
  }

  private async readPrices(tx: TenantTx): Promise<ModelPriceView[]> {
    const rows = await tx.modelPrice.findMany({
      orderBy: [{ providerKind: 'asc' }, { model: 'asc' }],
    });
    return rows.map((r) => ({
      providerKind: r.providerKind,
      model: r.model,
      inputPerMtok: Number(r.inputPerMtok),
      cachedInputPerMtok: r.cachedInputPerMtok === null ? null : Number(r.cachedInputPerMtok),
      outputPerMtok: Number(r.outputPerMtok),
      currency: r.currency,
      updatedAt: r.updatedAt.toISOString(),
    }));
  }
}

interface RawTotals {
  calls: number;
  input_tokens: bigint;
  cached_input_tokens: bigint;
  output_tokens: bigint;
  cost: string;
  unpriced_calls: number;
}

function toTotals(r: RawTotals): UsageTotals {
  return {
    calls: Number(r.calls),
    inputTokens: Number(r.input_tokens),
    cachedInputTokens: Number(r.cached_input_tokens),
    outputTokens: Number(r.output_tokens),
    cost: round(Number(r.cost)),
    unpricedCalls: Number(r.unpriced_calls),
  };
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
