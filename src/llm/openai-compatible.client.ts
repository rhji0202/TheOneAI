import { setTimeout as sleep } from 'node:timers/promises';
import {
  emptyUsage,
  type LlmClient,
  LlmError,
  type LlmProviderKind,
  type LlmRequest,
  type LlmResponse,
  type LlmStreamEvent,
  type LlmToolCall,
  type LlmUsage,
} from './llm.types.js';
import { buildChatBody } from './provider-params.js';

export interface OpenAiCompatibleOptions {
  kind: LlmProviderKind;
  baseUrl: string;
  apiKey: string;
  /** 응답 헤더까지(스트림) · 전체 응답까지(complete) 대기 시간 */
  requestTimeoutMs?: number;
  /** 스트림 청크 사이 최대 대기 시간 */
  idleTimeoutMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  fetchImpl?: typeof fetch;
}

interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
  completion_tokens_details?: { reasoning_tokens?: number } | null;
  prompt_cache_hit_tokens?: number;
}

interface WireToolCall {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface WireCompletion {
  model?: string;
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: WireToolCall[] };
    finish_reason?: string | null;
  }>;
  usage?: WireUsage | null;
}

interface WireChunk {
  model?: string;
  choices?: Array<{
    delta?: { content?: string | null; tool_calls?: WireToolCall[] };
    finish_reason?: string | null;
  }>;
  usage?: WireUsage | null;
}

/**
 * OpenAI 호환 Chat Completions 클라이언트 (OpenAI · DeepSeek · Gemini · 기타 호환 엔드포인트).
 *  - 429 · 5xx · 네트워크 · 시간 초과만 지수 백오프로 재시도한다 (스트림은 응답 헤더를 받기 전까지만).
 *  - json 모드를 provider 가 거부하면(400) 한 번 json 없이 다시 보낸다.
 */
export class OpenAiCompatibleClient implements LlmClient {
  private readonly url: string;
  private readonly requestTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAiCompatibleOptions) {
    this.url = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryBaseMs = options.retryBaseMs ?? 500;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    return this.withJsonFallback(request, async (json) => {
      const { response, cleanup } = await this.send(request, { stream: false, json });
      try {
        const body = (await response.json()) as WireCompletion;
        const choice = body.choices?.[0];
        if (!choice) throw new LlmError('invalid_response', '응답에 choices 가 없습니다');
        return {
          model: body.model ?? request.model,
          content: choice.message?.content ?? '',
          toolCalls: (choice.message?.tool_calls ?? []).map((call, i) => ({
            id: call.id ?? `call_${i}`,
            name: call.function?.name ?? '',
            arguments: call.function?.arguments ?? '',
          })),
          finishReason: choice.finish_reason ?? null,
          usage: toUsage(body.usage),
        };
      } catch (err) {
        throw this.normalize(err, request);
      } finally {
        cleanup();
      }
    });
  }

  async *stream(request: LlmRequest): AsyncGenerator<LlmStreamEvent> {
    const { response, cleanup } = await this.withJsonFallback(request, (json) =>
      this.send(request, { stream: true, json }),
    );
    const idle = new AbortController();
    let idleTimer = setTimeout(() => idle.abort(), this.idleTimeoutMs);
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => idle.abort(), this.idleTimeoutMs);
    };

    let content = '';
    let model = request.model;
    let finishReason: string | null = null;
    let usage: LlmUsage = emptyUsage();
    const toolCalls = new Map<number, LlmToolCall>();

    try {
      if (!response.body) throw new LlmError('invalid_response', '스트림 본문이 없습니다');
      const decoder = new TextDecoder();
      let buffer = '';
      let done = false;
      for await (const bytes of readWithAbort(response.body, idle.signal)) {
        resetIdle();
        buffer += decoder.decode(bytes, { stream: true });
        let index: number;
        while ((index = buffer.search(/\r?\n\r?\n/)) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index).replace(/^\r?\n\r?\n/, '');
          for (const line of block.split(/\r?\n/)) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') {
              done = true;
              continue;
            }
            const chunk = parseChunk(data);
            if (chunk.model) model = chunk.model;
            if (chunk.usage) usage = toUsage(chunk.usage);
            const choice = chunk.choices?.[0];
            if (!choice) continue;
            if (choice.finish_reason) finishReason = choice.finish_reason;
            const text = choice.delta?.content;
            if (text) {
              content += text;
              yield { type: 'text', text };
            }
            for (const delta of choice.delta?.tool_calls ?? []) {
              const i = delta.index ?? 0;
              const current = toolCalls.get(i) ?? { id: '', name: '', arguments: '' };
              toolCalls.set(i, {
                id: delta.id ?? current.id,
                name: current.name + (delta.function?.name ?? ''),
                arguments: current.arguments + (delta.function?.arguments ?? ''),
              });
            }
          }
        }
        if (done) break;
      }
    } catch (err) {
      if (idle.signal.aborted && !request.signal?.aborted) {
        throw new LlmError('timeout', `스트림이 ${this.idleTimeoutMs}ms 동안 멈췄습니다`);
      }
      throw this.normalize(err, request);
    } finally {
      clearTimeout(idleTimer);
      cleanup();
    }

    yield {
      type: 'done',
      response: {
        model,
        content,
        toolCalls: [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call),
        finishReason,
        usage,
      },
    };
  }

  /** 요청 전송 + 재시도. 성공하면 응답(헤더 수신 상태)과 정리 함수를 돌려준다. */
  private async send(
    request: LlmRequest,
    mode: { stream: boolean; json: boolean },
  ): Promise<{ response: Response; cleanup: () => void }> {
    const body = JSON.stringify(buildChatBody(this.options.kind, request, mode));
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const onAbort = () => controller.abort(request.signal?.reason);
      request.signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new LlmError('timeout', '응답 시간 초과')),
        this.requestTimeoutMs,
      );
      const cleanup = () => {
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', onAbort);
      };

      try {
        if (request.signal?.aborted) throw request.signal.reason ?? new Error('aborted');
        const response = await this.fetchImpl(this.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.options.apiKey}`,
            Accept: mode.stream ? 'text/event-stream' : 'application/json',
          },
          body,
          signal: controller.signal,
        });
        if (!response.ok) throw await errorFromResponse(response);
        if (mode.stream) clearTimeout(timer); // 스트림은 이후 idle timeout 으로 관리
        return { response, cleanup };
      } catch (err) {
        cleanup();
        const error = this.normalize(err, request);
        if (
          request.signal?.aborted ||
          !(error instanceof LlmError) ||
          !error.retryable ||
          attempt >= this.maxRetries
        ) {
          throw error;
        }
        const delay = this.retryBaseMs * 2 ** attempt * (0.8 + Math.random() * 0.4);
        await sleep(delay, undefined, { signal: request.signal });
      }
    }
  }

  private async withJsonFallback<T>(
    request: LlmRequest,
    fn: (json: boolean) => Promise<T>,
  ): Promise<T> {
    if (!request.json) return fn(false);
    try {
      return await fn(true);
    } catch (err) {
      if (
        err instanceof LlmError &&
        err.code === 'bad_request' &&
        /response_format|json/i.test(err.message)
      ) {
        return fn(false);
      }
      throw err;
    }
  }

  /** 취소는 원래 사유(TaskCancelledError 등)를 그대로, 나머지는 LlmError 로 */
  private normalize(err: unknown, request: LlmRequest): unknown {
    if (request.signal?.aborted) return request.signal.reason ?? err;
    if (err instanceof LlmError) return err;
    if (err instanceof Error && err.name === 'AbortError') {
      const reason: unknown = (err as Error & { cause?: unknown }).cause;
      return reason instanceof LlmError ? reason : new LlmError('timeout', '응답 시간 초과');
    }
    if (err instanceof SyntaxError)
      return new LlmError('invalid_response', `응답 JSON 오류: ${err.message}`);
    return new LlmError('network', err instanceof Error ? err.message : String(err));
  }
}

async function errorFromResponse(response: Response): Promise<LlmError> {
  let message = `${response.status} ${response.statusText}`;
  try {
    const text = await response.text();
    const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    const detail =
      typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? parsed.message);
    if (detail) message = `${response.status}: ${detail}`;
  } catch {
    // 본문이 JSON 이 아니면 상태 코드만 쓴다.
  }
  const status = response.status;
  const code =
    status === 401 || status === 403
      ? 'auth'
      : status === 429
        ? 'rate_limit'
        : status === 408
          ? 'timeout'
          : status >= 500
            ? 'server'
            : 'bad_request';
  return new LlmError(code, message, status);
}

function toUsage(usage: WireUsage | null | undefined): LlmUsage {
  return {
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    cachedInputTokens:
      usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? 0,
  };
}

function parseChunk(data: string): WireChunk {
  try {
    return JSON.parse(data) as WireChunk;
  } catch {
    throw new LlmError('invalid_response', '스트림 청크가 JSON 이 아닙니다');
  }
}

async function* readWithAbort(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (signal.aborted) throw new Error('idle timeout');
      if (done) return;
      if (value) yield value;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}
