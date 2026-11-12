import type { CallToolResult } from '@modelcontextprotocol/client';

/** MCP 서버가 isError 로 돌려준 실패 — 전송 오류가 아니므로 다시 시도하지 않는다 */
export class ToolReportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolReportedError';
  }
}

const MAX_RESOURCE_TEXT = 4_000;

/**
 * tools/call 결과 → 모델에게 줄 값.
 *  - structuredContent 가 있으면 그것을, 없으면 text 를 (JSON 이면 파싱해서)
 *  - 이미지 · 오디오는 내용 없이 형식만 알린다 (바이너리를 모델 컨텍스트에 넣지 않음)
 */
export function mcpResultToValue(result: CallToolResult): unknown {
  const parts = Array.isArray(result.content) ? result.content : [];
  const texts: string[] = [];
  const others: Array<Record<string, unknown>> = [];
  for (const part of parts) {
    switch (part.type) {
      case 'text':
        texts.push(part.text);
        break;
      case 'image':
      case 'audio':
        others.push({ type: part.type, mimeType: part.mimeType, note: 'binary content omitted' });
        break;
      case 'resource': {
        const res = part.resource as { uri: string; mimeType?: string; text?: string };
        others.push({
          type: 'resource',
          uri: res.uri,
          ...(res.mimeType ? { mimeType: res.mimeType } : {}),
          ...(typeof res.text === 'string'
            ? { text: res.text.slice(0, MAX_RESOURCE_TEXT) }
            : { note: 'binary content omitted' }),
        });
        break;
      }
      case 'resource_link':
        others.push({ type: 'resource_link', uri: part.uri, name: part.name });
        break;
      default:
        others.push({ type: (part as { type: string }).type, note: 'unsupported content omitted' });
    }
  }

  if (result.isError) {
    throw new ToolReportedError(texts.join('\n').slice(0, 1_000) || 'the tool reported an error');
  }
  if (result.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent;
  }
  if (others.length === 0) {
    const text = texts.join('\n');
    return parseJson(text) ?? { text };
  }
  return { content: [...texts.map((text) => ({ type: 'text', text })), ...others] };
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}
