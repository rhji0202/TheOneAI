/** fetch 기반 SSE — Authorization 헤더를 보내고, 끊기면 Last-Event-ID 로 이어서 받는다 (EventSource 는 헤더를 못 보냄) */
export interface SseMessage {
  id: string | null;
  event: string;
  data: unknown;
}

export interface SseOptions {
  url: string;
  token: () => string | null;
  lastEventId?: string | null;
  onEvent: (message: SseMessage) => void;
  onStatus?: (status: 'connecting' | 'open' | 'reconnecting' | 'closed') => void;
  /** 서버가 스트림을 닫으면(작업 종료) 다시 연결하지 않는다 */
  reconnectOnEnd?: boolean;
  /** 이 시간 동안 아무것도(heartbeat 포함) 오지 않으면 끊긴 것으로 본다 */
  idleTimeoutMs?: number;
}

export function openSse(options: SseOptions): () => void {
  let stopped = false;
  let lastId = options.lastEventId ?? null;
  let controller: AbortController | null = null;
  let attempt = 0;

  const run = async () => {
    while (!stopped) {
      controller = new AbortController();
      const current = controller;
      let idle: ReturnType<typeof setTimeout> | undefined;
      const bump = () => {
        clearTimeout(idle);
        idle = setTimeout(() => current.abort(), options.idleTimeoutMs ?? 75_000);
      };
      options.onStatus?.(attempt === 0 ? 'connecting' : 'reconnecting');
      let ended = false;
      try {
        const token = options.token();
        const res = await fetch(options.url, {
          headers: {
            Accept: 'text/event-stream',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(lastId ? { 'Last-Event-ID': lastId } : {}),
          },
          signal: current.signal,
          cache: 'no-store',
        });
        if (res.status === 404 || res.status === 401 || res.status === 403) {
          options.onStatus?.('closed');
          return;
        }
        if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
        options.onStatus?.('open');
        attempt = 0;
        bump();
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            ended = true;
            break;
          }
          bump();
          buffer += decoder.decode(value, { stream: true });
          let index: number;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const message = parseBlock(block);
            if (!message) continue;
            if (message.id) lastId = message.id;
            options.onEvent(message);
          }
        }
      } catch {
        // 네트워크 끊김 · 타임아웃 → 다시 연결
      } finally {
        clearTimeout(idle);
      }
      if (stopped) break;
      if (ended && !options.reconnectOnEnd) {
        options.onStatus?.('closed');
        return;
      }
      attempt += 1;
      options.onStatus?.('reconnecting');
      await new Promise((r) => setTimeout(r, Math.min(15_000, 500 * 2 ** Math.min(attempt, 5))));
    }
  };
  void run();
  return () => {
    stopped = true;
    controller?.abort();
  };
}

function parseBlock(block: string): SseMessage | null {
  let id: string | null = null;
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('id: ')) id = line.slice(4);
    else if (line.startsWith('event: ')) event = line.slice(7);
    else if (line.startsWith('data: ')) data.push(line.slice(6));
  }
  if (!data.length) return null;
  try {
    return { id, event, data: JSON.parse(data.join('\n')) };
  } catch {
    return null;
  }
}
