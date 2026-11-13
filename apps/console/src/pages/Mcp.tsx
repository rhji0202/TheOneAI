/**
 * C-04 MCP 서버 목록 · 상세 · Tool Registry 버전.
 * API: docs/api-spec.md §4.5 — src/mcp/admin/mcp-admin.{controller,service,schemas}.ts
 * 조회는 Viewer, 변경은 Admin, 사설 네트워크 허용은 Owner.
 */
import {
  ArrowRightIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  PlusIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { formatPercent } from '../../../shared/format';
import { LEVEL } from '../../../shared/status';
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
  Json,
  KeyValue,
  Loading,
  Modal,
  Mono,
  Notice,
  PageHeader,
  RoleGate,
  SearchInput,
  Tabs,
  Time,
  TONE_CLASS,
  Toggle,
  Toolbar,
  useAction,
  useQuery,
  useToast,
} from '../ui';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';

/* ───────────── 타입 (서버 응답) ───────────── */

export type ServerStatus = 'draft' | 'pending_review' | 'connected' | 'error' | 'disabled';
export type PermissionLevel = 'read' | 'write' | 'external_send' | 'delete' | 'financial';
export type ApprovalMode = 'auto' | 'require_approval' | 'always_approval' | 'block';
type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'purple';

export interface McpServerView {
  id: string;
  name: string;
  description: string | null;
  transport: 'streamable_http' | 'stdio_sandbox';
  endpointUrl: string | null;
  authType: 'none' | 'api_key' | 'oauth';
  /** Secret 값은 오지 않는다 — 저장 여부만 */
  secretRef: string | null;
  allowedHosts: string[];
  allowPrivateNetwork: boolean;
  status: ServerStatus;
  statusReason: string | null;
  trust: 'verified' | 'needs_review' | 'rejected';
  protocolVersion: string | null;
  lastSyncedAt: string | null;
  health: { p95Ms: number | null; errorRate: number | null };
  tools: { total: number; enabled: number; pendingChanges: number };
  createdAt: string;
  updatedAt: string;
}

export interface CheckResult<T> {
  result: T;
  issues: string[];
}
export type SchemaCheck = 'valid' | 'warning' | 'error';
export type SecurityCheck = 'passed' | 'warning' | 'failed';

export interface ToolDefinitionSnapshot {
  title: string | null;
  description: string | null;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  schemaHash: string;
  schema: CheckResult<SchemaCheck>;
  security: CheckResult<SecurityCheck>;
  suggestedLevel: PermissionLevel;
}

export interface PendingChange {
  kind: 'added' | 'changed' | 'removed';
  detectedAt: string;
  next?: ToolDefinitionSnapshot;
}

export interface McpToolView {
  id: string;
  name: string;
  registryName: string;
  title: string | null;
  description: string | null;
  inputSchema: unknown;
  schema: CheckResult<SchemaCheck>;
  security: CheckResult<SecurityCheck>;
  permissionLevel: PermissionLevel;
  approvalModeOverride: ApprovalMode | null;
  enabled: boolean;
  state: 'active' | 'pending_change' | 'removed';
  pendingChange: PendingChange | null;
}

export type BlockedReason =
  | 'private_ip'
  | 'link_local'
  | 'metadata'
  | 'host_not_allowed'
  | 'scheme_not_allowed'
  | 'dns_failed';

export interface ConnectionTestResult {
  handshake: 'ok' | 'failed';
  protocolVersion: string | null;
  era: 'modern' | 'legacy' | null;
  latencyMs: number | null;
  ssrf: { resolvedIps: string[]; allowed: boolean; blockedReason?: BlockedReason };
  server?: { name: string; version: string };
  error?: string;
}

export interface DiscoveredTool {
  name: string;
  description: string | null;
  schema: CheckResult<SchemaCheck>;
  security: CheckResult<SecurityCheck>;
  suggestedLevel: PermissionLevel;
  defaultInclude: boolean;
}

export interface DiscoverResult {
  server: McpServerView;
  protocolVersion: string | null;
  tools: DiscoveredTool[];
  changes: { added: number; changed: number; removed: number } | null;
}

export interface RegistryDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export interface PublishedVersion {
  id: string;
  version: number;
  created: boolean;
  diff: RegistryDiff;
}

interface ChangeSummary extends Partial<RegistryDiff> {
  reason?: string;
  server?: string;
  tool?: string;
  tools?: string[];
  skill?: string;
  version?: string;
}

interface RegistryVersionView {
  id: string;
  version: number;
  createdAt: string;
  changeSummary: ChangeSummary | null;
  toolCount: number;
}

interface SnapshotTool {
  name: string;
  source: 'builtin' | 'mcp';
  description: string;
  inputSchema: Record<string, unknown>;
  schemaHash: string;
  level: PermissionLevel;
  modeOverride: ApprovalMode | null;
}

interface SnapshotSkill {
  name: string;
  skillId: string;
  versionId: string;
  version: string;
  description: string;
  allowedTools: string[];
  contentHash: string;
}

interface RegistryVersionDetail {
  id: string;
  version: number;
  createdAt: string;
  changeSummary: ChangeSummary | null;
  snapshot: { builtinsHash: string; tools: SnapshotTool[]; skills: SnapshotSkill[] };
}

interface RegistryDiffView extends RegistryDiff {
  from: number | null;
  to: number;
}

/* ───────────── 라벨 · 배지 (마법사와 공용) ───────────── */

export const SERVER_STATUS: Record<ServerStatus, { label: string; tone: Tone }> = {
  draft: { label: '작성 중', tone: 'neutral' },
  pending_review: { label: '검토 대기', tone: 'warning' },
  connected: { label: '연결됨', tone: 'success' },
  error: { label: '오류', tone: 'danger' },
  disabled: { label: '비활성', tone: 'neutral' },
};

const TRUST: Record<McpServerView['trust'], { label: string; tone: Tone }> = {
  verified: { label: '검증됨', tone: 'success' },
  needs_review: { label: '검토 필요', tone: 'warning' },
  rejected: { label: '거부됨', tone: 'danger' },
};

export const LEVELS: PermissionLevel[] = ['read', 'write', 'external_send', 'delete', 'financial'];
const LEVEL_TONE: Record<PermissionLevel, Tone> = {
  read: 'info',
  write: 'warning',
  external_send: 'purple',
  delete: 'danger',
  financial: 'danger',
};

export const APPROVAL_MODES: { value: ApprovalMode; label: string }[] = [
  { value: 'auto', label: '자동 실행' },
  { value: 'require_approval', label: '승인 필요 (task 범위 허용)' },
  { value: 'always_approval', label: '매번 승인' },
  { value: 'block', label: '차단' },
];

export function approvalLabel(mode: ApprovalMode | null): string {
  if (!mode) return '등급 기본값';
  return APPROVAL_MODES.find((m) => m.value === mode)?.label ?? mode;
}

const SCHEMA_CHECK: Record<SchemaCheck, { label: string; tone: Tone }> = {
  valid: { label: '스키마 정상', tone: 'success' },
  warning: { label: '스키마 경고', tone: 'warning' },
  error: { label: '스키마 오류', tone: 'danger' },
};
const SECURITY_CHECK: Record<SecurityCheck, { label: string; tone: Tone }> = {
  passed: { label: '보안 통과', tone: 'success' },
  warning: { label: '보안 경고', tone: 'warning' },
  failed: { label: '보안 실패', tone: 'danger' },
};

const TOOL_STATE: Record<McpToolView['state'], { label: string; tone: Tone }> = {
  active: { label: '정상', tone: 'neutral' },
  pending_change: { label: '변경 검토 대기', tone: 'warning' },
  removed: { label: '서버에서 삭제됨', tone: 'danger' },
};

const CHANGE_KIND: Record<PendingChange['kind'], { label: string; tone: Tone }> = {
  added: { label: '새 Tool', tone: 'info' },
  changed: { label: '정의 변경', tone: 'warning' },
  removed: { label: '삭제됨', tone: 'danger' },
};

export const BLOCKED_REASON: Record<BlockedReason, string> = {
  private_ip: '사설 IP 로 해석됩니다 — 사설 네트워크 허용(Owner)이 필요해요',
  link_local: '링크 로컬 주소로 해석됩니다',
  metadata: '클라우드 메타데이터 주소입니다 — 어떤 설정으로도 허용되지 않아요',
  host_not_allowed: '허용되지 않은 호스트입니다 — 허용 호스트에 추가해 주세요',
  scheme_not_allowed: 'https 주소만 연결할 수 있어요',
  dns_failed: '호스트 이름을 DNS 로 찾지 못했어요',
};

const REGISTRY_REASON: Record<string, string> = {
  mcp_server_registered: 'MCP 서버 등록',
  mcp_server_changed: 'MCP 연결 정보 변경',
  mcp_tool_policy_changed: 'MCP Tool 정책 변경',
  mcp_changes_approved: 'MCP 변경 승인',
  mcp_server_disabled: 'MCP 서버 비활성화',
  mcp_server_deleted: 'MCP 서버 삭제',
  skill_activated: 'Skill 활성화',
  skill_disabled: 'Skill 비활성화',
  builtin_tools_changed: '내장 Tool 구성 변경',
};

export const FILTER_ITEM =
  'data-[state=on]:border-primary/40 data-[state=on]:bg-primary/10 data-[state=on]:text-primary';

/** 카드 안 세로 목록(Registry 버전 · Skill 버전 · 번들 파일)의 항목 버튼 — 선택은 aria-current */
export const LIST_ITEM =
  'flex w-full flex-col gap-1 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-muted aria-[current=true]:bg-primary/10';

export function ServerStatusBadge({ status }: { status: ServerStatus }) {
  const s = SERVER_STATUS[status] ?? { label: status, tone: 'neutral' as Tone };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function LevelBadge({ level }: { level: PermissionLevel }) {
  return <Badge tone={LEVEL_TONE[level] ?? 'neutral'}>{LEVEL[level] ?? level}</Badge>;
}

export function CheckBadges({
  schema,
  security,
}: {
  schema: CheckResult<SchemaCheck>;
  security: CheckResult<SecurityCheck>;
}) {
  const s = SCHEMA_CHECK[schema.result];
  const k = SECURITY_CHECK[security.result];
  return (
    <span className="inline-flex flex-wrap gap-1">
      <Badge tone={s.tone}>{s.label}</Badge>
      <Badge tone={k.tone}>{k.label}</Badge>
    </span>
  );
}

/** 검사 결과 문제 목록 (스키마 · 보안) */
export function CheckIssues({
  schema,
  security,
}: {
  schema: CheckResult<SchemaCheck>;
  security: CheckResult<SecurityCheck>;
}) {
  const items = [
    ...schema.issues.map((m) => ({ kind: '스키마', m, bad: schema.result === 'error' })),
    ...security.issues.map((m) => ({ kind: '보안', m, bad: security.result === 'failed' })),
  ];
  if (!items.length) return null;
  return (
    <ul className="my-2 flex flex-col gap-1 text-sm">
      {items.map((it, i) => {
        const Icon = it.bad ? CircleAlertIcon : TriangleAlertIcon;
        return (
          <li
            key={i}
            className={cn(
              'flex items-start gap-1.5',
              it.bad ? 'text-red-700 dark:text-red-300' : 'text-amber-800 dark:text-amber-300',
            )}
          >
            <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>
              <strong className="font-semibold">{it.kind}</strong> {it.m}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export interface FieldIssue {
  path: string;
  message: string;
  line?: number;
}

/** problem+json 의 errors[] (필드별 문제) */
export function issuesOf(err: Error | null | undefined): FieldIssue[] {
  if (err instanceof ApiError && Array.isArray(err.body.errors)) {
    return err.body.errors as FieldIssue[];
  }
  return [];
}

export function issueFor(err: Error | null | undefined, path: string): string | undefined {
  return issuesOf(err).find((i) => i.path === path || i.path.startsWith(`${path}.`))?.message;
}

/** 필드 문제 목록까지 보여 주는 오류 (필드에 붙이지 못한 문제용) */
export function ApiErrorNotice({
  error,
  skipPaths = [],
}: {
  error: Error | null | undefined;
  skipPaths?: string[];
}) {
  if (!error) return null;
  // detail 이 없으면 서버가 제목(예: 입력값 오류)을 준다 — 필드에 붙이지 못한 문제만 아래에 나열
  const rest = issuesOf(error).filter(
    (i) => !skipPaths.some((p) => i.path === p || i.path.startsWith(`${p}.`)),
  );
  return (
    <Alert variant="destructive" className="mb-3 flex items-start gap-2.5 border-destructive/30">
      <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p>{error.message}</p>
        {rest.length > 0 && (
          <ul className="mt-1.5 list-disc pl-5 text-sm">
            {rest.map((i, n) => (
              <li key={n}>
                {i.path && <Mono>{i.path}</Mono>} {i.message}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Alert>
  );
}

export function registryMessage(registry: PublishedVersion | null | undefined): string {
  if (!registry) return '';
  if (!registry.created) return 'Tool Registry 는 그대로예요';
  const { added, changed, removed } = registry.diff;
  const parts = [
    added.length ? `추가 ${added.length}` : '',
    changed.length ? `변경 ${changed.length}` : '',
    removed.length ? `삭제 ${removed.length}` : '',
  ].filter(Boolean);
  return `Tool Registry v${registry.version} 생성${parts.length ? ` (${parts.join(' · ')})` : ''}`;
}

export function hostOf(url: string | null): string {
  if (!url) return '—';
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function formatMs(ms: number | null | undefined): string {
  return ms == null ? '—' : `${Math.round(ms).toLocaleString('ko-KR')}ms`;
}

/* ───────────── 줄 단위 비교 (MCP Tool 정의 · Skill 파일) ───────────── */

export interface DiffLine {
  type: 'same' | 'add' | 'del';
  text: string;
}

/** LCS 기반 줄 비교 — 수백 줄 이하의 정의 · 문서용 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length * b.length > 400_000) {
    return [
      ...a.map((text) => ({ type: 'del' as const, text })),
      ...b.map((text) => ({ type: 'add' as const, text })),
    ];
  }
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    Array.from({ length: b.length + 1 }, () => 0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ type: 'del', text: a[i++]! });
    else out.push({ type: 'add', text: b[j++]! });
  }
  while (i < a.length) out.push({ type: 'del', text: a[i++]! });
  while (j < b.length) out.push({ type: 'add', text: b[j++]! });
  return out;
}

const DIFF_LINE: Record<DiffLine['type'], string> = {
  same: '',
  add: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300',
  del: 'bg-red-50 text-red-800 dark:bg-red-950/60 dark:text-red-300',
};

export function DiffView({
  before,
  after,
  label,
}: {
  before: string;
  after: string;
  label?: ReactNode;
}) {
  const lines = useMemo(() => lineDiff(before, after), [before, after]);
  const changed = lines.some((l) => l.type !== 'same');
  return (
    <div className="overflow-hidden rounded-lg border">
      {label && (
        <div className="border-b bg-muted/50 px-3 py-1.5 text-xs font-medium text-muted-foreground">
          {label}
        </div>
      )}
      {!changed ? (
        <p className="px-3 py-2 text-sm text-muted-foreground">차이 없음</p>
      ) : (
        <pre
          className="m-0 max-h-[420px] overflow-auto py-1.5 font-mono text-[12.5px] leading-relaxed"
          aria-label="변경 내용 (- 이전, + 이후)"
        >
          {lines.map((l, n) => (
            <div key={n} className={cn('px-3 break-words whitespace-pre-wrap', DIFF_LINE[l.type])}>
              <span className="inline-block w-4 select-none" aria-hidden="true">
                {l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}
              </span>
              {l.text || ' '}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}

const pretty = (v: unknown) => JSON.stringify(v ?? null, null, 2) ?? 'null';

/* ───────────── C-04 목록 ───────────── */

type StatusFilter = 'all' | ServerStatus | 'review';

export function McpListPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'registry' ? 'registry' : 'servers';
  return (
    <>
      <PageHeader
        title="MCP 서버"
        description="외부 Tool 을 제공하는 MCP 서버를 연결하고, Tool 권한 등급 · 변경 검토 · Registry 버전을 관리합니다."
        actions={
          <RoleGate min="admin">
            <Button asChild>
              <Link to="/mcp/new">
                <PlusIcon aria-hidden="true" />
                MCP 서버 연결
              </Link>
            </Button>
          </RoleGate>
        }
      />
      <Tabs
        label="MCP 보기"
        tabs={[
          { id: 'servers', label: '서버' },
          { id: 'registry', label: 'Tool Registry 버전' },
        ]}
        value={tab}
        onChange={(id) =>
          setParams(id === 'registry' ? { tab: 'registry' } : {}, { replace: true })
        }
      />
      {tab === 'servers' ? <ServerList /> : <RegistryVersions />}
    </>
  );
}

function ServerList() {
  const api = useApi();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<StatusFilter>('all');
  const servers = useQuery(() => api.get<McpServerView[]>('/v1/admin/mcp-servers'), [], {
    pollMs: 30_000,
  });
  const all = servers.data ?? [];
  const needsReview = (s: McpServerView) =>
    s.status === 'pending_review' || s.status === 'draft' || s.tools.pendingChanges > 0;
  const rows = all.filter((s) => {
    if (
      q &&
      !`${s.name} ${s.description ?? ''} ${s.endpointUrl ?? ''}`
        .toLowerCase()
        .includes(q.toLowerCase())
    )
      return false;
    if (filter === 'all') return true;
    if (filter === 'review') return needsReview(s);
    return s.status === filter;
  });
  const count = (f: (s: McpServerView) => boolean) => all.filter(f).length;

  const columns: Column<McpServerView>[] = [
    {
      key: 'name',
      header: '서버',
      render: (s) => (
        <div className="min-w-0">
          <div className="font-mono font-semibold">{s.name}</div>
          <div className="mt-0.5 line-clamp-2 text-xs whitespace-normal text-muted-foreground">
            {s.description || 'Streamable HTTP'}
          </div>
        </div>
      ),
    },
    {
      key: 'endpoint',
      header: '엔드포인트',
      render: (s) => <Mono title={s.endpointUrl ?? undefined}>{hostOf(s.endpointUrl)}</Mono>,
    },
    {
      key: 'status',
      header: '상태',
      render: (s) => (
        <div className="flex flex-wrap items-center gap-1">
          <ServerStatusBadge status={s.status} />
          {s.tools.pendingChanges > 0 && (
            <Badge tone="warning">변경 {s.tools.pendingChanges}건 검토</Badge>
          )}
        </div>
      ),
    },
    {
      key: 'tools',
      header: 'Tool',
      align: 'right',
      render: (s) => (
        <span className="tabular-nums" title="사용 중 / 전체">
          {s.tools.enabled} <span className="text-muted-foreground">/ {s.tools.total}</span>
        </span>
      ),
    },
    {
      key: 'health',
      header: '24시간 p95 · 오류율',
      render: (s) => <HealthCell health={s.health} />,
    },
    {
      key: 'protocol',
      header: '프로토콜',
      render: (s) =>
        s.protocolVersion ? (
          <Mono>{s.protocolVersion}</Mono>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: 'synced',
      header: '마지막 탐색',
      render: (s) => <Time iso={s.lastSyncedAt} />,
    },
  ];

  return (
    <>
      <Toolbar>
        <SearchInput label="서버 검색" placeholder="이름 · 설명 · URL" value={q} onChange={setQ} />
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={1}
          className="flex-wrap"
          aria-label="상태 필터"
          value={filter}
          onValueChange={(v) => v && setFilter(v as StatusFilter)}
        >
          {(
            [
              ['all', `전체 ${all.length}`],
              ['connected', `연결됨 ${count((s) => s.status === 'connected')}`],
              ['review', `검토 필요 ${count(needsReview)}`],
              ['error', `오류 ${count((s) => s.status === 'error')}`],
              ['disabled', `비활성 ${count((s) => s.status === 'disabled')}`],
            ] as [StatusFilter, string][]
          ).map(([id, label]) => (
            <ToggleGroupItem key={id} value={id} className={FILTER_ITEM}>
              {label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Toolbar>
      <ErrorNotice error={servers.error} onRetry={() => void servers.reload()} />
      <Card flush>
        <DataTable
          label="MCP 서버 목록"
          columns={columns}
          rows={rows}
          rowKey={(s) => s.id}
          loading={servers.loading && !servers.data}
          onRowClick={(s) => navigate(`/mcp/${s.id}`)}
          empty={
            all.length === 0 ? (
              <Empty title="연결된 MCP 서버가 없어요">
                <p>MCP 서버를 연결하면 Agent 가 그 서버의 Tool 을 쓸 수 있어요.</p>
                <RoleGate min="admin">
                  <Button asChild className="mt-3">
                    <Link to="/mcp/new">
                      <PlusIcon aria-hidden="true" />
                      MCP 서버 연결
                    </Link>
                  </Button>
                </RoleGate>
              </Empty>
            ) : (
              '조건에 맞는 서버가 없어요'
            )
          }
        />
      </Card>
    </>
  );
}

function HealthCell({ health }: { health: McpServerView['health'] }) {
  if (health.p95Ms == null && health.errorRate == null)
    return <span className="text-muted-foreground">호출 없음</span>;
  const rate = health.errorRate ?? 0;
  return (
    <span className="inline-flex items-center gap-1.5 tabular-nums">
      <span>{formatMs(health.p95Ms)}</span>
      <span className="text-muted-foreground">·</span>
      <span
        className={cn(
          rate >= 0.05 && 'font-semibold text-red-600 dark:text-red-400',
          rate > 0 && rate < 0.05 && 'text-amber-700 dark:text-amber-400',
        )}
      >
        {formatPercent(rate)}
      </span>
    </span>
  );
}

/* ───────────── Tool Registry 버전 ───────────── */

function reasonText(summary: ChangeSummary | null): string {
  if (!summary?.reason) return '변경';
  const label = REGISTRY_REASON[summary.reason] ?? summary.reason;
  const target = summary.server ?? summary.tool ?? summary.skill;
  return target ? `${label} · ${target}${summary.version ? ` ${summary.version}` : ''}` : label;
}

function RegistryVersions() {
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const versions = useQuery(
    () => api.get<RegistryVersionView[]>('/v1/admin/tool-registry/versions'),
    [],
  );
  const list = versions.data ?? [];
  const selected = Number(params.get('v')) || list[0]?.version || null;

  if (versions.loading && !versions.data) return <Loading />;
  if (versions.error)
    return <ErrorNotice error={versions.error} onRetry={() => void versions.reload()} />;
  if (!list.length)
    return (
      <Card>
        <Empty title="아직 Registry 버전이 없어요">
          MCP 서버를 등록하거나 Skill 을 활성화하면 버전이 만들어져요.
        </Empty>
      </Card>
    );

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
      <Card
        className="mb-0 lg:sticky lg:top-[72px]"
        title="버전"
        description="새 작업은 만들 때의 최신 버전을 고정해 씁니다."
        flush
      >
        <ul
          className="flex max-h-[70vh] flex-col gap-0.5 overflow-y-auto p-1.5"
          aria-label="Registry 버전"
        >
          {list.map((v) => {
            const s = v.changeSummary;
            return (
              <li key={v.id}>
                <button
                  type="button"
                  className={LIST_ITEM}
                  aria-current={v.version === selected || undefined}
                  onClick={() =>
                    setParams({ tab: 'registry', v: String(v.version) }, { replace: true })
                  }
                >
                  <span className="flex w-full items-center gap-2">
                    <strong className="font-semibold">v{v.version}</strong>
                    {v.version === list[0]!.version && <Badge tone="success">최신</Badge>}
                    <span className="ml-auto text-xs text-muted-foreground">
                      <Time iso={v.createdAt} />
                    </span>
                  </span>
                  <span className="line-clamp-2 text-muted-foreground">{reasonText(s)}</span>
                  <span className="flex gap-2 text-xs tabular-nums">
                    {s?.added?.length ? (
                      <span className={NAME_DIFF_TEXT.add}>+{s.added.length}</span>
                    ) : null}
                    {s?.changed?.length ? (
                      <span className={NAME_DIFF_TEXT.chg}>~{s.changed.length}</span>
                    ) : null}
                    {s?.removed?.length ? (
                      <span className={NAME_DIFF_TEXT.del}>−{s.removed.length}</span>
                    ) : null}
                    <span className="text-muted-foreground">Tool {v.toolCount}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </Card>
      {selected && <RegistryVersionDetailView version={selected} all={list} />}
    </div>
  );
}

function RegistryVersionDetailView({
  version,
  all,
}: {
  version: number;
  all: RegistryVersionView[];
}) {
  const api = useApi();
  const [from, setFrom] = useState<number | ''>('');
  useEffect(() => setFrom(''), [version]);
  const detail = useQuery(
    () => api.get<RegistryVersionDetail>(`/v1/admin/tool-registry/versions/${version}`),
    [version],
  );
  const diff = useQuery(
    () =>
      api.get<RegistryDiffView>(`/v1/admin/tool-registry/versions/${version}/diff`, {
        from: from === '' ? undefined : from,
      }),
    [version, from],
  );
  const d = detail.data;
  const toolColumns: Column<SnapshotTool>[] = [
    {
      key: 'name',
      header: 'Tool',
      render: (t) => (
        <span className="whitespace-nowrap">
          <Mono>{t.name}</Mono>
        </span>
      ),
    },
    {
      key: 'source',
      header: '출처',
      render: (t) => (
        <Badge tone={t.source === 'mcp' ? 'purple' : 'neutral'}>
          {t.source === 'mcp' ? 'MCP' : '내장'}
        </Badge>
      ),
    },
    { key: 'level', header: '등급', render: (t) => <LevelBadge level={t.level} /> },
    {
      key: 'mode',
      header: '승인 정책',
      render: (t) => <span className="whitespace-nowrap">{approvalLabel(t.modeOverride)}</span>,
    },
    {
      key: 'desc',
      header: '설명',
      render: (t) => (
        <span className="line-clamp-2 min-w-48 whitespace-normal">{t.description}</span>
      ),
    },
  ];

  return (
    <div className="min-w-0">
      <ErrorNotice error={detail.error} onRetry={() => void detail.reload()} />
      <Card
        title={`Tool Registry v${version}`}
        description={d ? reasonText(d.changeSummary) : undefined}
      >
        {!d ? (
          <Loading />
        ) : (
          <KeyValue
            items={[
              ['만든 시각', <Time key="t" iso={d.createdAt} absolute />],
              [
                'Tool',
                `${d.snapshot.tools.length}개 (MCP ${d.snapshot.tools.filter((t) => t.source === 'mcp').length})`,
              ],
              ['Skill', `${d.snapshot.skills.length}개`],
              ['버전 ID', <Mono key="i">{d.id}</Mono>],
            ]}
          />
        )}
      </Card>
      <Card
        title="변경 비교"
        actions={
          <div className="flex items-center gap-2">
            <Label htmlFor="registry-diff-from" className="font-normal text-muted-foreground">
              기준
            </Label>
            <NativeSelect
              id="registry-diff-from"
              size="sm"
              containerClassName="w-auto"
              value={from}
              onChange={(e) => setFrom(e.target.value === '' ? '' : Number(e.target.value))}
            >
              <NativeSelectOption value="">직전 버전</NativeSelectOption>
              {all
                .filter((v) => v.version < version)
                .map((v) => (
                  <NativeSelectOption key={v.id} value={v.version}>
                    v{v.version}
                  </NativeSelectOption>
                ))}
            </NativeSelect>
          </div>
        }
      >
        {diff.error ? (
          <ErrorNotice error={diff.error} />
        ) : !diff.data ? (
          <Loading />
        ) : (
          <>
            <p className="mb-3 text-sm text-muted-foreground">
              {diff.data.from
                ? `v${diff.data.from} → v${diff.data.to}`
                : `처음 버전 (v${diff.data.to})`}
            </p>
            <NameDiff diff={diff.data} />
          </>
        )}
      </Card>
      {d && (
        <>
          <Card title="Tool" flush>
            <DataTable
              label="이 버전의 Tool"
              columns={toolColumns}
              rows={d.snapshot.tools}
              rowKey={(t) => t.name}
              empty="Tool 이 없어요"
            />
          </Card>
          {d.snapshot.skills.length > 0 && (
            <Card title="Skill" flush>
              <DataTable
                label="이 버전의 Skill"
                columns={[
                  {
                    key: 'name',
                    header: 'Skill',
                    render: (s: SnapshotSkill) => (
                      <Link
                        to={`/skills/${s.skillId}?version=${s.versionId}`}
                        className="text-primary hover:underline"
                      >
                        <Mono>{s.name}</Mono>
                      </Link>
                    ),
                  },
                  { key: 'v', header: '버전', render: (s: SnapshotSkill) => s.version },
                  {
                    key: 'tools',
                    header: 'allowed-tools',
                    render: (s: SnapshotSkill) =>
                      s.allowedTools.length ? (
                        <span className="inline-flex flex-wrap gap-1">
                          {s.allowedTools.map((t) => (
                            <Mono key={t}>{t}</Mono>
                          ))}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">없음</span>
                      ),
                  },
                ]}
                rows={d.snapshot.skills}
                rowKey={(s) => s.versionId}
              />
            </Card>
          )}
        </>
      )}
    </div>
  );
}

type NameDiffKind = 'add' | 'chg' | 'del';
const NAME_DIFF_TEXT: Record<NameDiffKind, string> = {
  add: 'text-emerald-700 dark:text-emerald-400',
  chg: 'text-amber-700 dark:text-amber-400',
  del: 'text-red-700 dark:text-red-400',
};
export const NAME_DIFF_BORDER: Record<NameDiffKind, string> = {
  add: 'border-t-emerald-600 dark:border-t-emerald-500',
  chg: 'border-t-amber-600 dark:border-t-amber-500',
  del: 'border-t-red-600 dark:border-t-red-500',
};

export function NameDiff({ diff }: { diff: RegistryDiff }) {
  const groups: [string, string[], NameDiffKind][] = [
    ['추가', diff.added, 'add'],
    ['변경', diff.changed, 'chg'],
    ['삭제', diff.removed, 'del'],
  ];
  if (!diff.added.length && !diff.changed.length && !diff.removed.length)
    return <p className="text-sm text-muted-foreground">차이 없음</p>;
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {groups.map(([label, names, kind]) => (
        <div
          key={label}
          className={cn(
            'min-w-0 rounded-lg border border-t-[3px] px-3 py-2.5',
            NAME_DIFF_BORDER[kind],
          )}
        >
          <p className="mb-1.5 text-sm font-semibold">
            {label}{' '}
            <span className="font-normal text-muted-foreground tabular-nums">{names.length}</span>
          </p>
          {names.length ? (
            <ul className="flex flex-col items-start gap-1">
              {names.map((n) => (
                <li key={n}>
                  <Mono>{n}</Mono>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">—</p>
          )}
        </div>
      ))}
    </div>
  );
}

/* ───────────── C-04 상세 ───────────── */

export function McpDetailPage() {
  const { id = '' } = useParams();
  const api = useApi();
  const { can } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const isAdmin = can('admin');

  const server = useQuery(() => api.get<McpServerView>(`/v1/admin/mcp-servers/${id}`), [id]);
  const tools = useQuery(() => api.get<McpToolView[]>(`/v1/admin/mcp-servers/${id}/tools`), [id]);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<'disable' | 'delete' | null>(null);
  const [policyTool, setPolicyTool] = useState<McpToolView | null>(null);

  const reloadAll = async () => {
    await Promise.all([server.reload(), tools.reload()]);
  };

  const test = useAction(async () => {
    const result = await api.post<ConnectionTestResult>(`/v1/admin/mcp-servers/${id}/test`);
    setTestResult(result);
    if (result.handshake === 'ok') void server.reload();
    return result;
  });
  const discover = useAction(async () => {
    const result = await api.post<DiscoverResult>(`/v1/admin/mcp-servers/${id}/discover`);
    await reloadAll();
    const c = result.changes;
    if (c && c.added + c.changed + c.removed > 0)
      toast(
        `변경 감지: 새 Tool ${c.added} · 변경 ${c.changed} · 삭제 ${c.removed} — 검토해 주세요`,
        'warning',
      );
    else if (c) toast('바뀐 Tool 이 없어요');
    else toast(`Tool ${result.tools.length}개를 찾았어요 — 등록을 이어서 하세요`);
    return result;
  });
  const disable = useAction(async () => {
    await api.post(`/v1/admin/mcp-servers/${id}/disable`);
    setConfirm(null);
    toast('서버를 비활성화했어요 · 이 서버의 Tool 은 다음 호출부터 거부돼요');
    await reloadAll();
  });
  const remove = useAction(async () => {
    await api.delete(`/v1/admin/mcp-servers/${id}`);
    toast('서버를 삭제했어요');
    navigate('/mcp', { replace: true });
  });

  if (server.error && !server.data)
    return (
      <>
        <PageHeader title="MCP 서버" back={{ to: '/mcp', label: 'MCP 서버' }} />
        <ErrorNotice error={server.error} onRetry={() => void server.reload()} />
      </>
    );
  if (!server.data) return <Loading />;
  const s = server.data;
  const registered = s.status === 'connected' || s.status === 'error';
  const unfinished =
    s.status === 'draft' || s.status === 'pending_review' || s.status === 'disabled';

  return (
    <>
      <PageHeader
        back={{ to: '/mcp', label: 'MCP 서버' }}
        title={<span className="font-mono">{s.name}</span>}
        meta={
          <>
            <ServerStatusBadge status={s.status} />
            <Badge tone={TRUST[s.trust].tone}>{TRUST[s.trust].label}</Badge>
            <span>Streamable HTTP</span>
            {s.protocolVersion && <Mono>{s.protocolVersion}</Mono>}
            <span>
              마지막 탐색 <Time iso={s.lastSyncedAt} />
            </span>
          </>
        }
        description={s.description ?? undefined}
        actions={
          isAdmin ? (
            <>
              <Button variant="outline" loading={test.pending} onClick={() => void test.run()}>
                연결 테스트
              </Button>
              {registered && (
                <Button
                  variant="outline"
                  loading={discover.pending}
                  onClick={() => void discover.run()}
                >
                  다시 탐색
                </Button>
              )}
              {s.status !== 'disabled' && (
                <Button variant="destructive" onClick={() => setConfirm('disable')}>
                  비활성화
                </Button>
              )}
              <Button variant="destructive" onClick={() => setConfirm('delete')}>
                삭제
              </Button>
            </>
          ) : undefined
        }
      />

      {s.status === 'error' && s.statusReason && (
        <Notice tone="error">
          <span>
            마지막 확인에서 연결하지 못했어요 — {s.statusReason}. 복구되면 주기 재탐색이 다시
            연결됨으로 바꿔요.
          </span>
        </Notice>
      )}
      {unfinished && (
        <Notice tone="warn">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="min-w-0 flex-1">
              {s.statusReason && s.status !== 'disabled' ? `${s.statusReason}. ` : ''}
              {s.status === 'disabled'
                ? '비활성화된 서버입니다. 다시 쓰려면 연결 테스트 · Tool 탐색 · 등록을 다시 거쳐야 해요.'
                : '등록을 마치지 않은 서버입니다. 등록 전에는 이 서버의 Tool 을 쓸 수 없어요.'}
            </span>
            {isAdmin && (
              <Button asChild size="sm">
                <Link to={`/mcp/new?server=${s.id}`}>
                  {s.status === 'disabled' ? '다시 등록' : '등록 이어서 하기'}
                  <ArrowRightIcon aria-hidden="true" />
                </Link>
              </Button>
            )}
          </div>
        </Notice>
      )}
      <ErrorNotice error={test.error ?? discover.error ?? null} />

      {testResult && (
        <Card
          title="연결 테스트 결과"
          actions={
            <Button size="sm" variant="ghost" onClick={() => setTestResult(null)}>
              닫기
            </Button>
          }
        >
          <TestResultView result={testResult} />
        </Card>
      )}

      {s.tools.pendingChanges > 0 && (
        <PendingChangesCard
          serverId={s.id}
          tools={tools.data ?? []}
          onApproved={() => void reloadAll()}
        />
      )}

      <div className="grid items-start gap-4 min-[1100px]:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0">
          <Card
            title="Tool"
            description={`사용 ${s.tools.enabled} / 전체 ${s.tools.total} · 등급과 승인 정책은 Registry 새 버전으로 반영돼요`}
            flush
          >
            <ToolTable
              tools={tools.data ?? []}
              loading={tools.loading && !tools.data}
              error={tools.error}
              onOpen={setPolicyTool}
            />
          </Card>
        </div>
        <div className="min-w-0">
          <Card
            title="연결 정보"
            actions={
              isAdmin ? (
                <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                  수정
                </Button>
              ) : undefined
            }
          >
            <KeyValue
              items={[
                ['엔드포인트', <Mono key="e">{s.endpointUrl ?? '—'}</Mono>],
                [
                  '인증',
                  s.authType === 'api_key' ? (
                    <span key="a">
                      API Key{' '}
                      {s.secretRef ? (
                        <Badge tone="success">저장됨</Badge>
                      ) : (
                        <Badge tone="danger">없음</Badge>
                      )}
                    </span>
                  ) : s.authType === 'oauth' ? (
                    'OAuth'
                  ) : (
                    '인증 없음'
                  ),
                ],
                [
                  '허용 호스트',
                  s.allowedHosts.length ? (
                    <span key="h" className="inline-flex flex-wrap gap-1">
                      {s.allowedHosts.map((h) => (
                        <Mono key={h}>{h}</Mono>
                      ))}
                    </span>
                  ) : (
                    <span key="h" className="text-muted-foreground">
                      엔드포인트 호스트만
                    </span>
                  ),
                ],
                [
                  '사설 네트워크',
                  s.allowPrivateNetwork ? (
                    <Badge key="p" tone="warning">
                      허용 (Owner)
                    </Badge>
                  ) : (
                    '차단'
                  ),
                ],
                ['만든 시각', <Time key="c" iso={s.createdAt} absolute />],
              ]}
            />
          </Card>
          <Card title="상태 · 성능" description="최근 24시간 이 서버 Tool 호출 기준">
            <dl className="mb-3 grid grid-cols-3 gap-2">
              {(
                [
                  ['응답 p95', formatMs(s.health.p95Ms)],
                  ['오류율', s.health.errorRate == null ? '—' : formatPercent(s.health.errorRate)],
                  ['검토 대기 변경', s.tools.pendingChanges],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="min-w-0 rounded-md bg-muted/60 px-2.5 py-2">
                  <dt className="truncate text-xs text-muted-foreground">{label}</dt>
                  <dd className="mt-0.5 text-lg font-semibold tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
            <p className="mb-2 text-xs text-muted-foreground">
              주기 재탐색(mcp-sync)이 서버 상태 · Tool 변경을 확인합니다. 변경은 승인 전까지 이전
              정의로 실행돼요.
            </p>
            <Button asChild variant="link" size="sm" className="h-auto px-0">
              <Link to="/mcp?tab=registry">
                Tool Registry 버전 보기
                <ArrowRightIcon aria-hidden="true" />
              </Link>
            </Button>
          </Card>
        </div>
      </div>

      {editing && (
        <ServerEditModal
          server={s}
          onClose={() => setEditing(false)}
          onSaved={(updated) => {
            setEditing(false);
            server.setData(updated);
            void tools.reload();
            toast(
              updated.status === 'pending_review' && s.status !== 'pending_review'
                ? '저장했어요 · 연결 정보가 바뀌어 다시 검토(탐색 → 등록)해야 해요'
                : '저장했어요',
            );
          }}
        />
      )}
      {policyTool && (
        <ToolPolicyModal
          tool={policyTool}
          registered={registered}
          onClose={() => setPolicyTool(null)}
          onSaved={(msg) => {
            setPolicyTool(null);
            toast(msg);
            void reloadAll();
          }}
        />
      )}
      <ConfirmModal
        open={confirm === 'disable'}
        title={`${s.name} 비활성화`}
        body={
          <p className="mb-3 text-muted-foreground">
            이 서버의 Tool 이 새 Registry 버전에서 빠지고, 실행 중인 작업도 다음 호출부터 거부돼요.
            다시 쓰려면 탐색 · 등록을 다시 해야 합니다.
          </p>
        }
        confirmLabel="비활성화"
        danger
        pending={disable.pending}
        error={disable.error}
        onConfirm={() => void disable.run()}
        onClose={() => setConfirm(null)}
      />
      <ConfirmModal
        open={confirm === 'delete'}
        title={`${s.name} 삭제`}
        body={
          <p className="mb-3 text-muted-foreground">
            서버와 저장된 API Key 를 지우고, Agent 허용 목록에서도 빠집니다. 되돌릴 수 없어요. 같은
            이름으로 다시 연결할 수 있습니다.
          </p>
        }
        confirmLabel="삭제"
        danger
        pending={remove.pending}
        error={remove.error}
        onConfirm={() => void remove.run()}
        onClose={() => setConfirm(null)}
      />
    </>
  );
}

function ToolTable({
  tools,
  loading,
  error,
  onOpen,
}: {
  tools: McpToolView[];
  loading: boolean;
  error: Error | null;
  onOpen: (t: McpToolView) => void;
}) {
  // 새로 감지(아직 승인 전)된 Tool 은 변경 검토 카드에서 보여 준다
  const rows = tools.filter((t) => t.pendingChange?.kind !== 'added');
  const columns: Column<McpToolView>[] = [
    {
      key: 'name',
      header: 'Tool',
      render: (t) => (
        <div className="flex min-w-48 flex-col items-start gap-1 whitespace-normal">
          <Mono>{t.registryName}</Mono>
          {t.description && (
            <p className="line-clamp-2 text-xs text-muted-foreground">
              {t.title ? `${t.title} — ` : ''}
              {t.description}
            </p>
          )}
        </div>
      ),
    },
    { key: 'level', header: '등급', render: (t) => <LevelBadge level={t.permissionLevel} /> },
    {
      key: 'mode',
      header: '승인 정책',
      render: (t) => (
        <span
          className={cn('whitespace-nowrap', !t.approvalModeOverride && 'text-muted-foreground')}
        >
          {approvalLabel(t.approvalModeOverride)}
        </span>
      ),
    },
    {
      key: 'checks',
      header: '검사',
      render: (t) => <CheckBadges schema={t.schema} security={t.security} />,
    },
    {
      key: 'state',
      header: '사용',
      render: (t) =>
        t.state !== 'active' ? (
          <Badge tone={TOOL_STATE[t.state].tone}>{TOOL_STATE[t.state].label}</Badge>
        ) : t.enabled ? (
          <Badge tone="success">사용</Badge>
        ) : (
          <Badge>꺼짐</Badge>
        ),
    },
    {
      key: 'open',
      header: <span className="sr-only">설정</span>,
      width: '32px',
      render: () => (
        <ChevronRightIcon className="size-4 text-muted-foreground" aria-hidden="true" />
      ),
    },
  ];
  return (
    <>
      <ErrorNotice error={error} />
      <DataTable
        label="이 서버의 Tool"
        columns={columns}
        rows={rows}
        rowKey={(t) => t.id}
        loading={loading}
        onRowClick={onOpen}
        empty="탐색된 Tool 이 없어요"
      />
    </>
  );
}

export function TestResultView({ result }: { result: ConnectionTestResult }) {
  const ok = result.handshake === 'ok';
  const Icon = ok ? CircleCheckIcon : CircleAlertIcon;
  return (
    <div className="flex flex-col gap-3">
      <div
        className={cn(
          'flex items-start gap-3 rounded-lg p-3',
          TONE_CLASS[ok ? 'success' : 'danger'],
        )}
        role="status"
      >
        <Icon className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
        <div className="min-w-0">
          <p className="font-semibold">{ok ? '연결에 성공했어요' : '연결하지 못했어요'}</p>
          {result.error && <p className="mt-0.5 text-sm break-words">{result.error}</p>}
        </div>
      </div>
      <KeyValue
        items={[
          [
            '네트워크 · SSRF',
            result.ssrf.allowed ? (
              <span key="s">
                <Badge tone="success">허용</Badge>{' '}
                {result.ssrf.resolvedIps.length > 0 && (
                  <span className="inline-flex items-center gap-1 text-muted-foreground">
                    <ArrowRightIcon className="size-3.5" aria-hidden="true" />
                    {result.ssrf.resolvedIps.join(', ')}
                  </span>
                )}
              </span>
            ) : (
              <span key="s">
                <Badge tone="danger">차단</Badge>{' '}
                {result.ssrf.blockedReason ? BLOCKED_REASON[result.ssrf.blockedReason] : ''}
                {result.ssrf.resolvedIps.length > 0 && (
                  <span className="text-muted-foreground">
                    {' '}
                    ({result.ssrf.resolvedIps.join(', ')})
                  </span>
                )}
              </span>
            ),
          ],
          [
            '프로토콜',
            result.protocolVersion ? (
              <span key="p">
                <Mono>{result.protocolVersion}</Mono>{' '}
                <span className="text-muted-foreground">
                  {result.era === 'modern'
                    ? '요청 단위 프로토콜 (server/discover)'
                    : result.era === 'legacy'
                      ? '2025 계열 — initialize 핸드셰이크로 호환'
                      : ''}
                </span>
              </span>
            ) : (
              '—'
            ),
          ],
          ['응답 시간', formatMs(result.latencyMs)],
          [
            '서버',
            result.server ? (
              `${result.server.name} ${result.server.version}`
            ) : (
              <span key="v" className="text-muted-foreground">
                —
              </span>
            ),
          ],
        ]}
      />
    </div>
  );
}

function PendingChangesCard({
  serverId,
  tools,
  onApproved,
}: {
  serverId: string;
  tools: McpToolView[];
  onApproved: () => void;
}) {
  const api = useApi();
  const { can } = useAuth();
  const toast = useToast();
  const changes = useMemo(() => tools.filter((t) => t.pendingChange), [tools]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => setSelected(new Set(changes.map((c) => c.name))), [changes]);
  const approve = useAction(async () => {
    const res = await api.post<{ approved: string[]; registry: PublishedVersion | null }>(
      `/v1/admin/mcp-servers/${serverId}/changes/approve`,
      { toolNames: [...selected] },
    );
    toast(`변경 ${res.approved.length}건 승인 · ${registryMessage(res.registry)}`);
    onApproved();
  });
  if (!changes.length) return null;
  const toggle = (name: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <Card
      className="border-amber-400 dark:border-amber-700"
      title={`Tool 변경 검토 · ${changes.length}건`}
      description="서버가 알려 준 Tool 정의가 바뀌었어요. 승인하기 전까지는 이전 정의로 실행하고, 새 Tool 은 쓰이지 않아요."
      actions={
        can('admin') ? (
          <Button
            loading={approve.pending}
            disabled={selected.size === 0}
            onClick={() => void approve.run()}
          >
            선택한 {selected.size}건 승인
          </Button>
        ) : undefined
      }
      flush
    >
      <ApiErrorNotice error={approve.error} />
      <ul className="divide-y">
        {changes.map((t) => {
          const c = t.pendingChange!;
          const kind = CHANGE_KIND[c.kind];
          const expanded = open === t.id;
          return (
            <li key={t.id}>
              <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                {can('admin') && (
                  <Checkbox
                    aria-label={`${t.name} 변경 선택`}
                    checked={selected.has(t.name)}
                    onCheckedChange={() => toggle(t.name)}
                  />
                )}
                <Badge tone={kind.tone}>{kind.label}</Badge>
                <Mono>{t.registryName}</Mono>
                {c.next && <CheckBadges schema={c.next.schema} security={c.next.security} />}
                <span className="ml-auto text-xs text-muted-foreground">
                  감지 <Time iso={c.detectedAt} />
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : t.id)}
                >
                  {expanded ? '접기' : '자세히'}
                  <ChevronDownIcon
                    className={cn('transition-transform', expanded && 'rotate-180')}
                    aria-hidden="true"
                  />
                </Button>
              </div>
              {expanded && (
                <div className="flex flex-col gap-2.5 pr-4 pb-4 pl-4 text-sm sm:pl-10 [&>[data-slot=alert]]:mb-0">
                  {c.kind === 'removed' && (
                    <p>
                      서버가 더 이상 이 Tool 을 알려 주지 않아요. 승인하면 Registry 에서 빠집니다.
                    </p>
                  )}
                  {c.kind === 'added' && c.next && (
                    <>
                      <p>
                        새로 감지된 Tool 이에요. 승인해도 <strong>꺼진 채</strong> 추가되니, 확인 후
                        Tool 목록에서 켜세요. 제안 등급:{' '}
                        <LevelBadge level={c.next.suggestedLevel} />
                      </p>
                      {c.next.description && (
                        <p className="text-muted-foreground">{c.next.description}</p>
                      )}
                      <CheckIssues schema={c.next.schema} security={c.next.security} />
                      <Json value={c.next.inputSchema} />
                    </>
                  )}
                  {c.kind === 'changed' && c.next && (
                    <>
                      <CheckIssues schema={c.next.schema} security={c.next.security} />
                      {c.next.suggestedLevel !== t.permissionLevel && (
                        <Notice tone="warn">
                          <span>
                            새 정의의 제안 등급은 <LevelBadge level={c.next.suggestedLevel} />{' '}
                            입니다 (현재 <LevelBadge level={t.permissionLevel} />
                            ). 승인 후 Tool 정책에서 등급을 확인하세요.
                          </span>
                        </Notice>
                      )}
                      <DiffView
                        label="설명"
                        before={t.description ?? ''}
                        after={c.next.description ?? ''}
                      />
                      <DiffView
                        label="입력 스키마"
                        before={pretty(t.inputSchema)}
                        after={pretty(c.next.inputSchema)}
                      />
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function ToolPolicyModal({
  tool,
  registered,
  onClose,
  onSaved,
}: {
  tool: McpToolView;
  registered: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const api = useApi();
  const { can } = useAuth();
  const editable = can('admin');
  const [level, setLevel] = useState<PermissionLevel>(tool.permissionLevel);
  const [mode, setMode] = useState<ApprovalMode | ''>(tool.approvalModeOverride ?? '');
  const [enabled, setEnabled] = useState(tool.enabled);
  const blocked =
    tool.schema.result === 'error' || tool.security.result === 'failed' || tool.state === 'removed';
  const body: Record<string, unknown> = {};
  if (level !== tool.permissionLevel) body.permissionLevel = level;
  if ((mode || null) !== tool.approvalModeOverride) body.approvalModeOverride = mode || null;
  if (enabled !== tool.enabled) body.enabled = enabled;
  const dirty = Object.keys(body).length > 0;
  const save = useAction(async () => {
    const res = await api.put<{ tool: McpToolView; registry: PublishedVersion | null }>(
      `/v1/admin/mcp-tools/${tool.id}/policy`,
      body,
    );
    onSaved(res.registry ? `저장했어요 · ${registryMessage(res.registry)}` : '저장했어요');
  });

  return (
    <Modal
      open
      wide
      title={<Mono>{tool.registryName}</Mono>}
      onClose={onClose}
      footer={
        editable ? (
          <>
            <Button variant="outline" onClick={onClose}>
              취소
            </Button>
            <Button loading={save.pending} disabled={!dirty} onClick={() => void save.run()}>
              저장
            </Button>
          </>
        ) : (
          <Button variant="outline" onClick={onClose}>
            닫기
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-3 [&>[data-slot=alert]]:mb-0">
        {tool.description && <p>{tool.description}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <CheckBadges schema={tool.schema} security={tool.security} />
          {tool.state !== 'active' && (
            <Badge tone={TOOL_STATE[tool.state].tone}>{TOOL_STATE[tool.state].label}</Badge>
          )}
        </div>
        <CheckIssues schema={tool.schema} security={tool.security} />
        <div className="grid gap-4 sm:grid-cols-2 [&>*]:mb-0">
          <Field label="권한 등급" hint="등급별 기본 승인 정책은 승인 · 권한 화면에서 정합니다">
            <NativeSelect
              value={level}
              disabled={!editable}
              onChange={(e) => setLevel(e.target.value as PermissionLevel)}
            >
              {LEVELS.map((l) => (
                <NativeSelectOption key={l} value={l}>
                  {LEVEL[l]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field label="승인 정책" hint="비워 두면 등급 기본 정책을 따릅니다">
            <NativeSelect
              value={mode}
              disabled={!editable}
              onChange={(e) => setMode(e.target.value as ApprovalMode | '')}
            >
              <NativeSelectOption value="">등급 기본값</NativeSelectOption>
              {APPROVAL_MODES.map((m) => (
                <NativeSelectOption key={m.value} value={m.value}>
                  {m.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
        </div>
        <Toggle
          checked={enabled}
          disabled={!editable || (blocked && !tool.enabled)}
          onChange={setEnabled}
          label={
            blocked && !tool.enabled
              ? '사용 — 스키마 오류 · 보안 검사 실패 · 삭제된 Tool 은 켤 수 없어요'
              : '이 Tool 사용'
          }
        />
        {registered && dirty && (
          <Notice tone="info">
            <span>저장하면 새 Tool Registry 버전이 만들어지고, 새 작업부터 적용돼요.</span>
          </Notice>
        )}
        <ApiErrorNotice error={save.error} />
        <div>
          <p className="mb-1.5 text-sm font-semibold text-muted-foreground">입력 스키마</p>
          <Json value={tool.inputSchema} />
        </div>
      </div>
    </Modal>
  );
}

function ServerEditModal({
  server,
  onClose,
  onSaved,
}: {
  server: McpServerView;
  onClose: () => void;
  onSaved: (server: McpServerView) => void;
}) {
  const api = useApi();
  const { can } = useAuth();
  const isOwner = can('owner');
  const [description, setDescription] = useState(server.description ?? '');
  const [endpointUrl, setEndpointUrl] = useState(server.endpointUrl ?? '');
  const [authType, setAuthType] = useState<'none' | 'api_key'>(
    server.authType === 'api_key' ? 'api_key' : 'none',
  );
  const [secret, setSecret] = useState('');
  const [hosts, setHosts] = useState(server.allowedHosts.join('\n'));
  const [allowPrivate, setAllowPrivate] = useState(server.allowPrivateNetwork);

  const hostList = parseHosts(hosts);
  const body: Record<string, unknown> = {};
  if (description.trim() !== (server.description ?? ''))
    body.description = description.trim() || null;
  if (endpointUrl.trim() !== (server.endpointUrl ?? '')) body.endpointUrl = endpointUrl.trim();
  if (authType !== server.authType) body.authType = authType;
  if (secret) body.secret = secret;
  if (hostList.join() !== server.allowedHosts.join()) body.allowedHosts = hostList;
  if (allowPrivate !== server.allowPrivateNetwork) body.allowPrivateNetwork = allowPrivate;
  const connectionChanged = Object.keys(body).some((k) => k !== 'description');
  const registered = server.status === 'connected' || server.status === 'error';

  const save = useAction(async () =>
    onSaved(await api.patch<McpServerView>(`/v1/admin/mcp-servers/${server.id}`, body)),
  );

  return (
    <Modal
      open
      title="연결 정보 수정"
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            취소
          </Button>
          <Button
            loading={save.pending}
            disabled={Object.keys(body).length === 0}
            onClick={() => void save.run()}
          >
            저장
          </Button>
        </>
      }
    >
      <Field label="설명" error={issueFor(save.error, 'description')}>
        <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <Field label="엔드포인트 URL" required error={issueFor(save.error, 'endpointUrl')}>
        <Input
          className="font-mono"
          value={endpointUrl}
          onChange={(e) => setEndpointUrl(e.target.value)}
        />
      </Field>
      <Field label="인증">
        <NativeSelect
          value={authType}
          onChange={(e) => setAuthType(e.target.value as 'none' | 'api_key')}
        >
          <NativeSelectOption value="none">인증 없음</NativeSelectOption>
          <NativeSelectOption value="api_key">API Key</NativeSelectOption>
        </NativeSelect>
      </Field>
      {authType === 'api_key' && (
        <Field
          label="API Key"
          hint={
            server.secretRef
              ? '저장된 키가 있어요. 바꿀 때만 입력하세요 — 저장한 키는 다시 볼 수 없어요.'
              : 'Secret 저장소에 저장되고 다시 볼 수 없어요.'
          }
          error={issueFor(save.error, 'secret')}
        >
          <Input
            type="password"
            autoComplete="new-password"
            value={secret}
            placeholder={server.secretRef ? '••••••••  (바꿀 때만)' : 'API Key'}
            onChange={(e) => setSecret(e.target.value)}
          />
        </Field>
      )}
      <Field
        label="추가 허용 호스트"
        hint="한 줄에 하나 (예: api.example.com, *.example.com). 엔드포인트 호스트는 자동으로 허용돼요."
        error={issueFor(save.error, 'allowedHosts')}
      >
        <Textarea
          className="font-mono text-[13px]"
          rows={3}
          value={hosts}
          onChange={(e) => setHosts(e.target.value)}
        />
      </Field>
      <Toggle
        checked={allowPrivate}
        disabled={!isOwner}
        onChange={setAllowPrivate}
        label={
          isOwner
            ? '사설 네트워크(사내망 · localhost) 허용'
            : '사설 네트워크 허용 — Owner 만 바꿀 수 있어요'
        }
      />
      {registered && connectionChanged && (
        <Notice tone="warn">
          <span>
            연결 정보(URL · 인증 · 허용 호스트 · 사설망)를 바꾸면 서버가 <strong>검토 대기</strong>
            가 되고, 다시 탐색 · 등록할 때까지 이 서버의 Tool 은 쓰이지 않아요.
          </span>
        </Notice>
      )}
      <ApiErrorNotice
        error={save.error}
        skipPaths={['description', 'endpointUrl', 'secret', 'allowedHosts']}
      />
    </Modal>
  );
}

export function parseHosts(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((h) => h.trim())
    .filter(Boolean);
}
