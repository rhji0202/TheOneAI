import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../admin/audit/audit.service.js';
import type { AdminRequest, AdminSession } from '../admin/auth/admin-session.js';
import { canonicalJson } from '../common/canonical-json.js';
import { AppError } from '../common/errors/app-error.js';
import { uuidv7 } from '../common/uuid.js';
import type { MarketplaceListing, MarketplaceVersion, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../infrastructure/database/prisma.service.js';
import { ObjectStorage } from '../infrastructure/storage/object-storage.js';
import { SkillsAdminService } from '../skills/admin/skills-admin.service.js';
import { type BundleFile, bundleHash } from '../skills/bundle/skill-bundle.js';
import { SkillStoreService, type StoredSkillFile } from '../skills/skill-store.service.js';
import { MarketplaceSigner, type SignedContent } from './marketplace-signer.service.js';

const meta = {
  title: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().min(1).max(2_000).optional(),
};
export const publishSkillSchema = z.object({
  skillId: z.uuid(),
  /** 없으면 활성 버전 */
  versionId: z.uuid().optional(),
  ...meta,
});
export type PublishSkillInput = z.infer<typeof publishSkillSchema>;
export const publishMcpSchema = z.object({ serverId: z.uuid(), ...meta });
export type PublishMcpInput = z.infer<typeof publishMcpSchema>;
export const listingQuerySchema = z.object({
  kind: z.enum(['skill', 'mcp']).optional(),
  q: z.string().trim().max(100).optional(),
});
export type ListingQuery = z.infer<typeof listingQuerySchema>;
export const installSchema = z.object({ version: z.string().max(50).optional() });
export type InstallInput = z.infer<typeof installSchema>;

interface SkillManifest {
  files: StoredSkillFile[];
  allowedTools: string[];
  frontmatter: unknown;
}
interface McpManifest {
  endpointUrl: string;
  transport: string;
  authType: string;
  tools: Array<{ name: string; description: string | null; permissionLevel: string }>;
}

export interface ListingView {
  id: string;
  kind: 'skill' | 'mcp';
  name: string;
  title: string;
  description: string;
  publisher: string;
  latestVersion: string;
  installCount: number;
  status: string;
  /** 내 테넌트가 게시했나 · 설치했나 (Skill) */
  mine: boolean;
  installed: boolean;
  updatedAt: string;
}

export interface ListingDetail extends ListingView {
  versions: Array<{
    version: string;
    description: string;
    contentHash: string;
    keyId: string;
    /** 지금 플랫폼 키로 서명이 확인되는가 */
    signatureValid: boolean;
    publishedAt: string;
  }>;
  /** 최신 버전 내용 — Skill: 파일 · allowed-tools, MCP: 엔드포인트 · Tool */
  latest: SkillManifest | McpManifest;
}

/**
 * 마켓플레이스 (P2 — MCP 및 Skill 공유).
 *  - Skill: 검증을 통과한 내 Skill 버전을 게시한다. 파일은 마켓플레이스 저장소에 내용 주소로 복사하고, 이름 · 버전 ·
 *    내용 해시 · manifest 를 플랫폼 키로 서명한다. 설치하면 서명과 모든 파일 해시를 확인한 뒤 내 테넌트로 복사해
 *    업로드와 같은 검사(SKILL.md · 신뢰 검증 6항목, 서명 항목은 통과)를 거쳐 검토 대기 버전으로 만든다 — 활성화는 운영자가.
 *  - MCP: 등록한 서버의 연결 정보 · Tool 목록(비밀값 제외)을 템플릿으로 공유한다. 설치는 등록 마법사용 템플릿을 돌려줄 뿐
 *    — 연결 테스트 · Tool 검증 · API Key 입력은 설치하는 테넌트가 기존 등록 절차로 한다.
 *  - 목록은 모든 테넌트가 읽고, 새 버전 · 철회는 게시한 테넌트만 한다.
 */
@Injectable()
export class MarketplaceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ObjectStorage,
    private readonly store: SkillStoreService,
    private readonly skills: SkillsAdminService,
    private readonly signer: MarketplaceSigner,
    private readonly audit: AuditService,
  ) {}

  async publishSkill(
    admin: AdminSession,
    input: PublishSkillInput,
    req?: AdminRequest,
  ): Promise<ListingDetail> {
    const { skill, version, tenantName } = await this.prisma.withTenant(
      admin.tenantId,
      async (tx) => {
        const skill = await tx.skill.findFirst({ where: { id: input.skillId, deletedAt: null } });
        if (!skill) throw AppError.notFound('Skill 을 찾을 수 없습니다');
        if (skill.marketplaceListingId)
          throw new AppError(
            409,
            'NAME_TAKEN',
            '마켓플레이스에서 설치한 Skill 은 다시 게시할 수 없습니다',
          );
        const versionId = input.versionId ?? skill.activeVersionId;
        const version = versionId
          ? await tx.skillVersion.findFirst({ where: { id: versionId, skillId: skill.id } })
          : null;
        if (!version)
          throw AppError.notFound('게시할 Skill 버전이 없습니다 (활성 버전 또는 versionId)');
        if (version.verificationStatus !== 'passed')
          throw new AppError(
            422,
            'SKILL_VERIFICATION_FAILED',
            '신뢰 검증을 통과한 버전만 게시할 수 있습니다',
          );
        const tenant = await tx.tenant.findUniqueOrThrow({
          where: { id: admin.tenantId },
          select: { name: true },
        });
        return { skill, version, tenantName: tenant.name };
      },
    );

    // 파일을 마켓플레이스 저장소로 (내용 주소 — 같은 파일은 한 번만)
    const files = version.files as unknown as StoredSkillFile[];
    for (const file of files) {
      const key = blobKey(file.sha256);
      // 이미 있는 파일도 해시를 확인한다 — 손상 · 변조된 파일이 있으면 원본으로 덮어쓴다
      const existing = await this.storage.get(key);
      if (existing && sha256(existing) === file.sha256) continue;
      await this.storage.put(key, await this.store.read(admin.tenantId, file));
    }
    const manifest: SkillManifest = {
      files,
      allowedTools: version.allowedTools,
      frontmatter: version.frontmatter,
    };
    const listing = await this.publish(admin, {
      kind: 'skill',
      name: skill.name,
      version: version.version,
      description: version.description,
      title: input.title ?? skill.name,
      listingDescription: input.description ?? version.description,
      contentHash: version.contentHash,
      manifest,
      publisherName: tenantName,
    });
    await this.audited(
      admin,
      'marketplace.publish',
      listing.id,
      {
        kind: 'skill',
        name: skill.name,
        version: version.version,
      },
      req,
    );
    return this.get(admin, listing.id);
  }

  async publishMcp(
    admin: AdminSession,
    input: PublishMcpInput,
    req?: AdminRequest,
  ): Promise<ListingDetail> {
    const { server, tools, tenantName } = await this.prisma.withTenant(
      admin.tenantId,
      async (tx) => {
        const server = await tx.mcpServer.findFirst({
          where: { id: input.serverId, deletedAt: null },
        });
        if (!server) throw AppError.notFound('MCP 서버를 찾을 수 없습니다');
        if (server.status !== 'connected' || !server.endpointUrl)
          throw new AppError(
            409,
            'MCP_SERVER_STATE',
            '연결된 Streamable HTTP 서버만 공유할 수 있습니다',
          );
        const tools = await tx.mcpTool.findMany({
          where: { serverId: server.id, enabled: true },
          orderBy: { name: 'asc' },
          select: { name: true, description: true, permissionLevel: true },
        });
        const tenant = await tx.tenant.findUniqueOrThrow({
          where: { id: admin.tenantId },
          select: { name: true },
        });
        return { server, tools, tenantName: tenant.name };
      },
    );
    // 연결 정보 · Tool 목록만 — API Key · 허용 호스트 · 사설망 허용 같은 테넌트 설정은 공유하지 않는다
    const manifest: McpManifest = {
      endpointUrl: server.endpointUrl!,
      transport: server.transport,
      authType: server.authType,
      tools,
    };
    const contentHash = createHash('sha256').update(canonicalJson(manifest)).digest('hex');
    const existing = await this.prisma.marketplaceListing.findUnique({
      where: { kind_name: { kind: 'mcp', name: server.name } },
      include: { versions: { select: { version: true, contentHash: true } } },
    });
    if (existing?.versions.some((v) => v.contentHash === contentHash)) {
      throw new AppError(
        409,
        'SKILL_VERSION_EXISTS',
        '바뀐 내용이 없습니다 (같은 내용의 버전이 있습니다)',
      );
    }
    const listing = await this.publish(admin, {
      kind: 'mcp',
      name: server.name,
      version: nextPatch(existing?.versions.map((v) => v.version) ?? []),
      description: server.description ?? '',
      title: input.title ?? server.name,
      listingDescription: input.description ?? server.description ?? server.name,
      contentHash,
      manifest,
      publisherName: tenantName,
    });
    await this.audited(
      admin,
      'marketplace.publish',
      listing.id,
      { kind: 'mcp', name: server.name },
      req,
    );
    return this.get(admin, listing.id);
  }

  async list(admin: AdminSession, q: ListingQuery): Promise<ListingView[]> {
    const rows = await this.prisma.marketplaceListing.findMany({
      where: {
        OR: [{ status: 'published' }, { publisherTenantId: admin.tenantId }],
        ...(q.kind ? { kind: q.kind } : {}),
        ...(q.q
          ? {
              AND: [
                {
                  OR: [
                    { name: { contains: q.q, mode: 'insensitive' } },
                    { title: { contains: q.q, mode: 'insensitive' } },
                    { description: { contains: q.q, mode: 'insensitive' } },
                  ],
                },
              ],
            }
          : {}),
      },
      orderBy: [{ installCount: 'desc' }, { updatedAt: 'desc' }],
      take: 100,
    });
    const installed = await this.installedListings(admin.tenantId);
    return rows.map((r) => toView(r, admin.tenantId, installed));
  }

  async get(admin: AdminSession, id: string): Promise<ListingDetail> {
    const listing = await this.prisma.marketplaceListing.findUnique({
      where: { id },
      include: { versions: { orderBy: { publishedAt: 'desc' } } },
    });
    if (
      !listing ||
      (listing.status !== 'published' && listing.publisherTenantId !== admin.tenantId)
    )
      throw AppError.notFound('마켓플레이스 항목을 찾을 수 없습니다');
    const installed = await this.installedListings(admin.tenantId);
    const versions = [];
    for (const v of listing.versions) {
      versions.push({
        version: v.version,
        description: v.description,
        contentHash: v.contentHash,
        keyId: v.keyId,
        signatureValid: await this.signer.verify(signed(listing, v), v.signature, v.keyId),
        publishedAt: v.publishedAt.toISOString(),
      });
    }
    return {
      ...toView(listing, admin.tenantId, installed),
      versions,
      latest: listing.versions[0]!.manifest as unknown as SkillManifest | McpManifest,
    };
  }

  /**
   * 설치 — Skill: 서명 · 파일 해시를 확인하고 내 테넌트에 검토 대기 버전으로 복사 (활성화는 Skill 관리에서).
   * MCP: 등록 마법사에 넣을 템플릿을 돌려준다 (연결 테스트 · 등록은 기존 절차).
   */
  async install(admin: AdminSession, id: string, input: InstallInput, req?: AdminRequest) {
    const listing = await this.prisma.marketplaceListing.findUnique({
      where: { id },
      include: { versions: { orderBy: { publishedAt: 'desc' } } },
    });
    if (!listing || listing.status !== 'published')
      throw AppError.notFound('설치할 수 있는 마켓플레이스 항목이 없습니다');
    const version = input.version
      ? listing.versions.find((v) => v.version === input.version)
      : listing.versions[0];
    if (!version) throw AppError.notFound(`버전 ${input.version} 이(가) 없습니다`);
    if (!(await this.signer.verify(signed(listing, version), version.signature, version.keyId)))
      throw new AppError(422, 'MARKETPLACE_SIGNATURE_INVALID', '서명이 내용과 맞지 않습니다');

    if (listing.kind === 'mcp') {
      const manifest = version.manifest as unknown as McpManifest;
      await this.countInstall(listing.id);
      await this.audited(
        admin,
        'marketplace.install',
        listing.id,
        { kind: 'mcp', version: version.version },
        req,
      );
      return {
        kind: 'mcp' as const,
        listingId: listing.id,
        version: version.version,
        template: {
          name: listing.name,
          description: version.description || listing.description,
          transport: manifest.transport,
          endpointUrl: manifest.endpointUrl,
          authType: manifest.authType,
          tools: manifest.tools,
        },
      };
    }

    const manifest = version.manifest as unknown as SkillManifest;
    const files: BundleFile[] = [];
    for (const file of manifest.files) {
      const data = await this.storage.get(blobKey(file.sha256));
      if (!data || sha256(data) !== file.sha256)
        throw new AppError(
          422,
          'MARKETPLACE_SIGNATURE_INVALID',
          `파일이 게시 내용과 다릅니다: ${file.path}`,
        );
      files.push({ ...file, data });
    }
    if (bundleHash(files) !== version.contentHash)
      throw new AppError(422, 'MARKETPLACE_SIGNATURE_INVALID', '번들 해시가 게시 내용과 다릅니다');
    await this.store.putFiles(admin.tenantId, files);
    const result = await this.skills.ingest(
      admin,
      files,
      {
        kind: 'marketplace',
        listingId: listing.id,
        listing: listing.name,
        version: version.version,
        publisher: listing.publisherName,
        keyId: version.keyId,
      },
      req,
    );
    if (!result.duplicate) await this.countInstall(listing.id);
    return {
      kind: 'skill' as const,
      listingId: listing.id,
      marketplaceVersion: version.version,
      ...result,
    };
  }

  /** 철회 — 목록 · 설치에서 빠진다 (이미 설치한 테넌트의 Skill 은 그대로). 게시한 테넌트만 */
  async withdraw(admin: AdminSession, id: string, req?: AdminRequest): Promise<ListingView> {
    const listing = await this.prisma.marketplaceListing.findUnique({ where: { id } });
    if (!listing) throw AppError.notFound();
    if (listing.publisherTenantId !== admin.tenantId)
      throw new AppError(403, 'FORBIDDEN', '게시한 테넌트만 철회할 수 있습니다');
    const updated = await this.prisma.marketplaceListing.update({
      where: { id },
      data: { status: 'withdrawn' },
    });
    await this.audited(
      admin,
      'marketplace.withdraw',
      id,
      { kind: listing.kind, name: listing.name },
      req,
    );
    return toView(updated, admin.tenantId, await this.installedListings(admin.tenantId));
  }

  private async publish(
    admin: AdminSession,
    input: {
      kind: 'skill' | 'mcp';
      name: string;
      version: string;
      description: string;
      title: string;
      listingDescription: string;
      contentHash: string;
      manifest: SkillManifest | McpManifest;
      publisherName: string;
    },
  ): Promise<MarketplaceListing> {
    const content: SignedContent = {
      kind: input.kind,
      name: input.name,
      version: input.version,
      contentHash: input.contentHash,
      manifest: input.manifest,
    };
    const { signature, keyId } = await this.signer.sign(content);
    return this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<Array<{ id: string; publisher_tenant_id: string }>>`
        SELECT id, publisher_tenant_id FROM marketplace_listings
        WHERE kind = ${input.kind} AND name = ${input.name} FOR UPDATE`;
      if (locked && locked.publisher_tenant_id !== admin.tenantId)
        throw new AppError(
          409,
          'NAME_TAKEN',
          `다른 테넌트가 같은 이름(${input.name})으로 게시했습니다`,
        );
      const listingId = locked?.id ?? uuidv7();
      if (!locked) {
        await tx.marketplaceListing.create({
          data: {
            id: listingId,
            kind: input.kind,
            name: input.name,
            title: input.title,
            description: input.listingDescription,
            publisherTenantId: admin.tenantId,
            publisherName: input.publisherName,
            latestVersion: input.version,
          },
        });
      } else if (
        await tx.marketplaceVersion.findUnique({
          where: { listingId_version: { listingId, version: input.version } },
        })
      ) {
        throw new AppError(
          409,
          'SKILL_VERSION_EXISTS',
          `${input.name} ${input.version} 은(는) 이미 게시했습니다 — 버전을 올려 주세요`,
        );
      }
      await tx.marketplaceVersion.create({
        data: {
          id: uuidv7(),
          listingId,
          version: input.version,
          description: input.description,
          manifest: input.manifest as unknown as Prisma.InputJsonValue,
          contentHash: input.contentHash,
          signature,
          keyId,
        },
      });
      return tx.marketplaceListing.update({
        where: { id: listingId },
        data: {
          status: 'published',
          latestVersion: input.version,
          title: input.title,
          description: input.listingDescription,
          publisherName: input.publisherName,
        },
      });
    });
  }

  private async countInstall(listingId: string): Promise<void> {
    await this.prisma.marketplaceListing.update({
      where: { id: listingId },
      data: { installCount: { increment: 1 } },
    });
  }

  private async installedListings(tenantId: string): Promise<Set<string>> {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.skill.findMany({
        where: { marketplaceListingId: { not: null }, deletedAt: null },
        select: { marketplaceListingId: true },
      }),
    );
    return new Set(rows.map((r) => r.marketplaceListingId!));
  }

  private async audited(
    admin: AdminSession,
    action: string,
    listingId: string,
    metadata: Record<string, unknown>,
    req?: AdminRequest,
  ): Promise<void> {
    await this.prisma.withTenant(admin.tenantId, (tx) =>
      this.audit.record(
        tx,
        admin,
        { action, targetType: 'marketplace_listing', targetId: listingId, metadata },
        req,
      ),
    );
  }
}

function signed(listing: MarketplaceListing, version: MarketplaceVersion): SignedContent {
  return {
    kind: listing.kind,
    name: listing.name,
    version: version.version,
    contentHash: version.contentHash,
    manifest: version.manifest,
  };
}

function toView(r: MarketplaceListing, tenantId: string, installed: Set<string>): ListingView {
  return {
    id: r.id,
    kind: r.kind as ListingView['kind'],
    name: r.name,
    title: r.title,
    description: r.description,
    publisher: r.publisherName,
    latestVersion: r.latestVersion,
    installCount: r.installCount,
    status: r.status,
    mine: r.publisherTenantId === tenantId,
    installed: installed.has(r.id),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function blobKey(hash: string): string {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('잘못된 파일 해시');
  return `marketplace/blobs/${hash.slice(0, 2)}/${hash}`;
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function nextPatch(versions: string[]): string {
  const parsed = versions
    .map((v) => /^(\d+)\.(\d+)\.(\d+)$/.exec(v))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => [Number(m[1]), Number(m[2]), Number(m[3])] as const)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const last = parsed.at(-1);
  return last ? `${last[0]}.${last[1]}.${last[2] + 1}` : '1.0.0';
}
