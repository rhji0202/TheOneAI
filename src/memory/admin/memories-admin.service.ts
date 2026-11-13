import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { memoryPolicySchema } from '../../agents/agent-policies.js';
import { AuditService } from '../../admin/audit/audit.service.js';
import type { AdminRequest, AdminSession } from '../../admin/auth/admin-session.js';
import { AppError } from '../../common/errors/app-error.js';
import { type Page, toPage } from '../../common/http/pagination.js';
import type { Memory } from '../../generated/prisma/client.js';
import { PrismaService, type TenantTx } from '../../infrastructure/database/prisma.service.js';
import { EmbeddingService, toVectorLiteral } from '../embedding.service.js';
import { setEmbedding } from '../memory-ingest.service.js';
import { type MemoryHit, MemoryRetriever } from '../memory-retriever.service.js';

export const memorySearchSchema = z.object({
  agentId: z.uuid(),
  q: z.string().trim().min(1).max(500),
  mode: z.enum(['semantic', 'keyword']).default('semantic'),
  type: z.enum(['episodic', 'semantic', 'procedural']).optional(),
  scope: z.enum(['user', 'agent']).optional(),
  endUserId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
export type MemorySearchQuery = z.infer<typeof memorySearchSchema>;

export const memoryListSchema = z.object({
  status: z.enum(['active', 'quarantined']).default('quarantined'),
  type: z.enum(['episodic', 'semantic', 'procedural']).optional(),
  scope: z.enum(['user', 'agent']).optional(),
  agentId: z.uuid().optional(),
  endUserId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.uuid().optional(),
});
export type MemoryListQuery = z.infer<typeof memoryListSchema>;

export const memoryPatchSchema = z
  .object({
    title: z.string().trim().max(60).nullable(),
    content: z.string().trim().min(1).max(1_000),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, '바꿀 값이 없습니다');
export type MemoryPatch = z.infer<typeof memoryPatchSchema>;

/** docs/api-spec.md §4.8 MemorySearchHit */
export interface MemoryView {
  id: string;
  type: Memory['type'];
  scope: Memory['scope'];
  score?: number;
  title: string | null;
  content: string;
  confidence: number;
  needsVerification: boolean;
  status: Memory['status'];
  quarantineReason?: string | null;
  pinned: boolean;
  endUserId: string | null;
  /** 위젯 사용자 가명 (콘솔 공통 표시 — 작업 · 승인 화면과 같은 값) */
  endUserPseudonym: string | null;
  source: { type: string; taskIds: string[]; conversationId: string | null };
  useCount: number;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

/**
 * Memory 관리 (C-08). 검색은 Agent 의 Context 구성과 같은 경로(MemoryRetriever)라
 * 운영자가 “Agent 가 실제로 무엇을 떠올릴지” 재현할 수 있다.
 */
@Injectable()
export class MemoriesAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly retriever: MemoryRetriever,
    private readonly embeddings: EmbeddingService,
    private readonly audit: AuditService,
  ) {}

  async search(admin: AdminSession, q: MemorySearchQuery): Promise<MemoryView[]> {
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      const query = {
        agentId: q.agentId,
        endUserId: q.endUserId ?? null,
        allUsers: true,
        text: q.q,
        limit: q.limit,
        ...(q.type ? { types: [q.type] } : {}),
        ...(q.scope ? { scope: q.scope } : {}),
      };
      const hits =
        q.mode === 'semantic'
          ? await this.retriever.semantic(tx, query)
          : await this.retriever.keyword(tx, query);
      return withPseudonyms(tx, hits.map(fromHit));
    });
  }

  async list(admin: AdminSession, q: MemoryListQuery): Promise<Page<MemoryView>> {
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      const rows = await tx.memory.findMany({
        where: {
          status: q.status,
          ...(q.type ? { type: q.type } : {}),
          ...(q.scope ? { scope: q.scope } : {}),
          ...(q.agentId ? { agentId: q.agentId } : {}),
          ...(q.endUserId ? { endUserId: q.endUserId } : {}),
          ...(q.cursor ? { id: { lt: q.cursor } } : {}),
        },
        orderBy: { id: 'desc' },
        take: q.limit + 1,
      });
      const page = toPage(rows, q.limit, fromRow);
      return { ...page, items: await withPseudonyms(tx, page.items) };
    });
  }

  async get(admin: AdminSession, id: string): Promise<MemoryView> {
    return this.prisma.withTenant(admin.tenantId, async (tx) =>
      named(tx, fromRow(await this.find(tx, id))),
    );
  }

  /** 수정 → 다시 임베딩. 운영자가 확인한 내용이므로 검증 필요 표시를 내린다 */
  async update(
    admin: AdminSession,
    id: string,
    patch: MemoryPatch,
    req?: AdminRequest,
  ): Promise<MemoryView> {
    const current = await this.prisma.withTenant(admin.tenantId, (tx) => this.find(tx, id));
    const title = patch.title !== undefined ? patch.title : current.title;
    const content = patch.content ?? current.content;
    const vector = toVectorLiteral(await this.embeddings.embedOne(`${title ?? ''}\n${content}`));
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      const updated = await tx.memory.update({
        where: { id },
        data: { title, content, needsVerification: false },
      });
      await setEmbedding(tx, id, vector, this.embeddings.model);
      await this.audit.record(
        tx,
        admin,
        {
          action: 'memory.update',
          targetType: 'memory',
          targetId: id,
          metadata: { fields: Object.keys(patch) },
        },
        req,
      );
      return named(tx, fromRow(updated));
    });
  }

  /** 고정 — 만료에서 제외. 풀면 Agent 의 보존 기간으로 다시 만료일을 잡는다 */
  async pin(
    admin: AdminSession,
    id: string,
    pinned: boolean,
    req?: AdminRequest,
  ): Promise<MemoryView> {
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      const memory = await this.find(tx, id);
      const agent = await tx.agent.findUnique({
        where: { id: memory.agentId },
        select: { publishedVersion: { select: { memoryPolicy: true } } },
      });
      const days = memoryPolicySchema.parse(
        agent?.publishedVersion?.memoryPolicy ?? {},
      ).retentionDays;
      const updated = await tx.memory.update({
        where: { id },
        data: { pinned, expiresAt: pinned ? null : new Date(Date.now() + days * 86_400_000) },
      });
      await this.audit.record(
        tx,
        admin,
        { action: pinned ? 'memory.pin' : 'memory.unpin', targetType: 'memory', targetId: id },
        req,
      );
      return named(tx, fromRow(updated));
    });
  }

  /** 격리 해제 — 운영자가 내용을 확인한 뒤 Context 에 쓰이게 한다 */
  async release(admin: AdminSession, id: string, req?: AdminRequest): Promise<MemoryView> {
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      const memory = await this.find(tx, id);
      if (memory.status !== 'quarantined')
        throw new AppError(409, 'VALIDATION_FAILED', '격리된 기억이 아닙니다');
      const updated = await tx.memory.update({
        where: { id },
        data: { status: 'active', quarantineReason: null },
      });
      await this.audit.record(
        tx,
        admin,
        {
          action: 'memory.release',
          targetType: 'memory',
          targetId: id,
          metadata: { reason: memory.quarantineReason },
        },
        req,
      );
      return named(tx, fromRow(updated));
    });
  }

  async remove(admin: AdminSession, id: string, req?: AdminRequest): Promise<void> {
    await this.prisma.withTenant(admin.tenantId, async (tx) => {
      await this.find(tx, id);
      await tx.memory.delete({ where: { id } });
      await this.audit.record(
        tx,
        admin,
        { action: 'memory.delete', targetType: 'memory', targetId: id },
        req,
      );
    });
  }

  /**
   * 사용자 데이터 삭제 — 그 사용자의 기억 · 대화(메시지 · 작업 · 산출물 포함)를 지우고,
   * 외부 ID 연결을 끊어 같은 사용자가 다시 와도 새 사용자로 시작하게 한다. 사용자 행은 삭제 시각 기록용으로 남긴다.
   */
  async eraseEndUser(admin: AdminSession, endUserId: string, req?: AdminRequest) {
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      const user = await tx.endUser.findUnique({ where: { id: endUserId } });
      if (!user) throw AppError.notFound();
      const memories = await tx.memory.deleteMany({ where: { endUserId } });
      await tx.feedback.deleteMany({ where: { endUserId } });
      const conversations = await tx.conversation.deleteMany({ where: { endUserId } });
      await tx.endUser.update({
        where: { id: endUserId },
        data: {
          externalId: null,
          anonymousId: null,
          locale: null,
          pseudonym: `erased_${endUserId.slice(-8)}`,
          erasedAt: new Date(),
        },
      });
      await this.audit.record(
        tx,
        admin,
        {
          action: 'end_user.erase',
          targetType: 'end_user',
          targetId: endUserId,
          metadata: { memories: memories.count, conversations: conversations.count },
        },
        req,
      );
      return {
        endUserId,
        erased: { memories: memories.count, conversations: conversations.count },
      };
    });
  }

  private async find(tx: TenantTx, id: string): Promise<Memory> {
    const memory = await tx.memory.findUnique({ where: { id } });
    if (!memory) throw AppError.notFound();
    return memory;
  }
}

/** 사용자 범위 기억에 위젯 사용자 가명을 붙인다 (한 번에 조회) */
async function withPseudonyms(tx: TenantTx, views: MemoryView[]): Promise<MemoryView[]> {
  const ids = [...new Set(views.flatMap((v) => (v.endUserId ? [v.endUserId] : [])))];
  if (!ids.length) return views;
  const users = await tx.endUser.findMany({
    where: { id: { in: ids } },
    select: { id: true, pseudonym: true },
  });
  const byId = new Map(users.map((u) => [u.id, u.pseudonym]));
  return views.map((v) => ({
    ...v,
    endUserPseudonym: v.endUserId ? (byId.get(v.endUserId) ?? null) : null,
  }));
}

async function named(tx: TenantTx, view: MemoryView): Promise<MemoryView> {
  return (await withPseudonyms(tx, [view]))[0]!;
}

function fromHit(h: MemoryHit): MemoryView {
  return {
    id: h.id,
    type: h.type,
    scope: h.scope,
    score: h.score,
    title: h.title,
    content: h.content,
    confidence: h.confidence,
    needsVerification: h.needsVerification,
    status: h.status as Memory['status'],
    pinned: h.pinned,
    endUserId: h.endUserId,
    endUserPseudonym: null,
    source: {
      type: h.sourceType,
      taskIds: h.sourceTaskIds,
      conversationId: h.sourceConversationId,
    },
    useCount: h.useCount,
    lastUsedAt: h.lastUsedAt?.toISOString() ?? null,
    expiresAt: h.expiresAt?.toISOString() ?? null,
    createdAt: h.createdAt.toISOString(),
  };
}

function fromRow(m: Memory): MemoryView {
  return {
    id: m.id,
    type: m.type,
    scope: m.scope,
    title: m.title,
    content: m.content,
    confidence: m.confidence,
    needsVerification: m.needsVerification,
    status: m.status,
    quarantineReason: m.quarantineReason,
    pinned: m.pinned,
    endUserId: m.endUserId,
    endUserPseudonym: null,
    source: {
      type: m.sourceType,
      taskIds: m.sourceTaskIds,
      conversationId: m.sourceConversationId,
    },
    useCount: m.useCount,
    lastUsedAt: m.lastUsedAt?.toISOString() ?? null,
    expiresAt: m.expiresAt?.toISOString() ?? null,
    createdAt: m.createdAt.toISOString(),
  };
}
