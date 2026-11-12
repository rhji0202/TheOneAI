import { Global, Module } from '@nestjs/common';
import { BillingService } from './billing.service.js';

/** 사용량 · 비용 기록, 월 한도 확인 — API(작업 생성 · 재개)와 Worker(실행 · 기억 추출) 양쪽에서 쓴다 */
@Global()
@Module({
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
