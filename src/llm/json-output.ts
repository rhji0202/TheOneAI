import type { z } from 'zod';

/** 모델 출력에서 JSON 객체를 꺼낸다 (코드 펜스 · 앞뒤 설명 허용). */
export function extractJson(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new SyntaxError('JSON 객체를 찾을 수 없습니다');
  }
}

export type JsonParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseJsonOutput<T>(text: string, schema: z.ZodType<T>): JsonParseResult<T> {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    error: parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; '),
  };
}
