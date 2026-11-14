import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { AdminAuthGuard, bearerToken, CurrentAdmin } from './admin-auth.guard.js';
import {
  AdminAuthService,
  type AdminUserView,
  type LoginInput,
  type LoginResponse,
  loginSchema,
  type SwitchInput,
  switchSchema,
} from './admin-auth.service.js';
import type { AdminRequest, AdminSession } from './admin-session.js';
import { AdminTokenService } from './admin-token.service.js';

/**
 * docs/api-spec.md §1.2 — 로그인 · 현재 멤버.
 * refresh 쿠키 회전 · 로그아웃은 콘솔(Admin UI) 단계에서 추가한다. 지금은 access token(15분)만 발급한다.
 */
@Controller({ path: 'admin', version: '1' })
export class AdminAuthController {
  constructor(
    private readonly auth: AdminAuthService,
    private readonly tokens: AdminTokenService,
  ) {}

  @Post('auth/login')
  @HttpCode(200)
  login(@Body({ schema: loginSchema }) body: LoginInput): Promise<LoginResponse> {
    return this.auth.login(body);
  }

  /** 가드를 쓰지 않는다 — 지금 워크스페이스가 지워졌어도 토큰의 확인된 워크스페이스로 옮겨 갈 수 있게 */
  @Post('auth/switch')
  @HttpCode(200)
  async switch(
    @Req() req: AdminRequest,
    @Body({ schema: switchSchema }) body: SwitchInput,
  ): Promise<LoginResponse> {
    return this.auth.switch(await this.tokens.verify(bearerToken(req)), body);
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
