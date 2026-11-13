import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { LlmImage } from '../llm/llm.types.js';

/**
 * 문서 첨부 — Python 표준 라이브러리 스크립트(extract_text.py)로 텍스트를 뽑는다.
 * PDF 는 poppler 를 쓰고, 텍스트가 없는(스캔한) 페이지는 PNG 로 그려 이미지로 돌려준다.
 */
const SCRIPT = fileURLToPath(new URL('./extract_text.py', import.meta.url));
const TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 30 * 1024 * 1024;

export type DocumentKind = 'xlsx' | 'docx' | 'pptx' | 'pdf';

const KINDS: Array<{ kind: DocumentKind; mimeType: string; extension: string }> = [
  {
    kind: 'xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extension: '.xlsx',
  },
  {
    kind: 'docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: '.docx',
  },
  {
    kind: 'pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    extension: '.pptx',
  },
  { kind: 'pdf', mimeType: 'application/pdf', extension: '.pdf' },
];

/** 형식으로, 형식이 모호하면(application/octet-stream 등) 확장자로 판단한다 */
export function documentKind(mimeType: string, fileName: string): DocumentKind | null {
  const name = fileName.toLowerCase();
  return (
    KINDS.find((k) => k.mimeType === mimeType)?.kind ??
    KINDS.find((k) => name.endsWith(k.extension))?.kind ??
    null
  );
}

export interface ExtractedDocument {
  text: string;
  /** 스캔한 PDF 페이지 */
  images: Array<LlmImage & { page: number }>;
}

/** 읽을 수 없는 문서 — message 는 모델에게 그대로 보여 준다 */
export class DocumentUnreadableError extends Error {}

export function extractDocument(
  kind: DocumentKind,
  data: Buffer,
  options: { python: string; popplerPath: string | null },
): Promise<ExtractedDocument> {
  const args = [SCRIPT, kind, ...(options.popplerPath ? ['--poppler', options.popplerPath] : [])];
  return new Promise((resolve, reject) => {
    const child = spawn(options.python, args, { windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let stopped: string | null = null;
    const stop = (reason: string) => {
      stopped = reason;
      child.kill();
    };
    const timer = setTimeout(() => stop('extraction timed out'), TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) stop('extracted content is too large');
      else out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    // 스크립트가 다 읽기 전에 끝나면(크기 초과 등) stdin 이 EPIPE 를 낸다 — 결과는 close 에서 판단한다
    child.stdin.on('error', () => undefined);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Python 을 실행하지 못했습니다 (${options.python}): ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stderr = Buffer.concat(err).toString('utf8').trim();
      if (stopped) return reject(new DocumentUnreadableError(stopped));
      if (code === 2) return reject(new DocumentUnreadableError(stderr.split('\n').at(-1)!));
      if (code !== 0) return reject(new Error(`문서 추출 실패 (exit ${code}): ${stderr}`));
      resolve(JSON.parse(Buffer.concat(out).toString('utf8')) as ExtractedDocument);
    });
    child.stdin.end(data);
  });
}
