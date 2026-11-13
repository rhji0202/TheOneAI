import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../../admin/audit/audit.service.js';
import type { AdminRequest, AdminSession } from '../../admin/auth/admin-session.js';
import { AppError, type FieldIssue } from '../../common/errors/app-error.js';
import type { AgentVersion, Prisma } from '../../generated/prisma/client.js';
import { PrismaService, type TenantTx } from '../../infrastructure/database/prisma.service.js';
import {
  type ExecutionPolicy,
  executionPolicySchema,
  type MemoryPolicy,
  memoryPolicySchema,
} from '../agent-policies.js';

/**
 * 초안 편집 (C-03) — 지침 · 환영 메시지 · 역할별 모델 · 실행 정책 · Memory 정책 · Tool(MCP) · Skill 허용 목록.
 * 정책은 바꿀 항목만 보내면 지금 값과 합쳐 검증한다. 모르는 필드는 조용히 무시하지 않고 거부한다.
 */
const allowEntry = z.object({ id: z.uuid(), enabled: z.boolean() });
const modelEntry = z.object({
  role: z.enum(['planner', 'executor', 'evaluator']),
  providerId: z.uuid(),
  model: z.string().trim().min(1).max(200),
  maxOutputTokens: z.number().int().min(64).max(64_000),
  temperature: z.number().min(0).max(2).default(0),
  reasoningEffort: z.enum(['off', 'low', 'medium', 'high', 'max']).nullable().optional(),
  fallbackProviderId: z.uuid().nullable().optional(),
  fallbackModel: z.string().trim().min(1).max(200).nullable().optional(),
});
export const draftInputSchema = z
  .object({
    systemPrompt: z.string().max(20_000).optional(),
    welcomeMessage: z.string().trim().max(500).optional(),
    models: z.array(modelEntry).min(1).max(3).optional(),
    executionPolicy: z.record(z.string(), z.unknown()).optional(),
    memoryPolicy: z.record(z.string(), z.unknown()).optional(),
    mcpServers: z.array(allowEntry).max(100).optional(),
    skills: z.array(allowEntry).max(100).optional(),
    changeNote: z.string().trim().max(500).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), '바꿀 값이 없습니다');
export type DraftInput = z.infer<typeof draftInputSchema>;

export const publishInputSchema = z.object({ changeNote: z.string().trim().max(500).optional() });
export type PublishInput = z.infer<typeof publishInputSchema>;

export interface AgentModelView {
  role: 'planner' | 'executor' | 'evaluator';
  providerId: string;
  providerName: string;
  model: string;
  maxOutputTokens: number;
  temperature: number;
  reasoningEffort: string | null;
  fallbackProviderId: string | null;
  fallbackModel: string | null;
}

export interface AgentVersionView {
  id: string;
  version: number;
  status: AgentVersion['status'];
  publishedAt: string | null;
  changeNote: string | null;
  welcomeMessage: string;
  systemPrompt: string;
  executionPolicy: ExecutionPolicy;
  memoryPolicy: MemoryPolicy;
  models: AgentModelView[];
  mcpServers: Array<{ id: string; name: string; status: string; enabled: boolean }>;
  skills: Array<{ id: string; name: string; status: string; enabled: boolean }>;
  updatedAt: string;
}

export interface AgentAdminView {
  id: string;
  name: string;
  published: AgentVersionView | null;
  draft: AgentVersionView | null;
}

/**
 * Agent 초안 · 배포 (C-03 중 MCP 허용 목록). 배포된 버전은 바꾸지 않는다 —
 * 초안(배포 버전 복사본)을 고쳐 새 버전으로 배포하고, 실행 중 작업은 시작 당시 버전을 유지한다.
 */
/** 콘솔 Agent 목록 한 줄 — 초안이 있으면 배포 안 된 변경이 있다 */
export interface AgentListRow {
  id: string;
  name: string;
  publishedVersion: number | null;
  publishedAt: string | null;
  draftVersion: number | null;
  draftUpdatedAt: string | null;
}

@Injectable()
export class AgentsAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(admin: AdminSession): Promise<AgentListRow[]> {
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      const agents = await tx.agent.findMany({
        where: { archivedAt: null },
        include: { publishedVersion: { select: { version: true, publishedAt: true } } },
        orderBy: { name: 'asc' },
      });
      const drafts = await tx.agentVersion.findMany({
        where: { status: 'draft', agentId: { in: agents.map((a) => a.id) } },
        select: { agentId: true, version: true, updatedAt: true },
      });
      const draftOf = new Map(drafts.map((d) => [d.agentId, d]));
      return agents.map((a) => {
        const draft = draftOf.get(a.id);
        return {
          id: a.id,
          name: a.name,
          publishedVersion: a.publishedVersion?.version ?? null,
          publishedAt: a.publishedVersion?.publishedAt?.toISOString() ?? null,
          draftVersion: draft?.version ?? null,
          draftUpdatedAt: draft?.updatedAt.toISOString() ?? null,
        };
      });
    });
  }

  async get(admin: AdminSession, agentId: string): Promise<AgentAdminView> {
    return this.prisma.withTenant(admin.tenantId, (tx) => this.view(tx, agentId));
  }

  async updateDraft(
    admin: AdminSession,
    agentId: string,
    input: DraftInput,
    req?: AdminRequest,
  ): Promise<AgentAdminView> {
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      const draft = await this.draftFor(tx, admin, agentId);
      const issues: FieldIssue[] = [];
      const data: Prisma.AgentVersionUpdateInput = {};
      if (input.systemPrompt !== undefined) data.systemPrompt = input.systemPrompt;
      if (input.welcomeMessage !== undefined) data.welcomeMessage = input.welcomeMessage;
      if (input.changeNote !== undefined) data.changeNote = input.changeNote;
      if (input.executionPolicy) {
        const merged = executionPolicySchema.safeParse({
          ...(draft.executionPolicy as Record<string, unknown>),
          ...input.executionPolicy,
        });
        if (!merged.success) issues.push(...policyIssues('executionPolicy', merged.error));
        else data.executionPolicy = merged.data as unknown as Prisma.InputJsonValue;
      }
      if (input.memoryPolicy) {
        const merged = memoryPolicySchema.safeParse({
          ...(draft.memoryPolicy as Record<string, unknown>),
          ...input.memoryPolicy,
        });
        if (!merged.success) issues.push(...policyIssues('memoryPolicy', merged.error));
        else data.memoryPolicy = merged.data as unknown as Prisma.InputJsonValue;
      }
      if (issues.length) throw new AppError(422, 'AGENT_DRAFT_INVALID', undefined, issues);
      if (Object.keys(data).length) await tx.agentVersion.update({ where: { id: draft.id }, data });
      if (input.models) await this.replaceModels(tx, admin, draft.id, input.models);
      if (input.mcpServers) await this.replaceServers(tx, admin, draft.id, input.mcpServers);
      if (input.skills) await this.replaceSkills(tx, admin, draft.id, input.skills);
      await this.audit.record(
        tx,
        admin,
        {
          action: 'agent.draft_update',
          targetType: 'agent',
          targetId: agentId,
          metadata: {
            fields: Object.keys(input).filter((k) => input[k as keyof DraftInput] !== undefined),
            mcpServers: input.mcpServers ?? null,
            skills: input.skills ?? null,
          },
        },
        req,
      );
      return this.view(tx, agentId);
    });
  }

  /** 역할별 모델 — executor 는 필수, 역할은 한 번씩. Provider 는 이 테넌트의 것만 */
  private async replaceModels(
    tx: TenantTx,
    admin: AdminSession,
    draftId: string,
    models: DraftInput['models'] & object,
  ): Promise<void> {
    const issues: FieldIssue[] = [];
    const roles = models.map((m) => m.role);
    if (new Set(roles).size !== roles.length)
      issues.push({ path: 'models', message: '같은 역할이 두 번 있습니다' });
    if (!roles.includes('executor'))
      issues.push({ path: 'models', message: 'executor 모델이 필요합니다' });
    const providerIds = [
      ...new Set(
        models.flatMap((m) => [
          m.providerId,
          ...(m.fallbackProviderId ? [m.fallbackProviderId] : []),
        ]),
      ),
    ];
    const providers = await tx.provider.findMany({
      where: { id: { in: providerIds } },
      select: { id: true },
    });
    const known = new Set(providers.map((p) => p.id));
    models.forEach((m, i) => {
      if (!known.has(m.providerId))
        issues.push({ path: `models.${i}.providerId`, message: 'Provider 를 찾을 수 없습니다' });
      if (m.fallbackProviderId && !known.has(m.fallbackProviderId))
        issues.push({
          path: `models.${i}.fallbackProviderId`,
          message: 'Provider 를 찾을 수 없습니다',
        });
      if (!!m.fallbackProviderId !== !!m.fallbackModel)
        issues.push({
          path: `models.${i}.fallbackModel`,
          message: '대체 Provider 와 모델은 함께 지정해야 합니다',
        });
    });
    if (issues.length) throw new AppError(422, 'AGENT_DRAFT_INVALID', undefined, issues);
    await tx.modelConfig.deleteMany({ where: { agentVersionId: draftId } });
    await tx.modelConfig.createMany({
      data: models.map((m) => ({
        tenantId: admin.tenantId,
        agentVersionId: draftId,
        role: m.role,
        providerId: m.providerId,
        model: m.model,
        maxOutputTokens: m.maxOutputTokens,
        temperature: m.temperature,
        reasoningEffort: m.reasoningEffort ?? null,
        fallbackProviderId: m.fallbackProviderId ?? null,
        fallbackModel: m.fallbackModel ?? null,
      })),
    });
  }

  /** 버전 기록 (최신순) */
  async versions(admin: AdminSession, agentId: string) {
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      const agent = await tx.agent.findFirst({ where: { id: agentId, archivedAt: null } });
      if (!agent) throw AppError.notFound();
      const versions = await tx.agentVersion.findMany({
        where: { agentId },
        orderBy: { version: 'desc' },
        select: {
          id: true,
          version: true,
          status: true,
          changeNote: true,
          publishedAt: true,
          publishedById: true,
          createdAt: true,
        },
      });
      const memberIds = [
        ...new Set(versions.flatMap((v) => (v.publishedById ? [v.publishedById] : []))),
      ];
      const members = memberIds.length
        ? await tx.user.findMany({
            where: { id: { in: memberIds } },
            select: { id: true, name: true },
          })
        : [];
      const names = new Map(members.map((m) => [m.id, m.name]));
      const running = await tx.task.groupBy({
        by: ['agentVersionId'],
        where: {
          agentId,
          status: { in: ['queued', 'running', 'waiting_approval', 'recovering', 'paused'] },
        },
        _count: { _all: true },
      });
      return versions.map((v) => ({
        id: v.id,
        version: v.version,
        status: v.status,
        changeNote: v.changeNote,
        publishedAt: v.publishedAt?.toISOString() ?? null,
        publishedBy: v.publishedById ? (names.get(v.publishedById) ?? null) : null,
        createdAt: v.createdAt.toISOString(),
        activeTasks: running.find((r) => r.agentVersionId === v.id)?._count._all ?? 0,
      }));
    });
  }

  /** 이전 버전으로 되돌리기 — 그 버전의 내용으로 초안을 다시 만든다 (배포는 따로) */
  async restore(
    admin: AdminSession,
    agentId: string,
    versionId: string,
    req?: AdminRequest,
  ): Promise<AgentAdminView> {
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      const source = await tx.agentVersion.findFirst({ where: { id: versionId, agentId } });
      if (!source) throw AppError.notFound('버전을 찾을 수 없습니다');
      await tx.agentVersion.deleteMany({ where: { agentId, status: 'draft' } });
      await this.draftFor(tx, admin, agentId, source.id);
      await tx.agentVersion.updateMany({
        where: { agentId, status: 'draft' },
        data: { changeNote: `v${source.version} 로 되돌림` },
      });
      await this.audit.record(
        tx,
        admin,
        {
          action: 'agent.restore',
          targetType: 'agent',
          targetId: agentId,
          metadata: { fromVersion: source.version },
        },
        req,
      );
      return this.view(tx, agentId);
    });
  }

  /** 초안 버리기 — 배포 버전 그대로 */
  async discardDraft(admin: AdminSession, agentId: string, req?: AdminRequest) {
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      const removed = await tx.agentVersion.deleteMany({ where: { agentId, status: 'draft' } });
      if (removed.count) {
        await this.audit.record(
          tx,
          admin,
          { action: 'agent.draft_discard', targetType: 'agent', targetId: agentId },
          req,
        );
      }
      return this.view(tx, agentId);
    });
  }

  async providers(admin: AdminSession) {
    return this.prisma.withTenant(admin.tenantId, async (tx) =>
      (await tx.provider.findMany({ orderBy: { name: 'asc' } })).map((p) => ({
        id: p.id,
        name: p.name,
        kind: p.kind,
        baseUrl: p.baseUrl,
      })),
    );
  }

  private async replaceServers(
    tx: TenantTx,
    admin: AdminSession,
    draftId: string,
    entries: Array<{ id: string; enabled: boolean }>,
  ): Promise<void> {
    {
      const input = { mcpServers: entries };
      const draft = { id: draftId };
      const ids = input.mcpServers.map((s) => s.id);
      const servers = await tx.mcpServer.findMany({ where: { id: { in: ids }, deletedAt: null } });
      const byId = new Map(servers.map((s) => [s.id, s]));
      const issues: FieldIssue[] = [];
      input.mcpServers.forEach((s, i) => {
        const server = byId.get(s.id);
        if (!server)
          issues.push({ path: `mcpServers.${i}.id`, message: 'MCP 서버를 찾을 수 없습니다' });
        else if (s.enabled && server.status !== 'connected') {
          issues.push({
            path: `mcpServers.${i}.enabled`,
            message: `연결됨 상태의 서버만 켤 수 있습니다 (현재: ${server.status})`,
          });
        }
      });
      if (new Set(ids).size !== ids.length)
        issues.push({ path: 'mcpServers', message: '같은 서버가 두 번 있습니다' });
      if (issues.length) throw new AppError(422, 'AGENT_DRAFT_INVALID', undefined, issues);

      await tx.agentVersionMcpServer.deleteMany({ where: { agentVersionId: draft.id } });
      if (input.mcpServers.length) {
        await tx.agentVersionMcpServer.createMany({
          data: input.mcpServers.map((s) => ({
            tenantId: admin.tenantId,
            agentVersionId: draft.id,
            mcpServerId: s.id,
            enabled: s.enabled,
          })),
        });
      }
    }
  }

  /** Skill 허용 목록 — 활성 Skill 만 켤 수 있다 (검토 대기 · 검증 실패 · 비활성은 끔으로만) */
  private async replaceSkills(
    tx: TenantTx,
    admin: AdminSession,
    draftId: string,
    entries: Array<{ id: string; enabled: boolean }>,
  ): Promise<void> {
    const ids = entries.map((s) => s.id);
    const skills = await tx.skill.findMany({ where: { id: { in: ids }, deletedAt: null } });
    const byId = new Map(skills.map((s) => [s.id, s]));
    const issues: FieldIssue[] = [];
    entries.forEach((s, i) => {
      const skill = byId.get(s.id);
      if (!skill) issues.push({ path: `skills.${i}.id`, message: 'Skill 을 찾을 수 없습니다' });
      else if (s.enabled && skill.status !== 'active') {
        issues.push({
          path: `skills.${i}.enabled`,
          message: `활성 Skill 만 켤 수 있습니다 (현재: ${skill.status})`,
        });
      }
    });
    if (new Set(ids).size !== ids.length)
      issues.push({ path: 'skills', message: '같은 Skill 이 두 번 있습니다' });
    if (issues.length) throw new AppError(422, 'AGENT_DRAFT_INVALID', undefined, issues);
    await tx.agentVersionSkill.deleteMany({ where: { agentVersionId: draftId } });
    if (entries.length) {
      await tx.agentVersionSkill.createMany({
        data: entries.map((s) => ({
          tenantId: admin.tenantId,
          agentVersionId: draftId,
          skillId: s.id,
          enabled: s.enabled,
        })),
      });
    }
  }

  /** 초안 → 배포. 이전 배포 버전은 archived (그 버전으로 실행 중인 작업은 그대로) */
  async publish(
    admin: AdminSession,
    agentId: string,
    input: PublishInput,
    req?: AdminRequest,
  ): Promise<AgentAdminView> {
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      const agent = await tx.agent.findFirst({ where: { id: agentId, archivedAt: null } });
      if (!agent) throw AppError.notFound();
      const draft = await tx.agentVersion.findFirst({
        where: { agentId, status: 'draft' },
        include: {
          modelConfigs: true,
          mcpServers: { include: { mcpServer: true } },
          skills: { include: { skill: true } },
        },
      });
      if (!draft) throw new AppError(422, 'AGENT_DRAFT_INVALID', '배포할 초안이 없습니다');

      const issues: FieldIssue[] = [];
      if (!draft.modelConfigs.some((m) => m.role === 'executor')) {
        issues.push({ path: 'models', message: 'executor 모델이 필요합니다' });
      }
      for (const s of draft.mcpServers) {
        if (s.enabled && (s.mcpServer.deletedAt || s.mcpServer.status !== 'connected')) {
          issues.push({
            path: 'mcpServers',
            message: `'${s.mcpServer.name}' 서버가 연결됨 상태가 아닙니다`,
          });
        }
      }
      for (const s of draft.skills) {
        if (s.enabled && (s.skill.deletedAt || s.skill.status !== 'active')) {
          issues.push({
            path: 'skills',
            message: `'${s.skill.name}' Skill 이 활성 상태가 아닙니다`,
          });
        }
      }
      if (issues.length) throw new AppError(422, 'AGENT_DRAFT_INVALID', undefined, issues);

      if (agent.publishedVersionId) {
        await tx.agentVersion.update({
          where: { id: agent.publishedVersionId },
          data: { status: 'archived' },
        });
      }
      await tx.agentVersion.update({
        where: { id: draft.id },
        data: {
          status: 'published',
          publishedAt: new Date(),
          publishedById: admin.userId,
          changeNote: input.changeNote ?? draft.changeNote,
        },
      });
      await tx.agent.update({ where: { id: agentId }, data: { publishedVersionId: draft.id } });
      await this.audit.record(
        tx,
        admin,
        {
          action: 'agent.publish',
          targetType: 'agent',
          targetId: agentId,
          metadata: { version: draft.version },
        },
        req,
      );
      return this.view(tx, agentId);
    });
  }

  /** 초안이 없으면 배포 버전(또는 지정한 버전)을 복사해 만든다 (모델 · Skill · MCP 허용 목록 포함) */
  private async draftFor(
    tx: TenantTx,
    admin: AdminSession,
    agentId: string,
    fromVersionId?: string,
  ): Promise<AgentVersion> {
    const agent = await tx.agent.findFirst({ where: { id: agentId, archivedAt: null } });
    if (!agent) throw AppError.notFound();
    const existing = await tx.agentVersion.findFirst({ where: { agentId, status: 'draft' } });
    if (existing) return existing;
    const sourceId = fromVersionId ?? agent.publishedVersionId;
    if (!sourceId) throw new AppError(422, 'AGENT_DRAFT_INVALID', '복사할 배포 버전이 없습니다');

    const source = await tx.agentVersion.findUniqueOrThrow({
      where: { id: sourceId },
      include: { modelConfigs: true, skills: true, mcpServers: true },
    });
    const last = await tx.agentVersion.aggregate({ where: { agentId }, _max: { version: true } });
    const draft = await tx.agentVersion.create({
      data: {
        tenantId: admin.tenantId,
        agentId,
        version: (last._max.version ?? 0) + 1,
        status: 'draft',
        welcomeMessage: source.welcomeMessage,
        systemPrompt: source.systemPrompt,
        executionPolicy: source.executionPolicy as Prisma.InputJsonValue,
        memoryPolicy: source.memoryPolicy as Prisma.InputJsonValue,
        createdById: admin.userId,
      },
    });
    if (source.modelConfigs.length) {
      await tx.modelConfig.createMany({
        data: source.modelConfigs.map(({ id: _id, createdAt: _c, agentVersionId: _v, ...m }) => ({
          ...m,
          agentVersionId: draft.id,
        })),
      });
    }
    if (source.skills.length) {
      await tx.agentVersionSkill.createMany({
        data: source.skills.map((s) => ({ ...s, agentVersionId: draft.id })),
      });
    }
    if (source.mcpServers.length) {
      await tx.agentVersionMcpServer.createMany({
        data: source.mcpServers.map((s) => ({ ...s, agentVersionId: draft.id })),
      });
    }
    return draft;
  }

  private async view(tx: TenantTx, agentId: string): Promise<AgentAdminView> {
    const agent = await tx.agent.findFirst({ where: { id: agentId, archivedAt: null } });
    if (!agent) throw AppError.notFound();
    const versions = await tx.agentVersion.findMany({
      where: {
        agentId,
        OR: [
          { status: 'draft' },
          ...(agent.publishedVersionId ? [{ id: agent.publishedVersionId }] : []),
        ],
      },
      include: {
        mcpServers: { include: { mcpServer: true } },
        skills: { include: { skill: true } },
        modelConfigs: { include: { provider: { select: { name: true } } } },
      },
    });
    const roleOrder = { planner: 0, executor: 1, evaluator: 2 } as const;
    const toView = (v: (typeof versions)[number]): AgentVersionView => ({
      id: v.id,
      version: v.version,
      status: v.status,
      publishedAt: v.publishedAt?.toISOString() ?? null,
      changeNote: v.changeNote,
      welcomeMessage: v.welcomeMessage,
      systemPrompt: v.systemPrompt,
      executionPolicy: executionPolicySchema.parse(v.executionPolicy ?? {}),
      memoryPolicy: memoryPolicySchema.parse(v.memoryPolicy ?? {}),
      models: [...v.modelConfigs]
        .sort((a, b) => roleOrder[a.role] - roleOrder[b.role])
        .map((m) => ({
          role: m.role,
          providerId: m.providerId,
          providerName: m.provider.name,
          model: m.model,
          maxOutputTokens: m.maxOutputTokens,
          temperature: m.temperature,
          reasoningEffort: m.reasoningEffort,
          fallbackProviderId: m.fallbackProviderId,
          fallbackModel: m.fallbackModel,
        })),
      updatedAt: v.updatedAt.toISOString(),
      mcpServers: v.mcpServers
        .filter((s) => !s.mcpServer.deletedAt)
        .map((s) => ({
          id: s.mcpServerId,
          name: s.mcpServer.name,
          status: s.mcpServer.status,
          enabled: s.enabled,
        })),
      skills: v.skills
        .filter((s) => !s.skill.deletedAt)
        .map((s) => ({
          id: s.skillId,
          name: s.skill.name,
          status: s.skill.status,
          enabled: s.enabled,
        })),
    });
    const published = versions.find((v) => v.id === agent.publishedVersionId);
    const draft = versions.find((v) => v.status === 'draft');
    return {
      id: agent.id,
      name: agent.name,
      published: published ? toView(published) : null,
      draft: draft ? toView(draft) : null,
    };
  }
}

function policyIssues(prefix: string, error: z.ZodError): FieldIssue[] {
  return error.issues.map((i) => ({
    path: [prefix, ...i.path.map(String)].join('.'),
    message: i.message,
  }));
}
