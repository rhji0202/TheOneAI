import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AdminAuthGuard, CurrentAdmin, Roles } from '../admin/auth/admin-auth.guard.js';
import type { AdminRequest, AdminSession } from '../admin/auth/admin-session.js';
import {
  type InstallInput,
  installSchema,
  type ListingQuery,
  listingQuerySchema,
  MarketplaceService,
  type PublishMcpInput,
  publishMcpSchema,
  type PublishSkillInput,
  publishSkillSchema,
} from './marketplace.service.js';

const uuid = { schema: z.uuid() };

/** 마켓플레이스 (P2) — 조회는 Viewer, 게시 · 설치 · 철회는 Admin 이상 */
@Controller({ path: 'admin/marketplace', version: '1' })
@UseGuards(AdminAuthGuard)
export class MarketplaceController {
  constructor(private readonly marketplace: MarketplaceService) {}

  @Get('listings')
  list(
    @CurrentAdmin() admin: AdminSession,
    @Query({ schema: listingQuerySchema }) q: ListingQuery,
  ) {
    return this.marketplace.list(admin, q);
  }

  @Get('listings/:id')
  get(@CurrentAdmin() admin: AdminSession, @Param('id', uuid) id: string) {
    return this.marketplace.get(admin, id);
  }

  @Post('skills')
  @Roles('admin')
  publishSkill(
    @CurrentAdmin() admin: AdminSession,
    @Body({ schema: publishSkillSchema }) body: PublishSkillInput,
    @Req() req: AdminRequest,
  ) {
    return this.marketplace.publishSkill(admin, body, req);
  }

  @Post('mcp-servers')
  @Roles('admin')
  publishMcp(
    @CurrentAdmin() admin: AdminSession,
    @Body({ schema: publishMcpSchema }) body: PublishMcpInput,
    @Req() req: AdminRequest,
  ) {
    return this.marketplace.publishMcp(admin, body, req);
  }

  @Post('listings/:id/install')
  @HttpCode(200)
  @Roles('admin')
  install(
    @CurrentAdmin() admin: AdminSession,
    @Param('id', uuid) id: string,
    @Body({ schema: installSchema }) body: InstallInput,
    @Req() req: AdminRequest,
  ) {
    return this.marketplace.install(admin, id, body, req);
  }

  @Post('listings/:id/withdraw')
  @HttpCode(200)
  @Roles('admin')
  withdraw(
    @CurrentAdmin() admin: AdminSession,
    @Param('id', uuid) id: string,
    @Req() req: AdminRequest,
  ) {
    return this.marketplace.withdraw(admin, id, req);
  }
}
