/**
 * C-06 Skill 관리 — 목록 · zip 업로드 · 버전 · SKILL.md 미리보기 · 파일 · 공급망 검증 · 비교 · 활성화.
 * API: docs/api-spec.md §4.6 — src/skills/admin/skills-admin.{controller,service}.ts
 * 조회는 Viewer, 업로드 · 활성화 · 비활성화는 Admin.
 */
import {
  CircleCheckIcon,
  CircleMinusIcon,
  CircleXIcon,
  type LucideIcon,
  PlusIcon,
  TriangleAlertIcon,
  UploadIcon,
} from 'lucide-react';
import { type DragEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { formatBytes } from '../../../shared/format';
import { Markdown } from '../../../shared/markdown';
import { ApiError } from '../api';
import { useApi, useAuth } from '../auth';
import {
  Badge,
  Card,
  CodeBlock,
  type Column,
  ConfirmModal,
  DataTable,
  Empty,
  ErrorNotice,
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
  Toolbar,
  useAction,
  useQuery,
  useToast,
} from '../ui';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import {
  DiffView,
  type FieldIssue,
  FILTER_ITEM,
  issuesOf,
  LIST_ITEM,
  NAME_DIFF_BORDER,
  type PublishedVersion,
  registryMessage,
} from './Mcp';

/* ───────────── 타입 ───────────── */

type SkillStatus = 'active' | 'pending_review' | 'inactive' | 'verification_failed';
type VerificationStatus = 'pending' | 'passed' | 'failed';
type FileKind = 'skill' | 'doc' | 'template' | 'script' | 'asset';
type CheckName =
  'source' | 'hash' | 'signature' | 'script_static' | 'instruction_risk' | 'tool_scope';
type CheckStatus = 'passed' | 'warning' | 'failed' | 'skipped';
type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'purple';

interface SkillVersionSummary {
  id: string;
  version: string;
  description: string;
  allowedTools: string[];
  contentHash: string;
  verificationStatus: VerificationStatus;
  active: boolean;
  createdAt: string;
}

interface SkillView {
  id: string;
  name: string;
  source: 'upload' | 'git' | 'marketplace';
  status: SkillStatus;
  activeVersion: SkillVersionSummary | null;
  latestVersion: SkillVersionSummary | null;
  createdAt: string;
  updatedAt: string;
}

interface StoredFile {
  path: string;
  size: number;
  sha256: string;
  kind: FileKind;
}

interface VerificationCheck {
  check: CheckName;
  status: CheckStatus;
  detail: string;
  findings?: string[];
}

interface SkillVersionDetail extends SkillVersionSummary {
  skillId: string;
  frontmatter: Record<string, unknown> | null;
  files: StoredFile[];
  verification: VerificationCheck[];
}

interface UploadResult {
  skill: SkillView;
  version: SkillVersionDetail;
  duplicate: boolean;
  warnings: string[];
}

interface FileContent {
  path: string;
  kind: FileKind;
  size: number;
  sha256: string;
  text: string;
}

interface VersionDiff {
  from: { id: string; version: string } | null;
  to: { id: string; version: string };
  files: { added: string[]; removed: string[]; changed: string[] };
  metadata: {
    description: { from: string | null; to: string } | null;
    allowedTools: { from: string[]; to: string[] } | null;
  };
}

/* ───────────── 라벨 ───────────── */

const SKILL_STATUS: Record<SkillStatus, { label: string; tone: Tone }> = {
  active: { label: '활성', tone: 'success' },
  pending_review: { label: '검토 대기', tone: 'warning' },
  inactive: { label: '비활성', tone: 'neutral' },
  verification_failed: { label: '검증 실패', tone: 'danger' },
};

const VERIFICATION: Record<VerificationStatus, { label: string; tone: Tone }> = {
  pending: { label: '검증 중', tone: 'neutral' },
  passed: { label: '검증 통과', tone: 'success' },
  failed: { label: '검증 실패', tone: 'danger' },
};

const VERIFICATION_TEXT: Record<VerificationStatus, string> = {
  pending: '',
  passed: 'text-emerald-700 dark:text-emerald-400',
  failed: 'text-red-700 dark:text-red-400',
};

const SOURCE: Record<SkillView['source'], string> = {
  upload: '콘솔 업로드',
  git: 'Git',
  marketplace: '마켓플레이스',
};

const CHECK_LABEL: Record<CheckName, { title: string; hint: string }> = {
  source: { title: '출처', hint: '누가 어디서 올렸는지' },
  hash: { title: '내용 해시', hint: '번들 전체 sha256 — 버전 고정 · 변조 확인' },
  signature: { title: '서명', hint: 'Git · 마켓플레이스 출처의 서명' },
  script_static: { title: '스크립트 정적 검사', hint: '원격 코드 실행 · 난독화 · 자격 증명 접근' },
  instruction_risk: { title: '숨은 지시문', hint: '프롬프트 주입 · 보이지 않는 문자 · 민감정보' },
  tool_scope: { title: 'Tool 범위', hint: 'allowed-tools 가 Registry 에 있고 등급이 적절한지' },
};

const CHECK_STATUS: Record<CheckStatus, { label: string; icon: LucideIcon; tone: Tone }> = {
  passed: { label: '통과', icon: CircleCheckIcon, tone: 'success' },
  warning: { label: '경고', icon: TriangleAlertIcon, tone: 'warning' },
  failed: { label: '실패', icon: CircleXIcon, tone: 'danger' },
  skipped: { label: '해당 없음', icon: CircleMinusIcon, tone: 'neutral' },
};

const FILE_KIND: Record<FileKind, string> = {
  skill: 'SKILL.md',
  doc: '문서',
  template: '템플릿',
  script: '스크립트',
  asset: '파일',
};

const MAX_ZIP = 20 * 1024 * 1024;

/** 공용 Markdown 은 맨 태그만 내므로 글자 모양을 여기서 준다 (preflight 가 제목 크기 · 목록 기호를 지운다) */
const MARKDOWN = cn(
  'text-sm leading-relaxed break-words [&>*+*]:mt-2.5 [&>:first-child]:mt-0',
  '[&_:is(h1,h2,h3,h4)]:mt-4.5 [&_:is(h1,h2,h3,h4)]:leading-snug [&_:is(h1,h2,h3,h4)]:font-semibold',
  '[&_h1]:text-xl [&_h2]:text-[17px] [&_h3]:text-[15px]',
  '[&_ol]:list-decimal [&_ol]:pl-5.5 [&_ul]:list-disc [&_ul]:pl-5.5 [&_li+li]:mt-0.5',
  '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-px [&_code]:font-mono [&_code]:text-[12.5px]',
  '[&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:bg-muted [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0',
  '[&_blockquote]:border-l-[3px] [&_blockquote]:px-3 [&_blockquote]:py-1 [&_blockquote]:text-muted-foreground',
  '[&_hr]:border-t [&_div:has(>table)]:overflow-x-auto',
  '[&_table]:border-collapse [&_table]:text-[13px] [&_:is(td,th)]:border [&_:is(td,th)]:px-2.5 [&_:is(td,th)]:py-1.5 [&_:is(td,th)]:text-left [&_th]:bg-muted/60',
);

const VERIFY_ITEM: Record<CheckStatus, string> = {
  passed: '',
  skipped: '',
  warning: 'border-amber-300 bg-amber-50/50 dark:border-amber-900 dark:bg-amber-950/30',
  failed: 'border-red-300 bg-red-50/50 dark:border-red-900 dark:bg-red-950/30',
};

function SkillStatusBadge({ status }: { status: SkillStatus }) {
  const s = SKILL_STATUS[status] ?? { label: status, tone: 'neutral' as Tone };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

function VerificationBadge({ status }: { status: VerificationStatus }) {
  const v = VERIFICATION[status];
  return <Badge tone={v.tone}>{v.label}</Badge>;
}

/** SKILL.md 앞의 frontmatter(--- … ---)를 떼고 본문만 */
function stripFrontmatter(text: string): string {
  const normalized = text.replace(/^﻿/, '');
  if (!/^---\r?\n/.test(normalized)) return normalized;
  const end = normalized.search(/\r?\n---\s*(\r?\n|$)/);
  if (end < 0) return normalized;
  const after = normalized.slice(end).replace(/^\r?\n---\s*/, '');
  return after.replace(/^\r?\n/, '');
}

/* ───────────── 목록 ───────────── */

type Filter = 'all' | SkillStatus;

export function SkillsPage() {
  const api = useApi();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [uploading, setUploading] = useState(false);
  const skills = useQuery(() => api.get<SkillView[]>('/v1/admin/skills'), []);
  const all = skills.data ?? [];
  const rows = all.filter((s) => {
    const text = `${s.name} ${s.latestVersion?.description ?? ''}`.toLowerCase();
    if (q && !text.includes(q.toLowerCase())) return false;
    return filter === 'all' || s.status === filter;
  });
  const count = (st: SkillStatus) => all.filter((s) => s.status === st).length;

  const columns: Column<SkillView>[] = [
    {
      key: 'name',
      header: 'Skill',
      render: (s) => {
        const v = s.activeVersion ?? s.latestVersion;
        return (
          <div className="max-w-[460px] min-w-48 whitespace-normal">
            <div className="font-mono font-semibold">{s.name}</div>
            {v && (
              <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                {v.description}
              </div>
            )}
          </div>
        );
      },
    },
    { key: 'status', header: '상태', render: (s) => <SkillStatusBadge status={s.status} /> },
    {
      key: 'active',
      header: '활성 버전',
      render: (s) =>
        s.activeVersion ? (
          <Mono>{s.activeVersion.version}</Mono>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: 'latest',
      header: '최신 버전',
      render: (s) =>
        s.latestVersion ? (
          <span className="flex flex-wrap items-center gap-1">
            <Mono>{s.latestVersion.version}</Mono>
            {!s.latestVersion.active && s.activeVersion && (
              <Badge tone={s.latestVersion.verificationStatus === 'failed' ? 'danger' : 'warning'}>
                {s.latestVersion.verificationStatus === 'failed'
                  ? '새 버전 검증 실패'
                  : '새 버전 검토'}
              </Badge>
            )}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: 'verify',
      header: '검증',
      render: (s) =>
        s.latestVersion ? <VerificationBadge status={s.latestVersion.verificationStatus} /> : null,
    },
    {
      key: 'tools',
      header: 'allowed-tools',
      align: 'right',
      render: (s) => (
        <span className="tabular-nums">
          {(s.activeVersion ?? s.latestVersion)?.allowedTools.length ?? 0}
        </span>
      ),
    },
    { key: 'source', header: '출처', render: (s) => SOURCE[s.source] ?? s.source },
    { key: 'updated', header: '수정', render: (s) => <Time iso={s.updatedAt} /> },
  ];

  return (
    <>
      <PageHeader
        title="Skill"
        description="SKILL.md 기반 업무 절차를 올리고, 공급망 검증 · 버전 · 활성화를 관리합니다. 활성 버전만 새 작업에 쓰여요."
        actions={
          <RoleGate min="admin">
            <Button onClick={() => setUploading(true)}>
              <PlusIcon aria-hidden="true" />
              Skill 업로드
            </Button>
          </RoleGate>
        }
      />
      <Toolbar>
        <SearchInput label="Skill 검색" placeholder="이름 · 설명" value={q} onChange={setQ} />
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={1}
          className="flex-wrap"
          aria-label="상태 필터"
          value={filter}
          onValueChange={(v) => v && setFilter(v as Filter)}
        >
          {(
            [
              ['all', `전체 ${all.length}`],
              ['active', `활성 ${count('active')}`],
              ['pending_review', `검토 대기 ${count('pending_review')}`],
              ['verification_failed', `검증 실패 ${count('verification_failed')}`],
              ['inactive', `비활성 ${count('inactive')}`],
            ] as [Filter, string][]
          ).map(([id, label]) => (
            <ToggleGroupItem key={id} value={id} className={FILTER_ITEM}>
              {label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Toolbar>
      <ErrorNotice error={skills.error} onRetry={() => void skills.reload()} />
      <Card flush>
        <DataTable
          label="Skill 목록"
          columns={columns}
          rows={rows}
          rowKey={(s) => s.id}
          loading={skills.loading && !skills.data}
          onRowClick={(s) => navigate(`/skills/${s.id}`)}
          empty={
            all.length === 0 ? (
              <Empty title="등록된 Skill 이 없어요">
                <p>SKILL.md 와 참고 문서를 zip 으로 묶어 올리면 검증 후 활성화할 수 있어요.</p>
              </Empty>
            ) : (
              '조건에 맞는 Skill 이 없어요'
            )
          }
        />
      </Card>
      <UploadModal
        open={uploading}
        onClose={() => setUploading(false)}
        onDone={(r) => {
          setUploading(false);
          navigate(`/skills/${r.skill.id}?version=${r.version.id}`);
        }}
        onUploaded={() => void skills.reload()}
      />
    </>
  );
}

/* ───────────── 업로드 ───────────── */

function UploadModal({
  open,
  onClose,
  onDone,
  onUploaded,
}: {
  open: boolean;
  onClose: () => void;
  onDone: (r: UploadResult) => void;
  onUploaded?: (r: UploadResult) => void;
}) {
  const api = useApi();
  const [file, setFile] = useState<File | null>(null);
  const [drag, setDrag] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const upload = useAction(async (f: File) => {
    const form = new FormData();
    form.append('file', f, f.name);
    return api.upload<UploadResult>('/v1/admin/skills', form);
  });
  useEffect(() => {
    if (open) {
      setFile(null);
      setResult(null);
      upload.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const tooBig = file ? file.size > MAX_ZIP : false;
  const notZip = file ? !/\.zip$/i.test(file.name) : false;
  const pick = (f: File | undefined | null) => {
    if (!f) return;
    setFile(f);
    setResult(null);
    upload.reset();
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    pick(e.dataTransfer.files?.[0]);
  };
  const submit = async () => {
    if (!file) return;
    const r = await upload.run(file);
    if (r) {
      setResult(r);
      onUploaded?.(r);
    }
  };

  return (
    <Modal
      open={open}
      wide={Boolean(result)}
      title={result ? '업로드 결과' : 'Skill 업로드'}
      onClose={onClose}
      footer={
        result ? (
          <>
            <Button
              variant="outline"
              onClick={() => {
                setResult(null);
                setFile(null);
              }}
            >
              다른 파일 올리기
            </Button>
            <Button onClick={() => onDone(result)}>버전 상세 보기</Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={onClose}>
              취소
            </Button>
            <Button
              loading={upload.pending}
              disabled={!file || tooBig || notZip}
              onClick={() => void submit()}
            >
              올리고 검증하기
            </Button>
          </>
        )
      }
    >
      {result ? (
        <UploadSummary result={result} />
      ) : (
        <div className="flex flex-col gap-3 [&>[data-slot=alert]]:mb-0">
          <label
            className={cn(
              'flex min-h-40 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed p-5 text-center transition-colors hover:border-primary hover:bg-primary/5 has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50',
              drag && 'border-primary bg-primary/5',
            )}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={onDrop}
          >
            <Input
              ref={inputRef}
              type="file"
              accept=".zip,application/zip"
              className="sr-only"
              aria-label="Skill zip 파일"
              onChange={(e) => pick(e.target.files?.[0])}
            />
            <UploadIcon className="size-6 text-primary" aria-hidden="true" />
            {file ? (
              <span>
                <strong className="font-semibold">{file.name}</strong>{' '}
                <span className="text-muted-foreground">· {formatBytes(file.size)}</span>
              </span>
            ) : (
              <span className="font-semibold">zip 파일을 끌어 놓거나 눌러서 고르세요</span>
            )}
            <span className="text-xs text-muted-foreground">
              SKILL.md(최상위) + 참고 문서 · 템플릿 · 스크립트 — zip 20MB · 압축 해제 16MB · 파일
              512개 이하
            </span>
          </label>
          {tooBig && <Notice tone="error">20MB 를 넘는 zip 은 올릴 수 없어요.</Notice>}
          {notZip && <Notice tone="error">zip 파일만 올릴 수 있어요.</Notice>}
          <UploadError error={upload.error} />
          <p className="text-xs text-muted-foreground">
            올리면 SKILL.md 를 검사하고 출처 · 해시 · 서명 · 스크립트 · 숨은 지시문 · Tool 범위를
            검증한 뒤 <strong className="text-foreground">검토 대기</strong> 버전으로 저장해요.
            활성화는 결과를 확인한 뒤 따로 합니다.
          </p>
        </div>
      )}
    </Modal>
  );
}

function UploadError({ error }: { error: Error | null }) {
  if (!error) return null;
  const issues = issuesOf(error);
  const code = error instanceof ApiError ? error.code : '';
  const lineIssues = issues.filter((i) => i.line != null || i.path.startsWith('SKILL.md'));
  const other = issues.filter((i) => !lineIssues.includes(i));
  return (
    <Alert variant="destructive" className="flex items-start gap-2.5 border-destructive/30">
      <CircleXIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">
          {code === 'SKILL_PARSE_FAILED' && lineIssues.length
            ? 'SKILL.md 에 고칠 곳이 있어요'
            : error.message}
        </p>
        {lineIssues.length > 0 && (
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {lineIssues.map((i: FieldIssue, n) => (
              <li key={n} className="flex items-baseline gap-2.5">
                <span className="min-w-12 shrink-0 rounded bg-destructive/10 px-1.5 py-px text-center font-mono text-xs font-semibold">
                  {i.line != null ? `${i.line}행` : i.path}
                </span>
                <span>{i.message}</span>
              </li>
            ))}
          </ul>
        )}
        {other.length > 0 && (
          <ul className="mt-1.5 list-disc pl-5 text-sm">
            {other.map((i, n) => (
              <li key={n}>{i.message}</li>
            ))}
          </ul>
        )}
      </div>
    </Alert>
  );
}

function UploadSummary({ result }: { result: UploadResult }) {
  const v = result.version;
  return (
    <div className="flex flex-col gap-3 [&>[data-slot=alert]]:mb-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-base font-semibold">{result.skill.name}</span>
        <Mono>{v.version}</Mono>
        <VerificationBadge status={v.verificationStatus} />
        {v.active && <Badge tone="success">활성 버전</Badge>}
      </div>
      {result.duplicate ? (
        <Notice tone="info">
          같은 내용의 버전({v.version})이 이미 있어 새 버전을 만들지 않았어요.
        </Notice>
      ) : v.verificationStatus === 'failed' ? (
        <Notice tone="error">
          검증에 실패한 버전은 활성화할 수 없어요. 실패 항목을 고쳐 다시 올려 주세요.
        </Notice>
      ) : (
        <Notice tone="success">
          검증을 통과했어요. 버전 상세에서 내용을 확인하고 활성화하세요.
        </Notice>
      )}
      {result.warnings.length > 0 && (
        <Notice tone="warn">
          <div>
            <p className="font-semibold">SKILL.md 경고</p>
            <ul className="mt-1 list-disc pl-5 text-sm">
              {result.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        </Notice>
      )}
      <VerificationList checks={v.verification} />
    </div>
  );
}

/* ───────────── 상세 ───────────── */

type DetailTab = 'doc' | 'files' | 'checks' | 'diff';

export function SkillDetailPage() {
  const { id = '' } = useParams();
  const api = useApi();
  const { can } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<DetailTab>('doc');
  const [uploading, setUploading] = useState(false);
  const [confirm, setConfirm] = useState<'activate' | 'disable' | null>(null);

  const skill = useQuery(() => api.get<SkillView>(`/v1/admin/skills/${id}`), [id]);
  const versions = useQuery(
    () => api.get<SkillVersionSummary[]>(`/v1/admin/skills/${id}/versions`),
    [id],
  );
  const selectedId =
    params.get('version') ?? skill.data?.activeVersion?.id ?? versions.data?.[0]?.id ?? null;
  const version = useQuery(
    () => api.get<SkillVersionDetail>(`/v1/admin/skills/${id}/versions/${selectedId}`),
    [id, selectedId],
    { enabled: Boolean(selectedId) },
  );

  const reload = async () => {
    await Promise.all([skill.reload(), versions.reload(), version.reload()]);
  };
  const activate = useAction(async () => {
    const res = await api.post<{ skill: SkillView; registry: PublishedVersion }>(
      `/v1/admin/skills/${id}/versions/${selectedId}/activate`,
    );
    setConfirm(null);
    toast(`${version.data?.version} 활성화 · ${registryMessage(res.registry)}`);
    await reload();
  });
  const disable = useAction(async () => {
    const res = await api.post<{ skill: SkillView; registry: PublishedVersion }>(
      `/v1/admin/skills/${id}/disable`,
    );
    setConfirm(null);
    toast(`비활성화했어요 · ${registryMessage(res.registry)}`);
    await reload();
  });

  if (skill.error && !skill.data)
    return (
      <>
        <PageHeader title="Skill" back={{ to: '/skills', label: 'Skill' }} />
        <ErrorNotice error={skill.error} onRetry={() => void skill.reload()} />
      </>
    );
  if (!skill.data) return <Loading />;
  const s = skill.data;
  const v = version.data && version.data.id === selectedId ? version.data : null;
  const active = s.activeVersion;

  return (
    <>
      <PageHeader
        back={{ to: '/skills', label: 'Skill' }}
        title={<span className="font-mono">{s.name}</span>}
        meta={
          <>
            <SkillStatusBadge status={s.status} />
            <span>{SOURCE[s.source]}</span>
            <span>활성 버전 {active ? <Mono>{active.version}</Mono> : '없음'}</span>
            <span>
              수정 <Time iso={s.updatedAt} />
            </span>
          </>
        }
        description={(active ?? s.latestVersion)?.description}
        actions={
          can('admin') ? (
            <>
              {s.source !== 'marketplace' && (
                <Button variant="outline" onClick={() => setUploading(true)}>
                  새 버전 업로드
                </Button>
              )}
              {s.status === 'active' && (
                <Button variant="destructive" onClick={() => setConfirm('disable')}>
                  비활성화
                </Button>
              )}
            </>
          ) : undefined
        }
      />
      {s.status === 'inactive' && (
        <Notice tone="warn">
          <span>
            비활성화된 Skill 이에요. 새 작업에서 쓰지 않아요 — 검증을 통과한 버전을 활성화하면 다시
            쓰여요.
          </span>
        </Notice>
      )}
      {s.source === 'marketplace' && (
        <Notice tone="info">
          <span>마켓플레이스에서 설치한 Skill 이에요. 새 버전은 마켓플레이스에서 설치합니다.</span>
        </Notice>
      )}

      <div className="grid items-start gap-4 min-[1100px]:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0">
          {!selectedId ? (
            <Card>
              <Empty title="버전이 없어요" />
            </Card>
          ) : !v ? (
            version.error ? (
              <ErrorNotice error={version.error} onRetry={() => void version.reload()} />
            ) : (
              <Card>
                <Loading />
              </Card>
            )
          ) : (
            <>
              <Card>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-col gap-1.5">
                    <p className="font-semibold">
                      버전 <Mono>{v.version}</Mono>
                    </p>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <VerificationBadge status={v.verificationStatus} />
                      {v.active ? (
                        <Badge tone="success">활성 버전</Badge>
                      ) : (
                        <Badge>비활성 버전</Badge>
                      )}
                      <span className="text-xs text-muted-foreground">
                        <Time iso={v.createdAt} absolute />
                      </span>
                    </div>
                  </div>
                  {can('admin') && !v.active && (
                    <div className="flex flex-wrap items-center gap-2.5">
                      {v.verificationStatus !== 'passed' && (
                        <span className="text-xs text-muted-foreground">
                          검증을 통과해야 활성화할 수 있어요
                        </span>
                      )}
                      <Button
                        disabled={v.verificationStatus !== 'passed'}
                        onClick={() => setConfirm('activate')}
                      >
                        이 버전 활성화
                      </Button>
                    </div>
                  )}
                  {can('admin') && v.active && s.status !== 'active' && (
                    <Button onClick={() => setConfirm('activate')}>다시 활성화</Button>
                  )}
                </div>
                {activate.error && (
                  <div className="mt-3 [&>[data-slot=alert]]:mb-0">
                    <ErrorNotice error={activate.error} />
                  </div>
                )}
              </Card>
              <Tabs<DetailTab>
                label="버전 내용"
                value={tab}
                onChange={setTab}
                tabs={[
                  { id: 'doc', label: 'SKILL.md' },
                  { id: 'files', label: '파일', count: v.files.length },
                  {
                    id: 'checks',
                    label: '검증',
                    count:
                      v.verification.filter((c) => c.status === 'failed' || c.status === 'warning')
                        .length || undefined,
                  },
                  { id: 'diff', label: '버전 비교' },
                ]}
              />
              {tab === 'doc' && <SkillDocTab skillId={id} version={v} />}
              {tab === 'files' && <FilesTab skillId={id} version={v} />}
              {tab === 'checks' && (
                <Card
                  title="공급망 검증"
                  description="업로드할 때 검사한 결과예요. 실패 항목이 있으면 활성화할 수 없어요."
                >
                  <VerificationList checks={v.verification} />
                </Card>
              )}
              {tab === 'diff' && (
                <DiffTab skillId={id} version={v} versions={versions.data ?? []} />
              )}
            </>
          )}
        </div>
        <div className="min-w-0">
          <Card title="버전" description="새 작업은 활성 버전(내용 해시)으로 고정돼요" flush>
            {versions.loading && !versions.data ? (
              <Loading />
            ) : (
              <ul className="flex flex-col gap-0.5 p-1.5" aria-label="Skill 버전">
                {(versions.data ?? []).map((ver) => (
                  <li key={ver.id}>
                    <button
                      type="button"
                      className={LIST_ITEM}
                      aria-current={ver.id === selectedId || undefined}
                      onClick={() => setParams({ version: ver.id }, { replace: true })}
                    >
                      <span className="flex w-full items-center gap-2">
                        <strong className="font-mono font-semibold">{ver.version}</strong>
                        {ver.active && <Badge tone="success">활성</Badge>}
                        <span className="ml-auto text-xs text-muted-foreground">
                          <Time iso={ver.createdAt} />
                        </span>
                      </span>
                      <span className="flex gap-2 text-xs">
                        <span className={VERIFICATION_TEXT[ver.verificationStatus]}>
                          {VERIFICATION[ver.verificationStatus].label}
                        </span>
                        <span className="font-mono text-muted-foreground" title={ver.contentHash}>
                          sha256:{ver.contentHash.slice(0, 10)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {v && (
            <Card title="allowed-tools" description="Skill 단계에서 쓸 수 있는 Tool (서버가 강제)">
              {v.allowedTools.length ? (
                <ul className="flex flex-wrap gap-1.5">
                  {v.allowedTools.map((t) => (
                    <li key={t}>
                      <Mono>{t}</Mono>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">
                  지정 없음 — 문서만 참고하고 Tool 은 쓰지 않아요.
                </p>
              )}
            </Card>
          )}
        </div>
      </div>

      <UploadModal
        open={uploading}
        onClose={() => setUploading(false)}
        onDone={(r) => {
          setUploading(false);
          if (r.skill.id === id) {
            setParams({ version: r.version.id }, { replace: true });
            void reload();
          }
        }}
        onUploaded={() => void reload()}
      />
      <ConfirmModal
        open={confirm === 'activate'}
        title={`${s.name} ${v?.version ?? ''} 활성화`}
        body={
          <p className="mb-3 text-muted-foreground">
            새 Tool Registry 버전이 만들어지고, 그 뒤에 만드는 작업부터 이 버전을 써요
            {active && active.id !== selectedId ? ` (지금 활성: ${active.version})` : ''}. 실행 중인
            작업은 고정된 버전을 그대로 씁니다.
          </p>
        }
        confirmLabel="활성화"
        pending={activate.pending}
        error={activate.error}
        onConfirm={() => void activate.run()}
        onClose={() => setConfirm(null)}
      />
      <ConfirmModal
        open={confirm === 'disable'}
        title={`${s.name} 비활성화`}
        body={
          <p className="mb-3 text-muted-foreground">
            새 작업의 Registry 에서 빠지고, 실행 중인 작업도 다음 Skill 단계부터 쓰지 않아요. 버전은
            남아 있어 다시 활성화할 수 있어요.
          </p>
        }
        confirmLabel="비활성화"
        danger
        pending={disable.pending}
        error={disable.error}
        onConfirm={() => void disable.run()}
        onClose={() => setConfirm(null)}
      />
    </>
  );
}

function SkillDocTab({ skillId, version }: { skillId: string; version: SkillVersionDetail }) {
  const api = useApi();
  const skillFile =
    version.files.find((f) => f.kind === 'skill') ??
    version.files.find((f) => f.path === 'SKILL.md');
  const doc = useQuery(
    () =>
      api.get<FileContent>(`/v1/admin/skills/${skillId}/versions/${version.id}/file`, {
        path: skillFile?.path ?? 'SKILL.md',
      }),
    [skillId, version.id],
  );
  const [raw, setRaw] = useState(false);
  const fm = (version.frontmatter ?? {}) as Record<string, unknown>;
  const known = ['name', 'description', 'version', 'allowed-tools', 'allowedTools'];
  const extra = Object.entries(fm).filter(([k]) => !known.includes(k));

  return (
    <>
      <Card
        title="메타데이터"
        description="계획 단계에는 이 정보만 보이고, 본문은 Skill 단계에서 읽어요."
      >
        <KeyValue
          items={[
            ['name', <Mono key="n">{String(fm.name ?? '')}</Mono>],
            ['description', version.description],
            ['version', <Mono key="v">{version.version}</Mono>],
            [
              'allowed-tools',
              version.allowedTools.length ? (
                <span key="t" className="inline-flex flex-wrap gap-1">
                  {version.allowedTools.map((t) => (
                    <Mono key={t}>{t}</Mono>
                  ))}
                </span>
              ) : (
                <span key="t" className="text-muted-foreground">
                  없음
                </span>
              ),
            ],
            ...extra.map(([k, val]): [string, ReactNode] => [
              k,
              typeof val === 'string' ? val : <Mono key={k}>{JSON.stringify(val)}</Mono>,
            ]),
          ]}
        />
      </Card>
      <Card
        title="SKILL.md"
        actions={
          <Button size="sm" variant="ghost" onClick={() => setRaw((r) => !r)}>
            {raw ? '미리보기' : '원문 보기'}
          </Button>
        }
      >
        {doc.error ? (
          <ErrorNotice error={doc.error} onRetry={() => void doc.reload()} />
        ) : !doc.data ? (
          <Loading />
        ) : raw ? (
          <CodeBlock code={doc.data.text} />
        ) : (
          <Markdown className={MARKDOWN} text={stripFrontmatter(doc.data.text)} />
        )}
      </Card>
    </>
  );
}

function FilesTab({ skillId, version }: { skillId: string; version: SkillVersionDetail }) {
  const api = useApi();
  const files = useMemo(
    () =>
      [...version.files].sort((a, b) =>
        a.kind === 'skill' ? -1 : b.kind === 'skill' ? 1 : a.path.localeCompare(b.path),
      ),
    [version.files],
  );
  const [path, setPath] = useState<string>(files[0]?.path ?? '');
  useEffect(() => setPath(files[0]?.path ?? ''), [files]);
  const [raw, setRaw] = useState(false);
  const selected = files.find((f) => f.path === path);
  const content = useQuery(
    () => api.get<FileContent>(`/v1/admin/skills/${skillId}/versions/${version.id}/file`, { path }),
    [skillId, version.id, path],
    { enabled: Boolean(path) },
  );
  const total = files.reduce((n, f) => n + f.size, 0);
  const isMd = /\.md$/i.test(path);

  return (
    <div className="grid items-start gap-4 min-[1100px]:grid-cols-[280px_minmax(0,1fr)] [&>*]:mb-0">
      <Card title="파일" description={`${files.length}개 · ${formatBytes(total)}`} flush>
        <ul
          className="flex max-h-[60vh] flex-col gap-0.5 overflow-y-auto p-1.5"
          aria-label="번들 파일"
        >
          {files.map((f) => (
            <li key={f.path}>
              <button
                type="button"
                className={LIST_ITEM}
                aria-current={f.path === path || undefined}
                onClick={() => setPath(f.path)}
              >
                <span className="font-mono text-[12.5px] break-all">{f.path}</span>
                <span className="flex items-center gap-2 text-xs">
                  <Badge
                    tone={f.kind === 'script' ? 'warning' : f.kind === 'skill' ? 'info' : 'neutral'}
                  >
                    {FILE_KIND[f.kind]}
                  </Badge>
                  <span className="text-muted-foreground">{formatBytes(f.size)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Card>
      <Card
        title={selected ? <Mono>{selected.path}</Mono> : '미리보기'}
        description={
          selected
            ? `sha256:${selected.sha256.slice(0, 16)}… · ${formatBytes(selected.size)}`
            : undefined
        }
        actions={
          isMd ? (
            <Button size="sm" variant="ghost" onClick={() => setRaw((r) => !r)}>
              {raw ? '미리보기' : '원문 보기'}
            </Button>
          ) : undefined
        }
      >
        {!path ? (
          <Empty title="파일을 고르세요" />
        ) : content.error ? (
          <Notice tone="info">
            <span>{content.error.message}</span>
          </Notice>
        ) : !content.data || content.data.path !== path ? (
          <Loading />
        ) : isMd && !raw ? (
          <Markdown
            className={MARKDOWN}
            text={
              selected?.kind === 'skill' ? stripFrontmatter(content.data.text) : content.data.text
            }
          />
        ) : (
          <CodeBlock code={content.data.text} />
        )}
      </Card>
    </div>
  );
}

export function VerificationList({ checks }: { checks: VerificationCheck[] }) {
  const order: CheckName[] = [
    'source',
    'hash',
    'signature',
    'script_static',
    'instruction_risk',
    'tool_scope',
  ];
  const sorted = [...checks].sort((a, b) => order.indexOf(a.check) - order.indexOf(b.check));
  const failed = checks.filter((c) => c.status === 'failed').length;
  const warned = checks.filter((c) => c.status === 'warning').length;
  return (
    <div>
      <p className="mb-3 flex flex-wrap items-center gap-2">
        {failed ? (
          <Badge tone="danger">실패 {failed}</Badge>
        ) : (
          <Badge tone="success">실패 없음</Badge>
        )}
        {warned > 0 && <Badge tone="warning">경고 {warned}</Badge>}
        <span className="text-xs text-muted-foreground">{checks.length}개 항목</span>
      </p>
      <ol className="flex flex-col gap-2">
        {sorted.map((c) => {
          const st = CHECK_STATUS[c.status];
          const Icon = st.icon;
          const label = CHECK_LABEL[c.check] ?? { title: c.check, hint: '' };
          return (
            <li
              key={c.check}
              className={cn('flex gap-3 rounded-lg border p-3', VERIFY_ITEM[c.status])}
            >
              <span
                className={cn(
                  'grid size-7 shrink-0 place-items-center rounded-full',
                  TONE_CLASS[st.tone],
                )}
                aria-hidden="true"
              >
                <Icon className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 font-semibold">
                  {label.title} <Badge tone={st.tone}>{st.label}</Badge>
                </p>
                <p className="mt-0.5 text-sm break-words text-muted-foreground">{c.detail}</p>
                {c.findings && c.findings.length > 0 && (
                  <ul className="mt-1.5 list-disc pl-5 text-sm">
                    {c.findings.map((f, i) => (
                      <li key={i}>{f}</li>
                    ))}
                  </ul>
                )}
                {label.hint && <p className="mt-1 text-xs text-muted-foreground">{label.hint}</p>}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function DiffTab({
  skillId,
  version,
  versions,
}: {
  skillId: string;
  version: SkillVersionDetail;
  versions: SkillVersionSummary[];
}) {
  const api = useApi();
  const others = versions.filter((v) => v.id !== version.id);
  const [against, setAgainst] = useState<string>('');
  useEffect(() => setAgainst(''), [version.id]);
  const diff = useQuery(
    () =>
      api.get<VersionDiff>(`/v1/admin/skills/${skillId}/versions/${version.id}/diff`, {
        against: against || undefined,
      }),
    [skillId, version.id, against],
  );
  const [file, setFile] = useState<{ path: string; kind: 'added' | 'removed' | 'changed' } | null>(
    null,
  );
  useEffect(() => setFile(null), [diff.data]);
  const d = diff.data;

  return (
    <>
      <Card
        title="버전 비교"
        description={
          d
            ? d.from
              ? `${d.from.version} → ${d.to.version}`
              : `첫 버전 (${d.to.version})`
            : undefined
        }
        actions={
          others.length > 0 ? (
            <div className="flex items-center gap-2">
              <Label htmlFor="skill-diff-against" className="font-normal text-muted-foreground">
                기준
              </Label>
              <NativeSelect
                id="skill-diff-against"
                size="sm"
                className="w-auto"
                value={against}
                onChange={(e) => setAgainst(e.target.value)}
              >
                <NativeSelectOption value="">직전 버전</NativeSelectOption>
                {others.map((o) => (
                  <NativeSelectOption key={o.id} value={o.id}>
                    {o.version}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          ) : undefined
        }
      >
        {diff.error ? (
          <ErrorNotice error={diff.error} />
        ) : !d ? (
          <Loading />
        ) : !d.from ? (
          <p className="text-sm text-muted-foreground">비교할 이전 버전이 없어요.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {(d.metadata.description || d.metadata.allowedTools) && (
              <div className="flex flex-col gap-2.5">
                {d.metadata.description && (
                  <DiffView
                    label="description"
                    before={d.metadata.description.from ?? ''}
                    after={d.metadata.description.to}
                  />
                )}
                {d.metadata.allowedTools && (
                  <DiffView
                    label="allowed-tools"
                    before={d.metadata.allowedTools.from.join('\n')}
                    after={d.metadata.allowedTools.to.join('\n')}
                  />
                )}
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-3">
              {(
                [
                  ['추가', d.files.added, 'add', 'added'],
                  ['변경', d.files.changed, 'chg', 'changed'],
                  ['삭제', d.files.removed, 'del', 'removed'],
                ] as const
              ).map(([label, paths, cls, kind]) => (
                <div
                  key={label}
                  className={cn(
                    'min-w-0 rounded-lg border border-t-[3px] px-3 py-2.5',
                    NAME_DIFF_BORDER[cls],
                  )}
                >
                  <p className="mb-1.5 text-sm font-semibold">
                    {label} 파일{' '}
                    <span className="font-normal text-muted-foreground tabular-nums">
                      {paths.length}
                    </span>
                  </p>
                  {paths.length ? (
                    <ul className="flex flex-col items-start gap-1">
                      {paths.map((p) => (
                        <li key={p} className="max-w-full">
                          <Button
                            variant="link"
                            size="xs"
                            className={cn(
                              'h-auto px-0 text-left font-mono text-[12.5px] font-normal break-all whitespace-normal',
                              file?.path === p && 'font-bold underline',
                            )}
                            onClick={() => setFile({ path: p, kind })}
                          >
                            {p}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground">—</p>
                  )}
                </div>
              ))}
            </div>
            {!d.files.added.length && !d.files.changed.length && !d.files.removed.length && (
              <p className="text-sm text-muted-foreground">파일 차이 없음</p>
            )}
          </div>
        )}
      </Card>
      {d?.from && file && <FileDiff skillId={skillId} from={d.from.id} to={d.to.id} file={file} />}
    </>
  );
}

function FileDiff({
  skillId,
  from,
  to,
  file,
}: {
  skillId: string;
  from: string;
  to: string;
  file: { path: string; kind: 'added' | 'removed' | 'changed' };
}) {
  const api = useApi();
  const read = (versionId: string) =>
    api
      .get<FileContent>(`/v1/admin/skills/${skillId}/versions/${versionId}/file`, {
        path: file.path,
      })
      .then((r) => r.text);
  const texts = useQuery(
    async () => ({
      before: file.kind === 'added' ? '' : await read(from),
      after: file.kind === 'removed' ? '' : await read(to),
    }),
    [skillId, from, to, file.path, file.kind],
  );
  return (
    <Card title={<Mono>{file.path}</Mono>} description="− 이전 · + 이후">
      {texts.error ? (
        <Notice tone="info">
          <span>{texts.error.message}</span>
        </Notice>
      ) : !texts.data ? (
        <Loading />
      ) : (
        <DiffView before={texts.data.before} after={texts.data.after} />
      )}
    </Card>
  );
}
