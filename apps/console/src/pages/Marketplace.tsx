/**
 * 마켓플레이스 (P2) — Skill · MCP 서버 템플릿 공유. 목록 · 상세(버전 · 서명 · 파일) · 설치 · 게시 · 철회.
 * API: /v1/admin/marketplace/… (src/marketplace/marketplace.controller.ts)
 */
import {
  ArrowRightIcon,
  PuzzleIcon,
  SearchIcon,
  ServerIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  UploadIcon,
} from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { formatBytes, formatDateTime, formatNumber } from '../../../shared/format';
import { LEVEL } from '../../../shared/status';
import { ApiError } from '../api';
import { useApi, useAuth } from '../auth';
import {
  Badge,
  Card,
  ConfirmModal,
  Empty,
  ErrorNotice,
  Field,
  KeyValue,
  Loading,
  Modal,
  Mono,
  Notice,
  PageHeader,
  Tabs,
  Time,
  TONE_CLASS,
  useAction,
  useQuery,
  useToast,
} from '../ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';

/* ───────────── 타입 (src/marketplace/marketplace.service.ts) ───────────── */

type Kind = 'skill' | 'mcp';

interface ListingView {
  id: string;
  kind: Kind;
  name: string;
  title: string;
  description: string;
  publisher: string;
  latestVersion: string;
  installCount: number;
  status: string;
  mine: boolean;
  installed: boolean;
  updatedAt: string;
}

interface SkillManifest {
  files: Array<{ path: string; size: number; sha256: string; kind: string }>;
  allowedTools: string[];
  frontmatter: unknown;
}
interface McpManifest {
  endpointUrl: string;
  transport: string;
  authType: string;
  tools: Array<{ name: string; description: string | null; permissionLevel: string }>;
}

interface ListingDetail extends ListingView {
  versions: Array<{
    version: string;
    description: string;
    contentHash: string;
    keyId: string;
    signatureValid: boolean;
    publishedAt: string;
  }>;
  latest: SkillManifest | McpManifest;
}

interface SkillInstallResult {
  kind: 'skill';
  listingId: string;
  marketplaceVersion: string;
  skill: { id: string; name: string; status: string };
  version: { id: string; version: string; verificationStatus: string };
  duplicate: boolean;
  warnings: string[];
}
interface McpInstallResult {
  kind: 'mcp';
  listingId: string;
  version: string;
  template: {
    name: string;
    description: string;
    transport: string;
    endpointUrl: string;
    authType: string;
    tools: McpManifest['tools'];
  };
}
type InstallResult = SkillInstallResult | McpInstallResult;

interface SkillSummary {
  id: string;
  name: string;
  source: 'upload' | 'git' | 'marketplace';
  status: string;
  activeVersion: { id: string; version: string; verificationStatus: string } | null;
}
interface SkillVersionSummary {
  id: string;
  version: string;
  description: string;
  verificationStatus: 'pending' | 'passed' | 'failed';
  active: boolean;
  createdAt: string;
}
interface McpServerSummary {
  id: string;
  name: string;
  description: string | null;
  transport: string;
  endpointUrl: string | null;
  status: string;
}

type TabId = 'skill' | 'mcp' | 'mine';

const KIND_ICON = { skill: PuzzleIcon, mcp: ServerIcon } as const;
const KIND_TONE = { skill: 'purple', mcp: 'info' } as const;

const isSkillManifest = (m: SkillManifest | McpManifest): m is SkillManifest => 'files' in m;
const shortHash = (h: string) => `${h.slice(0, 12)}…`;

/* ───────────── 페이지 ───────────── */

export function MarketplacePage() {
  const api = useApi();
  const { can } = useAuth();
  const [tab, setTab] = useState<TabId>('skill');
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const listings = useQuery(
    () =>
      api.get<ListingView[]>('/v1/admin/marketplace/listings', {
        kind: tab === 'mine' ? undefined : tab,
        q: q || undefined,
      }),
    [tab, q],
  );
  const items = (listings.data ?? []).filter((l) => (tab === 'mine' ? l.mine : true));

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    setQ(qInput.trim());
  };

  return (
    <>
      <PageHeader
        title="마켓플레이스"
        description="검증을 통과한 Skill 과 MCP 서버 연결 템플릿을 다른 워크스페이스와 공유해요. 모든 항목은 플랫폼 키로 서명되고, 설치할 때 서명과 파일 해시를 다시 확인합니다."
        actions={
          can('admin') ? (
            <Button onClick={() => setPublishing(true)}>
              <UploadIcon aria-hidden="true" />
              게시하기
            </Button>
          ) : undefined
        }
      />
      <Tabs<TabId>
        label="마켓플레이스 종류"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'skill', label: 'Skill' },
          { id: 'mcp', label: 'MCP 템플릿' },
          { id: 'mine', label: '내 게시물' },
        ]}
      />
      <form className="mb-3 flex flex-wrap items-center gap-2" onSubmit={onSearch} role="search">
        <div className="relative w-full max-w-xs">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            className="pl-8"
            aria-label="마켓플레이스 검색"
            placeholder="이름 · 제목 · 설명"
            value={qInput}
            onChange={(e) => {
              setQInput(e.target.value);
              if (!e.target.value) setQ('');
            }}
          />
        </div>
        <Button variant="outline" type="submit">
          검색
        </Button>
      </form>
      <ErrorNotice error={listings.error} onRetry={() => void listings.reload()} />
      {listings.loading && !listings.data ? (
        <Loading />
      ) : items.length === 0 ? (
        <Card>
          <Empty
            title={
              q
                ? `“${q}” 에 맞는 항목이 없어요`
                : tab === 'mine'
                  ? '아직 게시한 항목이 없어요'
                  : tab === 'skill'
                    ? '공유된 Skill 이 없어요'
                    : '공유된 MCP 템플릿이 없어요'
            }
          >
            {tab === 'mine' && can('admin')
              ? '신뢰 검증을 통과한 Skill 버전이나 연결된 MCP 서버를 게시할 수 있어요.'
              : undefined}
          </Empty>
        </Card>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
          {items.map((l) => (
            <ListingCard key={l.id} listing={l} onOpen={() => setOpenId(l.id)} />
          ))}
        </div>
      )}
      {openId && (
        <ListingModal
          id={openId}
          onClose={() => setOpenId(null)}
          onChanged={() => void listings.reload()}
        />
      )}
      {publishing && (
        <PublishModal
          onClose={() => setPublishing(false)}
          onPublished={(detail) => {
            setPublishing(false);
            void listings.reload();
            setOpenId(detail.id);
          }}
        />
      )}
    </>
  );
}

function ListingCard({ listing, onOpen }: { listing: ListingView; onOpen: () => void }) {
  const Icon = KIND_ICON[listing.kind];
  return (
    <button
      type="button"
      className="flex min-w-0 flex-col gap-2.5 rounded-xl border bg-card p-4 text-left text-card-foreground shadow-sm transition-colors outline-none hover:border-primary focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
      onClick={onOpen}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          className={cn(
            'grid size-9 shrink-0 place-items-center rounded-lg',
            TONE_CLASS[KIND_TONE[listing.kind]],
          )}
          aria-hidden="true"
        >
          <Icon className="size-[18px]" />
        </span>
        <div className="min-w-0">
          <p className="truncate font-semibold">{listing.title || listing.name}</p>
          <p className="[&_code]:text-xs">
            <Mono>{listing.name}</Mono>
          </p>
        </div>
      </div>
      <p className="line-clamp-2 min-h-10 text-sm text-muted-foreground">
        {listing.description || '설명이 없어요'}
      </p>
      <div className="flex min-h-[22px] flex-wrap gap-1">
        {listing.status === 'withdrawn' && <Badge tone="danger">철회됨</Badge>}
        {listing.installed && <Badge tone="success">설치됨</Badge>}
        {listing.mine && <Badge tone="info">내 게시물</Badge>}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 border-t pt-2 text-xs text-muted-foreground">
        <span>{listing.publisher}</span>
        <span>v{listing.latestVersion}</span>
        <span>설치 {formatNumber(listing.installCount)}</span>
        <span>
          <Time iso={listing.updatedAt} />
        </span>
      </div>
    </button>
  );
}

/* ───────────── 상세 · 설치 · 철회 ───────────── */

function installError(error: Error | null): Error | null {
  if (!(error instanceof ApiError)) return error;
  if (error.code === 'MARKETPLACE_SIGNATURE_INVALID')
    return new Error(`서명 확인 실패 — 설치하지 않았어요. ${error.message}`);
  if (error.code === 'NAME_TAKEN')
    return new Error(`같은 이름의 Skill 이 이미 있어요. ${error.message}`);
  return error;
}

function ListingModal({
  id,
  onClose,
  onChanged,
}: {
  id: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const api = useApi();
  const { can } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const detail = useQuery(
    () => api.get<ListingDetail>(`/v1/admin/marketplace/listings/${id}`),
    [id],
  );
  const [version, setVersion] = useState('');
  const [result, setResult] = useState<InstallResult | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);
  const install = useAction((v: string) =>
    api.post<InstallResult>(
      `/v1/admin/marketplace/listings/${id}/install`,
      v ? { version: v } : {},
    ),
  );
  const withdraw = useAction(() =>
    api.post<ListingView>(`/v1/admin/marketplace/listings/${id}/withdraw`),
  );
  const d = detail.data;
  useEffect(() => {
    if (d && !version) setVersion(d.latestVersion);
  }, [d, version]);

  const latestValid = d?.versions.find((v) => v.version === d.latestVersion)?.signatureValid;
  const chosen = d?.versions.find((v) => v.version === version);

  const doInstall = async () => {
    const r = await install.run(version === d?.latestVersion ? '' : version);
    if (!r) return;
    setResult(r);
    onChanged();
    void detail.reload();
  };

  return (
    <>
      <Modal
        open
        wide
        title={d ? d.title || d.name : '마켓플레이스 항목'}
        onClose={onClose}
        footer={
          d && (
            <>
              {d.mine && d.status === 'published' && can('admin') && (
                <Button
                  variant="destructive"
                  className="sm:mr-auto"
                  onClick={() => setWithdrawing(true)}
                >
                  게시 철회
                </Button>
              )}
              <Button variant="outline" onClick={onClose}>
                닫기
              </Button>
              {can('admin') && d.status === 'published' && !result && (
                <Button
                  loading={install.pending}
                  disabled={chosen?.signatureValid === false}
                  onClick={() => void doInstall()}
                >
                  {d.kind === 'skill' ? (d.installed ? '새 버전 설치' : '설치') : '템플릿 가져오기'}
                </Button>
              )}
            </>
          )
        }
      >
        {detail.loading && !d ? (
          <Loading />
        ) : detail.error ? (
          <ErrorNotice error={detail.error} onRetry={() => void detail.reload()} />
        ) : d ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={KIND_TONE[d.kind]}>{d.kind === 'skill' ? 'Skill' : 'MCP 템플릿'}</Badge>
              <Mono>{d.name}</Mono>
              {d.status === 'withdrawn' && <Badge tone="danger">철회됨</Badge>}
              {d.installed && <Badge tone="success">설치됨</Badge>}
              {d.mine && <Badge tone="info">내 게시물</Badge>}
              {latestValid === true && (
                <Badge tone="success">
                  <ShieldCheckIcon aria-hidden="true" />
                  서명 확인됨
                </Badge>
              )}
              {latestValid === false && (
                <Badge tone="danger">
                  <ShieldAlertIcon aria-hidden="true" />
                  서명 불일치
                </Badge>
              )}
            </div>
            <p className="whitespace-pre-wrap text-muted-foreground">{d.description}</p>
            {result && (
              <InstallResultNotice
                result={result}
                onUseTemplate={(t) => navigate('/mcp/new', { state: { template: t } })}
              />
            )}
            <ErrorNotice error={installError(install.error)} />
            {!result && can('admin') && d.status === 'published' && d.versions.length > 1 && (
              <Field label="설치할 버전">
                <NativeSelect value={version} onChange={(e) => setVersion(e.target.value)}>
                  {d.versions.map((v) => (
                    <NativeSelectOption
                      key={v.version}
                      value={v.version}
                      disabled={!v.signatureValid}
                    >
                      v{v.version}
                      {v.version === d.latestVersion ? ' (최신)' : ''}
                      {!v.signatureValid ? ' — 서명 불일치' : ''}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
            )}
            {d.kind === 'skill' && !result && (
              <p className="text-xs text-muted-foreground">
                설치하면 업로드와 같은 검사(SKILL.md · 신뢰 검증)를 거쳐 검토 대기 버전이 돼요.
                활성화는 Skill 화면에서 운영자가 합니다.
              </p>
            )}
            {d.kind === 'mcp' && !result && (
              <p className="text-xs text-muted-foreground">
                템플릿에는 연결 정보와 Tool 목록만 있어요(비밀값 없음). 가져온 뒤 등록 마법사에서
                API Key 입력 · 연결 테스트 · Tool 검증을 거쳐 등록합니다.
              </p>
            )}
            <KeyValue
              items={[
                ['게시자', d.publisher],
                ['최신 버전', `v${d.latestVersion}`],
                ['설치', `${formatNumber(d.installCount)}회`],
                ['갱신', formatDateTime(d.updatedAt)],
              ]}
            />
            {isSkillManifest(d.latest) ? (
              <SkillContents manifest={d.latest} />
            ) : (
              <McpContents manifest={d.latest} />
            )}
            <section>
              <SectionTitle>버전 · 서명</SectionTitle>
              <Table aria-label="버전 · 서명">
                <TableHeader className="bg-muted/50 [&_th]:text-xs [&_th]:text-muted-foreground">
                  <TableRow>
                    <TableHead>버전</TableHead>
                    <TableHead>게시</TableHead>
                    <TableHead>내용 해시</TableHead>
                    <TableHead>서명 키</TableHead>
                    <TableHead>서명</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.versions.map((v) => (
                    <TableRow key={v.version}>
                      <TableCell className="whitespace-normal">
                        <strong>v{v.version}</strong>
                        {v.description && (
                          <div className="text-xs text-muted-foreground">{v.description}</div>
                        )}
                      </TableCell>
                      <TableCell>
                        <Time iso={v.publishedAt} />
                      </TableCell>
                      <TableCell>
                        <Mono title={v.contentHash}>{shortHash(v.contentHash)}</Mono>
                      </TableCell>
                      <TableCell>
                        <Mono>{v.keyId}</Mono>
                      </TableCell>
                      <TableCell>
                        {v.signatureValid ? (
                          <Badge tone="success">확인됨</Badge>
                        ) : (
                          <Badge tone="danger">불일치</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </section>
          </div>
        ) : null}
      </Modal>
      <ConfirmModal
        open={withdrawing}
        title="게시 철회"
        confirmLabel="철회"
        danger
        pending={withdraw.pending}
        error={withdraw.error}
        onClose={() => setWithdrawing(false)}
        onConfirm={() =>
          void withdraw.run().then((r) => {
            if (!r) return;
            setWithdrawing(false);
            toast('게시를 철회했어요');
            onChanged();
            void detail.reload();
          })
        }
        body={
          <p>목록과 새 설치에서 빠져요. 이미 설치한 워크스페이스의 Skill 은 그대로 남습니다.</p>
        }
      />
    </>
  );
}

function InstallResultNotice({
  result,
  onUseTemplate,
}: {
  result: InstallResult;
  onUseTemplate: (template: McpInstallResult['template']) => void;
}) {
  if (result.kind === 'mcp') {
    return (
      <Notice tone="success">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>
            템플릿 v{result.version} 을 가져왔어요. 등록 마법사에서 API Key 를 넣고 연결을
            확인하세요.
          </span>
          <Button size="sm" onClick={() => onUseTemplate(result.template)}>
            등록 마법사로
            <ArrowRightIcon aria-hidden="true" />
          </Button>
        </div>
      </Notice>
    );
  }
  return (
    <div>
      <Notice tone={result.duplicate ? 'info' : 'success'}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>
            {result.duplicate
              ? `같은 내용이 이미 설치돼 있어요 — ${result.skill.name} v${result.version.version}`
              : `${result.skill.name} v${result.version.version} 을 설치했어요 — 검토 대기 상태예요. Skill 화면에서 확인하고 활성화하세요.`}
          </span>
          <Button asChild size="sm">
            <Link to={`/skills/${result.skill.id}`}>
              Skill 검토하기
              <ArrowRightIcon aria-hidden="true" />
            </Link>
          </Button>
        </div>
      </Notice>
      {result.warnings.length > 0 && (
        <Notice tone="warn">
          <span>경고: {result.warnings.join(' · ')}</span>
        </Notice>
      )}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-1.5 text-sm font-semibold">{children}</h3>;
}

function SkillContents({ manifest }: { manifest: SkillManifest }) {
  const total = manifest.files.reduce((n, f) => n + f.size, 0);
  return (
    <section className="flex flex-col gap-3">
      <div>
        <SectionTitle>
          파일 {manifest.files.length}개 · {formatBytes(total)}
        </SectionTitle>
        <div className="max-h-[260px] overflow-auto rounded-lg border">
          <Table aria-label="파일">
            <TableHeader className="bg-muted/50 [&_th]:text-xs [&_th]:text-muted-foreground">
              <TableRow>
                <TableHead>경로</TableHead>
                <TableHead className="hidden sm:table-cell">종류</TableHead>
                <TableHead className="text-right">크기</TableHead>
                <TableHead className="hidden sm:table-cell">SHA-256</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {manifest.files.map((f) => (
                <TableRow key={f.path}>
                  <TableCell className="whitespace-normal">
                    <Mono>{f.path}</Mono>
                  </TableCell>
                  <TableCell className="hidden text-xs text-muted-foreground sm:table-cell">
                    {f.kind}
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground tabular-nums">
                    {formatBytes(f.size)}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <Mono title={f.sha256}>{f.sha256.slice(0, 10)}</Mono>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
      <div>
        <SectionTitle>허용 Tool (allowed-tools)</SectionTitle>
        {manifest.allowedTools.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {manifest.allowedTools.map((t) => (
              <Mono key={t}>{t}</Mono>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">없음 — 이 Skill 은 Tool 을 쓰지 않아요</p>
        )}
      </div>
    </section>
  );
}

function McpContents({ manifest }: { manifest: McpManifest }) {
  return (
    <section className="flex flex-col gap-3">
      <KeyValue
        items={[
          ['엔드포인트', <Mono>{manifest.endpointUrl}</Mono>],
          [
            '전송',
            manifest.transport === 'streamable_http' ? 'Streamable HTTP' : manifest.transport,
          ],
          [
            '인증',
            manifest.authType === 'none'
              ? '없음'
              : manifest.authType === 'api_key'
                ? 'API Key (설치 시 입력)'
                : manifest.authType,
          ],
        ]}
      />
      <div>
        <SectionTitle>Tool {manifest.tools.length}개</SectionTitle>
        <div className="max-h-[260px] overflow-auto rounded-lg border">
          <Table aria-label="Tool">
            <TableHeader className="bg-muted/50 [&_th]:text-xs [&_th]:text-muted-foreground">
              <TableRow>
                <TableHead>이름</TableHead>
                <TableHead>권한</TableHead>
                <TableHead>설명</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {manifest.tools.map((t) => (
                <TableRow key={t.name}>
                  <TableCell>
                    <Mono>{t.name}</Mono>
                  </TableCell>
                  <TableCell>
                    <Badge>{LEVEL[t.permissionLevel] ?? t.permissionLevel}</Badge>
                  </TableCell>
                  <TableCell className="text-xs whitespace-normal text-muted-foreground">
                    {t.description}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </section>
  );
}

/* ───────────── 게시 ───────────── */

function publishError(error: Error | null): Error | null {
  if (!(error instanceof ApiError)) return error;
  const messages: Record<string, string> = {
    SKILL_VERIFICATION_FAILED: '신뢰 검증을 통과한 버전만 게시할 수 있어요.',
    MCP_SERVER_STATE: '연결된(connected) Streamable HTTP 서버만 공유할 수 있어요.',
  };
  return messages[error.code] ? new Error(messages[error.code]) : error;
}

function PublishModal({
  onClose,
  onPublished,
}: {
  onClose: () => void;
  onPublished: (detail: ListingDetail) => void;
}) {
  const api = useApi();
  const toast = useToast();
  const [kind, setKind] = useState<Kind>('skill');
  const [skillId, setSkillId] = useState('');
  const [versionId, setVersionId] = useState('');
  const [serverId, setServerId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const skills = useQuery(() => api.get<SkillSummary[]>('/v1/admin/skills'), []);
  const servers = useQuery(() => api.get<McpServerSummary[]>('/v1/admin/mcp-servers'), [], {
    enabled: kind === 'mcp',
  });
  const versions = useQuery(
    () => api.get<SkillVersionSummary[]>(`/v1/admin/skills/${skillId}/versions`),
    [skillId],
    { enabled: Boolean(skillId) },
  );
  const publish = useAction((body: Record<string, unknown>) =>
    api.post<ListingDetail>(
      kind === 'skill' ? '/v1/admin/marketplace/skills' : '/v1/admin/marketplace/mcp-servers',
      body,
    ),
  );

  const ownSkills = (skills.data ?? []).filter((s) => s.source !== 'marketplace');
  const passed = (versions.data ?? []).filter((v) => v.verificationStatus === 'passed');
  useEffect(() => {
    // 기본: 활성 버전(통과) → 없으면 최신 통과 버전
    const active = passed.find((v) => v.active);
    setVersionId(active?.id ?? passed[0]?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versions.data]);

  const canSubmit = kind === 'skill' ? Boolean(skillId && versionId) : Boolean(serverId);
  const submit = async () => {
    const meta = {
      ...(title.trim() ? { title: title.trim() } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
    };
    const detail = await publish.run(
      kind === 'skill' ? { skillId, versionId, ...meta } : { serverId, ...meta },
    );
    if (detail) {
      toast(`${detail.title || detail.name} v${detail.latestVersion} 을 게시했어요`);
      onPublished(detail);
    }
  };

  return (
    <Modal
      open
      title="마켓플레이스에 게시"
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            취소
          </Button>
          <Button loading={publish.pending} disabled={!canSubmit} onClick={() => void submit()}>
            게시
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <ToggleGroup
          type="single"
          variant="outline"
          aria-label="게시할 종류"
          className="mb-1"
          value={kind}
          onValueChange={(v) => v && setKind(v as Kind)}
        >
          <ToggleGroupItem value="skill">Skill</ToggleGroupItem>
          <ToggleGroupItem value="mcp">MCP 템플릿</ToggleGroupItem>
        </ToggleGroup>
        {kind === 'skill' ? (
          <>
            <Field
              label="Skill"
              required
              hint="마켓플레이스에서 설치한 Skill 은 다시 게시할 수 없어요"
            >
              <NativeSelect
                value={skillId}
                onChange={(e) => {
                  setSkillId(e.target.value);
                  setVersionId('');
                }}
              >
                <NativeSelectOption value="">선택하세요</NativeSelectOption>
                {ownSkills.map((s) => (
                  <NativeSelectOption key={s.id} value={s.id}>
                    {s.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            {skillId && (
              <Field
                label="버전"
                required
                hint="신뢰 검증을 통과한 버전만 게시할 수 있어요"
                error={
                  versions.data && passed.length === 0
                    ? '검증을 통과한 버전이 없어요 — Skill 화면에서 검증 결과를 확인하세요'
                    : undefined
                }
              >
                <NativeSelect value={versionId} onChange={(e) => setVersionId(e.target.value)}>
                  {(versions.data ?? []).map((v) => (
                    <NativeSelectOption
                      key={v.id}
                      value={v.id}
                      disabled={v.verificationStatus !== 'passed'}
                    >
                      v{v.version}
                      {v.active ? ' (활성)' : ''}
                      {v.verificationStatus !== 'passed'
                        ? v.verificationStatus === 'failed'
                          ? ' — 검증 실패'
                          : ' — 검증 대기'
                        : ''}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
            )}
          </>
        ) : (
          <Field
            label="MCP 서버"
            required
            hint="연결 정보 · Tool 목록만 공유돼요. API Key · 허용 호스트 같은 설정은 공유하지 않아요"
          >
            <NativeSelect value={serverId} onChange={(e) => setServerId(e.target.value)}>
              <NativeSelectOption value="">선택하세요</NativeSelectOption>
              {(servers.data ?? []).map((s) => (
                <NativeSelectOption
                  key={s.id}
                  value={s.id}
                  disabled={s.status !== 'connected' || !s.endpointUrl}
                >
                  {s.name}
                  {s.status !== 'connected' ? ` — ${s.status}` : ''}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
        )}
        <Field label="제목" hint="비우면 이름을 써요">
          <Input maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="설명" hint="비우면 Skill · 서버 설명을 써요">
          <Textarea
            rows={3}
            maxLength={2000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <p className="text-xs text-muted-foreground">
          게시하면 플랫폼 키(Ed25519)로 이름 · 버전 · 내용 해시를 서명해요. 같은 이름으로 다시
          게시하면 새 버전이 됩니다.
        </p>
        <ErrorNotice error={publishError(publish.error ?? skills.error ?? servers.error)} />
      </div>
    </Modal>
  );
}
