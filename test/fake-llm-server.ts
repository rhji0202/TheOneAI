import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * e2e 용 가짜 OpenAI 호환 LLM 서버 (POST /chat/completions).
 * 시스템 프롬프트 첫 줄(# Role: …)로 역할을 구분하고, 사용자 요청 속 표식으로 시나리오를 고른다.
 *   [분석]     reason 1단계 + respond
 *   [재계획]   reason → assess 가 한 번 replan → 수정 계획 → proceed
 *   [형식오류] planner 가 두 번 모두 잘못된 JSON → 기본 계획
 *   [모델오류] respond 스트림이 항상 500
 */
export interface RecordedRequest {
  role: string;
  headers: IncomingMessage['headers'];
  body: ChatBody;
}

interface ChatBody {
  model: string;
  stream?: boolean;
  messages: Array<{ role: string; content: string | null }>;
  [key: string]: unknown;
}

export interface FakeLlm {
  baseUrl: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

const USAGE = { prompt_tokens: 100, completion_tokens: 20 };

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

      const reply = (content: string) =>
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            model: body.model,
            choices: [{ message: { content }, finish_reason: 'stop' }],
            usage: USAGE,
          }),
        );

      if (role === 'Planner') {
        if (allText.includes('[형식오류]')) return reply('계획은 이렇습니다만 JSON 은 아닙니다');
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

      if (role.startsWith('Executor (reason')) {
        return reply(`분석 메모: ${/Current step \d+: ([^\n]+)/.exec(lastUser)?.[1] ?? ''} 완료`);
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
