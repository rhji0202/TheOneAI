import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { PrismaService, type TenantTx } from '../infrastructure/database/prisma.service.js';
import { toConnectionError } from './mcp-connection.service.js';
import { type ChangeCounts, isRegistered, McpDiscoveryService } from './mcp-discovery.service.js';

export type SyncResult =
  | { status: 'connected'; changes: ChangeCounts }
  | { status: 'error'; error: string }
  | { status: 'skipped' };

/**
 * mcp-sync — 등록된 MCP 서버를 주기적으로 다시 탐색한다 (docs/api-spec.md §6).
 *  - Tool 추가 · 삭제 · 스키마 · 설명 변경은 pending_change 로만 기록 (운영자 승인 후 새 Registry 버전)
 *  - 연결 실패 → status = error (Tool 은 실행 시점에 제외), 다시 성공하면 connected 로 복구
 *  - 헬스: 최근 24시간 Tool 호출의 p95 응답 시간 · 오류율
 */
@Injectable()
export class McpSyncService {
  private readonly logger = new Logger(McpSyncService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly discovery: McpDiscoveryService,
  ) {}

  /** 재탐색 시기가 된 서버들을 차례로 확인한다 (테넌트 횡단 조회는 SECURITY DEFINER 함수로) */
  async tick(limit = 20): Promise<number> {
    const due = await this.prisma.$queryRaw<Array<{ server_id: string; tenant_id: string }>>`
      SELECT server_id, tenant_id
      FROM app_list_mcp_servers_due_for_sync(make_interval(secs => ${this.config.mcp.syncIntervalSec}), ${limit}::int)`;
    for (const row of due) {
      await this.syncServer(row.tenant_id, row.server_id).catch((err: unknown) =>
        this.logger.error(`MCP 재탐색 실패 (${row.server_id}): ${String(err)}`),
      );
    }
    return due.length;
  }

  async syncServer(tenantId: string, serverId: string): Promise<SyncResult> {
    const server = await this.prisma.withTenant(tenantId, (tx) =>
      tx.mcpServer.findFirst({ where: { id: serverId, deletedAt: null } }),
    );
    if (!server || !isRegistered(server)) return { status: 'skipped' };

    let found: Awaited<ReturnType<McpDiscoveryService['discover']>>;
    try {
      found = await this.discovery.discover(server);
    } catch (err) {
      const message = toConnectionError(err).message.slice(0, 500);
      await this.prisma.withTenant(tenantId, async (tx) => {
        await tx.mcpServer.update({
          where: { id: serverId },
          data: { status: 'error', statusReason: message, lastSyncedAt: new Date() },
        });
        await this.updateHealth(tx, serverId);
      });
      if (server.status !== 'error')
        this.logger.warn(`MCP 서버 오류 → 제외: ${server.name} (${message})`);
      return { status: 'error', error: message };
    }

    const changes = await this.prisma.withTenant(tenantId, async (tx) => {
      const counts = await this.discovery.recordChanges(tx, server, found.tools);
      await tx.mcpServer.update({
        where: { id: serverId },
        data: {
          status: 'connected',
          statusReason: null,
          lastSyncedAt: new Date(),
          protocolVersion: found.protocolVersion,
        },
      });
      await this.updateHealth(tx, serverId);
      return counts;
    });
    if (server.status === 'error') this.logger.log(`MCP 서버 복구: ${server.name}`);
    if (changes.added || changes.changed || changes.removed) {
      this.logger.log(
        `MCP 변경 감지 (${server.name}): +${changes.added} ~${changes.changed} -${changes.removed} — 운영자 검토 대기`,
      );
    }
    return { status: 'connected', changes };
  }

  /** 최근 24시간 이 서버 Tool 호출의 p95 · 오류율 (모델의 인자 오류는 서버 오류가 아니므로 제외) */
  private async updateHealth(tx: TenantTx, serverId: string): Promise<void> {
    const [row] = await tx.$queryRaw<Array<{ p95: number | null; error_rate: number | null }>>`
      SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY e.duration_ms)::float8 AS p95,
             avg(CASE WHEN e.status IN ('failed', 'timeout') THEN 1.0 ELSE 0.0 END)::float8 AS error_rate
      FROM tool_executions e
      JOIN mcp_tools t ON t.id = e.mcp_tool_id
      WHERE t.server_id = ${serverId}::uuid
        AND e.started_at > now() - interval '24 hours'
        AND e.status IN ('succeeded', 'failed', 'timeout')
        AND e.error_code IS DISTINCT FROM 'INVALID_ARGUMENTS'`;
    await tx.mcpServer.update({
      where: { id: serverId },
      data: {
        healthP95Ms: row?.p95 == null ? null : Math.round(row.p95),
        healthErrorRate: row?.error_rate ?? null,
      },
    });
  }
}
