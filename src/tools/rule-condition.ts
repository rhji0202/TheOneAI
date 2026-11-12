import { z } from 'zod';

/** tool_policy_rules.condition — docs/data-model.md §4.4 */
export type RuleCondition =
  | { all: RuleCondition[] }
  | { any: RuleCondition[] }
  | {
      arg: string;
      op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains' | 'matches';
      value: unknown;
    }
  | { argDomainNotIn: string; domains: string[] }
  | { timeOutside: { days: number[]; from: string; to: string; tz: string } };

export const ruleConditionSchema: z.ZodType<RuleCondition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(ruleConditionSchema) }),
    z.object({ any: z.array(ruleConditionSchema) }),
    z.object({
      arg: z.string().min(1),
      op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'matches']),
      value: z.unknown(),
    }),
    z.object({ argDomainNotIn: z.string().min(1), domains: z.array(z.string()) }),
    z.object({
      timeOutside: z.object({
        days: z.array(z.number().int().min(0).max(6)),
        from: z.string().regex(/^\d{2}:\d{2}$/),
        to: z.string().regex(/^\d{2}:\d{2}$/),
        tz: z.string(),
      }),
    }),
  ]),
);

/**
 * 규칙 조건 평가. 형식이 잘못된 조건은 “일치”로 본다 — 규칙은 정책을 강화만 하므로
 * 잘못 설정된 규칙이 보호를 풀어 버리지 않도록 안전한 쪽(fail-closed)을 택한다.
 */
export function evaluateCondition(raw: unknown, args: unknown, now: Date = new Date()): boolean {
  const parsed = ruleConditionSchema.safeParse(raw);
  if (!parsed.success) return true;
  return evaluate(parsed.data, args, now);
}

function evaluate(condition: RuleCondition, args: unknown, now: Date): boolean {
  if ('all' in condition) return condition.all.every((c) => evaluate(c, args, now));
  if ('any' in condition) return condition.any.some((c) => evaluate(c, args, now));
  if ('argDomainNotIn' in condition) {
    const values = toArray(lookup(args, condition.argDomainNotIn));
    const allowed = condition.domains.map((d) => d.toLowerCase());
    return values.some((v) => {
      const domain = extractDomain(String(v));
      return domain !== null && !allowed.some((d) => domain === d || domain.endsWith(`.${d}`));
    });
  }
  if ('timeOutside' in condition) {
    const { days, from, to, tz } = condition.timeOutside;
    const local = localParts(now, tz);
    if (!local) return true;
    const minutes = local.hour * 60 + local.minute;
    const inside =
      days.includes(local.weekday) && minutes >= toMinutes(from) && minutes < toMinutes(to);
    return !inside;
  }
  return compare(lookup(args, condition.arg), condition.op, condition.value);
}

function compare(actual: unknown, op: string, expected: unknown): boolean {
  switch (op) {
    case 'eq':
      return actual === expected;
    case 'neq':
      return actual !== expected;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = Number(actual);
      const b = Number(expected);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      return op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b;
    }
    case 'in':
      return Array.isArray(expected) && expected.includes(actual);
    case 'contains':
      if (typeof actual === 'string') return actual.includes(String(expected));
      if (Array.isArray(actual)) return actual.includes(expected);
      return false;
    case 'matches':
      try {
        return typeof actual === 'string' && new RegExp(String(expected), 'i').test(actual);
      } catch {
        return true; // 잘못된 정규식 — fail-closed
      }
    default:
      return true;
  }
}

/** "a.b.0.c" 경로 조회 */
function lookup(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current) && /^\d+$/.test(key)) return current[Number(key)];
    if (typeof current === 'object') return (current as Record<string, unknown>)[key];
    return undefined;
  }, value);
}

function toArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function extractDomain(value: string): string | null {
  const email = /@([A-Za-z0-9.-]+\.[A-Za-z]{2,})$/.exec(value.trim());
  if (email) return email[1]!.toLowerCase();
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return /^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(value) ? value.toLowerCase() : null;
  }
}

function localParts(
  now: Date,
  tz: string,
): { weekday: number; hour: number; minute: number } | null {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(now)
        .map((p) => [p.type, p.value]),
    );
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday ?? '');
    return { weekday, hour: Number(parts.hour), minute: Number(parts.minute) };
  } catch {
    return null;
  }
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
}
