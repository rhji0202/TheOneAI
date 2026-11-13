/**
 * C-09 위젯 설치 · 테마 — 설치 코드, 사용자 연동(서명 토큰), 허용 도메인, 테마 · 동작, 미리보기, Secret 재발급.
 * 설정은 bootstrap 이 매번 읽으므로 저장하면 바로 고객사 페이지의 위젯에 반영된다.
 * API: GET /v1/admin/widget-configs · PATCH /:id (Admin) · POST /:id/rotate-secret (Owner)
 */
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../api';
import { useApi, useAuth } from '../auth';
import {
  Badge,
  Button,
  Card,
  CodeBlock,
  ConfirmModal,
  CopyButton,
  Empty,
  ErrorNotice,
  Field,
  Loading,
  Modal,
  Mono,
  Notice,
  PageHeader,
  Time,
  Toggle,
  useAction,
  useQuery,
  useToast,
} from '../ui';
import './agents.css';
import './widget-settings.css';

/* ───────────── API 타입 (src/widget/admin/widget-configs-admin.service.ts) ───────────── */

type Position = 'bottom-right' | 'bottom-left';
type DarkMode = 'system' | 'light' | 'dark';
type IdentityMode = 'anonymous' | 'signed_token';

interface Theme {
  brandColor: string;
  position: Position;
  darkMode: DarkMode;
}

interface Behavior {
  autoOpen: boolean;
  language: string;
  attachments: { types: string[]; maxMb: number };
  noticeText: string;
  showPoweredBy: boolean;
}

interface WidgetConfig {
  id: string;
  name: string;
  agentId: string;
  agentName: string;
  publicKey: string;
  allowedOrigins: string[];
  identityMode: IdentityMode;
  enabled: boolean;
  theme: Theme;
  behavior: Behavior;
  previousSecretExpiresAt: string | null;
  updatedAt: string;
}

interface RotateResult {
  widget: WidgetConfig;
  secret: string;
  previousSecretExpiresAt: string;
}

interface AgentListItem {
  id: string;
  name: string;
  publishedVersion: number | null;
}

interface AgentDetail {
  id: string;
  name: string;
  published: { welcomeMessage: string } | null;
  draft: { welcomeMessage: string } | null;
}

type Form = Pick<
  WidgetConfig,
  'name' | 'agentId' | 'allowedOrigins' | 'identityMode' | 'enabled' | 'theme' | 'behavior'
>;

const toForm = (w: WidgetConfig): Form => ({
  name: w.name,
  agentId: w.agentId,
  allowedOrigins: [...w.allowedOrigins],
  identityMode: w.identityMode,
  enabled: w.enabled,
  theme: { ...w.theme },
  behavior: {
    ...w.behavior,
    attachments: { ...w.behavior.attachments, types: [...w.behavior.attachments.types] },
  },
});

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const FIELD_LABEL: Record<string, string> = {
  name: '이름',
  agentId: 'Agent',
  allowedOrigins: '허용 도메인',
  identityMode: '사용자 연동',
  enabled: '사용 여부',
  theme: '테마',
  behavior: '동작',
};

/* ───────────── 색 대비 (위젯 App.tsx 의 contrast() 와 같은 계산) ───────────── */

const DARK_TEXT = '#16181D';

/** WCAG 대비 — 브랜드 색 위 글자색 자동 보정 */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const n = hex.replace('#', '');
    const rgb = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
    const [r, g, bl] = rgb.map((c) =>
      c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
    ) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const onBrandOf = (brand: string) =>
  HEX.test(brand) && contrast(brand, '#FFFFFF') < 4.5 ? DARK_TEXT : '#FFFFFF';

const SWATCHES = [
  '#4F46E5',
  '#2563EB',
  '#0F766E',
  '#15803D',
  '#EA580C',
  '#E11D48',
  '#7C3AED',
  '#111827',
];

/* ───────────── 허용 도메인 ───────────── */

/** 서버 검증(src/widget/admin/widget-configs-admin.service.ts originSchema)과 같은 규칙 */
function checkOrigin(raw: string): { value: string; error: string | null } {
  const value = raw.trim().replace(/\/$/, '').toLowerCase();
  if (!value) return { value, error: '도메인을 입력하세요' };
  if (/^https?:\/\/\*\.[a-z0-9.-]+(:\d+)?$/.test(value)) return { value, error: null };
  if (value.includes('*'))
    return {
      value,
      error: '와일드카드는 https://*.example.com 처럼 맨 앞 서브도메인 한 단계만 돼요',
    };
  let origin: string | null = null;
  try {
    const url = new URL(value);
    origin = url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    origin = null;
  }
  if (!origin)
    return { value, error: 'https://도메인 형식으로 입력하세요 (예: https://shop.example.com)' };
  if (origin !== value)
    return {
      value,
      error: `경로 · 기본 포트 없이 출처만 입력하세요 → ${origin}`,
    };
  return { value, error: null };
}

function originNotes(origin: string): { label: string; tone: 'warning' | 'info' | 'neutral' }[] {
  const notes: { label: string; tone: 'warning' | 'info' | 'neutral' }[] = [];
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
  if (local) notes.push({ label: '개발용', tone: 'neutral' });
  else if (origin.startsWith('http://'))
    notes.push({ label: 'http — 운영에서는 https', tone: 'warning' });
  if (origin.includes('*')) notes.push({ label: '서브도메인 한 단계', tone: 'info' });
  return notes;
}

/* ───────────── 첨부 형식 ───────────── */

const ATTACHMENT_PRESETS: [string, string][] = [
  ['application/pdf', 'PDF'],
  ['image/png', 'PNG'],
  ['image/jpeg', 'JPEG'],
  ['image/*', '이미지 전체'],
  ['text/csv', 'CSV'],
  ['text/plain', '텍스트'],
  ['application/json', 'JSON'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Excel (xlsx)'],
];
const MIME = /^[a-z]+\/([a-z0-9.+-]+|\*)$/i;

const LANGUAGES: [string, string][] = [
  ['auto', '자동 (방문자 브라우저 언어)'],
  ['ko', '한국어'],
  ['en', 'English'],
  ['ja', '日本語'],
  ['zh-CN', '中文 (简体)'],
];

/* ───────────── 페이지 ───────────── */

export function WidgetSettingsPage() {
  const api = useApi();
  const { can } = useAuth();
  const toast = useToast();
  const canEdit = can('admin');
  const canRotate = can('owner');

  const configs = useQuery(() => api.get<WidgetConfig[]>('/v1/admin/widget-configs'), []);
  const agents = useQuery(() => api.get<AgentListItem[]>('/v1/admin/agents'), []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const widget = configs.data?.find((w) => w.id === selectedId) ?? configs.data?.[0] ?? null;
  const baseForm = useMemo(() => (widget ? toForm(widget) : null), [widget]);
  const [form, setForm] = useState<Form | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [rotateOpen, setRotateOpen] = useState(false);
  const [newSecret, setNewSecret] = useState<RotateResult | null>(null);

  useEffect(() => {
    setForm(baseForm);
    setIssues({});
  }, [baseForm]);

  const agentId = form?.agentId ?? widget?.agentId;
  const agent = useQuery(() => api.get<AgentDetail>(`/v1/admin/agents/${agentId}`), [agentId], {
    enabled: Boolean(agentId),
  });

  const changed = useMemo(
    () =>
      form && baseForm
        ? (Object.keys(FIELD_LABEL) as (keyof Form)[]).filter((k) => !same(form[k], baseForm[k]))
        : [],
    [form, baseForm],
  );
  const dirty = changed.length > 0;

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const replace = (updated: WidgetConfig) =>
    configs.setData((prev) => (prev ?? []).map((w) => (w.id === updated.id ? updated : w)));

  const save = useAction(async () => {
    if (!form || !baseForm || !widget) return;
    const local: Record<string, string> = {};
    if (!form.name.trim()) local.name = '이름을 입력하세요';
    if (!HEX.test(form.theme.brandColor)) local['theme.brandColor'] = '#RRGGBB 형식이어야 합니다';
    const mb = form.behavior.attachments.maxMb;
    if (!Number.isInteger(mb) || mb < 1 || mb > 50)
      local['behavior.attachments'] = '최대 크기는 1 ~ 50MB';
    if (form.behavior.noticeText.trim().length > 200)
      local['behavior.noticeText'] = '200자 이하로 입력하세요';
    if (Object.keys(local).length) {
      setIssues(local);
      throw new Error('입력값을 확인해 주세요');
    }
    const patch: Record<string, unknown> = {};
    if (form.name.trim() !== baseForm.name) patch.name = form.name.trim();
    if (form.agentId !== baseForm.agentId) patch.agentId = form.agentId;
    if (!same(form.allowedOrigins, baseForm.allowedOrigins))
      patch.allowedOrigins = form.allowedOrigins;
    if (form.identityMode !== baseForm.identityMode) patch.identityMode = form.identityMode;
    if (form.enabled !== baseForm.enabled) patch.enabled = form.enabled;
    const theme = changedKeys(form.theme, baseForm.theme);
    if (theme) patch.theme = theme;
    const behavior = changedKeys(form.behavior, baseForm.behavior);
    if (behavior)
      patch.behavior = {
        ...behavior,
        ...(behavior.noticeText !== undefined
          ? { noticeText: form.behavior.noticeText.trim() }
          : {}),
      };
    try {
      const updated = await api.patch<WidgetConfig>(`/v1/admin/widget-configs/${widget.id}`, patch);
      replace(updated);
      toast('저장했어요 — 위젯을 새로 열면 바로 적용돼요');
    } catch (err) {
      if (err instanceof ApiError && Array.isArray(err.body.errors)) {
        const mapped: Record<string, string> = {};
        for (const e of err.body.errors as Array<{ path?: string; message?: string }>) {
          const path = e.path ?? 'general';
          const key = path.startsWith('allowedOrigins') ? 'allowedOrigins' : path;
          mapped[key] = mapped[key] ?? e.message ?? '값이 올바르지 않습니다';
        }
        setIssues(mapped);
      }
      throw err;
    }
  });

  const rotate = useAction(async () => {
    if (!widget) return;
    const result = await api.post<RotateResult>(
      `/v1/admin/widget-configs/${widget.id}/rotate-secret`,
    );
    replace(result.widget);
    setRotateOpen(false);
    setNewSecret(result);
  });

  if (configs.error && !configs.data) {
    return (
      <>
        <PageHeader title="위젯 설치 · 테마" />
        <ErrorNotice error={configs.error} onRetry={configs.reload} />
      </>
    );
  }
  if (!configs.data) return <Loading />;
  if (!widget || !form || !baseForm) {
    return (
      <>
        <PageHeader title="위젯 설치 · 테마" />
        <Empty title="위젯 설정이 없어요" />
      </>
    );
  }

  const update = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const setTheme = (patch: Partial<Theme>) =>
    setForm((f) => (f ? { ...f, theme: { ...f.theme, ...patch } } : f));
  const setBehavior = (patch: Partial<Behavior>) =>
    setForm((f) => (f ? { ...f, behavior: { ...f.behavior, ...patch } } : f));
  const agentName = agents.data?.find((a) => a.id === form.agentId)?.name ?? widget.agentName;
  const welcome = (agent.data?.published ?? agent.data?.draft)?.welcomeMessage ?? '';

  return (
    <div className="ws-page">
      <PageHeader
        title="위젯 설치 · 테마"
        description="고객사 페이지에 로더 한 줄을 넣으면 위젯이 열립니다. 저장한 설정은 위젯을 새로 열 때 바로 반영돼요."
        meta={
          <>
            {baseForm.enabled ? (
              <Badge tone="success">사용 중</Badge>
            ) : (
              <Badge tone="danger">꺼짐</Badge>
            )}
            <Badge tone="info">
              {baseForm.identityMode === 'signed_token' ? '로그인 사용자 연동' : '익명'}
            </Badge>
            <span>
              <Time iso={widget.updatedAt} /> 변경
            </span>
          </>
        }
        actions={
          configs.data.length > 1 ? (
            <select
              className="input ws-select"
              aria-label="위젯 선택"
              value={widget.id}
              onChange={(e) => {
                if (
                  dirty &&
                  !window.confirm('저장하지 않은 변경이 사라져요. 다른 위젯으로 바꿀까요?')
                )
                  return;
                setSelectedId(e.target.value);
              }}
            >
              {configs.data.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          ) : undefined
        }
      />

      {!canEdit && (
        <Notice tone="info">보기 전용이에요. 설정을 바꾸려면 Admin 이상 역할이 필요해요.</Notice>
      )}
      {!baseForm.enabled && (
        <Notice tone="warn">
          위젯이 꺼져 있어요 — 고객사 페이지에 코드가 있어도 위젯이 보이지 않아요.
        </Notice>
      )}
      {issues.general && <Notice tone="error">{issues.general}</Notice>}

      <div className="ws-layout">
        <fieldset className="ws-main" disabled={!canEdit}>
          <Card title="기본">
            <div className="ws-grid-2">
              <Field label="이름" required error={issues.name} hint="콘솔에서만 보이는 이름">
                <input
                  className="input"
                  maxLength={100}
                  value={form.name}
                  onChange={(e) => update({ name: e.target.value })}
                />
              </Field>
              <Field
                label="연결할 Agent"
                error={issues.agentId}
                hint={
                  <>
                    인사말 · 추천 작업은 <Link to={`/agents/${form.agentId}`}>Agent 설정</Link>의
                    환영 문구와 허용된 Skill 에서 만들어져요
                  </>
                }
              >
                <select
                  className="input"
                  value={form.agentId}
                  onChange={(e) => update({ agentId: e.target.value })}
                >
                  {(
                    agents.data ?? [
                      { id: widget.agentId, name: widget.agentName, publishedVersion: null },
                    ]
                  ).map((a) => (
                    <option
                      key={a.id}
                      value={a.id}
                      disabled={a.publishedVersion === null && a.id !== widget.agentId}
                    >
                      {a.name}
                      {a.publishedVersion !== null ? ` (v${a.publishedVersion})` : ' (배포 안 됨)'}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Toggle
              checked={form.enabled}
              onChange={(enabled) => update({ enabled })}
              label="위젯 사용 — 끄면 모든 페이지에서 위젯이 숨겨지고 새 대화를 받지 않아요"
            />
          </Card>

          <InstallCard widget={widget} identityMode={form.identityMode} />

          <IdentityCard
            widget={widget}
            mode={form.identityMode}
            baseMode={baseForm.identityMode}
            onChange={(identityMode) => update({ identityMode })}
            canRotate={canRotate}
            onRotate={() => {
              rotate.reset();
              setRotateOpen(true);
            }}
          />

          <OriginsCard
            origins={form.allowedOrigins}
            onChange={(allowedOrigins) => update({ allowedOrigins })}
            serverError={issues.allowedOrigins}
          />

          <ThemeCard theme={form.theme} onChange={setTheme} error={issues['theme.brandColor']} />

          <BehaviorCard behavior={form.behavior} onChange={setBehavior} issues={issues} />
        </fieldset>

        <aside className="ws-side" aria-label="미리보기">
          <WidgetPreview
            theme={form.theme}
            behavior={form.behavior}
            agentName={agentName}
            welcome={welcome}
          />
        </aside>
      </div>

      {canEdit && dirty && (
        <div className="cfg-save-bar" role="region" aria-label="저장">
          <span className="cfg-save-bar-text">
            <span className="cfg-dirty-dot" aria-hidden="true" />
            저장하지 않은 변경 · {changed.map((k) => FIELD_LABEL[k]).join(', ')}
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
          <Button variant="primary" loading={save.pending} onClick={() => void save.run()}>
            저장
          </Button>
        </div>
      )}

      <ConfirmModal
        open={rotateOpen}
        title="Widget Secret 을 재발급할까요?"
        body={
          <div className="cfg-modal-text">
            <p>
              새 Secret 을 만들면 지금 Secret 은 <b>24시간 동안만</b> 함께 허용돼요.
            </p>
            <p>그 안에 고객사 서버의 환경 변수(예: THEONEAI_WIDGET_SECRET)를 새 값으로 바꾸세요.</p>
            <p className="muted">
              새 값은 재발급 직후 한 번만 보여 드려요. Secret 이 노출됐다면 바로 재발급하세요.
            </p>
          </div>
        }
        confirmLabel="재발급"
        danger
        pending={rotate.pending}
        error={rotate.error}
        onConfirm={() => void rotate.run()}
        onClose={() => setRotateOpen(false)}
      />
      <SecretModal result={newSecret} onClose={() => setNewSecret(null)} />
    </div>
  );
}

function changedKeys<T extends object>(next: T, prev: T): Partial<T> | null {
  const out: Partial<T> = {};
  for (const k of Object.keys(next) as (keyof T)[]) {
    if (!same(next[k], prev[k])) out[k] = next[k];
  }
  return Object.keys(out).length ? out : null;
}

/* ───────────── 설치 코드 ───────────── */

function InstallCard({
  widget,
  identityMode,
}: {
  widget: WidgetConfig;
  identityMode: IdentityMode;
}) {
  const loader = `${window.location.origin}/widget/v1/loader.js`;
  const tag = `<script src="${loader}" data-widget-key="${widget.publicKey}" async></script>`;
  const signed = `<script>
  // 로그인한 사용자의 identity token 을 고객사 서버에서 받아 온다 (로더보다 먼저)
  window.TheOneAISettings = {
    getIdentityToken: () =>
      fetch('/api/theoneai-token', { credentials: 'include' }).then((r) => (r.ok ? r.text() : null)),
  };
</script>
${tag}`;
  return (
    <Card
      title="설치 코드"
      description="고객사 페이지의 </body> 바로 앞에 붙여 넣으세요. 위젯은 Shadow DOM 안에 그려져 페이지 CSS 와 섞이지 않아요."
    >
      <ol className="ws-steps">
        <li>
          <b>허용 도메인</b>에 위젯을 넣을 사이트 주소를 등록합니다.
        </li>
        <li>아래 코드를 페이지에 붙여 넣습니다.</li>
        {identityMode === 'signed_token' && (
          <li>
            고객사 서버에 <b>identity token 발급 API</b>를 만듭니다 (아래 사용자 연동).
          </li>
        )}
      </ol>
      <CodeBlock code={identityMode === 'signed_token' ? signed : tag} label="HTML" />
      <div className="ws-key-row">
        <span className="muted">공개 키</span>
        <Mono>{widget.publicKey}</Mono>
        <CopyButton text={widget.publicKey} />
        <span className="field-hint">
          페이지에 노출돼도 괜찮아요 — 허용 도메인
          {identityMode === 'signed_token' ? ' · 서명 토큰' : ''}으로 보호돼요.
        </span>
      </div>
      {identityMode === 'signed_token' && (
        <p className="field-hint ws-after">
          로그인 · 로그아웃 뒤에는 <Mono>{'window.TheOneAI.identify({ token })'}</Mono> 또는{' '}
          <Mono>window.TheOneAI.destroy()</Mono> 를 부르세요.
        </p>
      )}
    </Card>
  );
}

/* ───────────── 사용자 연동 ───────────── */

function IdentityCard({
  widget,
  mode,
  baseMode,
  onChange,
  canRotate,
  onRotate,
}: {
  widget: WidgetConfig;
  mode: IdentityMode;
  baseMode: IdentityMode;
  onChange: (mode: IdentityMode) => void;
  canRotate: boolean;
  onRotate: () => void;
}) {
  const server = `// 고객사 서버 (Node.js · Express) — npm install jose
import { SignJWT } from 'jose';

// 콘솔에서 발급한 Widget Secret — 서버 환경 변수에만 두고 브라우저로 보내지 않는다
const widgetSecret = new TextEncoder().encode(process.env.THEONEAI_WIDGET_SECRET);

app.get('/api/theoneai-token', requireLogin, async (req, res) => {
  const token = await new SignJWT({ name: req.user.displayName }) // 선택: 표시 이름
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(String(req.user.id)) // 고객사 사용자 ID — 대화 · 기억이 이 값으로 묶여요
    .setAudience('${widget.publicKey}') // 이 위젯의 공개 키
    .setIssuedAt()
    .setExpirationTime('5m') // 수명은 최대 10분
    .sign(widgetSecret);
  res.set('Cache-Control', 'no-store').type('text/plain').send(token);
});`;
  return (
    <Card title="사용자 연동" description="위젯 사용자를 어떻게 구분할지 정합니다.">
      <div className="ws-mode-grid" role="radiogroup" aria-label="사용자 연동 방식">
        <ModeOption
          checked={mode === 'signed_token'}
          onSelect={() => onChange('signed_token')}
          title="로그인 사용자 연동 (권장)"
          description="고객사 서버가 서명한 identity token 으로 사용자를 확인해요. 로그인하지 않은 방문자에게는 위젯이 보이지 않아요."
        />
        <ModeOption
          checked={mode === 'anonymous'}
          onSelect={() => onChange('anonymous')}
          title="익명"
          description="로그인 없이 브라우저마다 익명 ID 를 만들어요. 기기 · 브라우저가 바뀌면 다른 사용자로 봐요."
        />
      </div>
      {mode !== baseMode && (
        <Notice tone="warn">
          {mode === 'anonymous'
            ? '익명으로 바꾸면 허용 도메인의 방문자 누구나 대화를 시작할 수 있어요. 개인 정보가 필요한 Tool 은 쓰지 마세요.'
            : '저장하는 순간부터 identity token 이 없는 방문자에게는 위젯이 보이지 않아요. 고객사 서버의 토큰 발급 API 를 먼저 준비하세요.'}
        </Notice>
      )}
      {mode === 'signed_token' && (
        <>
          <ul className="ws-rules">
            <li>
              HS256 으로 서명하고 <Mono>aud</Mono> = 공개 키, <Mono>sub</Mono> · <Mono>iat</Mono> ·{' '}
              <Mono>exp</Mono> 를 넣어요. 수명은 10분 이하.
            </li>
            <li>
              <Mono>sub</Mono> 는 바뀌지 않는 고객사 사용자 ID 를 쓰세요. 콘솔에는
              가명(user_xxxx)으로만 보여요.
            </li>
            <li>
              Widget Secret 은 고객사 서버에만 두세요. 브라우저 코드 · 저장소에 넣으면 누구나 다른
              사용자로 위장할 수 있어요.
            </li>
          </ul>
          <CodeBlock code={server} label="고객사 서버 예시 — identity token 발급" />
        </>
      )}
      <div className="ws-secret">
        <div>
          <p className="ws-secret-title">Widget Secret</p>
          <p className="field-hint">
            Secret 저장소에만 보관돼 콘솔에서도 다시 볼 수 없어요. 잃어버렸거나 노출됐다면
            재발급하세요.
          </p>
          {widget.previousSecretExpiresAt && (
            <p className="ws-secret-grace">
              이전 Secret 도 <Time iso={widget.previousSecretExpiresAt} absolute /> 까지 함께
              허용돼요.
            </p>
          )}
        </div>
        {canRotate ? (
          <Button variant="danger" onClick={onRotate}>
            Secret 재발급
          </Button>
        ) : (
          <span className="field-hint">재발급은 Owner 만 할 수 있어요</span>
        )}
      </div>
    </Card>
  );
}

function ModeOption({
  checked,
  onSelect,
  title,
  description,
}: {
  checked: boolean;
  onSelect: () => void;
  title: string;
  description: string;
}) {
  return (
    <label className={checked ? 'ws-mode checked' : 'ws-mode'}>
      <input type="radio" name="identity-mode" checked={checked} onChange={onSelect} />
      <span>
        <span className="ws-mode-title">{title}</span>
        <span className="ws-mode-desc">{description}</span>
      </span>
    </label>
  );
}

function SecretModal({ result, onClose }: { result: RotateResult | null; onClose: () => void }) {
  const [saved, setSaved] = useState(false);
  useEffect(() => setSaved(false), [result]);
  return (
    <Modal
      open={!!result}
      title="새 Widget Secret"
      onClose={() => saved && onClose()}
      footer={
        <Button variant="primary" disabled={!saved} onClick={onClose}>
          닫기
        </Button>
      }
    >
      <Notice tone="warn">
        이 창을 닫으면 다시 볼 수 없어요. 지금 복사해 고객사 서버의 환경 변수에 저장하세요.
      </Notice>
      {result && <CodeBlock code={result.secret} label="THEONEAI_WIDGET_SECRET" />}
      {result && (
        <p className="field-hint ws-after">
          이전 Secret 은 <Time iso={result.previousSecretExpiresAt} absolute /> 까지 함께 허용돼요.
        </p>
      )}
      <label className="check ws-after">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        안전한 곳에 저장했어요
      </label>
    </Modal>
  );
}

/* ───────────── 허용 도메인 ───────────── */

function OriginsCard({
  origins,
  onChange,
  serverError,
}: {
  origins: string[];
  onChange: (origins: string[]) => void;
  serverError?: string;
}) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = () => {
    const { value, error: err } = checkOrigin(draft);
    if (err) return setError(err);
    if (origins.includes(value)) return setError('이미 있는 도메인이에요');
    if (origins.length >= 50) return setError('50개까지 등록할 수 있어요');
    onChange([...origins, value]);
    setDraft('');
    setError(null);
  };
  return (
    <Card
      title="허용 도메인"
      description="여기 있는 출처(스킴 · 호스트 · 포트가 정확히 같은 주소)에서만 위젯이 열려요. 경로는 넣지 않아요."
    >
      {origins.length === 0 && (
        <Notice tone="warn">허용 도메인이 없으면 어떤 사이트에서도 위젯이 열리지 않아요.</Notice>
      )}
      {serverError && <Notice tone="error">{serverError}</Notice>}
      <ul className="ws-origins" aria-label="허용 도메인 목록">
        {origins.map((o) => (
          <li key={o}>
            <Mono>{o}</Mono>
            {originNotes(o).map((n) => (
              <Badge key={n.label} tone={n.tone}>
                {n.label}
              </Badge>
            ))}
            <span className="spacer" />
            <Button
              size="sm"
              variant="ghost"
              aria-label={`${o} 삭제`}
              onClick={() => onChange(origins.filter((x) => x !== o))}
            >
              삭제
            </Button>
          </li>
        ))}
      </ul>
      <div className="ws-origin-add">
        <Field
          label="도메인 추가"
          error={error}
          hint="예: https://shop.example.com · 서브도메인 전체는 https://*.example.com (한 단계만)"
        >
          <input
            className="input cfg-mono-input"
            value={draft}
            placeholder="https://"
            aria-invalid={!!error || undefined}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
          />
        </Field>
        <Button onClick={add} disabled={!draft.trim()}>
          추가
        </Button>
      </div>
    </Card>
  );
}

/* ───────────── 테마 ───────────── */

function ThemeCard({
  theme,
  onChange,
  error,
}: {
  theme: Theme;
  onChange: (patch: Partial<Theme>) => void;
  error?: string;
}) {
  const [hex, setHex] = useState(theme.brandColor);
  useEffect(() => setHex(theme.brandColor), [theme.brandColor]);
  const valid = HEX.test(theme.brandColor);
  const white = valid ? contrast(theme.brandColor, '#FFFFFF') : 0;
  const dark = valid ? contrast(theme.brandColor, DARK_TEXT) : 0;
  const onBrand = onBrandOf(theme.brandColor);
  const textRatio = onBrand === '#FFFFFF' ? white : dark;
  return (
    <Card title="테마" description="브랜드 색은 런처 · 내 메시지 · 버튼에 쓰여요.">
      <Field
        label="브랜드 색"
        error={error ?? (HEX.test(hex) ? undefined : '#RRGGBB 형식으로 입력하세요')}
      >
        <span className="ws-color-row">
          <input
            type="color"
            className="ws-color"
            aria-label="브랜드 색 고르기"
            value={valid ? theme.brandColor.toLowerCase() : '#4f46e5'}
            onChange={(e) => onChange({ brandColor: e.target.value.toUpperCase() })}
          />
          <input
            className="input cfg-mono-input ws-hex"
            value={hex}
            maxLength={7}
            onChange={(e) => {
              const v = e.target.value.trim();
              setHex(v);
              if (HEX.test(v)) onChange({ brandColor: v.toUpperCase() });
            }}
          />
          <span className="ws-swatches" role="group" aria-label="추천 색">
            {SWATCHES.map((c) => (
              <button
                key={c}
                type="button"
                className={c === theme.brandColor.toUpperCase() ? 'ws-swatch active' : 'ws-swatch'}
                style={{ background: c }}
                aria-label={c}
                title={c}
                onClick={() => onChange({ brandColor: c })}
              />
            ))}
          </span>
        </span>
      </Field>
      {valid && (
        <div className="ws-contrast" aria-live="polite">
          <span
            className="ws-contrast-sample"
            style={{ background: theme.brandColor, color: onBrand }}
          >
            가나다 Aa
          </span>
          <div className="ws-contrast-text">
            {white >= 4.5 ? (
              <p>
                <Badge tone="success">통과</Badge> 흰 글자 대비 {white.toFixed(1)}:1 (기준 4.5:1)
              </p>
            ) : textRatio >= 4.5 ? (
              <p>
                <Badge tone="warning">자동 보정</Badge> 흰 글자 대비 {white.toFixed(1)}:1 — 기준
                4.5:1 미만이라 위젯은 어두운 글자({DARK_TEXT}, {dark.toFixed(1)}:1)를 써요.
              </p>
            ) : (
              <p>
                <Badge tone="danger">대비 부족</Badge> 흰 글자 {white.toFixed(1)}:1 · 어두운 글자{' '}
                {dark.toFixed(1)}:1 — 어느 쪽도 4.5:1 에 못 미쳐요. 더 진하거나 밝은 색을 고르세요.
              </p>
            )}
            <p className="field-hint">
              흰 배경 위 런처 · 테두리 대비 {white.toFixed(1)}:1{' '}
              {white >= 3 ? '(3:1 이상 — 충분)' : '(3:1 미만 — 흰 페이지에서 잘 안 보일 수 있어요)'}
            </p>
          </div>
        </div>
      )}
      <div className="ws-grid-2">
        <div className="field">
          <span className="field-label">위치</span>
          <div className="ws-segment" role="radiogroup" aria-label="위치">
            {(
              [
                ['bottom-right', '오른쪽 아래'],
                ['bottom-left', '왼쪽 아래'],
              ] as [Position, string][]
            ).map(([v, label]) => (
              <label key={v} className={theme.position === v ? 'active' : undefined}>
                <input
                  type="radio"
                  name="ws-position"
                  checked={theme.position === v}
                  onChange={() => onChange({ position: v })}
                />
                {label}
              </label>
            ))}
          </div>
        </div>
        <Field label="다크 모드" hint="시스템 설정 따름: 방문자 OS 의 라이트 · 다크를 따라가요">
          <select
            className="input"
            value={theme.darkMode}
            onChange={(e) => onChange({ darkMode: e.target.value as DarkMode })}
          >
            <option value="system">시스템 설정 따름</option>
            <option value="light">항상 라이트</option>
            <option value="dark">항상 다크</option>
          </select>
        </Field>
      </div>
    </Card>
  );
}

/* ───────────── 동작 ───────────── */

function BehaviorCard({
  behavior,
  onChange,
  issues,
}: {
  behavior: Behavior;
  onChange: (patch: Partial<Behavior>) => void;
  issues: Record<string, string>;
}) {
  const [custom, setCustom] = useState('');
  const [customError, setCustomError] = useState<string | null>(null);
  const types = behavior.attachments.types;
  const setTypes = (next: string[]) =>
    onChange({ attachments: { ...behavior.attachments, types: next } });
  const presetIds = new Set(ATTACHMENT_PRESETS.map(([t]) => t));
  const addCustom = () => {
    const v = custom.trim().toLowerCase();
    if (!MIME.test(v)) return setCustomError('MIME 형식이어야 해요 (예: application/zip, audio/*)');
    if (types.includes(v)) return setCustomError('이미 있어요');
    if (types.length >= 30) return setCustomError('30개까지 넣을 수 있어요');
    setTypes([...types, v]);
    setCustom('');
    setCustomError(null);
  };
  return (
    <Card title="동작">
      <div className="ws-toggles">
        <Toggle
          checked={behavior.autoOpen}
          onChange={(autoOpen) => onChange({ autoOpen })}
          label="페이지를 열면 위젯 패널도 자동으로 열기"
        />
        <Toggle
          checked={behavior.showPoweredBy}
          onChange={(showPoweredBy) => onChange({ showPoweredBy })}
          label="하단에 ‘Powered by TheOneAI’ 표시"
        />
      </div>
      <Field
        label="고지 문구"
        hint={`입력창 아래에 늘 보여요 · ${behavior.noticeText.trim().length}/200`}
        error={issues['behavior.noticeText']}
      >
        <input
          className="input"
          maxLength={200}
          value={behavior.noticeText}
          onChange={(e) => onChange({ noticeText: e.target.value })}
        />
      </Field>
      <Field
        label="언어"
        hint="준비 중 — 지금 위젯 문구는 한국어로 보이고, 값은 저장만 돼요"
        error={issues['behavior.language']}
      >
        <select
          className="input ws-narrow"
          value={behavior.language}
          onChange={(e) => onChange({ language: e.target.value })}
        >
          {LANGUAGES.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
          {!LANGUAGES.some(([v]) => v === behavior.language) && (
            <option value={behavior.language}>{behavior.language}</option>
          )}
        </select>
      </Field>

      <div className="ws-attach">
        <div className="ws-attach-head">
          <p className="field-label">첨부 파일</p>
          {types.length === 0 ? (
            <Badge>꺼짐</Badge>
          ) : (
            <Badge tone="info">{types.length}개 형식 허용</Badge>
          )}
        </div>
        <p className="field-hint">
          고른 형식만 업로드할 수 있어요. 아무것도 고르지 않으면 첨부 버튼이 사라져요. 텍스트 · CSV
          · JSON 은 작업 내용에 데이터로 들어가요.
        </p>
        <div className="ws-chips" role="group" aria-label="허용 형식">
          {ATTACHMENT_PRESETS.map(([t, label]) => (
            <label key={t} className={types.includes(t) ? 'ws-chip on' : 'ws-chip'} title={t}>
              <input
                type="checkbox"
                checked={types.includes(t)}
                onChange={(e) =>
                  setTypes(e.target.checked ? [...types, t] : types.filter((x) => x !== t))
                }
              />
              {label}
            </label>
          ))}
          {types
            .filter((t) => !presetIds.has(t))
            .map((t) => (
              <span key={t} className="ws-chip on">
                <Mono>{t}</Mono>
                <button
                  type="button"
                  aria-label={`${t} 빼기`}
                  onClick={() => setTypes(types.filter((x) => x !== t))}
                >
                  ×
                </button>
              </span>
            ))}
        </div>
        <div className="ws-attach-row">
          <Field label="다른 형식 추가" error={customError}>
            <input
              className="input cfg-mono-input"
              placeholder="application/zip"
              value={custom}
              onChange={(e) => {
                setCustom(e.target.value);
                setCustomError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addCustom();
                }
              }}
            />
          </Field>
          <Button onClick={addCustom} disabled={!custom.trim()}>
            추가
          </Button>
          <Field label="파일 최대 크기" error={issues['behavior.attachments']}>
            <span className="cfg-num-unit">
              <input
                className="input cfg-num-input ws-mb"
                type="number"
                min={1}
                max={50}
                step={1}
                value={Number.isNaN(behavior.attachments.maxMb) ? '' : behavior.attachments.maxMb}
                onChange={(e) =>
                  onChange({
                    attachments: { ...behavior.attachments, maxMb: e.target.valueAsNumber },
                  })
                }
              />
              <span className="cfg-unit">MB (1 ~ 50)</span>
            </span>
          </Field>
        </div>
      </div>
    </Card>
  );
}

/* ───────────── 미리보기 ───────────── */

function WidgetPreview({
  theme,
  behavior,
  agentName,
  welcome,
}: {
  theme: Theme;
  behavior: Behavior;
  agentName: string;
  welcome: string;
}) {
  const systemDark = useSystemDark();
  const [override, setOverride] = useState<'light' | 'dark' | null>(null);
  useEffect(() => setOverride(null), [theme.darkMode]);
  const dark =
    theme.darkMode === 'system'
      ? override
        ? override === 'dark'
        : systemDark
      : theme.darkMode === 'dark';
  const brand = HEX.test(theme.brandColor) ? theme.brandColor : '#4F46E5';
  const onBrand = onBrandOf(brand);
  const greeting = welcome.trim() || '안녕하세요,\n무엇을 도와드릴까요?';
  return (
    <section className="card ws-preview-card">
      <div className="card-head">
        <div>
          <h2 className="card-title">미리보기</h2>
          <p className="card-desc">저장 전 모습이에요</p>
        </div>
        {theme.darkMode === 'system' && (
          <div className="ws-segment small" role="radiogroup" aria-label="미리보기 테마">
            {(['light', 'dark'] as const).map((m) => (
              <label key={m} className={(dark ? 'dark' : 'light') === m ? 'active' : undefined}>
                <input
                  type="radio"
                  name="ws-preview-mode"
                  checked={(dark ? 'dark' : 'light') === m}
                  onChange={() => setOverride(m)}
                />
                {m === 'light' ? '라이트' : '다크'}
              </label>
            ))}
          </div>
        )}
      </div>
      <div
        className="wp-stage"
        data-theme={dark ? 'dark' : 'light'}
        data-position={theme.position}
        style={{ ['--wp-brand' as string]: brand, ['--wp-on-brand' as string]: onBrand }}
        aria-hidden="true"
      >
        <div className="wp-panel">
          <div className="wp-head">
            <span className="wp-avatar">
              <SparkIcon />
            </span>
            <div className="wp-head-text">
              <p className="wp-title">{agentName || 'Agent'}</p>
              <p className="wp-sub">
                <span className="wp-dot" />
                연결됨
              </p>
            </div>
            <span className="wp-icon">＋</span>
            <span className="wp-icon">−</span>
          </div>
          <div className="wp-body">
            <h3 className="wp-greeting">
              {greeting.split('\n').map((line, i) => (
                <span key={i}>
                  {i > 0 && <br />}
                  {line}
                </span>
              ))}
            </h3>
            <div className="wp-msg-user">3월 매출 리포트 만들어줘</div>
            <div className="wp-msg-agent">
              <span className="wp-avatar small">
                <SparkIcon />
              </span>
              <p>
                네, 3월 주문 데이터를 확인해서 리포트를 만들게요. 실행 계획을 먼저 보여 드릴게요.
              </p>
            </div>
          </div>
          <div className="wp-composer">
            <div className="wp-input">
              {behavior.attachments.types.length > 0 && <span className="wp-clip">⌇</span>}
              <span className="wp-placeholder">무엇이든 요청하세요…</span>
              <span className="wp-send">↑</span>
            </div>
            <p className="wp-foot">
              {behavior.noticeText.trim()}
              {behavior.noticeText.trim() && behavior.showPoweredBy && ' · '}
              {behavior.showPoweredBy && 'Powered by TheOneAI'}
            </p>
          </div>
        </div>
        <div className="wp-launcher">
          <ChatIcon />
        </div>
      </div>
      <p className="ws-preview-note field-hint">
        {behavior.autoOpen
          ? '페이지를 열면 패널이 자동으로 열려요.'
          : '방문자가 런처를 누르면 패널이 열려요.'}{' '}
        폭 480px 이하 화면에서는 전체 화면으로 열려요.
      </p>
    </section>
  );
}

function useSystemDark(): boolean {
  const [dark, setDark] = useState(
    () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false,
  );
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const on = (e: MediaQueryListEvent) => setDark(e.matches);
    mq?.addEventListener('change', on);
    return () => mq?.removeEventListener('change', on);
  }, []);
  return dark;
}

function SparkIcon(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2l2.2 6.3L20 10l-5.8 1.7L12 18l-2.2-6.3L4 10l5.8-1.7z" />
    </svg>
  );
}

function ChatIcon(): ReactNode {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 12a8 8 0 01-11.6 7.1L4 20l1-4.6A8 8 0 1121 12z" />
    </svg>
  );
}
