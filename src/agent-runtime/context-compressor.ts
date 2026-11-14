import { Injectable } from '@nestjs/common';
import { findInjectionRisks } from '../common/security/text-risk.js';
import type { LlmMessage, LlmUsage } from '../llm/llm.types.js';
import { maskSensitive } from '../tools/masking.js';
import type { ModelRouter } from './model-router.js';
import { COMPRESSOR_CONVERSATION_ROLE, systemPrompt } from './prompts.js';

/** 대화 요약 최대 길이 (프롬프트에 늘 들어간다) */
export const CONVERSATION_SUMMARY_CHARS = 1_500;
/** 요약에 넣는 메시지 하나의 최대 길이 */
const SUMMARY_MESSAGE_CHARS = 2_000;
/** 작업 대화의 Tool 결과 합계가 이 길이를 넘으면 오래된 결과를 줄인다 */
export const TOOL_RESULTS_CHARS = 16_000;
const TOOL_RESULT_HEAD_CHARS = 600;

export interface CompressionResult<T> {
  value: T;
  usage: LlmUsage;
}

/**
 * Context Compression — 컨텍스트가 길어져도 중요한 내용을 잃지 않게 줄인다.
 *  - 대화: 최근 대화 창 밖으로 밀려난 메시지를 대화별 누적 요약에 합친다 (요약은 다음 작업들의 시스템 프롬프트에)
 *  - 작업 대화의 Tool 결과: 오래된 결과를 앞부분만 남긴다 (모델 호출 없이 — compactToolResults)
 */
@Injectable()
export class ContextCompressor {
  async summarizeConversation(
    router: ModelRouter,
    previous: string | null,
    messages: Array<{ role: 'user' | 'assistant'; text: string }>,
    signal: AbortSignal,
  ): Promise<CompressionResult<string | null>> {
    const transcript = messages
      .map(
        (m) =>
          `${m.role === 'user' ? 'User' : 'Agent'}: ${truncate(m.text, SUMMARY_MESSAGE_CHARS)}`,
      )
      .join('\n\n');
    const res = await router.complete(
      {
        maxOutputTokens: 900,
        messages: [
          { role: 'system', content: systemPrompt('', COMPRESSOR_CONVERSATION_ROLE) },
          {
            role: 'user',
            content: `Previous summary:\n${previous?.trim() || '(none)'}\n\nOlder messages to merge (oldest first):\n${transcript}`,
          },
        ],
      },
      signal,
    );
    const summary = clean(res.content, CONVERSATION_SUMMARY_CHARS);
    // 요약에 지시문처럼 보이는 내용이 섞이면 저장하지 않는다 (이전 요약 유지)
    if (!summary || findInjectionRisks([summary]).length) return { value: null, usage: res.usage };
    return { value: summary, usage: res.usage };
  }
}

/**
 * 작업 대화의 Tool 결과가 예산을 넘으면, 마지막 Tool 호출 묶음보다 앞선 결과를 앞부분만 남긴다.
 * 모델은 그 결과를 이미 보고 다음 판단을 했으므로, 핵심은 이후 대화에 남아 있다.
 * 바뀐 메시지 수를 돌려준다 (messages 를 그대로 고친다).
 */
export function compactToolResults(messages: LlmMessage[], budget = TOOL_RESULTS_CHARS): number {
  const toolChars = () =>
    messages.reduce((sum, m) => sum + (m.role === 'tool' ? (m.content?.length ?? 0) : 0), 0);
  if (toolChars() <= budget) return 0;
  // 마지막 assistant(Tool 호출) 이후의 결과는 모델이 아직 보지 않았으니 그대로 둔다
  let lastCall = -1;
  messages.forEach((m, i) => {
    if (m.role === 'assistant' && m.toolCalls?.length) lastCall = i;
  });
  let changed = 0;
  for (let i = 0; i < lastCall && toolChars() > budget; i++) {
    const m = messages[i]!;
    if (m.role !== 'tool' || !m.content || m.content.length <= TOOL_RESULT_HEAD_CHARS + 120)
      continue;
    messages[i] = {
      ...m,
      content: `${m.content.slice(0, TOOL_RESULT_HEAD_CHARS)}…(older tool result shortened to save context; ${m.content.length} chars originally — rely on what you already concluded from it)`,
    };
    changed++;
  }
  return changed;
}

function clean(text: string, max: number): string {
  const masked = (maskSensitive(text.trim()) as string) ?? '';
  return truncate(masked, max);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
