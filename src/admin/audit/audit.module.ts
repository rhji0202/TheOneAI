import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service.js';

/** 감사 로그 — 콘솔 API 와 Worker(승인 만료 등 시스템 처리) 양쪽에서 쓴다 */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
