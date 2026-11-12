import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../../admin/audit/audit.service.js';
import type { AdminRequest, AdminSession } from '../../admin/auth/admin-session.js';
import { AppError } from '../../common/errors/app-error.js';
import type { Prisma, Skill, SkillVersion } from '../../generated/prisma/client.js';
import { PrismaService, type TenantTx } from '../../infrastructure/database/prisma.service.js';
import { type PublishedVersion, ToolRegistryService } from '../../tools/tool-registry.service.js';
import {
  BundleError,
  type BundleFile,
  bundleHash,
  decodeText,
  readSkillZip,
} from '../bundle/skill-bundle.js';
import { parseSkillMd, SkillParseError } from '../skill-md.js';
import {
  SkillStoreService,
  type StoredSkillFile,
  storedFilesSchema,
} from '../skill-store.service.js';
import {
  overallStatus,
  type SkillBundleSource,
  type VerificationCheck,
  verifySkill,
} from '../skill-verifier.js';

export const skillListQuerySchema = z.object({
  status: z.enum(['active', 'pending_review', 'inactive', 'verification_failed']).optional(),
  q: z.string().trim().max(100).optional(),
});
export type SkillListQuery = z.infer<typeof skillListQuerySchema>;

export interface SkillVersionSummary {
  id: string;
  version: string;
  description: string;
  allowedTools: string[];
  contentHash: string;
  verificationStatus: SkillVersion['verificationStatus'];
  active: boolean;
  createdAt: string;
}

export interface SkillView {
  id: string;
  name: string;
  source: Skill['source'];
  status: Skill['status'];
  activeVersion: SkillVersionSummary | null;
  latestVersion: SkillVersionSummary | null;
  createdAt: string;
  updatedAt: string;
}

export interface SkillVersionDetail extends SkillVersionSummary {
  skillId: string;
  frontmatter: unknown;
  files: StoredSkillFile[];
  verification: VerificationCheck[];
}

export interface UploadResult {
  skill: SkillView;
  version: SkillVersionDetail;
  /** 같은 내용이 이미 등록되어 있어 새 버전을 만들지 않음 */
  duplicate: boolean;
  warnings: string[];
}

const MAX_PREVIEW_BYTES = 1024 * 1024;

/**
 * Skill 관리 (C-06). zip 업로드 → 번들 · SKILL.md 검사 → 신뢰 검증 → 버전 저장(검토 대기) → 운영자가 활성화하면 새 Registry 버전.
 * 검증은 요청 안에서 끝낸다(번들 상한 16MB · 512개라 수 초 이내) — 결과를 바로 화면에 보여 준다.
 */
@Injectable()
export class SkillsAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: SkillStoreService,
    private readonly registry: ToolRegistryService,
    private readonly audit: AuditService,
  ) {}

  async upload(admin: AdminSession, zip: Buffer, req?: AdminRequest): Promise<UploadResult> {
    let files: Awaited<ReturnType<typeof readSkillZip>>;
    try {
      files = await readSkillZip(zip);
    } catch (err) {
      if (err instanceof BundleError)
        throw new AppError(422, 'SKILL_PARSE_FAILED', err.message, [
          { path: 'bundle', message: err.message },
        ]);
      throw err;
    }
    return this.ingest(admin, files, { kind: 'upload', uploadedBy: admin.email }, req);
  }

  /**
   * 번들 → SKILL.md 검사 → 신뢰 검증 → 버전 저장(검토 대기). 업로드와 마켓플레이스 설치가 같은 경로를 쓴다.
   * 마켓플레이스에서 설치한 Skill 은 같은 목록에서만 새 버전을 받는다 (업로드 · 다른 목록과 이름이 겹치면 NAME_TAKEN).
   */
  async ingest(
    admin: AdminSession,
    files: BundleFile[],
    source: SkillBundleSource,
    req?: AdminRequest,
  ): Promise<UploadResult> {
    const skillFile = files.find((f) => f.kind === 'skill')!;
    const text = decodeText(skillFile.data);
    if (text === null)
      throw new AppError(422, 'SKILL_PARSE_FAILED', 'SKILL.md 가 UTF-8 텍스트가 아닙니다');
    let parsed: ReturnType<typeof parseSkillMd>;
    try {
      parsed = parseSkillMd(text);
    } catch (err) {
      if (err instanceof SkillParseError) {
        throw new AppError(
          422,
          'SKILL_PARSE_FAILED',
          undefined,
          err.issues.map((i) => ({ path: `SKILL.md:${i.line}`, line: i.line, message: i.message })),
        );
      }
      throw err;
    }
    const contentHash = bundleHash(files);
    const stored: StoredSkillFile[] = files.map(({ path, size, sha256, kind }) => ({
      path,
      size,
      sha256,
      kind,
    }));

    // 파일을 먼저 저장한다 (내용 주소라 중복 저장 없음, DB 롤백 시 남는 파일은 무해)
    await this.store.putFiles(admin.tenantId, files);

    const result = await this.prisma.withTenant(admin.tenantId, async (tx) => {
      let skill = await tx.skill.findFirst({ where: { name: parsed.name, deletedAt: null } });
      const listingId = source.kind === 'marketplace' ? source.listingId : null;
      if (skill && skill.marketplaceListingId !== listingId) {
        throw new AppError(
          409,
          'NAME_TAKEN',
          skill.marketplaceListingId
            ? `${parsed.name} 은(는) 마켓플레이스에서 설치한 Skill 입니다 — 새 버전은 마켓플레이스에서 설치하세요`
            : `같은 이름의 Skill(${parsed.name})이 이미 있습니다`,
        );
      }
      const versions = skill
        ? await tx.skillVersion.findMany({ where: { skillId: skill.id } })
        : [];
      const same = versions.find((v) => v.contentHash === contentHash);
      if (skill && same) return { skill, version: same, duplicate: true };

      const version = parsed.version ?? nextPatch(versions.map((v) => v.version));
      if (versions.some((v) => v.version === version)) {
        throw new AppError(
          409,
          'SKILL_VERSION_EXISTS',
          `${parsed.name} ${version} 이(가) 이미 다른 내용으로 있습니다 — SKILL.md 의 version 을 올려 주세요`,
        );
      }
      const knownTools = (await this.registry.latestTools(tx, admin.tenantId)).map((t) => ({
        name: t.name,
        level: t.level,
      }));
      const verification = verifySkill({
        source,
        files,
        contentHash,
        skill: parsed,
        knownTools,
      });
      const status = overallStatus(verification);

      skill ??= await tx.skill.create({
        data: {
          tenantId: admin.tenantId,
          name: parsed.name,
          source: source.kind,
          marketplaceListingId: listingId,
          status: 'pending_review',
        },
      });
      const created = await tx.skillVersion.create({
        data: {
          tenantId: admin.tenantId,
          skillId: skill.id,
          version,
          description: parsed.description,
          allowedTools: parsed.allowedTools,
          frontmatter: parsed.frontmatter as Prisma.InputJsonValue,
          contentHash,
          bundleKey: this.store.bundlePrefix(admin.tenantId),
          files: stored as unknown as Prisma.InputJsonValue,
          verificationStatus: status,
          verification: verification as unknown as Prisma.InputJsonValue,
          createdById: admin.userId,
          signatureVerified: source.kind === 'marketplace',
        },
      });
      // 활성 버전이 없는 Skill 만 상태를 바꾼다 (활성 Skill 은 새 버전을 활성화할 때까지 그대로)
      if (!skill.activeVersionId) {
        skill = await tx.skill.update({
          where: { id: skill.id },
          data: { status: status === 'failed' ? 'verification_failed' : 'pending_review' },
        });
      }
      await this.audit.record(
        tx,
        admin,
        {
          action: source.kind === 'upload' ? 'skill.upload' : 'skill.install',
          targetType: 'skill',
          targetId: skill.id,
          metadata: { name: parsed.name, version, contentHash, verification: status },
        },
        req,
      );
      return { skill, version: created, duplicate: false };
    });

    return {
      skill: await this.get(admin, result.skill.id),
      version: toDetail(result.version, result.skill.activeVersionId),
      duplicate: result.duplicate,
      warnings: parsed.warnings,
    };
  }

  async list(admin: AdminSession, query: SkillListQuery): Promise<SkillView[]> {
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      const skills = await tx.skill.findMany({
        where: {
          deletedAt: null,
          ...(query.status ? { status: query.status } : {}),
          ...(query.q ? { name: { contains: query.q, mode: 'insensitive' } } : {}),
        },
        include: { versions: { orderBy: { createdAt: 'desc' } } },
        orderBy: { name: 'asc' },
      });
      return skills.map((s) => toView(s, s.versions));
    });
  }

  async get(admin: AdminSession, id: string): Promise<SkillView> {
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      const skill = await this.find(tx, id);
      const versions = await tx.skillVersion.findMany({
        where: { skillId: id },
        orderBy: { createdAt: 'desc' },
      });
      return toView(skill, versions);
    });
  }

  async versions(admin: AdminSession, id: string): Promise<SkillVersionSummary[]> {
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      const skill = await this.find(tx, id);
      const versions = await tx.skillVersion.findMany({
        where: { skillId: id },
        orderBy: { createdAt: 'desc' },
      });
      return versions.map((v) => toSummary(v, skill.activeVersionId));
    });
  }

  async version(admin: AdminSession, id: string, versionId: string): Promise<SkillVersionDetail> {
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      const skill = await this.find(tx, id);
      return toDetail(await this.findVersion(tx, id, versionId), skill.activeVersionId);
    });
  }

  /** 파일 내용 (텍스트, 1MB 이하) — C-06 파일 미리보기 */
  async file(admin: AdminSession, id: string, versionId: string, path: string) {
    const version = await this.prisma.withTenant(admin.tenantId, async (tx) => {
      await this.find(tx, id);
      return this.findVersion(tx, id, versionId);
    });
    const file = storedFilesSchema.parse(version.files).find((f) => f.path === path);
    if (!file) throw AppError.notFound('번들에 없는 파일입니다');
    if (file.size > MAX_PREVIEW_BYTES)
      throw new AppError(422, 'VALIDATION_FAILED', '1MB 를 넘는 파일은 미리보기할 수 없습니다');
    const text = decodeText(await this.store.read(admin.tenantId, file));
    if (text === null) throw new AppError(422, 'VALIDATION_FAILED', '텍스트 파일이 아닙니다');
    return { path: file.path, kind: file.kind, size: file.size, sha256: file.sha256, text };
  }

  /** 버전 비교 — 파일(추가 · 삭제 · 변경)과 metadata */
  async diff(admin: AdminSession, id: string, versionId: string, against?: string) {
    return this.prisma.withTenant(admin.tenantId, async (tx) => {
      await this.find(tx, id);
      const target = await this.findVersion(tx, id, versionId);
      const base = against
        ? await this.findVersion(tx, id, against)
        : await tx.skillVersion.findFirst({
            where: { skillId: id, createdAt: { lt: target.createdAt } },
            orderBy: { createdAt: 'desc' },
          });
      const before = new Map(
        storedFilesSchema.parse(base?.files ?? []).map((f) => [f.path, f.sha256]),
      );
      const after = new Map(storedFilesSchema.parse(target.files).map((f) => [f.path, f.sha256]));
      return {
        from: base ? { id: base.id, version: base.version } : null,
        to: { id: target.id, version: target.version },
        files: {
          added: [...after.keys()].filter((p) => !before.has(p)),
          removed: [...before.keys()].filter((p) => !after.has(p)),
          changed: [...after.keys()].filter((p) => before.has(p) && before.get(p) !== after.get(p)),
        },
        metadata: {
          description:
            base?.description !== target.description
              ? { from: base?.description ?? null, to: target.description }
              : null,
          allowedTools:
            (base?.allowedTools ?? []).join() !== target.allowedTools.join()
              ? { from: base?.allowedTools ?? [], to: target.allowedTools }
              : null,
        },
      };
    });
  }

  /** 활성 버전 변경 → 새 Registry 버전 (검증 통과 버전만) */
  async activate(
    admin: AdminSession,
    id: string,
    versionId: string,
    req?: AdminRequest,
  ): Promise<{ skill: SkillView; registry: PublishedVersion }> {
    const registry = await this.prisma.withTenant(admin.tenantId, async (tx) => {
      const skill = await this.find(tx, id);
      const version = await this.findVersion(tx, id, versionId);
      if (version.verificationStatus !== 'passed') {
        const failed = (version.verification as unknown as VerificationCheck[])
          .filter((c) => c.status === 'failed')
          .map((c) => ({ path: c.check, message: c.detail }));
        throw new AppError(422, 'SKILL_VERIFICATION_FAILED', undefined, failed);
      }
      await tx.skill.update({
        where: { id },
        data: { activeVersionId: versionId, status: 'active' },
      });
      const published = await this.registry.publish(tx, admin.tenantId, {
        reason: 'skill_activated',
        skill: skill.name,
        version: version.version,
      });
      await this.audit.record(
        tx,
        admin,
        {
          action: 'skill.activate',
          targetType: 'skill',
          targetId: id,
          metadata: {
            version: version.version,
            from: skill.activeVersionId,
            registryVersion: published.version,
          },
        },
        req,
      );
      return published;
    });
    return { skill: await this.get(admin, id), registry };
  }

  /** 비활성화 — 새 작업의 Registry 에서 빠지고, 실행 중 작업도 다음 Skill 단계부터 쓰지 않는다 */
  async disable(
    admin: AdminSession,
    id: string,
    req?: AdminRequest,
  ): Promise<{ skill: SkillView; registry: PublishedVersion }> {
    const registry = await this.prisma.withTenant(admin.tenantId, async (tx) => {
      const skill = await this.find(tx, id);
      await tx.skill.update({ where: { id }, data: { status: 'inactive' } });
      const published = await this.registry.publish(tx, admin.tenantId, {
        reason: 'skill_disabled',
        skill: skill.name,
      });
      await this.audit.record(
        tx,
        admin,
        { action: 'skill.disable', targetType: 'skill', targetId: id },
        req,
      );
      return published;
    });
    return { skill: await this.get(admin, id), registry };
  }

  private async find(tx: TenantTx, id: string): Promise<Skill> {
    const skill = await tx.skill.findFirst({ where: { id, deletedAt: null } });
    if (!skill) throw AppError.notFound();
    return skill;
  }

  private async findVersion(
    tx: TenantTx,
    skillId: string,
    versionId: string,
  ): Promise<SkillVersion> {
    const version = await tx.skillVersion.findFirst({ where: { id: versionId, skillId } });
    if (!version) throw AppError.notFound();
    return version;
  }
}

function toSummary(v: SkillVersion, activeVersionId: string | null): SkillVersionSummary {
  return {
    id: v.id,
    version: v.version,
    description: v.description,
    allowedTools: v.allowedTools,
    contentHash: v.contentHash,
    verificationStatus: v.verificationStatus,
    active: v.id === activeVersionId,
    createdAt: v.createdAt.toISOString(),
  };
}

function toDetail(v: SkillVersion, activeVersionId: string | null): SkillVersionDetail {
  return {
    ...toSummary(v, activeVersionId),
    skillId: v.skillId,
    frontmatter: v.frontmatter,
    files: storedFilesSchema.parse(v.files),
    verification: v.verification as unknown as VerificationCheck[],
  };
}

function toView(s: Skill, versions: SkillVersion[]): SkillView {
  const active = versions.find((v) => v.id === s.activeVersionId);
  return {
    id: s.id,
    name: s.name,
    source: s.source,
    status: s.status,
    activeVersion: active ? toSummary(active, s.activeVersionId) : null,
    latestVersion: versions[0] ? toSummary(versions[0], s.activeVersionId) : null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

/** 버전이 없으면 1.0.0, 있으면 가장 높은 버전의 patch + 1 */
export function nextPatch(existing: string[]): string {
  const parsed = existing
    .map((v) => /^(\d+)\.(\d+)\.(\d+)/.exec(v))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => [Number(m[1]), Number(m[2]), Number(m[3])] as const)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const top = parsed.at(-1);
  return top ? `${top[0]}.${top[1]}.${top[2] + 1}` : '1.0.0';
}
