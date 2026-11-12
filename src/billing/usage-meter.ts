import type { ModelRole } from '../generated/prisma/client.js';
import type { LlmUsage } from '../llm/llm.types.js';

export interface MeterEntry {
  role: ModelRole;
  providerKind: string;
  model: string;
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/**
 * 모델 호출 사용량 — 역할 · provider · 모델별 합계. 작업 실행(또는 기억 추출) 하나마다 하나를 쓰고,
 * 끝날 때 BillingService.flush 가 usage_records 로 남기고 비용을 계산한다.
 * 대체(fallback) 모델로 바뀐 호출은 실제로 응답한 모델로 센다.
 */
export class UsageMeter {
  private readonly entries = new Map<string, MeterEntry>();

  record(role: ModelRole, target: { providerKind: string; model: string }, usage: LlmUsage): void {
    const key = `${role}|${target.providerKind}|${target.model}`;
    const entry = this.entries.get(key) ?? {
      role,
      providerKind: target.providerKind,
      model: target.model,
      calls: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    };
    entry.calls += 1;
    entry.inputTokens += usage.inputTokens;
    entry.cachedInputTokens += usage.cachedInputTokens;
    entry.outputTokens += usage.outputTokens;
    this.entries.set(key, entry);
  }

  /** 지금까지의 합계를 꺼내고 비운다 (한 번 기록한 사용량을 다시 기록하지 않도록) */
  drain(): MeterEntry[] {
    const list = [...this.entries.values()];
    this.entries.clear();
    return list;
  }
}

export interface Price {
  inputPerMtok: number;
  cachedInputPerMtok: number | null;
  outputPerMtok: number;
  currency: string;
}

/** 비용 = (입력 − 캐시 입력) × 입력 단가 + 캐시 입력 × 캐시 단가(없으면 입력 단가) + 출력 × 출력 단가 (1M 토큰당) */
export function costOf(
  entry: Pick<MeterEntry, 'inputTokens' | 'cachedInputTokens' | 'outputTokens'>,
  price: Price,
): number {
  const cached = Math.min(entry.cachedInputTokens, entry.inputTokens);
  return (
    ((entry.inputTokens - cached) * price.inputPerMtok +
      cached * (price.cachedInputPerMtok ?? price.inputPerMtok) +
      entry.outputTokens * price.outputPerMtok) /
    1_000_000
  );
}
