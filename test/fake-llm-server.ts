import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * e2e 용 가짜 OpenAI 호환 LLM 서버 (POST /chat/completions).
 * 시스템 프롬프트 첫 줄(# Role: …)로 역할을 구분하고, 사용자 요청 속 표식으로 시나리오를 고른다.
 *   [분석]       reason 1단계 + respond
 *   [재계획]     reason → assess 가 한 번 replan → 수정 계획 → proceed
 *   [형식오류]   planner 가 두 번 모두 잘못된 JSON → 기본 계획
 *   [모델오류]   respond 스트림이 항상 500
 * Tool 시나리오 (작업 단계에서 모델이 tool_calls 를 돌려준다)
 *   [도구]       calculate 1회 → 결과로 메모
 *   [병렬]       읽기 Tool 2개를 한 응답에서 동시에
 *   [무단]       Registry 에 없는 Tool 호출
 *   [승인필요]   planner 가 승인 필요 Tool 을 계획 → 형식 오류로 고침, 작업 단계에서 호출 → 승인 필요로 거부
 *   [규칙차단]   정책 규칙(식에 666 포함 차단)에 걸리는 calculate
 *   [잘못된인자] 인자 오류 → 고쳐서 다시 호출
 *   [도구한도]   Tool 을 끝없이 호출 → 왕복 한도 후 tool_choice=none 으로 정리
 *   [재시도]     첫 시도에 실패하는 멱등 Tool (테스트가 등록) → 재시도 후 성공
 *   [시간초과]   시간 제한을 넘기는 Tool (테스트가 등록)
 */
export interface RecordedRequest {
  role: string;
  headers: IncomingMessage['headers'];
  body: ChatBody;
}

export interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: string;
  content: string | null;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
}

export interface ChatBody {
  model: string;
  stream?: boolean;
  messages: ChatMessage[];
  tools?: Array<{
    type: 'function';
    function: { name: string; description: string; parameters: unknown };
  }>;
  tool_choice?: string;
  [key: string]: unknown;
}

export interface FakeLlm {
  baseUrl: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

const USAGE = { prompt_tokens: 100, completion_tokens: 20 };

type Call = [name: string, args: unknown];

/** 작업 단계에서 시나리오별로 부를 Tool — round 는 이 단계에서 이미 끝난 Tool 왕복 수 */
function scripted(text: string, round: number, toolsOffered: boolean): Call[] | null {
  if (text.includes('[도구한도]'))
    return toolsOffered ? [['builtin__calculate', { expression: `${round}+1` }]] : null;
  if (round > 0 && !text.includes('[잘못된인자]')) return null;
  if (text.includes('[도구]')) return [['builtin__calculate', { expression: '1234*5678' }]];
  if (text.includes('[병렬]')) {
    return [
      ['builtin__calculate', { expression: '2^10' }],
      ['builtin__current_time', { timezone: 'Asia/Seoul' }],
    ];
  }
  if (text.includes('[무단]')) return [['shell__exec', { cmd: 'cat /etc/passwd' }]];
  if (text.includes('[승인필요]'))
    return [['test__send_note', { to: 'ops@example.com', text: '안녕하세요' }]];
  if (text.includes('[규칙차단]')) return [['builtin__calculate', { expression: '666+1' }]];
  if (text.includes('[재시도]')) return [['test__flaky', { key: 'stock' }]];
  if (text.includes('[시간초과]')) return [['test__slow', {}]];
  if (text.includes('[잘못된인자]')) {
    if (round === 0) return [['builtin__calculate', '{"expr":"1+1"']]; // JSON 도 깨짐
    if (round === 1) return [['builtin__calculate', { expr: '1+1' }]]; // 필드 이름 틀림
    if (round === 2) return [['builtin__calculate', { expression: '1+1' }]];
  }
  return null;
}

/** Tool 시나리오의 계획 — 계획 단계의 kind 를 tool 로 둔다 */
function toolPlan(text: string, lastUser: string): Record<string, unknown> | null {
  const tool = (title: string, name: string) => ({
    title,
    kind: 'tool',
    tool: name,
    instructions: title,
  });
  const respond = { title: '답변 작성', kind: 'respond', instructions: '' };
  if (text.includes('[승인필요]')) {
    // 첫 시도는 승인이 필요한 Tool 을 계획 → 서버가 거절하면 reason 으로 고친다
    const corrected = lastUser.includes('is invalid');
    return {
      goal: '메모 보내기',
      steps: [
        corrected
          ? { title: '메모 전송 시도', kind: 'reason', instructions: '' }
          : tool('메모 전송', 'test__send_note'),
        respond,
      ],
    };
  }
  if (text.includes('[병렬]'))
    return {
      goal: '계산과 시간',
      steps: [tool('계산 · 시간 확인', 'builtin__calculate'), respond],
    };
  if (text.includes('[무단]'))
    return {
      goal: '파일 보기',
      steps: [{ title: '파일 확인', kind: 'reason', instructions: '' }, respond],
    };
  if (text.includes('[재시도]'))
    return { goal: '재고 조회', steps: [tool('재고 조회', 'test__flaky'), respond] };
  if (text.includes('[시간초과]'))
    return { goal: '느린 조회', steps: [tool('느린 조회', 'test__slow'), respond] };
  for (const tag of ['[도구]', '[규칙차단]', '[잘못된인자]', '[도구한도]']) {
    if (text.includes(tag))
      return { goal: '계산', steps: [tool('계산', 'builtin__calculate'), respond] };
  }
  return null;
}

export async function startFakeLlm(options: { chunkDelayMs?: number } = {}): Promise<FakeLlm> {
  const requests: RecordedRequest[] = [];
  const delay = options.chunkDelayMs ?? 15;

  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const body = JSON.parse(raw) as ChatBody;
      const system = body.messages[0]?.content ?? '';
      const lastUser = [...body.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      const allText = body.messages.map((m) => m.content ?? '').join('\n');
      const role = /# Role: ([^\n]+)/.exec(system)?.[1]?.trim() ?? 'unknown';
      const mode = /Mode: (\w+)/.exec(system)?.[1];
      requests.push({ role: mode ? `${role}:${mode}` : role, headers: req.headers, body });

      const reply = (content: string | null, toolCalls: WireToolCall[] = []) =>
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            model: body.model,
            choices: [
              {
                message: { content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
                finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
              },
            ],
            usage: USAGE,
          }),
        );

      if (role === 'Planner') {
        if (allText.includes('[형식오류]')) return reply('계획은 이렇습니다만 JSON 은 아닙니다');
        const forTools = toolPlan(allText, lastUser);
        if (forTools) return reply(JSON.stringify(forTools));
        if (allText.includes('[재계획]')) {
          const revised = lastUser.includes('Evaluator feedback');
          return reply(
            JSON.stringify({
              goal: '재계획 시나리오',
              steps: [
                {
                  title: revised ? '보완 분석' : '초기 분석',
                  kind: 'reason',
                  instructions: '분석',
                },
                { title: '답변 작성', kind: 'respond', instructions: '' },
              ],
            }),
          );
        }
        if (allText.includes('[분석]')) {
          return reply(
            '```json\n' +
              JSON.stringify({
                goal: '분석 후 답변',
                steps: [
                  { title: '요구사항 분석', kind: 'reason', instructions: '핵심을 정리' },
                  { title: '답변 작성', kind: 'respond', instructions: '' },
                ],
              }) +
              '\n```',
          );
        }
        return reply(
          JSON.stringify({
            goal: '바로 답변',
            steps: [{ title: '답변 작성', kind: 'respond', instructions: '' }],
          }),
        );
      }

      if (role.startsWith('Executor (work')) {
        const round = body.messages.filter(
          (m) => m.role === 'assistant' && m.tool_calls?.length,
        ).length;
        const toolsOffered = (body.tools?.length ?? 0) > 0 && body.tool_choice !== 'none';
        const calls = scripted(allText, round, toolsOffered);
        if (calls) {
          return reply(
            null,
            calls.map(([name, args], i) => ({
              id: `call_${round}_${i}`,
              type: 'function' as const,
              function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
            })),
          );
        }
        const results = body.messages.filter((m) => m.role === 'tool').map((m) => m.content);
        const stepTitle = /Current step \d+: ([^\n]+)/.exec(allText)?.[1] ?? '';
        return reply(
          results.length
            ? `도구 메모: ${stepTitle} — ${results.join(' | ')}`
            : `분석 메모: ${stepTitle} 완료`,
        );
      }

      if (role === 'Evaluator' && mode === 'assess') {
        const replan = allText.includes('[재계획]') && !allText.includes('### Note 2');
        return reply(
          JSON.stringify(
            replan
              ? { verdict: 'replan', reason: '근거가 부족합니다' }
              : { verdict: 'proceed', reason: '' },
          ),
        );
      }

      if (role === 'Evaluator' && mode === 'verify') {
        return reply(
          JSON.stringify({
            verdict: 'pass',
            checks: [
              { label: '요청에 답함', passed: true },
              { label: '사용자 언어로 작성', passed: true },
            ],
            summary: '요청에 맞게 답했습니다',
          }),
        );
      }

      if (role.startsWith('Executor (respond')) {
        if (allText.includes('[모델오류]')) {
          res
            .writeHead(500, { 'Content-Type': 'application/json' })
            .end(JSON.stringify({ error: { message: 'upstream exploded' } }));
          return;
        }
        const answer = `요청하신 내용에 대한 답변입니다. ${lastUser.slice(0, 40)} — 차근차근 정리해 드릴게요. 끝.`;
        const pieces = answer.match(/\S+\s*/g) ?? [answer];
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        let i = 0;
        const timer = setInterval(() => {
          if (res.destroyed) return clearInterval(timer);
          if (i < pieces.length) {
            res.write(
              `data: ${JSON.stringify({ model: body.model, choices: [{ delta: { content: pieces[i++] } }] })}\n\n`,
            );
            return;
          }
          clearInterval(timer);
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: USAGE })}\n\n`,
          );
          res.end('data: [DONE]\n\n');
        }, delay);
        return;
      }

      res
        .writeHead(400, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: { message: `unknown role ${role}` } }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
