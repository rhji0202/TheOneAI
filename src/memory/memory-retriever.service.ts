import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { type MemoryScope, type MemoryType, Prisma } from '../generated/prisma/client.js';
import type { TenantTx } from '../infrastructure/database/prisma.service.js';
import { EmbeddingService, toVectorLiteral } from './embedding.service.js';

export interface MemoryHit {
  id: string;
  type: MemoryType;
  scope: MemoryScope;
  title: string | null;
  content: string;
  score: number;
  confidence: number;
  needsVerification: boolean;
  sourceType: string;
  sourceTaskIds: string[];
  sourceConversationId: string | null;
  endUserId: string | null;
  pinned: boolean;
  status: string;
  useCount: number;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  /** profile: 질문과 비슷해서가 아니라 사용자 프로필로 넣은 기억 (score 없음) */
  via?: 'profile';
}

export interface MemoryQuery {
  agentId: string;
  /** 이 사용자의 user 범위 기억 + agent 범위 기억. null 이면 agent 범위만 */
  endUserId: string | null;
  text: string;
  limit: number;
  types?: MemoryType[];
  scope?: MemoryScope;
  minConfidence?: number;
  /** 이 점수 미만은 버린다 (Context 구성) */
  minScore?: number;
  /** 콘솔: 격리 항목 · 모든 사용자 포함 */
  includeQuarantined?: boolean;
  allUsers?: boolean;
}

const COLUMNS = Prisma.sql`
  id, type, scope, title, content, confidence, needs_verification, source_type, source_task_ids,
  source_conversation_id, end_user_id, pinned, status, use_count, last_used_at, expires_at, created_at`;

/**
 * MemoryRetriever — Agent 의 Context 구성과 콘솔 검색(C-08)이 같은 쿼리 경로를 쓴다 (docs/api-spec.md §4.8).
 *  - semantic: pgvector cosine (같은 임베딩 모델로 만든 기억만)
 *  - keyword: pg_trgm 유사도 (한국어 부분 일치)
 * 테넌트 격리는 RLS, 사용자 격리는 (scope = agent OR end_user_id = 요청 사용자) 조건이 맡는다.
 */
@Injectable()
export class MemoryRetriever {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly embeddings: EmbeddingService,
  ) {}

  get defaultMinScore(): number {
    return this.config.memory.minScore;
  }

  async semantic(tx: TenantTx, q: MemoryQuery): Promise<MemoryHit[]> {
    if (q.limit <= 0 || !q.text.trim()) return [];
    const vector = toVectorLiteral(await this.embeddings.embedOne(q.text));
    const rows = await tx.$queryRaw<RawRow[]>`
      SELECT ${COLUMNS}, 1 - (embedding <=> ${vector}::vector) AS score
      FROM memories
      WHERE ${this.filters(q)}
        AND embedding IS NOT NULL AND embedding_model = ${this.embeddings.model}
      ORDER BY embedding <=> ${vector}::vector
      LIMIT ${q.limit}`;
    return rows.map(toHit).filter((h) => h.score >= (q.minScore ?? 0));
  }

  async keyword(tx: TenantTx, q: MemoryQuery): Promise<MemoryHit[]> {
    if (q.limit <= 0 || !q.text.trim()) return [];
    const rows = await tx.$queryRaw<RawRow[]>`
      SELECT ${COLUMNS}, greatest(similarity(content, ${q.text}), word_similarity(${q.text}, content)) AS score
      FROM memories
      WHERE ${this.filters(q)}
        AND (content ILIKE ${`%${escapeLike(q.text)}%`} OR word_similarity(${q.text}, content) > 0.3)
      ORDER BY score DESC
      LIMIT ${q.limit}`;
    return rows.map(toHit);
  }

  /**
   * 사용자 프로필 — 이 사용자의 user 범위 semantic 기억(선호 형식 · 언어 · 역할 등).
   * 이런 사실은 질문 주제와 단어가 겹치지 않아도 늘 적용되므로 유사도와 상관없이 넣는다.
   * 고정 → 확신도 → 사용 횟수 → 최신 순.
   */
  async profile(
    tx: TenantTx,
    q: Pick<MemoryQuery, 'agentId' | 'endUserId' | 'limit' | 'minConfidence'>,
  ): Promise<MemoryHit[]> {
    if (q.limit <= 0 || !q.endUserId) return [];
    const rows = await tx.$queryRaw<RawRow[]>`
      SELECT ${COLUMNS}, 0 AS score
      FROM memories
      WHERE ${this.filters({ ...q, text: '', scope: 'user', types: ['semantic'] })}
      ORDER BY pinned DESC, confidence DESC, use_count DESC, created_at DESC
      LIMIT ${q.limit}`;
    return rows.map((r) => ({ ...toHit(r), via: 'profile' as const }));
  }

  /** 기억을 썼다는 기록 (use_count · last_used_at) */
  async markUsed(tx: TenantTx, ids: string[]): Promise<void> {
    if (!ids.length) return;
    await tx.memory.updateMany({
      where: { id: { in: ids } },
      data: { useCount: { increment: 1 }, lastUsedAt: new Date() },
    });
  }

  private filters(q: MemoryQuery): Prisma.Sql {
    const parts: Prisma.Sql[] = [Prisma.sql`agent_id = ${q.agentId}::uuid`];
    parts.push(q.includeQuarantined ? Prisma.sql`TRUE` : Prisma.sql`status = 'active'`);
    if (!q.allUsers) {
      parts.push(
        q.endUserId
          ? Prisma.sql`(scope = 'agent' OR end_user_id = ${q.endUserId}::uuid)`
          : Prisma.sql`scope = 'agent'`,
      );
    } else if (q.endUserId) {
      parts.push(Prisma.sql`end_user_id = ${q.endUserId}::uuid`);
    }
    if (q.scope) parts.push(Prisma.sql`scope = ${q.scope}::memory_scope`);
    if (q.types?.length) parts.push(Prisma.sql`type = ANY(${q.types}::memory_type[])`);
    if (q.minConfidence !== undefined) parts.push(Prisma.sql`confidence >= ${q.minConfidence}`);
    parts.push(Prisma.sql`(pinned OR expires_at IS NULL OR expires_at > now())`);
    return Prisma.join(parts, ' AND ');
  }
}

interface RawRow {
  id: string;
  type: MemoryType;
  scope: MemoryScope;
  title: string | null;
  content: string;
  confidence: number;
  needs_verification: boolean;
  source_type: string;
  source_task_ids: string[];
  source_conversation_id: string | null;
  end_user_id: string | null;
  pinned: boolean;
  status: string;
  use_count: number;
  last_used_at: Date | null;
  expires_at: Date | null;
  created_at: Date;
  score: number | string;
}

function toHit(r: RawRow): MemoryHit {
  return {
    id: r.id,
    type: r.type,
    scope: r.scope,
    title: r.title,
    content: r.content,
    score: Math.round(Number(r.score) * 1000) / 1000,
    confidence: r.confidence,
    needsVerification: r.needs_verification,
    sourceType: r.source_type,
    sourceTaskIds: r.source_task_ids,
    sourceConversationId: r.source_conversation_id,
    endUserId: r.end_user_id,
    pinned: r.pinned,
    status: r.status,
    useCount: r.use_count,
    lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
  };
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}
