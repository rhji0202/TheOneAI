import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService, type TenantTx } from '../infrastructure/database/prisma.service.js';
import type { LlmToolDefinition } from '../llm/llm.types.js';
import { BuiltinToolCatalog } from './builtin-tool.catalog.js';
import { toLlmName } from './tool-names.js';
import type { BuiltinTool, RegistrySnapshot, SnapshotSkill, SnapshotTool } from './tool.types.js';

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
    idempotent: z.boolean().optional(),
    mcpToolId: z.string().optional(),
    mcpServerId: z.string().optional(),
    mcpToolName: z.string().optional(),
  })
  .passthrough();

const snapshotSchema = z.object({
  builtinsHash: z.string().default(''),
  tools: z.array(snapshotToolSchema).default([]),
  skills: z
    .array(
      z.object({
        name: z.string(),
        skillId: z.string(),
        versionId: z.string(),
        version: z.string(),
        description: z.string().default(''),
        allowedTools: z.array(z.string()).default([]),
        contentHash: z.string().default(''),
      }),
    )
    .catch([])
    .default([]),
});

export function parseSnapshot(value: unknown): RegistrySnapshot {
  const parsed = snapshotSchema.safeParse(value ?? {});
  return parsed.success
    ? (parsed.data as RegistrySnapshot)
    : { builtinsHash: '', tools: [], skills: [] };
}

/** 모델에게 보여 줄 Tool 설명 상한 (MCP 서버가 준 설명이 지나치게 길 때) */
const MAX_TOOL_DESCRIPTION = 1_000;

export interface ResolvedTool extends SnapshotTool {
  llmName: string;
  /** 내장 Tool 의 실행 구현. MCP Tool 은 null (McpConnectionService 로 호출) */
  builtin: BuiltinTool | null;
}

/** 작업 1건이 고정해 쓰는 Tool 목록 (tasks.registry_version_id 의 스냅샷) */
export class Toolset {
  private readonly byLlm = new Map<string, ResolvedTool>();

  constructor(
    readonly registryVersionId: string,
    readonly tools: ResolvedTool[],
    /** 이 Registry 버전에 고정된 Skill (Agent 허용 목록 · 활성 여부는 SkillRuntimeService 가 거른다) */
    readonly skills: SnapshotSkill[] = [],
  ) {
    for (const tool of tools) this.byLlm.set(tool.llmName, tool);
  }

  /** 실행할 방법이 있는 Tool (내장 구현이 있거나, 서버 · 원래 이름이 기록된 MCP Tool) */
  get available(): ResolvedTool[] {
    return this.tools.filter((t) => isExecutable(t));
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

export function isExecutable(tool: ResolvedTool): boolean {
  return tool.source === 'builtin'
    ? tool.builtin !== null
    : Boolean(tool.mcpServerId && tool.mcpToolName);
}

export interface RegistryDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export interface PublishedVersion {
  id: string;
  version: number;
  created: boolean;
  diff: RegistryDiff;
}

/**
 * Tool Registry — 승인된 Tool 구성의 불변 버전(tool_registry_versions).
 *  - 스냅샷 = 배포된 내장 Tool + 운영자가 등록한 MCP Tool(연결됨 · 사용 · 스키마 정상).
 *  - 새 작업은 생성 시점의 최신 버전을 고정한다 (실행 중 MCP · Skill 변경과 무관).
 *  - 구성이 바뀔 때마다(내장 Tool 배포, MCP 등록 · 정책 · 변경 승인 · 비활성화) 새 버전을 만든다.
 *  - 버전 생성은 테넌트 단위 advisory lock 으로 직렬화한다.
 */
@Injectable()
export class ToolRegistryService {
  private readonly logger = new Logger(ToolRegistryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: BuiltinToolCatalog,
  ) {}

  /** 작업 생성 시: 최신 버전 id. 배포된 내장 Tool 구성이 달라졌으면 새 버전을 만든다. */
  async ensureCurrentVersion(tx: TenantTx, tenantId: string): Promise<string> {
    const latest = await this.latest(tx, tenantId);
    if (latest && parseSnapshot(latest.snapshot).builtinsHash === this.catalog.hash()) {
      return latest.id;
    }
    return (await this.publish(tx, tenantId, { reason: 'builtin_tools_changed' })).id;
  }

  /**
   * 현재 구성으로 스냅샷을 만들어, 최신 버전과 다르면 새 버전으로 저장한다.
   * 같으면 최신 버전을 그대로 돌려준다 (created = false).
   */
  async publish(
    tx: TenantTx,
    tenantId: string,
    change: { reason: string; [key: string]: unknown },
  ): Promise<PublishedVersion> {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`tool-registry:${tenantId}`}, 0))`;
    const latest = await this.latest(tx, tenantId);
    const previous = parseSnapshot(latest?.snapshot);
    const next = await this.buildSnapshot(tx);
    const diff = diffSnapshots(previous, next);
    const unchanged =
      latest &&
      previous.builtinsHash === next.builtinsHash &&
      !diff.added.length &&
      !diff.removed.length &&
      !diff.changed.length;
    if (unchanged) return { id: latest.id, version: latest.version, created: false, diff };

    const created = await tx.toolRegistryVersion.create({
      data: {
        tenantId,
        version: (latest?.version ?? 0) + 1,
        snapshot: next as unknown as Prisma.InputJsonValue,
        changeSummary: { ...change, ...diff } as Prisma.InputJsonValue,
      },
      select: { id: true, version: true },
    });
    this.logger.log(
      `Tool Registry v${created.version} (${change.reason}) +${diff.added.length} -${diff.removed.length} ~${diff.changed.length}`,
    );
    return { ...created, created: true, diff };
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
    return new Toolset(registryVersionId, tools, snapshot.skills);
  }

  private latest(tx: TenantTx, tenantId: string) {
    return tx.toolRegistryVersion.findFirst({
      where: { tenantId },
      orderBy: { version: 'desc' },
      select: { id: true, version: true, snapshot: true },
    });
  }

  private async buildSnapshot(tx: TenantTx): Promise<RegistrySnapshot> {
    const mcpTools = await tx.mcpTool.findMany({
      where: {
        enabled: true,
        state: { not: 'removed' },
        schemaCheck: { not: 'error' },
        // 오류 상태 서버의 Tool 도 스냅샷에는 남긴다 — 실행 가능 여부는 호출 시점의 서버 상태로 판단(복구되면 바로 다시 사용)
        server: { status: { in: ['connected', 'error'] }, deletedAt: null },
      },
      include: { server: { select: { id: true, name: true } } },
      orderBy: [{ server: { name: 'asc' } }, { name: 'asc' }],
    });
    const mcp: SnapshotTool[] = mcpTools.map((t) => ({
      name: `${t.server.name}.${t.name}`,
      source: 'mcp',
      description: truncate(t.description ?? t.title ?? '', MAX_TOOL_DESCRIPTION),
      inputSchema: t.inputSchema as Record<string, unknown>,
      schemaHash: t.schemaHash,
      level: t.permissionLevel,
      modeOverride: t.approvalModeOverride,
      idempotent: t.permissionLevel === 'read',
      mcpToolId: t.id,
      mcpServerId: t.server.id,
      mcpToolName: t.name,
    }));
    // 활성 Skill 의 활성 버전 (검증 통과) — 작업은 이 버전 · 내용 해시로 고정된다
    const skillRows = await tx.skill.findMany({
      where: { status: 'active', deletedAt: null, activeVersion: { verificationStatus: 'passed' } },
      include: { activeVersion: true },
      orderBy: { name: 'asc' },
    });
    const skills: SnapshotSkill[] = skillRows.map((s) => ({
      name: s.name,
      skillId: s.id,
      versionId: s.activeVersion!.id,
      version: s.activeVersion!.version,
      description: truncate(s.activeVersion!.description, MAX_TOOL_DESCRIPTION),
      allowedTools: s.activeVersion!.allowedTools,
      contentHash: s.activeVersion!.contentHash,
    }));
    return {
      builtinsHash: this.catalog.hash(),
      tools: [...this.catalog.snapshotTools(), ...mcp],
      skills,
    };
  }

  /** 지금 쓸 수 있는 Tool 구성 — 배포된 내장 Tool + 최신 Registry 의 MCP Tool (Skill allowed-tools 검사용) */
  async latestTools(tx: TenantTx, tenantId: string): Promise<SnapshotTool[]> {
    const latest = await this.latest(tx, tenantId);
    const registered = parseSnapshot(latest?.snapshot).tools.filter((t) => t.source !== 'builtin');
    return [...this.catalog.snapshotTools(), ...registered];
  }

  async loadSnapshot(tenantId: string, registryVersionId: string): Promise<RegistrySnapshot> {
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.toolRegistryVersion.findUnique({
        where: { id: registryVersionId },
        select: { snapshot: true },
      }),
    );
    return parseSnapshot(row?.snapshot);
  }
}

/** Tool · Skill(`skill:` 접두) 이름 기준 추가 · 삭제 · 변경(스키마 · 설명 · 등급 · 승인 재정의 · Skill 버전) */
export function diffSnapshots(before: RegistrySnapshot, after: RegistrySnapshot): RegistryDiff {
  const key = (t: SnapshotTool) => `${t.schemaHash}|${t.level}|${t.modeOverride ?? ''}`;
  const entries = (s: RegistrySnapshot): Array<[string, string]> => [
    ...s.tools.map((t): [string, string] => [t.name, key(t)]),
    ...s.skills.map((k): [string, string] => [
      `skill:${k.name}`,
      `${k.versionId}|${k.contentHash}`,
    ]),
  ];
  const prev = new Map(entries(before));
  const next = new Map(entries(after));
  return {
    added: [...next.keys()].filter((n) => !prev.has(n)),
    removed: [...prev.keys()].filter((n) => !next.has(n)),
    changed: [...next.keys()].filter((n) => prev.has(n) && prev.get(n) !== next.get(n)),
  };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
