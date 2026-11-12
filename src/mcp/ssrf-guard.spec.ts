import {
  checkEndpoint,
  checkUrl,
  classifyIp,
  guardedLookup,
  hostMatches,
  ipBlockReason,
} from './ssrf-guard.js';

const policy = (
  over: Partial<{
    allowPrivateNetwork: boolean;
    allowInsecureHttp: boolean;
    allowedHosts: string[];
  }> = {},
) => ({
  allowPrivateNetwork: false,
  allowInsecureHttp: false,
  allowedHosts: [],
  ...over,
});

describe('classifyIp · ipBlockReason', () => {
  it.each([
    ['8.8.8.8', 'public'],
    ['2606:4700:4700::1111', 'public'],
    ['10.1.2.3', 'private'],
    ['172.20.0.1', 'private'],
    ['192.168.0.10', 'private'],
    ['100.64.1.1', 'private'],
    ['fd12::1', 'private'],
    ['127.0.0.1', 'loopback'],
    ['::1', 'loopback'],
    ['169.254.10.10', 'link_local'],
    ['fe80::1', 'link_local'],
    ['169.254.169.254', 'metadata'],
    ['fd00:ec2::254', 'metadata'],
    ['0.0.0.0', 'reserved'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:a9fe:a9fe', 'metadata'],
  ])('%s → %s', (ip, expected) => {
    expect(classifyIp(ip)).toBe(expected);
  });

  it('사설 · 루프백 · 링크로컬은 allowPrivateNetwork 일 때만, 메타데이터는 항상 차단', () => {
    expect(ipBlockReason('10.0.0.1', { allowPrivateNetwork: false })).toBe('private_ip');
    expect(ipBlockReason('10.0.0.1', { allowPrivateNetwork: true })).toBeNull();
    expect(ipBlockReason('169.254.1.1', { allowPrivateNetwork: false })).toBe('link_local');
    expect(ipBlockReason('169.254.169.254', { allowPrivateNetwork: true })).toBe('metadata');
    expect(ipBlockReason('224.0.0.1', { allowPrivateNetwork: true })).toBe('private_ip');
    expect(ipBlockReason('1.1.1.1', { allowPrivateNetwork: false })).toBeNull();
  });
});

describe('checkUrl · hostMatches', () => {
  it('https 만 허용 (개발 설정이면 http 도)', () => {
    expect(checkUrl(new URL('http://a.example.com/mcp'), 'a.example.com', policy())).toBe(
      'scheme_not_allowed',
    );
    expect(
      checkUrl(
        new URL('http://a.example.com/mcp'),
        'a.example.com',
        policy({ allowInsecureHttp: true }),
      ),
    ).toBeNull();
    expect(
      checkUrl(
        new URL('ftp://a.example.com/'),
        'a.example.com',
        policy({ allowInsecureHttp: true }),
      ),
    ).toBe('scheme_not_allowed');
  });

  it('엔드포인트 호스트 + allowedHosts(와일드카드) 밖은 거부', () => {
    expect(checkUrl(new URL('https://evil.example.org/x'), 'a.example.com', policy())).toBe(
      'host_not_allowed',
    );
    expect(
      checkUrl(
        new URL('https://files.cdn.example.com/x'),
        'a.example.com',
        policy({ allowedHosts: ['*.cdn.example.com'] }),
      ),
    ).toBeNull();
    expect(hostMatches('cdn.example.com', '*.cdn.example.com')).toBe(false);
    expect(hostMatches('x.cdn.example.com', '*.cdn.example.com')).toBe(true);
    expect(hostMatches('evilcdn.example.com', '*.cdn.example.com')).toBe(false);
    expect(hostMatches('A.Example.com', 'a.example.com')).toBe(true);
  });
});

describe('checkEndpoint', () => {
  it('IP 리터럴 · 메타데이터 · 허용', async () => {
    await expect(checkEndpoint('https://127.0.0.1/mcp', policy())).resolves.toMatchObject({
      allowed: false,
      blockedReason: 'private_ip',
      resolvedIps: ['127.0.0.1'],
    });
    await expect(
      checkEndpoint('https://169.254.169.254/latest', policy({ allowPrivateNetwork: true })),
    ).resolves.toMatchObject({
      allowed: false,
      blockedReason: 'metadata',
    });
    await expect(
      checkEndpoint('https://[::1]/mcp', policy({ allowPrivateNetwork: true })),
    ).resolves.toMatchObject({
      allowed: true,
      resolvedIps: ['::1'],
    });
    await expect(checkEndpoint('not a url', policy())).resolves.toMatchObject({ allowed: false });
  });

  it('DNS 이름은 해석한 모든 주소를 검사한다 (localhost → 루프백)', async () => {
    const res = await checkEndpoint('https://localhost/mcp', policy());
    expect(res.allowed).toBe(false);
    expect(res.blockedReason).toBe('private_ip');
  });
});

describe('guardedLookup (연결 시점 검사)', () => {
  it('막힌 주소로 해석되면 ESSRFBLOCKED 오류', async () => {
    const lookup = guardedLookup({ allowPrivateNetwork: false });
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
      lookup('localhost', { all: true }, (e) => resolve(e)),
    );
    expect(err?.code).toBe('ESSRFBLOCKED');
  });

  it('허용되면 주소를 돌려준다 (all: false 형식 포함)', async () => {
    const lookup = guardedLookup({ allowPrivateNetwork: true });
    const single = await new Promise<{ address: unknown; family?: number }>((resolve, reject) =>
      lookup('localhost', {}, (e, address, family) =>
        e ? reject(e) : resolve({ address, family }),
      ),
    );
    expect(typeof single.address).toBe('string');
    expect([4, 6]).toContain(single.family);
  });
});
