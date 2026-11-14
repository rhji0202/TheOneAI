import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '../../common/errors/app-error.js';
import type { MemberRole } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { type AdminRequest, type AdminSession, hasRole } from './admin-session.js';
import { AdminTokenService, type VerifiedMembership } from './admin-token.service.js';

const ROLE_KEY = 'admin:minRole';

/** 이 역할 이상만 호출할 수 있다 (지정하지 않으면 Viewer 이상) */
export const Roles = (role: MemberRole) => SetMetadata(ROLE_KEY, role);

/**
 * Authorization: Bearer <콘솔 access token>.
 * 토큰이 유효해도 매 요청 멤버 상태 · 역할을 DB 에서 다시 확인한다 (비활성화 · 역할 변경 즉시 반영).
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: AdminTokenService,
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AdminRequest>();
    const claims = await this.tokens.verify(bearerToken(req));

    const user = await this.prisma.withTenant(claims.tid, (tx) =>
      tx.user.findUnique({
        where: { id: claims.sub },
        select: { id: true, email: true, name: true, role: true, disabledAt: true },
      }),
    );
    if (!user || user.disabledAt) throw AppError.unauthenticated('사용할 수 없는 계정입니다');

    const required =
      this.reflector.getAllAndOverride<MemberRole | undefined>(ROLE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'viewer';
    if (!hasRole(user.role, required)) throw new AppError(403, 'FORBIDDEN');

    req.adminSession = {
      tenantId: claims.tid,
      userId: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      verified: addVerified(claims.ws, { tid: claims.tid, sub: claims.sub }),
      expiresAt: new Date(claims.exp * 1_000),
    };
    return true;
  }
}

export function bearerToken(req: AdminRequest): string {
  const auth = req.header('authorization');
  if (!auth?.startsWith('Bearer ')) throw AppError.unauthenticated();
  return auth.slice('Bearer '.length).trim();
}

/** 확인된 멤버십 목록에 m 을 더한다 (같은 워크스페이스는 하나만) */
export function addVerified(
  list: VerifiedMembership[],
  m: VerifiedMembership,
): VerifiedMembership[] {
  return [...list.filter((v) => v.tid !== m.tid), m];
}

export const CurrentAdmin = createParamDecorator(
  (_: unknown, context: ExecutionContext): AdminSession => {
    const session = context.switchToHttp().getRequest<AdminRequest>().adminSession;
    if (!session) throw AppError.unauthenticated();
    return session;
  },
);
