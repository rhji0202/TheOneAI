/** "https://Shop.Example.com:443/path" → "https://shop.example.com". http(s) 가 아니면 null. */
export function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * widget_configs.allowed_origins 와 요청 Origin 을 비교한다.
 *  - 정확히 일치: https://www.example.com
 *  - 와일드카드는 서브도메인 한 단계만: https://*.example.com 은 shop.example.com 허용, a.b.example.com · example.com 거부
 */
export function isOriginAllowed(origin: string, allowed: readonly string[]): boolean {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  const request = new URL(normalized);

  return allowed.some((pattern) => {
    const wildcard = /^(https?):\/\/\*\.([^/]+)$/i.exec(pattern.trim());
    if (!wildcard) return normalizeOrigin(pattern) === normalized;

    const base = new URL(`${wildcard[1]!.toLowerCase()}://${wildcard[2]!}`);
    if (request.protocol !== base.protocol || request.port !== base.port) return false;
    const suffix = `.${base.hostname}`;
    if (!request.hostname.endsWith(suffix)) return false;
    const label = request.hostname.slice(0, -suffix.length);
    return label.length > 0 && !label.includes('.');
  });
}
