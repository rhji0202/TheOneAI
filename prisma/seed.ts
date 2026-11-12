/**
 * 개발용 시드: 데모 테넌트 · Agent(배포 버전) · 역할별 모델(DeepSeek) · 위젯 설정 · Registry v1 · 권한 정책 기본값.
 * 실행: npm run db:seed   (DATABASE_MIGRATION_URL = 테이블 소유자 계정)
 *
 * RLS 가 FORCE 되어 있으므로 테넌트 데이터는 반드시 app.tenant_id 를 설정한 트랜잭션 안에서 넣는다.
 */
import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  PrismaClient,
  type IdentityMode,
  type Prisma,
  type ProviderKind,
  type ReasoningEffort,
} from '../src/generated/prisma/client.js';
import { defaultExecutionPolicy, defaultMemoryPolicy } from '../src/agents/agent-policies.js';
import { uuidv7 } from '../src/common/uuid.js';

export interface SeedModelSpec {
  model: string;
  maxOutputTokens: number;
  temperature?: number;
  reasoningEffort?: ReasoningEffort;
  fallbackModel?: string;
}

/** 역할별 모델 (C-03 모델 구성). executor 필수, planner · evaluator 는 없으면 executor 를 쓴다. */
export interface SeedLlmInput {
  provider: { name: string; kind: ProviderKind; baseUrl?: string; secretRef: string };
  models: { planner?: SeedModelSpec; executor: SeedModelSpec; evaluator?: SeedModelSpec };
}

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
  llm?: SeedLlmInput;
}

/**
 * 개발용 기본 모델 — DeepSeek (OpenAI 호환 API).
 *  planner   deepseek-flash · 추론 off   (실패 시 v4-pro) — 첫 토큰 지연을 줄이기 위해 flash · 추론 off
 *            (실측: v4-pro · low 4.1s → flash · low 4.7s(복잡한 요청) → flash · off 2.3~3.1s)
 *  executor  deepseek-flash · 추론 off   스트리밍 답변 (실패 시 v4-pro)
 *  evaluator deepseek-flash · 추론 low   JSON 검증
 * API Key 는 DEV_SECRETS 의 vault://providers/deepseek 값.
 */
export const DEMO_DEEPSEEK: SeedLlmInput = {
  provider: { name: 'deepseek', kind: 'deepseek', secretRef: 'vault://providers/deepseek' },
  models: {
    planner: {
      model: 'deepseek-flash',
      maxOutputTokens: 4_096,
      reasoningEffort: 'off',
      fallbackModel: 'deepseek-v4-pro',
    },
    executor: {
      model: 'deepseek-flash',
      maxOutputTokens: 4_096,
      temperature: 0.3,
      reasoningEffort: 'off',
      fallbackModel: 'deepseek-v4-pro',
    },
    evaluator: { model: 'deepseek-flash', maxOutputTokens: 2_048, reasoningEffort: 'low' },
  },
};

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
    if (input.llm) await attachLlm(tx, tenantId, agentVersionId, input.llm);
  });

  return { tenantId, agentId, agentVersionId, widgetId, registryVersionId };
}

/** Provider 1개 + 역할별 model_configs 를 Agent 버전에 붙인다. */
export async function attachLlm(
  tx: Prisma.TransactionClient,
  tenantId: string,
  agentVersionId: string,
  llm: SeedLlmInput,
): Promise<void> {
  const provider = await tx.provider.upsert({
    where: { tenantId_name: { tenantId, name: llm.provider.name } },
    create: {
      tenantId,
      name: llm.provider.name,
      kind: llm.provider.kind,
      baseUrl: llm.provider.baseUrl ?? null,
      secretRef: llm.provider.secretRef,
    },
    update: {},
  });
  const roles = Object.entries(llm.models) as Array<
    ['planner' | 'executor' | 'evaluator', SeedModelSpec | undefined]
  >;
  for (const [role, spec] of roles) {
    if (!spec) continue;
    await tx.modelConfig.create({
      data: {
        tenantId,
        agentVersionId,
        role,
        providerId: provider.id,
        model: spec.model,
        maxOutputTokens: spec.maxOutputTokens,
        temperature: spec.temperature ?? 0,
        reasoningEffort: spec.reasoningEffort ?? null,
        fallbackProviderId: spec.fallbackModel ? provider.id : null,
        fallbackModel: spec.fallbackModel ?? null,
      },
    });
  }
}

/** 기존 데모 테넌트에 모델 설정이 없으면 DeepSeek 기본 설정을 붙인다. */
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
      const attached = await ensureDemoModels(prisma, found[0].id);
      console.log(
        attached
          ? '✔ 데모 테넌트에 DeepSeek 모델 설정을 붙였습니다.'
          : '· 데모 테넌트가 이미 있습니다. 시드를 건너뜁니다.',
      );
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
      llm: DEMO_DEEPSEEK,
    });
    console.log('✔ 데모 테넌트 생성', seeded);
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
