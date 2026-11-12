import { Injectable, Logger } from '@nestjs/common';
import { ApprovalsService } from '../approvals/approvals.service.js';
import { PrismaService } from '../infrastructure/database/prisma.service.js';

/**
 * approval-expiry — 만료 시각이 지난 대기 승인을 expired 로 바꾸고, 그 작업을 paused 로 둔다(checkpoint 유지).
 * 사용자가 재개하면 같은 Tool 호출부터 다시 승인을 요청한다. 테넌트 횡단 조회는 app_find_expired_approvals 로만 한다.
 */
@Injectable()
export class ApprovalExpiryService {
  private readonly logger = new Logger(ApprovalExpiryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly approvals: ApprovalsService,
  ) {}

  async tick(): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ approval_id: string; tenant_id: string }>>`
      SELECT approval_id, tenant_id FROM app_find_expired_approvals(100)`;
    let expired = 0;
    for (const row of rows) {
      const done = await this.approvals
        .expire(row.tenant_id, row.approval_id)
        .catch((err: unknown) => {
          this.logger.error(`승인 만료 처리 실패 (${row.approval_id}): ${String(err)}`);
          return false;
        });
      if (done) expired++;
    }
    return expired;
  }
}
