import { Injectable, Logger } from '@nestjs/common';
import { AppError } from '../common/errors/app-error.js';
import { uuidv7 } from '../common/uuid.js';
import type { ModelRole, ProviderKind } from '../generated/prisma/client.js';
import { PrismaService, type TenantTx } from '../infrastructure/database/prisma.service.js';
import { costOf, type MeterEntry, type Price, type UsageMeter } from './usage-meter.js';

export interface UsageScope {
  tenantId: string;
  agentId: string;
  taskId: string | null;
  /** task = Agent Loop 실행, memory = 작업 뒤 기억 추출 */
  purpose: 'task' | 'memory';
}

/**
 * 사용량 · 비용 (Billing).
 *  - 실행이 끝나면(성공 · 실패 · 중지 · 일시정지 · 승인 대기 · Worker 넘기기 모두) 사용량을 usage_records 로 남기고
 *    테넌트 단가(model_prices)로 비용을 계산해 작업 비용(tasks.cost_amount)에 더한다.
 *  - 단가가 없는 모델은 비용 0 · priced=false 로 기록한다 (콘솔에서 단가를 등록하면 그 뒤부터 계산).
 *  - 월 비용 한도(tenants.monthly_budget)를 넘으면 새 작업 · 재개를 받지 않는다 (BUDGET_EXCEEDED).
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** 사용량을 기록하고 비용을 작업에 더한다. 기록할 사용량이 없으면 아무것도 하지 않는다. */
  async flush(scope: UsageScope, meter: UsageMeter): Promise<number> {
    const entries = meter.drain();
    if (!entries.length) return 0;
    return this.prisma.withTenant(scope.tenantId, async (tx) => {
      const prices = await this.prices(tx);
      let total = 0;
      for (const entry of entries) {
        const price = prices.get(priceKey(entry.providerKind, entry.model));
        const cost = price ? costOf(entry, price) : 0;
        total += cost;
        await tx.usageRecord.create({
          data: {
            id: uuidv7(),
            tenantId: scope.tenantId,
            agentId: scope.agentId,
            taskId: scope.taskId,
            purpose: scope.purpose,
            role: entry.role,
            providerKind: entry.providerKind as ProviderKind,
            model: entry.model,
            calls: entry.calls,
            inputTokens: entry.inputTokens,
            cachedInputTokens: entry.cachedInputTokens,
            outputTokens: entry.outputTokens,
            costAmount: cost.toFixed(8),
            currency: price?.currency ?? 'USD',
            priced: price !== undefined,
          },
        });
      }
      if (scope.taskId && total > 0) {
        await tx.task.update({
          where: { id: scope.taskId },
          data: {
            costAmount: { increment: total.toFixed(6) },
            costCurrency: prices.values().next().value?.currency ?? 'USD',
          },
        });
      }
      return total;
    });
  }

  /** flush 실패는 작업 결과를 바꾸지 않는다 — 기록만 놓친다 */
  async flushQuietly(scope: UsageScope, meter: UsageMeter): Promise<void> {
    await this.flush(scope, meter).catch((err: unknown) =>
      this.logger.error(`사용량 기록 실패 (${scope.taskId ?? scope.agentId}): ${String(err)}`),
    );
  }

  /** 월 비용 한도 확인 — 작업 생성 · 재개 전에 같은 트랜잭션에서 부른다 */
  async assertWithinBudget(tx: TenantTx, tenantId: string): Promise<void> {
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { monthlyBudget: true, budgetCurrency: true },
    });
    if (!tenant?.monthlyBudget) return;
    const spent = await this.monthToDate(tx);
    if (spent >= Number(tenant.monthlyBudget)) {
      throw new AppError(
        402,
        'BUDGET_EXCEEDED',
        `이번 달 사용 한도(${Number(tenant.monthlyBudget)} ${tenant.budgetCurrency})에 도달했습니다`,
      );
    }
  }

  /** 이번 달(UTC) 비용 합계 */
  async monthToDate(tx: TenantTx): Promise<number> {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const sum = await tx.usageRecord.aggregate({
      where: { createdAt: { gte: start } },
      _sum: { costAmount: true },
    });
    return Number(sum._sum.costAmount ?? 0);
  }

  async prices(tx: TenantTx): Promise<Map<string, Price>> {
    const rows = await tx.modelPrice.findMany();
    return new Map(
      rows.map((r) => [
        priceKey(r.providerKind, r.model),
        {
          inputPerMtok: Number(r.inputPerMtok),
          cachedInputPerMtok: r.cachedInputPerMtok === null ? null : Number(r.cachedInputPerMtok),
          outputPerMtok: Number(r.outputPerMtok),
          currency: r.currency,
        },
      ]),
    );
  }
}

export function priceKey(providerKind: string, model: string): string {
  return `${providerKind}|${model}`;
}

export type { MeterEntry, ModelRole };
