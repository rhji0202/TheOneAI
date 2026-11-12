import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminAuthGuard, CurrentAdmin, Roles } from '../../admin/auth/admin-auth.guard.js';
import type { AdminSession } from '../../admin/auth/admin-session.js';
import { AuditService } from '../../admin/audit/audit.service.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { TaskControlService } from '../task-control.service.js';
import {
  type AdminTaskQuery,
  adminTaskQuerySchema,
  TasksAdminService,
} from './tasks-admin.service.js';

const uuid = { schema: z.uuid() };
const reasonSchema = z.object({ reason: z.string().trim().max(500).optional() });
const resumeSchema = z.object({
  fromStepId: z.uuid().optional(),
  mode: z.enum(['checkpoint', 'restart']).default('checkpoint'),
});

/** docs/api-spec.md §4.2 — 작업 (C-02). 조회는 Viewer, 제어는 Operator 이상 */
@Controller({ path: 'admin/tasks', version: '1' })
@UseGuards(AdminAuthGuard)
export class TasksAdminController {
  constructor(
    private readonly tasks: TasksAdminService,
    private readonly control: TaskControlService,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  list(
    @CurrentAdmin() admin: AdminSession,
    @Query({ schema: adminTaskQuerySchema }) q: AdminTaskQuery,
  ) {
    return this.tasks.list(admin, q);
  }

  @Get(':id/trace')
  trace(@CurrentAdmin() admin: AdminSession, @Param('id', uuid) id: string) {
    return this.tasks.trace(admin, id);
  }

  @Get(':id/steps/:stepId')
  step(
    @CurrentAdmin() admin: AdminSession,
    @Param('id', uuid) id: string,
    @Param('stepId', uuid) stepId: string,
  ) {
    return this.tasks.step(admin, id, stepId);
  }

  @Post(':id/pause')
  @HttpCode(202)
  @Roles('operator')
  async pause(
    @CurrentAdmin() admin: AdminSession,
    @Param('id', uuid) id: string,
    @Body({ schema: reasonSchema }) body: { reason?: string },
  ) {
    const result = await this.control.pause(
      admin.tenantId,
      id,
      {},
      body.reason ? `operator: ${body.reason}` : 'operator_paused',
    );
    await this.log(admin, 'task.pause', id, body);
    return result;
  }

  @Post(':id/cancel')
  @HttpCode(202)
  @Roles('operator')
  async cancel(
    @CurrentAdmin() admin: AdminSession,
    @Param('id', uuid) id: string,
    @Body({ schema: reasonSchema }) body: { reason?: string },
  ) {
    const result = await this.control.cancel(admin.tenantId, id, {}, 'operator_cancelled');
    await this.log(admin, 'task.cancel', id, body);
    return result;
  }

  @Post(':id/resume')
  @HttpCode(202)
  @Roles('operator')
  async resume(
    @CurrentAdmin() admin: AdminSession,
    @Param('id', uuid) id: string,
    @Body({ schema: resumeSchema }) body: { fromStepId?: string; mode: 'checkpoint' | 'restart' },
  ) {
    const result = await this.control.resume(admin.tenantId, id, {}, body);
    await this.log(admin, 'task.resume', id, body);
    return result;
  }

  private async log(
    admin: AdminSession,
    action: string,
    taskId: string,
    metadata: Record<string, unknown>,
  ) {
    await this.prisma.withTenant(admin.tenantId, (tx) =>
      this.audit.record(tx, admin, { action, targetType: 'task', targetId: taskId, metadata }),
    );
  }
}
