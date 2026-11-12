import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../admin/audit/audit.service.js';
import type { AdminRequest, AdminSession } from '../../admin/auth/admin-session.js';
import { hasRole } from '../../admin/auth/admin-session.js';
import { AppError, type FieldIssue } from '../../common/errors/app-error.js';
import { uuidv7 } from '../../common/uuid.js';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { type McpServer, type McpTool, Prisma } from '../../generated/prisma/client.js';
import { PrismaService, type TenantTx } from '../../infrastructure/database/prisma.service.js';
import { SecretStore } from '../../infrastructure/secrets/secret-store.js';
import {
  diffSnapshots,
  parseSnapshot,
  type PublishedVersion,
  ToolRegistryService,
} from '../../tools/tool-registry.service.js';
import {
  type ConnectionTestResult,
  McpConnectionError,
  McpConnectionService,
} from '../mcp-connection.service.js';
import {
  isRegistered,
  McpDiscoveryService,
  type PendingChange,
  readPending,
  toTarget,
} from '../mcp-discovery.service.js';
import type { CheckedTool } from '../mcp-tool-checks.js';
import type {
  ApproveChangesInput,
  CreateServerInput,
  ServerListQuery,
  ToolPolicyInput,
  ToolSelectionInput,
  UpdateServerInput,
} from './mcp-admin.schemas.js';

export interface McpServerView {
  id: string;
  name: string;
  description: string | null;
  transport: McpServer['transport'];
  endpointUrl: string | null;
  authType: McpServer['authType'];
  /** Secret 값은 돌려주지 않는다 — 저장 여부와 참조만 */
  secretRef: string | null;
  allowedHosts: string[];
  allowPrivateNetwork: boolean;
  status: McpServer['status'];
  statusReason: string | null;
  trust: McpServer['trust'];
  protocolVersion: string | null;
  lastSyncedAt: string | null;
  health: { p95Ms: number | null; errorRate: number | null };
  tools: { total: number; enabled: number; pendingChanges: number };
  createdAt: string;
  updatedAt: string;
}

export interface McpToolView {
  id: string;
  name: string;
  /** Registry · 정책 규칙에서 쓰는 이름 (서버.Tool) */
  registryName: string;
  title: string | null;
  description: string | null;
  inputSchema: unknown;
  schema: { result: McpTool['schemaCheck']; issues: string[] };
  security: { result: McpTool['securityCheck']; issues: string[] };
  permissionLevel: McpTool['permissionLevel'];
  approvalModeOverride: McpTool['approvalModeOverride'];
  enabled: boolean;
  state: McpTool['state'];
  pendingChange: PendingChange | null;
}

export interface DiscoveredTool {
  name: string;
  description: string | null;
  schema: CheckedTool['schema'];
  security: CheckedTool['security'];
  suggestedLevel: CheckedTool['suggestedLevel'];
  defaultInclude: boolean;
}

export interface DiscoverResult {
  server: McpServerView;
  protocolVersion: string | null;
  tools: DiscoveredTool[];
  /** 등록된 서버를 다시 탐색한 경우 감지된 변경 수 (검토 대기) */
  changes: { added: number; changed: number; removed: number } | null;
}

export interface RegistryVersionView {
  id: string;
  version: number;
  createdAt: string;
  changeSummary: unknown;
  toolCount: number;
}

type ToolCounts = Map<string, McpServerView['tools']>;

/**
 * MCP 서버 관리 (C-04 · C-05). 연결 정보 → 연결 테스트 → Tool 탐색 · 검증 → 포함 Tool · 등급 → 등록(새 Registry 버전).
 * 등록 후의 변경(재탐색 결과)은 운영자 승인 전까지 Registry 에 반영하지 않는다.
 */
@Injectable()
export class McpAdminService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly secrets: SecretStore,
    private readonly connections: McpConnectionService,
    private readonly discovery: McpDiscoveryService,
    private readonly registry: ToolRegistryService,
    private readonly audit: AuditService,
  ) {}

  async list(admin: AdminSession, query: ServerListQuery): Promise<McpServerView[]> {
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      const servers = await tx.mcpServer.findMany({
        where: {
          deletedAt: null,
          ...(query.status ? { status: query.status } : {}),
          ...(query.q ? { name: { contains: query.q, mode: 'insensitive' } } : {}),
        },
        orderBy: { name: 'asc' },
      });
      const counts = await this.toolCounts(
        tx,
        servers.map((s) => s.id),
      );
      return servers.map((s) => toServerView(s, counts));
    });
  }

  async get(admin: AdminSession, id: string): Promise<McpServerView> {
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      const server = await this.find(tx, id);
      return toServerView(server, await this.toolCounts(tx, [id]));
    });
  }

  /** ① 연결 정보 저장 (status = draft) */
  async create(
    admin: AdminSession,
    input: CreateServerInput,
    req?: AdminRequest,
  ): Promise<McpServerView> {
    this.validateConnection(admin, {
      transport: input.transport,
      endpointUrl: input.endpointUrl,
      authType: input.authType,
      hasSecret: Boolean(input.secret),
      allowPrivateNetwork: input.allowPrivateNetwork,
    });
    const id = uuidv7();
    const secretRef = input.secret ? secretRefFor(admin.tenantId, id) : null;
    const server = await this.prisma.withTenant(admin.tenantId, async (tx) => {
      const taken = await tx.mcpServer.findFirst({
        where: { name: input.name },
        select: { id: true },
      });
      if (taken) throw new AppError(409, 'NAME_TAKEN', `'${input.name}' 서버가 이미 있습니다`);
      const created = await tx.mcpServer.create({
        data: {
          id,
          tenantId: admin.tenantId,
          name: input.name,
          description: input.description ?? null,
          transport: input.transport,
          endpointUrl: input.endpointUrl ?? null,
          image: input.image ?? null,
          authType: input.authType,
          secretRef,
          allowedHosts: input.allowedHosts,
          allowPrivateNetwork: input.allowPrivateNetwork,
          status: 'draft',
          trust: 'needs_review',
          createdById: admin.userId,
        },
      });
      await this.audit.record(
        tx,
        admin,
        {
          action: 'mcp_server.create',
          targetType: 'mcp_server',
          targetId: id,
          metadata: { name: input.name },
        },
        req,
      );
      return created;
    });
    if (input.secret && secretRef) await this.secrets.put(secretRef, input.secret);
    return toServerView(server, new Map());
  }

  /** 연결 정보 수정. 등록된 서버의 연결 정보가 바뀌면 다시 검토(탐색 → 등록)해야 Tool 이 쓰인다. */
  async update(
    admin: AdminSession,
    id: string,
    input: UpdateServerInput,
    req?: AdminRequest,
  ): Promise<McpServerView> {
    const { server, secretRef } = await this.prisma.withTenant(admin.tenantId, async (tx) => {
      const current = await this.find(tx, id);
      const authType = input.authType ?? current.authType;
      this.validateConnection(admin, {
        transport: current.transport,
        endpointUrl: input.endpointUrl ?? current.endpointUrl ?? undefined,
        authType,
        hasSecret: Boolean(input.secret ?? current.secretRef),
        allowPrivateNetwork: input.allowPrivateNetwork ?? current.allowPrivateNetwork,
      });
      const connectionChanged =
        (input.endpointUrl !== undefined && input.endpointUrl !== current.endpointUrl) ||
        (input.authType !== undefined && input.authType !== current.authType) ||
        input.secret !== undefined ||
        (input.allowedHosts !== undefined &&
          input.allowedHosts.join() !== current.allowedHosts.join()) ||
        (input.allowPrivateNetwork !== undefined &&
          input.allowPrivateNetwork !== current.allowPrivateNetwork);
      const ref = input.secret
        ? (current.secretRef ?? secretRefFor(admin.tenantId, id))
        : current.secretRef;
      const needsReview = connectionChanged && isRegistered(current);
      const updated = await tx.mcpServer.update({
        where: { id },
        data: {
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.endpointUrl !== undefined ? { endpointUrl: input.endpointUrl } : {}),
          ...(input.authType !== undefined ? { authType: input.authType } : {}),
          ...(input.allowedHosts !== undefined ? { allowedHosts: input.allowedHosts } : {}),
          ...(input.allowPrivateNetwork !== undefined
            ? { allowPrivateNetwork: input.allowPrivateNetwork }
            : {}),
          secretRef: authType === 'none' ? null : ref,
          ...(needsReview
            ? {
                status: 'pending_review' as const,
                trust: 'needs_review' as const,
                statusReason: '연결 정보가 바뀌어 다시 검토해야 합니다',
              }
            : {}),
        },
      });
      if (needsReview) {
        await this.registry.publish(tx, admin.tenantId, {
          reason: 'mcp_server_changed',
          server: current.name,
        });
      }
      await this.audit.record(
        tx,
        admin,
        {
          action: 'mcp_server.update',
          targetType: 'mcp_server',
          targetId: id,
          metadata: {
            fields: Object.keys(input).map((k) => (k === 'secret' ? 'secret(rotated)' : k)),
            needsReview,
          },
        },
        req,
      );
      return { server: updated, secretRef: ref };
    });
    if (input.secret && secretRef) await this.secrets.put(secretRef, input.secret);
    return this.get(admin, server.id);
  }

  /** ① 연결 테스트 — SSRF 검사 · initialize 핸드셰이크 · 프로토콜 버전 · 응답 시간 */
  async test(admin: AdminSession, id: string): Promise<ConnectionTestResult> {
    const server = await this.prisma.withTenant(admin.tenantId, (tx) => this.find(tx, id));
    const result = await this.connections.test(toTarget(server));
    if (result.handshake === 'ok') {
      await this.prisma.withTenant(admin.tenantId, (tx) =>
        tx.mcpServer.update({ where: { id }, data: { protocolVersion: result.protocolVersion } }),
      );
    }
    return result;
  }

  /** ② Tool 탐색 · 검증. 등록된 서버면 변경을 검토 대기로만 기록한다. */
  async discover(admin: AdminSession, id: string, req?: AdminRequest): Promise<DiscoverResult> {
    const server = await this.prisma.withTenant(admin.tenantId, (tx) => this.find(tx, id));
    let found: Awaited<ReturnType<McpDiscoveryService['discover']>>;
    try {
      found = await this.discovery.discover(server);
    } catch (err) {
      throw connectionAppError(err);
    }
    const registered = isRegistered(server);
    const changes = await this.prisma.withTenant(admin.tenantId, async (tx) => {
      const counts = registered
        ? await this.discovery.recordChanges(tx, server, found.tools)
        : (await this.discovery.applyDirect(tx, server, found.tools), null);
      await tx.mcpServer.update({
        where: { id },
        data: {
          protocolVersion: found.protocolVersion,
          lastSyncedAt: new Date(),
          ...(registered
            ? { status: 'connected', statusReason: null }
            : { status: 'pending_review', statusReason: null }),
        },
      });
      await this.audit.record(
        tx,
        admin,
        {
          action: 'mcp_server.discover',
          targetType: 'mcp_server',
          targetId: id,
          metadata: { tools: found.tools.length, changes: counts },
        },
        req,
      );
      return counts;
    });
    return {
      server: await this.get(admin, id),
      protocolVersion: found.protocolVersion,
      tools: found.tools.map((t) => ({
        name: t.name,
        description: t.description,
        schema: t.schema,
        security: t.security,
        suggestedLevel: t.suggestedLevel,
        defaultInclude: t.defaultInclude,
      })),
      changes,
    };
  }

  /** ③ 포함할 Tool · 등급 · 승인 재정의 (등록 전) */
  async selectTools(
    admin: AdminSession,
    id: string,
    input: ToolSelectionInput,
    req?: AdminRequest,
  ): Promise<McpToolView[]> {
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      const server = await this.find(tx, id);
      if (server.status !== 'pending_review') {
        throw new AppError(
          409,
          'MCP_SERVER_STATE',
          '탐색을 마친 등록 전 서버에서만 고를 수 있습니다. 등록된 Tool 은 Tool 정책에서 바꿉니다.',
        );
      }
      const rows = await tx.mcpTool.findMany({
        where: { serverId: id, state: { not: 'removed' } },
      });
      const byName = new Map(rows.map((r) => [r.name, r]));
      const issues: FieldIssue[] = [];
      input.tools.forEach((t, i) => {
        const row = byName.get(t.name);
        if (!row)
          issues.push({ path: `tools.${i}.name`, message: `탐색된 Tool 이 아닙니다: ${t.name}` });
        else if (t.include && row.schemaCheck === 'error')
          issues.push({
            path: `tools.${i}.include`,
            message: '스키마 오류가 있는 Tool 은 포함할 수 없습니다',
          });
        else if (t.include && row.securityCheck === 'failed')
          issues.push({
            path: `tools.${i}.include`,
            message: '보안 검사를 통과하지 못한 Tool 은 포함할 수 없습니다',
          });
      });
      if (issues.length) throw new AppError(422, 'MCP_TOOL_INVALID', undefined, issues);

      for (const t of input.tools) {
        await tx.mcpTool.update({
          where: { id: byName.get(t.name)!.id },
          data: {
            enabled: t.include,
            ...(t.permissionLevel ? { permissionLevel: t.permissionLevel } : {}),
            ...(t.approvalModeOverride !== undefined
              ? { approvalModeOverride: t.approvalModeOverride }
              : {}),
          },
        });
      }
      await this.audit.record(
        tx,
        admin,
        {
          action: 'mcp_server.select_tools',
          targetType: 'mcp_server',
          targetId: id,
          metadata: { included: input.tools.filter((t) => t.include).map((t) => t.name) },
        },
        req,
      );
      return this.toolViews(tx, server);
    });
  }

  /** ④ 등록 → 새 Registry 버전 */
  async register(
    admin: AdminSession,
    id: string,
    req?: AdminRequest,
  ): Promise<{ server: McpServerView; registry: PublishedVersion }> {
    const registry = await this.prisma.withTenant(admin.tenantId, async (tx) => {
      const server = await this.find(tx, id);
      if (server.status !== 'pending_review') {
        throw new AppError(409, 'MCP_SERVER_STATE', 'Tool 탐색 · 검증을 먼저 마쳐야 합니다');
      }
      const included = await tx.mcpTool.count({
        where: {
          serverId: id,
          enabled: true,
          state: { not: 'removed' },
          schemaCheck: { not: 'error' },
        },
      });
      if (included === 0) {
        throw new AppError(422, 'VALIDATION_FAILED', '포함할 Tool 을 하나 이상 골라야 합니다');
      }
      await tx.mcpServer.update({
        where: { id },
        data: { status: 'connected', trust: 'verified', statusReason: null },
      });
      const published = await this.registry.publish(tx, admin.tenantId, {
        reason: 'mcp_server_registered',
        server: server.name,
      });
      await this.audit.record(
        tx,
        admin,
        {
          action: 'mcp_server.register',
          targetType: 'mcp_server',
          targetId: id,
          metadata: { registryVersion: published.version, diff: published.diff },
        },
        req,
      );
      return published;
    });
    return { server: await this.get(admin, id), registry };
  }

  async tools(admin: AdminSession, id: string): Promise<McpToolView[]> {
    return this.prisma.withTenant(admin.tenantId, async (tx) =>
      this.toolViews(tx, await this.find(tx, id)),
    );
  }

  /** Tool 단위 등급 · 승인 재정의 · 사용 여부 → (등록된 서버면) 새 Registry 버전 */
  async updateToolPolicy(
    admin: AdminSession,
    toolId: string,
    input: ToolPolicyInput,
    req?: AdminRequest,
  ): Promise<{ tool: McpToolView; registry: PublishedVersion | null }> {
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      const tool = await tx.mcpTool.findUnique({
        where: { id: toolId },
        include: { server: true },
      });
      if (!tool || tool.server.deletedAt) throw AppError.notFound();
      if (input.enabled) {
        if (tool.state === 'removed')
          throw new AppError(422, 'MCP_TOOL_INVALID', '서버에서 삭제된 Tool 입니다');
        if (readPending(tool)?.kind === 'added') {
          throw new AppError(
            409,
            'MCP_SERVER_STATE',
            '새로 감지된 Tool 은 변경을 먼저 승인해야 합니다',
          );
        }
        if (tool.schemaCheck === 'error' || tool.securityCheck === 'failed') {
          throw new AppError(
            422,
            'MCP_TOOL_INVALID',
            '스키마 오류 · 보안 검사 실패 Tool 은 켤 수 없습니다',
          );
        }
      }
      const updated = await tx.mcpTool.update({
        where: { id: toolId },
        data: {
          ...(input.permissionLevel ? { permissionLevel: input.permissionLevel } : {}),
          ...(input.approvalModeOverride !== undefined
            ? { approvalModeOverride: input.approvalModeOverride }
            : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        },
      });
      const registry = isRegistered(tool.server)
        ? await this.registry.publish(tx, admin.tenantId, {
            reason: 'mcp_tool_policy_changed',
            tool: `${tool.server.name}.${tool.name}`,
          })
        : null;
      await this.audit.record(
        tx,
        admin,
        {
          action: 'mcp_tool.policy',
          targetType: 'mcp_tool',
          targetId: toolId,
          metadata: { ...input, registryVersion: registry?.version ?? null },
        },
        req,
      );
      return { tool: toToolView(updated, tool.server.name), registry };
    });
  }

  async changes(admin: AdminSession, id: string): Promise<McpToolView[]> {
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      const server = await this.find(tx, id);
      return (await this.toolViews(tx, server)).filter((t) => t.pendingChange !== null);
    });
  }

  async approveChanges(
    admin: AdminSession,
    id: string,
    input: ApproveChangesInput,
    req?: AdminRequest,
  ): Promise<{ approved: string[]; registry: PublishedVersion | null }> {
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      const server = await this.find(tx, id);
      const approved = await this.discovery.approveChanges(tx, id, input.toolNames);
      const missing = input.toolNames.filter((n) => !approved.includes(n));
      if (missing.length) {
        throw new AppError(
          422,
          'VALIDATION_FAILED',
          `검토 대기 중인 변경이 없습니다: ${missing.join(', ')}`,
        );
      }
      const registry = isRegistered(server)
        ? await this.registry.publish(tx, admin.tenantId, {
            reason: 'mcp_changes_approved',
            server: server.name,
            tools: approved,
          })
        : null;
      await this.audit.record(
        tx,
        admin,
        {
          action: 'mcp_server.approve_changes',
          targetType: 'mcp_server',
          targetId: id,
          metadata: { tools: approved, registryVersion: registry?.version ?? null },
        },
        req,
      );
      return { approved, registry };
    });
  }

  /** 비활성화 — 실행 중 작업도 다음 호출부터 거부된다 (Dispatcher 가 서버 상태를 확인) */
  async disable(admin: AdminSession, id: string, req?: AdminRequest): Promise<McpServerView> {
    await this.prisma.withTenant(admin.tenantId, async (tx) => {
      const server = await this.find(tx, id);
      await tx.mcpServer.update({
        where: { id },
        data: { status: 'disabled', statusReason: '운영자가 비활성화했습니다' },
      });
      await this.registry.publish(tx, admin.tenantId, {
        reason: 'mcp_server_disabled',
        server: server.name,
      });
      await this.audit.record(
        tx,
        admin,
        { action: 'mcp_server.disable', targetType: 'mcp_server', targetId: id },
        req,
      );
    });
    return this.get(admin, id);
  }

  /** 삭제 (soft delete). 이름은 다시 쓸 수 있게 바꾸고 Secret 은 지운다 */
  async remove(admin: AdminSession, id: string, req?: AdminRequest): Promise<void> {
    const secretRef = await this.prisma.withTenant(admin.tenantId, async (tx) => {
      const server = await this.find(tx, id);
      await tx.mcpServer.update({
        where: { id },
        data: {
          status: 'disabled',
          deletedAt: new Date(),
          name: `${server.name}~deleted~${id.slice(-8)}`,
          secretRef: null,
        },
      });
      await tx.agentVersionMcpServer.updateMany({
        where: { mcpServerId: id },
        data: { enabled: false },
      });
      await this.registry.publish(tx, admin.tenantId, {
        reason: 'mcp_server_deleted',
        server: server.name,
      });
      await this.audit.record(
        tx,
        admin,
        {
          action: 'mcp_server.delete',
          targetType: 'mcp_server',
          targetId: id,
          metadata: { name: server.name },
        },
        req,
      );
      return server.secretRef;
    });
    if (secretRef) await this.secrets.delete(secretRef);
  }

  async registryVersions(admin: AdminSession): Promise<RegistryVersionView[]> {
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      const rows = await tx.toolRegistryVersion.findMany({
        orderBy: { version: 'desc' },
        take: 100,
      });
      return rows.map((r) => ({
        id: r.id,
        version: r.version,
        createdAt: r.createdAt.toISOString(),
        changeSummary: r.changeSummary,
        toolCount: parseSnapshot(r.snapshot).tools.length,
      }));
    });
  }

  async registryVersion(admin: AdminSession, version: number) {
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      const row = await tx.toolRegistryVersion.findFirst({ where: { version } });
      if (!row) throw AppError.notFound();
      return {
        id: row.id,
        version: row.version,
        createdAt: row.createdAt.toISOString(),
        changeSummary: row.changeSummary,
        snapshot: parseSnapshot(row.snapshot),
      };
    });
  }

  async registryDiff(admin: AdminSession, version: number, from?: number) {
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      const base = from ?? version - 1;
      const rows = await tx.toolRegistryVersion.findMany({
        where: { version: { in: [version, base] } },
      });
      const target = rows.find((r) => r.version === version);
      if (!target) throw AppError.notFound();
      const previous = rows.find((r) => r.version === base);
      return {
        from: previous ? base : null,
        to: version,
        ...diffSnapshots(parseSnapshot(previous?.snapshot), parseSnapshot(target.snapshot)),
      };
    });
  }

  private validateConnection(
    admin: AdminSession,
    input: {
      transport: McpServer['transport'];
      endpointUrl: string | undefined;
      authType: McpServer['authType'];
      hasSecret: boolean;
      allowPrivateNetwork: boolean;
    },
  ): void {
    if (input.transport === 'stdio_sandbox') {
      throw new AppError(
        422,
        'MCP_TRANSPORT_UNSUPPORTED',
        'stdio(Docker Sandbox) 실행형은 Sandbox 단계에서 지원합니다. Streamable HTTP 서버를 연결해 주세요.',
      );
    }
    if (input.authType === 'oauth') {
      throw new AppError(
        422,
        'MCP_AUTH_UNSUPPORTED',
        'OAuth 인증은 아직 지원하지 않습니다 (API Key 또는 인증 없음)',
      );
    }
    if (input.allowPrivateNetwork && !hasRole(admin.role, 'owner')) {
      throw new AppError(403, 'FORBIDDEN', '사설 네트워크 허용은 Owner 만 켤 수 있습니다');
    }
    const issues: FieldIssue[] = [];
    if (!input.endpointUrl) {
      issues.push({
        path: 'endpointUrl',
        message: 'Streamable HTTP 서버는 엔드포인트가 필요합니다',
      });
    } else {
      let url: URL | null = null;
      try {
        url = new URL(input.endpointUrl);
      } catch {
        issues.push({ path: 'endpointUrl', message: 'URL 형식이 아닙니다' });
      }
      if (url) {
        const httpAllowed = this.config.mcp.allowInsecureHttp && url.protocol === 'http:';
        if (url.protocol !== 'https:' && !httpAllowed) {
          issues.push({ path: 'endpointUrl', message: 'https 만 허용합니다' });
        }
        if (url.username || url.password) {
          issues.push({
            path: 'endpointUrl',
            message: 'URL 에 계정 정보를 넣을 수 없습니다 (Secret 을 쓰세요)',
          });
        }
      }
    }
    if (input.authType === 'api_key' && !input.hasSecret) {
      issues.push({ path: 'secret', message: 'API Key 인증에는 secret 이 필요합니다' });
    }
    if (issues.length) throw new AppError(422, 'VALIDATION_FAILED', undefined, issues);
  }

  private async find(tx: TenantTx, id: string): Promise<McpServer> {
    const server = await tx.mcpServer.findFirst({ where: { id, deletedAt: null } });
    if (!server) throw AppError.notFound();
    return server;
  }

  private async toolViews(tx: TenantTx, server: McpServer): Promise<McpToolView[]> {
    const rows = await tx.mcpTool.findMany({
      where: { serverId: server.id },
      orderBy: { name: 'asc' },
    });
    return rows.map((r) => toToolView(r, server.name));
  }

  private async toolCounts(tx: TenantTx, serverIds: string[]): Promise<ToolCounts> {
    const rows = await tx.mcpTool.findMany({
      where: { serverId: { in: serverIds } },
      select: { serverId: true, enabled: true, state: true, pendingChange: true },
    });
    const counts: ToolCounts = new Map();
    for (const r of rows) {
      const c = counts.get(r.serverId) ?? { total: 0, enabled: 0, pendingChanges: 0 };
      if (r.state !== 'removed' && readPending(r)?.kind !== 'added') c.total++;
      if (r.enabled && r.state !== 'removed') c.enabled++;
      if (readPending(r)) c.pendingChanges++;
      counts.set(r.serverId, c);
    }
    return counts;
  }
}

function secretRefFor(tenantId: string, serverId: string): string {
  return `vault://mcp/${tenantId}/${serverId}`;
}

export function connectionAppError(err: unknown): AppError {
  if (err instanceof McpConnectionError) {
    switch (err.code) {
      case 'ssrf_blocked':
        return new AppError(422, 'MCP_SSRF_BLOCKED', `${err.message}`);
      case 'unsupported_transport':
        return new AppError(422, 'MCP_TRANSPORT_UNSUPPORTED', err.message);
      case 'unsupported_auth':
        return new AppError(422, 'MCP_AUTH_UNSUPPORTED', err.message);
      default:
        return new AppError(422, 'MCP_HANDSHAKE_FAILED', err.message);
    }
  }
  return new AppError(
    422,
    'MCP_HANDSHAKE_FAILED',
    err instanceof Error ? err.message : String(err),
  );
}

function toServerView(s: McpServer, counts: ToolCounts): McpServerView {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    transport: s.transport,
    endpointUrl: s.endpointUrl,
    authType: s.authType,
    secretRef: s.secretRef,
    allowedHosts: s.allowedHosts,
    allowPrivateNetwork: s.allowPrivateNetwork,
    status: s.status,
    statusReason: s.statusReason,
    trust: s.trust,
    protocolVersion: s.protocolVersion,
    lastSyncedAt: s.lastSyncedAt?.toISOString() ?? null,
    health: { p95Ms: s.healthP95Ms, errorRate: s.healthErrorRate },
    tools: counts.get(s.id) ?? { total: 0, enabled: 0, pendingChanges: 0 },
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

function toToolView(t: McpTool, serverName: string): McpToolView {
  return {
    id: t.id,
    name: t.name,
    registryName: `${serverName}.${t.name}`,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    schema: { result: t.schemaCheck, issues: asStrings(t.schemaIssues) },
    security: { result: t.securityCheck, issues: asStrings(t.securityIssues) },
    permissionLevel: t.permissionLevel,
    approvalModeOverride: t.approvalModeOverride,
    enabled: t.enabled,
    state: t.state,
    pendingChange: readPending(t),
  };
}

function asStrings(value: Prisma.JsonValue | null): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}
