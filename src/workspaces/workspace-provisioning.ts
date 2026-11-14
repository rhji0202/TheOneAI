import { z } from 'zod';
import type {
  IdentityMode,
  MemberRole,
  Prisma,
  ProviderKind,
  ReasoningEffort,
} from '../generated/prisma/client.js';
import { defaultExecutionPolicy, defaultMemoryPolicy } from '../agents/agent-policies.js';
import { uuidv7 } from '../common/uuid.js';

/** 처음부터 있는 워크스페이스. slug 는 만든 뒤 바꿀 수 없으므로 이 워크스페이스는 늘 기본이고 지울 수 없다. */
export const DEFAULT_WORKSPACE_SLUG = 'default';

/** 워크스페이스 목록 순서 — 기본 워크스페이스 먼저, 그다음 이름 순 */
export function byWorkspaceOrder(
  a: { slug: string; name: string },
  b: { slug: string; name: string },
): number {
  return (
    Number(b.slug === DEFAULT_WORKSPACE_SLUG) - Number(a.slug === DEFAULT_WORKSPACE_SLUG) ||
    a.name.localeCompare(b.name)
  );
}

export const workspaceSlugSchema = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/,
    '영문 소문자 · 숫자 · 하이픈(-) 40자 이하, 하이픈으로 시작하거나 끝날 수 없습니다',
  );

export const workspaceNameSchema = z.string().trim().min(1).max(100);

export interface WorkspaceModelSpec {
  model: string;
  maxOutputTokens: number;
  temperature?: number;
  reasoningEffort?: ReasoningEffort;
  fallbackModel?: string;
}

/** 모델 (C-03 모델 구성) — Agent Loop 가 쓰는 executor 하나 */
export interface WorkspaceLlmInput {
  provider: { name: string; kind: ProviderKind; baseUrl?: string; secretRef: string };
  models: { executor: WorkspaceModelSpec };
}

export interface ProvisionWorkspaceInput {
  tenantId: string;
  slug: string;
  name: string;
  agentName?: string;
  widget: {
    publicKey: string;
    secretRef: string;
    allowedOrigins: string[];
    identityMode?: IdentityMode;
  };
  llm?: WorkspaceLlmInput;
  members?: Array<{ email: string; name: string; role: MemberRole; passwordHash: string | null }>;
}

export interface ProvisionedWorkspace {
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
  starterPrompts: [],
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

/**
 * 새 워크스페이스(테넌트) — Registry v1 · 기본 권한 정책 · 배포된 Agent v1 · 기본 위젯 (+ 모델 · 멤버).
 * tx 는 app.tenant_id 가 input.tenantId 로 설정된 트랜잭션이어야 한다 (RLS FORCE).
 */
export async function provisionWorkspace(
  tx: Prisma.TransactionClient,
  input: ProvisionWorkspaceInput,
): Promise<ProvisionedWorkspace> {
  const { tenantId } = input;
  const agentId = uuidv7();
  const agentVersionId = uuidv7();
  const widgetId = uuidv7();
  const registryVersionId = uuidv7();

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
  if (input.members?.length)
    await tx.user.createMany({
      data: input.members.map((m) => ({ ...m, email: m.email.toLowerCase(), tenantId })),
    });

  return { tenantId, agentId, agentVersionId, widgetId, registryVersionId };
}

/** Provider 1개 + 역할별 model_configs 를 Agent 버전에 붙인다. */
export async function attachLlm(
  tx: Prisma.TransactionClient,
  tenantId: string,
  agentVersionId: string,
  llm: WorkspaceLlmInput,
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
  const spec = llm.models.executor;
  await tx.modelConfig.create({
    data: {
      tenantId,
      agentVersionId,
      role: 'executor',
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
