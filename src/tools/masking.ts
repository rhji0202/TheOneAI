/**
 * Tool 인자 · 결과를 화면 · 로그 · DB 에 남기기 전에 민감 정보를 가린다 (설계 원칙: 서버에서 마스킹 후 전송).
 * 모델에게 주는 원본 결과는 가리지 않는다 (작업 수행에 필요).
 */
const SENSITIVE_KEY =
  /pass(word|wd)?|secret|token|api[-_]?key|authorization|cookie|credential|private[-_]?key|card[-_]?(number|no)|cvc|cvv|ssn|resident/i;
const CARD_NUMBER = /\b(?:\d[ -]?){13,19}\b/g;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const SECRET_LIKE = /\b(sk|pk|rk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{12,}\b/g;
const MAX_DEPTH = 6;
const MAX_STRING = 2_000;
const MAX_ITEMS = 50;

export function maskSensitive(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return maskString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_DEPTH) return '[…]';
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((v) => maskSensitive(v, depth + 1));
    if (value.length > MAX_ITEMS) items.push(`[…${value.length - MAX_ITEMS}개 더]`);
    return items;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? '***' : maskSensitive(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

function maskString(text: string): string {
  const masked = text
    .replace(BEARER, '$1 ***')
    .replace(SECRET_LIKE, '$1-***')
    .replace(CARD_NUMBER, (match) => {
      const digits = match.replace(/\D/g, '');
      return digits.length >= 13 ? `****-****-****-${digits.slice(-4)}` : match;
    });
  return masked.length > MAX_STRING
    ? `${masked.slice(0, MAX_STRING)}…(${masked.length}자)`
    : masked;
}

/** 화면에 보여 줄 한 줄 요약 */
export function preview(value: unknown, max = 300): string {
  const text = typeof value === 'string' ? value : JSON.stringify(maskSensitive(value));
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
