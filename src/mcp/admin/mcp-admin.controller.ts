import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AdminAuthGuard, CurrentAdmin, Roles } from '../../admin/auth/admin-auth.guard.js';
import type { AdminRequest, AdminSession } from '../../admin/auth/admin-session.js';
import {
  type ApproveChangesInput,
  approveChangesSchema,
  type CreateServerInput,
  createServerSchema,
  registryDiffQuerySchema,
  type ServerListQuery,
  serverListQuerySchema,
  type ToolPolicyInput,
  toolPolicySchema,
  type ToolSelectionInput,
  toolSelectionSchema,
  type UpdateServerInput,
  updateServerSchema,
} from './mcp-admin.schemas.js';
import { McpAdminService } from './mcp-admin.service.js';

const uuid = { schema: z.uuid() };
const version = { schema: z.coerce.number().int().min(1) };

/** docs/api-spec.md §4.5 — MCP · Tool Registry (C-04 · C-05). 조회는 Viewer, 변경은 Admin 이상 */
@Controller({ path: 'admin', version: '1' })
@UseGuards(AdminAuthGuard)
export class McpAdminController {
  constructor(private readonly mcp: McpAdminService) {}

  @Get('mcp-servers')
  list(
    @CurrentAdmin() admin: AdminSession,
    @Query({ schema: serverListQuerySchema }) q: ServerListQuery,
  ) {
    return this.mcp.list(admin, q);
  }

  @Post('mcp-servers')
  @Roles('admin')
  create(
    @CurrentAdmin() admin: AdminSession,
    @Body({ schema: createServerSchema }) body: CreateServerInput,
    @Req() req: AdminRequest,
  ) {
    return this.mcp.create(admin, body, req);
  }

  @Get('mcp-servers/:id')
  get(@CurrentAdmin() admin: AdminSession, @Param('id', uuid) id: string) {
    return this.mcp.get(admin, id);
  }

  @Patch('mcp-servers/:id')
  @Roles('admin')
  update(
    @CurrentAdmin() admin: AdminSession,
    @Param('id', uuid) id: string,
    @Body({ schema: updateServerSchema }) body: UpdateServerInput,
    @Req() req: AdminRequest,
  ) {
    return this.mcp.update(admin, id, body, req);
  }

  @Post('mcp-servers/:id/test')
  @HttpCode(200)
  @Roles('admin')
  test(@CurrentAdmin() admin: AdminSession, @Param('id', uuid) id: string) {
    return this.mcp.test(admin, id);
  }

  @Post('mcp-servers/:id/discover')
  @HttpCode(200)
  @Roles('admin')
  discover(
    @CurrentAdmin() admin: AdminSession,
    @Param('id', uuid) id: string,
    @Req() req: AdminRequest,
  ) {
    return this.mcp.discover(admin, id, req);
  }

  @Put('mcp-servers/:id/tool-selection')
  @Roles('admin')
  selectTools(
    @CurrentAdmin() admin: AdminSession,
    @Param('id', uuid) id: string,
    @Body({ schema: toolSelectionSchema }) body: ToolSelectionInput,
    @Req() req: AdminRequest,
  ) {
    return this.mcp.selectTools(admin, id, body, req);
  }

  @Post('mcp-servers/:id/register')
  @HttpCode(200)
  @Roles('admin')
  register(
    @CurrentAdmin() admin: AdminSession,
    @Param('id', uuid) id: string,
    @Req() req: AdminRequest,
  ) {
    return this.mcp.register(admin, id, req);
  }

  @Get('mcp-servers/:id/tools')
  tools(@CurrentAdmin() admin: AdminSession, @Param('id', uuid) id: string) {
    return this.mcp.tools(admin, id);
  }

  @Put('mcp-tools/:id/policy')
  @Roles('admin')
  toolPolicy(
    @CurrentAdmin() admin: AdminSession,
    @Param('id', uuid) id: string,
    @Body({ schema: toolPolicySchema }) body: ToolPolicyInput,
    @Req() req: AdminRequest,
  ) {
    return this.mcp.updateToolPolicy(admin, id, body, req);
  }

  @Get('mcp-servers/:id/changes')
  changes(@CurrentAdmin() admin: AdminSession, @Param('id', uuid) id: string) {
    return this.mcp.changes(admin, id);
  }

  @Post('mcp-servers/:id/changes/approve')
  @HttpCode(200)
  @Roles('admin')
  approveChanges(
    @CurrentAdmin() admin: AdminSession,
    @Param('id', uuid) id: string,
    @Body({ schema: approveChangesSchema }) body: ApproveChangesInput,
    @Req() req: AdminRequest,
  ) {
    return this.mcp.approveChanges(admin, id, body, req);
  }

  @Post('mcp-servers/:id/disable')
  @HttpCode(200)
  @Roles('admin')
  disable(
    @CurrentAdmin() admin: AdminSession,
    @Param('id', uuid) id: string,
    @Req() req: AdminRequest,
  ) {
    return this.mcp.disable(admin, id, req);
  }

  @Delete('mcp-servers/:id')
  @HttpCode(204)
  @Roles('admin')
  async remove(
    @CurrentAdmin() admin: AdminSession,
    @Param('id', uuid) id: string,
    @Req() req: AdminRequest,
  ) {
    await this.mcp.remove(admin, id, req);
  }

  @Get('tool-registry/versions')
  versions(@CurrentAdmin() admin: AdminSession) {
    return this.mcp.registryVersions(admin);
  }

  @Get('tool-registry/versions/:version')
  registryVersion(@CurrentAdmin() admin: AdminSession, @Param('version', version) v: number) {
    return this.mcp.registryVersion(admin, v);
  }

  @Get('tool-registry/versions/:version/diff')
  registryDiff(
    @CurrentAdmin() admin: AdminSession,
    @Param('version', version) v: number,
    @Query({ schema: registryDiffQuerySchema }) q: { from?: number },
  ) {
    return this.mcp.registryDiff(admin, v, q.from);
  }
}
