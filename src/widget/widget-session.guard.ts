import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { AppError } from '../common/errors/app-error.js';
import { normalizeOrigin } from './origin.js';
import { SessionTokenService } from './session-token.service.js';
import type { WidgetRequest, WidgetSession } from './widget-session.js';

/** Authorization: Bearer <위젯 세션 토큰> 검증. bootstrap 때의 Origin 과 다른 Origin 에서 온 요청은 거부한다. */
@Injectable()
export class WidgetSessionGuard implements CanActivate {
  constructor(private readonly tokens: SessionTokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<WidgetRequest>();
    const auth = req.header('authorization');
    if (!auth?.startsWith('Bearer ')) throw AppError.unauthenticated();

    const session = await this.tokens.verify(auth.slice('Bearer '.length).trim());
    const origin = req.header('origin');
    if (origin && session.origin && normalizeOrigin(origin) !== session.origin) {
      throw new AppError(403, 'ORIGIN_NOT_ALLOWED');
    }
    req.widgetSession = session;
    return true;
  }
}

export const CurrentSession = createParamDecorator(
  (_: unknown, context: ExecutionContext): WidgetSession => {
    const session = context.switchToHttp().getRequest<WidgetRequest>().widgetSession;
    if (!session) throw AppError.unauthenticated();
    return session;
  },
);
