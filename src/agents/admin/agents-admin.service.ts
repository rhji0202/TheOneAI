import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../../admin/audit/audit.service.js';
import type { AdminRequest, AdminSession } from '../../admin/auth/admin-session.js';
import { AppError, type FieldIssue } from '../../common/errors/app-error.js';
import type { AgentVersion, Prisma } from '../../generated/prisma/client.js';
import { PrismaService, type TenantTx } from '../../infrastructure/database/prisma.service.js';

/**
 * 지금 받는 초안 필드는 MCP 허용 목록뿐이다 (C-03 의 나머지 — 지침 · 모델 · 정책 편집은 콘솔 단계).
 * 모르는 필드는 조용히 무시하지 않고 거부한다.
 */
const allowEntry = z.object({ id: z.uuid(), enabled: z.boolean() });
export const draftInputSchema = z
  .object({
    mcpServers: z.array(allowEntry).max(100).optional(),
    skills: z.array(allowEntry).max(100).optional(),
  })
  .strict()
  .refine((v) => v.mcpServers !== undefined || v.skills !== undefined, '바꿀 값이 없습니다');
export type DraftInput = z.infer<typeof draftInputSchema>;

export const publishInputSchema = z.object({ changeNote: z.string().trim().max(500).optional() });
export type PublishInput = z.infer<typeof publishInputSchema>;

export interface AgentVersionView {
  id: string;
  version: number;
  status: AgentVersion['status'];
  publishedAt: string | null;
  changeNote: string | null;
  mcpServers: Array<{ id: string; name: string; status: string; enabled: boolean }>;
  skills: Array<{ id: string; name: string; status: string; enabled: boolean }>;
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
@Injectable()
export class AgentsAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(
    admin: AdminSession,
  ): Promise<Array<{ id: string; name: string; publishedVersion: number | null }>> {
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      const agents = await tx.agent.findMany({
        where: { archivedAt: null },
        include: { publishedVersion: { select: { version: true } } },
        orderBy: { name: 'asc' },
      });
      return agents.map((a) => ({
        id: a.id,
        name: a.name,
        publishedVersion: a.publishedVersion?.version ?? null,
      }));
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
      if (input.mcpServers) await this.replaceServers(tx, admin, draft.id, input.mcpServers);
      if (input.skills) await this.replaceSkills(tx, admin, draft.id, input.skills);
      await this.audit.record(
        tx,
        admin,
        {
          action: 'agent.draft_update',
          targetType: 'agent',
          targetId: agentId,
          metadata: { mcpServers: input.mcpServers ?? null, skills: input.skills ?? null },
        },
        req,
      );
      return this.view(tx, agentId);
    });
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

  /** 초안이 없으면 배포 버전을 복사해 만든다 (모델 · Skill · MCP 허용 목록 포함) */
  private async draftFor(
    tx: TenantTx,
    admin: AdminSession,
    agentId: string,
  ): Promise<AgentVersion> {
    const agent = await tx.agent.findFirst({ where: { id: agentId, archivedAt: null } });
    if (!agent) throw AppError.notFound();
    const existing = await tx.agentVersion.findFirst({ where: { agentId, status: 'draft' } });
    if (existing) return existing;
    if (!agent.publishedVersionId)
      throw new AppError(422, 'AGENT_DRAFT_INVALID', '복사할 배포 버전이 없습니다');

    const source = await tx.agentVersion.findUniqueOrThrow({
      where: { id: agent.publishedVersionId },
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
      },
    });
    const toView = (v: (typeof versions)[number]): AgentVersionView => ({
      id: v.id,
      version: v.version,
      status: v.status,
      publishedAt: v.publishedAt?.toISOString() ?? null,
      changeNote: v.changeNote,
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
