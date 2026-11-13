/**
 * C-08 Memory 탐색 — 의미 · 키워드 검색(Agent 가 실제로 떠올리는 경로와 같음), 활성 · 격리 목록,
 * 출처 추적, 격리 해제 · 편집(재임베딩) · 고정 · 삭제, 사용자 데이터 삭제.
 * API: docs/api-spec.md §4.8 (/v1/admin/memories…, /v1/admin/end-users/:id/erase)
 */
import { type FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { formatDateTime, formatPercent } from '../../../shared/format';
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
  KeyValue,
  Modal,
  MoreButton,
  Mono,
  Notice,
  type Page,
  PageHeader,
  pseudonym,
  Tabs,
  Time,
  Toolbar,
  useAction,
  usePaged,
  useQuery,
  useToast,
} from '../ui';
import { Button } from '@/components/ui/button';

/* ───────────── 타입 (src/memory/admin/memories-admin.service.ts) ───────────── */

type MemoryType = 'episodic' | 'semantic' | 'procedural';
type MemoryScope = 'user' | 'agent';

interface MemoryView {
  id: string;
  type: MemoryType;
  scope: MemoryScope;
  score?: number;
  title: string | null;
  content: string;
  confidence: number;
  needsVerification: boolean;
  status: 'active' | 'quarantined';
  quarantineReason?: string | null;
  pinned: boolean;
  endUserId: string | null;
  /** 서버가 정한 가명 — 작업 · 승인 화면과 같은 값 */
  endUserPseudonym: string | null;
  source: { type: string; taskIds: string[]; conversationId: string | null };
  useCount: number;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

interface AgentItem {
  id: string;
  name: string;
  publishedVersion: number | null;
}

const TYPE_LABEL: Record<MemoryType, string> = {
  semantic: '사실 · 선호',
  episodic: '대화 요약',
  procedural: '처리 요령',
};
const TYPE_TONE: Record<MemoryType, 'info' | 'purple' | 'success'> = {
  semantic: 'info',
  episodic: 'purple',
  procedural: 'success',
};
const SOURCE_LABEL: Record<string, string> = {
  user_message: '사용자 메시지',
  tool_result: 'Tool 결과',
  external_document: '외부 문서',
  reflection: '작업 회고',
  manual: '운영자 입력',
};

type StatusTab = 'active' | 'quarantined';

/** 만료까지 남은 기간 — "45일 후" */
function untilLabel(iso: string | null, pinned: boolean): string {
  if (pinned) return '고정 — 만료 없음';
  if (!iso) return '만료 없음';
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return '만료됨';
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days}일 후`;
  const hours = Math.max(1, Math.floor(ms / 3_600_000));
  return `${hours}시간 후`;
}

/* ───────────── 페이지 ───────────── */

export function MemoryPage() {
  const api = useApi();
  const agents = useQuery(() => api.get<AgentItem[]>('/v1/admin/agents'), []);
  const [agentId, setAgentId] = useState('');
  useEffect(() => {
    if (!agentId && agents.data?.[0]) setAgentId(agents.data[0].id);
  }, [agents.data, agentId]);

  // 검색 조건 — 입력 중인 값과 실행한 값을 나눠 둔다
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'semantic' | 'keyword'>('semantic');
  const [type, setType] = useState<MemoryType | ''>('');
  const [scope, setScope] = useState<MemoryScope | ''>('');
  const [search, setSearch] = useState<{
    q: string;
    mode: 'semantic' | 'keyword';
    agentId: string;
    type: MemoryType | '';
    scope: MemoryScope | '';
  } | null>(null);
  const [tab, setTab] = useState<StatusTab>('active');
  const [selected, setSelected] = useState<MemoryView | null>(null);

  const results = useQuery(
    () =>
      api.get<MemoryView[]>('/v1/admin/memories/search', {
        agentId: search!.agentId,
        q: search!.q,
        mode: search!.mode,
        type: search!.type || undefined,
        scope: search!.scope || undefined,
        limit: 30,
      }),
    [search],
    { enabled: search !== null },
  );

  const list = usePaged(
    (cursor) =>
      api.get<Page<MemoryView>>('/v1/admin/memories', {
        status: tab,
        type: type || undefined,
        scope: scope || undefined,
        limit: 50,
        cursor,
      }),
    [tab, type, scope],
  );
  const listed = list.items;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = text.trim();
    if (!q || !agentId) {
      setSearch(null);
      return;
    }
    setSearch({ q, mode, agentId, type, scope });
  };

  const onChanged = (updated: MemoryView | null, removedId?: string) => {
    if (updated) {
      setSelected(updated);
      results.setData((prev) =>
        (prev ?? []).map((m) => (m.id === updated.id ? { ...updated, score: m.score } : m)),
      );
    }
    if (removedId) {
      setSelected(null);
      results.setData((prev) => (prev ?? []).filter((m) => m.id !== removedId));
      // 사용자 데이터 삭제는 그 사용자의 다른 기억도 지우므로 검색 결과를 다시 받는다
      if (search) void results.reload();
    }
    void list.reload();
  };

  const searching = search !== null;
  const rows = searching ? (results.data ?? []) : listed;

  return (
    <>
      <PageHeader
        title="Memory 탐색"
        description="Agent 가 대화에서 기억한 사용자 사실 · 대화 요약 · 처리 요령입니다. 검색은 Agent 가 Context 를 만들 때와 같은 방식으로 찾아요."
      />
      <Card className="memory-search">
        <form className="memory-search-form" onSubmit={submit} role="search">
          <select
            className="input"
            aria-label="Agent"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
          >
            {(agents.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <input
            type="search"
            className="input memory-q"
            aria-label="기억 검색어"
            placeholder={
              mode === 'semantic'
                ? '무엇을 떠올리는지 확인할 문장 — 예: 배송 주소 바꾸는 방법'
                : '포함된 단어 — 예: 환불'
            }
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (!e.target.value) setSearch(null);
            }}
          />
          <div className="segmented" role="group" aria-label="검색 방식">
            <button
              type="button"
              aria-pressed={mode === 'semantic'}
              onClick={() => setMode('semantic')}
            >
              의미
            </button>
            <button
              type="button"
              aria-pressed={mode === 'keyword'}
              onClick={() => setMode('keyword')}
            >
              키워드
            </button>
          </div>
          <Button type="submit" disabled={!text.trim() || !agentId}>
            검색
          </Button>
        </form>
        <Toolbar>
          <select
            className="input"
            aria-label="종류"
            value={type}
            onChange={(e) => setType(e.target.value as MemoryType | '')}
          >
            <option value="">모든 종류</option>
            {(Object.keys(TYPE_LABEL) as MemoryType[]).map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
          <select
            className="input"
            aria-label="범위"
            value={scope}
            onChange={(e) => setScope(e.target.value as MemoryScope | '')}
          >
            <option value="">모든 범위</option>
            <option value="user">사용자별</option>
            <option value="agent">Agent 공통</option>
          </select>
          {searching && (
            <>
              <span className="muted">
                “{search.q}” {search.mode === 'semantic' ? '의미' : '키워드'} 검색 결과{' '}
                {results.data ? `${results.data.length}건` : ''}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setText('');
                  setSearch(null);
                }}
              >
                검색 지우기
              </Button>
            </>
          )}
        </Toolbar>
        {searching && (
          <p className="muted small">
            검색은 활성 기억만 찾아요 — 격리된 기억은 Agent 가 떠올리지 않습니다.
          </p>
        )}
      </Card>

      {!searching && (
        <Tabs<StatusTab>
          label="기억 상태"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'active', label: '활성' },
            { id: 'quarantined', label: '격리됨' },
          ]}
        />
      )}
      {!searching && tab === 'quarantined' && (
        <Notice tone="warn">
          <span>
            숨은 지시문 · 의심스러운 내용이 들어 있어 격리된 기억이에요. Agent 는 격리된 기억을 쓰지
            않아요. 확인한 뒤 격리 해제하거나 삭제하세요.
          </span>
        </Notice>
      )}

      <Card flush>
        <ErrorNotice
          error={searching ? results.error : list.error}
          onRetry={() => void (searching ? results.reload() : list.reload())}
        />
        <MemoryTable
          rows={rows}
          loading={searching ? results.loading : list.loading}
          showScore={searching}
          onOpen={setSelected}
          empty={
            searching ? (
              <Empty title="찾은 기억이 없어요">
                {mode === 'semantic'
                  ? '다른 문장으로 찾거나 키워드 검색을 써 보세요.'
                  : '다른 단어로 찾거나 의미 검색을 써 보세요.'}
              </Empty>
            ) : tab === 'quarantined' ? (
              <Empty title="격리된 기억이 없어요" />
            ) : (
              <Empty title="기억이 없어요">
                작업이 끝나면 Agent 가 기억할 만한 내용을 추려 여기에 저장해요.
              </Empty>
            )
          }
        />
        {!searching && (
          <MoreButton hasMore={list.hasMore} loading={list.moreLoading} onClick={list.loadMore} />
        )}
      </Card>

      {selected && (
        <MemoryDetail memory={selected} onClose={() => setSelected(null)} onChanged={onChanged} />
      )}
    </>
  );
}

function MemoryTable({
  rows,
  loading,
  showScore,
  onOpen,
  empty,
}: {
  rows: MemoryView[];
  loading: boolean;
  showScore: boolean;
  onOpen: (m: MemoryView) => void;
  empty: React.ReactNode;
}) {
  const columns: Column<MemoryView>[] = [
    ...(showScore
      ? [
          {
            key: 'score',
            header: '유사도',
            width: '72px',
            align: 'right' as const,
            render: (m: MemoryView) => (
              <span className="num">{m.score !== undefined ? m.score.toFixed(2) : '—'}</span>
            ),
          },
        ]
      : []),
    {
      key: 'content',
      header: '내용',
      render: (m) => (
        <div className="memory-content">
          <div className="row memory-flags">
            <Badge tone={TYPE_TONE[m.type]}>{TYPE_LABEL[m.type]}</Badge>
            {m.pinned && <Badge tone="neutral">고정</Badge>}
            {m.status === 'quarantined' && <Badge tone="danger">격리</Badge>}
            {m.needsVerification && <Badge tone="warning">검증 필요</Badge>}
          </div>
          {m.title && <p className="memory-title">{m.title}</p>}
          <p className="memory-text">{m.content}</p>
          {m.status === 'quarantined' && m.quarantineReason && (
            <p className="memory-quarantine">격리 사유: {m.quarantineReason}</p>
          )}
        </div>
      ),
    },
    {
      key: 'scope',
      header: '범위',
      width: '120px',
      render: (m) =>
        m.scope === 'user' ? (
          <span className="ident">
            <Mono>{m.endUserPseudonym ?? pseudonym(m.endUserId)}</Mono>
          </span>
        ) : (
          <span>Agent 공통</span>
        ),
    },
    {
      key: 'confidence',
      header: '확신도',
      width: '80px',
      align: 'right',
      render: (m) => <span className="num">{formatPercent(m.confidence, 0)}</span>,
    },
    {
      key: 'uses',
      header: '사용',
      width: '110px',
      render: (m) => (
        <div>
          <span className="num">{m.useCount}회</span>
          <div className="cell-sub">
            {m.lastUsedAt ? <Time iso={m.lastUsedAt} /> : '아직 안 씀'}
          </div>
        </div>
      ),
    },
    {
      key: 'source',
      header: '출처',
      width: '150px',
      render: (m) => (
        <div>
          <span>{SOURCE_LABEL[m.source.type] ?? m.source.type}</span>
          <div className="cell-sub">
            {m.source.taskIds.length > 0 ? `작업 ${m.source.taskIds.length}건` : '—'}
          </div>
        </div>
      ),
    },
    {
      key: 'expires',
      header: '보존',
      width: '120px',
      render: (m) => <span className="cell-sub">{untilLabel(m.expiresAt, m.pinned)}</span>,
    },
  ];
  return (
    <div className="wide-table memory-table">
      <DataTable
        label="기억 목록"
        columns={columns}
        rows={rows}
        rowKey={(m) => m.id}
        loading={loading}
        onRowClick={onOpen}
        empty={empty}
      />
    </div>
  );
}

/* ───────────── 상세 · 조치 ───────────── */

function MemoryDetail({
  memory,
  onClose,
  onChanged,
}: {
  memory: MemoryView;
  onClose: () => void;
  onChanged: (updated: MemoryView | null, removedId?: string) => void;
}) {
  const api = useApi();
  const { can } = useAuth();
  const toast = useToast();
  const admin = can('admin');
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(memory.title ?? '');
  const [content, setContent] = useState(memory.content);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmErase, setConfirmErase] = useState(false);

  // 검색 결과에는 격리 사유가 없어 상세를 다시 받는다
  const detail = useQuery(
    () => api.get<MemoryView>(`/v1/admin/memories/${memory.id}`),
    [memory.id],
  );
  const m: MemoryView = { ...memory, ...detail.data, score: memory.score };

  useEffect(() => {
    setTitle(m.title ?? '');
    setContent(m.content);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.id, m.title, m.content]);

  const update = useAction((body: { title?: string | null; content?: string }) =>
    api.patch<MemoryView>(`/v1/admin/memories/${m.id}`, body),
  );
  const pin = useAction((pinned: boolean) =>
    api.post<MemoryView>(`/v1/admin/memories/${m.id}/pin`, { pinned }),
  );
  const release = useAction(() => api.post<MemoryView>(`/v1/admin/memories/${m.id}/release`));
  const remove = useAction(async () => {
    await api.delete(`/v1/admin/memories/${m.id}`);
    return m.id;
  });
  const error = update.error ?? pin.error ?? release.error;

  const apply = (updated: MemoryView | undefined, message: string) => {
    if (!updated) return;
    detail.setData(updated);
    onChanged(updated);
    toast(message);
  };

  const saveEdit = async () => {
    const body: { title?: string | null; content?: string } = {};
    if ((m.title ?? '') !== title.trim()) body.title = title.trim() || null;
    if (m.content !== content.trim()) body.content = content.trim();
    if (Object.keys(body).length === 0) {
      setEditing(false);
      return;
    }
    const updated = await update.run(body);
    if (updated) {
      setEditing(false);
      apply(updated, body.content ? '내용을 바꾸고 다시 임베딩했어요' : '제목을 바꿨어요');
    }
  };

  return (
    <>
      <Modal
        open
        wide
        title="기억 상세"
        onClose={onClose}
        footer={
          <>
            {admin && !editing && (
              <>
                <Button variant="destructive" onClick={() => setConfirmDelete(true)}>
                  삭제
                </Button>
                <span className="spacer" />
                {m.status === 'quarantined' && (
                  <Button
                    variant="outline"
                    loading={release.pending}
                    onClick={() =>
                      void release
                        .run()
                        .then((u) => apply(u, '격리를 해제했어요 — 이제 Agent 가 씁니다'))
                    }
                  >
                    격리 해제
                  </Button>
                )}
                <Button
                  variant="outline"
                  loading={pin.pending}
                  onClick={() =>
                    void pin
                      .run(!m.pinned)
                      .then((u) =>
                        apply(u, m.pinned ? '고정을 풀었어요' : '고정했어요 — 만료되지 않아요'),
                      )
                  }
                >
                  {m.pinned ? '고정 해제' : '고정'}
                </Button>
                <Button onClick={() => setEditing(true)}>편집</Button>
              </>
            )}
            {admin && editing && (
              <>
                <Button
                  variant="outline"
                  onClick={() => {
                    setEditing(false);
                    setTitle(m.title ?? '');
                    setContent(m.content);
                    update.reset();
                  }}
                >
                  취소
                </Button>
                <Button
                  loading={update.pending}
                  disabled={!content.trim()}
                  onClick={() => void saveEdit()}
                >
                  저장
                </Button>
              </>
            )}
            {!admin && (
              <Button variant="outline" onClick={onClose}>
                닫기
              </Button>
            )}
          </>
        }
      >
        <div className="stack">
          <div className="row">
            <Badge tone={TYPE_TONE[m.type]}>{TYPE_LABEL[m.type]}</Badge>
            {m.status === 'quarantined' ? (
              <Badge tone="danger">격리됨</Badge>
            ) : (
              <Badge tone="success">활성</Badge>
            )}
            {m.pinned && <Badge>고정</Badge>}
            {m.needsVerification && <Badge tone="warning">검증 필요</Badge>}
            {m.score !== undefined && (
              <span className="muted small">유사도 {m.score.toFixed(3)}</span>
            )}
          </div>
          {m.status === 'quarantined' && (
            <Notice tone="warn">
              <span>격리 사유: {m.quarantineReason ?? '알 수 없음'}</span>
            </Notice>
          )}
          {editing ? (
            <>
              <Field label="제목" hint="60자 이내 (비우면 제목 없음)">
                <input
                  className="input"
                  value={title}
                  maxLength={60}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </Field>
              <Field
                label="내용"
                hint="내용을 바꾸면 저장할 때 다시 임베딩해요 (1,000자 이내)"
                required
              >
                <textarea
                  className="input"
                  rows={5}
                  maxLength={1000}
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                />
              </Field>
            </>
          ) : (
            <div className="memory-detail-body">
              {m.title && <p className="memory-title">{m.title}</p>}
              <p className="memory-detail-text">{m.content}</p>
            </div>
          )}
          <ErrorNotice error={error} />
          <KeyValue
            items={[
              [
                '범위',
                m.scope === 'user' ? (
                  <span className="row">
                    사용자별 <Mono>{m.endUserPseudonym ?? pseudonym(m.endUserId)}</Mono>
                    {admin && m.endUserId && (
                      <Button size="sm" variant="ghost" onClick={() => setConfirmErase(true)}>
                        이 사용자 데이터 삭제
                      </Button>
                    )}
                  </span>
                ) : (
                  'Agent 공통 — 모든 사용자 대화에 쓰여요'
                ),
              ],
              [
                '확신도',
                `${formatPercent(m.confidence, 0)}${m.needsVerification ? ' · 검증 필요' : ''}`,
              ],
              ['출처', SOURCE_LABEL[m.source.type] ?? m.source.type],
              [
                '출처 작업',
                m.source.taskIds.length > 0 ? (
                  <span className="source-links">
                    {m.source.taskIds.map((id) => (
                      <Link key={id} to={`/tasks/${id}`}>
                        <Mono title={id}>{id.slice(0, 8)}</Mono>
                      </Link>
                    ))}
                  </span>
                ) : (
                  '—'
                ),
              ],
              [
                '출처 대화',
                m.source.conversationId ? (
                  <Link to={`/conversations/${m.source.conversationId}`}>대화 보기</Link>
                ) : (
                  '—'
                ),
              ],
              [
                '사용',
                `${m.useCount}회${m.lastUsedAt ? ` · 마지막 ${formatDateTime(m.lastUsedAt)}` : ''}`,
              ],
              ['저장', formatDateTime(m.createdAt)],
              [
                '보존',
                m.pinned
                  ? '고정 — 만료 없음'
                  : m.expiresAt
                    ? `${formatDateTime(m.expiresAt)} 까지`
                    : '만료 없음',
              ],
              ['ID', <Mono>{m.id}</Mono>],
            ]}
          />
          {!admin && <p className="muted small">기억을 바꾸거나 지우려면 Admin 권한이 필요해요.</p>}
        </div>
      </Modal>
      <ConfirmModal
        open={confirmDelete}
        title="기억 삭제"
        confirmLabel="삭제"
        danger
        pending={remove.pending}
        error={remove.error}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() =>
          void remove.run().then((id) => {
            if (!id) return;
            setConfirmDelete(false);
            onChanged(null, id);
            toast('기억을 삭제했어요');
          })
        }
        body={
          <p>
            이 기억을 지울까요? Agent 는 다음 작업부터 이 내용을 떠올리지 않아요. 되돌릴 수 없어요.
          </p>
        }
      />
      {confirmErase && m.endUserId && (
        <EraseUserModal
          endUserId={m.endUserId}
          name={m.endUserPseudonym ?? pseudonym(m.endUserId)}
          onClose={() => setConfirmErase(false)}
          onErased={() => {
            setConfirmErase(false);
            onChanged(null, m.id);
          }}
        />
      )}
    </>
  );
}

/** 사용자 데이터 삭제 — 가명을 그대로 입력해야 실행 (되돌릴 수 없음) */
function EraseUserModal({
  endUserId,
  name,
  onClose,
  onErased,
}: {
  endUserId: string;
  name: string;
  onClose: () => void;
  onErased: () => void;
}) {
  const api = useApi();
  const toast = useToast();
  const [typed, setTyped] = useState('');
  const erase = useAction(() =>
    api.post<{ endUserId: string; erased: { memories: number; conversations: number } }>(
      `/v1/admin/end-users/${endUserId}/erase`,
    ),
  );
  return (
    <Modal
      open
      title="사용자 데이터 삭제"
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            취소
          </Button>
          <Button
            variant="destructive"
            loading={erase.pending}
            disabled={typed.trim() !== name}
            onClick={() =>
              void erase.run().then((r) => {
                if (!r) return;
                toast(
                  `삭제했어요 — 기억 ${r.erased.memories}건 · 대화 ${r.erased.conversations}건`,
                );
                onErased();
              })
            }
          >
            영구 삭제
          </Button>
        </>
      }
    >
      <div className="stack">
        <Notice tone="error">
          <span>
            <Mono>{name}</Mono> 사용자의 기억 · 대화 · 작업 · 산출물 · 피드백을 모두 지우고 외부 ID
            연결을 끊어요. 같은 사람이 다시 오면 새 사용자로 시작합니다. 되돌릴 수 없어요.
          </span>
        </Notice>
        <p className="muted small">
          삭제 기록은 감사 로그에 남아요 (지운 건수만, 내용은 남기지 않음).
        </p>
        <Field label={`확인을 위해 ${name} 을(를) 입력하세요`} required>
          <input
            className="input mono-input"
            value={typed}
            autoComplete="off"
            onChange={(e) => setTyped(e.target.value)}
          />
        </Field>
        <ErrorNotice error={erase.error} />
      </div>
    </Modal>
  );
}
