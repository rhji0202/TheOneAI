import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppError } from '../common/errors/app-error.js';
import type { IdentityMode } from '../generated/prisma/client.js';
import { PrismaService, type TenantTx } from '../infrastructure/database/prisma.service.js';
import { SecretStore } from '../infrastructure/secrets/secret-store.js';
import { ObjectStorage } from '../infrastructure/storage/object-storage.js';
import {
  ACTIVE_STATUSES,
  taskSummarySelect,
  toTaskSummary,
  type TaskSummaryView,
} from '../tasks/task-views.js';
import { IdentityTokenVerifier } from './identity-token.verifier.js';
import { isOriginAllowed, normalizeOrigin } from './origin.js';
import { SessionTokenService } from './session-token.service.js';

export const bootstrapSchema = z.object({
  publicKey: z.string().regex(/^wk_pub_[A-Za-z0-9_]{3,64}$/, '위젯 공개 키 형식이 아닙니다'),
  identityToken: z.string().min(1).max(4_096).optional(),
  anonymousId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{16,64}$/, '16~64자의 영문 · 숫자 · _ · - 만 사용할 수 있습니다')
    .optional(),
});
export type BootstrapInput = z.infer<typeof bootstrapSchema>;

export const themeSchema = z
  .object({
    brandColor: z.string().default('#4F46E5'),
    position: z.enum(['bottom-right', 'bottom-left']).default('bottom-right'),
    darkMode: z.enum(['system', 'light', 'dark']).default('system'),
    /** 콘솔에서 올린 위젯 아이콘 (위젯 헤더) — 저장소 키는 widget-icons/<tenant>/<sha256> */
    icon: z
      .object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), mimeType: z.string() })
      .nullable()
      .default(null),
  })
  .catch({ brandColor: '#4F46E5', position: 'bottom-right', darkMode: 'system', icon: null });

/** 위젯 · 콘솔에 주는 테마 — 아이콘은 공개 주소로 (내용 해시가 들어 있어 바뀌면 주소도 바뀐다) */
export function publicTheme(theme: z.infer<typeof themeSchema>, publicKey: string) {
  const { icon, ...rest } = theme;
  return { ...rest, iconUrl: icon ? `/v1/widget/icons/${publicKey}/${icon.sha256}` : null };
}
export type PublicTheme = ReturnType<typeof publicTheme>;

export const widgetIconKey = (tenantId: string, sha256: string) =>
  `widget-icons/${tenantId}/${sha256}`;

export const behaviorSchema = z
  .object({
    autoOpen: z.boolean().default(false),
    language: z.string().default('auto'),
    attachments: z
      .object({ types: z.array(z.string()).default([]), maxMb: z.number().default(20) })
      .prefault({}),
    noticeText: z.string().default('AI 응답은 부정확할 수 있어요'),
    showPoweredBy: z.boolean().default(true),
    /** 새 대화 화면의 제시어 (콘솔 위젯 설정 · C-09) */
    starterPrompts: z.array(z.string()).default([]),
  })
  .catch({
    autoOpen: false,
    language: 'auto',
    attachments: { types: [], maxMb: 20 },
    noticeText: 'AI 응답은 부정확할 수 있어요',
    showPoweredBy: true,
    starterPrompts: [],
  });

/** 위젯 하나에 둘 수 있는 제시어 수 */
export const MAX_STARTER_PROMPTS = 6;

const skillFrontmatter = z
  .object({ title: z.string().optional(), example_prompt: z.string().optional() })
  .passthrough()
  .catch({});

export interface WidgetBootstrapResponse {
  sessionToken: string;
  expiresAt: string;
  endUser: { id: string; anonymous: boolean };
  agent: { id: string; name: string; avatarUrl: string | null; welcomeMessage: string };
  theme: PublicTheme;
  behavior: z.infer<typeof behaviorSchema>;
  suggestions: Array<{ skillName: string; title: string; description: string; prompt: string }>;
  activeTasks: TaskSummaryView[];
}

interface ResolvedWidget {
  widget_id: string;
  tenant_id: string;
  agent_id: string;
  allowed_origins: string[];
  identity_mode: IdentityMode;
}

@Injectable()
export class WidgetBootstrapService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretStore,
    private readonly identity: IdentityTokenVerifier,
    private readonly sessions: SessionTokenService,
    private readonly storage: ObjectStorage,
  ) {}

  /**
   * 위젯 아이콘 (공개 — 방문자 페이지의 img 가 세션 없이 읽는다).
   * 지금 설정된 아이콘의 해시와 같을 때만 준다 (예전 아이콘 · 다른 테넌트의 파일은 404).
   */
  async icon(publicKey: string, sha256: string): Promise<{ data: Buffer; mimeType: string }> {
    const rows = await this.prisma.$queryRaw<ResolvedWidget[]>`
      SELECT widget_id, tenant_id, agent_id, allowed_origins, identity_mode
      FROM app_resolve_widget(${publicKey})`;
    const resolved = rows[0];
    if (!resolved) throw AppError.notFound();
    const widget = await this.prisma.withTenant(resolved.tenant_id, (tx) =>
      tx.widgetConfig.findUnique({ where: { id: resolved.widget_id }, select: { theme: true } }),
    );
    const icon = widget ? themeSchema.parse(widget.theme).icon : null;
    if (!icon || icon.sha256 !== sha256) throw AppError.notFound();
    const data = await this.storage.get(widgetIconKey(resolved.tenant_id, sha256));
    if (!data) throw AppError.notFound();
    return { data, mimeType: icon.mimeType };
  }

  async bootstrap(
    input: BootstrapInput,
    originHeader: string | undefined,
  ): Promise<WidgetBootstrapResponse> {
    // 1) 공개 키 → 테넌트 (테넌트 컨텍스트 전이므로 SECURITY DEFINER 함수로만 조회)
    const rows = await this.prisma.$queryRaw<ResolvedWidget[]>`
      SELECT widget_id, tenant_id, agent_id, allowed_origins, identity_mode
      FROM app_resolve_widget(${input.publicKey})`;
    const resolved = rows[0];
    if (!resolved) throw new AppError(403, 'WIDGET_DISABLED');

    // 2) Origin 검사
    const origin = originHeader ? normalizeOrigin(originHeader) : null;
    if (!origin || !isOriginAllowed(origin, resolved.allowed_origins)) {
      throw new AppError(403, 'ORIGIN_NOT_ALLOWED');
    }

    const { tenant_id: tenantId, widget_id: widgetId, agent_id: agentId } = resolved;

    // 3) 위젯 · Agent 배포 버전 · 추천 Skill
    const loaded = await this.prisma.withTenant(tenantId, (tx) =>
      this.loadWidget(tx, widgetId, agentId),
    );

    // 4) 사용자 식별
    const identity = await this.resolveIdentity(input, resolved.identity_mode, loaded.secretRefs);

    // 5) EndUser upsert + 진행 중 작업
    const { endUserId, activeTasks } = await this.prisma.withTenant(tenantId, async (tx) => {
      const endUser = await this.upsertEndUser(tx, tenantId, identity);
      const tasks = await tx.task.findMany({
        where: { endUserId: endUser.id, agentId, status: { in: ACTIVE_STATUSES } },
        select: taskSummarySelect,
        orderBy: { createdAt: 'desc' },
        take: 10,
      });
      return { endUserId: endUser.id, activeTasks: tasks.map(toTaskSummary) };
    });

    // 6) 세션 토큰
    const { token, expiresAt } = await this.sessions.issue({
      tenantId,
      widgetId,
      agentId,
      endUserId,
      anonymous: identity.kind === 'anonymous',
      origin,
    });

    return {
      sessionToken: token,
      expiresAt: expiresAt.toISOString(),
      endUser: { id: endUserId, anonymous: identity.kind === 'anonymous' },
      agent: loaded.agent,
      theme: loaded.theme,
      behavior: loaded.behavior,
      suggestions: loaded.suggestions,
      activeTasks,
    };
  }

  private async loadWidget(tx: TenantTx, widgetId: string, agentId: string) {
    const widget = await tx.widgetConfig.findUnique({ where: { id: widgetId } });
    if (!widget || !widget.enabled) throw new AppError(403, 'WIDGET_DISABLED');

    const agent = await tx.agent.findUnique({
      where: { id: agentId },
      include: {
        publishedVersion: {
          include: {
            skills: {
              where: { enabled: true, skill: { status: 'active', deletedAt: null } },
              include: { skill: { include: { activeVersion: true } } },
            },
          },
        },
      },
    });
    const version = agent?.publishedVersion;
    if (!agent || !version || agent.archivedAt) throw new AppError(503, 'AGENT_NOT_PUBLISHED');

    const secretRefs = [widget.secretRef];
    if (
      widget.previousSecretRef &&
      widget.previousSecretExpiresAt &&
      widget.previousSecretExpiresAt > new Date()
    ) {
      secretRefs.push(widget.previousSecretRef);
    }

    const suggestions = version.skills.flatMap(({ skill }) => {
      const active = skill.activeVersion;
      if (!active) return [];
      const fm = skillFrontmatter.parse(active.frontmatter);
      return [
        {
          skillName: skill.name,
          title: fm.title ?? skill.name,
          description: active.description,
          prompt: fm.example_prompt ?? '',
        },
      ];
    });

    return {
      secretRefs,
      agent: {
        id: agent.id,
        name: agent.name,
        avatarUrl: agent.avatarUrl,
        welcomeMessage: version.welcomeMessage,
      },
      theme: publicTheme(themeSchema.parse(widget.theme), widget.publicKey),
      behavior: behaviorSchema.parse(widget.behavior),
      suggestions,
    };
  }

  private async resolveIdentity(
    input: BootstrapInput,
    mode: IdentityMode,
    secretRefs: string[],
  ): Promise<
    | { kind: 'signed'; externalId: string; locale?: string }
    | { kind: 'anonymous'; anonymousId: string }
  > {
    if (mode === 'anonymous') {
      if (!input.anonymousId) {
        throw new AppError(400, 'VALIDATION_FAILED', '익명 위젯은 anonymousId 가 필요합니다', [
          { path: 'anonymousId', message: '필수 값입니다' },
        ]);
      }
      return { kind: 'anonymous', anonymousId: input.anonymousId };
    }

    if (!input.identityToken) throw new AppError(401, 'IDENTITY_TOKEN_REQUIRED');
    const secrets = (await Promise.all(secretRefs.map((ref) => this.secrets.get(ref)))).filter(
      (s): s is string => typeof s === 'string' && s.length > 0,
    );
    if (secrets.length === 0)
      throw new AppError(500, 'INTERNAL_ERROR', '위젯 Secret 을 찾을 수 없습니다');
    const claims = await this.identity.verify(input.identityToken, {
      audience: input.publicKey,
      secrets,
    });
    return { kind: 'signed', externalId: claims.sub, locale: claims.locale };
  }

  private async upsertEndUser(
    tx: TenantTx,
    tenantId: string,
    identity:
      | { kind: 'signed'; externalId: string; locale?: string }
      | { kind: 'anonymous'; anonymousId: string },
  ) {
    const now = new Date();
    const pseudonym = `user_${randomBytes(4).toString('hex')}`;
    if (identity.kind === 'signed') {
      return tx.endUser.upsert({
        where: { tenantId_externalId: { tenantId, externalId: identity.externalId } },
        create: {
          tenantId,
          externalId: identity.externalId,
          pseudonym,
          locale: identity.locale,
          lastSeenAt: now,
        },
        update: { lastSeenAt: now, ...(identity.locale ? { locale: identity.locale } : {}) },
      });
    }
    return tx.endUser.upsert({
      where: { tenantId_anonymousId: { tenantId, anonymousId: identity.anonymousId } },
      create: { tenantId, anonymousId: identity.anonymousId, pseudonym, lastSeenAt: now },
      update: { lastSeenAt: now },
    });
  }
}
