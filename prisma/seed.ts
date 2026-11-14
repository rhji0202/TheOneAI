/**
 * 개발용 시드: 기본 워크스페이스(default) · Agent(배포 버전) · 역할별 모델(DeepSeek) · 위젯 설정 · Registry v1 · 권한 정책 기본값.
 * 실행: npm run db:seed   (DATABASE_MIGRATION_URL = 테이블 소유자 계정)
 *
 * RLS 가 FORCE 되어 있으므로 테넌트 데이터는 반드시 app.tenant_id 를 설정한 트랜잭션 안에서 넣는다.
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type MemberRole } from '../src/generated/prisma/client.js';
import { hashPassword } from '../src/admin/auth/password.js';
import { uuidv7 } from '../src/common/uuid.js';
import {
  attachLlm,
  DEFAULT_WORKSPACE_SLUG,
  type ProvisionedWorkspace,
  type ProvisionWorkspaceInput,
  provisionWorkspace,
  type WorkspaceLlmInput,
} from '../src/workspaces/workspace-provisioning.js';

export interface SeedTenantInput extends Omit<ProvisionWorkspaceInput, 'tenantId' | 'members'> {
  /** 콘솔 멤버 (비밀번호는 scrypt 해시로 저장) */
  members?: SeedMemberInput[];
}

export interface SeedMemberInput {
  email: string;
  name: string;
  role: MemberRole;
  password: string;
}

/**
 * 개발용 기본 모델 — DeepSeek (OpenAI 호환 API).
 *  executor  deepseek-flash · 추론 off   Agent Loop(Tool 호출 · 스트리밍 답변) (실패 시 v4-pro)
 * API Key 는 DEV_SECRETS 의 vault://providers/deepseek 값.
 */
export const DEMO_DEEPSEEK: WorkspaceLlmInput = {
  provider: { name: 'deepseek', kind: 'deepseek', secretRef: 'vault://providers/deepseek' },
  models: {
    executor: {
      model: 'deepseek-flash',
      maxOutputTokens: 4_096,
      temperature: 0.3,
      reasoningEffort: 'off',
      fallbackModel: 'deepseek-v4-pro',
    },
  },
};

export async function seedTenant(
  prisma: PrismaClient,
  input: SeedTenantInput,
): Promise<ProvisionedWorkspace> {
  const tenantId = uuidv7();
  const members = await Promise.all(
    (input.members ?? []).map(async (m) => ({
      email: m.email,
      name: m.name,
      role: m.role,
      passwordHash: await hashPassword(m.password),
    })),
  );
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return provisionWorkspace(tx, { ...input, tenantId, members });
  });
}

/** 기존 기본 워크스페이스에 모델 설정이 없으면 DeepSeek 기본 설정을 붙인다. */
async function ensureDemoModels(prisma: PrismaClient, tenantId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    const agents = await tx.agent.findMany({
      where: { publishedVersionId: { not: null } },
      select: { publishedVersionId: true },
    });
    let attached = false;
    for (const { publishedVersionId } of agents) {
      const count = await tx.modelConfig.count({ where: { agentVersionId: publishedVersionId! } });
      if (count > 0) continue;
      await attachLlm(tx, tenantId, publishedVersionId!, DEMO_DEEPSEEK);
      attached = true;
    }
    return attached;
  });
}

/** 기본 워크스페이스에 콘솔 멤버가 없으면 Owner 를 만든다. 비밀번호: DEV_ADMIN_PASSWORD, 없으면 생성해 한 번만 출력 */
async function ensureDemoOwner(prisma: PrismaClient, tenantId: string): Promise<void> {
  const exists = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return (await tx.user.count()) > 0;
  });
  if (exists) return;
  const password = process.env.DEV_ADMIN_PASSWORD || randomBytes(12).toString('base64url');
  const passwordHash = await hashPassword(password);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    await tx.user.create({
      data: { tenantId, email: DEMO_OWNER_EMAIL, name: '데모 Owner', role: 'owner', passwordHash },
    });
  });
  console.log(`✔ 콘솔 Owner 생성: ${DEFAULT_WORKSPACE_SLUG} / ${DEMO_OWNER_EMAIL}`);
  if (!process.env.DEV_ADMIN_PASSWORD) {
    console.log(`  비밀번호(다시 표시하지 않음): ${password}`);
  }
}

const DEMO_OWNER_EMAIL = 'owner@demo.local';
const DEFAULT_WORKSPACE_NAME = '기본 워크스페이스';

async function resolveTenant(prisma: PrismaClient, slug: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<
    Array<{ id: string | null }>
  >`SELECT app_resolve_tenant(${slug}) AS id`;
  return rows[0]?.id ?? null;
}

/** 이전 시드가 만든 demo 워크스페이스는 데이터를 그대로 둔 채 default 로 바꾼다. */
async function adoptLegacyDemo(prisma: PrismaClient): Promise<string | null> {
  const tenantId = await resolveTenant(prisma, 'demo');
  if (!tenantId) return null;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    await tx.tenant.update({
      where: { id: tenantId },
      data: { slug: DEFAULT_WORKSPACE_SLUG, name: DEFAULT_WORKSPACE_NAME },
    });
  });
  console.log(`✔ 워크스페이스 demo 를 ${DEFAULT_WORKSPACE_SLUG} 로 바꿨습니다.`);
  return tenantId;
}

/** 개발 환경: DATABASE_URL 의 계정을 app_rw 역할 로그인으로 만든다 (없을 때만). */
export async function ensureAppLogin(
  prisma: PrismaClient,
  databaseUrl: string,
): Promise<string | null> {
  const url = new URL(databaseUrl);
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (!user || !password) return null;
  const existing = await prisma.$queryRaw<Array<{ exists: boolean }>>`
    SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${user}) AS exists`;
  if (existing[0]?.exists) return null;
  const rows = await prisma.$queryRaw<Array<{ stmt: string }>>`
    SELECT format('CREATE ROLE %I LOGIN PASSWORD %L IN ROLE app_rw', ${user}::text, ${password}::text) AS stmt`;
  await prisma.$executeRawUnsafe(rows[0]!.stmt);
  return user;
}

async function main(): Promise<void> {
  const migrationUrl = process.env.DATABASE_MIGRATION_URL;
  if (!migrationUrl) throw new Error('DATABASE_MIGRATION_URL 이 필요합니다.');
  if (process.env.NODE_ENV === 'production')
    throw new Error('개발용 시드는 production 에서 실행할 수 없습니다.');

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: migrationUrl }) });
  try {
    if (process.env.DATABASE_URL) {
      const created = await ensureAppLogin(prisma, process.env.DATABASE_URL);
      if (created) console.log(`✔ 애플리케이션 계정 생성: ${created} (app_rw)`);
    }

    const existingId =
      (await resolveTenant(prisma, DEFAULT_WORKSPACE_SLUG)) ?? (await adoptLegacyDemo(prisma));
    if (existingId) {
      await ensureDemoOwner(prisma, existingId);
      const attached = await ensureDemoModels(prisma, existingId);
      console.log(
        attached
          ? '✔ 기본 워크스페이스에 DeepSeek 모델 설정을 붙였습니다.'
          : '· 기본 워크스페이스가 이미 있습니다. 시드를 건너뜁니다.',
      );
      return;
    }

    const seeded = await seedTenant(prisma, {
      slug: DEFAULT_WORKSPACE_SLUG,
      name: DEFAULT_WORKSPACE_NAME,
      widget: {
        publicKey: 'wk_pub_demo',
        secretRef: 'vault://widgets/demo',
        allowedOrigins: ['http://localhost:3000', 'http://localhost:5173'],
      },
      llm: DEMO_DEEPSEEK,
    });
    console.log('✔ 기본 워크스페이스 생성', seeded);
    await ensureDemoOwner(prisma, seeded.tenantId);
    console.log(
      '  모델: DeepSeek — DEV_SECRETS 에 vault://providers/deepseek 값(API Key)이 필요합니다.',
    );
    console.log(
      '  위젯 공개 키: wk_pub_demo  ·  Secret 참조: vault://widgets/demo (DEV_SECRETS 에서 값 조회)',
    );
    console.log('  identity token 발급: npm run dev:identity-token -- --sub user-1');
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
