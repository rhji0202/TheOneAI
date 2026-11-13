/**
 * C-05 MCP 서버 연결 마법사 — ① 연결 정보 → ② 연결 테스트 → ③ Tool 탐색 · 보안 검사 → ④ 등록.
 * 서버 흐름: POST mcp-servers(draft) → POST :id/test → POST :id/discover(pending_review)
 *          → PUT :id/tool-selection → POST :id/register(connected, 새 Registry 버전).
 * /mcp/new?server=<id> 로 등록을 마치지 않은 서버(draft · pending_review · disabled)를 이어서 한다.
 */
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { LEVEL } from '../../../shared/status';
import { ApiError } from '../api';
import { useApi, useAuth } from '../auth';
import {
  Button,
  Card,
  ConfirmModal,
  Empty,
  ErrorNotice,
  Field,
  KeyValue,
  Loading,
  Mono,
  Notice,
  PageHeader,
  Toggle,
  useAction,
  useToast,
} from '../ui';
import {
  ApiErrorNotice,
  APPROVAL_MODES,
  type ApprovalMode,
  approvalLabel,
  CheckBadges,
  CheckIssues,
  type CheckResult,
  type ConnectionTestResult,
  type DiscoverResult,
  hostOf,
  issueFor,
  LevelBadge,
  LEVELS,
  type McpServerView,
  type McpToolView,
  parseHosts,
  type PermissionLevel,
  type PublishedVersion,
  registryMessage,
  type SchemaCheck,
  type SecurityCheck,
  ServerStatusBadge,
  TestResultView,
} from './Mcp';
import './mcp.css';

type Step = 1 | 2 | 3 | 4;

const STEPS: { n: Step; title: string; sub: string }[] = [
  { n: 1, title: '연결 정보', sub: '엔드포인트 · 인증' },
  { n: 2, title: '연결 테스트', sub: 'SSRF · 핸드셰이크' },
  { n: 3, title: 'Tool 탐색 · 보안 검사', sub: '포함할 Tool · 등급' },
  { n: 4, title: '등록', sub: '새 Registry 버전' },
];

interface Candidate {
  name: string;
  description: string | null;
  schema: CheckResult<SchemaCheck>;
  security: CheckResult<SecurityCheck>;
  suggestedLevel: PermissionLevel;
  include: boolean;
  level: PermissionLevel;
  mode: ApprovalMode | '';
}

interface FormState {
  name: string;
  description: string;
  endpointUrl: string;
  authType: 'none' | 'api_key';
  secret: string;
  hosts: string;
  allowPrivateNetwork: boolean;
}

const EMPTY_FORM: FormState = {
  name: '',
  description: '',
  endpointUrl: '',
  authType: 'none',
  secret: '',
  hosts: '',
  allowPrivateNetwork: false,
};

/** 마켓플레이스 설치 결과의 MCP 템플릿 (Marketplace.tsx → router state) */
interface TemplateState {
  name: string;
  description?: string;
  endpointUrl?: string;
  authType?: string;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,40}$/;

const blocked = (c: Pick<Candidate, 'schema' | 'security'>) =>
  c.schema.result === 'error' || c.security.result === 'failed';

export function McpWizardPage() {
  const api = useApi();
  const { can } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const resumeId = params.get('server');

  const [step, setStep] = useState<Step>(1);
  const [reached, setReached] = useState<Step>(1);
  const [server, setServer] = useState<McpServerView | null>(null);
  // 마켓플레이스 MCP 템플릿에서 왔으면 연결 정보를 채운다 (Secret 은 템플릿에 없다)
  const location = useLocation();
  const template = (location.state as { template?: TemplateState } | null)?.template;
  const [form, setForm] = useState<FormState>(() =>
    template && !resumeId
      ? {
          ...EMPTY_FORM,
          name: template.name,
          description: template.description ?? '',
          endpointUrl: template.endpointUrl ?? '',
          authType: template.authType === 'api_key' ? 'api_key' : 'none',
        }
      : EMPTY_FORM,
  );
  const [test, setTest] = useState<ConnectionTestResult | null>(null);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [discovered, setDiscovered] = useState<{ protocolVersion: string | null } | null>(null);
  const [registered, setRegistered] = useState<{
    server: McpServerView;
    registry: PublishedVersion;
  } | null>(null);
  const [loadingResume, setLoadingResume] = useState(Boolean(resumeId));
  const [resumeError, setResumeError] = useState<Error | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const go = useCallback((n: Step) => {
    setStep(n);
    setReached((r) => (n > r ? n : r));
  }, []);

  /* 이어서 하기 — 서버 상태에 맞는 단계로 */
  useEffect(() => {
    if (!resumeId || server?.id === resumeId) return;
    let cancelled = false;
    setLoadingResume(true);
    (async () => {
      try {
        const s = await api.get<McpServerView>(`/v1/admin/mcp-servers/${resumeId}`);
        if (cancelled) return;
        setServer(s);
        setForm({
          name: s.name,
          description: s.description ?? '',
          endpointUrl: s.endpointUrl ?? '',
          authType: s.authType === 'api_key' ? 'api_key' : 'none',
          secret: '',
          hosts: s.allowedHosts.join('\n'),
          allowPrivateNetwork: s.allowPrivateNetwork,
        });
        if (s.status === 'pending_review') {
          const tools = await api.get<McpToolView[]>(`/v1/admin/mcp-servers/${resumeId}/tools`);
          if (cancelled) return;
          setCandidates(
            tools
              .filter((t) => t.state !== 'removed')
              .map((t) => ({
                name: t.name,
                description: t.description,
                schema: t.schema,
                security: t.security,
                suggestedLevel: t.permissionLevel,
                include: t.enabled && !blocked(t),
                level: t.permissionLevel,
                mode: t.approvalModeOverride ?? '',
              })),
          );
          setDiscovered({ protocolVersion: s.protocolVersion });
          setReached(3);
          setStep(3);
        } else if (s.status === 'draft' || s.status === 'disabled') {
          setReached(2);
          setStep(2);
        }
      } catch (err) {
        if (!cancelled) setResumeError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (!cancelled) setLoadingResume(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, resumeId, server?.id]);

  const cancelDraft = useAction(async () => {
    if (server) await api.delete(`/v1/admin/mcp-servers/${server.id}`);
    toast('연결을 취소하고 작성 중인 서버를 지웠어요');
    navigate('/mcp', { replace: true });
  });

  if (!can('admin')) {
    return (
      <>
        <PageHeader title="MCP 서버 연결" back={{ to: '/mcp', label: 'MCP 서버' }} />
        <Card>
          <Empty title="Admin 이상만 MCP 서버를 연결할 수 있어요" />
        </Card>
      </>
    );
  }
  if (loadingResume) return <Loading />;
  if (resumeError)
    return (
      <>
        <PageHeader title="MCP 서버 연결" back={{ to: '/mcp', label: 'MCP 서버' }} />
        <ErrorNotice error={resumeError} />
      </>
    );
  if (server && !registered && (server.status === 'connected' || server.status === 'error')) {
    return (
      <>
        <PageHeader title="MCP 서버 연결" back={{ to: '/mcp', label: 'MCP 서버' }} />
        <Notice tone="info">
          <span>
            {server.name} 은(는) 이미 등록된 서버예요. 변경은 서버 상세에서 다시 탐색 · 검토하세요.
          </span>
          <Link className="btn btn-primary btn-sm" to={`/mcp/${server.id}`}>
            서버 상세
          </Link>
        </Notice>
      </>
    );
  }

  const draftExists = Boolean(server) && !registered && server!.status !== 'disabled';

  return (
    <>
      <PageHeader
        back={{
          to: server ? `/mcp/${server.id}` : '/mcp',
          label: server ? server.name : 'MCP 서버',
        }}
        title="MCP 서버 연결"
        description="Streamable HTTP MCP 서버를 연결하고, 검사를 통과한 Tool 만 골라 등록합니다. 등록하면 새 Tool Registry 버전이 만들어져요."
        meta={
          server ? (
            <ServerStatusBadge status={registered?.server.status ?? server.status} />
          ) : undefined
        }
        actions={
          draftExists ? (
            <Button variant="ghost" onClick={() => setConfirmCancel(true)}>
              작성 취소
            </Button>
          ) : undefined
        }
      />
      <Stepper
        step={step}
        reached={registered ? 4 : reached}
        locked={Boolean(registered)}
        onGo={go}
      />

      {step === 1 && (
        <ConnectionStep
          form={form}
          setForm={setForm}
          server={server}
          onSaved={(s) => {
            setServer(s);
            setTest(null);
            setCandidates(null);
            setParams({ server: s.id }, { replace: true });
            go(2);
          }}
        />
      )}
      {step === 2 && server && (
        <TestStep
          server={server}
          result={test}
          onResult={setTest}
          onBack={() => setStep(1)}
          onNext={() => {
            setCandidates(null);
            go(3);
          }}
        />
      )}
      {step === 3 && server && (
        <DiscoverStep
          server={server}
          candidates={candidates}
          onDiscovered={(result) => {
            setServer(result.server);
            setDiscovered({ protocolVersion: result.protocolVersion });
            setCandidates(
              result.tools.map((t) => ({
                name: t.name,
                description: t.description,
                schema: t.schema,
                security: t.security,
                suggestedLevel: t.suggestedLevel,
                include: t.defaultInclude && !blocked(t),
                level: t.suggestedLevel,
                mode: '',
              })),
            );
          }}
          setCandidates={setCandidates}
          onBack={() => setStep(2)}
          onNext={() => go(4)}
        />
      )}
      {step === 4 && server && (
        <RegisterStep
          server={server}
          protocolVersion={discovered?.protocolVersion ?? server.protocolVersion}
          candidates={candidates ?? []}
          result={registered}
          onBack={() => setStep(3)}
          onRegistered={(r) => {
            setRegistered(r);
            setServer(r.server);
            toast(`${r.server.name} 등록 완료 · ${registryMessage(r.registry)}`);
          }}
        />
      )}

      <ConfirmModal
        open={confirmCancel}
        title="연결 작성 취소"
        body={
          <p className="confirm-body">
            작성 중인 서버({server?.name})와 저장한 API Key 를 지웁니다.
          </p>
        }
        confirmLabel="작성 취소"
        danger
        pending={cancelDraft.pending}
        error={cancelDraft.error}
        onConfirm={() => void cancelDraft.run()}
        onClose={() => setConfirmCancel(false)}
      />
    </>
  );
}

function Stepper({
  step,
  reached,
  locked,
  onGo,
}: {
  step: Step;
  reached: Step;
  locked: boolean;
  onGo: (n: Step) => void;
}) {
  return (
    <ol className="stepper" aria-label="연결 단계">
      {STEPS.map((s) => {
        const state =
          s.n === step
            ? 'current'
            : s.n < reached || (s.n <= reached && s.n < step)
              ? 'done'
              : 'todo';
        const clickable = !locked && s.n < step;
        return (
          <li
            key={s.n}
            className={`step ${state}`}
            aria-current={s.n === step ? 'step' : undefined}
          >
            <button type="button" disabled={!clickable} onClick={() => onGo(s.n)}>
              <span className="step-num" aria-hidden="true">
                {state === 'done' ? '✓' : s.n}
              </span>
              <span className="step-text">
                <span className="step-title">{s.title}</span>
                <span className="step-sub">{s.sub}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/* ① 연결 정보 */
function ConnectionStep({
  form,
  setForm,
  server,
  onSaved,
}: {
  form: FormState;
  setForm: (f: FormState | ((p: FormState) => FormState)) => void;
  server: McpServerView | null;
  onSaved: (s: McpServerView) => void;
}) {
  const api = useApi();
  const { can } = useAuth();
  const isOwner = can('owner');
  const [touched, setTouched] = useState(false);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((p) => ({ ...p, [key]: value }));

  const nameError =
    !server && touched
      ? !NAME_PATTERN.test(form.name)
        ? '영문 소문자 · 숫자 · - 로 2~41자, 첫 글자는 영문 · 숫자'
        : ['builtin', 'skill'].includes(form.name)
          ? '예약된 이름입니다'
          : undefined
      : undefined;
  let urlError: string | undefined;
  let urlWarning: string | undefined;
  if (touched) {
    try {
      const u = new URL(form.endpointUrl.trim());
      if (u.protocol !== 'https:' && u.protocol !== 'http:')
        urlError = 'https 주소를 입력해 주세요';
      else if (u.protocol === 'http:')
        urlWarning = 'http 는 개발 환경(MCP_ALLOW_INSECURE_HTTP)에서만 허용돼요';
      if (u.username || u.password)
        urlError = 'URL 에 계정 정보를 넣을 수 없어요 — API Key 를 쓰세요';
    } catch {
      urlError = form.endpointUrl.trim() ? 'URL 형식이 아닙니다' : '엔드포인트가 필요해요';
    }
  }
  const secretMissing = form.authType === 'api_key' && !form.secret && !server?.secretRef;

  const save = useAction(async () => {
    const hosts = parseHosts(form.hosts);
    if (!server) {
      return api.post<McpServerView>('/v1/admin/mcp-servers', {
        name: form.name.trim(),
        ...(form.description.trim() ? { description: form.description.trim() } : {}),
        transport: 'streamable_http',
        endpointUrl: form.endpointUrl.trim(),
        authType: form.authType,
        ...(form.authType === 'api_key' && form.secret ? { secret: form.secret } : {}),
        allowedHosts: hosts,
        allowPrivateNetwork: form.allowPrivateNetwork,
      });
    }
    const body: Record<string, unknown> = {};
    if (form.description.trim() !== (server.description ?? ''))
      body.description = form.description.trim() || null;
    if (form.endpointUrl.trim() !== (server.endpointUrl ?? ''))
      body.endpointUrl = form.endpointUrl.trim();
    if (form.authType !== server.authType) body.authType = form.authType;
    if (form.authType === 'api_key' && form.secret) body.secret = form.secret;
    if (hosts.join() !== server.allowedHosts.join()) body.allowedHosts = hosts;
    if (form.allowPrivateNetwork !== server.allowPrivateNetwork)
      body.allowPrivateNetwork = form.allowPrivateNetwork;
    if (!Object.keys(body).length) return server;
    return api.patch<McpServerView>(`/v1/admin/mcp-servers/${server.id}`, body);
  });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (nameError || urlError || secretMissing) return;
    if (!server && !NAME_PATTERN.test(form.name)) return;
    const saved = await save.run();
    if (saved) {
      set('secret', '');
      onSaved(saved);
    }
  };

  const err = save.error;
  const nameTaken = err instanceof ApiError && err.code === 'NAME_TAKEN' ? err.message : undefined;

  return (
    <form onSubmit={(e) => void submit(e)} noValidate>
      <div className="grid grid-main-side">
        <Card
          title="① 연결 정보"
          description="Agent 가 Tool 을 부를 MCP 서버의 주소와 인증을 입력합니다."
        >
          <Field
            label="서버 이름"
            required
            hint={
              server
                ? '이름은 등록 후 바꿀 수 없어요'
                : `Tool 이름 앞에 붙어요 — 예: ${form.name || 'crm-internal'}.lookup_order`
            }
            error={nameError ?? nameTaken ?? issueFor(err, 'name')}
          >
            <input
              className="input mono-input"
              value={form.name}
              disabled={Boolean(server)}
              placeholder="crm-internal"
              autoComplete="off"
              onChange={(e) => set('name', e.target.value.toLowerCase())}
            />
          </Field>
          <Field label="설명" hint="콘솔에서만 보여요" error={issueFor(err, 'description')}>
            <input
              className="input"
              value={form.description}
              placeholder="사내 CRM 주문 · 고객 조회"
              onChange={(e) => set('description', e.target.value)}
            />
          </Field>
          <fieldset className="choice-group">
            <legend className="field-label">전송 방식</legend>
            <label className="choice selected">
              <input type="radio" name="transport" checked readOnly />
              <span>
                <strong>Streamable HTTP</strong>
                <span className="choice-sub">원격 MCP 서버 (HTTPS)</span>
              </span>
            </label>
            <label className="choice disabled" title="Sandbox 단계에서 지원">
              <input type="radio" name="transport" disabled />
              <span>
                <strong>stdio · Docker Sandbox</strong>
                <span className="choice-sub">
                  이미지 서명 검증 후 격리 실행 — 다음 단계에서 지원
                </span>
              </span>
            </label>
          </fieldset>
          <Field
            label="엔드포인트 URL"
            required
            hint={
              urlWarning ??
              'MCP 서버의 Streamable HTTP 엔드포인트 (예: https://mcp.example.com/mcp)'
            }
            error={urlError ?? issueFor(err, 'endpointUrl')}
          >
            <input
              className="input mono-input"
              type="url"
              inputMode="url"
              value={form.endpointUrl}
              placeholder="https://mcp.example.com/mcp"
              autoComplete="off"
              onChange={(e) => set('endpointUrl', e.target.value)}
            />
          </Field>
          <fieldset className="choice-group">
            <legend className="field-label">인증</legend>
            {(
              [
                ['none', '인증 없음', '공개 · 사내망 전용 서버'],
                ['api_key', 'API Key', 'Authorization 헤더로 전달'],
              ] as const
            ).map(([value, label, sub]) => (
              <label key={value} className={form.authType === value ? 'choice selected' : 'choice'}>
                <input
                  type="radio"
                  name="authType"
                  checked={form.authType === value}
                  onChange={() => set('authType', value)}
                />
                <span>
                  <strong>{label}</strong>
                  <span className="choice-sub">{sub}</span>
                </span>
              </label>
            ))}
            <label className="choice disabled">
              <input type="radio" name="authType" disabled />
              <span>
                <strong>OAuth</strong>
                <span className="choice-sub">지원 예정</span>
              </span>
            </label>
          </fieldset>
          {form.authType === 'api_key' && (
            <Field
              label="API Key"
              required={!server?.secretRef}
              hint={
                server?.secretRef
                  ? '저장된 키가 있어요. 바꿀 때만 입력하세요.'
                  : 'Secret 저장소에 저장되고, 저장한 뒤에는 콘솔에서도 다시 볼 수 없어요.'
              }
              error={
                touched && secretMissing
                  ? 'API Key 인증에는 키가 필요해요'
                  : issueFor(err, 'secret')
              }
            >
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                value={form.secret}
                placeholder={server?.secretRef ? '•••••••• (바꿀 때만)' : 'API Key'}
                onChange={(e) => set('secret', e.target.value)}
              />
            </Field>
          )}
          <Field
            label="추가 허용 호스트"
            hint="서버가 다른 호스트로 연결해야 할 때만 — 한 줄에 하나 (api.example.com, *.example.com)"
            error={issueFor(err, 'allowedHosts')}
          >
            <textarea
              className="input code"
              rows={2}
              value={form.hosts}
              onChange={(e) => set('hosts', e.target.value)}
            />
          </Field>
          <Toggle
            checked={form.allowPrivateNetwork}
            disabled={!isOwner}
            onChange={(v) => set('allowPrivateNetwork', v)}
            label={
              isOwner
                ? '사설 네트워크(사내망 · localhost) 허용'
                : '사설 네트워크 허용 — Owner 만 켤 수 있어요'
            }
          />
          {form.allowPrivateNetwork && (
            <Notice tone="warn">
              <span>
                사설 · 루프백 · 링크로컬 주소로의 연결을 허용합니다. 사내 MCP 서버일 때만 켜 주세요.
              </span>
            </Notice>
          )}
          <ApiErrorNotice
            error={nameTaken ? null : err}
            skipPaths={['name', 'description', 'endpointUrl', 'secret', 'allowedHosts']}
          />
        </Card>
        <div className="stack">
          <Card title="연결 보안 (SSRF 방어)">
            <ul className="guard-list">
              <li>https 주소만 연결합니다 (개발 환경 제외).</li>
              <li>엔드포인트 호스트와 추가 허용 호스트로만 나갑니다.</li>
              <li>
                DNS 해석 결과가 사설 · 루프백 · 링크로컬이면 막습니다 — 사설 네트워크 허용(Owner) 시
                제외.
              </li>
              <li>
                클라우드 메타데이터 주소(169.254.169.254 등)는 어떤 설정으로도 허용하지 않습니다.
              </li>
              <li>
                같은 검사를 연결하는 순간에도 다시 해서 DNS rebinding · 리다이렉트를 막습니다.
              </li>
            </ul>
          </Card>
          <Card title="다음 단계">
            <p className="muted small">
              저장하면 서버가 <strong>작성 중</strong> 상태로 만들어지고, 연결 테스트 → Tool 탐색 ·
              보안 검사 → 등록을 거쳐야 Agent 가 쓸 수 있어요. 중간에 나가도 서버 상세에서 이어서 할
              수 있어요.
            </p>
          </Card>
        </div>
      </div>
      <div className="wizard-actions">
        <Link className="btn btn-ghost" to="/mcp">
          나가기
        </Link>
        <span className="spacer" />
        <Button type="submit" variant="primary" loading={save.pending}>
          {server ? '저장하고 연결 테스트' : '저장하고 연결 테스트'}
        </Button>
      </div>
    </form>
  );
}

/* ② 연결 테스트 */
function TestStep({
  server,
  result,
  onResult,
  onBack,
  onNext,
}: {
  server: McpServerView;
  result: ConnectionTestResult | null;
  onResult: (r: ConnectionTestResult) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const api = useApi();
  const run = useAction(() =>
    api.post<ConnectionTestResult>(`/v1/admin/mcp-servers/${server.id}/test`),
  );
  const started = useRef(false);
  const start = useCallback(async () => {
    const r = await run.run();
    if (r) onResult(r);
  }, [run, onResult]);
  useEffect(() => {
    if (started.current || result) return;
    started.current = true;
    void start();
  }, [result, start]);

  return (
    <>
      <Card
        title="② 연결 테스트"
        description={
          <>
            <Mono>{server.endpointUrl ?? ''}</Mono> 에 SSRF 검사 후 MCP 핸드셰이크를 시도합니다.
          </>
        }
        actions={
          <Button size="sm" loading={run.pending} onClick={() => void start()}>
            다시 테스트
          </Button>
        }
      >
        {run.pending && !result ? (
          <Loading label="연결하는 중… (DNS 해석 · SSRF 검사 · 핸드셰이크)" />
        ) : run.error ? (
          <ApiErrorNotice error={run.error} />
        ) : result ? (
          <>
            <TestResultView result={result} />
            {result.handshake === 'failed' && (
              <Notice tone="info">
                <span>
                  {result.ssrf.allowed
                    ? 'URL · 인증 정보를 확인하고 연결 정보를 고친 뒤 다시 테스트하세요.'
                    : '네트워크 정책에 막혔어요. 연결 정보에서 허용 호스트 · 사설 네트워크 설정을 확인하세요.'}
                </span>
              </Notice>
            )}
          </>
        ) : null}
      </Card>
      <div className="wizard-actions">
        <Button onClick={onBack}>← 연결 정보 수정</Button>
        <span className="spacer" />
        <Button
          variant="primary"
          disabled={result?.handshake !== 'ok' || run.pending}
          onClick={onNext}
        >
          Tool 탐색하기 →
        </Button>
      </div>
    </>
  );
}

/* ③ Tool 탐색 · 보안 검사 */
function DiscoverStep({
  server,
  candidates,
  onDiscovered,
  setCandidates,
  onBack,
  onNext,
}: {
  server: McpServerView;
  candidates: Candidate[] | null;
  onDiscovered: (r: DiscoverResult) => void;
  setCandidates: (c: Candidate[]) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const api = useApi();
  const discover = useAction(() =>
    api.post<DiscoverResult>(`/v1/admin/mcp-servers/${server.id}/discover`),
  );
  const [open, setOpen] = useState<string | null>(null);
  const started = useRef(false);
  const run = useCallback(async () => {
    const r = await discover.run();
    if (r) onDiscovered(r);
  }, [discover, onDiscovered]);
  useEffect(() => {
    if (started.current || candidates) return;
    started.current = true;
    void run();
  }, [candidates, run]);

  const select = useAction(async (list: Candidate[]) =>
    api.put<McpToolView[]>(`/v1/admin/mcp-servers/${server.id}/tool-selection`, {
      tools: list.map((c) => ({
        name: c.name,
        include: c.include,
        permissionLevel: c.level,
        approvalModeOverride: c.mode || null,
      })),
    }),
  );

  const update = (name: string, patch: Partial<Candidate>) =>
    setCandidates((candidates ?? []).map((c) => (c.name === name ? { ...c, ...patch } : c)));

  if (discover.pending && !candidates)
    return (
      <Card title="③ Tool 탐색 · 보안 검사">
        <Loading label="Tool 을 탐색하고 검사하는 중…" />
      </Card>
    );

  const list = candidates ?? [];
  const included = list.filter((c) => c.include);
  const excluded = list.filter((c) => blocked(c));
  const warned = list.filter(
    (c) => !blocked(c) && (c.schema.result === 'warning' || c.security.result === 'warning'),
  );

  return (
    <>
      {discover.error && (
        <>
          <ApiErrorNotice error={discover.error} />
          {!candidates && (
            <div className="wizard-actions">
              <Button onClick={onBack}>← 연결 테스트</Button>
              <span className="spacer" />
              <Button onClick={() => void run()}>다시 탐색</Button>
            </div>
          )}
        </>
      )}
      {candidates && (
        <>
          <Card
            title="③ Tool 탐색 · 보안 검사"
            description="스키마 유효성 · 숨은 지시문 · 보이지 않는 문자 · 민감정보를 검사했어요. 실패한 Tool 은 포함할 수 없고, 등급은 이름 · 설명으로 제안한 값이에요."
            actions={
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setCandidates(
                      list.map((c) => ({
                        ...c,
                        include:
                          !blocked(c) &&
                          c.level !== 'delete' &&
                          c.level !== 'financial' &&
                          c.security.result === 'passed',
                      })),
                    )
                  }
                >
                  권장대로 선택
                </Button>
                <Button size="sm" loading={discover.pending} onClick={() => void run()}>
                  다시 탐색
                </Button>
              </>
            }
            flush
          >
            <div className="discover-summary">
              <span>
                발견 <strong>{list.length}</strong>
              </span>
              <span>
                포함 <strong>{included.length}</strong>
              </span>
              <span className={excluded.length ? 'bad' : undefined}>
                검사 실패 · 제외 <strong>{excluded.length}</strong>
              </span>
              <span className={warned.length ? 'warn' : undefined}>
                경고 <strong>{warned.length}</strong>
              </span>
            </div>
            {list.length === 0 ? (
              <Empty title="서버가 알려 준 Tool 이 없어요">
                서버 구현을 확인한 뒤 다시 탐색하세요.
              </Empty>
            ) : (
              <div className="table-wrap">
                <table className="table discover-table" aria-label="탐색된 Tool">
                  <thead>
                    <tr>
                      <th style={{ width: 52 }}>포함</th>
                      <th>Tool</th>
                      <th>검사</th>
                      <th style={{ width: 150 }}>권한 등급</th>
                      <th style={{ width: 190 }}>승인 정책</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((c) => {
                      const isBlocked = blocked(c);
                      const expanded = open === c.name;
                      const hasIssues = c.schema.issues.length + c.security.issues.length > 0;
                      return (
                        <tr key={c.name} className={isBlocked ? 'row-blocked' : undefined}>
                          <td>
                            <input
                              type="checkbox"
                              className="big-check"
                              aria-label={`${c.name} 포함`}
                              checked={c.include}
                              disabled={isBlocked}
                              onChange={(e) => update(c.name, { include: e.target.checked })}
                            />
                          </td>
                          <td>
                            <div className="tool-cell">
                              <Mono>
                                {server.name}.{c.name}
                              </Mono>
                              {c.description && <p className="cell-sub clamp-2">{c.description}</p>}
                              {isBlocked && (
                                <p className="blocked-note">검사 실패 — 포함할 수 없어요</p>
                              )}
                              {hasIssues && (
                                <button
                                  type="button"
                                  className="link-btn"
                                  aria-expanded={expanded}
                                  onClick={() => setOpen(expanded ? null : c.name)}
                                >
                                  {expanded
                                    ? '검사 결과 접기'
                                    : `검사 결과 ${c.schema.issues.length + c.security.issues.length}건 보기`}
                                </button>
                              )}
                              {expanded && <CheckIssues schema={c.schema} security={c.security} />}
                            </div>
                          </td>
                          <td>
                            <CheckBadges schema={c.schema} security={c.security} />
                          </td>
                          <td>
                            <select
                              className="input input-sm"
                              aria-label={`${c.name} 권한 등급`}
                              value={c.level}
                              disabled={isBlocked}
                              onChange={(e) =>
                                update(c.name, { level: e.target.value as PermissionLevel })
                              }
                            >
                              {LEVELS.map((l) => (
                                <option key={l} value={l}>
                                  {LEVEL[l]}
                                  {l === c.suggestedLevel ? ' (제안)' : ''}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <select
                              className="input input-sm"
                              aria-label={`${c.name} 승인 정책`}
                              value={c.mode}
                              disabled={isBlocked}
                              onChange={(e) =>
                                update(c.name, { mode: e.target.value as ApprovalMode | '' })
                              }
                            >
                              <option value="">등급 기본값</option>
                              {APPROVAL_MODES.map((m) => (
                                <option key={m.value} value={m.value}>
                                  {m.label}
                                </option>
                              ))}
                            </select>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <ApiErrorNotice error={select.error} />
          <div className="wizard-actions">
            <Button onClick={onBack}>← 연결 테스트</Button>
            <span className="spacer" />
            <span className="muted small">{included.length}개 Tool 포함</span>
            <Button
              variant="primary"
              loading={select.pending}
              disabled={included.length === 0}
              onClick={() =>
                void select.run(list).then((r) => {
                  if (r) onNext();
                })
              }
            >
              선택 저장 · 다음 →
            </Button>
          </div>
        </>
      )}
    </>
  );
}

/* ④ 등록 */
function RegisterStep({
  server,
  protocolVersion,
  candidates,
  result,
  onBack,
  onRegistered,
}: {
  server: McpServerView;
  protocolVersion: string | null;
  candidates: Candidate[];
  result: { server: McpServerView; registry: PublishedVersion } | null;
  onBack: () => void;
  onRegistered: (r: { server: McpServerView; registry: PublishedVersion }) => void;
}) {
  const api = useApi();
  const register = useAction(() =>
    api.post<{ server: McpServerView; registry: PublishedVersion }>(
      `/v1/admin/mcp-servers/${server.id}/register`,
    ),
  );
  const included = candidates.filter((c) => c.include);

  if (result) {
    const r = result.registry;
    return (
      <Card>
        <div className="register-done" role="status">
          <span className="done-icon" aria-hidden="true">
            ✓
          </span>
          <h2>{result.server.name} 을(를) 등록했어요</h2>
          <p className="muted">
            {registryMessage(r)} — 새로 만드는 작업부터 이 서버의 Tool {included.length}개를 쓸 수
            있어요.
          </p>
          <Notice tone="info">
            <span>
              Agent 가 실제로 쓰려면 Agent 설정의 MCP 허용 목록에서 이 서버를 켜고 배포하세요.
            </span>
          </Notice>
          <div className="row center">
            <Link className="btn btn-primary" to={`/mcp/${result.server.id}`}>
              서버 상세 보기
            </Link>
            <Link className="btn" to="/agents">
              Agent 설정에서 허용하기
            </Link>
            <Link className="btn btn-ghost" to={`/mcp?tab=registry&v=${r.version}`}>
              Registry v{r.version} 보기
            </Link>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <>
      <div className="grid grid-main-side">
        <Card title="④ 등록 — 마지막 확인" flush>
          <div className="table-wrap">
            <table className="table" aria-label="등록할 Tool">
              <thead>
                <tr>
                  <th>등록할 Tool</th>
                  <th>권한 등급</th>
                  <th>승인 정책</th>
                  <th>검사</th>
                </tr>
              </thead>
              <tbody>
                {included.map((c) => (
                  <tr key={c.name}>
                    <td>
                      <Mono>
                        {server.name}.{c.name}
                      </Mono>
                    </td>
                    <td>
                      <LevelBadge level={c.level} />
                    </td>
                    <td>{approvalLabel(c.mode || null)}</td>
                    <td>
                      <CheckBadges schema={c.schema} security={c.security} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {included.length === 0 && (
              <div className="table-empty">포함한 Tool 이 없어요 — 이전 단계에서 고르세요</div>
            )}
          </div>
        </Card>
        <div className="stack">
          <Card title="서버">
            <KeyValue
              items={[
                ['이름', <Mono key="n">{server.name}</Mono>],
                ['엔드포인트', <Mono key="e">{hostOf(server.endpointUrl)}</Mono>],
                ['프로토콜', protocolVersion ? <Mono key="p">{protocolVersion}</Mono> : '—'],
                ['인증', server.authType === 'api_key' ? 'API Key (저장됨)' : '인증 없음'],
                ['제외한 Tool', `${candidates.length - included.length}개`],
              ]}
            />
          </Card>
          <Card title="등록하면">
            <ul className="guard-list">
              <li>
                새 Tool Registry 버전이 만들어지고, 그 뒤에 만드는 작업부터 적용돼요 (실행 중 작업은
                그대로).
              </li>
              <li>위험 등급 Tool 은 승인 정책에 따라 사용자 · 운영자 승인을 받습니다.</li>
              <li>이후 서버의 Tool 정의가 바뀌면 운영자 검토 전까지 이전 정의로 실행돼요.</li>
            </ul>
          </Card>
        </div>
      </div>
      <ApiErrorNotice error={register.error} />
      <div className="wizard-actions">
        <Button onClick={onBack}>← Tool 선택</Button>
        <span className="spacer" />
        <Button
          variant="primary"
          loading={register.pending}
          disabled={included.length === 0}
          onClick={() =>
            void register.run().then((r) => {
              if (r) onRegistered(r);
            })
          }
        >
          등록하기
        </Button>
      </div>
    </>
  );
}
