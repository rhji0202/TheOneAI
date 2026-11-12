import { Global, Module } from '@nestjs/common';
import { AuditModule } from './audit/audit.module.js';
import { AdminAuthController } from './auth/admin-auth.controller.js';
import { AdminAuthGuard } from './auth/admin-auth.guard.js';
import { AdminAuthService } from './auth/admin-auth.service.js';
import { AdminTokenService } from './auth/admin-token.service.js';

/** 콘솔 인증 · 역할 가드 · 감사 로그. 다른 Admin API 모듈이 가드와 감사 로그를 쓰므로 전역으로 내보낸다. */
@Global()
@Module({
  imports: [AuditModule],
  controllers: [AdminAuthController],
  providers: [AdminTokenService, AdminAuthService, AdminAuthGuard],
  exports: [AdminTokenService, AdminAuthGuard, AuditModule],
})
export class AdminCoreModule {}
