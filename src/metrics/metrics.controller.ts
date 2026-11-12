import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AdminAuthGuard, CurrentAdmin } from '../admin/auth/admin-auth.guard.js';
import type { AdminSession } from '../admin/auth/admin-session.js';
import { type MetricsQuery, metricsQuerySchema, MetricsService } from './metrics.service.js';

/** docs/api-spec.md §4.1 — 대시보드 품질 지표 (Viewer 이상) */
@Controller({ path: 'admin', version: '1' })
@UseGuards(AdminAuthGuard)
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('metrics')
  get(@CurrentAdmin() admin: AdminSession, @Query({ schema: metricsQuerySchema }) q: MetricsQuery) {
    return this.metrics.metrics(admin, q);
  }
}
