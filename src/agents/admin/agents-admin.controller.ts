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
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AdminAuthGuard, CurrentAdmin, Roles } from '../../admin/auth/admin-auth.guard.js';
import type { AdminRequest, AdminSession } from '../../admin/auth/admin-session.js';
import {
  AgentsAdminService,
  type DraftInput,
  draftInputSchema,
  type PublishInput,
  publishInputSchema,
} from './agents-admin.service.js';

const uuid = { schema: z.uuid() };

/** docs/api-spec.md §4.4 — Agent 조회 · 초안 편집 · 배포 · 버전 기록 · 되돌리기 (C-03) */
@Controller({ path: 'admin/agents', version: '1' })
@UseGuards(AdminAuthGuard)
export class AgentsAdminController {
  constructor(private readonly agents: AgentsAdminService) {}

  @Get()
  list(@CurrentAdmin() admin: AdminSession) {
    return this.agents.list(admin);
  }

  @Get(':id')
  get(@CurrentAdmin() admin: AdminSession, @Param('id', uuid) id: string) {
    return this.agents.get(admin, id);
  }

  @Patch(':id/draft')
  @Roles('admin')
  updateDraft(
    @CurrentAdmin() admin: AdminSession,
    @Param('id', uuid) id: string,
    @Body({ schema: draftInputSchema }) body: DraftInput,
    @Req() req: AdminRequest,
  ) {
    return this.agents.updateDraft(admin, id, body, req);
  }

  @Post(':id/publish')
  @HttpCode(200)
  @Roles('admin')
  publish(
    @CurrentAdmin() admin: AdminSession,
    @Param('id', uuid) id: string,
    @Body({ schema: publishInputSchema }) body: PublishInput,
    @Req() req: AdminRequest,
  ) {
    return this.agents.publish(admin, id, body, req);
  }

  @Get(':id/versions')
  versions(@CurrentAdmin() admin: AdminSession, @Param('id', uuid) id: string) {
    return this.agents.versions(admin, id);
  }

  @Post(':id/versions/:versionId/restore')
  @HttpCode(200)
  @Roles('admin')
  restore(
    @CurrentAdmin() admin: AdminSession,
    @Param('id', uuid) id: string,
    @Param('versionId', uuid) versionId: string,
    @Req() req: AdminRequest,
  ) {
    return this.agents.restore(admin, id, versionId, req);
  }

  @Delete(':id/draft')
  @Roles('admin')
  discardDraft(
    @CurrentAdmin() admin: AdminSession,
    @Param('id', uuid) id: string,
    @Req() req: AdminRequest,
  ) {
    return this.agents.discardDraft(admin, id, req);
  }
}

/** Provider 목록 (모델 구성에서 고른다 — API Key 는 Secret 참조라 내려주지 않는다) */
@Controller({ path: 'admin/providers', version: '1' })
@UseGuards(AdminAuthGuard)
export class ProvidersAdminController {
  constructor(private readonly agents: AgentsAdminService) {}

  @Get()
  list(@CurrentAdmin() admin: AdminSession) {
    return this.agents.providers(admin);
  }
}
