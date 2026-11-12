import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { AdminAuthGuard, CurrentAdmin } from './admin-auth.guard.js';
import {
  AdminAuthService,
  type AdminUserView,
  type LoginInput,
  type LoginResponse,
  loginSchema,
} from './admin-auth.service.js';
import type { AdminSession } from './admin-session.js';

/**
 * docs/api-spec.md §1.2 — 로그인 · 현재 멤버.
 * refresh 쿠키 회전 · 로그아웃은 콘솔(Admin UI) 단계에서 추가한다. 지금은 access token(15분)만 발급한다.
 */
@Controller({ path: 'admin', version: '1' })
export class AdminAuthController {
  constructor(private readonly auth: AdminAuthService) {}

  @Post('auth/login')
  @HttpCode(200)
  login(@Body({ schema: loginSchema }) body: LoginInput): Promise<LoginResponse> {
    return this.auth.login(body);
  }

  @Get('me')
  @UseGuards(AdminAuthGuard)
  me(@CurrentAdmin() admin: AdminSession): AdminUserView {
    return {
      id: admin.userId,
      email: admin.email,
      name: admin.name,
      role: admin.role,
      tenantId: admin.tenantId,
    };
  }
}
