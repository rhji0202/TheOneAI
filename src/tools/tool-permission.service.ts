import { Injectable } from '@nestjs/common';
import type {
  ApprovalMode,
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
    private readonly levels: Map<PermissionLevel, ToolPolicy>,
    private readonly rules: ToolPolicyRule[],
  ) {}

  modeFor(tool: PermissionSubject): ApprovalMode {
    return tool.modeOverride ?? this.levels.get(tool.level)?.mode ?? DEFAULT_MODES[tool.level];
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

function appliesTo(rule: ToolPolicyRule, tool: PermissionSubject): boolean {
  if (rule.toolPattern && !matchesToolPattern(tool.name, rule.toolPattern)) return false;
  if (rule.level && rule.level !== tool.level) return false;
  return true;
}

@Injectable()
export class ToolPermissionService {
  constructor(private readonly prisma: PrismaService) {}

  /** 실행 직전마다 새로 읽는다 — 정책 강화가 실행 중 작업에도 바로 적용되도록. */
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
