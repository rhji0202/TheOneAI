import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * 파일 저장소 추상화 (Skill 번들 · 이후 산출물). DB 에는 키만 저장한다.
 * 운영 구현(S3)은 같은 인터페이스로 산출물 단계에서 추가한다.
 */
export abstract class ObjectStorage {
  abstract put(key: string, data: Buffer): Promise<void>;
  /** 없으면 null */
  abstract get(key: string): Promise<Buffer | null>;
  abstract exists(key: string): Promise<boolean>;
  abstract deletePrefix(prefix: string): Promise<void>;
}

/** 키 형식 — 경로 탈출이 불가능한 문자만 (a-z 0-9 / _ . -, `..` 금지) */
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/;

export function assertKey(key: string): void {
  if (
    !KEY_PATTERN.test(key) ||
    key.split('/').some((part) => part === '..' || part === '.' || part === '')
  ) {
    throw new Error(`저장소 키 형식 오류: ${key}`);
  }
}

/** 내용 주소 키 (같은 내용은 한 번만 저장) */
export function contentKey(prefix: string, data: Buffer): { key: string; sha256: string } {
  const sha256 = createHash('sha256').update(data).digest('hex');
  return { key: `${prefix}/${sha256.slice(0, 2)}/${sha256}`, sha256 };
}

/** 개발 · 테스트 전용: 로컬 디렉터리 (API · Worker 가 같은 머신에서 공유). production 에서는 설정 단계에서 거부 */
export class LocalObjectStorage extends ObjectStorage {
  private readonly root: string;

  constructor(dir: string) {
    super();
    this.root = resolve(dir);
  }

  async put(key: string, data: Buffer): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, path);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.path(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      return (await stat(this.path(key))).isFile();
    } catch {
      return false;
    }
  }

  async deletePrefix(prefix: string): Promise<void> {
    await rm(this.path(prefix), { recursive: true, force: true });
  }

  private path(key: string): string {
    assertKey(key);
    const full = resolve(join(this.root, key));
    if (!full.startsWith(this.root + sep)) throw new Error(`저장소 경로 탈출: ${key}`);
    return full;
  }
}
