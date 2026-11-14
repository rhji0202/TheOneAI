import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AdminAuthGuard, CurrentAdmin, Roles } from '../../admin/auth/admin-auth.guard.js';
import type { AdminRequest, AdminSession } from '../../admin/auth/admin-session.js';
import {
  type WorkspaceCreate,
  workspaceCreateSchema,
  type WorkspaceDelete,
  workspaceDeleteSchema,
  type WorkspaceRename,
  workspaceRenameSchema,
  WorkspacesAdminService,
} from './workspaces-admin.service.js';

/** docs/api-spec.md §4.11 — 워크스페이스. 조회는 Viewer, 이름 변경은 Admin, 생성 · 삭제는 Owner */
@Controller({ path: 'admin', version: '1' })
@UseGuards(AdminAuthGuard)
export class WorkspacesAdminController {
  constructor(private readonly workspaces: WorkspacesAdminService) {}

  @Get('workspace')
  current(@CurrentAdmin() admin: AdminSession) {
    return this.workspaces.current(admin);
  }

  @Patch('workspace')
  @Roles('admin')
  rename(
    @CurrentAdmin() admin: AdminSession,
    @Body({ schema: workspaceRenameSchema }) body: WorkspaceRename,
    @Req() req: AdminRequest,
  ) {
    return this.workspaces.rename(admin, body, req);
  }

  @Delete('workspace')
  @HttpCode(204)
  @Roles('owner')
  remove(
    @CurrentAdmin() admin: AdminSession,
    @Body({ schema: workspaceDeleteSchema }) body: WorkspaceDelete,
  ) {
    return this.workspaces.remove(admin, body);
  }

  @Get('workspaces')
  list(@CurrentAdmin() admin: AdminSession) {
    return this.workspaces.listForMember(admin);
  }

  @Post('workspaces')
  @Roles('owner')
  create(
    @CurrentAdmin() admin: AdminSession,
    @Body({ schema: workspaceCreateSchema }) body: WorkspaceCreate,
    @Req() req: AdminRequest,
  ) {
    return this.workspaces.create(admin, body, req);
  }
}
