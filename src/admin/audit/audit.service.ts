import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import type { TenantTx } from '../../infrastructure/database/prisma.service.js';
import type { AdminRequest, AdminSession } from '../auth/admin-session.js';

export interface AuditEntry {
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * 감사 로그 (audit_logs). 변경과 같은 트랜잭션에서 남겨, 변경이 커밋되면 기록도 반드시 남는다.
 * Secret 값 · 개인정보는 metadata 에 넣지 않는다.
 */
@Injectable()
export class AuditService {
  async record(
    tx: TenantTx,
    admin: AdminSession,
    entry: AuditEntry,
    req?: AdminRequest,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        tenantId: admin.tenantId,
        actorType: 'user',
        actorId: admin.userId,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId ?? null,
        metadata: (entry.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
        ip: req?.ip ?? null,
        userAgent: req?.header('user-agent')?.slice(0, 500) ?? null,
        traceId: req?.traceId ?? null,
      },
    });
  }
}
