import { Body, Controller, Get, Put, Query, Req, UseGuards } from '@nestjs/common';
import { AdminAuthGuard, CurrentAdmin, Roles } from '../../admin/auth/admin-auth.guard.js';
import type { AdminRequest, AdminSession } from '../../admin/auth/admin-session.js';
import {
  BillingAdminService,
  type BudgetPut,
  budgetPutSchema,
  type ModelPricesPut,
  modelPricesPutSchema,
  type UsageQuery,
  usageQuerySchema,
} from './billing-admin.service.js';

/** 사용량 · 과금 — 조회는 Viewer, 단가는 Admin, 월 한도는 Owner */
@Controller({ path: 'admin/billing', version: '1' })
@UseGuards(AdminAuthGuard)
export class BillingAdminController {
  constructor(private readonly billing: BillingAdminService) {}

  @Get('usage')
  usage(@CurrentAdmin() admin: AdminSession, @Query({ schema: usageQuerySchema }) q: UsageQuery) {
    return this.billing.usage(admin, q);
  }

  @Get('model-prices')
  prices(@CurrentAdmin() admin: AdminSession) {
    return this.billing.prices(admin);
  }

  @Put('model-prices')
  @Roles('admin')
  replacePrices(
    @CurrentAdmin() admin: AdminSession,
    @Body({ schema: modelPricesPutSchema }) body: ModelPricesPut,
    @Req() req: AdminRequest,
  ) {
    return this.billing.replacePrices(admin, body, req);
  }

  @Put('budget')
  @Roles('owner')
  budget(
    @CurrentAdmin() admin: AdminSession,
    @Body({ schema: budgetPutSchema }) body: BudgetPut,
    @Req() req: AdminRequest,
  ) {
    return this.billing.setBudget(admin, body, req);
  }
}
