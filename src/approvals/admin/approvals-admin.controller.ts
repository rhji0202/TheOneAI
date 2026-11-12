import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AdminAuthGuard, CurrentAdmin, Roles } from '../../admin/auth/admin-auth.guard.js';
import type { AdminRequest, AdminSession } from '../../admin/auth/admin-session.js';
import {
  ApprovalsService,
  type OperatorDecisionInput,
  operatorDecisionSchema,
} from '../approvals.service.js';
import {
  type ApprovalHistoryQuery,
  approvalHistorySchema,
  type ApprovalListQuery,
  approvalListSchema,
  ApprovalsAdminService,
} from './approvals-admin.service.js';
import {
  ToolPoliciesAdminService,
  type ToolPoliciesPut,
  toolPoliciesPutSchema,
  type ToolPolicyRuleInput,
  toolPolicyRuleInputSchema,
  type ToolPolicyRulePatch,
  toolPolicyRulePatchSchema,
} from './tool-policies-admin.service.js';

const uuid = { schema: z.uuid() };

/** docs/api-spec.md §4.7 — 승인 · 권한 정책 (C-07). 조회는 Viewer, 대리 결정은 Operator, 정책 변경은 Admin */
@Controller({ path: 'admin', version: '1' })
@UseGuards(AdminAuthGuard)
export class ApprovalsAdminController {
  constructor(
    private readonly approvals: ApprovalsService,
    private readonly list: ApprovalsAdminService,
    private readonly policies: ToolPoliciesAdminService,
  ) {}

  @Get('approvals')
  listApprovals(
    @CurrentAdmin() admin: AdminSession,
    @Query({ schema: approvalListSchema }) q: ApprovalListQuery,
  ) {
    return this.list.list(admin, q);
  }

  @Get('approvals/history')
  history(
    @CurrentAdmin() admin: AdminSession,
    @Query({ schema: approvalHistorySchema }) q: ApprovalHistoryQuery,
  ) {
    return this.list.history(admin, q);
  }

  @Post('approvals/:id/decision')
  @HttpCode(200)
  @Roles('operator')
  decide(
    @CurrentAdmin() admin: AdminSession,
    @Param('id', uuid) id: string,
    @Body({ schema: operatorDecisionSchema }) body: OperatorDecisionInput,
    @Req() req: AdminRequest,
  ) {
    return this.approvals.decideAsOperator(admin, id, body, req);
  }

  @Get('tool-policies')
  toolPolicies(@CurrentAdmin() admin: AdminSession) {
    return this.policies.policies(admin);
  }

  @Put('tool-policies')
  @Roles('admin')
  replaceToolPolicies(
    @CurrentAdmin() admin: AdminSession,
    @Body({ schema: toolPoliciesPutSchema }) body: ToolPoliciesPut,
    @Req() req: AdminRequest,
  ) {
    return this.policies.replacePolicies(admin, body, req);
  }

  @Get('tool-policy-rules')
  rules(@CurrentAdmin() admin: AdminSession) {
    return this.policies.rules(admin);
  }

  @Post('tool-policy-rules')
  @Roles('admin')
  createRule(
    @CurrentAdmin() admin: AdminSession,
    @Body({ schema: toolPolicyRuleInputSchema }) body: ToolPolicyRuleInput,
    @Req() req: AdminRequest,
  ) {
    return this.policies.createRule(admin, body, req);
  }

  @Patch('tool-policy-rules/:id')
  @Roles('admin')
  updateRule(
    @CurrentAdmin() admin: AdminSession,
    @Param('id', uuid) id: string,
    @Body({ schema: toolPolicyRulePatchSchema }) body: ToolPolicyRulePatch,
    @Req() req: AdminRequest,
  ) {
    return this.policies.updateRule(admin, id, body, req);
  }

  @Delete('tool-policy-rules/:id')
  @HttpCode(204)
  @Roles('admin')
  async deleteRule(
    @CurrentAdmin() admin: AdminSession,
    @Param('id', uuid) id: string,
    @Req() req: AdminRequest,
  ) {
    await this.policies.deleteRule(admin, id, req);
  }
}
