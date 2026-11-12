import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { Readable } from 'node:stream';
import yauzl, { type Entry, type ZipFile } from 'yauzl';

/** Agent Skills 표준 · MCP Skills 확장과 같은 상한 (파일 512개, 압축 해제 후 16MB) */
export const BUNDLE_LIMITS = {
  files: 512,
  bytes: 16 * 1024 * 1024,
  zipBytes: 20 * 1024 * 1024,
} as const;

export type BundleFileKind = 'skill' | 'doc' | 'template' | 'script' | 'asset';

export interface BundleFile {
  path: string;
  size: number;
  sha256: string;
  kind: BundleFileKind;
  data: Buffer;
}

export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleError';
  }
}

const SCRIPT_EXT = new Set([
  '.py',
  '.sh',
  '.bash',
  '.zsh',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.rb',
  '.pl',
  '.ps1',
  '.bat',
  '.cmd',
  '.php',
]);
const TEXT_EXT = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.csv',
  '.tsv',
  '.html',
  '.htm',
  '.xml',
  '.toml',
  '.ini',
  '.sql',
]);
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/**
 * zip 번들 읽기 — zip-slip(절대 경로 · `..`) · 심볼릭 링크 · 암호화 항목 · 파일 수 · 크기(선언값과 실제값 모두) 검사.
 * 숨김 파일(.git 등)과 macOS 부산물은 건너뛴다. 최상위 폴더 하나로 감싼 zip 이면 그 폴더를 루트로 본다.
 */
export async function readSkillZip(buffer: Buffer): Promise<BundleFile[]> {
  if (buffer.length > BUNDLE_LIMITS.zipBytes) {
    throw new BundleError(`zip 이 ${BUNDLE_LIMITS.zipBytes / 1024 / 1024}MB 를 넘습니다`);
  }
  const zip = await openZip(buffer);
  const raw: Array<{ path: string; data: Buffer }> = [];
  let total = 0;
  try {
    for (;;) {
      const entry = await nextEntry(zip);
      if (!entry) break;
      const name = entry.fileName;
      if (name.endsWith('/')) continue; // 디렉터리
      if (isIgnored(name)) continue;
      if (entry.generalPurposeBitFlag & 0x1)
        throw new BundleError(`암호화된 파일은 받을 수 없습니다: ${name}`);
      if (((entry.externalFileAttributes >>> 16) & S_IFMT) === S_IFLNK) {
        throw new BundleError(`심볼릭 링크는 받을 수 없습니다: ${name}`);
      }
      if (raw.length + 1 > BUNDLE_LIMITS.files)
        throw new BundleError(`파일이 ${BUNDLE_LIMITS.files}개를 넘습니다`);
      if (total + entry.uncompressedSize > BUNDLE_LIMITS.bytes) {
        throw new BundleError(
          `압축을 푼 크기가 ${BUNDLE_LIMITS.bytes / 1024 / 1024}MB 를 넘습니다`,
        );
      }
      const data = await readEntry(zip, entry, BUNDLE_LIMITS.bytes - total);
      total += data.length;
      raw.push({ path: name, data });
    }
  } finally {
    zip.close();
  }
  return normalize(raw);
}

/** 이미 풀린 파일 목록(테스트 · Git 등)도 같은 규칙으로 정리한다 */
export function normalize(raw: Array<{ path: string; data: Buffer }>): BundleFile[] {
  for (const f of raw) {
    // 경로 탈출은 숨김 파일로 보고 건너뛰지 않고 번들 전체를 거부한다
    if (f.path.startsWith('/') || f.path.split('/').some((part) => part === '..' || part === '.')) {
      throw new BundleError(`허용되지 않는 파일 경로: ${f.path}`);
    }
  }
  const files = raw.filter((f) => !isIgnored(f.path));
  let prefix = '';
  if (!files.some((f) => f.path === 'SKILL.md')) {
    const tops = new Set(files.map((f) => f.path.split('/')[0]));
    const [only] = [...tops];
    if (tops.size === 1 && files.some((f) => f.path === `${only}/SKILL.md`)) prefix = `${only}/`;
    else throw new BundleError('번들 루트(또는 최상위 폴더 하나)에 SKILL.md 가 없습니다');
  }
  const seen = new Set<string>();
  return files
    .map((f) => {
      const path = f.path.slice(prefix.length);
      if (!path || path.length > 255 || posix.normalize(path) !== path || path.startsWith('/')) {
        throw new BundleError(`허용되지 않는 파일 경로: ${f.path}`);
      }
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u001f\\]/.test(path))
        throw new BundleError(`허용되지 않는 파일 경로: ${f.path}`);
      if (seen.has(path)) throw new BundleError(`같은 경로가 두 번 있습니다: ${path}`);
      seen.add(path);
      return {
        path,
        size: f.data.length,
        sha256: createHash('sha256').update(f.data).digest('hex'),
        kind: kindOf(path, f.data),
        data: f.data,
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** 번들 전체 해시 — 경로 · 파일 해시를 정렬해 묶는다 (같은 내용이면 같은 해시) */
export function bundleHash(files: Array<Pick<BundleFile, 'path' | 'sha256'>>): string {
  const lines = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => `${f.path}\0${f.sha256}\n`)
    .join('');
  return createHash('sha256').update(lines).digest('hex');
}

/** 텍스트로 다룰 수 있는 파일인가 (UTF-8 로 온전히 읽히는가) */
export function decodeText(data: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return null;
  }
}

function kindOf(path: string, data: Buffer): BundleFileKind {
  if (path === 'SKILL.md') return 'skill';
  const ext = posix.extname(path).toLowerCase();
  const top = path.split('/')[0]!;
  if (top === 'scripts' || SCRIPT_EXT.has(ext)) return 'script';
  const text = (TEXT_EXT.has(ext) || ext === '') && decodeText(data) !== null;
  if (!text) return 'asset';
  if (top === 'templates' || top === 'assets') return 'template';
  return 'doc';
}

function isIgnored(path: string): boolean {
  return path.split('/').some((part) => part.startsWith('.') || part === '__MACOSX');
}

function openZip(buffer: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) =>
    yauzl.fromBuffer(
      buffer,
      { lazyEntries: true, validateEntrySizes: true, decodeStrings: true, strictFileNames: true },
      (err, zip) =>
        err || !zip
          ? reject(new BundleError(`zip 을 읽을 수 없습니다: ${err?.message ?? 'unknown'}`))
          : resolve(zip),
    ),
  );
}

function nextEntry(zip: ZipFile): Promise<Entry | null> {
  return new Promise((resolve, reject) => {
    const onEntry = (entry: Entry) => {
      cleanup();
      resolve(entry);
    };
    const onEnd = () => {
      cleanup();
      resolve(null);
    };
    const onError = (err: Error) => {
      cleanup();
      reject(new BundleError(`zip 항목 오류: ${err.message}`));
    };
    const cleanup = () => {
      zip.off('entry', onEntry);
      zip.off('end', onEnd);
      zip.off('error', onError);
    };
    zip.on('entry', onEntry);
    zip.on('end', onEnd);
    zip.on('error', onError);
    zip.readEntry();
  });
}

function readEntry(zip: ZipFile, entry: Entry, remaining: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream?: Readable) => {
      if (err || !stream)
        return reject(new BundleError(`파일을 읽을 수 없습니다: ${entry.fileName}`));
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > remaining) {
          stream.destroy(
            new BundleError(`압축을 푼 크기가 ${BUNDLE_LIMITS.bytes / 1024 / 1024}MB 를 넘습니다`),
          );
          return;
        }
        chunks.push(chunk);
      });
      stream.on('error', (e) =>
        reject(e instanceof BundleError ? e : new BundleError(`압축 해제 오류: ${e.message}`)),
      );
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}
