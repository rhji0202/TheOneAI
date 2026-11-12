import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LlmError, type LlmStreamEvent } from './llm.types.js';
import { OpenAiCompatibleClient } from './openai-compatible.client.js';

type Handler = (
  req: IncomingMessage & { json: Record<string, unknown> },
  res: ServerResponse,
) => void;

let server: Server;
let baseUrl: string;
let handlers: Handler[] = [];
let received: Array<{ headers: IncomingMessage['headers']; body: Record<string, unknown> }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const json = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      received.push({ headers: req.headers, body: json });
      const handler = handlers.shift();
      if (!handler) {
        res.writeHead(500).end('no handler');
        return;
      }
      handler(Object.assign(req, { json }), res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  handlers = [];
  received = [];
});

const json =
  (status: number, body: unknown): Handler =>
  (_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  };

const completion = (content: string, extra: Record<string, unknown> = {}) =>
  json(200, {
    model: 'm',
    choices: [{ message: { content, ...extra }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      completion_tokens_details: { reasoning_tokens: 3 },
      prompt_tokens_details: { cached_tokens: 2 },
    },
  });

const sse =
  (chunks: unknown[], options: { stallAfter?: boolean } = {}): Handler =>
  (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    if (options.stallAfter) return; // 연결을 열어 둔 채 멈춤
    res.end('data: [DONE]\n\n');
  };

function client(
  kind: 'deepseek' | 'openai' | 'gemini' = 'deepseek',
  extra: Partial<ConstructorParameters<typeof OpenAiCompatibleClient>[0]> = {},
) {
  return new OpenAiCompatibleClient({
    kind,
    baseUrl,
    apiKey: 'test-key',
    retryBaseMs: 1,
    ...extra,
  });
}

async function collect(stream: AsyncGenerator<LlmStreamEvent>) {
  const events: LlmStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('요청 본문 (provider 별)', () => {
  it('DeepSeek: 추론 off → thinking disabled, max_tokens, temperature, json, 인증 헤더', async () => {
    handlers.push(completion('{"ok":true}'));
    await client('deepseek').complete({
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 100,
      temperature: 0.2,
      reasoning: 'off',
      json: true,
    });
    const { headers, body } = received[0]!;
    expect(headers.authorization).toBe('Bearer test-key');
    expect(body).toMatchObject({
      model: 'deepseek-flash',
      max_tokens: 100,
      temperature: 0.2,
      thinking: { type: 'disabled' },
      response_format: { type: 'json_object' },
    });
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('DeepSeek: medium 은 high 로, temperature 는 추론 중 보내지 않는다', async () => {
    handlers.push(completion('x'));
    await client('deepseek').complete({
      model: 'd',
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 10,
      temperature: 0.5,
      reasoning: 'medium',
    });
    expect(received[0]!.body).toMatchObject({ reasoning_effort: 'high' });
    expect(received[0]!.body).not.toHaveProperty('temperature');
    expect(received[0]!.body).not.toHaveProperty('thinking');
  });

  it('OpenAI: max_completion_tokens, max → high, off 는 아무것도 보내지 않음', async () => {
    handlers.push(completion('x'), completion('y'));
    const c = client('openai');
    await c.complete({
      model: 'o',
      messages: [{ role: 'user', content: 'a' }],
      maxOutputTokens: 50,
      reasoning: 'max',
    });
    await c.complete({
      model: 'o',
      messages: [{ role: 'user', content: 'a' }],
      maxOutputTokens: 50,
      reasoning: 'off',
    });
    expect(received[0]!.body).toMatchObject({
      max_completion_tokens: 50,
      reasoning_effort: 'high',
    });
    expect(received[0]!.body).not.toHaveProperty('max_tokens');
    expect(received[1]!.body).not.toHaveProperty('reasoning_effort');
    expect(received[1]!.body).not.toHaveProperty('thinking');
  });

  it('assistant tool_calls · tool 메시지 · tools 정의를 OpenAI 형식으로 보낸다', async () => {
    handlers.push(completion('done'));
    await client('gemini').complete({
      model: 'g',
      maxOutputTokens: 10,
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: null,
          toolCalls: [{ id: 'c1', name: 'get_weather', arguments: '{"city":"Seoul"}' }],
        },
        { role: 'tool', toolCallId: 'c1', content: '{"temp":3}' },
      ],
      tools: [{ name: 'get_weather', description: 'w', parameters: { type: 'object' } }],
    });
    const body = received[0]!.body as { messages: unknown[]; tools: unknown[] };
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"Seoul"}' },
        },
      ],
    });
    expect(body.messages[2]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '{"temp":3}' });
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: { name: 'get_weather', description: 'w', parameters: { type: 'object' } },
      },
    ]);
  });
});

describe('complete()', () => {
  it('본문 · tool call · usage 를 읽는다', async () => {
    handlers.push(
      completion('hello', {
        tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{}' } }],
      }),
    );
    const res = await client().complete({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 10,
    });
    expect(res.content).toBe('hello');
    expect(res.toolCalls).toEqual([{ id: 't1', name: 'f', arguments: '{}' }]);
    expect(res.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 3,
      cachedInputTokens: 2,
    });
  });

  it('5xx · 429 는 재시도하고 성공하면 결과를 준다', async () => {
    handlers.push(
      json(503, { error: { message: 'busy' } }),
      json(429, { error: 'slow down' }),
      completion('ok'),
    );
    const res = await client().complete({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 10,
    });
    expect(res.content).toBe('ok');
    expect(received).toHaveLength(3);
  });

  it('재시도 한도를 넘으면 LlmError(server)', async () => {
    handlers.push(json(500, {}), json(500, {}), json(500, {}));
    const err = await client()
      .complete({ model: 'm', messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 10 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).code).toBe('server');
    expect(received).toHaveLength(3);
  });

  it('401 · 400 은 재시도하지 않는다', async () => {
    handlers.push(json(401, { error: { message: 'invalid api key' } }));
    const auth = await client()
      .complete({ model: 'm', messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 10 })
      .catch((e: unknown) => e);
    expect(auth).toMatchObject({ code: 'auth', status: 401 });
    expect((auth as LlmError).message).toContain('invalid api key');
    expect(received).toHaveLength(1);
  });

  it('json 모드를 거부하면 json 없이 한 번 더 보낸다', async () => {
    handlers.push(
      json(400, { error: { message: 'response_format is not supported' } }),
      completion('{"a":1}'),
    );
    const res = await client().complete({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 10,
      json: true,
    });
    expect(res.content).toBe('{"a":1}');
    expect(received[0]!.body).toHaveProperty('response_format');
    expect(received[1]!.body).not.toHaveProperty('response_format');
  });

  it('호출 측 취소는 원래 사유로 끝난다', async () => {
    handlers.push((_req, res) => setTimeout(() => res.writeHead(200).end('{}'), 500));
    const controller = new AbortController();
    const reason = new Error('cancelled by user');
    const promise = client().complete({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 10,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(reason), 20);
    await expect(promise).rejects.toBe(reason);
  });
});

describe('stream()', () => {
  it('텍스트 delta 를 흘리고, tool call 조각과 마지막 usage 를 모은다', async () => {
    handlers.push(
      sse([
        { model: 'deepseek-flash', choices: [{ delta: { content: '안녕' } }] },
        { choices: [{ delta: { content: '하세요' } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'c1', function: { name: 'look', arguments: '{"q":' } },
                ],
              },
            },
          ],
        },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] } }] },
        {
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 7, completion_tokens: 4 },
        },
      ]),
    );
    const events = await collect(
      client().stream({
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
        maxOutputTokens: 10,
      }),
    );
    expect(
      events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text),
    ).toEqual(['안녕', '하세요']);
    const done = events.at(-1) as Extract<LlmStreamEvent, { type: 'done' }>;
    expect(done.response).toMatchObject({
      model: 'deepseek-flash',
      content: '안녕하세요',
      finishReason: 'stop',
      toolCalls: [{ id: 'c1', name: 'look', arguments: '{"q":"x"}' }],
      usage: { inputTokens: 7, outputTokens: 4 },
    });
    expect(received[0]!.body).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it('청크가 멈추면 idle timeout 으로 실패한다', async () => {
    handlers.push(sse([{ choices: [{ delta: { content: 'a' } }] }], { stallAfter: true }));
    const err = await collect(
      client('deepseek', { idleTimeoutMs: 100 }).stream({
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
        maxOutputTokens: 10,
      }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).code).toBe('timeout');
  });

  it('응답 헤더 전 5xx 는 재시도한다', async () => {
    handlers.push(json(502, {}), sse([{ choices: [{ delta: { content: 'ok' } }] }]));
    const events = await collect(
      client().stream({
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
        maxOutputTokens: 10,
      }),
    );
    expect((events.at(-1) as Extract<LlmStreamEvent, { type: 'done' }>).response.content).toBe(
      'ok',
    );
    expect(received).toHaveLength(2);
  });
});
