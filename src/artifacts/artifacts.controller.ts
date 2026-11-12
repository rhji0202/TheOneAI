import { Body, Controller, Get, Param, Post, Put, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { AdminAuthGuard, CurrentAdmin } from '../admin/auth/admin-auth.guard.js';
import type { AdminSession } from '../admin/auth/admin-session.js';
import { CurrentSession, WidgetSessionGuard } from '../widget/widget-session.guard.js';
import type { WidgetRequest, WidgetSession } from '../widget/widget-session.js';
import {
  ArtifactsService,
  type CreateUploadInput,
  createUploadSchema,
} from './artifacts.service.js';

const uuid = { schema: z.uuid() };

/** docs/api-spec.md §2.6 — 첨부 업로드 · 산출물 (위젯 세션) */
@Controller({ version: '1' })
@UseGuards(WidgetSessionGuard)
export class ArtifactsController {
  constructor(private readonly artifacts: ArtifactsService) {}

  @Post('uploads')
  create(
    @CurrentSession() session: WidgetSession,
    @Body({ schema: createUploadSchema }) body: CreateUploadInput,
  ) {
    return this.artifacts.createUpload(session, body);
  }

  /** 내용 — 요청 본문 그대로 (configure-app 에서 raw 로 받는다) */
  @Put('uploads/:id/content')
  put(
    @CurrentSession() session: WidgetSession,
    @Param('id', uuid) id: string,
    @Req() req: WidgetRequest,
  ) {
    return this.artifacts.putContent(session, id, req.body as Buffer);
  }

  @Get('tasks/:id/artifacts')
  list(@CurrentSession() session: WidgetSession, @Param('id', uuid) id: string) {
    return this.artifacts.taskArtifacts(session, id);
  }

  @Get('artifacts/:id/download')
  async download(
    @CurrentSession() session: WidgetSession,
    @Param('id', uuid) id: string,
    @Res() res: Response,
  ) {
    const { artifact, data } = await this.artifacts.download(session, id);
    send(res, artifact, data);
  }
}

/** 콘솔 — 테넌트 안의 첨부 · 산출물 내려받기 (C-02) */
@Controller({ path: 'admin/artifacts', version: '1' })
@UseGuards(AdminAuthGuard)
export class ArtifactsAdminController {
  constructor(private readonly artifacts: ArtifactsService) {}

  @Get(':id/download')
  async download(
    @CurrentAdmin() admin: AdminSession,
    @Param('id', uuid) id: string,
    @Res() res: Response,
  ) {
    const { artifact, data } = await this.artifacts.downloadAsAdmin(admin.tenantId, id);
    send(res, artifact, data);
  }
}

function send(res: Response, artifact: { fileName: string; mimeType: string }, data: Buffer) {
  res
    .status(200)
    .setHeader('Content-Type', artifact.mimeType)
    .setHeader('Content-Length', String(data.length))
    .setHeader(
      'Content-Disposition',
      `attachment; filename="${artifact.fileName.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(artifact.fileName)}`,
    )
    .setHeader('X-Content-Type-Options', 'nosniff')
    .end(data);
}
