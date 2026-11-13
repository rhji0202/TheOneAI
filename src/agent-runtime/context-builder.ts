import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { contentBlockSchema } from '../conversations/message-views.js';
import { PrismaService } from '../infrastructure/database/prisma.service.js';
import {
  addUsage,
  emptyUsage,
  type LlmImage,
  type LlmMessage,
  type LlmUsage,
} from '../llm/llm.types.js';
import { type MemoryHit, MemoryRetriever } from '../memory/memory-retriever.service.js';
import { ArtifactsService } from '../artifacts/artifacts.service.js';
import { ContextCompressor } from './context-compressor.js';
import type { ModelRouter } from './model-router.js';
import { renderMemories } from './prompts.js';
import type { TaskRunInfo } from './run-context.js';

const HISTORY_MESSAGES = 12;
const HISTORY_CHARS = 12_000;
/** 한 번의 요약에 넣는 오래된 메시지 수 (밀린 메시지가 많으면 여러 번에 나눠 합친다) */
const SUMMARY_BATCH = 40;
const SUMMARY_MAX_BATCHES = 3;

export interface AgentContext {
  tenantPrompt: string;
  /** 이번 요청 이전의 최근 대화 (오래된 것 → 최신) */
  history: LlmMessage[];
  request: string;
  /** 요청에 첨부한 이미지 — 요청을 보여 주는 모든 프롬프트의 사용자 메시지에 함께 싣는다 */
  images: LlmImage[];
  /** 관련 기억 (프롬프트용 목록, 없으면 빈 문자열) */
  memories: string;
  memoryHits: MemoryHit[];
  /** 최근 대화 창 밖의 오래된 대화 요약 (없으면 빈 문자열) */
  conversationSummary: string;
}

export interface ContextBuildResult {
  context: AgentContext;
  /** 이번에 요약에 새로 합친 메시지 수 · 요약 길이 (없으면 null) */
  compression: { messages: number; chars: number } | null;
  usage: LlmUsage;
}

/**
 * Context 구성 — 지침 + 최근 대화 + (오래된 대화 요약) + 이번 요청 + 관련 기억(Memory 정책: topK · 종류 · 최소 신뢰도).
 * 최근 대화는 메시지 수 · 글자 수 예산 안에서 그대로 넣고, 그 밖으로 밀려난 메시지는 대화별 누적 요약에 합친다
 * (Context Compression — 요약은 앞으로만 나아가며, 이미 합친 메시지는 다시 요약하지 않는다).
 * 기억은 이 사용자의 user 범위 + Agent 범위만, 같은 임베딩 모델로 만든 것만 쓴다 (MemoryRetriever).
 */
@Injectable()
export class ContextBuilder {
  private readonly logger = new Logger(ContextBuilder.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly retriever: MemoryRetriever,
    private readonly compressor: ContextCompressor,
    private readonly artifacts: ArtifactsService,
  ) {}

  /** @param compress 주어지면 창 밖으로 밀려난 메시지를 요약에 합친다 (Agent Loop) */
  async build(
    task: TaskRunInfo,
    compress?: { router: ModelRouter; signal: AbortSignal },
  ): Promise<ContextBuildResult> {
    const { rows, conversation } = await this.prisma.withTenant(task.tenantId, async (tx) => ({
      rows: await tx.message.findMany({
        where: {
          conversationId: task.conversationId,
          role: { in: ['user', 'assistant'] },
          ...(task.triggerMessageId ? { id: { lt: task.triggerMessageId } } : {}),
        },
        orderBy: { id: 'desc' },
        take: HISTORY_MESSAGES,
        select: { id: true, role: true, content: true },
      }),
      conversation: await tx.conversation.findUnique({
        where: { id: task.conversationId },
        select: { summary: true, summaryThroughId: true },
      }),
    }));

    // 최신 메시지부터 글자 수 예산 안에서 담고, 다시 시간순으로 돌린다.
    const window: Array<{ id: string; message: LlmMessage }> = [];
    let budget = HISTORY_CHARS;
    for (const row of rows) {
      const text = textOf(row.content);
      if (!text) continue;
      if (text.length > budget) break;
      budget -= text.length;
      window.unshift({
        id: row.id,
        message: { role: row.role === 'assistant' ? 'assistant' : 'user', content: text },
      });
    }
    // 대화 기록은 user 로 시작해야 하는 provider 가 있다 (빠진 assistant 메시지는 요약으로 간다).
    while (window[0]?.message.role === 'assistant') window.shift();
    const history = window.map((w) => w.message);
    const oldestIncluded = window[0]?.id ?? null;

    let summary = conversation?.summary ?? '';
    let compression: ContextBuildResult['compression'] = null;
    let usage = emptyUsage();
    // 창 밖(가장 오래된 포함 메시지 이전 — 창이 비면 이번 요청 이전 전부) 중 아직 요약에 없는 메시지
    const before = oldestIncluded ?? task.triggerMessageId;
    if (compress && before) {
      try {
        const merged = await this.compressOlder(
          task,
          compress,
          before,
          conversation?.summaryThroughId ?? null,
          summary,
        );
        if (merged) {
          summary = merged.summary;
          compression = { messages: merged.messages, chars: summary.length };
          usage = merged.usage;
        }
      } catch (err) {
        if (compress.signal.aborted) throw err;
        this.logger.warn(`대화 요약 실패 (${task.id}): ${String(err)} — 기존 요약으로 진행`);
      }
    }

    const memoryHits = await this.recall(task);
    // 첨부 파일 — 텍스트(CSV · JSON · 텍스트)는 내용을, 이미지는 이미지 입력으로, 나머지는 이름 · 형식만 데이터로 붙인다
    const attachments = task.triggerMessageId
      ? await this.artifacts.attachmentContext(task.tenantId, task.triggerMessageId)
      : { text: '', images: [] };
    return {
      context: {
        tenantPrompt: task.systemPrompt,
        history,
        request: task.triggerText + attachments.text,
        images: attachments.images,
        memories: renderMemories(memoryHits),
        memoryHits,
        conversationSummary: summary,
      },
      compression,
      usage,
    };
  }

  /** 요약에 아직 없는 오래된 메시지를 누적 요약에 합치고 대화에 저장한다 */
  private async compressOlder(
    task: TaskRunInfo,
    { router, signal }: { router: ModelRouter; signal: AbortSignal },
    before: string,
    throughId: string | null,
    previous: string,
  ): Promise<{ summary: string; messages: number; usage: LlmUsage } | null> {
    let summary = previous;
    let through = throughId;
    let merged = 0;
    let usage = emptyUsage();
    for (let batch = 0; batch < SUMMARY_MAX_BATCHES; batch++) {
      const older = await this.prisma.withTenant(task.tenantId, (tx) =>
        tx.message.findMany({
          where: {
            conversationId: task.conversationId,
            role: { in: ['user', 'assistant'] },
            id: { lt: before, ...(through ? { gt: through } : {}) },
          },
          orderBy: { id: 'asc' },
          take: SUMMARY_BATCH,
          select: { id: true, role: true, content: true },
        }),
      );
      if (!older.length) break;
      const messages = older
        .map((m) => ({
          role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
          text: textOf(m.content),
        }))
        .filter((m) => m.text);
      const result = messages.length
        ? await this.compressor.summarizeConversation(router, summary || null, messages, signal)
        : { value: null, usage: emptyUsage() };
      usage = addUsage(usage, result.usage);
      // 요약을 못 만들었어도(지시문 의심 등) 이 메시지들은 지난 것으로 표시해 매번 다시 시도하지 않는다
      if (result.value) summary = result.value;
      through = older.at(-1)!.id;
      merged += older.length;
      await this.prisma.withTenant(task.tenantId, (tx) =>
        tx.conversation.update({
          where: { id: task.conversationId },
          data: {
            summary: summary || null,
            summaryThroughId: through,
            summaryUpdatedAt: new Date(),
          },
        }),
      );
      if (older.length < SUMMARY_BATCH) break;
    }
    return merged ? { summary, messages: merged, usage } : null;
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
