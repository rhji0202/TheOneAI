import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ObjectStorage } from '../infrastructure/storage/object-storage.js';
import type { BundleFile, BundleFileKind } from './bundle/skill-bundle.js';

/** skill_versions.files 한 줄 */
export interface StoredSkillFile {
  path: string;
  size: number;
  sha256: string;
  kind: BundleFileKind;
}

export const storedFilesSchema = z
  .array(
    z.object({
      path: z.string(),
      size: z.number(),
      sha256: z.string(),
      kind: z.enum(['skill', 'doc', 'template', 'script', 'asset']),
    }),
  )
  .catch([]);

export class SkillFileIntegrityError extends Error {
  constructor(path: string) {
    super(`Skill 파일 해시가 맞지 않습니다 (변조 의심): ${path}`);
    this.name = 'SkillFileIntegrityError';
  }
}

/**
 * Skill 번들 파일 저장 — 내용 주소(sha256) 키로 테넌트별로 한 번만 저장한다.
 * 읽을 때마다 해시를 다시 확인해, 저장소에서 바뀐 파일은 쓰지 않는다.
 */
@Injectable()
export class SkillStoreService {
  constructor(private readonly storage: ObjectStorage) {}

  bundlePrefix(tenantId: string): string {
    return `skills/${tenantId}/blobs`;
  }

  async putFiles(tenantId: string, files: BundleFile[]): Promise<void> {
    for (const file of files) {
      const key = this.key(tenantId, file.sha256);
      if (!(await this.storage.exists(key))) await this.storage.put(key, file.data);
    }
  }

  async read(tenantId: string, file: Pick<StoredSkillFile, 'path' | 'sha256'>): Promise<Buffer> {
    const data = await this.storage.get(this.key(tenantId, file.sha256));
    if (!data || createHash('sha256').update(data).digest('hex') !== file.sha256) {
      throw new SkillFileIntegrityError(file.path);
    }
    return data;
  }

  private key(tenantId: string, sha256: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('잘못된 파일 해시');
    return `${this.bundlePrefix(tenantId)}/${sha256.slice(0, 2)}/${sha256}`;
  }
}
