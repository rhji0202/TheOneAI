import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../../admin/audit/audit.service.js';
import type { AdminRequest, AdminSession } from '../../admin/auth/admin-session.js';
import { AppError } from '../../common/errors/app-error.js';
import { uuidv7 } from '../../common/uuid.js';
import type {
  PermissionLevel,
  Prisma,
  ToolPolicy,
  ToolPolicyRule,
} from '../../generated/prisma/client.js';
import { PrismaService, type TenantTx } from '../../infrastructure/database/prisma.service.js';
import { ruleConditionSchema } from '../../tools/rule-condition.js';
import { TOOL_NAME_PATTERN } from '../../tools/tool-names.js';
import {
  ALWAYS_ASK_LEVELS,
  DEFAULT_MODES,
  DEFAULT_TTL_SECONDS,
} from '../../tools/tool-permission.service.js';

const levelSchema = z.enum(['read', 'write', 'external_send', 'delete', 'financial']);

/** docs/api-spec.md §4.7 ToolPolicyInput */
export const toolPolicyInputSchema = z.object({
  level: levelSchema,
  mode: z.enum(['auto', 'require_approval', 'always_approval', 'block']),
  approver: z.enum(['user', 'operator', 'user_and_operator']).nullable().optional(),
  allowTaskScope: z.boolean().default(false),
  ttlSeconds: z.number().int().min(60).max(86_400).default(DEFAULT_TTL_SECONDS),
});
export const toolPoliciesPutSchema = z.object({
  policies: z
    .array(toolPolicyInputSchema)
    .max(5)
    .refine((list) => new Set(list.map((p) => p.level)).size === list.length, {
      message: '등급이 중복되었습니다',
    }),
});
export type ToolPoliciesPut = z.infer<typeof toolPoliciesPutSchema>;

/** 규칙 대상 Tool 패턴 — 정확한 이름 또는 접두사 와일드카드 (google-drive.*) */
const toolPatternSchema = z
  .string()
  .trim()
  .max(200)
  .refine((p) => TOOL_NAME_PATTERN.test(p.endsWith('.*') ? `${p.slice(0, -2)}.x` : p), {
    message: 'Tool 이름 또는 server.* 형식이어야 합니다',
  });

/** docs/api-spec.md §4.7 ToolPolicyRuleInput */
export const toolPolicyRuleInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(500).nullable().optional(),
    toolPattern: toolPatternSchema.nullable().optional(),
    level: levelSchema.nullable().optional(),
    condition: ruleConditionSchema,
    effect: z.enum(['require_operator', 'block']),
    priority: z.number().int().min(0).max(10_000).default(100),
    enabled: z.boolean().default(true),
  })
  .refine((r) => r.toolPattern || r.level, {
    message: 'toolPattern 또는 level 중 하나는 있어야 합니다',
  });
export type ToolPolicyRuleInput = z.infer<typeof toolPolicyRuleInputSchema>;

export const toolPolicyRulePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(500).nullable(),
    toolPattern: toolPatternSchema.nullable(),
    level: levelSchema.nullable(),
    condition: ruleConditionSchema,
    effect: z.enum(['require_operator', 'block']),
    priority: z.number().int().min(0).max(10_000),
    enabled: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, '바꿀 값이 없습니다');
export type ToolPolicyRulePatch = z.infer<typeof toolPolicyRulePatchSchema>;

export interface ToolPolicyView {
  level: PermissionLevel;
  mode: ToolPolicy['mode'];
  approver: ToolPolicy['approver'];
  allowTaskScope: boolean;
  ttlSeconds: number;
  /** 테넌트가 정하지 않아 기본값을 쓰는 중 */
  isDefault: boolean;
  updatedAt: string | null;
}

export interface ToolPolicyRuleView {
  id: string;
  name: string;
  description: string | null;
  toolPattern: string | null;
  level: PermissionLevel | null;
  condition: unknown;
  effect: ToolPolicyRule['effect'];
  priority: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

const LEVELS = Object.keys(DEFAULT_MODES) as PermissionLevel[];

/**
 * 권한 정책 (C-07) — 등급별 기본 정책과 조건 규칙.
 * 바뀐 정책은 실행 중 작업에도 바로 읽히지만, 작업은 시작 때 정책과 비교해 엄격한 쪽을 쓰므로
 * 강화만 즉시 적용되고 완화는 새 작업부터 적용된다 (ToolPermissionService.forTask).
 */
@Injectable()
export class ToolPoliciesAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async policies(admin: AdminSession): Promise<ToolPolicyView[]> {
    return this.prisma.withTenant(admin.tenantId, (tx) => this.readPolicies(tx));
  }

  /** 전체 교체 — 빠진 등급은 기본값으로 돌아간다. delete · financial · always_approval 은 task 범위 승인 불가 */
  async replacePolicies(
    admin: AdminSession,
    input: ToolPoliciesPut,
    req?: AdminRequest,
  ): Promise<ToolPolicyView[]> {
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      const before = await this.readPolicies(tx);
      const given = new Set(input.policies.map((p) => p.level));
      await tx.toolPolicy.deleteMany({ where: { level: { notIn: [...given] } } });
      for (const p of input.policies) {
        const data = {
          mode: p.mode,
          approver:
            p.mode === 'require_approval' || p.mode === 'always_approval'
              ? (p.approver ?? null)
              : null,
          allowTaskScope:
            p.allowTaskScope &&
            p.mode !== 'always_approval' &&
            !ALWAYS_ASK_LEVELS.includes(p.level),
          ttlSeconds: p.ttlSeconds,
          updatedById: admin.userId,
        };
        await tx.toolPolicy.upsert({
          where: { tenantId_level: { tenantId: admin.tenantId, level: p.level } },
          create: { id: uuidv7(), tenantId: admin.tenantId, level: p.level, ...data },
          update: data,
        });
      }
      const after = await this.readPolicies(tx);
      await this.audit.record(
        tx,
        admin,
        {
          action: 'tool_policy.update',
          targetType: 'tool_policy',
          targetId: null,
          metadata: {
            before: before.filter((p) => !p.isDefault).map(compact),
            after: after.filter((p) => !p.isDefault).map(compact),
          },
        },
        req,
      );
      return after;
    });
  }

  async rules(admin: AdminSession): Promise<ToolPolicyRuleView[]> {
    return this.prisma.withTenant(admin.tenantId, async (tx) =>
      (
        await tx.toolPolicyRule.findMany({ orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] })
      ).map(toRuleView),
    );
  }

  async createRule(
    admin: AdminSession,
    input: ToolPolicyRuleInput,
    req?: AdminRequest,
  ): Promise<ToolPolicyRuleView> {
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      const rule = await tx.toolPolicyRule.create({
        data: {
          id: uuidv7(),
          tenantId: admin.tenantId,
          name: input.name,
          description: input.description ?? null,
          toolPattern: input.toolPattern ?? null,
          level: input.level ?? null,
          condition: input.condition as Prisma.InputJsonValue,
          effect: input.effect,
          priority: input.priority,
          enabled: input.enabled,
          createdById: admin.userId,
        },
      });
      await this.audit.record(
        tx,
        admin,
        {
          action: 'tool_policy_rule.create',
          targetType: 'tool_policy_rule',
          targetId: rule.id,
          metadata: { name: rule.name, effect: rule.effect },
        },
        req,
      );
      return toRuleView(rule);
    });
  }

  async updateRule(
    admin: AdminSession,
    id: string,
    patch: ToolPolicyRulePatch,
    req?: AdminRequest,
  ): Promise<ToolPolicyRuleView> {
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      const current = await tx.toolPolicyRule.findUnique({ where: { id } });
      if (!current) throw AppError.notFound();
      const toolPattern = patch.toolPattern !== undefined ? patch.toolPattern : current.toolPattern;
      const level = patch.level !== undefined ? patch.level : current.level;
      if (!toolPattern && !level) {
        throw new AppError(422, 'VALIDATION_FAILED', undefined, [
          { path: 'toolPattern', message: 'toolPattern 또는 level 중 하나는 있어야 합니다' },
        ]);
      }
      const { condition, ...fields } = patch;
      const rule = await tx.toolPolicyRule.update({
        where: { id },
        data: {
          ...fields,
          ...(condition ? { condition: condition as Prisma.InputJsonValue } : {}),
        },
      });
      await this.audit.record(
        tx,
        admin,
        {
          action: 'tool_policy_rule.update',
          targetType: 'tool_policy_rule',
          targetId: id,
          metadata: { fields: Object.keys(patch) },
        },
        req,
      );
      return toRuleView(rule);
    });
  }

  async deleteRule(admin: AdminSession, id: string, req?: AdminRequest): Promise<void> {
    await this.prisma.withTenant(admin.tenantId, async (tx) => {
      const rule = await tx.toolPolicyRule.findUnique({ where: { id } });
      if (!rule) throw AppError.notFound();
      await tx.toolPolicyRule.delete({ where: { id } });
      await this.audit.record(
        tx,
        admin,
        {
          action: 'tool_policy_rule.delete',
          targetType: 'tool_policy_rule',
          targetId: id,
          metadata: { name: rule.name },
        },
        req,
      );
    });
  }

  private async readPolicies(tx: TenantTx): Promise<ToolPolicyView[]> {
    const rows = await tx.toolPolicy.findMany();
    return LEVELS.map((level) => {
      const row = rows.find((r) => r.level === level);
      return row
        ? {
            level,
            mode: row.mode,
            approver: row.approver,
            allowTaskScope: row.allowTaskScope,
            ttlSeconds: row.ttlSeconds,
            isDefault: false,
            updatedAt: row.updatedAt.toISOString(),
          }
        : {
            level,
            mode: DEFAULT_MODES[level],
            approver: null,
            allowTaskScope: false,
            ttlSeconds: DEFAULT_TTL_SECONDS,
            isDefault: true,
            updatedAt: null,
          };
    });
  }
}

function compact(p: ToolPolicyView) {
  return {
    level: p.level,
    mode: p.mode,
    approver: p.approver,
    allowTaskScope: p.allowTaskScope,
    ttlSeconds: p.ttlSeconds,
  };
}

function toRuleView(r: ToolPolicyRule): ToolPolicyRuleView {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    toolPattern: r.toolPattern,
    level: r.level,
    condition: r.condition,
    effect: r.effect,
    priority: r.priority,
    enabled: r.enabled,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
