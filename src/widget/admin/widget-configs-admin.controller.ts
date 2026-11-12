import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AdminAuthGuard, CurrentAdmin, Roles } from '../../admin/auth/admin-auth.guard.js';
import type { AdminRequest, AdminSession } from '../../admin/auth/admin-session.js';
import {
  type WidgetConfigPatch,
  widgetConfigPatchSchema,
  WidgetConfigsAdminService,
} from './widget-configs-admin.service.js';

const uuid = { schema: z.uuid() };

/** docs/api-spec.md §4.9 — 위젯 설치 · 테마 (C-09). 조회는 Viewer, 변경은 Admin, Secret 재발급은 Owner */
@Controller({ path: 'admin/widget-configs', version: '1' })
@UseGuards(AdminAuthGuard)
export class WidgetConfigsAdminController {
  constructor(private readonly widgets: WidgetConfigsAdminService) {}

  @Get()
  list(@CurrentAdmin() admin: AdminSession) {
    return this.widgets.list(admin);
  }

  @Patch(':id')
  @Roles('admin')
  update(
    @CurrentAdmin() admin: AdminSession,
    @Param('id', uuid) id: string,
    @Body({ schema: widgetConfigPatchSchema }) body: WidgetConfigPatch,
    @Req() req: AdminRequest,
  ) {
    return this.widgets.update(admin, id, body, req);
  }

  @Post(':id/rotate-secret')
  @HttpCode(200)
  @Roles('owner')
  rotate(
    @CurrentAdmin() admin: AdminSession,
    @Param('id', uuid) id: string,
    @Req() req: AdminRequest,
  ) {
    return this.widgets.rotateSecret(admin, id, req);
  }
}
