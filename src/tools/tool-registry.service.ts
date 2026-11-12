import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService, type TenantTx } from '../infrastructure/database/prisma.service.js';
import type { LlmToolDefinition } from '../llm/llm.types.js';
import { BuiltinToolCatalog } from './builtin-tool.catalog.js';
import { toLlmName } from './tool-names.js';
import type { BuiltinTool, RegistrySnapshot, SnapshotTool } from './tool.types.js';

const snapshotToolSchema = z
  .object({
    name: z.string(),
    source: z.enum(['builtin', 'mcp']),
    description: z.string().default(''),
    inputSchema: z.record(z.string(), z.unknown()).default({ type: 'object' }),
    schemaHash: z.string().default(''),
    level: z.enum(['read', 'write', 'external_send', 'delete', 'financial']),
    modeOverride: z
      .enum(['auto', 'require_approval', 'always_approval', 'block'])
      .nullable()
      .default(null),
    mcpToolId: z.string().optional(),
  })
  .passthrough();

const snapshotSchema = z.object({
  builtinsHash: z.string().default(''),
  tools: z.array(snapshotToolSchema).default([]),
  skills: z.array(z.unknown()).default([]),
});

export function parseSnapshot(value: unknown): RegistrySnapshot {
  const parsed = snapshotSchema.safeParse(value ?? {});
  return parsed.success
    ? (parsed.data as RegistrySnapshot)
    : { builtinsHash: '', tools: [], skills: [] };
}

export interface ResolvedTool extends SnapshotTool {
  llmName: string;
  /** 실행 구현. MCP Tool 은 5단계에서 연결되며, 그 전까지는 null(사용 불가) */
  builtin: BuiltinTool | null;
}

/** 작업 1건이 고정해 쓰는 Tool 목록 (tasks.registry_version_id 의 스냅샷) */
export class Toolset {
  private readonly byLlm = new Map<string, ResolvedTool>();

  constructor(
    readonly registryVersionId: string,
    readonly tools: ResolvedTool[],
  ) {
    for (const tool of tools) this.byLlm.set(tool.llmName, tool);
  }

  /** 실행 구현이 있는 Tool */
  get available(): ResolvedTool[] {
    return this.tools.filter((t) => t.builtin !== null);
  }

  byLlmName(name: string): ResolvedTool | undefined {
    return this.byLlm.get(name);
  }

  definitions(
    tools: ResolvedTool[],
    note?: (tool: ResolvedTool) => string | null,
  ): LlmToolDefinition[] {
    return tools.map((tool) => {
      const extra = note?.(tool);
      return {
        name: tool.llmName,
        description: extra ? `${tool.description} ${extra}` : tool.description,
        parameters: tool.inputSchema,
      };
    });
  }
}

/**
 * Tool Registry — 승인된 Tool 구성의 불변 버전(tool_registry_versions).
 *  - 새 작업은 생성 시점의 최신 버전을 고정한다 (실행 중 MCP · Skill 변경과 무관).
 *  - 내장 Tool 은 배포된 코드가 기준이므로, 구성이 바뀌었으면 작업 생성 시 새 버전을 만든다.
 *  - MCP Tool 은 5단계에서 운영자 검토 후 새 버전으로 추가된다.
 */
@Injectable()
export class ToolRegistryService {
  private readonly logger = new Logger(ToolRegistryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: BuiltinToolCatalog,
  ) {}

  async ensureCurrentVersion(tx: TenantTx, tenantId: string): Promise<string> {
    const latest = await tx.toolRegistryVersion.findFirst({
      where: { tenantId },
      orderBy: { version: 'desc' },
      select: { id: true, version: true, snapshot: true },
    });
    const current = parseSnapshot(latest?.snapshot);
    const builtinsHash = this.catalog.hash();
    if (latest && current.builtinsHash === builtinsHash) return latest.id;

    const builtins = this.catalog.snapshotTools();
    const next: RegistrySnapshot = {
      builtinsHash,
      tools: [...builtins, ...current.tools.filter((t) => t.source !== 'builtin')],
      skills: current.skills,
    };
    const before = new Map(
      current.tools.filter((t) => t.source === 'builtin').map((t) => [t.name, t.schemaHash]),
    );
    const after = new Map(builtins.map((t) => [t.name, t.schemaHash]));
    const created = await tx.toolRegistryVersion.create({
      data: {
        tenantId,
        version: (latest?.version ?? 0) + 1,
        snapshot: next as unknown as Prisma.InputJsonValue,
        changeSummary: {
          reason: 'builtin_tools_changed',
          added: [...after.keys()].filter((n) => !before.has(n)),
          removed: [...before.keys()].filter((n) => !after.has(n)),
          changed: [...after.keys()].filter((n) => before.has(n) && before.get(n) !== after.get(n)),
        },
      },
      select: { id: true },
    });
    return created.id;
  }

  async loadToolset(tenantId: string, registryVersionId: string): Promise<Toolset> {
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.toolRegistryVersion.findUnique({
        where: { id: registryVersionId },
        select: { snapshot: true },
      }),
    );
    const snapshot = parseSnapshot(row?.snapshot);
    const tools: ResolvedTool[] = [];
    for (const tool of snapshot.tools) {
      let llmName: string;
      try {
        llmName = toLlmName(tool.name);
      } catch {
        this.logger.warn(`LLM 이름으로 바꿀 수 없는 Tool 은 제외: ${tool.name}`);
        continue;
      }
      tools.push({
        ...tool,
        llmName,
        builtin: tool.source === 'builtin' ? (this.catalog.get(tool.name) ?? null) : null,
      });
    }
    return new Toolset(registryVersionId, tools);
  }
}
