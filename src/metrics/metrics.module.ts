import { Module } from '@nestjs/common';
import { BillingAdminController } from '../billing/admin/billing-admin.controller.js';
import { BillingAdminService } from '../billing/admin/billing-admin.service.js';
import { MetricsController } from './metrics.controller.js';
import { MetricsService } from './metrics.service.js';

/** 대시보드 지표 (C-01) · 사용량 · 과금 (콘솔) */
@Module({
  controllers: [MetricsController, BillingAdminController],
  providers: [MetricsService, BillingAdminService],
})
export class MetricsModule {}
