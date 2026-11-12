import { Injectable } from '@nestjs/common';
import type { McpServer } from '../generated/prisma/client.js';
import { PrismaService } from '../infrastructure/database/prisma.service.js';
import type { McpServerTarget } from '../mcp/mcp-connection.service.js';
import { toTarget } from '../mcp/mcp-discovery.service.js';
import type { ResolvedTool } from './tool-registry.service.js';

/**
 * ok          : 사용 가능
 * not_allowed : 이 Agent 버전의 허용 목록에 없는 MCP 서버 (모델에게 보이지 않았어야 함 → 무단 호출)
 * unavailable : 서버가 오류 · 비활성 · 삭제 상태이거나 운영자가 Tool 을 껐음 (작업 중에 바뀔 수 있음)
 */
export type Availability = 'ok' | 'not_allowed' | 'unavailable';

/** 작업이 고정한 Registry 버전의 MCP Tool 을 지금 쓸 수 있는가 — 서버 상태 · Tool 사용 여부 · Agent 허용 목록 */
export class ToolAvailability {
  constructor(
    private readonly allowedServers: Set<string>,
    private readonly servers: Map<string, McpServer>,
    private readonly tools: Map<string, { enabled: boolean; state: string }>,
  ) {}

  check(tool: ResolvedTool): Availability {
    if (tool.source !== 'mcp') return 'ok';
    if (!tool.mcpServerId || !this.allowedServers.has(tool.mcpServerId)) return 'not_allowed';
    const server = this.servers.get(tool.mcpServerId);
    if (!server || server.deletedAt || server.status !== 'connected') return 'unavailable';
    const row = tool.mcpToolId ? this.tools.get(tool.mcpToolId) : undefined;
    if (!row || !row.enabled || row.state === 'removed') return 'unavailable';
    return 'ok';
  }

  target(serverId: string): McpServerTarget | undefined {
    const server = this.servers.get(serverId);
    return server ? toTarget(server) : undefined;
  }
}

@Injectable()
export class ToolAvailabilityService {
  constructor(private readonly prisma: PrismaService) {}

  /** Context 구성 때와 Tool 호출 직전마다 읽는다 — 서버 비활성화 · 오류가 실행 중 작업에도 바로 반영되도록 */
  async load(tenantId: string, agentVersionId: string): Promise<ToolAvailability> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const allowed = await tx.agentVersionMcpServer.findMany({
        where: { agentVersionId, enabled: true },
        select: { mcpServerId: true },
      });
      const serverIds = allowed.map((a) => a.mcpServerId);
      const [servers, tools] = serverIds.length
        ? await Promise.all([
            tx.mcpServer.findMany({ where: { id: { in: serverIds } } }),
            tx.mcpTool.findMany({
              where: { serverId: { in: serverIds } },
              select: { id: true, enabled: true, state: true },
            }),
          ])
        : [[], []];
      return new ToolAvailability(
        new Set(serverIds),
        new Map(servers.map((s) => [s.id, s])),
        new Map(tools.map((t) => [t.id, { enabled: t.enabled, state: t.state }])),
      );
    });
  }
}
