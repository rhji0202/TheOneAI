import {
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
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
import { BUNDLE_LIMITS } from '../bundle/skill-bundle.js';
import {
  type SkillListQuery,
  skillListQuerySchema,
  SkillsAdminService,
} from './skills-admin.service.js';

/** multer 메모리 저장 파일 중 쓰는 필드 */
interface UploadedZip {
  buffer: Buffer;
  size: number;
  originalname: string;
}

const uuid = { schema: z.uuid() };
const diffQuery = z.object({ against: z.uuid().optional() });
const fileQuery = z.object({ path: z.string().min(1).max(255) });

/** docs/api-spec.md §4.6 — Skill (C-06). 조회는 Viewer, 등록 · 활성화는 Admin 이상 */
@Controller({ path: 'admin/skills', version: '1' })
@UseGuards(AdminAuthGuard)
export class SkillsAdminController {
  constructor(private readonly skills: SkillsAdminService) {}

  @Get()
  list(
    @CurrentAdmin() admin: AdminSession,
    @Query({ schema: skillListQuerySchema }) q: SkillListQuery,
  ) {
    return this.skills.list(admin, q);
  }

  /** multipart/form-data, 필드 이름 file (zip, 20MB 이하) */
  @Post()
  @Roles('admin')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: BUNDLE_LIMITS.zipBytes, files: 1, fields: 5 } }),
  )
  upload(
    @CurrentAdmin() admin: AdminSession,
    @UploadedFile() file: UploadedZip | undefined,
    @Req() req: AdminRequest,
  ) {
    if (!file?.buffer?.length) {
      throw new AppError(422, 'VALIDATION_FAILED', 'file 필드에 Skill zip 을 올려 주세요', [
        { path: 'file', message: 'zip 파일이 필요합니다' },
      ]);
    }
    return this.skills.upload(admin, file.buffer, req);
  }

  @Get(':id')
  get(@CurrentAdmin() admin: AdminSession, @Param('id', uuid) id: string) {
    return this.skills.get(admin, id);
  }

  @Get(':id/versions')
  versions(@CurrentAdmin() admin: AdminSession, @Param('id', uuid) id: string) {
    return this.skills.versions(admin, id);
  }

  @Get(':id/versions/:versionId')
  version(
    @CurrentAdmin() admin: AdminSession,
    @Param('id', uuid) id: string,
    @Param('versionId', uuid) versionId: string,
  ) {
    return this.skills.version(admin, id, versionId);
  }

  /** 파일 내용 — 경로는 ?path= (예: references/style_guide.md) */
  @Get(':id/versions/:versionId/file')
  file(
    @CurrentAdmin() admin: AdminSession,
    @Param('id', uuid) id: string,
    @Param('versionId', uuid) versionId: string,
    @Query({ schema: fileQuery }) q: { path: string },
  ) {
    return this.skills.file(admin, id, versionId, q.path);
  }

  @Get(':id/versions/:versionId/diff')
  diff(
    @CurrentAdmin() admin: AdminSession,
    @Param('id', uuid) id: string,
    @Param('versionId', uuid) versionId: string,
    @Query({ schema: diffQuery }) q: { against?: string },
  ) {
    return this.skills.diff(admin, id, versionId, q.against);
  }

  @Post(':id/versions/:versionId/activate')
  @HttpCode(200)
  @Roles('admin')
  activate(
    @CurrentAdmin() admin: AdminSession,
    @Param('id', uuid) id: string,
    @Param('versionId', uuid) versionId: string,
    @Req() req: AdminRequest,
  ) {
    return this.skills.activate(admin, id, versionId, req);
  }

  @Post(':id/disable')
  @HttpCode(200)
  @Roles('admin')
  disable(
    @CurrentAdmin() admin: AdminSession,
    @Param('id', uuid) id: string,
    @Req() req: AdminRequest,
  ) {
    return this.skills.disable(admin, id, req);
  }
}
