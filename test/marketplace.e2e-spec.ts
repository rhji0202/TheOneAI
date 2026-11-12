import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { adminLogin, api, CONSOLE_MEMBERS, startTestApp, type TestContext } from './helpers.js';
import { testEnv } from './test-env.js';
import { makeZip } from './zip.js';

interface Listing {
  id: string;
  kind: string;
  name: string;
  latestVersion: string;
  installCount: number;
  mine: boolean;
  installed: boolean;
  status: string;
  publisher: string;
  versions: Array<{ version: string; signatureValid: boolean; keyId: string }>;
  latest: {
    files?: Array<{ path: string; sha256: string }>;
    tools?: unknown[];
    endpointUrl?: string;
  };
}

let ctx: TestContext;
let ownerA: string;
let viewerA: string;
let ownerB: string;
let skillId: string;
let versionId: string;
let listingId: string;

const skillMd = (version: string) => `---
name: refund-guide
description: 환불 규정을 안내합니다. 환불 · 반품 문의에 사용.
allowed-tools: builtin.calculate
version: ${version}
---
# 환불 안내 절차
1. references/policy.md 를 확인한다.
`;
const bundle = (version: string, policy = '단순 변심 반품은 7일 이내') =>
  makeZip([
    { path: 'refund-guide/SKILL.md', data: skillMd(version) },
    { path: 'refund-guide/references/policy.md', data: policy },
  ]);

beforeAll(async () => {
  ctx = await startTestApp();
  ownerA = await adminLogin(ctx.baseUrl, ctx.slugs.A, CONSOLE_MEMBERS.owner);
  viewerA = await adminLogin(ctx.baseUrl, ctx.slugs.A, CONSOLE_MEMBERS.viewer);
  ownerB = await adminLogin(ctx.baseUrl, ctx.slugs.B, CONSOLE_MEMBERS.owner);
});

afterAll(async () => {
  await ctx?.close();
});

const admin = <T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
  token = ownerA,
) => api<T & { code?: string }>(ctx.baseUrl, method, `/v1/admin${path}`, { token, body });

async function upload(zip: Buffer, token: string) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(zip)], { type: 'application/zip' }), 'skill.zip');
  const res = await fetch(`${ctx.baseUrl}/v1/admin/skills`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  return {
    status: res.status,
    body: (await res.json()) as { skill: { id: string }; version: { id: string }; code?: string },
  };
}

/** 테스트 DB 소유자 계정은 RLS 를 우회하므로, 다른 테넌트 행이 섞이지 않게 쿼리에 tenantId 를 함께 건다 */
function tenantRows<T>(tenantId: string, fn: (tx: TestContext['owner']) => Promise<T>) {
  return ctx.owner.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx as unknown as TestContext['owner']);
  });
}

describe('Skill 공유', () => {
  it('검증을 통과한 Skill 버전을 게시하면 파일을 복사하고 플랫폼 키로 서명한다', async () => {
    const up = await upload(await bundle('1.0.0'), ownerA);
    expect(up.status).toBe(201);
    skillId = up.body.skill.id;
    versionId = up.body.version.id;

    // Viewer 는 게시할 수 없다
    expect(
      (await admin('POST', '/marketplace/skills', { skillId, versionId }, viewerA)).status,
    ).toBe(403);
    const res = await admin<Listing>('POST', '/marketplace/skills', {
      skillId,
      versionId,
      title: '환불 안내',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      kind: 'skill',
      name: 'refund-guide',
      latestVersion: '1.0.0',
      mine: true,
      installed: false,
      status: 'published',
    });
    expect(res.body.versions).toEqual([
      expect.objectContaining({
        version: '1.0.0',
        signatureValid: true,
        keyId: expect.any(String),
      }),
    ]);
    expect(res.body.latest.files!.map((f) => f.path).sort()).toEqual([
      'SKILL.md',
      'references/policy.md',
    ]);
    listingId = res.body.id;
    // 같은 버전을 다시 게시할 수 없다
    expect((await admin('POST', '/marketplace/skills', { skillId, versionId })).body.code).toBe(
      'SKILL_VERSION_EXISTS',
    );
  });

  it('다른 테넌트가 설치하면 서명 · 해시를 확인하고 검토 대기 버전으로 복사한다 (활성화는 운영자가)', async () => {
    const list = await admin<Listing[]>(
      'GET',
      '/marketplace/listings?kind=skill&q=환불',
      undefined,
      ownerB,
    );
    expect(list.body.map((l) => l.id)).toContain(listingId);
    expect(list.body.find((l) => l.id === listingId)).toMatchObject({
      mine: false,
      installed: false,
    });

    const res = await admin<{
      kind: string;
      marketplaceVersion: string;
      skill: { id: string; status: string; source: string };
      version: {
        id: string;
        verification: Array<{ check: string; status: string; detail: string }>;
      };
    }>('POST', `/marketplace/listings/${listingId}/install`, {}, ownerB);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ kind: 'skill', marketplaceVersion: '1.0.0' });
    expect(res.body.skill).toMatchObject({ status: 'pending_review', source: 'marketplace' });
    const checks = Object.fromEntries(res.body.version.verification.map((c) => [c.check, c]));
    expect(checks.signature).toMatchObject({ status: 'passed' });
    expect(checks.source!.detail).toContain('마켓플레이스 refund-guide 1.0.0');

    const stored = await tenantRows(ctx.tenantB.tenantId, (tx) =>
      tx.skillVersion.findUniqueOrThrow({ where: { id: res.body.version.id } }),
    );
    expect(stored).toMatchObject({ signatureVerified: true, verificationStatus: 'passed' });
    const activated = await admin<{ status: string }>(
      'POST',
      `/skills/${res.body.skill.id}/versions/${res.body.version.id}/activate`,
      {},
      ownerB,
    );
    expect(activated.status).toBe(200);
    // 설치 표시 · 설치 수
    const detail = await admin<Listing>(
      'GET',
      `/marketplace/listings/${listingId}`,
      undefined,
      ownerB,
    );
    expect(detail.body).toMatchObject({ installed: true, installCount: 1 });
    // 같은 버전을 다시 설치하면 중복 (설치 수 그대로)
    const again = await admin<{ duplicate: boolean }>(
      'POST',
      `/marketplace/listings/${listingId}/install`,
      {},
      ownerB,
    );
    expect(again.body.duplicate).toBe(true);
    expect(
      (await admin<Listing>('GET', `/marketplace/listings/${listingId}`, undefined, ownerB)).body
        .installCount,
    ).toBe(1);
    expect(
      await tenantRows(ctx.tenantB.tenantId, (tx) =>
        tx.auditLog.count({
          where: { tenantId: ctx.tenantB.tenantId, action: 'skill.install' },
        }),
      ),
    ).toBe(1);
  });

  it('게시자가 새 버전을 올리면 설치한 테넌트는 같은 Skill 의 새 버전으로 받는다', async () => {
    const v2 = await upload(await bundle('1.1.0', '단순 변심 반품은 14일 이내'), ownerA);
    await admin('POST', '/marketplace/skills', { skillId, versionId: v2.body.version.id });
    const res = await admin<{ skill: { id: string }; version: { version: string } }>(
      'POST',
      `/marketplace/listings/${listingId}/install`,
      { version: '1.1.0' },
      ownerB,
    );
    expect(res.body.version.version).toBe('1.1.0');
    const versions = await tenantRows(ctx.tenantB.tenantId, (tx) =>
      tx.skillVersion.findMany({ where: { skillId: res.body.skill.id } }),
    );
    expect(versions.map((v) => v.version).sort()).toEqual(['1.0.0', '1.1.0']);
  });

  it('파일이나 서명된 내용이 바뀌면 설치하지 않는다', async () => {
    const detail = await admin<Listing>('GET', `/marketplace/listings/${listingId}`);
    const policy = detail.body.latest.files!.find((f) => f.path === 'references/policy.md')!;
    const path = join(
      testEnv.OBJECT_STORAGE_DIR!,
      'marketplace/blobs',
      policy.sha256.slice(0, 2),
      policy.sha256,
    );
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '환불은 언제든 무제한 가능');
    const tampered = await admin('POST', `/marketplace/listings/${listingId}/install`, {}, ownerB);
    expect(tampered).toMatchObject({
      status: 422,
      body: { code: 'MARKETPLACE_SIGNATURE_INVALID' },
    });

    // manifest 변조 → 서명 불일치 (목록에서도 표시)
    await ctx.owner.$executeRaw`
      UPDATE marketplace_versions SET manifest = jsonb_set(manifest, '{allowedTools}', '["*"]')
      WHERE listing_id = ${listingId}::uuid AND version = '1.0.0'`;
    const bad = await admin<Listing>(
      'GET',
      `/marketplace/listings/${listingId}`,
      undefined,
      ownerB,
    );
    expect(bad.body.versions.find((v) => v.version === '1.0.0')!.signatureValid).toBe(false);
    expect(
      (
        await admin(
          'POST',
          `/marketplace/listings/${listingId}/install`,
          { version: '1.0.0' },
          ownerB,
        )
      ).body.code,
    ).toBe('MARKETPLACE_SIGNATURE_INVALID');
  });

  it('이름 충돌 · 게시자 권한 · 철회', async () => {
    // B 가 같은 이름으로 게시하려 하면 거부 (B 의 refund-guide 는 설치본이라 게시도 불가)
    const bSkill = await tenantRows(ctx.tenantB.tenantId, (tx) =>
      tx.skill.findFirstOrThrow({
        where: { tenantId: ctx.tenantB.tenantId, name: 'refund-guide' },
      }),
    );
    expect(
      (await admin('POST', '/marketplace/skills', { skillId: bSkill.id }, ownerB)).body.code,
    ).toBe('NAME_TAKEN');
    // 설치본에 업로드로 새 버전을 섞을 수 없다
    expect((await upload(await bundle('2.0.0'), ownerB)).body.code).toBe('NAME_TAKEN');

    expect(
      (await admin('POST', `/marketplace/listings/${listingId}/withdraw`, {}, ownerB)).status,
    ).toBe(403);
    const withdrawn = await admin<Listing>('POST', `/marketplace/listings/${listingId}/withdraw`);
    expect(withdrawn.body.status).toBe('withdrawn');
    const list = await admin<Listing[]>('GET', '/marketplace/listings', undefined, ownerB);
    expect(list.body.map((l) => l.id)).not.toContain(listingId);
    expect(
      (await admin('GET', `/marketplace/listings/${listingId}`, undefined, ownerB)).status,
    ).toBe(404);
    expect(
      (await admin('POST', `/marketplace/listings/${listingId}/install`, {}, ownerB)).status,
    ).toBe(404);
    // 게시자에게는 보이고, 이미 설치한 Skill 은 그대로
    expect((await admin<Listing>('GET', `/marketplace/listings/${listingId}`)).body.status).toBe(
      'withdrawn',
    );
    expect(
      await tenantRows(ctx.tenantB.tenantId, (tx) =>
        tx.skill.count({
          where: { tenantId: ctx.tenantB.tenantId, name: 'refund-guide', deletedAt: null },
        }),
      ),
    ).toBe(1);
  });
});

describe('MCP 서버 템플릿 공유', () => {
  it('연결 정보 · Tool 목록만 공유하고(비밀값 제외), 설치하면 등록 마법사용 템플릿을 준다', async () => {
    const serverId = await tenantRows(ctx.tenantA.tenantId, async (tx) => {
      const server = await tx.mcpServer.create({
        data: {
          tenantId: ctx.tenantA.tenantId,
          name: 'shared-shop',
          description: '데모 쇼핑몰 주문 조회',
          transport: 'streamable_http',
          endpointUrl: 'https://mcp.shop.example.com/mcp',
          authType: 'api_key',
          secretRef: 'vault://tenant-a/shop-key',
          allowedHosts: ['mcp.shop.example.com'],
          status: 'connected',
        },
      });
      await tx.mcpTool.create({
        data: {
          tenantId: ctx.tenantA.tenantId,
          serverId: server.id,
          name: 'lookup_order',
          description: '주문 상태 조회',
          inputSchema: { type: 'object' },
          schemaHash: 'h1',
          schemaCheck: 'valid',
          securityCheck: 'passed',
          permissionLevel: 'read',
          enabled: true,
        },
      });
      return server.id;
    });
    const published = await admin<Listing>('POST', '/marketplace/mcp-servers', { serverId });
    expect(published.status).toBe(201);
    expect(published.body).toMatchObject({
      kind: 'mcp',
      name: 'shared-shop',
      latestVersion: '1.0.0',
    });
    expect(JSON.stringify(published.body)).not.toContain('vault://');
    // 바뀐 것이 없으면 새 버전을 만들지 않는다
    expect((await admin('POST', '/marketplace/mcp-servers', { serverId })).body.code).toBe(
      'SKILL_VERSION_EXISTS',
    );

    const installed = await admin<{
      kind: string;
      template: { endpointUrl: string; authType: string; tools: Array<{ name: string }> };
    }>('POST', `/marketplace/listings/${published.body.id}/install`, {}, ownerB);
    expect(installed.body).toMatchObject({
      kind: 'mcp',
      template: {
        endpointUrl: 'https://mcp.shop.example.com/mcp',
        authType: 'api_key',
        tools: [{ name: 'lookup_order', description: '주문 상태 조회', permissionLevel: 'read' }],
      },
    });
    expect(JSON.stringify(installed.body)).not.toContain('vault://');
    // 템플릿만 줄 뿐 B 에 서버를 만들지 않는다 (연결 테스트 · 등록은 기존 절차)
    expect(
      await tenantRows(ctx.tenantB.tenantId, (tx) =>
        tx.mcpServer.count({ where: { tenantId: ctx.tenantB.tenantId, name: 'shared-shop' } }),
      ),
    ).toBe(0);
  });
});
