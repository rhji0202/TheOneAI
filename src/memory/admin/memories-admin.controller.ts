import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AdminAuthGuard, CurrentAdmin, Roles } from '../../admin/auth/admin-auth.guard.js';
import type { AdminRequest, AdminSession } from '../../admin/auth/admin-session.js';
import {
  MemoriesAdminService,
  type MemoryListQuery,
  memoryListSchema,
  type MemoryPatch,
  memoryPatchSchema,
  type MemorySearchQuery,
  memorySearchSchema,
} from './memories-admin.service.js';

const uuid = { schema: z.uuid() };
const pinSchema = z.object({ pinned: z.boolean() });

/** docs/api-spec.md §4.8 — Memory (C-08). 조회는 Viewer, 변경은 Admin 이상 */
@Controller({ path: 'admin', version: '1' })
@UseGuards(AdminAuthGuard)
export class MemoriesAdminController {
  constructor(private readonly memories: MemoriesAdminService) {}

  @Get('memories/search')
  search(
    @CurrentAdmin() admin: AdminSession,
    @Query({ schema: memorySearchSchema }) q: MemorySearchQuery,
  ) {
    return this.memories.search(admin, q);
  }

  @Get('memories')
  list(
    @CurrentAdmin() admin: AdminSession,
    @Query({ schema: memoryListSchema }) q: MemoryListQuery,
  ) {
    return this.memories.list(admin, q);
  }

  @Get('memories/:id')
  get(@CurrentAdmin() admin: AdminSession, @Param('id', uuid) id: string) {
    return this.memories.get(admin, id);
  }

  @Patch('memories/:id')
  @Roles('admin')
  update(
    @CurrentAdmin() admin: AdminSession,
    @Param('id', uuid) id: string,
    @Body({ schema: memoryPatchSchema }) body: MemoryPatch,
    @Req() req: AdminRequest,
  ) {
    return this.memories.update(admin, id, body, req);
  }

  @Post('memories/:id/pin')
  @HttpCode(200)
  @Roles('admin')
  pin(
    @CurrentAdmin() admin: AdminSession,
    @Param('id', uuid) id: string,
    @Body({ schema: pinSchema }) body: { pinned: boolean },
    @Req() req: AdminRequest,
  ) {
    return this.memories.pin(admin, id, body.pinned, req);
  }

  @Post('memories/:id/release')
  @HttpCode(200)
  @Roles('admin')
  release(
    @CurrentAdmin() admin: AdminSession,
    @Param('id', uuid) id: string,
    @Req() req: AdminRequest,
  ) {
    return this.memories.release(admin, id, req);
  }

  @Delete('memories/:id')
  @HttpCode(204)
  @Roles('admin')
  async remove(
    @CurrentAdmin() admin: AdminSession,
    @Param('id', uuid) id: string,
    @Req() req: AdminRequest,
  ) {
    await this.memories.remove(admin, id, req);
  }

  /** 사용자 데이터 삭제 (기억 · 대화 · 작업) */
  @Post('end-users/:id/erase')
  @HttpCode(202)
  @Roles('admin')
  erase(
    @CurrentAdmin() admin: AdminSession,
    @Param('id', uuid) id: string,
    @Req() req: AdminRequest,
  ) {
    return this.memories.eraseEndUser(admin, id, req);
  }
}
