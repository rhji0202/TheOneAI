import type { Approval, ToolPolicy } from '../generated/prisma/client.js';

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
  expiresAt: string;
}

export function toApprovalView(
  approval: Approval,
  policy: Pick<ToolPolicy, 'allowTaskScope'> | null,
): ApprovalView {
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
    summary: approval.reason,
    args: Object.entries(raw).map(([label, value]) => ({
      label,
      value: typeof value === 'string' ? value : JSON.stringify(value),
    })),
    rawArgs: raw,
    reason: approval.reason,
    requiredApprover: approval.requiredApprover,
    allowTaskScope: policy?.allowTaskScope ?? false,
    status: approval.status,
    expiresAt: approval.expiresAt.toISOString(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
