import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import type { MemberRole } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { AdminTokenService } from './admin-token.service.js';
import { verifyPassword } from './password.js';

export const loginSchema = z.object({
  tenantSlug: z.string().trim().min(1).max(100),
  email: z.email().max(320),
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export interface AdminUserView {
  id: string;
  email: string;
  name: string;
  role: MemberRole;
  tenantId: string;
}

export interface LoginResponse {
  accessToken: string;
  expiresAt: string;
  user: AdminUserView;
}

const INVALID_LOGIN = '워크스페이스 · 이메일 · 비밀번호를 확인해 주세요';

/** POST /v1/admin/auth/login — 테넌트 slug 로 테넌트를 찾고(SECURITY DEFINER 함수) 그 범위에서 멤버를 확인한다. */
@Injectable()
export class AdminAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: AdminTokenService,
  ) {}

  async login(input: LoginInput): Promise<LoginResponse> {
    const [resolved] = await this.prisma.$queryRaw<Array<{ id: string | null }>>`
      SELECT app_resolve_tenant(${input.tenantSlug}) AS id`;
    const tenantId = resolved?.id ?? null;

    const user = tenantId
      ? await this.prisma.withTenant(tenantId, (tx) =>
          tx.user.findUnique({
            where: { tenantId_email: { tenantId, email: input.email.toLowerCase() } },
          }),
        )
      : null;
    // 계정이 없어도 같은 비용으로 비교한다 (응답 시간으로 계정 존재 여부가 드러나지 않게)
    const valid = await verifyPassword(input.password, user?.passwordHash);
    if (!tenantId || !user || !valid || user.disabledAt) {
      throw AppError.unauthenticated(INVALID_LOGIN);
    }

    await this.prisma.withTenant(tenantId, (tx) =>
      tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }),
    );
    const { token, expiresAt } = await this.tokens.issue({
      sub: user.id,
      tid: tenantId,
      role: user.role,
    });
    return {
      accessToken: token,
      expiresAt: expiresAt.toISOString(),
      user: { id: user.id, email: user.email, name: user.name, role: user.role, tenantId },
    };
  }
}
