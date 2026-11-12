import type { Approval, PermissionLevel, ToolPolicy } from '../generated/prisma/client.js';

/** docs/api-spec.md §0 ApprovalView */
export interface ApprovalView {
  id: string;
  taskId: string;
  toolName: string;
  toolSource: 'mcp' | 'sandbox' | 'builtin' | 'skill_script';
  permissionLevel: Approval['permissionLevel'];
  riskLevel: Approval['riskLevel'];
  summary: string;
  args: Array<{ label: string; value: string }>;
  rawArgs: Record<string, unknown>;
  reason: string;
  requiredApprover: Approval['requiredApprover'];
  allowTaskScope: boolean;
  status: Approval['status'];
  /** user_and_operator: 한쪽이 먼저 승인했으면 남은 쪽 */
  waitingFor: 'user' | 'operator' | 'user_and_operator' | null;
  expiresAt: string;
}

/** 작업 동안 승인(task 범위)을 허용하지 않는 등급 — 매번 묻는다 */
const ALWAYS_ASK: PermissionLevel[] = ['delete', 'financial'];

/**
 * “이 작업 동안 다시 묻지 않기” 노출 여부 — 등급 정책이 허용하고, 매번 묻는 등급 · 방식이 아니며,
 * 조건 규칙 때문에 생긴 승인이 아닐 때만 (규칙은 인자마다 다시 판단해야 한다).
 */
export function taskScopeAllowed(
  approval: Pick<Approval, 'permissionLevel' | 'matchedRuleIds'>,
  policy: Pick<ToolPolicy, 'allowTaskScope' | 'mode'> | null,
): boolean {
  return (
    !!policy?.allowTaskScope &&
    policy.mode !== 'always_approval' &&
    !ALWAYS_ASK.includes(approval.permissionLevel) &&
    approval.matchedRuleIds.length === 0
  );
}

export function toApprovalView(approval: Approval, allowTaskScope: boolean): ApprovalView {
  const raw = isRecord(approval.args) ? approval.args : {};
  const toolSource: ApprovalView['toolSource'] = approval.mcpToolId
    ? 'mcp'
    : approval.toolName.startsWith('sandbox.')
      ? 'sandbox'
      : 'builtin';
  return {
    id: approval.id,
    taskId: approval.taskId,
    toolName: approval.toolName,
    toolSource,
    permissionLevel: approval.permissionLevel,
    riskLevel: approval.riskLevel,
    summary: approval.summary || approval.reason,
    args: Object.entries(raw).map(([label, value]) => ({
      label,
      value: typeof value === 'string' ? value : JSON.stringify(value),
    })),
    rawArgs: raw,
    reason: approval.reason,
    requiredApprover: approval.requiredApprover,
    allowTaskScope: approval.status === 'pending' && allowTaskScope,
    status: approval.status,
    waitingFor: approval.status === 'pending' ? waitingFor(approval) : null,
    expiresAt: approval.expiresAt.toISOString(),
  };
}

function waitingFor(approval: Approval): ApprovalView['waitingFor'] {
  if (approval.requiredApprover !== 'user_and_operator') return approval.requiredApprover;
  if (approval.userDecision === 'approve') return 'operator';
  if (approval.operatorDecision === 'approve') return 'user';
  return 'user_and_operator';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
