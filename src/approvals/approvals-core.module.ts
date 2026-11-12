import { Module } from '@nestjs/common';
import { ApprovalsService } from './approvals.service.js';

/** 승인 결정 · 만료 처리 — API(결정)와 Worker(approval-expiry) 양쪽에서 쓴다 */
@Module({
  providers: [ApprovalsService],
  exports: [ApprovalsService],
})
export class ApprovalsCoreModule {}
