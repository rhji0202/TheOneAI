import { setTimeout as sleep } from 'node:timers/promises';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import type { AgentRuntime, RunResult } from './agent-runtime.js';
import type { RunContext } from './run-context.js';

/**
 * 임시 Agent Runtime — 작업 큐 → Worker → 단계 · checkpoint 저장 → SSE 스트리밍 파이프라인을 검증한다.
 * LLM 이나 Tool 을 호출하지 않는다. 개발 순서 3단계(Agent Loop)에서 AgentLoop 로 교체한다.
 */
@Injectable()
export class PlaceholderAgentRuntime implements AgentRuntime {
  private readonly delayMs: number;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.delayMs = config.placeholderRuntime.streamDelayMs;
  }

  async run(ctx: RunContext): Promise<RunResult> {
    await ctx.step({ type: 'context', name: 'context.build' }, async () => ({
      value: undefined,
      summary: '지침 · 대화 맥락 구성 (Memory · Skill 검색은 이후 단계에서 연결)',
      output: { systemPromptChars: ctx.task.systemPrompt.length, memories: 0, skills: 0 },
    }));

    await ctx.step({ type: 'plan', name: 'planner.create' }, async () => {
      await ctx.setPlan([
        { index: 1, title: '요청 확인 · 응답 작성', kind: 'respond', requiresApproval: false },
      ]);
      return { value: undefined, summary: '1단계 계획' };
    });

    const message = await ctx.step({ type: 'respond', name: 'respond', planIndex: 1 }, async () => {
      const reply = placeholderReply(ctx.task.triggerText);
      const msg = await ctx.streamAssistantMessage(chunked(reply, this.delayMs, ctx.signal));
      ctx.workingMemory.lastReplyMessageId = msg.id;
      return {
        value: msg,
        summary: '응답 작성 완료',
        output: { messageId: msg.id, chars: msg.text.length },
        checkpoint: true,
      };
    });

    const verification = [{ label: '응답 메시지 생성', passed: message.text.length > 0 }];
    await ctx.step({ type: 'evaluate', name: 'evaluator.check' }, async () => ({
      value: undefined,
      summary: '결과 확인',
      evaluation: { verdict: 'pass', checks: verification },
    }));

    return { messageId: message.id, verification };
  }
}

export function placeholderReply(request: string): string {
  const quoted = request.length > 200 ? `${request.slice(0, 199)}…` : request;
  return [
    `요청을 받았어요: “${quoted}”`,
    '',
    '지금은 실행 파이프라인(작업 큐 → Worker → 단계 기록 → 실시간 스트리밍)을 확인하는 임시 응답입니다.',
    '계획 수립 · Tool 실행 · 결과 검증을 하는 Agent Loop 는 다음 개발 단계에서 연결됩니다.',
  ].join('\n');
}

/** 공백 단위로 잘라 흘려보낸다. */
async function* chunked(
  text: string,
  delayMs: number,
  signal: AbortSignal,
): AsyncGenerator<string> {
  for (const piece of text.match(/\S+\s*|\s+/g) ?? []) {
    if (signal.aborted) return;
    if (delayMs > 0) await sleep(delayMs, undefined, { signal }).catch(() => undefined);
    yield piece;
  }
}
