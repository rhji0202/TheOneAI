import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import type { MemberRole, User } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { byWorkspaceOrder } from '../../workspaces/workspace-provisioning.js';
import { addVerified } from './admin-auth.guard.js';
import {
  type AdminTokenClaims,
  AdminTokenService,
  type VerifiedMembership,
} from './admin-token.service.js';
import { verifyPassword } from './password.js';

export const loginSchema = z.object({
  /** 없으면 비밀번호가 맞는 워크스페이스 중 기본 워크스페이스(없으면 이름 순 첫 번째)로 들어간다 */
  tenantSlug: z.string().trim().min(1).max(100).optional(),
  email: z.email().max(320),
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const switchSchema = z.strictObject({
  slug: z.string().trim().min(1).max(100),
  /** 이 로그인에서 아직 확인하지 않은 워크스페이스일 때 그 워크스페이스의 비밀번호 */
  password: z.string().min(1).max(200).optional(),
});
export type SwitchInput = z.infer<typeof switchSchema>;

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
  workspace: { slug: string; name: string };
}

interface Membership {
  tenantId: string;
  slug: string;
  name: string;
}

const INVALID_LOGIN = '이메일 · 비밀번호를 확인해 주세요';

/**
 * POST /v1/admin/auth/login · /auth/switch.
 * 같은 이메일이라도 워크스페이스마다 다른 계정이다. 로그인할 때 비밀번호가 맞은 워크스페이스만 토큰(ws)에 넣고,
 * 그 안에서만 비밀번호 없이 전환한다 — 다른 워크스페이스가 같은 이메일로 만든 계정으로 넘어가지 못하게.
 */
@Injectable()
export class AdminAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: AdminTokenService,
  ) {}

  async login(input: LoginInput): Promise<LoginResponse> {
    const memberships = await this.memberships(input.email);
    const checked = await Promise.all(
      memberships.map(async (m) => {
        const user = await this.memberByEmail(m.tenantId, input.email);
        return { m, user, ok: await verifyPassword(input.password, user?.passwordHash) };
      }),
    );
    // 계정이 없어도 같은 비용으로 비교한다 (응답 시간으로 계정 존재 여부가 드러나지 않게)
    if (!memberships.length) await verifyPassword(input.password, undefined);

    const verified = checked.filter(
      (c): c is typeof c & { user: User } => c.ok && !!c.user && !c.user.disabledAt,
    );
    const target = input.tenantSlug
      ? verified.find((c) => c.m.slug === input.tenantSlug)
      : verified[0];
    if (!target) throw AppError.unauthenticated(INVALID_LOGIN);

    return this.enter(
      target.m,
      target.user,
      verified.map((c) => ({ tid: c.m.tenantId, sub: c.user.id })),
    );
  }

  async switch(claims: AdminTokenClaims, input: SwitchInput): Promise<LoginResponse> {
    const [resolved] = await this.prisma.$queryRaw<Array<{ id: string | null }>>`
      SELECT app_resolve_tenant(${input.slug}) AS id`;
    const tenantId = resolved?.id;
    if (!tenantId) throw AppError.notFound();

    const known = claims.ws.find((v) => v.tid === tenantId);
    let user: User | null;
    if (known) {
      user = await this.prisma.withTenant(tenantId, (tx) =>
        tx.user.findUnique({ where: { id: known.sub } }),
      );
    } else {
      const me = await this.prisma.withTenant(claims.tid, (tx) =>
        tx.user.findUnique({ where: { id: claims.sub } }),
      );
      if (!me) throw AppError.unauthenticated();
      user = await this.memberByEmail(tenantId, me.email);
      if (user && !user.disabledAt) {
        // 401 이 아니라 403 — 지금 로그인은 그대로 유효하고 이 워크스페이스의 비밀번호만 다시 받는다
        if (!input.password) throw new AppError(403, 'WORKSPACE_PASSWORD_REQUIRED');
        if (!(await verifyPassword(input.password, user.passwordHash)))
          throw new AppError(403, 'WORKSPACE_PASSWORD_REQUIRED', '비밀번호가 맞지 않습니다');
      }
    }
    if (!user || user.disabledAt) throw AppError.notFound();

    const workspace = await this.prisma.withTenant(tenantId, (tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { slug: true, name: true } }),
    );
    return this.enter(
      { tenantId, ...workspace },
      user,
      addVerified(claims.ws, { tid: tenantId, sub: user.id }),
      new Date(claims.exp * 1_000),
    );
  }

  private async enter(
    m: Membership,
    user: User,
    verified: VerifiedMembership[],
    until?: Date,
  ): Promise<LoginResponse> {
    await this.prisma.withTenant(m.tenantId, (tx) =>
      tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }),
    );
    const { token, expiresAt } = await this.tokens.issue(
      { sub: user.id, tid: m.tenantId, role: user.role, ws: verified },
      until,
    );
    return {
      accessToken: token,
      expiresAt: expiresAt.toISOString(),
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        tenantId: m.tenantId,
      },
      workspace: { slug: m.slug, name: m.name },
    };
  }

  /** 이 이메일이 활성 멤버인 워크스페이스 (SECURITY DEFINER 함수) — 기본 먼저, 그다음 이름 순 */
  private async memberships(email: string): Promise<Membership[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{ tenant_id: string; slug: string; name: string }>
    >`
      SELECT tenant_id, slug, name FROM app_member_workspaces(${email})`;
    return rows
      .map((r) => ({ tenantId: r.tenant_id, slug: r.slug, name: r.name }))
      .sort(byWorkspaceOrder);
  }

  private memberByEmail(tenantId: string, email: string): Promise<User | null> {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.user.findUnique({ where: { tenantId_email: { tenantId, email: email.toLowerCase() } } }),
    );
  }
}
