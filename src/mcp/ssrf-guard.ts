import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { BlockList, isIP } from 'node:net';

/**
 * MCP 서버로 나가는 연결의 SSRF 방어 (C-05 ③ 네트워크 · SSRF).
 *  - 스킴: https 만 (개발 · 테스트에서 MCP_ALLOW_INSECURE_HTTP 일 때만 http)
 *  - 호스트: 엔드포인트 호스트 + allowedHosts (* 접두 와일드카드)
 *  - IP: DNS 해석 결과가 하나라도 막힌 대역이면 거부. 클라우드 메타데이터는 어떤 설정으로도 허용하지 않는다.
 *    사설 · 루프백 · 링크로컬은 서버별 allowPrivateNetwork(Owner 만 켤 수 있음)일 때만 허용.
 * 같은 검사를 연결 시점(소켓의 lookup)에서도 한다 → DNS rebinding · 리다이렉트도 막힌다.
 */
export type BlockedReason =
  | 'private_ip'
  | 'link_local'
  | 'metadata'
  | 'host_not_allowed'
  | 'scheme_not_allowed'
  | 'dns_failed';

export interface EgressPolicy {
  /** 엔드포인트 호스트 외에 허용할 호스트 (예: api.example.com, *.example.com) */
  allowedHosts: string[];
  allowPrivateNetwork: boolean;
  allowInsecureHttp: boolean;
}

export interface SsrfCheck {
  resolvedIps: string[];
  allowed: boolean;
  blockedReason?: BlockedReason;
}

export class SsrfBlockedError extends Error {
  constructor(
    readonly reason: BlockedReason,
    readonly target: string,
  ) {
    super(`SSRF 차단 (${reason}): ${target}`);
    this.name = 'SsrfBlockedError';
  }
}

type IpClass = 'public' | 'private' | 'loopback' | 'link_local' | 'metadata' | 'reserved';

const METADATA = new BlockList();
METADATA.addAddress('169.254.169.254', 'ipv4'); // AWS · GCP · Azure · OpenStack
METADATA.addAddress('169.254.170.2', 'ipv4'); // AWS ECS task metadata
METADATA.addAddress('100.100.100.200', 'ipv4'); // Alibaba Cloud
METADATA.addAddress('fd00:ec2::254', 'ipv6'); // AWS IPv6

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');

const LINK_LOCAL = new BlockList();
LINK_LOCAL.addSubnet('169.254.0.0', 16, 'ipv4');
LINK_LOCAL.addSubnet('fe80::', 10, 'ipv6');

const PRIVATE = new BlockList();
PRIVATE.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE.addSubnet('100.64.0.0', 10, 'ipv4'); // CGNAT
PRIVATE.addSubnet('fc00::', 7, 'ipv6'); // ULA

const RESERVED = new BlockList();
RESERVED.addSubnet('0.0.0.0', 8, 'ipv4');
RESERVED.addSubnet('224.0.0.0', 4, 'ipv4'); // multicast
RESERVED.addSubnet('240.0.0.0', 4, 'ipv4'); // reserved · broadcast
RESERVED.addAddress('::', 'ipv6');
RESERVED.addSubnet('ff00::', 8, 'ipv6');

export function classifyIp(raw: string): IpClass {
  const ip = unmapIpv4(raw.replace(/^\[|\]$/g, ''));
  const family = isIP(ip) === 6 ? 'ipv6' : 'ipv4';
  if (METADATA.check(ip, family)) return 'metadata';
  if (LOOPBACK.check(ip, family)) return 'loopback';
  if (LINK_LOCAL.check(ip, family)) return 'link_local';
  if (PRIVATE.check(ip, family)) return 'private';
  if (RESERVED.check(ip, family)) return 'reserved';
  return 'public';
}

/** 이 IP 로 연결해도 되는가. 막히면 사유 */
export function ipBlockReason(
  ip: string,
  policy: Pick<EgressPolicy, 'allowPrivateNetwork'>,
): BlockedReason | null {
  switch (classifyIp(ip)) {
    case 'public':
      return null;
    case 'metadata':
      return 'metadata';
    case 'reserved':
      return 'private_ip';
    case 'link_local':
      return policy.allowPrivateNetwork ? null : 'link_local';
    case 'loopback':
    case 'private':
      return policy.allowPrivateNetwork ? null : 'private_ip';
  }
}

export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return h === p;
}

/** URL 자체(스킴 · 호스트) 검사. IP 는 resolve 단계에서 본다 */
export function checkUrl(
  url: URL,
  endpointHost: string,
  policy: EgressPolicy,
): BlockedReason | null {
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && policy.allowInsecureHttp)) {
    return 'scheme_not_allowed';
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const allowed = [endpointHost, ...policy.allowedHosts].some((p) => hostMatches(host, p));
  return allowed ? null : 'host_not_allowed';
}

/** 연결 테스트용: URL 검사 + DNS 해석 + 모든 IP 검사 */
export async function checkEndpoint(rawUrl: string, policy: EgressPolicy): Promise<SsrfCheck> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { resolvedIps: [], allowed: false, blockedReason: 'host_not_allowed' };
  }
  const urlReason = checkUrl(url, url.hostname.replace(/^\[|\]$/g, ''), policy);
  if (urlReason) return { resolvedIps: [], allowed: false, blockedReason: urlReason };
  let ips: string[];
  try {
    ips = await resolveAll(url.hostname.replace(/^\[|\]$/g, ''));
  } catch {
    return { resolvedIps: [], allowed: false, blockedReason: 'dns_failed' };
  }
  for (const ip of ips) {
    const reason = ipBlockReason(ip, policy);
    if (reason) return { resolvedIps: ips, allowed: false, blockedReason: reason };
  }
  return {
    resolvedIps: ips,
    allowed: ips.length > 0,
    ...(ips.length ? {} : { blockedReason: 'dns_failed' as const }),
  };
}

async function resolveAll(host: string): Promise<string[]> {
  if (isIP(host)) return [host];
  return new Promise((resolve, reject) =>
    dnsLookup(host, { all: true }, (err, addresses) =>
      err ? reject(err) : resolve(addresses.map((a) => a.address)),
    ),
  );
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * net.connect · tls.connect 의 lookup 대체. 해석된 주소 중 하나라도 막혀 있으면 연결하지 않는다.
 * (IP 리터럴 호스트는 lookup 을 거치지 않으므로 fetch 래퍼에서 따로 검사한다)
 */
export function guardedLookup(policy: Pick<EgressPolicy, 'allowPrivateNetwork'>) {
  return (hostname: string, options: LookupOptions, callback: LookupCallback) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, options.all ? [] : '', undefined);
      for (const a of addresses) {
        const reason = ipBlockReason(a.address, policy);
        if (reason) {
          const blocked = new SsrfBlockedError(
            reason,
            `${hostname} → ${a.address}`,
          ) as NodeJS.ErrnoException;
          blocked.code = 'ESSRFBLOCKED';
          return callback(blocked, options.all ? [] : '', undefined);
        }
      }
      if (options.all) return callback(null, addresses);
      const first = addresses[0];
      if (!first)
        return callback(
          Object.assign(new Error(`no address for ${hostname}`), { code: 'ENOTFOUND' }),
          '',
        );
      callback(null, first.address, first.family);
    });
  };
}

function unmapIpv4(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1]! : ip;
}
