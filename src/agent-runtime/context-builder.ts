import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { contentBlockSchema } from '../conversations/message-views.js';
import { PrismaService } from '../infrastructure/database/prisma.service.js';
import type { LlmMessage } from '../llm/llm.types.js';
import { type MemoryHit, MemoryRetriever } from '../memory/memory-retriever.service.js';
import { renderMemories } from './prompts.js';
import type { TaskRunInfo } from './run-context.js';

const HISTORY_MESSAGES = 12;
const HISTORY_CHARS = 12_000;

export interface AgentContext {
  tenantPrompt: string;
  /** 이번 요청 이전의 대화 (오래된 것 → 최신) */
  history: LlmMessage[];
  request: string;
  /** 관련 기억 (프롬프트용 목록, 없으면 빈 문자열) */
  memories: string;
  memoryHits: MemoryHit[];
}

/**
 * Context 구성 — 지침 + 최근 대화 + 이번 요청 + 관련 기억(Memory 정책: topK · 종류 · 최소 신뢰도).
 * 기억은 이 사용자의 user 범위 + Agent 범위만, 같은 임베딩 모델로 만든 것만 쓴다 (MemoryRetriever).
 */
@Injectable()
export class ContextBuilder {
  private readonly logger = new Logger(ContextBuilder.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly retriever: MemoryRetriever,
  ) {}

  async build(task: TaskRunInfo): Promise<AgentContext> {
    const rows = await this.prisma.withTenant(task.tenantId, (tx) =>
      tx.message.findMany({
        where: {
          conversationId: task.conversationId,
          role: { in: ['user', 'assistant'] },
          ...(task.triggerMessageId ? { id: { lt: task.triggerMessageId } } : {}),
        },
        orderBy: { id: 'desc' },
        take: HISTORY_MESSAGES,
        select: { role: true, content: true },
      }),
    );

    // 최신 메시지부터 글자 수 예산 안에서 담고, 다시 시간순으로 돌린다.
    const history: LlmMessage[] = [];
    let budget = HISTORY_CHARS;
    for (const row of rows) {
      const text = textOf(row.content);
      if (!text) continue;
      if (text.length > budget) break;
      budget -= text.length;
      history.unshift({ role: row.role === 'assistant' ? 'assistant' : 'user', content: text });
    }
    // 대화 기록은 user 로 시작해야 하는 provider 가 있다.
    while (history[0]?.role === 'assistant') history.shift();

    const memoryHits = await this.recall(task);
    return {
      tenantPrompt: task.systemPrompt,
      history,
      request: task.triggerText,
      memories: renderMemories(memoryHits),
      memoryHits,
    };
  }

  /** 기억 검색 실패(임베딩 API 장애 등)는 작업을 막지 않는다 — 기억 없이 진행 */
  private async recall(task: TaskRunInfo): Promise<MemoryHit[]> {
    const policy = task.memoryPolicy;
    if (!policy.enabled || !task.triggerText) return [];
    try {
      return await this.prisma.withTenant(task.tenantId, async (tx) => {
        const profile = policy.types.includes('semantic')
          ? await this.retriever.profile(tx, {
              agentId: task.agentId,
              endUserId: task.endUserId,
              limit: policy.profileSize,
              minConfidence: policy.minConfidence,
            })
          : [];
        const similar = await this.retriever.semantic(tx, {
          agentId: task.agentId,
          endUserId: task.endUserId,
          text: task.triggerText,
          limit: policy.topK,
          types: policy.types,
          minConfidence: policy.minConfidence,
          minScore: this.retriever.defaultMinScore,
        });
        const seen = new Set(profile.map((h) => h.id));
        const hits = [...profile, ...similar.filter((h) => !seen.has(h.id))];
        await this.retriever.markUsed(
          tx,
          hits.map((h) => h.id),
        );
        return hits;
      });
    } catch (err) {
      this.logger.warn(`기억 검색 실패 (${task.id}): ${String(err)}`);
      return [];
    }
  }

  /** 이 작업에 실행 중 보낸 추가 지시 (POST /tasks/:id/steer), 오래된 것부터 */
  async steers(task: TaskRunInfo): Promise<Array<{ id: string; text: string }>> {
    const rows = await this.prisma.withTenant(task.tenantId, (tx) =>
      tx.message.findMany({
        where: {
          taskId: task.id,
          role: 'user',
          ...(task.triggerMessageId ? { id: { not: task.triggerMessageId } } : {}),
        },
        orderBy: { id: 'asc' },
        take: 20,
        select: { id: true, content: true },
      }),
    );
    return rows.map((r) => ({ id: r.id, text: textOf(r.content) })).filter((r) => r.text);
  }
}

function textOf(content: unknown): string {
  const parsed = z.array(contentBlockSchema).safeParse(content);
  if (!parsed.success) return '';
  return parsed.data
    .flatMap((b) => (b.type === 'text' ? [b.text] : []))
    .join('\n')
    .trim();
}
