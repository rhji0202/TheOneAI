import { isIP } from 'node:net';
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import {
  type CallToolResult,
  Client,
  type ConnectOptions,
  type FetchLike,
  ProtocolError,
  SdkHttpError,
  StreamableHTTPClientTransport,
  type Tool,
} from '@modelcontextprotocol/client';
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import type { McpAuthType, McpTransport } from '../generated/prisma/client.js';
import { SecretStore } from '../infrastructure/secrets/secret-store.js';
import { ToolReportedError } from './mcp-result.js';
import {
  type BlockedReason,
  checkEndpoint,
  checkUrl,
  type EgressPolicy,
  guardedLookup,
  ipBlockReason,
  SsrfBlockedError,
  type SsrfCheck,
} from './ssrf-guard.js';

/** 연결에 필요한 mcp_servers 컬럼 */
export interface McpServerTarget {
  id: string;
  tenantId: string;
  name: string;
  transport: McpTransport;
  endpointUrl: string | null;
  authType: McpAuthType;
  secretRef: string | null;
  allowedHosts: string[];
  allowPrivateNetwork: boolean;
  /** 마지막으로 협상한 프로토콜 버전 (2025 계열이면 재사용 연결에서 버전 탐색을 건너뛴다) */
  protocolVersion: string | null;
  updatedAt: Date;
}

export type McpConnectionErrorCode =
  | 'ssrf_blocked'
  | 'handshake_failed'
  | 'auth_failed'
  | 'unsupported_transport'
  | 'unsupported_auth';

export class McpConnectionError extends Error {
  constructor(
    readonly code: McpConnectionErrorCode,
    message: string,
    readonly blockedReason?: BlockedReason,
  ) {
    super(message);
    this.name = 'McpConnectionError';
  }
}

export interface ConnectionTestResult {
  handshake: 'ok' | 'failed';
  protocolVersion: string | null;
  /** modern = 2026-07-28 이후(요청 단위 프로토콜), legacy = 2025 계열(initialize 핸드셰이크) */
  era: 'modern' | 'legacy' | null;
  latencyMs: number | null;
  ssrf: SsrfCheck;
  server?: { name: string; version: string };
  error?: string;
}

interface Connection {
  client: Client;
  transport: StreamableHTTPClientTransport;
  agent: Agent;
}

interface PoolEntry {
  key: string;
  connection: Promise<Connection>;
  lastUsed: number;
}

const IDLE_CLOSE_MS = 5 * 60_000;
const CLIENT_INFO = { name: 'theonewidget-agent', version: '0.1.0' };

/**
 * MCP 서버 연결 (Streamable HTTP, 공식 TypeScript SDK v2 `@modelcontextprotocol/client`).
 *  - 프로토콜: 2026-07-28 을 먼저 확인(server/discover)하고, 2025 계열 서버면 initialize 핸드셰이크로 내려간다.
 *  - 탐색 · 연결 테스트는 매번 새 연결(서버 업그레이드도 감지), Tool 호출은 Worker 프로세스 안에서 재사용한다.
 * stdio(Docker Sandbox) 실행형과 OAuth 인증은 Sandbox 단계에서 추가한다.
 */
@Injectable()
export class McpConnectionService implements OnModuleDestroy {
  private readonly logger = new Logger(McpConnectionService.name);
  private readonly pool = new Map<string, PoolEntry>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly secrets: SecretStore,
  ) {
    this.sweeper = setInterval(() => this.closeIdle(), 60_000);
    this.sweeper.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.sweeper);
    await Promise.all([...this.pool.keys()].map((id) => this.invalidate(id)));
  }

  egressPolicy(
    server: Pick<McpServerTarget, 'allowedHosts' | 'allowPrivateNetwork'>,
  ): EgressPolicy {
    return {
      allowedHosts: server.allowedHosts,
      allowPrivateNetwork: server.allowPrivateNetwork,
      allowInsecureHttp: this.config.mcp.allowInsecureHttp,
    };
  }

  /** C-05 ① 연결 테스트 — SSRF 검사(DNS 해석) → initialize 핸드셰이크 */
  async test(server: McpServerTarget): Promise<ConnectionTestResult> {
    const ssrf = await checkEndpoint(server.endpointUrl ?? '', this.egressPolicy(server));
    if (!ssrf.allowed) {
      return {
        handshake: 'failed',
        protocolVersion: null,
        era: null,
        latencyMs: null,
        ssrf,
        error: `SSRF 차단: ${ssrf.blockedReason}`,
      };
    }
    const started = Date.now();
    try {
      const conn = await this.open(server);
      try {
        const info = conn.client.getServerVersion();
        return {
          handshake: 'ok',
          protocolVersion: negotiatedVersion(conn),
          era: conn.client.getProtocolEra() ?? null,
          latencyMs: Date.now() - started,
          ssrf,
          ...(info ? { server: { name: info.name, version: info.version } } : {}),
        };
      } finally {
        await this.close(conn);
      }
    } catch (err) {
      const e = toConnectionError(err);
      return {
        handshake: 'failed',
        protocolVersion: null,
        era: null,
        latencyMs: null,
        ssrf,
        error: e.message,
      };
    }
  }

  /** tools/list (SDK 가 모든 페이지를 모아 준다, 최대 64쪽). 매번 새 연결 — 이전 연결 상태 · 캐시와 무관하게 */
  async listTools(
    server: McpServerTarget,
    signal?: AbortSignal,
  ): Promise<{ tools: Tool[]; protocolVersion: string | null }> {
    const conn = await this.open(server);
    try {
      const res = await conn.client.listTools(undefined, {
        signal,
        timeout: this.config.mcp.connectTimeoutMs,
        cacheMode: 'bypass',
      });
      return { tools: res.tools, protocolVersion: negotiatedVersion(conn) };
    } catch (err) {
      throw toConnectionError(err);
    } finally {
      await this.close(conn);
    }
  }

  /**
   * tools/call. 연결은 서버 설정이 바뀌기 전까지 재사용하고, 전송 오류가 나면 버린다.
   * inputSchema 는 Registry 에 고정된 정의를 넘긴다 — 재사용 연결에서 tools/list 를 다시 부르지 않도록
   * (2026-07-28 의 Mcp-Param-* 헤더도 이 정의로 만든다).
   * 서버가 JSON-RPC 오류로 거절하면(모르는 Tool · 잘못된 인자 등) ToolReportedError — 연결은 유지하고 재시도하지 않는다.
   */
  async callTool(
    server: McpServerTarget,
    name: string,
    args: Record<string, unknown>,
    options: { signal: AbortSignal; timeoutMs: number; inputSchema?: Record<string, unknown> },
  ): Promise<CallToolResult> {
    const conn = await this.pooled(server);
    try {
      return await conn.client.callTool(
        { name, arguments: args },
        {
          signal: options.signal,
          timeout: options.timeoutMs,
          ...(options.inputSchema
            ? { toolDefinition: { name, inputSchema: options.inputSchema } as Tool }
            : {}),
        },
      );
    } catch (err) {
      if (ProtocolError.isInstance(err)) throw new ToolReportedError(err.message);
      if (!options.signal.aborted) await this.invalidate(server.id);
      throw err;
    }
  }

  async invalidate(serverId: string): Promise<void> {
    const entry = this.pool.get(serverId);
    if (!entry) return;
    this.pool.delete(serverId);
    await entry.connection.then((c) => this.close(c)).catch(() => undefined);
  }

  private async pooled(server: McpServerTarget): Promise<Connection> {
    const key = `${server.updatedAt.toISOString()}`;
    const existing = this.pool.get(server.id);
    if (existing && existing.key === key) {
      existing.lastUsed = Date.now();
      return existing.connection;
    }
    if (existing) await this.invalidate(server.id);
    // 2025 계열로 확인된 서버는 server/discover 탐색 왕복을 건너뛴다 (시기 판단은 매시간 재탐색이 갱신)
    const prior: ConnectOptions['prior'] =
      server.protocolVersion && server.protocolVersion < '2026' ? { kind: 'legacy' } : undefined;
    const connection = this.open(server, prior);
    const entry: PoolEntry = { key, connection, lastUsed: Date.now() };
    this.pool.set(server.id, entry);
    connection.catch(() => {
      if (this.pool.get(server.id) === entry) this.pool.delete(server.id);
    });
    return connection;
  }

  private async open(
    server: McpServerTarget,
    prior?: ConnectOptions['prior'],
  ): Promise<Connection> {
    if (server.transport !== 'streamable_http') {
      throw new McpConnectionError(
        'unsupported_transport',
        'stdio(Docker Sandbox) 실행형은 아직 지원하지 않습니다',
      );
    }
    if (server.authType === 'oauth') {
      throw new McpConnectionError('unsupported_auth', 'OAuth 인증은 아직 지원하지 않습니다');
    }
    let endpoint: URL;
    try {
      endpoint = new URL(server.endpointUrl ?? '');
    } catch {
      throw new McpConnectionError('handshake_failed', '엔드포인트 URL 이 올바르지 않습니다');
    }
    const policy = this.egressPolicy(server);
    const headers: Record<string, string> = {};
    if (server.authType === 'api_key') {
      const secret = server.secretRef ? await this.secrets.get(server.secretRef) : null;
      if (!secret)
        throw new McpConnectionError('auth_failed', 'API Key(Secret)를 찾을 수 없습니다');
      headers.Authorization = `Bearer ${secret}`;
    }

    const agent = new Agent({
      connect: { lookup: guardedLookup(policy), timeout: this.config.mcp.connectTimeoutMs },
      headersTimeout: this.config.mcp.toolTimeoutMs,
      bodyTimeout: 0, // SSE 응답은 길게 열려 있을 수 있다 — 요청별 timeout 으로 제한
    });
    const transport = new StreamableHTTPClientTransport(endpoint, {
      fetch: guardedFetch(endpoint, policy, agent),
      requestInit: { headers },
      reconnectionOptions: {
        maxReconnectionDelay: 5_000,
        initialReconnectionDelay: 500,
        reconnectionDelayGrowFactor: 2,
        maxRetries: 1,
      },
    });
    const client = new Client(CLIENT_INFO, {
      capabilities: {},
      versionNegotiation: {
        mode: 'auto',
        probe: { timeoutMs: this.config.mcp.connectTimeoutMs },
      },
    });
    try {
      await client.connect(transport, {
        timeout: this.config.mcp.connectTimeoutMs,
        ...(prior ? { prior } : {}),
      });
    } catch (err) {
      await client.close().catch(() => undefined);
      await agent.close().catch(() => undefined);
      throw toConnectionError(err);
    }
    return { client, transport, agent };
  }

  private async close(conn: Connection): Promise<void> {
    await conn.client.close().catch(() => undefined);
    await conn.agent.close().catch(() => undefined);
  }

  private closeIdle(): void {
    const now = Date.now();
    for (const [id, entry] of this.pool) {
      if (now - entry.lastUsed > IDLE_CLOSE_MS) {
        this.logger.debug(`유휴 MCP 연결 종료: ${id}`);
        void this.invalidate(id);
      }
    }
  }
}

function negotiatedVersion(conn: Connection): string | null {
  return conn.client.getNegotiatedProtocolVersion() ?? conn.transport.protocolVersion ?? null;
}

/** 모든 요청(리다이렉트 포함)의 스킴 · 호스트 · IP 리터럴을 검사하고, 소켓 연결은 guardedLookup 을 거친다 */
function guardedFetch(endpoint: URL, policy: EgressPolicy, agent: Agent): FetchLike {
  const endpointHost = endpoint.hostname.replace(/^\[|\]$/g, '');
  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.href);
    const urlReason = checkUrl(url, endpointHost, policy);
    if (urlReason) throw new SsrfBlockedError(urlReason, url.host);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host)) {
      const ipReason = ipBlockReason(host, policy);
      if (ipReason) throw new SsrfBlockedError(ipReason, host);
    }
    const res = await undiciFetch(url, { ...(init as UndiciRequestInit), dispatcher: agent });
    return res as unknown as Response;
  };
}

export function toConnectionError(err: unknown): McpConnectionError {
  if (err instanceof McpConnectionError) return err;
  for (
    let e: unknown = err, depth = 0;
    e && depth < 6;
    e = (e as { cause?: unknown }).cause, depth++
  ) {
    if (e instanceof SsrfBlockedError) {
      return new McpConnectionError('ssrf_blocked', e.message, e.reason);
    }
    const name = (e as { name?: string }).name;
    const status = SdkHttpError.isInstance(e) ? e.status : (e as { status?: unknown }).status;
    if (name === 'UnauthorizedError' || status === 401 || status === 403) {
      return new McpConnectionError('auth_failed', 'MCP 서버가 인증을 거부했습니다');
    }
  }
  const message = err instanceof Error ? describe(err) : String(err);
  return new McpConnectionError('handshake_failed', message);
}

function describe(err: Error): string {
  const cause = (err as { cause?: unknown }).cause;
  const detail =
    cause instanceof Error && cause.message !== err.message ? ` (${cause.message})` : '';
  return `${err.message}${detail}`.slice(0, 500);
}
