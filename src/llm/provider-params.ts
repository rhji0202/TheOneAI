import type { LlmMessage, LlmProviderKind, LlmRequest, ReasoningEffort } from './llm.types.js';

/** 각 사의 OpenAI 호환 Chat Completions 엔드포인트 (base URL + /chat/completions) */
export const DEFAULT_BASE_URLS: Record<LlmProviderKind, string | null> = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  openai_compatible: null,
};

export const SUPPORTED_PROVIDER_KINDS = Object.keys(DEFAULT_BASE_URLS) as LlmProviderKind[];

export function isSupportedProviderKind(kind: string): kind is LlmProviderKind {
  return (SUPPORTED_PROVIDER_KINDS as string[]).includes(kind);
}

/**
 * provider 별 요청 본문. 공통 OpenAI 형식에 차이만 반영한다.
 *  - 출력 토큰: OpenAI 는 max_completion_tokens, 나머지는 max_tokens
 *  - 추론 강도:
 *      deepseek  off → thinking: { type: 'disabled' } / 그 외 → reasoning_effort (low · high · max, medium → high)
 *      openai · gemini · 기타  off → 보내지 않음 / 그 외 → reasoning_effort (low · medium · high, max → high)
 *  - temperature: 추론 모델은 무시하거나 거부하므로 추론을 끄거나 지정하지 않은 경우에만 보낸다.
 */
export function buildChatBody(
  kind: LlmProviderKind,
  request: LlmRequest,
  options: { stream: boolean; json: boolean },
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages.map(toWireMessage),
  };

  if (kind === 'openai') body.max_completion_tokens = request.maxOutputTokens;
  else body.max_tokens = request.maxOutputTokens;

  Object.assign(body, reasoningParams(kind, request.reasoning));

  if (
    request.temperature !== undefined &&
    (request.reasoning === undefined || request.reasoning === 'off')
  ) {
    body.temperature = request.temperature;
  }
  if (options.json) body.response_format = { type: 'json_object' };
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
    if (request.toolChoice) body.tool_choice = request.toolChoice;
  }
  if (options.stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  return body;
}

function reasoningParams(
  kind: LlmProviderKind,
  effort: ReasoningEffort | undefined,
): Record<string, unknown> {
  if (effort === undefined) return {};
  if (kind === 'deepseek') {
    if (effort === 'off') return { thinking: { type: 'disabled' } };
    return { reasoning_effort: effort === 'medium' ? 'high' : effort };
  }
  if (effort === 'off') return {};
  return { reasoning_effort: effort === 'max' ? 'high' : effort };
}

function toWireMessage(message: LlmMessage): Record<string, unknown> {
  switch (message.role) {
    case 'assistant':
      return {
        role: 'assistant',
        content: message.content,
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: call.arguments },
              })),
            }
          : {}),
      };
    case 'tool':
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
    default:
      return { role: message.role, content: message.content };
  }
}
