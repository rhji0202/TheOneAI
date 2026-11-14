import { randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../../admin/audit/audit.service.js';
import { addVerified } from '../../admin/auth/admin-auth.guard.js';
import type { LoginResponse } from '../../admin/auth/admin-auth.service.js';
import type { AdminRequest, AdminSession } from '../../admin/auth/admin-session.js';
import { AdminTokenService } from '../../admin/auth/admin-token.service.js';
import { AppError } from '../../common/errors/app-error.js';
import { isUniqueViolation } from '../../common/errors/prisma-errors.js';
import { uuidv7 } from '../../common/uuid.js';
import type { MemberRole, Tenant } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import {
  byWorkspaceOrder,
  DEFAULT_WORKSPACE_SLUG,
  provisionWorkspace,
  workspaceNameSchema,
  workspaceSlugSchema,
} from '../workspace-provisioning.js';

export const workspaceRenameSchema = z.strictObject({ name: workspaceNameSchema });
export type WorkspaceRename = z.infer<typeof workspaceRenameSchema>;

export const workspaceCreateSchema = z.strictObject({
  slug: workspaceSlugSchema,
  name: workspaceNameSchema,
});
export type WorkspaceCreate = z.infer<typeof workspaceCreateSchema>;

export const workspaceDeleteSchema = z.strictObject({ confirmSlug: z.string().trim() });
export type WorkspaceDelete = z.infer<typeof workspaceDeleteSchema>;

export interface WorkspaceView {
  id: string;
  slug: string;
  name: string;
  plan: string;
  isDefault: boolean;
  createdAt: string;
}

export interface MemberWorkspaceView {
  slug: string;
  name: string;
  role: MemberRole;
  isDefault: boolean;
  current: boolean;
  /** 이 로그인에서 비밀번호를 확인해 비밀번호 없이 전환할 수 있는가 */
  switchable: boolean;
}

export type CreatedWorkspace = LoginResponse & { slug: string };

/**
 * 워크스페이스(테넌트) 관리. slug 는 만든 뒤 바꿀 수 없다 — default 는 늘 기본 워크스페이스로 남는다.
 * 다른 워크스페이스로의 전환은 POST /admin/auth/switch (admin-auth.service.ts).
 */
@Injectable()
export class WorkspacesAdminService {
  private readonly logger = new Logger(WorkspacesAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: AdminTokenService,
    private readonly audit: AuditService,
  ) {}

  async current(admin: AdminSession): Promise<WorkspaceView> {
    const tenant = await this.prisma.withTenant(admin.tenantId, (tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: admin.tenantId } }),
    );
    return toView(tenant);
  }

  async rename(
    admin: AdminSession,
    input: WorkspaceRename,
    req?: AdminRequest,
  ): Promise<WorkspaceView> {
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      const tenant = await tx.tenant.update({
        where: { id: admin.tenantId },
        data: { name: input.name },
      });
      await this.audit.record(
        tx,
        admin,
        { action: 'workspace.rename', targetType: 'tenant', targetId: tenant.id },
        req,
      );
      return toView(tenant);
    });
  }

  /** 이 이메일이 활성 멤버인 워크스페이스 — 기본 워크스페이스 먼저, 그다음 이름 순 */
  async listForMember(admin: AdminSession): Promise<MemberWorkspaceView[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{ tenant_id: string; slug: string; name: string; role: MemberRole }>
    >`SELECT tenant_id, slug, name, role FROM app_member_workspaces(${admin.email})`;
    return rows
      .map((r) => ({
        slug: r.slug,
        name: r.name,
        role: r.role,
        isDefault: r.slug === DEFAULT_WORKSPACE_SLUG,
        current: r.tenant_id === admin.tenantId,
        switchable: admin.verified.some((v) => v.tid === r.tenant_id),
      }))
      .sort(byWorkspaceOrder);
  }

  /** 새 워크스페이스를 만들고 호출한 멤버를 그곳의 Owner 로 넣는다. 응답은 새 워크스페이스의 로그인 결과. */
  async create(
    admin: AdminSession,
    input: WorkspaceCreate,
    req?: AdminRequest,
  ): Promise<CreatedWorkspace> {
    const [taken] = await this.prisma.$queryRaw<Array<{ id: string | null }>>`
      SELECT app_resolve_tenant(${input.slug}) AS id`;
    if (taken?.id) throw new AppError(409, 'WORKSPACE_SLUG_TAKEN');

    const creator = await this.prisma.withTenant(admin.tenantId, (tx) =>
      tx.user.findUniqueOrThrow({
        where: { id: admin.userId },
        select: { email: true, name: true, passwordHash: true },
      }),
    );
    const tenantId = uuidv7();
    let owner: { id: string };
    try {
      owner = await this.prisma.withTenant(tenantId, async (tx) => {
        await provisionWorkspace(tx, {
          tenantId,
          slug: input.slug,
          name: input.name,
          widget: {
            publicKey: `wk_pub_${randomBytes(12).toString('base64url')}`,
            secretRef: `vault://widgets/${input.slug}`,
            allowedOrigins: [],
          },
        });
        const user = await tx.user.create({
          data: { tenantId, ...creator, role: 'owner' },
          select: { id: true },
        });
        await this.audit.record(
          tx,
          { ...admin, tenantId, userId: user.id, role: 'owner' },
          {
            action: 'workspace.create',
            targetType: 'tenant',
            targetId: tenantId,
            metadata: { fromTenantId: admin.tenantId },
          },
          req,
        );
        return user;
      });
    } catch (err) {
      if (isUniqueViolation(err, 'slug')) throw new AppError(409, 'WORKSPACE_SLUG_TAKEN');
      throw err;
    }

    const { token, expiresAt } = await this.tokens.issue(
      {
        sub: owner.id,
        tid: tenantId,
        role: 'owner',
        ws: addVerified(admin.verified, { tid: tenantId, sub: owner.id }),
      },
      admin.expiresAt,
    );
    return {
      accessToken: token,
      expiresAt: expiresAt.toISOString(),
      user: { id: owner.id, email: creator.email, name: creator.name, role: 'owner', tenantId },
      workspace: { slug: input.slug, name: input.name },
      slug: input.slug,
    };
  }

  /** 워크스페이스와 그 안의 모든 데이터를 지운다 (외래 키 CASCADE). 감사 로그도 함께 지워지므로 서버 로그에 남긴다. */
  async remove(admin: AdminSession, input: WorkspaceDelete): Promise<void> {
    const tenant = await this.prisma.withTenant(admin.tenantId, async (tx) => {
      const found = await tx.tenant.findUniqueOrThrow({ where: { id: admin.tenantId } });
      if (found.slug === DEFAULT_WORKSPACE_SLUG)
        throw new AppError(409, 'DEFAULT_WORKSPACE_PROTECTED');
      if (input.confirmSlug !== found.slug)
        throw new AppError(400, 'VALIDATION_FAILED', undefined, [
          { path: 'confirmSlug', message: '워크스페이스 주소가 일치하지 않습니다' },
        ]);
      return tx.tenant.delete({ where: { id: found.id } });
    });
    this.logger.log(`워크스페이스 삭제: ${tenant.slug} (${tenant.id}) — 멤버 ${admin.userId}`);
  }
}

function toView(t: Tenant): WorkspaceView {
  return {
    id: t.id,
    slug: t.slug,
    name: t.name,
    plan: t.plan,
    isDefault: t.slug === DEFAULT_WORKSPACE_SLUG,
    createdAt: t.createdAt.toISOString(),
  };
}
