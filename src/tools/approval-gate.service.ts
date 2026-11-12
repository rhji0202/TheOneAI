import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { RunContext } from '../agent-runtime/run-context.js';
import { uuidv7 } from '../common/uuid.js';
import type { Approval, PermissionLevel, Prisma, RiskLevel } from '../generated/prisma/client.js';
import { toApprovalView } from '../tasks/approval-views.js';
import type { ResolvedTool } from './tool-registry.service.js';
import type { PolicySet } from './tool-permission.service.js';
import type { PermissionDecision } from './tool.types.js';

type ApprovalDecision = Extract<PermissionDecision, { decision: 'require_approval' }>;

export type GateResult =
  /** 이 호출을 허락한 승인 (once 범위면 지금 사용 처리됨) */
  | { kind: 'approved'; approvalId: string }
  /** 같은 호출을 사용자 · 운영자가 거절했다 — 모델에게 알린다 */
  | { kind: 'rejected'; approvalId: string; comment: string | null }
  /** 새 승인 요청을 만들었다 — 작업은 결정이 날 때까지 멈춘다 */
  | { kind: 'requested'; approvalId: string };

/**
 * 승인 게이트 — 승인이 필요한 Tool 호출을 이 작업의 승인 기록과 맞춰 본다 (docs/api-spec.md §2.5 · §6).
 *  1) 같은 Tool 을 “이 작업 동안” 승인(task 범위)했고, 승인자 요구가 같으며 조건 규칙에 걸리지 않았으면 → 실행
 *  2) 같은 Tool · 같은 인자(해시)의 가장 최근 결정이
 *       승인(once, 아직 안 씀) → 사용 처리 후 실행  /  거절 → 모델에게 거절을 알림
 *  3) 그 밖(처음 · 만료 · 이미 쓴 승인 · 인자가 바뀜) → 새 승인 요청 (approval.required)
 */
@Injectable()
export class ApprovalGateService {
  async check(
    ctx: RunContext,
    input: {
      tool: ResolvedTool;
      args: unknown;
      maskedArgs: unknown;
      decision: ApprovalDecision;
      policies: PolicySet;
      stepId: string;
      seq: number;
    },
  ): Promise<GateResult> {
    const { tool, decision } = input;
    const hash = argsHash(input.args);
    const found = await ctx.read((tx) =>
      tx.approval.findMany({
        where: {
          taskId: ctx.task.id,
          toolName: tool.name,
          status: { in: ['approved', 'rejected'] },
        },
        orderBy: { createdAt: 'desc' },
      }),
    );

    const taskGrant = found.find(
      (a) =>
        a.status === 'approved' &&
        a.scope === 'task' &&
        a.requiredApprover === decision.approver &&
        decision.matchedRuleIds.length === 0,
    );
    if (taskGrant) return { kind: 'approved', approvalId: taskGrant.id };

    const latest = found.find((a) => a.argsHash === hash);
    if (latest?.status === 'rejected') {
      return {
        kind: 'rejected',
        approvalId: latest.id,
        comment: latest.operatorComment ?? latest.userComment ?? null,
      };
    }
    if (latest?.status === 'approved' && latest.consumedAt === null) {
      // once 범위는 한 번만 — 동시에 같은 승인을 쓰려는 호출이 있어도 하나만 통과한다
      const consumed = await ctx.read((tx) =>
        tx.approval.updateMany({
          where: { id: latest.id, consumedAt: null },
          data: { consumedAt: new Date() },
        }),
      );
      if (consumed.count === 1) return { kind: 'approved', approvalId: latest.id };
    }

    return { kind: 'requested', approvalId: await this.request(ctx, input, hash) };
  }

  private async request(
    ctx: RunContext,
    input: {
      tool: ResolvedTool;
      maskedArgs: unknown;
      decision: ApprovalDecision;
      policies: PolicySet;
      stepId: string;
      seq: number;
    },
    hash: string,
  ): Promise<string> {
    const { tool, decision, policies } = input;
    const id = uuidv7();
    const ttlSeconds = policies.levelPolicy(tool.level).ttlSeconds;
    await ctx.record(async (tx, emit) => {
      const approval: Approval = await tx.approval.create({
        data: {
          id,
          tenantId: ctx.task.tenantId,
          taskId: ctx.task.id,
          stepId: input.stepId,
          mcpToolId: tool.mcpToolId ?? null,
          toolName: tool.name,
          permissionLevel: tool.level,
          riskLevel: riskLevel(tool.level, decision.matchedRuleIds.length > 0),
          args: (isRecord(input.maskedArgs)
            ? input.maskedArgs
            : { value: input.maskedArgs }) as Prisma.InputJsonValue,
          argsHash: hash,
          reason: decision.reason,
          summary: summarize(tool),
          matchedRuleIds: decision.matchedRuleIds,
          requiredApprover: decision.approver,
          expiresAt: new Date(Date.now() + ttlSeconds * 1_000),
        },
      });
      const allowTaskScope =
        policies.allowsTaskScope(tool.level) && decision.matchedRuleIds.length === 0;
      await emit('approval.required', { approval: toApprovalView(approval, allowTaskScope) });
    });
    return id;
  }
}

/** 인자 해시 — 키 순서와 무관하게 같은 값이면 같은 해시. 승인 후 인자가 바뀌면 다시 묻는다. */
export function argsHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** 위험도 — 등급 기준, 조건 규칙(금액 · 대상 등)에 걸렸으면 high */
export function riskLevel(level: PermissionLevel, matchedRule: boolean): RiskLevel {
  if (matchedRule || level === 'delete' || level === 'financial') return 'high';
  return level === 'read' ? 'low' : 'medium';
}

/** 승인 카드 한 줄 — Tool 설명의 첫 문장 */
export function summarize(tool: Pick<ResolvedTool, 'name' | 'description'>): string {
  const first = tool.description.split(/(?<=[.!?。])\s|\n/)[0]?.trim() ?? '';
  const text = first || tool.name;
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
