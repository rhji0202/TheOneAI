import { Global, Module } from '@nestjs/common';
import { IdentityTokenVerifier } from './identity-token.verifier.js';
import { SessionTokenService } from './session-token.service.js';
import { WidgetBootstrapService } from './widget-bootstrap.service.js';
import { WidgetController } from './widget.controller.js';
import { WidgetSessionGuard } from './widget-session.guard.js';

/** 세션 토큰 서비스 · 가드는 다른 Widget API 모듈(대화 · 작업)에서도 쓰므로 전역으로 내보낸다. */
@Global()
@Module({
  controllers: [WidgetController],
  providers: [
    WidgetBootstrapService,
    IdentityTokenVerifier,
    SessionTokenService,
    WidgetSessionGuard,
  ],
  exports: [SessionTokenService, WidgetSessionGuard],
})
export class WidgetModule {}
