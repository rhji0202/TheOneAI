import { Injectable } from '@nestjs/common';
import type {
  ApprovalMode,
  Approver,
  PermissionLevel,
  ToolPolicy,
  ToolPolicyRule,
} from '../generated/prisma/client.js';
import { PrismaService } from '../infrastructure/database/prisma.service.js';
import { evaluateCondition } from './rule-condition.js';
import { matchesToolPattern } from './tool-names.js';
import type { PermissionDecision } from './tool.types.js';

/** 테넌트가 등급 정책을 두지 않았을 때의 기본값 (C-07 기본 정책과 같음) */
export const DEFAULT_MODES: Record<PermissionLevel, ApprovalMode> = {
  read: 'auto',
  write: 'require_approval',
  external_send: 'require_approval',
  delete: 'always_approval',
  financial: 'always_approval',
};

export const DEFAULT_TTL_SECONDS = 900;

/** 작업 동안 승인(task 범위)을 허용하지 않는 등급 — 매번 묻는다 */
export const ALWAYS_ASK_LEVELS: PermissionLevel[] = ['delete', 'financial'];

/** 등급 정책 한 줄 (tool_policies) */
export type LevelPolicy = Pick<
  ToolPolicy,
  'level' | 'mode' | 'approver' | 'allowTaskScope' | 'ttlSeconds'
>;
/** 조건 규칙 한 줄 (tool_policy_rules, 켜진 것만) */
export type RulePolicy = Pick<
  ToolPolicyRule,
  'id' | 'name' | 'toolPattern' | 'level' | 'condition' | 'effect' | 'priority'
>;

/** 작업 시작 시점의 정책 (checkpoint 에 남겨 재개 후에도 같은 기준) */
export interface PolicySnapshot {
  levels: LevelPolicy[];
  rules: RulePolicy[];
}

const MODE_RANK: Record<ApprovalMode, number> = {
  auto: 0,
  require_approval: 1,
  always_approval: 2,
  block: 3,
};

export interface PermissionSubject {
  name: string;
  level: PermissionLevel;
  modeOverride: ApprovalMode | null;
}

/** 계획 · 모델에게 미리 알려 줄 수 있는 판단 (인자 조건 규칙은 실행 시점에 다시 본다) */
export type PlanningMode = 'auto' | 'approval' | 'blocked';

/**
 * 한 테넌트의 Tool 권한 정책 (C-07).
 * 판단 순서: 등급 기본 정책 → Tool 재정의 → 조건 규칙(priority 오름차순). 규칙은 강화만 한다.
 */
export class PolicySet {
  constructor(
    private readonly levels: Map<PermissionLevel, LevelPolicy>,
    private readonly rules: RulePolicy[],
  ) {}

  static fromSnapshot(snapshot: PolicySnapshot): PolicySet {
    return new PolicySet(new Map(snapshot.levels.map((l) => [l.level, l])), snapshot.rules);
  }

  /**
   * 두 정책 중 엄격한 쪽 (docs/api-spec.md §4.7 “강화는 실행 중 작업에도 즉시, 완화는 새 작업부터”).
   * 등급마다 더 엄격한 방식 · 승인자 · 짧은 만료, 규칙은 둘 다 적용(규칙은 강화만 하므로 합집합이 더 엄격하다).
   */
  static strictest(pinned: PolicySet, current: PolicySet): PolicySet {
    const levels = new Map<PermissionLevel, LevelPolicy>();
    for (const level of Object.keys(DEFAULT_MODES) as PermissionLevel[]) {
      const a = pinned.levelPolicy(level);
      const b = current.levelPolicy(level);
      const [strict, other] = MODE_RANK[a.mode] >= MODE_RANK[b.mode] ? [a, b] : [b, a];
      levels.set(level, {
        level,
        mode: strict.mode,
        approver:
          MODE_RANK[strict.mode] === MODE_RANK[other.mode]
            ? mergeApprovers(strict.approver, other.approver)
            : strict.approver,
        allowTaskScope: a.allowTaskScope && b.allowTaskScope,
        ttlSeconds: Math.min(a.ttlSeconds, b.ttlSeconds),
      });
    }
    const rules = new Map<string, RulePolicy>();
    for (const rule of [...pinned.rules, ...current.rules]) {
      rules.set(
        `${rule.id}:${JSON.stringify([rule.toolPattern, rule.level, rule.condition, rule.effect])}`,
        rule,
      );
    }
    return new PolicySet(
      levels,
      [...rules.values()].sort((x, y) => x.priority - y.priority),
    );
  }

  toSnapshot(): PolicySnapshot {
    return {
      levels: [...this.levels.values()].map((l) => ({
        level: l.level,
        mode: l.mode,
        approver: l.approver,
        allowTaskScope: l.allowTaskScope,
        ttlSeconds: l.ttlSeconds,
      })),
      rules: this.rules.map((r) => ({
        id: r.id,
        name: r.name,
        toolPattern: r.toolPattern,
        level: r.level,
        condition: r.condition,
        effect: r.effect,
        priority: r.priority,
      })),
    };
  }

  /** 등급 정책 (없으면 기본값) */
  levelPolicy(level: PermissionLevel): LevelPolicy {
    return (
      this.levels.get(level) ?? {
        level,
        mode: DEFAULT_MODES[level],
        approver: null,
        allowTaskScope: false,
        ttlSeconds: DEFAULT_TTL_SECONDS,
      }
    );
  }

  /** “이 작업 동안 다시 묻지 않기”를 허용하는가 — delete · financial · always_approval 은 매번 묻는다 */
  allowsTaskScope(level: PermissionLevel): boolean {
    const policy = this.levelPolicy(level);
    return (
      policy.allowTaskScope &&
      policy.mode !== 'always_approval' &&
      !ALWAYS_ASK_LEVELS.includes(level)
    );
  }

  modeFor(tool: PermissionSubject): ApprovalMode {
    return tool.modeOverride ?? this.levelPolicy(tool.level).mode;
  }

  planningMode(tool: PermissionSubject): PlanningMode {
    const mode = this.modeFor(tool);
    if (mode === 'block') return 'blocked';
    return mode === 'auto' ? 'auto' : 'approval';
  }

  decide(tool: PermissionSubject, args: unknown, now: Date = new Date()): PermissionDecision {
    const mode = this.modeFor(tool);
    const matchedRuleIds: string[] = [];
    let requireOperator = false;

    for (const rule of this.rules) {
      if (!appliesTo(rule, tool)) continue;
      if (!evaluateCondition(rule.condition, args, now)) continue;
      matchedRuleIds.push(rule.id);
      if (rule.effect === 'block') {
        return {
          decision: 'deny',
          mode,
          matchedRuleIds,
          deniedReason: 'blocked_by_rule',
          reason: `정책 규칙 '${rule.name}' 에 의해 차단되었습니다`,
        };
      }
      requireOperator = true;
    }

    if (mode === 'block') {
      return {
        decision: 'deny',
        mode,
        matchedRuleIds,
        deniedReason: 'blocked_by_policy',
        reason: `권한 등급(${tool.level}) 정책상 사용할 수 없는 Tool 입니다`,
      };
    }
    if (mode === 'auto' && !requireOperator) return { decision: 'allow', mode, matchedRuleIds };

    const base =
      mode === 'auto'
        ? null
        : (this.levels.get(tool.level)?.approver ??
          (mode === 'always_approval' ? 'user_and_operator' : 'user'));
    const approver = !requireOperator
      ? (base ?? 'user')
      : base === null || base === 'operator'
        ? 'operator'
        : 'user_and_operator';
    return {
      decision: 'require_approval',
      mode,
      approver,
      matchedRuleIds,
      reason: requireOperator
        ? '정책 규칙에 따라 운영자 승인이 필요합니다'
        : '실행 전에 승인이 필요한 작업입니다',
    };
  }
}

function mergeApprovers(a: Approver | null, b: Approver | null): Approver | null {
  if (!a || !b || a === b) return a ?? b;
  return 'user_and_operator';
}

function appliesTo(rule: RulePolicy, tool: PermissionSubject): boolean {
  if (rule.toolPattern && !matchesToolPattern(tool.name, rule.toolPattern)) return false;
  if (rule.level && rule.level !== tool.level) return false;
  return true;
}

@Injectable()
export class ToolPermissionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 작업에 적용할 정책 — 작업이 처음 읽은 정책(pinned)과 지금 정책 중 엄격한 쪽.
   * 실행 직전마다 지금 정책을 새로 읽어, 강화는 실행 중 작업에도 바로 적용되고 완화는 새 작업부터 적용된다.
   * pinned 가 없으면(작업의 첫 판단) 지금 정책을 그대로 쓰고, 그 스냅샷을 돌려준다.
   */
  async forTask(
    tenantId: string,
    pinned: PolicySnapshot | null | undefined,
  ): Promise<{ policies: PolicySet; snapshot: PolicySnapshot }> {
    const current = await this.load(tenantId);
    if (!pinned) return { policies: current, snapshot: current.toSnapshot() };
    return {
      policies: PolicySet.strictest(PolicySet.fromSnapshot(pinned), current),
      snapshot: pinned,
    };
  }

  /** 지금 정책 (테넌트 설정 그대로) */
  async load(tenantId: string): Promise<PolicySet> {
    const { policies, rules } = await this.prisma.withTenant(tenantId, async (tx) => ({
      policies: await tx.toolPolicy.findMany(),
      rules: await tx.toolPolicyRule.findMany({
        where: { enabled: true },
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      }),
    }));
    return new PolicySet(new Map(policies.map((p) => [p.level, p])), rules);
  }
}
