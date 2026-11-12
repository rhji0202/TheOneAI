/**
 * 개발용 시드: 데모 테넌트 · Agent(배포 버전) · 위젯 설정 · Registry v1 · 권한 정책 기본값.
 * 실행: npm run db:seed   (DATABASE_MIGRATION_URL = 테이블 소유자 계정)
 *
 * RLS 가 FORCE 되어 있으므로 테넌트 데이터는 반드시 app.tenant_id 를 설정한 트랜잭션 안에서 넣는다.
 */
import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type IdentityMode, type Prisma } from '../src/generated/prisma/client.js';
import { defaultExecutionPolicy, defaultMemoryPolicy } from '../src/agents/agent-policies.js';
import { uuidv7 } from '../src/common/uuid.js';

export interface SeedTenantInput {
  slug: string;
  name: string;
  agentName?: string;
  widget: {
    publicKey: string;
    secretRef: string;
    allowedOrigins: string[];
    identityMode?: IdentityMode;
  };
}

export interface SeededTenant {
  tenantId: string;
  agentId: string;
  agentVersionId: string;
  widgetId: string;
  registryVersionId: string;
}

const DEFAULT_THEME = { brandColor: '#4F46E5', position: 'bottom-right', darkMode: 'system' };
const DEFAULT_BEHAVIOR = {
  autoOpen: false,
  language: 'auto',
  attachments: { types: ['application/pdf', 'image/png', 'image/jpeg', 'text/csv'], maxMb: 20 },
  noticeText: 'AI 응답은 부정확할 수 있어요',
  showPoweredBy: true,
};

/** C-07 등급별 기본 정책 */
const DEFAULT_TOOL_POLICIES: Array<Omit<Prisma.ToolPolicyCreateManyInput, 'tenantId'>> = [
  { level: 'read', mode: 'auto', approver: null, allowTaskScope: false, ttlSeconds: 900 },
  {
    level: 'write',
    mode: 'require_approval',
    approver: 'user',
    allowTaskScope: true,
    ttlSeconds: 900,
  },
  {
    level: 'external_send',
    mode: 'require_approval',
    approver: 'user',
    allowTaskScope: true,
    ttlSeconds: 900,
  },
  {
    level: 'delete',
    mode: 'always_approval',
    approver: 'user_and_operator',
    allowTaskScope: false,
    ttlSeconds: 1800,
  },
  {
    level: 'financial',
    mode: 'always_approval',
    approver: 'user_and_operator',
    allowTaskScope: false,
    ttlSeconds: 600,
  },
];

export async function seedTenant(
  prisma: PrismaClient,
  input: SeedTenantInput,
): Promise<SeededTenant> {
  const tenantId = uuidv7();
  const agentId = uuidv7();
  const agentVersionId = uuidv7();
  const widgetId = uuidv7();
  const registryVersionId = uuidv7();

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    await tx.tenant.create({ data: { id: tenantId, name: input.name, slug: input.slug } });
    await tx.toolRegistryVersion.create({
      data: {
        id: registryVersionId,
        tenantId,
        version: 1,
        snapshot: { tools: [], skills: [] },
        changeSummary: { note: '초기 Registry' },
      },
    });
    await tx.toolPolicy.createMany({
      data: DEFAULT_TOOL_POLICIES.map((p) => ({ ...p, tenantId })),
    });
    await tx.agent.create({
      data: { id: agentId, tenantId, name: input.agentName ?? '고객지원 에이전트' },
    });
    await tx.agentVersion.create({
      data: {
        id: agentVersionId,
        tenantId,
        agentId,
        version: 1,
        status: 'published',
        welcomeMessage: '안녕하세요, 무엇을 도와드릴까요?',
        systemPrompt: `당신은 ${input.name}의 고객지원 에이전트입니다.`,
        executionPolicy: defaultExecutionPolicy(),
        memoryPolicy: defaultMemoryPolicy(),
        publishedAt: new Date(),
        changeNote: '시드',
      },
    });
    await tx.agent.update({ where: { id: agentId }, data: { publishedVersionId: agentVersionId } });
    await tx.widgetConfig.create({
      data: {
        id: widgetId,
        tenantId,
        agentId,
        name: '기본 위젯',
        publicKey: input.widget.publicKey,
        secretRef: input.widget.secretRef,
        allowedOrigins: input.widget.allowedOrigins,
        identityMode: input.widget.identityMode ?? 'signed_token',
        theme: DEFAULT_THEME,
        behavior: DEFAULT_BEHAVIOR,
      },
    });
  });

  return { tenantId, agentId, agentVersionId, widgetId, registryVersionId };
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

    const found = await prisma.$queryRaw<
      Array<{ id: string | null }>
    >`SELECT app_resolve_tenant('demo') AS id`;
    if (found[0]?.id) {
      console.log('· 데모 테넌트가 이미 있습니다. 시드를 건너뜁니다.');
      return;
    }

    const seeded = await seedTenant(prisma, {
      slug: 'demo',
      name: '데모 워크스페이스',
      widget: {
        publicKey: 'wk_pub_demo',
        secretRef: 'vault://widgets/demo',
        allowedOrigins: ['http://localhost:3000', 'http://localhost:5173'],
      },
    });
    console.log('✔ 데모 테넌트 생성', seeded);
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
