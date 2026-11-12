/**
 * 레지스트리 이름(builtin.calculate, google-drive.upload_file) ↔ LLM function 이름.
 * OpenAI 호환 API 의 function 이름은 ^[a-zA-Z0-9_-]{1,64}$ 이므로 '.' 를 '__' 로 바꾼다.
 */
export const TOOL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)+$/;

export function toLlmName(name: string): string {
  const llm = name.replace(/\./g, '__');
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(llm)) {
    throw new Error(`LLM function 이름으로 쓸 수 없는 Tool 이름입니다: ${name}`);
  }
  return llm;
}

/** toolPattern 매칭: 정확히 같거나, "google-drive.*" 처럼 끝의 * 가 접두어를 뜻한다. */
export function matchesToolPattern(name: string, pattern: string): boolean {
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}
