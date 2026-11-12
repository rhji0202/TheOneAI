import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infrastructure/database/prisma.service.js';
import type { SnapshotSkill } from '../tools/tool.types.js';
import { decodeText } from './bundle/skill-bundle.js';
import { parseSkillMd } from './skill-md.js';
import {
  SkillStoreService,
  type StoredSkillFile,
  storedFilesSchema,
} from './skill-store.service.js';

/** 선택된 Skill 의 전체 지침 · 파일 목록 (Skill 단계에서만 로딩 — progressive disclosure) */
export interface LoadedSkill {
  name: string;
  version: string;
  versionId: string;
  allowedTools: string[];
  /** SKILL.md 본문 (frontmatter 제외) */
  instructions: string;
  /** SKILL.md 를 뺀 번들 파일 */
  files: StoredSkillFile[];
}

export class SkillUnavailableError extends Error {}

const MAX_READ_BYTES = 200 * 1024;

/**
 * 실행 중 Skill 로딩.
 *  - 작업이 고정한 Registry 의 Skill 버전(versionId · contentHash)을 그대로 쓴다 — 운영자가 새 버전을 활성화해도 실행 중 작업은 그대로
 *  - 쓸 수 있는가는 매번 확인: Agent 허용 목록 · Skill 상태(비활성화 즉시 반영)
 *  - 파일은 읽을 때마다 sha256 을 다시 확인한다
 */
@Injectable()
export class SkillRuntimeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: SkillStoreService,
  ) {}

  /** 고정된 스냅샷의 Skill 중 이 Agent 버전이 허용하고 지금 활성인 것 */
  async available(
    tenantId: string,
    agentVersionId: string,
    skills: SnapshotSkill[],
  ): Promise<SnapshotSkill[]> {
    if (!skills.length) return [];
    const allowed = await this.prisma.withTenant(tenantId, (tx) =>
      tx.agentVersionSkill.findMany({
        where: {
          agentVersionId,
          enabled: true,
          skill: { status: 'active', deletedAt: null },
        },
        select: { skillId: true },
      }),
    );
    const ids = new Set(allowed.map((a) => a.skillId));
    return skills.filter((s) => ids.has(s.skillId));
  }

  async load(tenantId: string, skill: SnapshotSkill): Promise<LoadedSkill> {
    const version = await this.prisma.withTenant(tenantId, (tx) =>
      tx.skillVersion.findFirst({ where: { id: skill.versionId, skillId: skill.skillId } }),
    );
    if (!version || version.contentHash !== skill.contentHash) {
      throw new SkillUnavailableError(
        `Skill ${skill.name} ${skill.version} 을(를) 찾을 수 없습니다`,
      );
    }
    const files = storedFilesSchema.parse(version.files);
    const skillFile = files.find((f) => f.kind === 'skill');
    if (!skillFile) throw new SkillUnavailableError(`Skill ${skill.name} 에 SKILL.md 가 없습니다`);
    const text = decodeText(await this.store.read(tenantId, skillFile));
    if (text === null)
      throw new SkillUnavailableError(`Skill ${skill.name} 의 SKILL.md 를 읽을 수 없습니다`);
    return {
      name: skill.name,
      version: skill.version,
      versionId: skill.versionId,
      allowedTools: skill.allowedTools,
      instructions: parseSkillMd(text).body,
      files: files.filter((f) => f.kind !== 'skill'),
    };
  }

  /** 번들 안 텍스트 파일 읽기 (참조 문서 · 템플릿 · 스크립트 원문). 이진 파일 · 큰 파일은 거부 */
  async readFile(
    tenantId: string,
    skill: LoadedSkill,
    path: string,
  ): Promise<{ path: string; kind: string; text: string; truncated: boolean }> {
    const normalized = path.replace(/^\.\//, '');
    const file = skill.files.find((f) => f.path === normalized);
    if (!file) throw new SkillUnavailableError(`'${path}' is not a file of skill ${skill.name}`);
    if (file.kind === 'asset')
      throw new SkillUnavailableError(`'${path}' is a binary file and cannot be read as text`);
    const text = decodeText(await this.store.read(tenantId, file));
    if (text === null) throw new SkillUnavailableError(`'${path}' is not UTF-8 text`);
    const truncated = Buffer.byteLength(text) > MAX_READ_BYTES;
    return {
      path: file.path,
      kind: file.kind,
      text: truncated ? text.slice(0, MAX_READ_BYTES) : text,
      truncated,
    };
  }
}
