import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import { AdminAuthGuard, CurrentAdmin, Roles } from '../../admin/auth/admin-auth.guard.js';
import type { AdminRequest, AdminSession } from '../../admin/auth/admin-session.js';
import { AppError } from '../../common/errors/app-error.js';
import {
  MAX_ICON_BYTES,
  type WidgetConfigPatch,
  widgetConfigPatchSchema,
  WidgetConfigsAdminService,
} from './widget-configs-admin.service.js';

const uuid = { schema: z.uuid() };

/** docs/api-spec.md §4.9 — 위젯 설치 · 테마 (C-09). 조회는 Viewer, 변경은 Admin */
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

  /** 위젯 아이콘 — multipart/form-data, 필드 이름 file (PNG · JPEG · WebP, 256KB 이하) */
  @Post(':id/icon')
  @HttpCode(200)
  @Roles('admin')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_ICON_BYTES, files: 1, fields: 5 } }),
  )
  uploadIcon(
    @CurrentAdmin() admin: AdminSession,
    @Param('id', uuid) id: string,
    @UploadedFile() file: { buffer: Buffer } | undefined,
    @Req() req: AdminRequest,
  ) {
    if (!file?.buffer?.length) {
      throw new AppError(422, 'VALIDATION_FAILED', 'file 필드에 아이콘 이미지를 올려 주세요', [
        { path: 'file', message: '이미지 파일이 필요합니다' },
      ]);
    }
    return this.widgets.setIcon(admin, id, file.buffer, req);
  }

  @Delete(':id/icon')
  @Roles('admin')
  removeIcon(
    @CurrentAdmin() admin: AdminSession,
    @Param('id', uuid) id: string,
    @Req() req: AdminRequest,
  ) {
    return this.widgets.removeIcon(admin, id, req);
  }
}
