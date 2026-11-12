import { Body, Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { ApprovalView } from '../tasks/approval-views.js';
import { CurrentSession, WidgetSessionGuard } from '../widget/widget-session.guard.js';
import type { WidgetSession } from '../widget/widget-session.js';
import {
  ApprovalsService,
  type UserDecisionInput,
  userDecisionSchema,
} from './approvals.service.js';

/** docs/api-spec.md §2.5 — 위젯 승인 카드(W-03)의 승인 · 거절 */
@Controller({ path: 'approvals', version: '1' })
@UseGuards(WidgetSessionGuard)
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Post(':id/decision')
  @HttpCode(200)
  decide(
    @CurrentSession() session: WidgetSession,
    @Param('id', { schema: z.uuid() }) id: string,
    @Body({ schema: userDecisionSchema }) body: UserDecisionInput,
  ): Promise<ApprovalView> {
    return this.approvals.decideAsUser(session.tenantId, session.endUserId, id, body);
  }
}
