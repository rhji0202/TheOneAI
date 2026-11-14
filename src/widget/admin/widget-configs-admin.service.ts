import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../../admin/audit/audit.service.js';
import type { AdminRequest, AdminSession } from '../../admin/auth/admin-session.js';
import { AppError, type FieldIssue } from '../../common/errors/app-error.js';
import type { Prisma, WidgetConfig } from '../../generated/prisma/client.js';
import { PrismaService, type TenantTx } from '../../infrastructure/database/prisma.service.js';
import { normalizeOrigin } from '../origin.js';
import { contentKey, ObjectStorage } from '../../infrastructure/storage/object-storage.js';
import {
  behaviorSchema,
  MAX_STARTER_PROMPTS,
  type PublicTheme,
  publicTheme,
  themeSchema,
  widgetIconKey,
} from '../widget-bootstrap.service.js';

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
        /** 새 대화 화면에 보여 줄 제시어 — 누르면 그대로 보낸다 */
        starterPrompts: z
          .array(z.string().trim().min(1, '빈 제시어는 넣을 수 없습니다').max(100))
          .max(MAX_STARTER_PROMPTS),
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
  theme: PublicTheme;
  behavior: z.infer<typeof behaviorSchema>;
  updatedAt: string;
}

/** 위젯 설치 · 테마 (C-09). 설정은 bootstrap 이 매번 읽으므로 저장 즉시 위젯에 반영된다. */
@Injectable()
export class WidgetConfigsAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: ObjectStorage,
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

  /** 위젯 아이콘 올리기 — PNG · JPEG · WebP (내용으로 판별, SVG 는 받지 않는다), 256KB 이하 */
  async setIcon(
    admin: AdminSession,
    id: string,
    data: Buffer,
    req?: AdminRequest,
  ): Promise<WidgetConfigView> {
    const mimeType = iconMimeType(data);
    if (!mimeType) {
      throw new AppError(422, 'VALIDATION_FAILED', 'PNG · JPEG · WebP 이미지만 올릴 수 있어요', [
        { path: 'file', message: 'PNG · JPEG · WebP 이미지가 아닙니다' },
      ]);
    }
    const { sha256 } = contentKey('widget-icons', data);
    await this.storage.put(widgetIconKey(admin.tenantId, sha256), data);
    return this.replaceIcon(admin, id, { sha256, mimeType }, req);
  }

  /** 위젯 아이콘 지우기 — 기본 아이콘으로 돌아간다 (파일은 내용 주소라 그대로 둔다) */
  removeIcon(admin: AdminSession, id: string, req?: AdminRequest): Promise<WidgetConfigView> {
    return this.replaceIcon(admin, id, null, req);
  }

  private replaceIcon(
    admin: AdminSession,
    id: string,
    icon: { sha256: string; mimeType: string } | null,
    req?: AdminRequest,
  ): Promise<WidgetConfigView> {
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      const current = await this.find(tx, id);
      const updated = await tx.widgetConfig.update({
        where: { id },
        data: {
          theme: { ...themeSchema.parse(current.theme), icon } as Prisma.InputJsonValue,
        },
      });
      await this.audit.record(
        tx,
        admin,
        {
          action: 'widget_config.update',
          targetType: 'widget_config',
          targetId: id,
          metadata: { fields: ['theme.icon'], icon: icon?.sha256 ?? null },
        },
        req,
      );
      return this.toView(tx, updated);
    });
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
      theme: publicTheme(themeSchema.parse(w.theme), w.publicKey),
      behavior: behaviorSchema.parse(w.behavior),
      updatedAt: w.updatedAt.toISOString(),
    };
  }
}

/** 위젯 아이콘 최대 크기 */
export const MAX_ICON_BYTES = 256 * 1024;

/** 파일 앞부분(매직 바이트)으로 형식을 정한다 — 올린 사람이 붙인 형식은 믿지 않는다 */
function iconMimeType(data: Buffer): string | null {
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
    return 'image/jpeg';
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('latin1') === 'RIFF' &&
    data.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp';
  return null;
}
