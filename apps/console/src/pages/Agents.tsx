/**
 * C-03 Agent 설정 — 지침 · 역할별 모델 · 허용 목록(MCP · Skill) · 실행 정책 · Memory 정책.
 * 배포된 버전은 바뀌지 않는다: 초안(배포 버전 복사본)을 고쳐 저장하고, 배포하면 새 작업부터 그 버전을 쓴다.
 * API: GET/PATCH/DELETE /v1/admin/agents/:id(/draft) · POST publish · versions · restore · GET /v1/admin/providers
 */
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { formatDuration, formatNumber } from '../../../shared/format';
import { ApiError } from '../api';
import { useApi, useAuth } from '../auth';
import {
  Badge,
  Card,
  type Column,
  ConfirmModal,
  DataTable,
  Empty,
  ErrorNotice,
  Field,
  Loading,
  Modal,
  Notice,
  PageHeader,
  Tabs,
  Time,
  Toggle,
  useAction,
  useQuery,
  useToast,
} from '../ui';
import { Button } from '@/components/ui/button';

/* ───────────── API 타입 (src/agents/admin/agents-admin.service.ts) ───────────── */

type Role = 'planner' | 'executor' | 'evaluator';
const ROLES: Role[] = ['planner', 'executor', 'evaluator'];

interface AgentListItem {
  id: string;
  name: string;
  publishedVersion: number | null;
}

interface AgentModel {
  role: Role;
  providerId: string;
  providerName: string;
  model: string;
  maxOutputTokens: number;
  temperature: number;
  reasoningEffort: string | null;
  fallbackProviderId: string | null;
  fallbackModel: string | null;
}

type Policy = Record<string, unknown>;

interface AllowEntry {
  id: string;
  name: string;
  status: string;
  enabled: boolean;
}

interface AgentVersion {
  id: string;
  version: number;
  status: 'draft' | 'published' | 'archived';
  publishedAt: string | null;
  changeNote: string | null;
  welcomeMessage: string;
  systemPrompt: string;
  executionPolicy: Policy;
  memoryPolicy: Policy;
  models: AgentModel[];
  mcpServers: AllowEntry[];
  skills: AllowEntry[];
  updatedAt: string;
}

interface AgentDetail {
  id: string;
  name: string;
  published: AgentVersion | null;
  draft: AgentVersion | null;
}

interface VersionRow {
  id: string;
  version: number;
  status: 'draft' | 'published' | 'archived';
  changeNote: string | null;
  publishedAt: string | null;
  publishedBy: string | null;
  createdAt: string;
  activeTasks: number;
}

interface Provider {
  id: string;
  name: string;
  kind: string;
  baseUrl: string | null;
}

interface McpServerItem {
  id: string;
  name: string;
  description: string | null;
  status: string;
  statusReason: string | null;
  tools: { total: number; enabled: number; pendingChanges: number };
}

interface SkillItem {
  id: string;
  name: string;
  status: string;
  activeVersion: { version: string; description: string } | null;
  latestVersion: { version: string; description: string } | null;
}

/* ───────────── 목록 ───────────── */

export function AgentsPage() {
  const api = useApi();
  const navigate = useNavigate();
  const agents = useQuery(async () => {
    const list = await api.get<AgentListItem[]>('/v1/admin/agents');
    // 목록 API 에는 초안 상태가 없어 상세를 함께 읽는다 (Agent 는 보통 몇 개뿐)
    return Promise.all(list.map((a) => api.get<AgentDetail>(`/v1/admin/agents/${a.id}`)));
  }, []);

  const columns: Column<AgentDetail>[] = [
    {
      key: 'name',
      header: 'Agent',
      render: (a) => {
        const executor = (a.draft ?? a.published)?.models.find((m) => m.role === 'executor');
        return (
          <div>
            <p className="cell-title">{a.name}</p>
            <p className="cell-sub">
              {executor ? `${executor.providerName} · ${executor.model}` : '실행 모델 없음'}
            </p>
          </div>
        );
      },
    },
    {
      key: 'published',
      header: '배포 버전',
      render: (a) =>
        a.published ? (
          <Badge tone="success">v{a.published.version} 배포 중</Badge>
        ) : (
          <Badge>배포 안 됨</Badge>
        ),
    },
    {
      key: 'draft',
      header: '초안',
      render: (a) =>
        a.draft ? (
          <Badge tone="warning">v{a.draft.version} · 배포 안 된 변경</Badge>
        ) : (
          <span className="muted">없음</span>
        ),
    },
    {
      key: 'allow',
      header: '허용 목록',
      render: (a) => {
        const v = a.draft ?? a.published;
        if (!v) return '—';
        const mcp = v.mcpServers.filter((s) => s.enabled).length;
        const skills = v.skills.filter((s) => s.enabled).length;
        return (
          <span className="muted">
            MCP {mcp} · Skill {skills}
          </span>
        );
      },
    },
    {
      key: 'updated',
      header: '최근 변경',
      render: (a) => <Time iso={(a.draft ?? a.published)?.updatedAt} />,
    },
  ];

  return (
    <>
      <PageHeader
        title="Agent 설정"
        description="지침 · 모델 · 허용 Tool · 실행 정책을 초안에서 고친 뒤 배포합니다. 배포된 버전은 바뀌지 않고, 실행 중인 작업은 시작할 때의 버전을 그대로 씁니다."
      />
      <ErrorNotice error={agents.error} onRetry={agents.reload} />
      <Card flush>
        <DataTable
          label="Agent 목록"
          columns={columns}
          rows={agents.data ?? []}
          rowKey={(a) => a.id}
          loading={agents.loading}
          onRowClick={(a) => navigate(`/agents/${a.id}`)}
          empty="Agent 가 없어요."
        />
      </Card>
    </>
  );
}

/* ───────────── 편집 폼 상태 ───────────── */

interface ModelForm {
  /** planner · evaluator 는 끄면 executor 설정을 쓴다 */
  enabled: boolean;
  providerId: string;
  model: string;
  maxOutputTokens: number | null;
  temperature: number | null;
  /** '' = Provider 기본값 */
  reasoningEffort: string;
  fallbackProviderId: string;
  fallbackModel: string;
}

interface Form {
  systemPrompt: string;
  welcomeMessage: string;
  models: Record<Role, ModelForm>;
  executionPolicy: Policy;
  memoryPolicy: Policy;
  /** 허용 목록에 있는 항목 → 사용 여부 */
  mcp: Record<string, boolean>;
  skills: Record<string, boolean>;
}

type Section = 'basic' | 'models' | 'tools' | 'execution' | 'memory';
const SECTION_LABEL: Record<Section, string> = {
  basic: '기본',
  models: '모델',
  tools: '허용 목록',
  execution: '실행 정책',
  memory: 'Memory 정책',
};

const EMPTY_MODEL: ModelForm = {
  enabled: false,
  providerId: '',
  model: '',
  maxOutputTokens: 4096,
  temperature: 0,
  reasoningEffort: '',
  fallbackProviderId: '',
  fallbackModel: '',
};

function toForm(v: AgentVersion): Form {
  const models = {} as Record<Role, ModelForm>;
  for (const role of ROLES) {
    const m = v.models.find((x) => x.role === role);
    models[role] = m
      ? {
          enabled: true,
          providerId: m.providerId,
          model: m.model,
          maxOutputTokens: m.maxOutputTokens,
          temperature: m.temperature,
          reasoningEffort: m.reasoningEffort ?? '',
          fallbackProviderId: m.fallbackProviderId ?? '',
          fallbackModel: m.fallbackModel ?? '',
        }
      : { ...EMPTY_MODEL, enabled: role === 'executor' };
  }
  return {
    systemPrompt: v.systemPrompt,
    welcomeMessage: v.welcomeMessage,
    models,
    executionPolicy: structuredClone(v.executionPolicy),
    memoryPolicy: structuredClone(v.memoryPolicy),
    mcp: Object.fromEntries(v.mcpServers.map((s) => [s.id, s.enabled])),
    skills: Object.fromEntries(v.skills.map((s) => [s.id, s.enabled])),
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** 꺼진 역할의 세부 값은 비교 · 전송에서 뺀다 */
function activeModels(models: Record<Role, ModelForm>) {
  return ROLES.filter((r) => models[r].enabled).map((r) => ({ role: r, ...models[r] }));
}

function sectionChanged(section: Section, a: Form, b: Form): boolean {
  switch (section) {
    case 'basic':
      return a.systemPrompt !== b.systemPrompt || a.welcomeMessage !== b.welcomeMessage;
    case 'models':
      return !same(activeModels(a.models), activeModels(b.models));
    case 'tools':
      return (
        !same(sortEntries(a.mcp), sortEntries(b.mcp)) ||
        !same(sortEntries(a.skills), sortEntries(b.skills))
      );
    case 'execution':
      return !same(a.executionPolicy, b.executionPolicy);
    case 'memory':
      return !same(a.memoryPolicy, b.memoryPolicy);
  }
}

function sortEntries(map: Record<string, boolean>) {
  return Object.entries(map).sort(([x], [y]) => x.localeCompare(y));
}

function getPath(obj: Policy, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o as Policy | undefined)?.[k], obj);
}

function setPath(obj: Policy, path: string, value: unknown): Policy {
  const [head, ...rest] = path.split('.') as [string, ...string[]];
  if (!rest.length) return { ...obj, [head]: value };
  return {
    ...obj,
    [head]: setPath((obj[head] as Policy | undefined) ?? {}, rest.join('.'), value),
  };
}

/* ───────────── 정책 필드 정의 (src/agents/agent-policies.ts 와 같은 범위) ───────────── */

type FieldSpec =
  | {
      kind: 'number';
      path: string;
      label: string;
      min: number;
      max?: number;
      step?: number;
      int?: boolean;
      unit?: string;
      hint?: (value: unknown) => ReactNode;
    }
  | { kind: 'bool'; path: string; label: string; hint?: ReactNode }
  | { kind: 'select'; path: string; label: string; options: [string, string][]; hint?: ReactNode };

interface FieldGroup {
  title: string;
  description?: ReactNode;
  fields: FieldSpec[];
  muted?: boolean;
}

const EXECUTION_GROUPS: FieldGroup[] = [
  {
    title: '실행 한도',
    description:
      '한도를 넘으면 작업은 실패로 끝나요. 운영자가 마지막 checkpoint 부터 재개할 수 있어요.',
    fields: [
      {
        kind: 'number',
        path: 'maxSteps',
        label: '최대 단계 수',
        min: 1,
        max: 200,
        int: true,
        unit: '단계',
        hint: () => 'Tool 호출도 한 단계로 셉니다',
      },
      {
        kind: 'number',
        path: 'maxDurationSec',
        label: '최대 실행 시간',
        min: 10,
        max: 86_400,
        int: true,
        unit: '초',
        hint: (v) =>
          typeof v === 'number' && v > 0 ? `= ${formatDuration(v * 1000)}` : '10초 ~ 24시간',
      },
      {
        kind: 'number',
        path: 'tokenBudget',
        label: '토큰 예산',
        min: 1_000,
        int: true,
        unit: '토큰',
        hint: (v) =>
          typeof v === 'number'
            ? `작업 하나의 모델 호출 합계 · ${formatNumber(v)} 토큰`
            : '최소 1,000',
      },
    ],
  },
  {
    title: '계획 · 검증',
    fields: [
      {
        kind: 'number',
        path: 'replanLimit',
        label: '재계획 한도',
        min: 0,
        max: 10,
        int: true,
        unit: '회',
        hint: () => '중간 평가에서 계획을 바꿀 수 있는 횟수',
      },
      {
        kind: 'bool',
        path: 'selfCorrection',
        label: '답변 자가 정정',
        hint: '최종 검증에서 구체적인 오류가 나오면 한 번 바로잡는 후속 메시지를 보냅니다',
      },
    ],
  },
  {
    title: 'Tool 실행',
    fields: [
      {
        kind: 'bool',
        path: 'parallelTools.enabled',
        label: '읽기 Tool 병렬 실행',
        hint: '한 응답의 읽기 등급 Tool 호출을 함께 실행합니다 (쓰기 이상은 순서대로)',
      },
      {
        kind: 'number',
        path: 'parallelTools.max',
        label: '동시 실행 수',
        min: 1,
        max: 10,
        int: true,
        unit: '개',
      },
      {
        kind: 'number',
        path: 'toolRetry.maxAttempts',
        label: '최대 시도 횟수',
        min: 1,
        max: 5,
        int: true,
        unit: '회',
        hint: () => '멱등 Tool 만 실패 · 시간 초과 시 다시 시도합니다',
      },
      {
        kind: 'number',
        path: 'toolRetry.baseMs',
        label: '재시도 첫 대기',
        min: 50,
        int: true,
        unit: 'ms',
        hint: () => '지수 백오프 — 다음 대기는 두 배씩',
      },
    ],
  },
  {
    title: 'Sandbox',
    muted: true,
    description: '실행형 Tool(Docker Sandbox) 단계에서 적용됩니다. 지금은 값만 저장돼요.',
    fields: [
      {
        kind: 'number',
        path: 'sandbox.cpu',
        label: 'CPU',
        min: 0.25,
        max: 8,
        step: 0.25,
        unit: 'vCPU',
      },
      {
        kind: 'number',
        path: 'sandbox.memoryMb',
        label: '메모리',
        min: 128,
        max: 16_384,
        int: true,
        unit: 'MB',
      },
      {
        kind: 'number',
        path: 'sandbox.timeoutSec',
        label: '실행 시간 제한',
        min: 1,
        max: 600,
        int: true,
        unit: '초',
      },
      {
        kind: 'select',
        path: 'sandbox.network',
        label: '네트워크',
        options: [
          ['none', '차단'],
          ['allowlist', '허용 목록만'],
        ],
      },
    ],
  },
];

const MEMORY_GROUPS: FieldGroup[] = [
  {
    title: '저장',
    fields: [
      {
        kind: 'bool',
        path: 'enabled',
        label: 'Memory 사용',
        hint: '끄면 작업이 끝나도 기억을 만들지 않고, 실행할 때 기억을 넣지 않습니다',
      },
      {
        kind: 'number',
        path: 'retentionDays',
        label: '보존 기간',
        min: 1,
        max: 3_650,
        int: true,
        unit: '일',
        hint: () => '고정한 기억은 기간이 지나도 남습니다',
      },
      {
        kind: 'number',
        path: 'minConfidence',
        label: '최소 확신도',
        min: 0,
        max: 1,
        step: 0.05,
        hint: () => '이보다 낮은 추출 결과는 "검증 필요" 로 저장됩니다 (0 ~ 1)',
      },
    ],
  },
  {
    title: '실행 시 불러오기',
    fields: [
      {
        kind: 'number',
        path: 'topK',
        label: '관련 기억 수',
        min: 0,
        max: 50,
        int: true,
        unit: '개',
        hint: () => '요청과 의미가 가까운 기억을 이만큼 넣습니다',
      },
      {
        kind: 'number',
        path: 'profileSize',
        label: '사용자 프로필 수',
        min: 0,
        max: 10,
        int: true,
        unit: '개',
        hint: () => '주제와 상관없이 늘 넣는 사용자 사실 · 선호',
      },
    ],
  },
];

const MEMORY_TYPES: [string, string, string][] = [
  ['episodic', '대화 요약', '무엇을 요청했고 어떻게 끝났는지'],
  ['semantic', '사실 · 선호', '사용자에 대한 사실, 말투 · 형식 선호'],
  ['procedural', '처리 요령', '실패 · 재계획에서 얻은 Agent 범위 요령'],
];

const REASONING: [string, string][] = [
  ['', 'Provider 기본값'],
  ['off', '끔'],
  ['low', '낮음'],
  ['medium', '중간'],
  ['high', '높음'],
  ['max', '최대'],
];

const ROLE_META: Record<Role, { title: string; description: string }> = {
  planner: {
    title: '계획 (planner)',
    description: '요청을 단계로 나누고 중간 평가 뒤 다시 계획합니다.',
  },
  executor: {
    title: '실행 · 답변 (executor)',
    description: 'reason · tool 단계를 실행하고 최종 답변을 스트리밍합니다. 필수입니다.',
  },
  evaluator: {
    title: '평가 · 검증 (evaluator)',
    description: '단계 결과를 평가하고 최종 답변을 검증합니다.',
  },
};

/* ───────────── 검증 · 오류 ───────────── */

type Issues = Record<string, string>;

function validateNumber(
  spec: Extract<FieldSpec, { kind: 'number' }>,
  value: unknown,
): string | null {
  if (value === null || value === undefined || value === '') return '값을 입력하세요';
  if (typeof value !== 'number' || Number.isNaN(value)) return '숫자를 입력하세요';
  if (spec.int && !Number.isInteger(value)) return '정수로 입력하세요';
  if (value < spec.min) return `${formatNumber(spec.min, 2)} 이상이어야 합니다`;
  if (spec.max !== undefined && value > spec.max)
    return `${formatNumber(spec.max, 2)} 이하여야 합니다`;
  return null;
}

function validate(form: Form): Issues {
  const issues: Issues = {};
  for (const [prefix, groups, policy] of [
    ['executionPolicy', EXECUTION_GROUPS, form.executionPolicy],
    ['memoryPolicy', MEMORY_GROUPS, form.memoryPolicy],
  ] as const) {
    for (const g of groups)
      for (const f of g.fields) {
        if (f.kind !== 'number') continue;
        const msg = validateNumber(f, getPath(policy, f.path));
        if (msg) issues[`${prefix}.${f.path}`] = msg;
      }
  }
  if (!Array.isArray(form.memoryPolicy.types))
    issues['memoryPolicy.types'] = '기억 종류를 고르세요';
  if (form.welcomeMessage.trim().length > 500) issues.welcomeMessage = '500자 이하로 입력하세요';
  if (form.systemPrompt.length > 20_000) issues.systemPrompt = '20,000자 이하로 입력하세요';
  for (const role of ROLES) {
    const m = form.models[role];
    if (!m.enabled) continue;
    const k = `models.${role}`;
    if (!m.providerId) issues[`${k}.providerId`] = 'Provider 를 고르세요';
    if (!m.model.trim()) issues[`${k}.model`] = '모델 이름을 입력하세요';
    if (
      m.maxOutputTokens === null ||
      !Number.isInteger(m.maxOutputTokens) ||
      m.maxOutputTokens < 64 ||
      m.maxOutputTokens > 64_000
    )
      issues[`${k}.maxOutputTokens`] = '64 ~ 64,000 사이 정수';
    if (m.temperature === null || m.temperature < 0 || m.temperature > 2)
      issues[`${k}.temperature`] = '0 ~ 2 사이';
    if (!!m.fallbackProviderId !== !!m.fallbackModel.trim())
      issues[`${k}.fallbackModel`] = '대체 Provider 와 모델은 함께 지정해야 합니다';
  }
  if (!form.models.executor.enabled) issues['models'] = 'executor 모델이 필요합니다';
  return issues;
}

function sectionOf(key: string): Section {
  if (key.startsWith('models')) return 'models';
  if (key.startsWith('mcp') || key.startsWith('skills')) return 'tools';
  if (key.startsWith('executionPolicy')) return 'execution';
  if (key.startsWith('memoryPolicy')) return 'memory';
  return 'basic';
}

/** 서버 422 의 path(models.0.providerId · mcpServers.1.enabled …)를 화면 키로 */
function mapServerIssues(
  err: ApiError,
  sent: { roles: Role[]; mcp: string[]; skills: string[] },
): Issues {
  const list = Array.isArray(err.body.errors)
    ? (err.body.errors as Array<{ path?: string; message?: string }>)
    : [];
  const out: Issues = {};
  for (const e of list) {
    const path = e.path ?? '';
    const parts = path.split('.');
    let key = path || 'general';
    if (parts[0] === 'models' && parts[1] !== undefined) {
      const role = sent.roles[Number(parts[1])];
      key = role ? `models.${role}.${parts[2] ?? 'model'}` : 'models';
    } else if (parts[0] === 'mcpServers') {
      const id = parts[1] !== undefined ? sent.mcp[Number(parts[1])] : undefined;
      key = id ? `mcp.${id}` : 'mcp';
    } else if (parts[0] === 'skills') {
      const id = parts[1] !== undefined ? sent.skills[Number(parts[1])] : undefined;
      key = id ? `skills.${id}` : 'skills';
    }
    out[key] = e.message ?? '값이 올바르지 않습니다';
  }
  if (!list.length) out.general = err.message;
  return out;
}

/* ───────────── 상세 ───────────── */

export function AgentDetailPage() {
  const { id = '' } = useParams();
  const api = useApi();
  const { can } = useAuth();
  const toast = useToast();
  const canEdit = can('admin');

  const detail = useQuery(() => api.get<AgentDetail>(`/v1/admin/agents/${id}`), [id]);
  const providers = useQuery(() => api.get<Provider[]>('/v1/admin/providers'), []);
  const servers = useQuery(() => api.get<McpServerItem[]>('/v1/admin/mcp-servers'), []);
  const skills = useQuery(() => api.get<SkillItem[]>('/v1/admin/skills'), []);

  const agent = detail.data;
  const base = agent ? (agent.draft ?? agent.published) : null;
  const baseForm = useMemo(() => (base ? toForm(base) : null), [base]);
  const [form, setForm] = useState<Form | null>(null);
  const [tab, setTab] = useState<Section>('basic');
  const [issues, setIssues] = useState<Issues>({});
  const [publishOpen, setPublishOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);

  useEffect(() => {
    setForm(baseForm);
    setIssues({});
  }, [baseForm]);

  const dirtySections = useMemo(
    () =>
      form && baseForm
        ? (Object.keys(SECTION_LABEL) as Section[]).filter((s) => sectionChanged(s, form, baseForm))
        : [],
    [form, baseForm],
  );
  const dirty = dirtySections.length > 0;

  // 초안과 배포 버전의 차이 (배포하면 바뀌는 항목)
  const pendingSections = useMemo(() => {
    if (!agent?.draft || !agent.published) return [];
    const d = toForm(agent.draft);
    const p = toForm(agent.published);
    return (Object.keys(SECTION_LABEL) as Section[]).filter((s) => sectionChanged(s, d, p));
  }, [agent]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const save = useAction(async () => {
    if (!form || !baseForm) return;
    const local = validate(form);
    if (Object.keys(local).length) {
      setIssues(local);
      const first = sectionOf(Object.keys(local)[0]!);
      setTab(first);
      throw new Error('입력값을 확인해 주세요');
    }
    const patch: Record<string, unknown> = {};
    const sent = { roles: [] as Role[], mcp: [] as string[], skills: [] as string[] };
    if (form.systemPrompt !== baseForm.systemPrompt) patch.systemPrompt = form.systemPrompt;
    if (form.welcomeMessage !== baseForm.welcomeMessage)
      patch.welcomeMessage = form.welcomeMessage.trim();
    if (sectionChanged('models', form, baseForm)) {
      const models = activeModels(form.models);
      sent.roles = models.map((m) => m.role);
      patch.models = models.map((m) => ({
        role: m.role,
        providerId: m.providerId,
        model: m.model.trim(),
        maxOutputTokens: m.maxOutputTokens,
        temperature: m.temperature,
        reasoningEffort: m.reasoningEffort || null,
        fallbackProviderId: m.fallbackProviderId || null,
        fallbackModel: m.fallbackModel.trim() || null,
      }));
    }
    for (const key of ['executionPolicy', 'memoryPolicy'] as const) {
      // 서버는 지금 값과 얕게 합친다 — 바뀐 최상위 키만 (중첩 객체는 통째로) 보낸다
      const changed = Object.keys(form[key]).filter((k) => !same(form[key][k], baseForm[key][k]));
      if (changed.length) patch[key] = Object.fromEntries(changed.map((k) => [k, form[key][k]]));
    }
    if (!same(sortEntries(form.mcp), sortEntries(baseForm.mcp))) {
      sent.mcp = Object.keys(form.mcp);
      patch.mcpServers = sent.mcp.map((sid) => ({ id: sid, enabled: form.mcp[sid] }));
    }
    if (!same(sortEntries(form.skills), sortEntries(baseForm.skills))) {
      sent.skills = Object.keys(form.skills);
      patch.skills = sent.skills.map((sid) => ({ id: sid, enabled: form.skills[sid] }));
    }
    try {
      const updated = await api.patch<AgentDetail>(`/v1/admin/agents/${id}/draft`, patch);
      detail.setData(updated);
      toast(`초안 v${updated.draft?.version ?? ''} 에 저장했어요`);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 422 || err.status === 400)) {
        const mapped = mapServerIssues(err, sent);
        setIssues(mapped);
        const first = Object.keys(mapped).find((k) => k !== 'general');
        if (first) setTab(sectionOf(first));
      }
      throw err;
    }
  });

  const publish = useAction(async (changeNote: string) => {
    const updated = await api.post<AgentDetail>(
      `/v1/admin/agents/${id}/publish`,
      changeNote ? { changeNote } : {},
    );
    detail.setData(updated);
    setPublishOpen(false);
    toast(`v${updated.published?.version ?? ''} 을 배포했어요 — 새 작업부터 적용돼요`);
  });

  const discard = useAction(async () => {
    const updated = await api.delete<AgentDetail>(`/v1/admin/agents/${id}/draft`);
    detail.setData(updated);
    setDiscardOpen(false);
    toast('초안을 버렸어요');
  });

  if (detail.error && !agent) {
    return (
      <>
        <PageHeader title="Agent 설정" back={{ to: '/agents', label: 'Agent 목록' }} />
        <ErrorNotice error={detail.error} onRetry={detail.reload} />
      </>
    );
  }
  if (!agent || !form || !baseForm) {
    if (agent && !base) {
      return (
        <>
          <PageHeader title={agent.name} back={{ to: '/agents', label: 'Agent 목록' }} />
          <Empty title="배포된 버전이 없어요">편집할 기준 버전이 없습니다.</Empty>
        </>
      );
    }
    return <Loading />;
  }

  const update = (fn: (f: Form) => Form) => setForm((f) => (f ? fn(f) : f));
  const issueCount = (s: Section) =>
    Object.keys(issues).filter((k) => sectionOf(k) === s && k !== 'general').length;
  const providerList = providers.data ?? [];
  const knownModels = [
    ...new Set(
      [agent.published, agent.draft].flatMap((v) =>
        v ? v.models.flatMap((m) => [m.model, ...(m.fallbackModel ? [m.fallbackModel] : [])]) : [],
      ),
    ),
  ];

  return (
    <div className="agent-page">
      <PageHeader
        back={{ to: '/agents', label: 'Agent 목록' }}
        title={agent.name}
        meta={
          <>
            {agent.published ? (
              <Badge tone="success">v{agent.published.version} 배포 중</Badge>
            ) : (
              <Badge>배포 안 됨</Badge>
            )}
            {agent.published?.publishedAt && (
              <span>
                <Time iso={agent.published.publishedAt} /> 배포
              </span>
            )}
            {agent.draft ? (
              <Badge tone="warning">초안 v{agent.draft.version} · 배포 안 된 변경</Badge>
            ) : (
              <span>초안 없음 — 저장하면 배포 버전을 복사해 초안을 만들어요</span>
            )}
          </>
        }
        actions={
          <>
            <Button variant="outline" onClick={() => setVersionsOpen(true)}>
              버전 기록
            </Button>
            {canEdit && agent.draft && (
              <Button variant="ghost" onClick={() => setDiscardOpen(true)}>
                초안 버리기
              </Button>
            )}
            {canEdit && (
              <Button
                disabled={!agent.draft || dirty}
                title={
                  dirty
                    ? '저장하지 않은 변경이 있어요 — 먼저 초안에 저장하세요'
                    : !agent.draft
                      ? '배포할 초안이 없어요'
                      : undefined
                }
                onClick={() => {
                  publish.reset();
                  setPublishOpen(true);
                }}
              >
                배포
              </Button>
            )}
          </>
        }
      />

      {!canEdit && (
        <Notice tone="info">
          보기 전용이에요. 설정을 바꾸고 배포하려면 Admin 이상 역할이 필요해요.
        </Notice>
      )}
      {agent.draft && pendingSections.length > 0 && (
        <div className="agent-pending" role="status">
          <span className="agent-pending-label">배포하면 바뀌는 항목</span>
          {pendingSections.map((s) => (
            <button key={s} type="button" className="agent-chip" onClick={() => setTab(s)}>
              {SECTION_LABEL[s]}
            </button>
          ))}
          {agent.draft.changeNote && <span className="muted">· {agent.draft.changeNote}</span>}
        </div>
      )}
      {issues.general && <Notice tone="error">{issues.general}</Notice>}

      <Tabs
        label="Agent 설정 영역"
        value={tab}
        onChange={setTab}
        tabs={(Object.keys(SECTION_LABEL) as Section[]).map((s) => ({
          id: s,
          label: (
            <span className="agent-tab">
              {SECTION_LABEL[s]}
              {dirtySections.includes(s) && (
                <span className="cfg-dirty-dot" aria-label="저장 안 됨" />
              )}
              {issueCount(s) > 0 && <span className="cfg-issue-count">{issueCount(s)}</span>}
            </span>
          ),
        }))}
      />

      <fieldset className="agent-fieldset" disabled={!canEdit}>
        {tab === 'basic' && <BasicSection form={form} update={update} issues={issues} />}
        {tab === 'models' && (
          <ModelsSection
            form={form}
            update={update}
            issues={issues}
            providers={providerList}
            providersError={providers.error}
            knownModels={knownModels}
          />
        )}
        {tab === 'tools' && (
          <ToolsSection
            form={form}
            update={update}
            issues={issues}
            servers={servers.data}
            serversError={servers.error}
            skills={skills.data}
            skillsError={skills.error}
            base={base}
          />
        )}
        {tab === 'execution' && (
          <PolicySection
            prefix="executionPolicy"
            groups={EXECUTION_GROUPS}
            policy={form.executionPolicy}
            onChange={(p) => update((f) => ({ ...f, executionPolicy: p }))}
            issues={issues}
            footer={
              <Notice tone="info">
                승인 요청의 만료 시간은 Tool 등급별 정책에서 정해요 —{' '}
                <Link to="/approvals">승인 · 권한 정책</Link>
              </Notice>
            }
          />
        )}
        {tab === 'memory' && (
          <PolicySection
            prefix="memoryPolicy"
            groups={MEMORY_GROUPS}
            policy={form.memoryPolicy}
            onChange={(p) => update((f) => ({ ...f, memoryPolicy: p }))}
            issues={issues}
            extra={
              <MemoryTypes
                value={(form.memoryPolicy.types as string[] | undefined) ?? []}
                onChange={(types) =>
                  update((f) => ({ ...f, memoryPolicy: { ...f.memoryPolicy, types } }))
                }
                error={issues['memoryPolicy.types']}
              />
            }
          />
        )}
      </fieldset>

      {canEdit && dirty && (
        <div className="cfg-save-bar" role="region" aria-label="저장">
          <span className="cfg-save-bar-text">
            <span className="cfg-dirty-dot" aria-hidden="true" />
            저장하지 않은 변경 · {dirtySections.map((s) => SECTION_LABEL[s]).join(', ')}
          </span>
          {save.error && <span className="cfg-save-bar-error">{save.error.message}</span>}
          <Button
            variant="ghost"
            onClick={() => {
              setForm(baseForm);
              setIssues({});
              save.reset();
            }}
          >
            되돌리기
          </Button>
          <Button loading={save.pending} onClick={() => void save.run()}>
            {agent.draft ? `초안 v${agent.draft.version} 에 저장` : '초안 만들어 저장'}
          </Button>
        </div>
      )}

      <PublishModal
        open={publishOpen}
        agent={agent}
        pendingSections={pendingSections}
        pending={publish.pending}
        error={publish.error}
        onClose={() => setPublishOpen(false)}
        onPublish={(note) => void publish.run(note)}
      />
      <ConfirmModal
        open={discardOpen}
        title="초안을 버릴까요?"
        body={
          <p className="cfg-modal-text">
            초안 v{agent.draft?.version} 의 변경 내용이 모두 사라지고, 배포 중인 v
            {agent.published?.version} 그대로 남습니다.
          </p>
        }
        confirmLabel="초안 버리기"
        danger
        pending={discard.pending}
        error={discard.error}
        onConfirm={() => void discard.run()}
        onClose={() => setDiscardOpen(false)}
      />
      <VersionsModal
        open={versionsOpen}
        agentId={id}
        canEdit={canEdit}
        dirty={dirty}
        onClose={() => setVersionsOpen(false)}
        onRestored={(updated, version) => {
          detail.setData(updated);
          setVersionsOpen(false);
          toast(`v${version} 내용으로 초안을 만들었어요 — 확인 후 배포하세요`);
        }}
      />
    </div>
  );
}

/* ───────────── 섹션: 기본 ───────────── */

function BasicSection({
  form,
  update,
  issues,
}: {
  form: Form;
  update: (fn: (f: Form) => Form) => void;
  issues: Issues;
}) {
  return (
    <>
      <Card
        title="지침 (시스템 프롬프트)"
        description="Agent 의 역할 · 말투 · 지켜야 할 규칙. 플랫폼 안전 지침 뒤에 붙고, 사용자 입력보다 우선합니다."
      >
        <Field
          label="지침"
          hint={`${formatNumber(form.systemPrompt.length)} / 20,000자`}
          error={issues.systemPrompt}
        >
          <textarea
            className="input agent-prompt"
            rows={14}
            value={form.systemPrompt}
            onChange={(e) => update((f) => ({ ...f, systemPrompt: e.target.value }))}
            placeholder="예: 당신은 쇼핑몰 고객지원 Agent 입니다. 주문 · 환불 문의에 답하고, 환불 실행 전에는 반드시 주문번호를 확인합니다."
          />
        </Field>
      </Card>
      <Card
        title="환영 문구"
        description="위젯 홈 화면의 인사말입니다. 줄바꿈이 그대로 보여요. 비우면 기본 문구를 씁니다."
      >
        <Field
          label="환영 문구"
          hint={`${form.welcomeMessage.trim().length} / 500자`}
          error={issues.welcomeMessage}
        >
          <textarea
            className="input"
            rows={3}
            value={form.welcomeMessage}
            onChange={(e) => update((f) => ({ ...f, welcomeMessage: e.target.value }))}
            placeholder={'안녕하세요,\n무엇을 도와드릴까요?'}
          />
        </Field>
      </Card>
    </>
  );
}

/* ───────────── 섹션: 모델 ───────────── */

function ModelsSection({
  form,
  update,
  issues,
  providers,
  providersError,
  knownModels,
}: {
  form: Form;
  update: (fn: (f: Form) => Form) => void;
  issues: Issues;
  providers: Provider[];
  providersError: Error | null;
  knownModels: string[];
}) {
  const setModel = (role: Role, patch: Partial<ModelForm>) =>
    update((f) => ({ ...f, models: { ...f.models, [role]: { ...f.models[role], ...patch } } }));
  return (
    <>
      <ErrorNotice error={providersError} />
      {issues.models && <Notice tone="error">{issues.models}</Notice>}
      <datalist id="agent-known-models">
        {knownModels.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      {ROLES.map((role) => {
        const m = form.models[role];
        const k = `models.${role}`;
        const meta = ROLE_META[role];
        return (
          <Card
            key={role}
            title={meta.title}
            description={meta.description}
            actions={
              role === 'executor' ? (
                <Badge tone="info">필수</Badge>
              ) : (
                <Toggle
                  checked={m.enabled}
                  onChange={(on) =>
                    setModel(
                      role,
                      on && !m.providerId
                        ? { ...copyFrom(form.models.executor), enabled: true }
                        : { enabled: on },
                    )
                  }
                  label="별도 모델"
                />
              )
            }
          >
            {!m.enabled ? (
              <p className="muted">실행(executor) 모델 설정을 그대로 씁니다.</p>
            ) : (
              <div className="ag-model-grid">
                <Field label="Provider" required error={issues[`${k}.providerId`]}>
                  <select
                    className="input"
                    value={m.providerId}
                    onChange={(e) => setModel(role, { providerId: e.target.value })}
                  >
                    <option value="">선택하세요</option>
                    {providers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.kind})
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="모델" required error={issues[`${k}.model`]}>
                  <input
                    className="input cfg-mono-input"
                    list="agent-known-models"
                    value={m.model}
                    onChange={(e) => setModel(role, { model: e.target.value })}
                    placeholder="예: deepseek-chat"
                  />
                </Field>
                <Field
                  label="최대 출력 토큰"
                  required
                  hint="64 ~ 64,000"
                  error={issues[`${k}.maxOutputTokens`]}
                >
                  <NumberInput
                    value={m.maxOutputTokens}
                    min={64}
                    max={64_000}
                    step={1}
                    onChange={(v) => setModel(role, { maxOutputTokens: v })}
                  />
                </Field>
                <Field
                  label="Temperature"
                  hint="0 ~ 2 · 낮을수록 일관됨"
                  error={issues[`${k}.temperature`]}
                >
                  <NumberInput
                    value={m.temperature}
                    min={0}
                    max={2}
                    step={0.1}
                    onChange={(v) => setModel(role, { temperature: v })}
                  />
                </Field>
                <Field label="추론 강도" hint="추론을 지원하는 모델에만 적용">
                  <select
                    className="input"
                    value={m.reasoningEffort}
                    onChange={(e) => setModel(role, { reasoningEffort: e.target.value })}
                  >
                    {REASONING.map(([v, label]) => (
                      <option key={v} value={v}>
                        {label}
                      </option>
                    ))}
                  </select>
                </Field>
                <div className="ag-model-fallback">
                  <p className="ag-model-fallback-title">대체 모델</p>
                  <p className="field-hint">
                    기본 모델이 오류 · 과부하로 응답하지 못하면 이 모델로 다시 시도합니다.
                  </p>
                  <div className="ag-model-fallback-row">
                    <Field label="대체 Provider" error={issues[`${k}.fallbackProviderId`]}>
                      <select
                        className="input"
                        value={m.fallbackProviderId}
                        onChange={(e) => setModel(role, { fallbackProviderId: e.target.value })}
                      >
                        <option value="">사용 안 함</option>
                        {providers.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} ({p.kind})
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="대체 모델" error={issues[`${k}.fallbackModel`]}>
                      <input
                        className="input cfg-mono-input"
                        list="agent-known-models"
                        value={m.fallbackModel}
                        disabled={!m.fallbackProviderId && !m.fallbackModel}
                        onChange={(e) => setModel(role, { fallbackModel: e.target.value })}
                      />
                    </Field>
                  </div>
                </div>
              </div>
            )}
          </Card>
        );
      })}
    </>
  );
}

function copyFrom(m: ModelForm): ModelForm {
  return { ...m };
}

function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
  id,
  invalid,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  id?: string;
  invalid?: boolean;
}) {
  return (
    <input
      id={id}
      className="input cfg-num-input"
      type="number"
      inputMode="decimal"
      value={value ?? ''}
      min={min}
      max={max}
      step={step}
      aria-invalid={invalid || undefined}
      onChange={(e) => {
        const raw = e.target.value;
        onChange(raw === '' ? null : Number(raw));
      }}
    />
  );
}

/* ───────────── 섹션: 허용 목록 ───────────── */

const MCP_STATUS: Record<string, [string, 'success' | 'warning' | 'danger' | 'neutral']> = {
  connected: ['연결됨', 'success'],
  pending_review: ['검토 대기', 'warning'],
  draft: ['등록 중', 'neutral'],
  error: ['오류', 'danger'],
  disabled: ['비활성', 'neutral'],
};
const SKILL_STATUS: Record<string, [string, 'success' | 'warning' | 'danger' | 'neutral']> = {
  active: ['활성', 'success'],
  pending_review: ['검토 대기', 'warning'],
  verification_failed: ['검증 실패', 'danger'],
  inactive: ['비활성', 'neutral'],
};

function ToolsSection({
  form,
  update,
  issues,
  servers,
  serversError,
  skills,
  skillsError,
  base,
}: {
  form: Form;
  update: (fn: (f: Form) => Form) => void;
  issues: Issues;
  servers: McpServerItem[] | undefined;
  serversError: Error | null;
  skills: SkillItem[] | undefined;
  skillsError: Error | null;
  base: AgentVersion | null;
}) {
  // 목록 API 에 없지만 허용 목록에 남아 있는 항목(삭제 직전 등)도 보이게 합친다
  const serverRows = mergeRows(servers, base?.mcpServers, (s) => ({
    id: s.id,
    name: s.name,
    status: s.status,
    sub: s.description ?? '',
    meta: `Tool ${s.tools.enabled}/${s.tools.total}`,
  }));
  const skillRows = mergeRows(skills, base?.skills, (s) => ({
    id: s.id,
    name: s.name,
    status: s.status,
    sub: (s.activeVersion ?? s.latestVersion)?.description ?? '',
    meta: s.activeVersion ? `v${s.activeVersion.version}` : '활성 버전 없음',
  }));
  return (
    <div className="grid grid-2">
      <Card
        title="MCP 서버"
        description="켠 서버의 Tool 만 이 Agent 가 계획 · 실행에 씁니다. 연결됨 상태인 서버만 켤 수 있어요."
        flush
      >
        <ErrorNotice error={serversError} />
        {issues.mcp && <Notice tone="error">{issues.mcp}</Notice>}
        <AllowList
          rows={serverRows}
          value={form.mcp}
          statusMap={MCP_STATUS}
          allowStatus="connected"
          issuePrefix="mcp"
          issues={issues}
          loading={!servers && !serversError}
          empty={
            <>
              연결된 MCP 서버가 없어요. <Link to="/mcp/new">MCP 서버 연결</Link>
            </>
          }
          onChange={(next) => update((f) => ({ ...f, mcp: next }))}
        />
      </Card>
      <Card
        title="Skill"
        description="켠 Skill 은 계획에 이름 · 설명만 보이고, 필요한 단계에서 본문을 읽습니다. 활성 Skill 만 켤 수 있어요."
        flush
      >
        <ErrorNotice error={skillsError} />
        {issues.skills && <Notice tone="error">{issues.skills}</Notice>}
        <AllowList
          rows={skillRows}
          value={form.skills}
          statusMap={SKILL_STATUS}
          allowStatus="active"
          issuePrefix="skills"
          issues={issues}
          loading={!skills && !skillsError}
          empty={
            <>
              등록된 Skill 이 없어요. <Link to="/skills">Skill 올리기</Link>
            </>
          }
          onChange={(next) => update((f) => ({ ...f, skills: next }))}
        />
      </Card>
    </div>
  );
}

interface AllowRow {
  id: string;
  name: string;
  status: string;
  sub: string;
  meta: string;
}

function mergeRows<T extends { id: string }>(
  items: T[] | undefined,
  inVersion: AllowEntry[] | undefined,
  map: (t: T) => AllowRow,
): AllowRow[] {
  const rows = (items ?? []).map(map);
  const known = new Set(rows.map((r) => r.id));
  for (const e of inVersion ?? []) {
    if (!known.has(e.id))
      rows.push({ id: e.id, name: e.name, status: e.status, sub: '', meta: '' });
  }
  return rows;
}

function AllowList({
  rows,
  value,
  statusMap,
  allowStatus,
  issuePrefix,
  issues,
  loading,
  empty,
  onChange,
}: {
  rows: AllowRow[];
  value: Record<string, boolean>;
  statusMap: Record<string, [string, 'success' | 'warning' | 'danger' | 'neutral']>;
  allowStatus: string;
  issuePrefix: string;
  issues: Issues;
  loading: boolean;
  empty: ReactNode;
  onChange: (next: Record<string, boolean>) => void;
}) {
  if (loading) return <Loading />;
  if (!rows.length) return <div className="table-empty">{empty}</div>;
  return (
    <ul className="ag-allow-list">
      {rows.map((r) => {
        const checked = value[r.id] === true;
        const blocked = r.status !== allowStatus && !checked;
        const [label, tone] = statusMap[r.status] ?? [r.status, 'neutral'];
        const error = issues[`${issuePrefix}.${r.id}`];
        return (
          <li key={r.id} className={blocked ? 'ag-allow-row is-blocked' : 'ag-allow-row'}>
            <label className="ag-allow-main">
              <input
                type="checkbox"
                checked={checked}
                disabled={blocked}
                onChange={(e) => onChange({ ...value, [r.id]: e.target.checked })}
              />
              <span className="ag-allow-text">
                <span className="ag-allow-name">
                  {r.name}
                  {r.id in value && !checked && <span className="muted"> · 꺼짐</span>}
                </span>
                {r.sub && <span className="ag-allow-sub">{r.sub}</span>}
                {error && <span className="field-error">{error}</span>}
              </span>
            </label>
            <span className="ag-allow-meta">
              {r.meta && <span className="muted">{r.meta}</span>}
              <Badge tone={tone}>{label}</Badge>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/* ───────────── 섹션: 정책 ───────────── */

function PolicySection({
  prefix,
  groups,
  policy,
  onChange,
  issues,
  extra,
  footer,
}: {
  prefix: string;
  groups: FieldGroup[];
  policy: Policy;
  onChange: (p: Policy) => void;
  issues: Issues;
  extra?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <>
      {groups.map((g, i) => (
        <Card
          key={g.title}
          title={
            <span className="row">
              {g.title}
              {g.muted && <Badge>준비 중</Badge>}
            </span>
          }
          description={g.description}
          className={g.muted ? 'ag-policy-muted' : undefined}
        >
          <div className="ag-policy-grid">
            {g.fields.map((f) => (
              <PolicyField
                key={f.path}
                spec={f}
                value={getPath(policy, f.path)}
                error={issues[`${prefix}.${f.path}`]}
                onChange={(v) => onChange(setPath(policy, f.path, v))}
              />
            ))}
          </div>
          {i === 0 && extra}
        </Card>
      ))}
      {footer}
    </>
  );
}

function PolicyField({
  spec,
  value,
  error,
  onChange,
}: {
  spec: FieldSpec;
  value: unknown;
  error?: string;
  onChange: (v: unknown) => void;
}) {
  if (spec.kind === 'bool') {
    return (
      <div className="ag-policy-bool">
        <Toggle checked={value === true} onChange={onChange} label={spec.label} />
        {spec.hint && <p className="field-hint">{spec.hint}</p>}
      </div>
    );
  }
  if (spec.kind === 'select') {
    return (
      <Field label={spec.label} hint={spec.hint} error={error}>
        <select
          className="input"
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        >
          {spec.options.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
      </Field>
    );
  }
  const range =
    spec.max !== undefined
      ? `${formatNumber(spec.min, 2)} ~ ${formatNumber(spec.max, 2)}`
      : `${formatNumber(spec.min, 2)} 이상`;
  return (
    <Field label={spec.label} hint={spec.hint?.(value) ?? range} error={error}>
      <span className="cfg-num-unit">
        <NumberInput
          value={typeof value === 'number' ? value : null}
          min={spec.min}
          max={spec.max}
          step={spec.step ?? 1}
          invalid={!!error}
          onChange={onChange}
        />
        {spec.unit && <span className="cfg-unit">{spec.unit}</span>}
      </span>
    </Field>
  );
}

function MemoryTypes({
  value,
  onChange,
  error,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  error?: string;
}) {
  return (
    <div className="ag-memory-types" role="group" aria-label="저장할 기억 종류">
      <p className="field-label">저장할 기억 종류</p>
      <div className="ag-memory-type-list">
        {MEMORY_TYPES.map(([id, label, desc]) => (
          <label key={id} className="ag-memory-type">
            <input
              type="checkbox"
              checked={value.includes(id)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? MEMORY_TYPES.map(([t]) => t).filter((t) => t === id || value.includes(t))
                    : value.filter((t) => t !== id),
                )
              }
            />
            <span>
              <span className="ag-memory-type-name">{label}</span>
              <span className="ag-allow-sub">{desc}</span>
            </span>
          </label>
        ))}
      </div>
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}

/* ───────────── 배포 · 버전 기록 ───────────── */

function PublishModal({
  open,
  agent,
  pendingSections,
  pending,
  error,
  onClose,
  onPublish,
}: {
  open: boolean;
  agent: AgentDetail;
  pendingSections: Section[];
  pending: boolean;
  error: Error | null;
  onClose: () => void;
  onPublish: (note: string) => void;
}) {
  const [note, setNote] = useState('');
  useEffect(() => {
    if (open) setNote(agent.draft?.changeNote ?? '');
  }, [open, agent.draft?.changeNote]);
  const serverIssues =
    error instanceof ApiError && Array.isArray(error.body.errors)
      ? (error.body.errors as Array<{ path?: string; message?: string }>)
      : [];
  return (
    <Modal
      open={open}
      title={`초안 v${agent.draft?.version ?? ''} 배포`}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            취소
          </Button>
          <Button loading={pending} onClick={() => onPublish(note.trim())}>
            배포
          </Button>
        </>
      }
    >
      <p className="cfg-modal-text">
        배포하면 <b>새로 시작하는 작업</b>부터 v{agent.draft?.version} 을 씁니다. 실행 중인 작업은
        시작할 때의 버전(v{agent.published?.version ?? '—'})을 그대로 유지해요.
      </p>
      {pendingSections.length > 0 && (
        <p className="cfg-modal-text muted">
          바뀌는 항목: {pendingSections.map((s) => SECTION_LABEL[s]).join(' · ')}
        </p>
      )}
      <Field label="변경 메모" hint="버전 기록에 남습니다 (500자 이하)">
        <textarea
          className="input"
          rows={3}
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="예: 환불 Skill 허용, executor 모델 교체"
        />
      </Field>
      {serverIssues.length > 0 ? (
        <div className="notice notice-error" role="alert">
          <div>
            <p>배포할 수 없어요.</p>
            <ul className="cfg-issue-list">
              {serverIssues.map((e, i) => (
                <li key={i}>{e.message}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : (
        <ErrorNotice error={error} />
      )}
    </Modal>
  );
}

const VERSION_STATUS: Record<VersionRow['status'], [string, 'success' | 'warning' | 'neutral']> = {
  published: ['배포 중', 'success'],
  draft: ['초안', 'warning'],
  archived: ['이전 버전', 'neutral'],
};

function VersionsModal({
  open,
  agentId,
  canEdit,
  dirty,
  onClose,
  onRestored,
}: {
  open: boolean;
  agentId: string;
  canEdit: boolean;
  dirty: boolean;
  onClose: () => void;
  onRestored: (updated: AgentDetail, version: number) => void;
}) {
  const api = useApi();
  const versions = useQuery(
    () => api.get<VersionRow[]>(`/v1/admin/agents/${agentId}/versions`),
    [agentId, open],
    { enabled: open },
  );
  const [target, setTarget] = useState<VersionRow | null>(null);
  const restore = useAction(async (row: VersionRow) => {
    const updated = await api.post<AgentDetail>(
      `/v1/admin/agents/${agentId}/versions/${row.id}/restore`,
    );
    setTarget(null);
    onRestored(updated, row.version);
  });
  const hasDraft = versions.data?.some((v) => v.status === 'draft') ?? false;

  const columns: Column<VersionRow>[] = [
    {
      key: 'version',
      header: '버전',
      width: '72px',
      render: (v) => <span className="ag-version-num">v{v.version}</span>,
    },
    {
      key: 'status',
      header: '상태',
      render: (v) => {
        const [label, tone] = VERSION_STATUS[v.status];
        return (
          <span className="row">
            <Badge tone={tone}>{label}</Badge>
            {v.activeTasks > 0 && <Badge tone="info">실행 중 작업 {v.activeTasks}</Badge>}
          </span>
        );
      },
    },
    {
      key: 'note',
      header: '변경 메모',
      render: (v) => (
        <span className="ag-version-note">{v.changeNote ?? <span className="muted">—</span>}</span>
      ),
    },
    {
      key: 'published',
      header: '배포',
      render: (v) =>
        v.publishedAt ? (
          <span>
            <Time iso={v.publishedAt} />
            {v.publishedBy && <span className="cell-sub"> · {v.publishedBy}</span>}
          </span>
        ) : (
          <span className="muted">
            <Time iso={v.createdAt} /> 생성
          </span>
        ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (v) =>
        canEdit && v.status !== 'draft' ? (
          <Button variant="outline" size="sm" onClick={() => setTarget(v)}>
            이 버전으로 초안 만들기
          </Button>
        ) : null,
    },
  ];

  return (
    <>
      <Modal open={open && !target} title="버전 기록" onClose={onClose} wide>
        <p className="cfg-modal-text muted">
          이전 버전을 고르면 그 내용으로 초안을 다시 만듭니다. 배포는 초안을 확인한 뒤 따로 해요.
        </p>
        <ErrorNotice error={versions.error} onRetry={versions.reload} />
        <div className="ag-versions-table">
          <DataTable
            label="버전 기록"
            columns={columns}
            rows={versions.data ?? []}
            rowKey={(v) => v.id}
            loading={versions.loading}
          />
        </div>
      </Modal>
      <ConfirmModal
        open={!!target}
        title={`v${target?.version ?? ''} 로 되돌릴까요?`}
        body={
          <div className="cfg-modal-text">
            <p>
              v{target?.version} 의 지침 · 모델 · 허용 목록 · 정책으로 새 초안을 만듭니다.
              {hasDraft && ' 지금 초안은 버려져요.'}
            </p>
            {dirty && <p className="field-error">저장하지 않은 변경도 사라집니다.</p>}
            <p className="muted">배포 중인 버전은 그대로이며, 초안을 확인한 뒤 배포하세요.</p>
          </div>
        }
        confirmLabel="초안 만들기"
        danger={hasDraft || dirty}
        pending={restore.pending}
        error={restore.error}
        onConfirm={() => target && void restore.run(target)}
        onClose={() => {
          setTarget(null);
          restore.reset();
        }}
      />
    </>
  );
}
