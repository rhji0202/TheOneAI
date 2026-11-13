/**
 * 마켓플레이스 (P2) — Skill · MCP 서버 템플릿 공유. 목록 · 상세(버전 · 서명 · 파일) · 설치 · 게시 · 철회.
 * API: /v1/admin/marketplace/… (src/marketplace/marketplace.controller.ts)
 */
import { type FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { formatBytes, formatDateTime, formatNumber } from '../../../shared/format';
import { LEVEL } from '../../../shared/status';
import { ApiError } from '../api';
import { useApi, useAuth } from '../auth';
import {
  Badge,
  Button,
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
  useAction,
  useQuery,
  useToast,
} from '../ui';

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
            <Button variant="primary" onClick={() => setPublishing(true)}>
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
      <form className="toolbar" onSubmit={onSearch} role="search">
        <input
          type="search"
          className="input search"
          aria-label="마켓플레이스 검색"
          placeholder="이름 · 제목 · 설명"
          value={qInput}
          onChange={(e) => {
            setQInput(e.target.value);
            if (!e.target.value) setQ('');
          }}
        />
        <Button type="submit">검색</Button>
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
        <div className="listing-grid">
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
  return (
    <button type="button" className="listing-card" onClick={onOpen}>
      <div className="listing-card-head">
        <span className={`listing-icon ${listing.kind}`} aria-hidden="true">
          {listing.kind === 'skill' ? 'S' : 'M'}
        </span>
        <div className="listing-card-titles">
          <p className="listing-title">{listing.title || listing.name}</p>
          <p className="listing-name">
            <Mono>{listing.name}</Mono>
          </p>
        </div>
      </div>
      <p className="listing-desc">{listing.description || '설명이 없어요'}</p>
      <div className="listing-badges">
        {listing.status === 'withdrawn' && <Badge tone="danger">철회됨</Badge>}
        {listing.installed && <Badge tone="success">설치됨</Badge>}
        {listing.mine && <Badge tone="info">내 게시물</Badge>}
      </div>
      <div className="listing-foot">
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
                <Button variant="danger" onClick={() => setWithdrawing(true)}>
                  게시 철회
                </Button>
              )}
              <span className="spacer" />
              <Button onClick={onClose}>닫기</Button>
              {can('admin') && d.status === 'published' && !result && (
                <Button
                  variant="primary"
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
          <div className="stack">
            <div className="row">
              <Badge tone={d.kind === 'skill' ? 'purple' : 'info'}>
                {d.kind === 'skill' ? 'Skill' : 'MCP 템플릿'}
              </Badge>
              <Mono>{d.name}</Mono>
              {d.status === 'withdrawn' && <Badge tone="danger">철회됨</Badge>}
              {d.installed && <Badge tone="success">설치됨</Badge>}
              {d.mine && <Badge tone="info">내 게시물</Badge>}
              {latestValid === true && <Badge tone="success">✓ 서명 확인됨</Badge>}
              {latestValid === false && <Badge tone="danger">서명 불일치</Badge>}
            </div>
            <p className="listing-detail-desc">{d.description}</p>
            {result && (
              <InstallResultNotice
                result={result}
                onUseTemplate={(t) => navigate('/mcp/new', { state: { template: t } })}
              />
            )}
            <ErrorNotice error={installError(install.error)} />
            {!result && can('admin') && d.status === 'published' && d.versions.length > 1 && (
              <Field label="설치할 버전">
                <select
                  className="input"
                  value={version}
                  onChange={(e) => setVersion(e.target.value)}
                >
                  {d.versions.map((v) => (
                    <option key={v.version} value={v.version} disabled={!v.signatureValid}>
                      v{v.version}
                      {v.version === d.latestVersion ? ' (최신)' : ''}
                      {!v.signatureValid ? ' — 서명 불일치' : ''}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {d.kind === 'skill' && !result && (
              <p className="muted small">
                설치하면 업로드와 같은 검사(SKILL.md · 신뢰 검증)를 거쳐 검토 대기 버전이 돼요.
                활성화는 Skill 화면에서 운영자가 합니다.
              </p>
            )}
            {d.kind === 'mcp' && !result && (
              <p className="muted small">
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
              <h3 className="section-title">버전 · 서명</h3>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>버전</th>
                      <th>게시</th>
                      <th>내용 해시</th>
                      <th>서명 키</th>
                      <th>서명</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.versions.map((v) => (
                      <tr key={v.version}>
                        <td>
                          <strong>v{v.version}</strong>
                          {v.description && <div className="cell-sub">{v.description}</div>}
                        </td>
                        <td>
                          <Time iso={v.publishedAt} />
                        </td>
                        <td>
                          <Mono title={v.contentHash}>{shortHash(v.contentHash)}</Mono>
                        </td>
                        <td>
                          <Mono>{v.keyId}</Mono>
                        </td>
                        <td>
                          {v.signatureValid ? (
                            <Badge tone="success">확인됨</Badge>
                          ) : (
                            <Badge tone="danger">불일치</Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
        <span>
          템플릿 v{result.version} 을 가져왔어요. 등록 마법사에서 API Key 를 넣고 연결을 확인하세요.
        </span>
        <Button size="sm" variant="primary" onClick={() => onUseTemplate(result.template)}>
          등록 마법사로
        </Button>
      </Notice>
    );
  }
  return (
    <div className="stack">
      <Notice tone={result.duplicate ? 'info' : 'success'}>
        <span>
          {result.duplicate
            ? `같은 내용이 이미 설치돼 있어요 — ${result.skill.name} v${result.version.version}`
            : `${result.skill.name} v${result.version.version} 을 설치했어요 — 검토 대기 상태예요. Skill 화면에서 확인하고 활성화하세요.`}
        </span>
        <Link className="btn btn-sm btn-primary" to={`/skills/${result.skill.id}`}>
          Skill 검토하기
        </Link>
      </Notice>
      {result.warnings.length > 0 && (
        <Notice tone="warn">
          <span>경고: {result.warnings.join(' · ')}</span>
        </Notice>
      )}
    </div>
  );
}

function SkillContents({ manifest }: { manifest: SkillManifest }) {
  const total = manifest.files.reduce((n, f) => n + f.size, 0);
  return (
    <section className="stack">
      <h3 className="section-title">
        파일 {manifest.files.length}개 · {formatBytes(total)}
      </h3>
      <div className="file-list">
        {manifest.files.map((f) => (
          <div key={f.path} className="file-row">
            <Mono>{f.path}</Mono>
            <span className="muted small">{f.kind}</span>
            <span className="muted small num">{formatBytes(f.size)}</span>
            <Mono title={f.sha256}>{f.sha256.slice(0, 10)}</Mono>
          </div>
        ))}
      </div>
      <div>
        <h3 className="section-title">허용 Tool (allowed-tools)</h3>
        {manifest.allowedTools.length > 0 ? (
          <div className="row">
            {manifest.allowedTools.map((t) => (
              <Mono key={t}>{t}</Mono>
            ))}
          </div>
        ) : (
          <p className="muted small">없음 — 이 Skill 은 Tool 을 쓰지 않아요</p>
        )}
      </div>
    </section>
  );
}

function McpContents({ manifest }: { manifest: McpManifest }) {
  return (
    <section className="stack">
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
      <h3 className="section-title">Tool {manifest.tools.length}개</h3>
      <div className="file-list">
        {manifest.tools.map((t) => (
          <div key={t.name} className="tool-row">
            <Mono>{t.name}</Mono>
            <Badge>{LEVEL[t.permissionLevel] ?? t.permissionLevel}</Badge>
            <span className="muted small tool-desc">{t.description}</span>
          </div>
        ))}
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
          <Button onClick={onClose}>취소</Button>
          <Button
            variant="primary"
            loading={publish.pending}
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            게시
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="segmented" role="group" aria-label="게시할 종류">
          <button type="button" aria-pressed={kind === 'skill'} onClick={() => setKind('skill')}>
            Skill
          </button>
          <button type="button" aria-pressed={kind === 'mcp'} onClick={() => setKind('mcp')}>
            MCP 템플릿
          </button>
        </div>
        {kind === 'skill' ? (
          <>
            <Field
              label="Skill"
              required
              hint="마켓플레이스에서 설치한 Skill 은 다시 게시할 수 없어요"
            >
              <select
                className="input"
                value={skillId}
                onChange={(e) => {
                  setSkillId(e.target.value);
                  setVersionId('');
                }}
              >
                <option value="">선택하세요</option>
                {ownSkills.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
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
                <select
                  className="input"
                  value={versionId}
                  onChange={(e) => setVersionId(e.target.value)}
                >
                  {(versions.data ?? []).map((v) => (
                    <option key={v.id} value={v.id} disabled={v.verificationStatus !== 'passed'}>
                      v{v.version}
                      {v.active ? ' (활성)' : ''}
                      {v.verificationStatus !== 'passed'
                        ? v.verificationStatus === 'failed'
                          ? ' — 검증 실패'
                          : ' — 검증 대기'
                        : ''}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </>
        ) : (
          <Field
            label="MCP 서버"
            required
            hint="연결 정보 · Tool 목록만 공유돼요. API Key · 허용 호스트 같은 설정은 공유하지 않아요"
          >
            <select
              className="input"
              value={serverId}
              onChange={(e) => setServerId(e.target.value)}
            >
              <option value="">선택하세요</option>
              {(servers.data ?? []).map((s) => (
                <option
                  key={s.id}
                  value={s.id}
                  disabled={s.status !== 'connected' || !s.endpointUrl}
                >
                  {s.name}
                  {s.status !== 'connected' ? ` — ${s.status}` : ''}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="제목" hint="비우면 이름을 써요">
          <input
            className="input"
            maxLength={120}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field label="설명" hint="비우면 Skill · 서버 설명을 써요">
          <textarea
            className="input"
            rows={3}
            maxLength={2000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <p className="muted small">
          게시하면 플랫폼 키(Ed25519)로 이름 · 버전 · 내용 해시를 서명해요. 같은 이름으로 다시
          게시하면 새 버전이 됩니다.
        </p>
        <ErrorNotice error={publishError(publish.error ?? skills.error ?? servers.error)} />
      </div>
    </Modal>
  );
}
