import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { contentBlockSchema } from '../conversations/message-views.js';
import { PrismaService } from '../infrastructure/database/prisma.service.js';
import type { LlmMessage } from '../llm/llm.types.js';
import type { TaskRunInfo } from './run-context.js';

const HISTORY_MESSAGES = 12;
const HISTORY_CHARS = 12_000;

export interface AgentContext {
  tenantPrompt: string;
  /** 이번 요청 이전의 대화 (오래된 것 → 최신) */
  history: LlmMessage[];
  request: string;
}

/**
 * Context 구성 — 지침 + 최근 대화 + 이번 요청.
 * Memory · Skill metadata 검색은 개발 순서 6 · 9단계에서 여기에 더한다.
 */
@Injectable()
export class ContextBuilder {
  constructor(private readonly prisma: PrismaService) {}

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

    return { tenantPrompt: task.systemPrompt, history, request: task.triggerText };
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
