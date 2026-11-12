import { Injectable } from '@nestjs/common';
import { type McpServer, type McpTool, Prisma } from '../generated/prisma/client.js';
import type { TenantTx } from '../infrastructure/database/prisma.service.js';
import { McpConnectionService, type McpServerTarget } from './mcp-connection.service.js';
import { type CheckedTool, checkTool } from './mcp-tool-checks.js';

/** mcp_tools.pending_change — 재탐색에서 감지한 변경 (운영자 승인 전까지 Registry 에 반영하지 않는다) */
export interface PendingChange {
  kind: 'added' | 'changed' | 'removed';
  detectedAt: string;
  /** added · changed: 서버가 지금 알려 주는 정의 */
  next?: ToolDefinitionSnapshot;
}

export interface ToolDefinitionSnapshot {
  title: string | null;
  description: string | null;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  schemaHash: string;
  schema: CheckedTool['schema'];
  security: CheckedTool['security'];
  suggestedLevel: CheckedTool['suggestedLevel'];
}

export interface ChangeCounts {
  added: number;
  changed: number;
  removed: number;
}

export function toTarget(server: McpServer): McpServerTarget {
  return {
    id: server.id,
    tenantId: server.tenantId,
    name: server.name,
    transport: server.transport,
    endpointUrl: server.endpointUrl,
    authType: server.authType,
    secretRef: server.secretRef,
    allowedHosts: server.allowedHosts,
    allowPrivateNetwork: server.allowPrivateNetwork,
    protocolVersion: server.protocolVersion,
    updatedAt: server.updatedAt,
  };
}

/** 등록된 서버인가 (변경은 검토를 거쳐야 한다) */
export function isRegistered(server: Pick<McpServer, 'status'>): boolean {
  return server.status === 'connected' || server.status === 'error';
}

/**
 * Tool 탐색 결과를 mcp_tools 에 반영한다.
 *  - 등록 전 서버(draft · pending_review · disabled): 바로 반영 — 운영자가 C-05 ③ · ④에서 검토한다.
 *  - 등록된 서버(connected · error): 추가 · 변경 · 삭제를 pending_change 로만 기록 (Tool 설명 변조 대응).
 */
@Injectable()
export class McpDiscoveryService {
  constructor(private readonly connections: McpConnectionService) {}

  async discover(
    server: McpServer,
    signal?: AbortSignal,
  ): Promise<{ tools: CheckedTool[]; protocolVersion: string | null }> {
    const { tools, protocolVersion } = await this.connections.listTools(toTarget(server), signal);
    const seen = new Set<string>();
    const checked: CheckedTool[] = [];
    for (const tool of tools) {
      if (seen.has(tool.name)) continue; // 같은 이름이 두 번 오면 첫 정의만
      seen.add(tool.name);
      checked.push(checkTool(tool, server.name));
    }
    return { tools: checked, protocolVersion };
  }

  /** 등록 전 서버: 탐색 결과를 그대로 반영. 운영자가 고른 포함 여부 · 등급은 유지한다 */
  async applyDirect(tx: TenantTx, server: McpServer, checked: CheckedTool[]): Promise<void> {
    const existing = await tx.mcpTool.findMany({ where: { serverId: server.id } });
    const byName = new Map(existing.map((t) => [t.name, t]));
    for (const c of checked) {
      const row = byName.get(c.name);
      const blocked = c.schema.result === 'error' || c.security.result === 'failed';
      if (!row) {
        await tx.mcpTool.create({
          data: {
            tenantId: server.tenantId,
            serverId: server.id,
            name: c.name,
            ...definitionColumns(c),
            permissionLevel: c.suggestedLevel,
            enabled: c.defaultInclude,
            state: 'active',
          },
        });
        continue;
      }
      await tx.mcpTool.update({
        where: { id: row.id },
        data: {
          ...definitionColumns(c),
          ...(row.state === 'removed' ? { permissionLevel: c.suggestedLevel } : {}),
          enabled: blocked ? false : row.state === 'removed' ? c.defaultInclude : row.enabled,
          state: 'active',
          pendingChange: dbNull(),
        },
      });
    }
    const names = new Set(checked.map((c) => c.name));
    const gone = existing.filter((t) => !names.has(t.name) && t.state !== 'removed');
    if (gone.length) {
      await tx.mcpTool.updateMany({
        where: { id: { in: gone.map((t) => t.id) } },
        data: { state: 'removed', enabled: false, pendingChange: dbNull() },
      });
    }
  }

  /** 등록된 서버: 차이를 pending_change 로 기록 (반영은 approveChanges) */
  async recordChanges(
    tx: TenantTx,
    server: McpServer,
    checked: CheckedTool[],
  ): Promise<ChangeCounts> {
    const now = new Date().toISOString();
    const existing = await tx.mcpTool.findMany({ where: { serverId: server.id } });
    const byName = new Map(existing.map((t) => [t.name, t]));
    const counts: ChangeCounts = { added: 0, changed: 0, removed: 0 };

    for (const c of checked) {
      const row = byName.get(c.name);
      const next = snapshotOf(c);
      if (!row) {
        await tx.mcpTool.create({
          data: {
            tenantId: server.tenantId,
            serverId: server.id,
            name: c.name,
            ...definitionColumns(c),
            permissionLevel: c.suggestedLevel,
            enabled: false,
            state: 'pending_change',
            pendingChange: json({ kind: 'added', detectedAt: now, next }),
          },
        });
        counts.added++;
        continue;
      }
      const pending = readPending(row);
      if (row.state === 'removed') {
        await this.setPending(tx, row, {
          kind: 'added',
          detectedAt: keepDate(pending, 'added', now),
          next,
        });
        counts.added++;
      } else if (pending?.kind === 'added') {
        // 아직 승인 전인 새 Tool — 정의만 최신으로
        await this.setPending(tx, row, { kind: 'added', detectedAt: pending.detectedAt, next });
        counts.added++;
      } else if (row.schemaHash !== c.schemaHash) {
        const same = pending?.kind === 'changed' && pending.next?.schemaHash === c.schemaHash;
        await this.setPending(tx, row, {
          kind: 'changed',
          detectedAt: same ? pending.detectedAt : now,
          next,
        });
        counts.changed++;
      } else if (pending) {
        // 이전에 감지한 변경 · 삭제가 원래대로 돌아옴
        await tx.mcpTool.update({
          where: { id: row.id },
          data: { state: 'active', pendingChange: dbNull() },
        });
      }
    }

    const names = new Set(checked.map((c) => c.name));
    for (const row of existing) {
      if (names.has(row.name) || row.state === 'removed') continue;
      const pending = readPending(row);
      if (pending?.kind === 'added') {
        // 승인 전에 사라진 새 Tool 은 조용히 정리
        await tx.mcpTool.update({
          where: { id: row.id },
          data: { state: 'removed', enabled: false, pendingChange: dbNull() },
        });
        continue;
      }
      await this.setPending(tx, row, {
        kind: 'removed',
        detectedAt: keepDate(pending, 'removed', now),
      });
      counts.removed++;
    }
    return counts;
  }

  /** 변경 승인 → 정의 반영. 반환: 반영한 Tool 이름 */
  async approveChanges(tx: TenantTx, serverId: string, toolNames: string[]): Promise<string[]> {
    const rows = await tx.mcpTool.findMany({
      where: { serverId, name: { in: toolNames }, pendingChange: { not: dbNull() } },
    });
    for (const row of rows) {
      const pending = readPending(row)!;
      if (pending.kind === 'removed') {
        await tx.mcpTool.update({
          where: { id: row.id },
          data: { state: 'removed', enabled: false, pendingChange: dbNull() },
        });
        continue;
      }
      const next = pending.next!;
      const blocked = next.schema.result === 'error' || next.security.result === 'failed';
      await tx.mcpTool.update({
        where: { id: row.id },
        data: {
          title: next.title,
          description: next.description,
          inputSchema: json(next.inputSchema),
          outputSchema: next.outputSchema ? json(next.outputSchema) : dbNull(),
          schemaHash: next.schemaHash,
          schemaCheck: next.schema.result,
          schemaIssues: json(next.schema.issues),
          securityCheck: next.security.result,
          securityIssues: json(next.security.issues),
          // 새 Tool 은 승인해도 꺼진 채로 추가된다 — 운영자가 등급을 확인하고 켠다
          enabled: pending.kind === 'added' ? false : blocked ? false : row.enabled,
          ...(pending.kind === 'added' ? { permissionLevel: next.suggestedLevel } : {}),
          state: 'active',
          pendingChange: dbNull(),
        },
      });
    }
    return rows.map((r) => r.name);
  }

  private async setPending(tx: TenantTx, row: McpTool, change: PendingChange): Promise<void> {
    await tx.mcpTool.update({
      where: { id: row.id },
      data: { state: 'pending_change', pendingChange: json(change) },
    });
  }
}

export function readPending(row: Pick<McpTool, 'pendingChange'>): PendingChange | null {
  const value = row.pendingChange as PendingChange | null;
  return value && typeof value === 'object' && 'kind' in value ? value : null;
}

function keepDate(pending: PendingChange | null, kind: PendingChange['kind'], now: string): string {
  return pending?.kind === kind ? pending.detectedAt : now;
}

function snapshotOf(c: CheckedTool): ToolDefinitionSnapshot {
  return {
    title: c.title,
    description: c.description,
    inputSchema: c.inputSchema,
    outputSchema: c.outputSchema,
    schemaHash: c.schemaHash,
    schema: c.schema,
    security: c.security,
    suggestedLevel: c.suggestedLevel,
  };
}

function definitionColumns(c: CheckedTool) {
  return {
    title: c.title,
    description: c.description,
    inputSchema: json(c.inputSchema),
    outputSchema: c.outputSchema ? json(c.outputSchema) : dbNull(),
    schemaHash: c.schemaHash,
    schemaCheck: c.schema.result,
    schemaIssues: json(c.schema.issues),
    securityCheck: c.security.result,
    securityIssues: json(c.security.issues),
  };
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

/** Json? 컬럼을 SQL NULL 로 */
function dbNull() {
  return Prisma.DbNull;
}
