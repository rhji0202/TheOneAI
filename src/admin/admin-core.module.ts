import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit/audit.service.js';
import { AdminAuthController } from './auth/admin-auth.controller.js';
import { AdminAuthGuard } from './auth/admin-auth.guard.js';
import { AdminAuthService } from './auth/admin-auth.service.js';
import { AdminTokenService } from './auth/admin-token.service.js';

/** 콘솔 인증 · 역할 가드 · 감사 로그. 다른 Admin API 모듈이 가드와 감사 로그를 쓰므로 전역으로 내보낸다. */
@Global()
@Module({
  controllers: [AdminAuthController],
  providers: [AdminTokenService, AdminAuthService, AdminAuthGuard, AuditService],
  exports: [AdminTokenService, AdminAuthGuard, AuditService],
})
export class AdminCoreModule {}
