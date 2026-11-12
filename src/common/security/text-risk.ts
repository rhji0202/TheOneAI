/**
 * 외부에서 들어온 텍스트(MCP Tool 설명 · SKILL.md 지침 · 참조 문서)의 위험 신호.
 * 모델이 지시로 오해할 수 있는 숨은 지시문(프롬프트 주입)과 보이지 않는 문자를 찾는다.
 * 보이지 않는 문자는 소스에서도 보이도록 반드시 \u 이스케이프로 쓴다.
 */
export const INJECTION_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /ignore\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|rules)/i,
    '이전 지시 무시 요구',
  ],
  [/(system|developer)\s+prompt/i, '시스템 프롬프트 언급'],
  [/<\s*\/?\s*(important|instructions?|system|secret)\s*>/i, '숨은 지시 태그'],
  [
    /(do\s*not|don't|never)\s+(tell|inform|mention|reveal|show)\b.{0,40}\buser/i,
    '사용자에게 숨기라는 지시',
  ],
  [/before\s+(using|calling)\s+(this|any)\s+(other\s+)?tool/i, '다른 Tool 사용 전 행동 지시'],
  [
    /(read|send|upload|include)\b.{0,40}(~\/\.ssh|id_rsa|\.env|credentials|api[_ ]?keys?)/i,
    '자격 증명 반출 지시',
  ],
  [
    /(disable|bypass|ignore)\s+(the\s+)?(safety|security|platform)\s+(rules|checks|policy|policies)/i,
    '안전 규칙 우회 지시',
  ],
  [/이전\s*(의\s*)?지시.{0,10}무시/, '이전 지시 무시 요구'],
  [/시스템\s*프롬프트/, '시스템 프롬프트 언급'],
  [/사용자에게\s*(말하지|알리지|보여주지)\s*마/, '사용자에게 숨기라는 지시'],
  [/(보안|안전)\s*(규칙|정책)\S*\s*(무시|우회)/, '안전 규칙 우회 지시'],
];

/** 제로폭 문자 · 방향 제어 문자 · 단어 결합자 · BOM · 유니코드 태그 문자 */
export const HIDDEN_CHARS =
  /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/u;

/** 텍스트에서 찾은 숨은 지시문 · 보이지 않는 문자 (중복 제거) */
export function findInjectionRisks(texts: string[]): string[] {
  const joined = texts.join('\n');
  const found: string[] = [];
  for (const [pattern, label] of INJECTION_PATTERNS) {
    if (pattern.test(joined)) found.push(`숨은 지시문 의심: ${label}`);
  }
  if (HIDDEN_CHARS.test(joined)) {
    found.push('보이지 않는 문자(제로폭 · 방향 제어 · 태그 문자)가 있습니다');
  }
  return [...new Set(found)];
}
