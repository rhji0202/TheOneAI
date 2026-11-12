import { createHash } from 'node:crypto';
import { Ajv, type ValidateFunction } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';

/**
 * 외부(MCP) Tool 의 JSON Schema 검증 — 등록 시 스키마 자체를, 실행 시 모델이 만든 인자를 검사한다.
 * $schema 가 2019-09 · 2020-12 면 Ajv2020, 아니면 draft-07. 포맷 검사는 하지 않는다(서버가 최종 검증).
 */
const OPTIONS = { strict: false, allErrors: true, validateFormats: false, logger: false } as const;
const draft7 = new Ajv(OPTIONS);
const draft2020 = new Ajv2020(OPTIONS);

const CACHE_LIMIT = 500;
const cache = new Map<string, ValidateFunction>();

export type CompileResult = { ok: true; validate: ValidateFunction } | { ok: false; error: string };

export function compileSchema(schema: unknown): CompileResult {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { ok: false, error: 'schema must be an object' };
  }
  const key = createHash('sha256').update(canonicalJson(schema)).digest('hex');
  const cached = cache.get(key);
  if (cached) return { ok: true, validate: cached };

  // 최상위 $schema · $id 는 떼어 낸다 (메타 스키마 조회 실패 · $id 충돌 방지)
  const { $schema, $id: _id, ...rest } = schema as Record<string, unknown>;
  const ajv = typeof $schema === 'string' && /20(19|20)-/.test($schema) ? draft2020 : draft7;
  try {
    const validate = ajv.compile(rest);
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    cache.set(key, validate);
    return { ok: true, validate };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 인자 검증. 실패하면 모델이 고칠 수 있게 경로 · 이유를 한 줄로 */
export function validateAgainst(
  schema: unknown,
  value: unknown,
): { ok: true } | { ok: false; message: string } {
  const compiled = compileSchema(schema);
  if (!compiled.ok) return { ok: false, message: `tool schema is invalid: ${compiled.error}` };
  if (compiled.validate(value)) return { ok: true };
  const message = (compiled.validate.errors ?? [])
    .slice(0, 5)
    .map(
      (e) =>
        `${e.instancePath || '(root)'}: ${e.message ?? 'invalid'}${e.params && 'additionalProperty' in e.params ? ` '${String(e.params.additionalProperty)}'` : ''}`,
    )
    .join('; ');
  return { ok: false, message: message || 'arguments do not match the schema' };
}

/** 키 순서와 무관한 JSON 문자열 (스키마 해시 · 변경 감지용) */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
