import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Secret 저장 · 조회 추상화. DB 에는 vault://… 참조만 저장하고 값은 여기서 다룬다.
 * 운영 구현(Vault · 클라우드 Secret Manager)은 같은 인터페이스로 추가한다.
 */
export abstract class SecretStore {
  /** 참조가 없으면 null */
  abstract get(ref: string): Promise<string | null>;
  /** 값 저장 (write-only — 저장한 값은 API 응답 · 로그에 다시 나타나지 않는다) */
  abstract put(ref: string, value: string): Promise<void>;
  abstract delete(ref: string): Promise<void>;
}

const fileSchema = z.record(z.string(), z.string());

/**
 * 개발 · 테스트 전용: DEV_SECRETS(환경 변수, 읽기 전용) + 파일 저장소(LOCAL_SECRETS_FILE).
 * 파일이 없으면 메모리에만 저장한다 — API 와 Worker 가 한 프로세스인 테스트에서만 충분하다.
 * production 에서는 설정 단계에서 거부된다.
 */
export class LocalSecretStore extends SecretStore {
  private readonly memory = new Map<string, string>();

  constructor(
    private readonly fixed: Record<string, string>,
    private readonly file: string | null = null,
  ) {
    super();
  }

  async get(ref: string): Promise<string | null> {
    if (this.memory.has(ref)) return this.memory.get(ref)!;
    const stored = this.readFile()[ref];
    if (stored !== undefined) return stored;
    return this.fixed[ref] ?? null;
  }

  async put(ref: string, value: string): Promise<void> {
    if (!this.file) {
      this.memory.set(ref, value);
      return;
    }
    this.writeFile({ ...this.readFile(), [ref]: value });
  }

  async delete(ref: string): Promise<void> {
    this.memory.delete(ref);
    if (!this.file) return;
    const { [ref]: _removed, ...rest } = this.readFile();
    this.writeFile(rest);
  }

  private readFile(): Record<string, string> {
    if (!this.file || !existsSync(this.file)) return {};
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(this.file, 'utf8')));
    return parsed.success ? parsed.data : {};
  }

  private writeFile(data: Record<string, string>): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file!);
  }
}
