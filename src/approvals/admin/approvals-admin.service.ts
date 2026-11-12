import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { AdminSession } from '../../admin/auth/admin-session.js';
import { type Page, toPage } from '../../common/http/pagination.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { type ApprovalView, taskScopeAllowed, toApprovalView } from '../../tasks/approval-views.js';

export const approvalListSchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'expired', 'cancelled']).default('pending'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.uuid().optional(),
});
export type ApprovalListQuery = z.infer<typeof approvalListSchema>;

export const approvalHistorySchema = z.object({
  toolName: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.uuid().optional(),
});
export type ApprovalHistoryQuery = z.infer<typeof approvalHistorySchema>;

/** 콘솔 승인 목록 한 줄 (C-07) */
export interface AdminApprovalRow extends ApprovalView {
  taskTitle: string;
  conversationId: string;
  endUserPseudonym: string;
  user: { decision: string; comment: string | null; at: string } | null;
  operator: {
    decision: string;
    comment: string | null;
    at: string;
    memberId: string | null;
    memberName: string | null;
  } | null;
  createdAt: string;
  resolvedAt: string | null;
}

const include = {
  task: {
    select: { title: true, conversationId: true, endUser: { select: { pseudonym: true } } },
  },
} satisfies Prisma.ApprovalInclude;
type Row = Prisma.ApprovalGetPayload<{ include: typeof include }>;

@Injectable()
export class ApprovalsAdminService {
  constructor(private readonly prisma: PrismaService) {}

  /** 상태별 목록 — 위험도 높은 순 → 만료 임박 순 */
  async list(admin: AdminSession, q: ApprovalListQuery): Promise<Page<AdminApprovalRow>> {
    return this.query(admin, q.limit, q.cursor, {
      where: { status: q.status },
      orderBy: [{ riskLevel: 'desc' }, { expiresAt: 'asc' }, { id: 'asc' }],
    });
  }

  /** 처리 이력 — 최근 처리 순 */
  async history(admin: AdminSession, q: ApprovalHistoryQuery): Promise<Page<AdminApprovalRow>> {
    return this.query(admin, q.limit, q.cursor, {
      where: { status: { not: 'pending' }, ...(q.toolName ? { toolName: q.toolName } : {}) },
      orderBy: [{ resolvedAt: 'desc' }, { id: 'desc' }],
    });
  }

  private async query(
    admin: AdminSession,
    limit: number,
    cursor: string | undefined,
    args: Pick<Prisma.ApprovalFindManyArgs, 'where' | 'orderBy'>,
  ): Promise<Page<AdminApprovalRow>> {
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      const rows: Row[] = await tx.approval.findMany({
        ...args,
        include,
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      const policies = await tx.toolPolicy.findMany({
        select: { level: true, allowTaskScope: true, mode: true },
      });
      const memberIds = [...new Set(rows.flatMap((r) => (r.operatorId ? [r.operatorId] : [])))];
      const members = memberIds.length
        ? await tx.user.findMany({
            where: { id: { in: memberIds } },
            select: { id: true, name: true },
          })
        : [];
      const names = new Map(members.map((m) => [m.id, m.name]));
      return toPage(rows, limit, (r) => ({
        ...toApprovalView(
          r,
          taskScopeAllowed(r, policies.find((p) => p.level === r.permissionLevel) ?? null),
        ),
        taskTitle: r.task.title,
        conversationId: r.task.conversationId,
        endUserPseudonym: r.task.endUser.pseudonym,
        user: r.userDecision
          ? {
              decision: r.userDecision,
              comment: r.userComment,
              at: r.userDecidedAt?.toISOString() ?? '',
            }
          : null,
        operator: r.operatorDecision
          ? {
              decision: r.operatorDecision,
              comment: r.operatorComment,
              at: r.operatorDecidedAt?.toISOString() ?? '',
              memberId: r.operatorId,
              memberName: r.operatorId ? (names.get(r.operatorId) ?? null) : null,
            }
          : null,
        createdAt: r.createdAt.toISOString(),
        resolvedAt: r.resolvedAt?.toISOString() ?? null,
      }));
    });
  }
}
