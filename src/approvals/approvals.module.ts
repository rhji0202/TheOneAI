import { Module } from '@nestjs/common';
import { ApprovalsAdminController } from './admin/approvals-admin.controller.js';
import { ApprovalsAdminService } from './admin/approvals-admin.service.js';
import { ToolPoliciesAdminService } from './admin/tool-policies-admin.service.js';
import { ApprovalsCoreModule } from './approvals-core.module.js';
import { ApprovalsController } from './approvals.controller.js';

/** docs/api-spec.md §2.5 · §4.7 — 위젯 승인 결정, 콘솔 승인 목록 · 대리 결정 · 권한 정책 */
@Module({
  imports: [ApprovalsCoreModule],
  controllers: [ApprovalsController, ApprovalsAdminController],
  providers: [ApprovalsAdminService, ToolPoliciesAdminService],
})
export class ApprovalsModule {}
