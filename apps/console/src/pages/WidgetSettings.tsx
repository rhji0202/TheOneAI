/**
 * C-09 위젯 설치 · 테마 — 설치 코드, 사용자 연동(서명 토큰), 허용 도메인, 테마 · 동작, 미리보기, Secret 재발급.
 * 설정은 bootstrap 이 매번 읽으므로 저장하면 바로 고객사 페이지의 위젯에 반영된다.
 * API: GET /v1/admin/widget-configs · PATCH /:id (Admin) · POST /:id/rotate-secret (Owner)
 */
import {
  ArrowUpIcon,
  CheckIcon,
  MessageCircleIcon,
  MinusIcon,
  MoonIcon,
  PaperclipIcon,
  PlusIcon,
  RefreshCwIcon,
  SparklesIcon,
  SunIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import { type ReactNode, useEffect, useId, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../api';
import { useApi, useAuth } from '../auth';
import {
  Badge,
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
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Toggle as ToggleChip } from '@/components/ui/toggle';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

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

const LINK = 'text-primary underline-offset-4 hover:underline';

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
    <TooltipProvider>
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
            <NativeSelect
              containerClassName="w-auto min-w-[200px]"
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
                <NativeSelectOption key={w.id} value={w.id}>
                  {w.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
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

      <div className="grid grid-cols-1 items-start gap-5 min-[1180px]:grid-cols-[minmax(0,1fr)_380px]">
        <fieldset className="min-w-0" disabled={!canEdit}>
          <Card title="기본">
            <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-x-4 gap-y-0">
              <Field label="이름" required error={issues.name} hint="콘솔에서만 보이는 이름">
                <Input
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
                    인사말 · 추천 작업은{' '}
                    <Link to={`/agents/${form.agentId}`} className={LINK}>
                      Agent 설정
                    </Link>
                    의 환영 문구와 허용된 Skill 에서 만들어져요
                  </>
                }
              >
                <NativeSelect
                  value={form.agentId}
                  onChange={(e) => update({ agentId: e.target.value })}
                >
                  {(
                    agents.data ?? [
                      { id: widget.agentId, name: widget.agentName, publishedVersion: null },
                    ]
                  ).map((a) => (
                    <NativeSelectOption
                      key={a.id}
                      value={a.id}
                      disabled={a.publishedVersion === null && a.id !== widget.agentId}
                    >
                      {a.name}
                      {a.publishedVersion !== null ? ` (v${a.publishedVersion})` : ' (배포 안 됨)'}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
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

        <aside
          className="min-w-0 sm:max-[1180px]:order-first min-[1180px]:sticky min-[1180px]:top-[72px]"
          aria-label="미리보기"
        >
          <WidgetPreview
            theme={form.theme}
            behavior={form.behavior}
            agentName={agentName}
            welcome={welcome}
          />
        </aside>
      </div>

      {canEdit && dirty && (
        <div
          className="sticky bottom-4 z-15 mt-2 flex flex-wrap items-center gap-2.5 rounded-xl border bg-card py-2.5 pr-3 pl-4 shadow-lg"
          role="region"
          aria-label="저장"
        >
          <span className="inline-flex min-w-[180px] flex-1 items-center gap-2 text-sm font-medium">
            <span className="size-2 shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
            저장하지 않은 변경 · {changed.map((k) => FIELD_LABEL[k]).join(', ')}
          </span>
          {save.error && <span className="text-sm text-destructive">{save.error.message}</span>}
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
            저장
          </Button>
        </div>
      )}

      <ConfirmModal
        open={rotateOpen}
        title="Widget Secret 을 재발급할까요?"
        body={
          <div className="mb-3 space-y-1.5 text-sm leading-relaxed">
            <p>
              새 Secret 을 만들면 지금 Secret 은 <b>24시간 동안만</b> 함께 허용돼요.
            </p>
            <p>그 안에 고객사 서버의 환경 변수(예: THEONEAI_WIDGET_SECRET)를 새 값으로 바꾸세요.</p>
            <p className="text-muted-foreground">
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
    </TooltipProvider>
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
      <ol className="mb-3 list-decimal space-y-1 pl-5 text-sm leading-relaxed text-muted-foreground">
        <li>
          <b className="text-foreground">허용 도메인</b>에 위젯을 넣을 사이트 주소를 등록합니다.
        </li>
        <li>아래 코드를 페이지에 붙여 넣습니다.</li>
        {identityMode === 'signed_token' && (
          <li>
            고객사 서버에 <b className="text-foreground">identity token 발급 API</b>를 만듭니다
            (아래 사용자 연동).
          </li>
        )}
      </ol>
      <CodeBlock code={identityMode === 'signed_token' ? signed : tag} label="HTML" />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">공개 키</span>
        <Mono>{widget.publicKey}</Mono>
        <CopyButton text={widget.publicKey} />
        <span className="text-xs text-muted-foreground">
          페이지에 노출돼도 괜찮아요 — 허용 도메인
          {identityMode === 'signed_token' ? ' · 서명 토큰' : ''}으로 보호돼요.
        </span>
      </div>
      {identityMode === 'signed_token' && (
        <p className="mt-2.5 text-xs text-muted-foreground">
          로그인 · 로그아웃 뒤에는 <Mono>{'window.TheOneAI.identify({ token })'}</Mono> 또는{' '}
          <Mono>window.TheOneAI.destroy()</Mono> 를 부르세요.
        </p>
      )}
    </Card>
  );
}

/* ───────────── 사용자 연동 ───────────── */

const IDENTITY_MODES: [IdentityMode, string, string][] = [
  [
    'signed_token',
    '로그인 사용자 연동 (권장)',
    '고객사 서버가 서명한 identity token 으로 사용자를 확인해요. 로그인하지 않은 방문자에게는 위젯이 보이지 않아요.',
  ],
  [
    'anonymous',
    '익명',
    '로그인 없이 브라우저마다 익명 ID 를 만들어요. 기기 · 브라우저가 바뀌면 다른 사용자로 봐요.',
  ],
];

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
  const id = useId();
  return (
    <Card title="사용자 연동" description="위젯 사용자를 어떻게 구분할지 정합니다.">
      <RadioGroup
        className="mb-3 grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-2.5"
        aria-label="사용자 연동 방식"
        value={mode}
        onValueChange={(v) => onChange(v as IdentityMode)}
      >
        {IDENTITY_MODES.map(([value, title, description]) => (
          <Label
            key={value}
            htmlFor={`${id}-${value}`}
            className="cursor-pointer items-start gap-2.5 rounded-lg border px-3.5 py-3 leading-normal font-normal has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5 dark:has-[[data-state=checked]]:bg-primary/10"
          >
            <RadioGroupItem id={`${id}-${value}`} value={value} className="mt-0.5" />
            <span>
              <span className="block font-semibold">{title}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
            </span>
          </Label>
        ))}
      </RadioGroup>
      {mode !== baseMode && (
        <Notice tone="warn">
          {mode === 'anonymous'
            ? '익명으로 바꾸면 허용 도메인의 방문자 누구나 대화를 시작할 수 있어요. 개인 정보가 필요한 Tool 은 쓰지 마세요.'
            : '저장하는 순간부터 identity token 이 없는 방문자에게는 위젯이 보이지 않아요. 고객사 서버의 토큰 발급 API 를 먼저 준비하세요.'}
        </Notice>
      )}
      {mode === 'signed_token' && (
        <>
          <ul className="mt-1 mb-3 list-disc space-y-0.5 pl-5 text-sm leading-relaxed text-muted-foreground">
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
      <div className="mt-4 flex flex-wrap items-center justify-between gap-4 border-t pt-3.5">
        <div className="min-w-60 flex-1">
          <p className="font-semibold">Widget Secret</p>
          <p className="text-xs text-muted-foreground">
            Secret 저장소에만 보관돼 콘솔에서도 다시 볼 수 없어요. 잃어버렸거나 노출됐다면
            재발급하세요.
          </p>
          {widget.previousSecretExpiresAt && (
            <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">
              이전 Secret 도 <Time iso={widget.previousSecretExpiresAt} absolute /> 까지 함께
              허용돼요.
            </p>
          )}
        </div>
        {canRotate ? (
          <Button variant="destructive" onClick={onRotate}>
            <RefreshCwIcon aria-hidden="true" />
            Secret 재발급
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">재발급은 Owner 만 할 수 있어요</span>
        )}
      </div>
    </Card>
  );
}

function SecretModal({ result, onClose }: { result: RotateResult | null; onClose: () => void }) {
  const [saved, setSaved] = useState(false);
  useEffect(() => setSaved(false), [result]);
  const savedId = useId();
  return (
    <Modal
      open={!!result}
      title="새 Widget Secret"
      onClose={() => saved && onClose()}
      footer={
        <Button disabled={!saved} onClick={onClose}>
          닫기
        </Button>
      }
    >
      <Notice tone="warn">
        이 창을 닫으면 다시 볼 수 없어요. 지금 복사해 고객사 서버의 환경 변수에 저장하세요.
      </Notice>
      {result && <CodeBlock code={result.secret} label="THEONEAI_WIDGET_SECRET" />}
      {result && (
        <p className="mt-2.5 text-xs text-muted-foreground">
          이전 Secret 은 <Time iso={result.previousSecretExpiresAt} absolute /> 까지 함께 허용돼요.
        </p>
      )}
      <div className="mt-2.5 flex items-center gap-2">
        <Checkbox id={savedId} checked={saved} onCheckedChange={(v) => setSaved(v === true)} />
        <Label htmlFor={savedId} className="font-normal">
          안전한 곳에 저장했어요
        </Label>
      </div>
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
      <ul className="mb-3 divide-y rounded-lg border empty:hidden" aria-label="허용 도메인 목록">
        {origins.map((o) => (
          <li key={o} className="flex flex-wrap items-center gap-2 py-1.5 pr-1.5 pl-3">
            <Mono>{o}</Mono>
            {originNotes(o).map((n) => (
              <Badge key={n.label} tone={n.tone}>
                {n.label}
              </Badge>
            ))}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="ml-auto text-muted-foreground hover:text-destructive"
                  aria-label={`${o} 삭제`}
                  onClick={() => onChange(origins.filter((x) => x !== o))}
                >
                  <Trash2Icon aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>삭제</TooltipContent>
            </Tooltip>
          </li>
        ))}
      </ul>
      <AddInput
        group="새 허용 도메인"
        label="도메인 추가"
        hint="예: https://shop.example.com · 서브도메인 전체는 https://*.example.com (한 단계만)"
        error={error}
        value={draft}
        placeholder="https://"
        onChange={(v) => {
          setDraft(v);
          setError(null);
        }}
        onAdd={add}
      />
    </Card>
  );
}

function AddInput({
  group,
  label,
  hint,
  error,
  value,
  placeholder,
  onChange,
  onAdd,
}: {
  /** 그룹 접근성 이름 — label 과 겹치면 getByLabel(label) 이 입력칸 하나로 좁혀지지 않는다 */
  group: string;
  label: string;
  hint?: ReactNode;
  error: string | null;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  onAdd: () => void;
}) {
  const id = useId();
  const note = error ?? hint;
  return (
    <div role="group" aria-label={group} className="mb-4 flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id} className="text-muted-foreground">
        {label}
      </Label>
      <div className="flex gap-2">
        <Input
          id={id}
          className="font-mono"
          value={value}
          placeholder={placeholder}
          aria-invalid={!!error || undefined}
          aria-describedby={note ? `${id}-note` : undefined}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onAdd();
            }
          }}
        />
        <Button variant="outline" onClick={onAdd} disabled={!value.trim()}>
          <PlusIcon aria-hidden="true" />
          추가
        </Button>
      </div>
      {note && (
        <span
          id={`${id}-note`}
          className={cn('text-xs', error ? 'text-destructive' : 'text-muted-foreground')}
        >
          {note}
        </span>
      )}
    </div>
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
  const positionId = useId();
  return (
    <Card title="테마" description="브랜드 색은 런처 · 내 메시지 · 버튼에 쓰여요.">
      <Field
        label="브랜드 색"
        error={error ?? (HEX.test(hex) ? undefined : '#RRGGBB 형식으로 입력하세요')}
      >
        <span className="flex flex-wrap items-center gap-2.5">
          <Input
            type="color"
            className="h-9 w-11 cursor-pointer p-0.5"
            aria-label="브랜드 색 고르기"
            value={valid ? theme.brandColor.toLowerCase() : '#4f46e5'}
            onChange={(e) => onChange({ brandColor: e.target.value.toUpperCase() })}
          />
          <Input
            className="w-[110px] font-mono uppercase"
            value={hex}
            maxLength={7}
            onChange={(e) => {
              const v = e.target.value.trim();
              setHex(v);
              if (HEX.test(v)) onChange({ brandColor: v.toUpperCase() });
            }}
          />
          <span className="inline-flex flex-wrap gap-1.5" role="group" aria-label="추천 색">
            {SWATCHES.map((c) => (
              <Tooltip key={c}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      'size-6 cursor-pointer rounded-full border-2 border-background ring-1 ring-border outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                      c === theme.brandColor.toUpperCase() && 'ring-2 ring-foreground',
                    )}
                    style={{ background: c }}
                    aria-label={c}
                    onClick={() => onChange({ brandColor: c })}
                  />
                </TooltipTrigger>
                <TooltipContent className="font-mono">{c}</TooltipContent>
              </Tooltip>
            ))}
          </span>
        </span>
      </Field>
      {valid && (
        <div
          className="mb-3.5 flex items-center gap-3.5 rounded-lg border bg-muted/50 p-3"
          aria-live="polite"
        >
          <span
            className="shrink-0 rounded-[14px_14px_4px_14px] px-3.5 py-2.5 font-semibold"
            style={{ background: theme.brandColor, color: onBrand }}
          >
            가나다 Aa
          </span>
          <div className="space-y-1 text-sm leading-relaxed">
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
            <p className="text-xs text-muted-foreground">
              흰 배경 위 런처 · 테두리 대비 {white.toFixed(1)}:1{' '}
              {white >= 3 ? '(3:1 이상 — 충분)' : '(3:1 미만 — 흰 페이지에서 잘 안 보일 수 있어요)'}
            </p>
          </div>
        </div>
      )}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-x-4 gap-y-0">
        <div className="mb-4 flex flex-col gap-1.5">
          <span id={positionId} className="text-sm leading-none font-medium text-muted-foreground">
            위치
          </span>
          <RadioGroup
            className="flex h-9 flex-wrap items-center gap-x-5"
            aria-labelledby={positionId}
            value={theme.position}
            onValueChange={(v) => onChange({ position: v as Position })}
          >
            {(
              [
                ['bottom-right', '오른쪽 아래'],
                ['bottom-left', '왼쪽 아래'],
              ] as [Position, string][]
            ).map(([v, label]) => (
              <div key={v} className="flex items-center gap-2">
                <RadioGroupItem id={`${positionId}-${v}`} value={v} />
                <Label htmlFor={`${positionId}-${v}`} className="font-normal">
                  {label}
                </Label>
              </div>
            ))}
          </RadioGroup>
        </div>
        <Field label="다크 모드" hint="시스템 설정 따름: 방문자 OS 의 라이트 · 다크를 따라가요">
          <NativeSelect
            value={theme.darkMode}
            onChange={(e) => onChange({ darkMode: e.target.value as DarkMode })}
          >
            <NativeSelectOption value="system">시스템 설정 따름</NativeSelectOption>
            <NativeSelectOption value="light">항상 라이트</NativeSelectOption>
            <NativeSelectOption value="dark">항상 다크</NativeSelectOption>
          </NativeSelect>
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
      <div className="mb-3.5 flex flex-col gap-1.5">
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
        <Input
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
        <NativeSelect
          containerClassName="max-w-80"
          value={behavior.language}
          onChange={(e) => onChange({ language: e.target.value })}
        >
          {LANGUAGES.map(([v, label]) => (
            <NativeSelectOption key={v} value={v}>
              {label}
            </NativeSelectOption>
          ))}
          {!LANGUAGES.some(([v]) => v === behavior.language) && (
            <NativeSelectOption value={behavior.language}>{behavior.language}</NativeSelectOption>
          )}
        </NativeSelect>
      </Field>

      <div className="border-t pt-3.5">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-muted-foreground">첨부 파일</p>
          {types.length === 0 ? (
            <Badge>꺼짐</Badge>
          ) : (
            <Badge tone="info">{types.length}개 형식 허용</Badge>
          )}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          고른 형식만 업로드할 수 있어요. 아무것도 고르지 않으면 첨부 버튼이 사라져요. 텍스트 · CSV
          · JSON 은 작업 내용에 데이터로 들어가요.
        </p>
        <div className="mt-2.5 mb-3 flex flex-wrap gap-1.5" role="group" aria-label="허용 형식">
          {ATTACHMENT_PRESETS.map(([t, label]) => {
            const on = types.includes(t);
            return (
              <ToggleChip
                key={t}
                size="sm"
                variant="outline"
                className="rounded-full data-[state=on]:border-primary data-[state=on]:bg-primary/10 data-[state=on]:text-primary"
                title={t}
                pressed={on}
                onPressedChange={(next) =>
                  setTypes(next ? [...types, t] : types.filter((x) => x !== t))
                }
              >
                {on && <CheckIcon aria-hidden="true" />}
                {label}
              </ToggleChip>
            );
          })}
          {types
            .filter((t) => !presetIds.has(t))
            .map((t) => (
              <span
                key={t}
                className="inline-flex h-8 items-center gap-1 rounded-full border border-primary bg-primary/10 pr-1 pl-3 text-primary"
              >
                <code className="font-mono text-xs">{t}</code>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      className="rounded-full hover:bg-primary/15 hover:text-primary"
                      aria-label={`${t} 빼기`}
                      onClick={() => setTypes(types.filter((x) => x !== t))}
                    >
                      <XIcon aria-hidden="true" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>빼기</TooltipContent>
                </Tooltip>
              </span>
            ))}
        </div>
        <div className="grid items-start gap-x-4 gap-y-0 sm:grid-cols-[minmax(0,1fr)_auto]">
          <AddInput
            group="새 첨부 형식"
            label="다른 형식 추가"
            error={customError}
            value={custom}
            placeholder="application/zip"
            onChange={(v) => {
              setCustom(v);
              setCustomError(null);
            }}
            onAdd={addCustom}
          />
          <Field label="파일 최대 크기" error={issues['behavior.attachments']}>
            <span className="flex items-center gap-2">
              <Input
                className="w-24 tabular-nums"
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
              <span className="text-sm whitespace-nowrap text-muted-foreground">MB (1 ~ 50)</span>
            </span>
          </Field>
        </div>
      </div>
    </Card>
  );
}

/* ───────────── 미리보기 ───────────── */

/** 위젯(apps/widget/src/widget.css) 과 같은 색 — 콘솔이 아니라 위젯의 다크 모드 설정을 따른다 */
const WP_TOKENS = {
  light: {
    '--wp-bg': '#ffffff',
    '--wp-bg-soft': '#fafafb',
    '--wp-line': '#e3e5e8',
    '--wp-line-soft': '#eef0f2',
    '--wp-text': '#16181d',
    '--wp-text-2': '#3f4451',
    '--wp-text-3': '#5b6170',
    '--wp-input-line': '#c9cdd3',
    '--wp-page': '#eef0f4',
    '--wp-page-line': '#dfe2e8',
  },
  dark: {
    '--wp-bg': '#17191f',
    '--wp-bg-soft': '#1c1f26',
    '--wp-line': '#30343d',
    '--wp-line-soft': '#292c34',
    '--wp-text': '#eef0f3',
    '--wp-text-2': '#c7cbd3',
    '--wp-text-3': '#9aa1ad',
    '--wp-input-line': '#3d424d',
    '--wp-page': '#0d0f13',
    '--wp-page-line': '#22252c',
  },
};

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
  const mode = dark ? 'dark' : 'light';
  const vars: Record<string, string> = {
    ...WP_TOKENS[mode],
    '--wp-brand': brand,
    '--wp-on-brand': onBrand,
  };
  const side = theme.position === 'bottom-left' ? 'left-3.5' : 'right-3.5';
  return (
    <Card
      title="미리보기"
      description="저장 전 모습이에요"
      className="mb-0"
      flush
      actions={
        theme.darkMode === 'system' && (
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            aria-label="미리보기 테마"
            value={mode}
            onValueChange={(v) => v && setOverride(v as 'light' | 'dark')}
          >
            <ToggleGroupItem value="light">
              <SunIcon aria-hidden="true" />
              라이트
            </ToggleGroupItem>
            <ToggleGroupItem value="dark">
              <MoonIcon aria-hidden="true" />
              다크
            </ToggleGroupItem>
          </ToggleGroup>
        )
      }
    >
      <div
        className="relative mx-4 mt-3 h-[560px] overflow-hidden rounded-lg bg-(--wp-page) text-[13px] leading-[1.55] text-(--wp-text) max-sm:h-[520px]"
        style={vars}
        aria-hidden="true"
      >
        <div className="absolute top-6 left-5 h-2.5 w-[45%] bg-(--wp-page-line)" />
        <div className="absolute top-11 left-5 h-2 w-[60%] bg-(--wp-page-line)" />
        <div className="absolute top-[60px] left-5 h-2 w-[52%] bg-(--wp-page-line)" />
        <div
          className={cn(
            'absolute bottom-[78px] flex h-[440px] w-[300px] flex-col overflow-hidden rounded-[14px] border border-(--wp-line) bg-(--wp-bg) shadow-[0_12px_32px_rgba(22,24,29,0.16)]',
            side,
          )}
        >
          <div className="flex items-center gap-1.5 border-b border-(--wp-line-soft) py-[9px] pr-2 pl-2.5">
            <span className="grid size-[30px] flex-none place-items-center rounded-full bg-(--wp-brand) text-(--wp-on-brand)">
              <SparklesIcon className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13.5px] font-bold">{agentName || 'Agent'}</p>
              <p className="flex items-center gap-[5px] text-[11.5px] text-(--wp-text-3)">
                <span className="size-1.5 rounded-full bg-green-600" />
                연결됨
              </p>
            </div>
            <PlusIcon className="mx-[5px] size-4 text-(--wp-text-2)" />
            <MinusIcon className="mx-[5px] size-4 text-(--wp-text-2)" />
          </div>
          <div className="flex flex-1 flex-col gap-3 overflow-hidden bg-(--wp-bg-soft) px-3 py-4">
            <h3 className="mb-1 text-[17px] leading-[1.4] font-bold break-keep">
              {greeting.split('\n').map((line, i) => (
                <span key={i}>
                  {i > 0 && <br />}
                  {line}
                </span>
              ))}
            </h3>
            <div className="max-w-[82%] self-end rounded-[14px_14px_4px_14px] bg-(--wp-brand) px-3 py-2 text-(--wp-on-brand)">
              3월 매출 리포트 만들어줘
            </div>
            <div className="flex items-start gap-2">
              <span className="grid size-6 flex-none place-items-center rounded-full bg-(--wp-brand) text-(--wp-on-brand)">
                <SparklesIcon className="size-[13px]" />
              </span>
              <p>
                네, 3월 주문 데이터를 확인해서 리포트를 만들게요. 실행 계획을 먼저 보여 드릴게요.
              </p>
            </div>
          </div>
          <div className="border-t border-(--wp-line-soft) bg-(--wp-bg) px-2.5 pt-2 pb-1.5">
            <div className="flex items-center gap-1.5 rounded-xl border border-(--wp-input-line) py-[5px] pr-[5px] pl-2.5">
              {behavior.attachments.types.length > 0 && (
                <PaperclipIcon className="size-4 text-(--wp-text-3)" />
              )}
              <span className="flex-1 text-(--wp-text-3)">무엇이든 요청하세요…</span>
              <span className="grid size-[30px] place-items-center rounded-[9px] bg-(--wp-brand) text-(--wp-on-brand) opacity-55">
                <ArrowUpIcon className="size-4" />
              </span>
            </div>
            <p className="mt-[5px] min-h-[15px] text-center text-[10.5px] text-(--wp-text-3)">
              {behavior.noticeText.trim()}
              {behavior.noticeText.trim() && behavior.showPoweredBy && ' · '}
              {behavior.showPoweredBy && 'Powered by TheOneAI'}
            </p>
          </div>
        </div>
        <div
          className={cn(
            'absolute bottom-3.5 grid size-[52px] place-items-center rounded-full bg-(--wp-brand) text-(--wp-on-brand) shadow-[0_6px_16px_rgba(22,24,29,0.25)]',
            side,
          )}
        >
          <MessageCircleIcon className="size-6" />
        </div>
      </div>
      <p className="px-4 pt-2.5 pb-3.5 text-xs text-muted-foreground">
        {behavior.autoOpen
          ? '페이지를 열면 패널이 자동으로 열려요.'
          : '방문자가 런처를 누르면 패널이 열려요.'}{' '}
        폭 480px 이하 화면에서는 전체 화면으로 열려요.
      </p>
    </Card>
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
