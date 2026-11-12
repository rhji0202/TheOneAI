import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../admin/audit/audit.service.js';
import type { AdminRequest, AdminSession } from '../admin/auth/admin-session.js';
import { AppError } from '../common/errors/app-error.js';
import { type TaskEventEnvelope, TaskEventsService } from '../events/task-events.service.js';
import type { Approval, ApprovalStatus } from '../generated/prisma/client.js';
import { PrismaService, type TenantTx } from '../infrastructure/database/prisma.service.js';
import { TaskQueueService } from '../infrastructure/queue/task-queue.service.js';
import { type ApprovalView, taskScopeAllowed, toApprovalView } from '../tasks/approval-views.js';

export const userDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  scope: z.enum(['once', 'task']).default('once'),
  comment: z.string().trim().max(1_000).optional(),
});
export type UserDecisionInput = z.infer<typeof userDecisionSchema>;

/** 콘솔 대리 승인 · 거절 — 사유 필수 */
export const operatorDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  comment: z.string().trim().min(1).max(1_000),
});
export type OperatorDecisionInput = z.infer<typeof operatorDecisionSchema>;

type Actor =
  | { kind: 'user'; endUserId: string }
  | { kind: 'operator'; admin: AdminSession; req?: AdminRequest };

type DecidedBy = 'user' | 'operator' | 'system';

interface Outcome {
  view: ApprovalView;
  events: TaskEventEnvelope[];
  /** 대기 중인 승인이 모두 끝나 작업을 다시 큐에 넣는다 */
  resume: boolean;
  /** 만료된 승인에 결정하려 했다 (만료 처리는 커밋하고 410) */
  expired?: boolean;
}

/**
 * 승인 결정 (docs/api-spec.md §2.5 · §4.7).
 *  - 사용자(위젯): 자기 작업의 승인만. operator 전용 승인은 FORBIDDEN_APPROVER
 *  - 운영자(콘솔, Operator 이상): 대리 승인 · 거절, 사유 필수 · 감사 로그
 *  - user_and_operator: 양쪽 모두 승인해야 approved (먼저 한 쪽은 기록만, approval.updated), 어느 쪽이든 거절하면 rejected
 *  - 결정이 나고 그 작업에 대기 중인 승인이 더 없으면 작업을 queued 로 바꾸고 재개 Job 을 넣는다 (같은 Tool 호출부터)
 * 작업 행을 먼저 잠근다 — Worker 의 waiting_approval 전환 · 중지 · 만료 처리와 순서가 섞이지 않도록.
 */
@Injectable()
export class ApprovalsService {
  private readonly logger = new Logger(ApprovalsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: TaskEventsService,
    private readonly queue: TaskQueueService,
    private readonly audit: AuditService,
  ) {}

  decideAsUser(
    tenantId: string,
    endUserId: string,
    approvalId: string,
    input: UserDecisionInput,
  ): Promise<ApprovalView> {
    return this.decide(tenantId, approvalId, { kind: 'user', endUserId }, input);
  }

  decideAsOperator(
    admin: AdminSession,
    approvalId: string,
    input: OperatorDecisionInput,
    req?: AdminRequest,
  ): Promise<ApprovalView> {
    return this.decide(
      admin.tenantId,
      approvalId,
      { kind: 'operator', admin, req },
      { ...input, scope: 'once' },
    );
  }

  /** approval-expiry — 만료 시각이 지난 대기 승인 → expired, 작업은 paused (checkpoint 유지) */
  async expire(tenantId: string, approvalId: string): Promise<boolean> {
    const outcome = await this.prisma.withTenant(tenantId, async (tx) => {
      const approval = await this.lockFor(tx, approvalId, null);
      if (approval.status !== 'pending' || approval.expiresAt > new Date()) return null;
      return this.expireLocked(tx, tenantId, approval);
    });
    if (!outcome) return false;
    await this.events.publish(outcome.taskId, ...outcome.events);
    return true;
  }

  private async decide(
    tenantId: string,
    approvalId: string,
    actor: Actor,
    input: UserDecisionInput,
  ): Promise<ApprovalView> {
    const outcome = await this.prisma.withTenant(tenantId, async (tx): Promise<Outcome> => {
      const approval = await this.lockFor(
        tx,
        approvalId,
        actor.kind === 'user' ? actor.endUserId : null,
      );
      if (approval.status !== 'pending') throw new AppError(409, 'APPROVAL_ALREADY_RESOLVED');
      if (approval.expiresAt <= new Date()) {
        const expired = await this.expireLocked(tx, tenantId, approval);
        return { view: expired.view, events: expired.events, resume: false, expired: true };
      }

      const allowTaskScope = taskScopeAllowed(
        approval,
        await tx.toolPolicy.findFirst({
          where: { level: approval.permissionLevel },
          select: { allowTaskScope: true, mode: true },
        }),
      );
      if (actor.kind === 'user') {
        if (approval.requiredApprover === 'operator')
          throw new AppError(403, 'FORBIDDEN_APPROVER', '운영자가 승인해야 하는 요청입니다');
        if (approval.userDecision)
          throw new AppError(409, 'APPROVAL_ALREADY_RESOLVED', '이미 결정했습니다');
        if (input.decision === 'approve' && input.scope === 'task' && !allowTaskScope)
          throw new AppError(422, 'APPROVAL_SCOPE_NOT_ALLOWED');
      } else if (approval.operatorDecision) {
        throw new AppError(409, 'APPROVAL_ALREADY_RESOLVED', '이미 결정했습니다');
      }

      const now = new Date();
      const status = nextStatus(approval, actor.kind, input.decision);
      const updated = await tx.approval.update({
        where: { id: approval.id },
        data: {
          ...(actor.kind === 'user'
            ? {
                userDecision: input.decision,
                userComment: input.comment ?? null,
                userDecidedAt: now,
                // task 범위는 사용자가 승인하며 고를 때만
                ...(input.decision === 'approve' && input.scope === 'task'
                  ? { scope: 'task' as const }
                  : {}),
              }
            : {
                operatorDecision: input.decision,
                operatorComment: input.comment ?? null,
                operatorId: actor.admin.userId,
                operatorDecidedAt: now,
              }),
          status,
          ...(status !== 'pending' ? { resolvedAt: now } : {}),
        },
      });
      if (actor.kind === 'operator') {
        await this.audit.record(
          tx,
          actor.admin,
          {
            action: `approval.${input.decision}`,
            targetType: 'approval',
            targetId: approval.id,
            metadata: {
              taskId: approval.taskId,
              toolName: approval.toolName,
              comment: input.comment,
              status,
            },
          },
          actor.req,
        );
      }

      const view = toApprovalView(updated, allowTaskScope);
      if (status === 'pending') {
        // user_and_operator 의 한쪽 승인 — 남은 쪽을 기다린다
        const event = await this.events.append(tx, tenantId, approval.taskId, 'approval.updated', {
          approval: view,
        });
        return { view, events: [event], resume: false };
      }
      const resolved = await this.afterResolved(tx, tenantId, updated, status, actor.kind);
      return { view, ...resolved };
    });

    await this.events.publish(outcome.view.taskId, ...outcome.events);
    if (outcome.expired) throw new AppError(410, 'APPROVAL_EXPIRED');
    if (outcome.resume) {
      await this.queue.enqueueResume(
        { tenantId, taskId: outcome.view.taskId },
        { kind: 'resume', n: approvalId },
      );
    }
    return outcome.view;
  }

  /** 결정 · 만료 뒤: approval.resolved, 승인 요청 단계 닫기, 대기 중인 승인이 더 없으면 작업 재개 · 일시정지 */
  private async afterResolved(
    tx: TenantTx,
    tenantId: string,
    approval: Approval,
    status: ApprovalStatus,
    decidedBy: DecidedBy,
  ): Promise<{ events: TaskEventEnvelope[]; resume: boolean }> {
    const events: TaskEventEnvelope[] = [];
    await tx.taskStep.updateMany({
      where: { id: approval.stepId, status: 'waiting_approval' },
      data: {
        status: status === 'approved' ? 'succeeded' : 'skipped',
        summary: STEP_SUMMARY[status] ?? null,
        finishedAt: new Date(),
      },
    });
    events.push(
      await this.events.append(tx, tenantId, approval.taskId, 'approval.resolved', {
        approvalId: approval.id,
        status,
        decidedBy,
      }),
    );
    const task = await tx.task.findUniqueOrThrow({
      where: { id: approval.taskId },
      select: { status: true },
    });
    const stillPending = await tx.approval.count({
      where: { taskId: approval.taskId, status: 'pending' },
    });
    // 실행 중(Worker 가 막 승인을 요청한 참)이면 Worker 가 waiting_approval 로 바꿀 때 대기 승인이 없음을 보고 재개한다
    if (task.status !== 'waiting_approval' || stillPending > 0) return { events, resume: false };

    if (status === 'expired') {
      await tx.task.update({
        where: { id: approval.taskId },
        data: { status: 'paused', pausedReason: 'approval_expired' },
      });
      events.push(
        await this.events.append(tx, tenantId, approval.taskId, 'task.status', {
          status: 'paused',
          reason: 'approval_expired',
        }),
      );
      return { events, resume: false };
    }
    await tx.task.update({
      where: { id: approval.taskId },
      data: { status: 'queued', queuedAt: new Date() },
    });
    events.push(
      await this.events.append(tx, tenantId, approval.taskId, 'task.status', {
        status: 'queued',
        reason: 'approval_resolved',
      }),
    );
    return { events, resume: true };
  }

  private async expireLocked(tx: TenantTx, tenantId: string, approval: Approval) {
    const updated = await tx.approval.update({
      where: { id: approval.id },
      data: { status: 'expired', resolvedAt: new Date() },
    });
    const { events } = await this.afterResolved(tx, tenantId, updated, 'expired', 'system');
    this.logger.log(`승인 만료 (${approval.id}, 작업 ${approval.taskId})`);
    return { taskId: approval.taskId, events, view: toApprovalView(updated, false) };
  }

  /** 승인과 그 작업 행을 잠근다 (작업 → 승인 순서). 위젯이면 사용자 본인 작업만 */
  private async lockFor(
    tx: TenantTx,
    approvalId: string,
    endUserId: string | null,
  ): Promise<Approval> {
    const found = await tx.approval.findUnique({
      where: { id: approvalId },
      select: { taskId: true },
    });
    if (!found) throw AppError.notFound('승인 요청을 찾을 수 없습니다');
    const rows = endUserId
      ? await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM tasks WHERE id = ${found.taskId}::uuid AND end_user_id = ${endUserId}::uuid FOR UPDATE`
      : await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM tasks WHERE id = ${found.taskId}::uuid FOR UPDATE`;
    if (!rows.length) throw AppError.notFound('승인 요청을 찾을 수 없습니다');
    const [approval] = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM approvals WHERE id = ${approvalId}::uuid FOR UPDATE`;
    if (!approval) throw AppError.notFound('승인 요청을 찾을 수 없습니다');
    return tx.approval.findUniqueOrThrow({ where: { id: approvalId } });
  }
}

const STEP_SUMMARY: Partial<Record<ApprovalStatus, string>> = {
  approved: '승인됨',
  rejected: '거절됨',
  expired: '승인 만료',
  cancelled: '승인 취소',
};

/** 결정 뒤 상태 — 거절은 누구든 바로 rejected, 승인은 필요한 승인자가 모두 승인했을 때 approved */
export function nextStatus(
  approval: Pick<Approval, 'requiredApprover' | 'userDecision' | 'operatorDecision'>,
  actor: 'user' | 'operator',
  decision: 'approve' | 'reject',
): ApprovalStatus {
  if (decision === 'reject') return 'rejected';
  if (approval.requiredApprover !== 'user_and_operator') return 'approved'; // 운영자는 사용자 대신 승인할 수 있다
  const other = actor === 'user' ? approval.operatorDecision : approval.userDecision;
  return other === 'approve' ? 'approved' : 'pending';
}
