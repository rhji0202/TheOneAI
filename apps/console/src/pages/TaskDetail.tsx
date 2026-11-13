import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { formatBytes, formatDuration, formatNumber, formatRemaining } from '../../../shared/format';
import { LEVEL, RISK } from '../../../shared/status';
import { ApiError } from '../api';
import { useApi, useAuth } from '../auth';
import {
  Badge,
  Button,
  Card,
  CopyButton,
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
  ShortId,
  StatusBadge,
  Tabs,
  Time,
  useAction,
  useQuery,
  useToast,
} from '../ui';
import { type AdminTaskRow, failureLabel, formatElapsed, isLive, Progress } from './Tasks';
import './tasks.css';

/* ───────────── 타입 (src/tasks/admin/tasks-admin.service.ts · trace / step) ───────────── */

type StepStatus =
  'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'waiting_approval' | 'cancelled';

interface PlanStep {
  index: number;
  title: string;
  kind: 'reason' | 'tool' | 'skill' | 'respond';
  toolName?: string;
  skill?: { name: string; version: string };
  requiresApproval: boolean;
  status: StepStatus;
}

interface TraceStep {
  id: string;
  seq: number;
  planIndex: number | null;
  type: string;
  name: string;
  status: StepStatus;
  summary: string | null;
  parallelGroup: number | null;
  durationMs: number | null;
  checkpoint: { label: string; at: string } | null;
}

interface ApprovalView {
  id: string;
  taskId: string;
  toolName: string;
  toolSource: string;
  permissionLevel: string;
  riskLevel: string;
  summary: string;
  args: { label: string; value: string }[];
  rawArgs: Record<string, unknown>;
  reason: string;
  requiredApprover: 'user' | 'operator' | 'user_and_operator';
  allowTaskScope: boolean;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';
  waitingFor: 'user' | 'operator' | 'user_and_operator' | null;
  expiresAt: string;
}

interface Usage {
  inputTokens: number;
  outputTokens: number;
}

interface TraceResponse {
  task: AdminTaskRow & {
    agentVersion: number;
    registryVersion: number;
    traceId: string;
    usage: Usage & { byRole: Record<'planner' | 'executor' | 'evaluator', Usage> };
    cost: { amount: string; currency: string };
  };
  stats: {
    steps: { completed: number; total: number | null };
    toolCalls: number;
    retries: number;
    replans: number;
    recoveries: number;
  };
  plans: { version: number; steps: PlanStep[]; reason: string | null; createdAt: string }[];
  steps: TraceStep[];
  artifacts: {
    id: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    previewable: boolean;
    createdAt: string;
    origin: 'user_upload' | 'task_output';
  }[];
  feedback: { rating: 'helpful' | 'not_helpful'; comment: string | null; createdAt: string }[];
  approvals: ApprovalView[];
}

interface ToolExecution {
  id: string;
  toolName: string;
  source: string;
  status: string;
  attempt: number;
  deniedReason: string | null;
  input: unknown;
  output: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  durationMs: number | null;
}

interface StepDetail {
  id: string;
  seq: number;
  planVersion: number | null;
  planIndex: number | null;
  type: string;
  name: string;
  status: StepStatus;
  attempts: number;
  parallelGroup: number | null;
  input: unknown;
  output: unknown;
  evaluation: unknown;
  summary: string | null;
  usage: Usage;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  checkpoint: { at: string; data: unknown } | null;
  toolExecutions: ToolExecution[];
}

/* ───────────── 표시 문구 ───────────── */

const STEP_STATUS: Record<StepStatus, { label: string; tone: BadgeTone }> = {
  pending: { label: '대기', tone: 'neutral' },
  running: { label: '실행 중', tone: 'info' },
  succeeded: { label: '성공', tone: 'success' },
  failed: { label: '실패', tone: 'danger' },
  skipped: { label: '건너뜀', tone: 'neutral' },
  waiting_approval: { label: '승인 대기', tone: 'warning' },
  cancelled: { label: '취소', tone: 'neutral' },
};
type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'purple';

const STEP_TYPE: Record<string, string> = {
  context: '컨텍스트',
  plan: '계획',
  reason: '추론',
  tool: 'Tool',
  skill: 'Skill',
  respond: '답변',
  evaluate: '평가',
};

const STEP_NAME: Record<string, string> = {
  'context.build': '컨텍스트 구성',
  'context.compress_notes': '작업 노트 압축',
  'planner.create': '실행 계획 생성',
  'planner.revise': '재계획',
  'executor.tool': 'Tool 호출 판단',
  'executor.respond': '답변 작성',
  'executor.correct': '답변 정정',
  'evaluator.assess': '중간 평가',
  'evaluator.check': '단계 확인',
  'evaluator.verify': '답변 검증',
  'evaluator.verify_correction': '정정 답변 검증',
};

const TOOL_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  succeeded: { label: '성공', tone: 'success' },
  failed: { label: '실패', tone: 'danger' },
  denied: { label: '거부', tone: 'danger' },
  running: { label: '실행 중', tone: 'info' },
  timeout: { label: '시간 초과', tone: 'danger' },
  cancelled: { label: '취소', tone: 'neutral' },
};

const DENIED_REASON: Record<string, string> = {
  approval_rejected: '승인 거절',
  not_allowed: 'Agent 허용 목록 밖',
  blocked_by_policy: '등급 정책 차단',
  blocked_by_rule: '조건 규칙 차단',
  tool_unavailable: 'Tool 사용 불가 (서버 장애 · 비활성)',
  unknown_tool: 'Registry 에 없는 Tool',
};

const TOOL_SOURCE: Record<string, string> = {
  mcp: 'MCP',
  sandbox: 'Sandbox',
  builtin: '내장',
  skill_script: 'Skill 스크립트',
};

const APPROVAL_STATUS: Record<ApprovalView['status'], { label: string; tone: BadgeTone }> = {
  pending: { label: '대기', tone: 'warning' },
  approved: { label: '승인', tone: 'success' },
  rejected: { label: '거절', tone: 'danger' },
  expired: { label: '만료', tone: 'neutral' },
  cancelled: { label: '취소', tone: 'neutral' },
};

const APPROVER: Record<ApprovalView['requiredApprover'], string> = {
  user: '사용자',
  operator: '운영자',
  user_and_operator: '사용자 + 운영자',
};

const CONTROL_ERROR: Record<string, string> = {
  TASK_NOT_ACTIVE: '이미 끝난 작업이에요.',
  TASK_NOT_RESUMABLE: '실패하거나 일시정지된 작업만 재개할 수 있어요.',
  CHECKPOINT_NOT_FOUND: '재개할 checkpoint 가 없어요. 처음부터 다시 실행해 주세요.',
  TASK_ALREADY_ACTIVE: '같은 대화에서 다른 작업이 진행 중이라 재개할 수 없어요.',
  BUDGET_EXCEEDED: '월 비용 한도를 넘어 실행할 수 없어요. 사용량 · 비용에서 한도를 확인해 주세요.',
};

function controlError(err: Error | null): Error | null {
  if (!err) return null;
  if (err instanceof ApiError && CONTROL_ERROR[err.code]) return new Error(CONTROL_ERROR[err.code]);
  return err;
}

export function formatMoney(amount: string | number, currency: string): string {
  const n = Number(amount);
  try {
    return new Intl.NumberFormat('ko-KR', {
      style: 'currency',
      currency,
      maximumFractionDigits: n !== 0 && Math.abs(n) < 1 ? 4 : 2,
    }).format(n);
  } catch {
    return `${formatNumber(n, 4)} ${currency}`;
  }
}

function StepStatusBadge({ status }: { status: StepStatus }) {
  const s = STEP_STATUS[status] ?? { label: status, tone: 'neutral' as const };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

const PAUSABLE = ['queued', 'running', 'waiting_approval', 'recovering'];
const CANCELLABLE = ['queued', 'running', 'waiting_approval', 'recovering', 'paused'];
const RESUMABLE = ['failed', 'paused'];

/* ───────────── C-02 작업 상세 · 실행 트레이스 ───────────── */

export function TaskDetailPage() {
  const { id = '' } = useParams();
  const api = useApi();
  const { can } = useAuth();
  const [polling, setPolling] = useState(false);
  const trace = useQuery(() => api.get<TraceResponse>(`/v1/admin/tasks/${id}/trace`), [id], {
    pollMs: polling ? 3_000 : undefined,
  });
  const data = trace.data;
  useEffect(() => setPolling(Boolean(data && isLive(data.task.status))), [data]);

  const [openStep, setOpenStep] = useState<string | null>(null);
  const [control, setControl] = useState<'pause' | 'cancel' | 'resume' | null>(null);

  if (!data) {
    return (
      <>
        <PageHeader title="작업 상세" back={{ to: '/tasks', label: '작업' }} />
        {trace.error ? (
          <ErrorNotice
            error={
              trace.error instanceof ApiError && trace.error.status === 404
                ? new Error('작업을 찾을 수 없어요.')
                : trace.error
            }
            onRetry={() => void trace.reload()}
          />
        ) : (
          <Loading />
        )}
      </>
    );
  }

  const { task, stats } = data;
  const operator = can('operator');
  const checkpoints = data.steps.filter((s) => s.checkpoint);
  const verify = [...data.steps]
    .reverse()
    .find((s) => s.name === 'evaluator.verify' || s.name === 'evaluator.verify_correction');

  return (
    <>
      <PageHeader
        back={{ to: '/tasks', label: '작업' }}
        title={task.title}
        meta={
          <>
            <StatusBadge status={task.status} />
            <ShortId id={task.id} />
            <span>
              {task.agentName} v{task.agentVersion}
            </span>
            <span>· {task.endUserPseudonym}</span>
            <span>
              · <Time iso={task.createdAt} absolute />
            </span>
            {polling && <Badge tone="info">실시간 갱신 중</Badge>}
          </>
        }
        actions={
          <>
            <Link className="btn btn-secondary" to={`/conversations/${task.conversationId}`}>
              대화 보기
            </Link>
            {operator && PAUSABLE.includes(task.status) && (
              <Button onClick={() => setControl('pause')}>일시정지</Button>
            )}
            {operator && RESUMABLE.includes(task.status) && (
              <Button variant="primary" onClick={() => setControl('resume')}>
                재개
              </Button>
            )}
            {operator && CANCELLABLE.includes(task.status) && (
              <Button variant="danger" onClick={() => setControl('cancel')}>
                중지
              </Button>
            )}
          </>
        }
      />

      <ErrorNotice error={trace.error} onRetry={() => void trace.reload()} />
      <StatusNotices task={task} hasCheckpoint={checkpoints.length > 0} />

      <div className="tk-stats" aria-label="실행 요약">
        <Stat label="단계">
          <Progress completed={stats.steps.completed} total={stats.steps.total} />
        </Stat>
        <Stat label="Tool 호출">{formatNumber(stats.toolCalls)}</Stat>
        <Stat label="재시도">{formatNumber(stats.retries)}</Stat>
        <Stat label="재계획">{formatNumber(stats.replans)}</Stat>
        <Stat label="복구">{formatNumber(stats.recoveries)}</Stat>
        <Stat label="토큰">{formatNumber(task.usage.inputTokens + task.usage.outputTokens)}</Stat>
        <Stat label="비용">{formatMoney(task.cost.amount, task.cost.currency)}</Stat>
        <Stat label="소요">{formatElapsed(task.elapsedMs)}</Stat>
      </div>

      <div className="grid grid-main-side">
        <div className="stack">
          <Card
            title="실행 트레이스"
            description="Agent Loop 단계 순서 — 단계를 누르면 입력 · 출력 · Tool 실행을 봅니다."
            flush
          >
            <Timeline steps={data.steps} onOpen={setOpenStep} />
          </Card>
          {data.approvals.length > 0 && <ApprovalsCard approvals={data.approvals} />}
        </div>
        <div className="stack">
          <PlanCard plans={data.plans} steps={data.steps} />
          {verify && (
            <Card title="결과 검증">
              <div className="row">
                <StepStatusBadge status={verify.status} />
                <span className="muted">{STEP_NAME[verify.name]}</span>
              </div>
              {verify.summary && <p className="tk-verify-text">{verify.summary}</p>}
            </Card>
          )}
          <Card title="실행 정보">
            <KeyValue
              items={[
                [
                  'Agent',
                  <>
                    {task.agentName} <Badge>v{task.agentVersion}</Badge>
                  </>,
                ],
                [
                  'Tool Registry',
                  <span key="r" title="작업을 시작할 때 고정된 Registry 버전">
                    <Badge tone="purple">v{task.registryVersion}</Badge>{' '}
                    <span className="muted">시작 시 고정</span>
                  </span>,
                ],
                ['사용자', task.endUserPseudonym],
                ['Worker', task.workerId ? <Mono>{task.workerId}</Mono> : null],
                [
                  'Trace ID',
                  task.traceId ? (
                    <span key="t" className="row tk-nowrap">
                      <Mono>{task.traceId}</Mono>
                      <CopyButton text={task.traceId} />
                    </span>
                  ) : null,
                ],
                ['시작', <Time key="c" iso={task.createdAt} absolute />],
                [
                  '종료',
                  task.finishedAt ? <Time key="f" iso={task.finishedAt} absolute /> : '진행 중',
                ],
              ]}
            />
          </Card>
          <Card title="토큰 사용량" description="모델 역할별 입력 / 출력">
            <TokenTable usage={task.usage} />
          </Card>
          {data.artifacts.length > 0 && <ArtifactsCard artifacts={data.artifacts} />}
          <FeedbackCard feedback={data.feedback} />
        </div>
      </div>

      <StepModal taskId={task.id} stepId={openStep} onClose={() => setOpenStep(null)} />
      <ControlModal
        kind={control}
        task={task}
        checkpoints={checkpoints}
        onClose={() => setControl(null)}
        onDone={() => {
          setControl(null);
          void trace.reload();
        }}
      />
    </>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="tk-stat">
      <span className="tk-stat-label">{label}</span>
      <span className="tk-stat-value">{children}</span>
    </div>
  );
}

function StatusNotices({
  task,
  hasCheckpoint,
}: {
  task: TraceResponse['task'];
  hasCheckpoint: boolean;
}) {
  if (task.status === 'failed' && task.failure) {
    return (
      <Notice tone="error">
        <span>
          <strong>{failureLabel(task.failure.code)}</strong> <Mono>{task.failure.code}</Mono>
          {task.failure.message && <> — {task.failure.message}</>}
          <br />
          {task.failure.resumable
            ? '마지막 checkpoint 부터 재개할 수 있어요.'
            : '저장된 checkpoint 가 없어 처음부터 다시 실행해야 해요.'}
        </span>
      </Notice>
    );
  }
  if (task.status === 'waiting_approval' && task.pendingApproval) {
    return (
      <Notice tone="warn">
        <span>
          승인을 기다리는 중이에요 · {formatRemaining(task.pendingApproval.expiresAt)}. 응답이
          없으면 작업이 일시정지됩니다.
        </span>
        <Link to="/approvals" className="btn btn-sm btn-secondary">
          승인 큐에서 보기
        </Link>
      </Notice>
    );
  }
  if (task.status === 'paused') {
    return (
      <Notice tone="info">
        <span>
          일시정지된 작업이에요.{' '}
          {hasCheckpoint
            ? 'checkpoint 부터 이어서 실행하거나 처음부터 다시 실행할 수 있어요.'
            : '처음부터 다시 실행할 수 있어요.'}
        </span>
      </Notice>
    );
  }
  if (task.status === 'recovering') {
    return (
      <Notice tone="info">
        <span>
          Worker 연결이 끊겨 마지막 checkpoint 부터 복구하는 중이에요 (복구 {task.recoveryCount}회).
        </span>
      </Notice>
    );
  }
  return null;
}

/* ── 타임라인 ── */

function Timeline({ steps, onOpen }: { steps: TraceStep[]; onOpen: (id: string) => void }) {
  if (steps.length === 0) return <Empty title="아직 실행된 단계가 없어요" />;
  return (
    <ol className="tk-timeline">
      {steps.map((s) => (
        <li key={s.id} className={`tl-item tl-${s.status}`}>
          <span className="tl-dot" aria-hidden="true" />
          <button type="button" className="tl-body" onClick={() => onOpen(s.id)}>
            <span className="tl-head">
              <span className="tl-seq">#{s.seq}</span>
              <span className={`tl-type tl-type-${s.type}`}>{STEP_TYPE[s.type] ?? s.type}</span>
              <span className="tl-name">
                {STEP_NAME[s.name] ?? <span className="tk-mono">{s.name}</span>}
              </span>
              {s.name === 'planner.revise' && <Badge tone="purple">재계획</Badge>}
              <span className="spacer" />
              <StepStatusBadge status={s.status} />
            </span>
            <span className="tl-meta">
              {STEP_NAME[s.name] && s.type !== 'tool' && <span className="tk-mono">{s.name}</span>}
              {s.planIndex !== null && <span>계획 {s.planIndex}단계</span>}
              {s.parallelGroup !== null && <span>병렬 그룹 {s.parallelGroup}</span>}
              {s.durationMs !== null && <span>{formatDuration(s.durationMs)}</span>}
              {s.checkpoint && (
                <span className="tl-cp" title={`checkpoint 저장 · ${s.checkpoint.at}`}>
                  ⚑ {s.checkpoint.label}
                </span>
              )}
            </span>
            {s.summary && <span className="tl-summary">{s.summary}</span>}
          </button>
        </li>
      ))}
    </ol>
  );
}

/* ── 실행 계획 (재계획 이력) ── */

function PlanCard({ plans, steps }: { plans: TraceResponse['plans']; steps: TraceStep[] }) {
  const latest = plans.length ? plans[plans.length - 1]!.version : 0;
  const [version, setVersion] = useState(latest);
  useEffect(() => setVersion(latest), [latest]);
  const plan = plans.find((p) => p.version === version) ?? plans[plans.length - 1];

  // 최신 계획의 단계 상태는 실제 실행 단계에서 (계획 이벤트의 상태는 만들 때 값)
  const statusOf = useMemo(() => {
    const map = new Map<number, StepStatus>();
    for (const s of steps) {
      if (s.planIndex !== null && s.type !== 'context' && s.type !== 'evaluate')
        map.set(s.planIndex, s.status);
    }
    return map;
  }, [steps]);

  if (!plan) {
    return (
      <Card title="실행 계획">
        <p className="muted">계획을 아직 만들지 않았어요.</p>
      </Card>
    );
  }
  const isLatest = plan.version === latest;
  return (
    <Card
      title="실행 계획"
      actions={plans.length > 1 ? <Badge tone="purple">재계획 {plans.length - 1}회</Badge> : null}
    >
      {plans.length > 1 && (
        <Tabs
          label="계획 버전"
          tabs={plans.map((p) => ({ id: String(p.version), label: `v${p.version}` }))}
          value={String(plan.version)}
          onChange={(v) => setVersion(Number(v))}
        />
      )}
      {plan.reason && (
        <p className="tk-plan-reason">
          <strong>재계획 사유</strong> {plan.reason}
        </p>
      )}
      <ol className="tk-plan-list">
        {plan.steps.map((st) => {
          const status = isLatest ? statusOf.get(st.index) : undefined;
          return (
            <li key={st.index} className="tk-plan-item">
              <span className={`tk-plan-num ${status ?? 'none'}`}>{st.index}</span>
              <div className="tk-plan-text">
                <span className="tk-plan-title">{st.title}</span>
                <span className="cell-sub">
                  {st.kind === 'tool' && st.toolName && <Mono>{st.toolName}</Mono>}
                  {st.kind === 'skill' && st.skill && (
                    <Mono>
                      {st.skill.name}@{st.skill.version}
                    </Mono>
                  )}
                  {(st.kind === 'reason' || st.kind === 'respond') && STEP_TYPE[st.kind]}
                  {st.requiresApproval && (
                    <>
                      {' '}
                      <Badge tone="warning">승인 필요</Badge>
                    </>
                  )}
                </span>
              </div>
              {status && <StepStatusBadge status={status} />}
            </li>
          );
        })}
      </ol>
      <p className="cell-sub">
        v{plan.version} · <Time iso={plan.createdAt} />
      </p>
    </Card>
  );
}

/* ── 승인 · 산출물 · 피드백 · 토큰 ── */

function ApprovalsCard({ approvals }: { approvals: ApprovalView[] }) {
  return (
    <Card title="승인 요청" flush>
      <ul className="tk-list">
        {approvals.map((a) => {
          const st = APPROVAL_STATUS[a.status];
          const risk = RISK[a.riskLevel];
          return (
            <li key={a.id} className="tk-approval-row">
              <div className="row">
                <Mono>{a.toolName}</Mono>
                <Badge tone={st.tone}>{st.label}</Badge>
                {risk && (
                  <span className="badge" style={{ background: risk.bg, color: risk.fg }}>
                    위험도 {risk.label}
                  </span>
                )}
                <Badge>{LEVEL[a.permissionLevel] ?? a.permissionLevel}</Badge>
                <span className="spacer" />
                <span className="cell-sub">
                  {APPROVER[a.requiredApprover]} 승인
                  {a.status === 'pending' && ` · ${formatRemaining(a.expiresAt)}`}
                </span>
              </div>
              <p className="tk-approval-summary">{a.summary}</p>
              {a.args.length > 0 && (
                <dl className="tk-args">
                  {a.args.map((arg) => (
                    <div key={arg.label}>
                      <dt>{arg.label}</dt>
                      <dd>{arg.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {a.status === 'pending' && (
                <Link to="/approvals" className="btn btn-sm btn-secondary">
                  승인 큐에서 결정
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function ArtifactsCard({ artifacts }: { artifacts: TraceResponse['artifacts'] }) {
  const api = useApi();
  const toast = useToast();
  const download = useAction((a: TraceResponse['artifacts'][number]) =>
    api.download(`/v1/admin/artifacts/${a.id}/download`, a.fileName),
  );
  useEffect(() => {
    if (download.error) toast(download.error.message, 'danger');
  }, [download.error, toast]);
  return (
    <Card title="파일" flush>
      <ul className="tk-list">
        {artifacts.map((a) => (
          <li key={a.id} className="tk-file-row">
            <div className="tk-file-text">
              <span className="tk-file-name">{a.fileName}</span>
              <span className="cell-sub">
                {a.origin === 'user_upload' ? '사용자 첨부' : '산출물'} · {formatBytes(a.sizeBytes)}{' '}
                · {a.mimeType}
              </span>
            </div>
            <Button size="sm" onClick={() => void download.run(a)}>
              다운로드
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function FeedbackCard({ feedback }: { feedback: TraceResponse['feedback'] }) {
  return (
    <Card title="사용자 피드백">
      {feedback.length === 0 ? (
        <p className="muted">피드백이 없어요.</p>
      ) : (
        <ul className="tk-list tk-compact">
          {feedback.map((f, i) => (
            <li key={i}>
              <Badge tone={f.rating === 'helpful' ? 'success' : 'danger'}>
                {f.rating === 'helpful' ? '👍 도움됨' : '👎 아쉬움'}
              </Badge>{' '}
              <Time iso={f.createdAt} />
              {f.comment && <p className="tk-feedback-comment">“{f.comment}”</p>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function TokenTable({ usage }: { usage: TraceResponse['task']['usage'] }) {
  const rows: [string, Usage][] = [
    ['Planner', usage.byRole.planner],
    ['Executor', usage.byRole.executor],
    ['Evaluator', usage.byRole.evaluator],
  ];
  return (
    <table className="tk-mini-table">
      <thead>
        <tr>
          <th>역할</th>
          <th className="num">입력</th>
          <th className="num">출력</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([role, u]) => (
          <tr key={role}>
            <td>{role}</td>
            <td className="num">{formatNumber(u.inputTokens)}</td>
            <td className="num">{formatNumber(u.outputTokens)}</td>
          </tr>
        ))}
        <tr className="tk-total">
          <td>합계</td>
          <td className="num">{formatNumber(usage.inputTokens)}</td>
          <td className="num">{formatNumber(usage.outputTokens)}</td>
        </tr>
      </tbody>
    </table>
  );
}

/* ── 단계 상세 ── */

function StepModal({
  taskId,
  stepId,
  onClose,
}: {
  taskId: string;
  stepId: string | null;
  onClose: () => void;
}) {
  const api = useApi();
  const step = useQuery(
    () => api.get<StepDetail>(`/v1/admin/tasks/${taskId}/steps/${stepId}`),
    [taskId, stepId],
    { enabled: Boolean(stepId) },
  );
  const [tab, setTab] = useState<'tools' | 'input' | 'output' | 'evaluation' | 'checkpoint'>(
    'tools',
  );
  const d = step.data && step.data.id === stepId ? step.data : undefined;
  useEffect(() => {
    if (d) setTab(d.toolExecutions.length ? 'tools' : 'output');
  }, [d]);

  return (
    <Modal
      open={Boolean(stepId)}
      onClose={onClose}
      wide
      title={
        d ? (
          <>
            #{d.seq} {STEP_NAME[d.name] ?? d.name}
          </>
        ) : (
          '단계 상세'
        )
      }
    >
      {!d ? (
        step.error ? (
          <ErrorNotice error={step.error} onRetry={() => void step.reload()} />
        ) : (
          <Loading />
        )
      ) : (
        <div className="tk-step-detail">
          <KeyValue
            items={[
              [
                '종류 · 상태',
                <span key="s" className="row">
                  <span className={`tl-type tl-type-${d.type}`}>{STEP_TYPE[d.type] ?? d.type}</span>
                  <Mono>{d.name}</Mono>
                  <StepStatusBadge status={d.status} />
                </span>,
              ],
              [
                '계획',
                d.planIndex !== null
                  ? `v${d.planVersion ?? '?'} · ${d.planIndex}단계`
                  : '계획 밖 단계',
              ],
              ['시도', `${d.attempts}회`],
              [
                '시간',
                <span key="t">
                  <Time iso={d.startedAt} absolute /> → <Time iso={d.finishedAt} absolute />
                  {d.durationMs !== null && ` (${formatDuration(d.durationMs)})`}
                </span>,
              ],
              [
                '토큰',
                `입력 ${formatNumber(d.usage.inputTokens)} · 출력 ${formatNumber(d.usage.outputTokens)}`,
              ],
              ['병렬 그룹', d.parallelGroup ?? '—'],
              [
                'checkpoint',
                d.checkpoint ? <Time key="c" iso={d.checkpoint.at} absolute /> : '없음',
              ],
            ]}
          />
          {d.summary && (
            <Field label="요약">
              <p className="tk-step-summary">{d.summary}</p>
            </Field>
          )}
          <Tabs
            label="단계 데이터"
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'tools', label: 'Tool 실행', count: d.toolExecutions.length },
              { id: 'input', label: '입력' },
              { id: 'output', label: '출력' },
              { id: 'evaluation', label: '평가' },
              ...(d.checkpoint ? [{ id: 'checkpoint' as const, label: 'checkpoint' }] : []),
            ]}
          />
          {tab === 'tools' &&
            (d.toolExecutions.length === 0 ? (
              <p className="muted">이 단계에서는 Tool 을 실행하지 않았어요.</p>
            ) : (
              <div className="stack">
                {d.toolExecutions.map((e) => (
                  <ToolExecutionItem key={e.id} exec={e} />
                ))}
              </div>
            ))}
          {tab === 'input' && <JsonOrEmpty value={d.input} />}
          {tab === 'output' && <JsonOrEmpty value={d.output} />}
          {tab === 'evaluation' && <JsonOrEmpty value={d.evaluation} />}
          {tab === 'checkpoint' && d.checkpoint && <JsonOrEmpty value={d.checkpoint.data} />}
          <p className="cell-sub">민감정보는 서버에서 마스킹된 값입니다.</p>
        </div>
      )}
    </Modal>
  );
}

function JsonOrEmpty({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <p className="muted">기록된 값이 없어요.</p>;
  return <Json value={value} />;
}

function ToolExecutionItem({ exec }: { exec: ToolExecution }) {
  const st = TOOL_STATUS[exec.status] ?? { label: exec.status, tone: 'neutral' as const };
  return (
    <details className="tk-tool-exec" open={exec.status !== 'succeeded'}>
      <summary>
        <Mono>{exec.toolName}</Mono>
        <Badge tone={st.tone}>{st.label}</Badge>
        <span className="cell-sub">
          {TOOL_SOURCE[exec.source] ?? exec.source} · {exec.attempt}번째 시도
          {exec.durationMs !== null && ` · ${formatDuration(exec.durationMs)}`}
        </span>
      </summary>
      {exec.deniedReason && (
        <Notice tone="warn">
          <span>거부 사유: {DENIED_REASON[exec.deniedReason] ?? exec.deniedReason}</span>
        </Notice>
      )}
      {exec.errorCode && (
        <Notice tone="error">
          <span>
            <Mono>{exec.errorCode}</Mono> {exec.errorMessage}
          </span>
        </Notice>
      )}
      <div className="grid grid-2">
        <div>
          <p className="field-label">인자</p>
          <JsonOrEmpty value={exec.input} />
        </div>
        <div>
          <p className="field-label">결과</p>
          <JsonOrEmpty value={exec.output} />
        </div>
      </div>
    </details>
  );
}

/* ── 제어 (일시정지 · 중지 · 재개) ── */

function ControlModal({
  kind,
  task,
  checkpoints,
  onClose,
  onDone,
}: {
  kind: 'pause' | 'cancel' | 'resume' | null;
  task: TraceResponse['task'];
  checkpoints: TraceStep[];
  onClose: () => void;
  onDone: () => void;
}) {
  const api = useApi();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const latestCp = checkpoints[checkpoints.length - 1]?.id ?? '';
  const [mode, setMode] = useState<'checkpoint' | 'restart'>('checkpoint');
  const [fromStepId, setFromStepId] = useState(latestCp);
  useEffect(() => {
    if (!kind) return;
    setReason('');
    setMode(checkpoints.length ? 'checkpoint' : 'restart');
    setFromStepId(latestCp);
    // 열 때마다 초기화
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  const action = useAction(async () => {
    if (kind === 'pause') {
      await api.post(`/v1/admin/tasks/${task.id}/pause`, reason ? { reason } : {});
      return '일시정지를 요청했어요. 진행 중인 단계를 마치면 멈춥니다.';
    }
    if (kind === 'cancel') {
      await api.post(`/v1/admin/tasks/${task.id}/cancel`, reason ? { reason } : {});
      return '작업을 중지했어요.';
    }
    await api.post(
      `/v1/admin/tasks/${task.id}/resume`,
      mode === 'checkpoint' ? { mode, fromStepId: fromStepId || undefined } : { mode },
    );
    return mode === 'checkpoint' ? 'checkpoint 부터 재개했어요.' : '처음부터 다시 실행해요.';
  });
  useEffect(() => {
    if (!kind) action.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  const submit = async () => {
    const message = await action.run();
    if (message) {
      toast(message);
      onDone();
    }
  };

  const title = kind === 'pause' ? '작업 일시정지' : kind === 'cancel' ? '작업 중지' : '작업 재개';
  return (
    <Modal
      open={kind !== null}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button onClick={onClose}>닫기</Button>
          <Button
            variant={kind === 'cancel' ? 'danger' : 'primary'}
            loading={action.pending}
            disabled={kind === 'resume' && mode === 'checkpoint' && !fromStepId}
            onClick={() => void submit()}
          >
            {kind === 'pause' ? '일시정지' : kind === 'cancel' ? '중지' : '재개'}
          </Button>
        </>
      }
    >
      <p className="tk-modal-title">{task.title}</p>
      {kind === 'pause' && (
        <p className="muted">
          실행 중인 단계는 마치고 멈춥니다. 승인 대기 · 대기 중인 작업은 바로 멈춥니다. 나중에
          checkpoint 부터 재개할 수 있어요.
        </p>
      )}
      {kind === 'cancel' && (
        <p className="muted">
          중지한 작업은 다시 이어서 실행할 수 없어요. 대기 중인 승인 요청도 함께 취소됩니다.
        </p>
      )}
      {(kind === 'pause' || kind === 'cancel') && (
        <Field label="사유" hint="감사 로그에 남습니다 (선택)">
          <textarea
            className="input"
            rows={3}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
      )}
      {kind === 'resume' && (
        <div className="stack tk-resume-options" role="radiogroup" aria-label="재개 방식">
          <label className={`tk-option${checkpoints.length ? '' : ' disabled'}`}>
            <input
              type="radio"
              name="mode"
              checked={mode === 'checkpoint'}
              disabled={!checkpoints.length}
              onChange={() => setMode('checkpoint')}
            />
            <span>
              <strong>checkpoint 부터 재개</strong>
              <span className="cell-sub">
                {checkpoints.length
                  ? '끝난 단계는 건너뛰고 저장된 지점부터 이어서 실행해요.'
                  : '저장된 checkpoint 가 없어요.'}
              </span>
              {mode === 'checkpoint' && checkpoints.length > 0 && (
                <select
                  className="input"
                  aria-label="재개할 checkpoint"
                  value={fromStepId}
                  onChange={(e) => setFromStepId(e.target.value)}
                >
                  {[...checkpoints].reverse().map((c, i) => (
                    <option key={c.id} value={c.id}>
                      {c.checkpoint!.label} · #{c.seq} {STEP_NAME[c.name] ?? c.name}
                      {i === 0 ? ' (최근)' : ''}
                    </option>
                  ))}
                </select>
              )}
            </span>
          </label>
          <label className="tk-option">
            <input
              type="radio"
              name="mode"
              checked={mode === 'restart'}
              onChange={() => setMode('restart')}
            />
            <span>
              <strong>처음부터 다시</strong>
              <span className="cell-sub">계획부터 새로 실행해요. 토큰 · 비용이 다시 듭니다.</span>
            </span>
          </label>
        </div>
      )}
      <ErrorNotice error={controlError(action.error)} />
    </Modal>
  );
}
