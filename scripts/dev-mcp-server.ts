/**
 * 개발용 데모 MCP 서버 (Streamable HTTP, stateless) — 가상의 쇼핑몰 주문 · FAQ · 문의 Tool.
 *   npm run dev:mcp-server -- [--port 3901] [--key <API Key>]
 * 콘솔에서 연결: endpointUrl http://127.0.0.1:3901/mcp, allowPrivateNetwork true (Owner),
 * API 서버 · Worker 는 MCP_ALLOW_INSECURE_HTTP=true 로 실행 (개발 전용 — production 에서는 https 만).
 */
import { createServer, type IncomingMessage } from 'node:http';
import { parseArgs } from 'node:util';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  type CallToolResult,
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

const { values } = parseArgs({
  options: { port: { type: 'string', default: '3901' }, key: { type: 'string' } },
});

const ORDERS: Record<
  string,
  { status: string; items: string[]; eta: string | null; carrier: string | null }
> = {
  'A-1001': { status: '배송 중', items: ['무선 이어폰'], eta: '2026-11-14', carrier: 'CJ대한통운' },
  'A-1002': { status: '결제 완료', items: ['USB-C 케이블 2개'], eta: '2026-11-16', carrier: null },
  'A-1003': { status: '배송 완료', items: ['노트북 파우치'], eta: null, carrier: '우체국택배' },
};

const FAQ = [
  {
    q: '반품 기간',
    a: '상품 수령 후 7일 이내 반품 신청할 수 있습니다. 단순 변심은 왕복 배송비 6,000원.',
  },
  { q: '배송 기간', a: '결제 후 평균 1~3 영업일. 도서 산간은 2일 추가.' },
  { q: '교환', a: '같은 상품의 옵션 교환만 가능하며 수령 후 7일 이내 신청합니다.' },
];

type Handler = (args: Record<string, unknown>) => CallToolResult;

const TOOLS: Array<Tool & { handler: Handler }> = [
  {
    name: 'lookup_order',
    description: '주문 번호로 주문 상태 · 상품 · 도착 예정일을 조회합니다.',
    inputSchema: {
      type: 'object',
      properties: { orderId: { type: 'string', description: '주문 번호 (예: A-1001)' } },
      required: ['orderId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    handler: ({ orderId }) => {
      const order = ORDERS[String(orderId)];
      if (!order)
        return {
          isError: true,
          content: [{ type: 'text', text: `주문 ${String(orderId)} 을 찾을 수 없습니다` }],
        };
      const data = { orderId: String(orderId), ...order };
      return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
    },
  },
  {
    name: 'search_faq',
    description: '쇼핑몰 자주 묻는 질문(반품 · 배송 · 교환)을 검색합니다.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: '검색어' } },
      required: ['query'],
    },
    annotations: { readOnlyHint: true },
    handler: ({ query }) => {
      const q = String(query);
      const hits = FAQ.filter((f) =>
        q.split(/\s+/).some((w) => w && (f.q.includes(w) || f.a.includes(w))),
      );
      return {
        content: [
          { type: 'text', text: JSON.stringify({ query: q, results: hits.length ? hits : FAQ }) },
        ],
      };
    },
  },
  {
    name: 'create_ticket',
    description: '상담원에게 전달할 문의 티켓을 만듭니다.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: '제목' },
        body: { type: 'string', description: '문의 내용' },
      },
      required: ['subject', 'body'],
    },
    handler: ({ subject }) => ({
      content: [{ type: 'text', text: `티켓 T-${Date.now() % 10000} 생성: ${String(subject)}` }],
    }),
  },
];

function buildServer(): Server {
  const server = new Server(
    { name: 'demo-shop', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOLS.map(({ handler: _h, ...t }) => t),
  }));
  server.setRequestHandler(CallToolRequestSchema, (req) => {
    const tool = TOOLS.find((t) => t.name === req.params.name);
    console.log(`tools/call ${req.params.name} ${JSON.stringify(req.params.arguments ?? {})}`);
    return tool
      ? tool.handler((req.params.arguments ?? {}) as Record<string, unknown>)
      : { isError: true, content: [{ type: 'text', text: 'unknown tool' }] };
  });
  return server;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of req) raw += (chunk as Buffer).toString();
  return raw ? JSON.parse(raw) : undefined;
}

const http = createServer((req, res) => {
  void (async () => {
    if (values.key && req.headers.authorization !== `Bearer ${values.key}`) {
      res.writeHead(401).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const body = await readJson(req);
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  })().catch((err: unknown) => {
    if (!res.headersSent) res.writeHead(500).end(String(err));
  });
});

http.listen(Number(values.port), '127.0.0.1', () => {
  console.log(
    `데모 MCP 서버: http://127.0.0.1:${values.port}/mcp${values.key ? ' (API Key 필요)' : ''}`,
  );
});
