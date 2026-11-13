/** LLM 호출 계약. Agent Runtime 은 provider 와 무관하게 이 타입만 쓴다. */

export type LlmProviderKind = 'openai' | 'deepseek' | 'gemini' | 'openai_compatible';
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'max';

export interface LlmToolCall {
  id: string;
  name: string;
  /** JSON 문자열 (모델이 만든 그대로) */
  arguments: string;
}

/** 사용자 메시지에 싣는 이미지 (base64) — provider 형식(data URL 등)은 보낼 때 만든다 */
export interface LlmImage {
  mimeType: string;
  data: string;
}

export type LlmMessage =
  | { role: 'system' | 'user'; content: string; images?: LlmImage[] }
  | { role: 'assistant'; content: string | null; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface LlmToolDefinition {
  name: string;
  description: string;
  /** JSON Schema (object) */
  parameters: Record<string, unknown>;
}

export interface LlmRequest {
  model: string;
  messages: LlmMessage[];
  maxOutputTokens: number;
  temperature?: number;
  reasoning?: ReasoningEffort;
  /** JSON 객체로만 답하도록 요청 (provider 가 거부하면 프롬프트 지시만으로 재시도) */
  json?: boolean;
  tools?: LlmToolDefinition[];
  /** 'none' 이면 Tool 정의는 보내되 호출하지 않고 글로만 답하게 한다 */
  toolChoice?: 'auto' | 'none';
  signal?: AbortSignal;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
}

export interface LlmResponse {
  model: string;
  content: string;
  toolCalls: LlmToolCall[];
  finishReason: string | null;
  usage: LlmUsage;
}

export type LlmStreamEvent =
  { type: 'text'; text: string } | { type: 'done'; response: LlmResponse };

export interface LlmClient {
  complete(request: LlmRequest): Promise<LlmResponse>;
  stream(request: LlmRequest): AsyncGenerator<LlmStreamEvent>;
}

export type LlmErrorCode =
  | 'not_configured'
  | 'auth'
  | 'rate_limit'
  | 'bad_request'
  | 'server'
  | 'network'
  | 'timeout'
  | 'invalid_response';

export class LlmError extends Error {
  constructor(
    readonly code: LlmErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }

  get retryable(): boolean {
    return ['rate_limit', 'server', 'network', 'timeout'].includes(this.code);
  }
}

export const emptyUsage = (): LlmUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedInputTokens: 0,
});

export function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
  };
}
