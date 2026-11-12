import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../../admin/audit/audit.service.js';
import type { AdminRequest, AdminSession } from '../../admin/auth/admin-session.js';
import { AppError, type FieldIssue } from '../../common/errors/app-error.js';
import type { Prisma, WidgetConfig } from '../../generated/prisma/client.js';
import { PrismaService, type TenantTx } from '../../infrastructure/database/prisma.service.js';
import { SecretStore } from '../../infrastructure/secrets/secret-store.js';
import { normalizeOrigin } from '../origin.js';
import { behaviorSchema, themeSchema } from '../widget-bootstrap.service.js';

/** 허용 도메인 — 정확한 출처(https://shop.example.com) 또는 서브도메인 한 단계 와일드카드(https://*.example.com) */
const originSchema = z
  .string()
  .trim()
  .max(253)
  .refine(
    (v) =>
      /^(https?):\/\/\*\.[a-z0-9.-]+(:\d+)?$/i.test(v) ||
      normalizeOrigin(v) === v.replace(/\/$/, ''),
    {
      message: 'https://도메인 형식(경로 없이)이어야 합니다. 와일드카드는 https://*.example.com 만',
    },
  );

export const widgetConfigPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    agentId: z.uuid(),
    allowedOrigins: z.array(originSchema).max(50),
    identityMode: z.enum(['anonymous', 'signed_token']),
    enabled: z.boolean(),
    theme: z
      .object({
        brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, '#RRGGBB 형식이어야 합니다'),
        position: z.enum(['bottom-right', 'bottom-left']),
        darkMode: z.enum(['system', 'light', 'dark']),
      })
      .partial(),
    behavior: z
      .object({
        autoOpen: z.boolean(),
        language: z.string().regex(/^(auto|[a-z]{2}(-[A-Z]{2})?)$/),
        attachments: z.object({
          types: z.array(z.string().regex(/^[a-z]+\/([a-z0-9.+-]+|\*)$/i)).max(30),
          maxMb: z.number().int().min(1).max(50),
        }),
        noticeText: z.string().trim().max(200),
        showPoweredBy: z.boolean(),
      })
      .partial(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, '바꿀 값이 없습니다');
export type WidgetConfigPatch = z.infer<typeof widgetConfigPatchSchema>;

export interface WidgetConfigView {
  id: string;
  name: string;
  agentId: string;
  agentName: string;
  publicKey: string;
  allowedOrigins: string[];
  identityMode: WidgetConfig['identityMode'];
  enabled: boolean;
  theme: z.infer<typeof themeSchema>;
  behavior: z.infer<typeof behaviorSchema>;
  /** 재발급 뒤 이전 Secret 을 함께 받는 기한 */
  previousSecretExpiresAt: string | null;
  updatedAt: string;
}

const SECRET_GRACE_MS = 24 * 3_600_000;

/**
 * 위젯 설치 · 테마 (C-09). 설정은 bootstrap 이 매번 읽으므로 저장 즉시 위젯에 반영된다.
 * 서명 Secret 은 Secret 저장소에만 두고 재발급 응답에서 한 번만 보여 준다 (이전 Secret 은 24시간 함께 허용).
 */
@Injectable()
export class WidgetConfigsAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretStore,
    private readonly audit: AuditService,
  ) {}

  async list(admin: AdminSession): Promise<WidgetConfigView[]> {
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      const rows = await tx.widgetConfig.findMany({ orderBy: { createdAt: 'asc' } });
      return Promise.all(rows.map((w) => this.toView(tx, w)));
    });
  }

  async update(
    admin: AdminSession,
    id: string,
    patch: WidgetConfigPatch,
    req?: AdminRequest,
  ): Promise<WidgetConfigView> {
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      const current = await this.find(tx, id);
      const issues: FieldIssue[] = [];
      if (patch.agentId) {
        const agent = await tx.agent.findFirst({ where: { id: patch.agentId, archivedAt: null } });
        if (!agent) issues.push({ path: 'agentId', message: 'Agent 를 찾을 수 없습니다' });
      }
      if (issues.length) throw new AppError(422, 'VALIDATION_FAILED', undefined, issues);
      const data: Prisma.WidgetConfigUpdateInput = {};
      if (patch.name !== undefined) data.name = patch.name;
      if (patch.agentId) data.agent = { connect: { id: patch.agentId } };
      if (patch.allowedOrigins)
        data.allowedOrigins = [
          ...new Set(patch.allowedOrigins.map((o) => o.replace(/\/$/, '').toLowerCase())),
        ];
      if (patch.identityMode) data.identityMode = patch.identityMode;
      if (patch.enabled !== undefined) data.enabled = patch.enabled;
      if (patch.theme)
        data.theme = {
          ...themeSchema.parse(current.theme),
          ...patch.theme,
        } as Prisma.InputJsonValue;
      if (patch.behavior)
        data.behavior = {
          ...behaviorSchema.parse(current.behavior),
          ...patch.behavior,
        } as Prisma.InputJsonValue;
      const updated = await tx.widgetConfig.update({ where: { id }, data });
      await this.audit.record(
        tx,
        admin,
        {
          action: 'widget_config.update',
          targetType: 'widget_config',
          targetId: id,
          metadata: { fields: Object.keys(patch) },
        },
        req,
      );
      return this.toView(tx, updated);
    });
  }

  /** 서명 Secret 재발급 — 새 값은 이 응답에서만 보인다. 이전 값은 24시간 동안 함께 허용 (Owner) */
  async rotateSecret(admin: AdminSession, id: string, req?: AdminRequest) {
    const current = await this.prisma.withTenant(admin.tenantId, (tx) => this.find(tx, id));
    const secret = `ws_${randomBytes(32).toString('base64url')}`;
    const ref = `vault://widgets/${id}/${Date.now()}`;
    await this.secrets.put(ref, secret);
    const expiresAt = new Date(Date.now() + SECRET_GRACE_MS);
    const view = await this.prisma.withTenant(admin.tenantId, async (tx) => {
      const updated = await tx.widgetConfig.update({
        where: { id },
        data: {
          secretRef: ref,
          previousSecretRef: current.secretRef,
          previousSecretExpiresAt: expiresAt,
        },
      });
      await this.audit.record(
        tx,
        admin,
        { action: 'widget_config.rotate_secret', targetType: 'widget_config', targetId: id },
        req,
      );
      return this.toView(tx, updated);
    });
    return { widget: view, secret, previousSecretExpiresAt: expiresAt.toISOString() };
  }

  private async find(tx: TenantTx, id: string): Promise<WidgetConfig> {
    const widget = await tx.widgetConfig.findUnique({ where: { id } });
    if (!widget) throw AppError.notFound();
    return widget;
  }

  private async toView(tx: TenantTx, w: WidgetConfig): Promise<WidgetConfigView> {
    const agent = await tx.agent.findUnique({ where: { id: w.agentId }, select: { name: true } });
    return {
      id: w.id,
      name: w.name,
      agentId: w.agentId,
      agentName: agent?.name ?? '',
      publicKey: w.publicKey,
      allowedOrigins: w.allowedOrigins,
      identityMode: w.identityMode,
      enabled: w.enabled,
      theme: themeSchema.parse(w.theme),
      behavior: behaviorSchema.parse(w.behavior),
      previousSecretExpiresAt:
        w.previousSecretExpiresAt && w.previousSecretExpiresAt > new Date()
          ? w.previousSecretExpiresAt.toISOString()
          : null,
      updatedAt: w.updatedAt.toISOString(),
    };
  }
}
