import { useEffect, useId, useMemo, useState } from 'react';
import {
  ArrowRightIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CirclePauseIcon,
  CircleSlashIcon,
  CircleXIcon,
  DownloadIcon,
  FileIcon,
  FlagIcon,
  LoaderCircleIcon,
  type LucideIcon,
  MessagesSquareIcon,
  PauseIcon,
  PlayIcon,
  SquareIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
} from 'lucide-react';
import { Link, useParams } from 'react-router';
import { formatBytes, formatDuration, formatNumber, formatRemaining } from '../../../shared/format';
import { LEVEL, RISK } from '../../../shared/status';
import { ApiError } from '../api';
import { useApi, useAuth } from '../auth';
import {
  Badge,
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
  type Tone,
  TONE_CLASS,
  useAction,
  useQuery,
  useToast,
} from '../ui';
import { Badge as UiBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Progress as ProgressBar } from '@/components/ui/progress';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { type AdminTaskRow, failureLabel, formatElapsed, isLive, type TaskStatus } from './Tasks';

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

const STEP_STATUS: Record<
  StepStatus,
  { label: string; tone: Tone; icon: LucideIcon; iconClass: string }
> = {
  pending: {
    label: '대기',
    tone: 'neutral',
    icon: CircleDashedIcon,
    iconClass: 'text-muted-foreground',
  },
  running: {
    label: '실행 중',
    tone: 'info',
    icon: LoaderCircleIcon,
    iconClass: 'animate-spin text-blue-600 dark:text-blue-400',
  },
  succeeded: {
    label: '성공',
    tone: 'success',
    icon: CircleCheckIcon,
    iconClass: 'text-emerald-600 dark:text-emerald-400',
  },
  failed: {
    label: '실패',
    tone: 'danger',
    icon: CircleXIcon,
    iconClass: 'text-red-600 dark:text-red-400',
  },
  skipped: {
    label: '건너뜀',
    tone: 'neutral',
    icon: CircleDashedIcon,
    iconClass: 'text-muted-foreground',
  },
  waiting_approval: {
    label: '승인 대기',
    tone: 'warning',
    icon: CirclePauseIcon,
    iconClass: 'text-amber-600 dark:text-amber-400',
  },
  cancelled: {
    label: '취소',
    tone: 'neutral',
    icon: CircleSlashIcon,
    iconClass: 'text-muted-foreground',
  },
};

function stepStatus(status: string) {
  return STEP_STATUS[status as StepStatus] ?? { ...STEP_STATUS.pending, label: status };
}

const BRAND_CHIP = 'bg-primary/10 text-primary';

const STEP_TYPE: Record<string, { label: string; className: string }> = {
  context: { label: '컨텍스트', className: TONE_CLASS.neutral },
  plan: { label: '계획', className: BRAND_CHIP },
  reason: { label: '추론', className: TONE_CLASS.neutral },
  tool: { label: 'Tool', className: TONE_CLASS.info },
  skill: { label: 'Skill', className: TONE_CLASS.purple },
  respond: { label: '답변', className: TONE_CLASS.success },
  evaluate: { label: '평가', className: BRAND_CHIP },
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

const TOOL_STATUS: Record<string, { label: string; tone: Tone }> = {
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

const APPROVAL_STATUS: Record<ApprovalView['status'], { label: string; tone: Tone }> = {
  pending: { label: '대기', tone: 'warning' },
  approved: { label: '승인', tone: 'success' },
  rejected: { label: '거절', tone: 'danger' },
  expired: { label: '만료', tone: 'neutral' },
  cancelled: { label: '취소', tone: 'neutral' },
};

const RISK_TONE: Record<string, Tone> = { low: 'success', medium: 'warning', high: 'danger' };

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
  const s = stepStatus(status);
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

function StepTypeChip({ type }: { type: string }) {
  const t = STEP_TYPE[type];
  return (
    <UiBadge className={cn('rounded-md font-semibold', t?.className ?? TONE_CLASS.neutral)}>
      {t?.label ?? type}
    </UiBadge>
  );
}

/** 운영자 제어 — 헤더 버튼과 확인 창이 같은 문구를 쓴다 */
const CONTROL_KINDS = ['pause', 'resume', 'cancel'] as const;
type ControlKind = (typeof CONTROL_KINDS)[number];

const CONTROL: Record<
  ControlKind,
  {
    label: string;
    title: string;
    icon: LucideIcon;
    variant: 'default' | 'outline' | 'destructive';
    from: TaskStatus[];
  }
> = {
  pause: {
    label: '일시정지',
    title: '작업 일시정지',
    icon: PauseIcon,
    variant: 'outline',
    from: ['queued', 'running', 'waiting_approval', 'recovering'],
  },
  resume: {
    label: '재개',
    title: '작업 재개',
    icon: PlayIcon,
    variant: 'default',
    from: ['failed', 'paused'],
  },
  cancel: {
    label: '중지',
    title: '작업 중지',
    icon: SquareIcon,
    variant: 'destructive',
    from: ['queued', 'running', 'waiting_approval', 'recovering', 'paused'],
  },
};

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
  const [control, setControl] = useState<ControlKind | null>(null);

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
  const stepRatio = stats.steps.total ? Math.min(1, stats.steps.completed / stats.steps.total) : 0;

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
            {polling && (
              <Badge tone="info">
                <span className="size-1.5 animate-pulse rounded-full bg-current" />
                실시간 갱신 중
              </Badge>
            )}
          </>
        }
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to={`/conversations/${task.conversationId}`}>
                <MessagesSquareIcon aria-hidden="true" />
                대화 보기
              </Link>
            </Button>
            {operator &&
              CONTROL_KINDS.filter((k) => CONTROL[k].from.includes(task.status)).map((k) => {
                const { label, icon: Icon, variant } = CONTROL[k];
                return (
                  <Button key={k} variant={variant} onClick={() => setControl(k)}>
                    <Icon aria-hidden="true" />
                    {label}
                  </Button>
                );
              })}
          </>
        }
      />

      <ErrorNotice error={trace.error} onRetry={() => void trace.reload()} />
      <StatusNotices task={task} hasCheckpoint={checkpoints.length > 0} />

      <dl
        aria-label="실행 요약"
        className="mb-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border shadow-sm min-[560px]:grid-cols-4 min-[1100px]:grid-cols-8"
      >
        <Stat label="단계">
          {stats.steps.completed}/{stats.steps.total ?? '?'}
          <ProgressBar
            value={Math.round(stepRatio * 100)}
            aria-hidden="true"
            className="mt-1.5 h-1 bg-muted"
          />
        </Stat>
        <Stat label="Tool 호출">{formatNumber(stats.toolCalls)}</Stat>
        <Stat label="재시도">{formatNumber(stats.retries)}</Stat>
        <Stat label="재계획">{formatNumber(stats.replans)}</Stat>
        <Stat label="복구">{formatNumber(stats.recoveries)}</Stat>
        <Stat label="토큰">{formatNumber(task.usage.inputTokens + task.usage.outputTokens)}</Stat>
        <Stat label="비용">{formatMoney(task.cost.amount, task.cost.currency)}</Stat>
        <Stat label="소요">{formatElapsed(task.elapsedMs)}</Stat>
      </dl>

      <div className="grid grid-cols-1 items-start gap-x-4 gap-y-0 min-[1100px]:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0">
          <Card
            title="실행 트레이스"
            description="Agent Loop 단계 순서 — 단계를 누르면 입력 · 출력 · Tool 실행을 봅니다."
            flush
          >
            <Timeline steps={data.steps} onOpen={setOpenStep} />
          </Card>
          {data.approvals.length > 0 && <ApprovalsCard approvals={data.approvals} />}
        </div>
        <div className="min-w-0">
          <PlanCard plans={data.plans} steps={data.steps} />
          {verify && (
            <Card title="결과 검증">
              <div className="flex flex-wrap items-center gap-2">
                <StepStatusBadge status={verify.status} />
                <span className="text-sm text-muted-foreground">{STEP_NAME[verify.name]}</span>
              </div>
              {verify.summary && (
                <p className="mt-2 text-sm whitespace-pre-wrap text-muted-foreground">
                  {verify.summary}
                </p>
              )}
            </Card>
          )}
          <Card title="실행 정보">
            <KeyValue
              items={[
                [
                  'Agent',
                  <span key="a" className="inline-flex flex-wrap items-center gap-1.5">
                    {task.agentName} <Badge>v{task.agentVersion}</Badge>
                  </span>,
                ],
                [
                  'Tool Registry',
                  <span
                    key="r"
                    className="inline-flex flex-wrap items-center gap-1.5"
                    title="작업을 시작할 때 고정된 Registry 버전"
                  >
                    <Badge tone="purple">v{task.registryVersion}</Badge>
                    <span className="text-xs text-muted-foreground">시작 시 고정</span>
                  </span>,
                ],
                ['사용자', task.endUserPseudonym],
                ['Worker', task.workerId ? <Mono>{task.workerId}</Mono> : null],
                [
                  'Trace ID',
                  task.traceId ? (
                    <span key="t" className="flex min-w-0 items-center gap-2">
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
          <Card title="토큰 사용량" description="모델 역할별 입력 / 출력" flush>
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
    <div className="flex min-w-0 flex-col gap-1 bg-card px-3.5 py-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-base font-semibold tabular-nums">{children}</dd>
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
        <p>
          <strong>{failureLabel(task.failure.code)}</strong> <Mono>{task.failure.code}</Mono>
          {task.failure.message && <> — {task.failure.message}</>}
        </p>
        <p className="mt-1">
          {task.failure.resumable
            ? '마지막 checkpoint 부터 재개할 수 있어요.'
            : '저장된 checkpoint 가 없어 처음부터 다시 실행해야 해요.'}
        </p>
      </Notice>
    );
  }
  if (task.status === 'waiting_approval' && task.pendingApproval) {
    return (
      <Notice tone="warn">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span>
            승인을 기다리는 중이에요 · {formatRemaining(task.pendingApproval.expiresAt)}. 응답이
            없으면 작업이 일시정지됩니다.
          </span>
          <Button asChild size="sm" variant="outline">
            <Link to="/approvals">
              승인 큐에서 보기
              <ArrowRightIcon aria-hidden="true" />
            </Link>
          </Button>
        </div>
      </Notice>
    );
  }
  if (task.status === 'paused') {
    return (
      <Notice tone="info">
        일시정지된 작업이에요.{' '}
        {hasCheckpoint
          ? 'checkpoint 부터 이어서 실행하거나 처음부터 다시 실행할 수 있어요.'
          : '처음부터 다시 실행할 수 있어요.'}
      </Notice>
    );
  }
  if (task.status === 'recovering') {
    return (
      <Notice tone="info">
        Worker 연결이 끊겨 마지막 checkpoint 부터 복구하는 중이에요 (복구 {task.recoveryCount}회).
      </Notice>
    );
  }
  return null;
}

/* ── 타임라인 ── */

function Timeline({ steps, onOpen }: { steps: TraceStep[]; onOpen: (id: string) => void }) {
  if (steps.length === 0) return <Empty title="아직 실행된 단계가 없어요" />;
  return (
    <ol className="py-2">
      {steps.map((s) => {
        const { icon: Icon, iconClass } = stepStatus(s.status);
        const dimmed = s.status === 'skipped' || s.status === 'cancelled';
        return (
          <li
            key={s.id}
            className="relative pr-4 pl-10 before:absolute before:inset-y-0 before:left-[23px] before:w-0.5 before:bg-border first:before:top-[18px] last:before:bottom-[calc(100%-18px)]"
          >
            <Icon
              aria-hidden="true"
              className={cn(
                'absolute top-[11px] left-4 z-10 size-4 rounded-full bg-card',
                iconClass,
              )}
            />
            <button
              type="button"
              className="my-0.5 flex w-full flex-col gap-1 rounded-lg px-2.5 py-2 text-left outline-none hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring/50"
              onClick={() => onOpen(s.id)}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-[26px] font-mono text-xs text-muted-foreground">
                  #{s.seq}
                </span>
                <StepTypeChip type={s.type} />
                <span
                  className={cn(
                    'min-w-0 truncate font-semibold',
                    dimmed && 'text-muted-foreground',
                  )}
                >
                  {STEP_NAME[s.name] ?? <span className="font-mono text-[12.5px]">{s.name}</span>}
                </span>
                {s.name === 'planner.revise' && <Badge tone="purple">재계획</Badge>}
                <span className="ml-auto shrink-0">
                  <StepStatusBadge status={s.status} />
                </span>
              </span>
              <span className="flex flex-wrap gap-x-3 gap-y-1 pl-[34px] text-xs text-muted-foreground">
                {STEP_NAME[s.name] && s.type !== 'tool' && (
                  <span className="font-mono">{s.name}</span>
                )}
                {s.planIndex !== null && <span>계획 {s.planIndex}단계</span>}
                {s.parallelGroup !== null && <span>병렬 그룹 {s.parallelGroup}</span>}
                {s.durationMs !== null && <span>{formatDuration(s.durationMs)}</span>}
                {s.checkpoint && (
                  <span
                    className="inline-flex items-center gap-1 font-semibold text-violet-700 dark:text-violet-300"
                    title={`checkpoint 저장 · ${s.checkpoint.at}`}
                  >
                    <FlagIcon className="size-3" aria-hidden="true" />
                    {s.checkpoint.label}
                  </span>
                )}
              </span>
              {s.summary && (
                <span className="line-clamp-2 pl-[34px] text-sm text-muted-foreground">
                  {s.summary}
                </span>
              )}
            </button>
          </li>
        );
      })}
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
        <p className="text-sm text-muted-foreground">계획을 아직 만들지 않았어요.</p>
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
        <p className={cn('mb-2.5 rounded-lg px-2.5 py-2 text-sm', TONE_CLASS.purple)}>
          <strong className="mr-1.5">재계획 사유</strong>
          {plan.reason}
        </p>
      )}
      <ol className="mb-2 divide-y">
        {plan.steps.map((st) => {
          const status = isLatest ? statusOf.get(st.index) : undefined;
          return (
            <li key={st.index} className="flex items-start gap-2.5 py-2">
              <span
                className={cn(
                  'grid size-[22px] shrink-0 place-items-center gap-0 rounded-full text-xs font-bold',
                  TONE_CLASS[status ? stepStatus(status).tone : 'neutral'],
                )}
              >
                {st.index}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="font-medium">{st.title}</span>
                <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  {st.kind === 'tool' && st.toolName && <Mono>{st.toolName}</Mono>}
                  {st.kind === 'skill' && st.skill && (
                    <Mono>
                      {st.skill.name}@{st.skill.version}
                    </Mono>
                  )}
                  {(st.kind === 'reason' || st.kind === 'respond') && STEP_TYPE[st.kind]!.label}
                  {st.requiresApproval && <Badge tone="warning">승인 필요</Badge>}
                </span>
              </div>
              {status && <StepStatusBadge status={status} />}
            </li>
          );
        })}
      </ol>
      <p className="text-xs text-muted-foreground">
        v{plan.version} · <Time iso={plan.createdAt} />
      </p>
    </Card>
  );
}

/* ── 승인 · 산출물 · 피드백 · 토큰 ── */

function ApprovalsCard({ approvals }: { approvals: ApprovalView[] }) {
  return (
    <Card title="승인 요청" flush>
      <ul className="divide-y">
        {approvals.map((a) => {
          const st = APPROVAL_STATUS[a.status];
          const risk = RISK[a.riskLevel];
          return (
            <li key={a.id} className="flex flex-col items-start gap-2 px-4 py-3">
              <div className="flex w-full flex-wrap items-center gap-2">
                <Mono>{a.toolName}</Mono>
                <Badge tone={st.tone}>{st.label}</Badge>
                {risk && <Badge tone={RISK_TONE[a.riskLevel]}>위험도 {risk.label}</Badge>}
                <Badge>{LEVEL[a.permissionLevel] ?? a.permissionLevel}</Badge>
                <span className="ml-auto text-xs text-muted-foreground">
                  {APPROVER[a.requiredApprover]} 승인
                  {a.status === 'pending' && ` · ${formatRemaining(a.expiresAt)}`}
                </span>
              </div>
              <p className="font-medium">{a.summary}</p>
              {a.args.length > 0 && (
                <dl className="w-full divide-y rounded-lg border text-sm">
                  {a.args.map((arg) => (
                    <div
                      key={arg.label}
                      className="grid grid-cols-[120px_minmax(0,1fr)] gap-2 px-2.5 py-1.5"
                    >
                      <dt className="font-mono text-xs text-muted-foreground">{arg.label}</dt>
                      <dd className="break-words">{arg.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {a.status === 'pending' && (
                <Button asChild size="sm" variant="outline">
                  <Link to="/approvals">
                    승인 큐에서 결정
                    <ArrowRightIcon aria-hidden="true" />
                  </Link>
                </Button>
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
      <ul className="divide-y">
        {artifacts.map((a) => (
          <li key={a.id} className="flex items-center gap-3 px-4 py-3">
            <FileIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium">{a.fileName}</span>
              <span className="text-xs text-muted-foreground">
                {a.origin === 'user_upload' ? '사용자 첨부' : '산출물'} · {formatBytes(a.sizeBytes)}{' '}
                · {a.mimeType}
              </span>
            </div>
            <Button variant="outline" size="sm" onClick={() => void download.run(a)}>
              <DownloadIcon aria-hidden="true" />
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
        <p className="text-sm text-muted-foreground">피드백이 없어요.</p>
      ) : (
        <ul className="flex flex-col gap-3 text-sm">
          {feedback.map((f, i) => (
            <li key={i}>
              <div className="flex items-center gap-2">
                {f.rating === 'helpful' ? (
                  <Badge tone="success">
                    <ThumbsUpIcon aria-hidden="true" />
                    도움됨
                  </Badge>
                ) : (
                  <Badge tone="danger">
                    <ThumbsDownIcon aria-hidden="true" />
                    아쉬움
                  </Badge>
                )}
                <span className="text-xs text-muted-foreground">
                  <Time iso={f.createdAt} />
                </span>
              </div>
              {f.comment && <p className="mt-1 text-muted-foreground">“{f.comment}”</p>}
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
    <Table className="[&_td]:px-4 [&_th]:px-4">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="h-9 text-xs text-muted-foreground">역할</TableHead>
          <TableHead className="h-9 text-right text-xs text-muted-foreground">입력</TableHead>
          <TableHead className="h-9 text-right text-xs text-muted-foreground">출력</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(([role, u]) => (
          <TableRow key={role}>
            <TableCell>{role}</TableCell>
            <TableCell className="text-right tabular-nums">{formatNumber(u.inputTokens)}</TableCell>
            <TableCell className="text-right tabular-nums">
              {formatNumber(u.outputTokens)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
      <TableFooter>
        <TableRow className="font-semibold">
          <TableCell>합계</TableCell>
          <TableCell className="text-right tabular-nums">
            {formatNumber(usage.inputTokens)}
          </TableCell>
          <TableCell className="text-right tabular-nums">
            {formatNumber(usage.outputTokens)}
          </TableCell>
        </TableRow>
      </TableFooter>
    </Table>
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
        <div>
          <KeyValue
            items={[
              [
                '종류 · 상태',
                <span key="s" className="flex flex-wrap items-center gap-2">
                  <StepTypeChip type={d.type} />
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
                <span key="t" className="inline-flex flex-wrap items-center gap-1.5">
                  <Time iso={d.startedAt} absolute />
                  <ArrowRightIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
                  <Time iso={d.finishedAt} absolute />
                  {d.durationMs !== null && (
                    <span className="text-muted-foreground">({formatDuration(d.durationMs)})</span>
                  )}
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
            <section className="mt-3">
              <h3 className="mb-1.5 text-sm font-medium text-muted-foreground">요약</h3>
              <p className="rounded-lg bg-muted px-2.5 py-2 text-sm whitespace-pre-wrap">
                {d.summary}
              </p>
            </section>
          )}
          <div className="mt-4">
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
          </div>
          {tab === 'tools' &&
            (d.toolExecutions.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                이 단계에서는 Tool 을 실행하지 않았어요.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {d.toolExecutions.map((e) => (
                  <ToolExecutionItem key={e.id} exec={e} />
                ))}
              </div>
            ))}
          {tab === 'input' && <JsonOrEmpty value={d.input} />}
          {tab === 'output' && <JsonOrEmpty value={d.output} />}
          {tab === 'evaluation' && <JsonOrEmpty value={d.evaluation} />}
          {tab === 'checkpoint' && d.checkpoint && <JsonOrEmpty value={d.checkpoint.data} />}
          <p className="mt-3 text-xs text-muted-foreground">
            민감정보는 서버에서 마스킹된 값입니다.
          </p>
        </div>
      )}
    </Modal>
  );
}

function JsonOrEmpty({ value }: { value: unknown }) {
  if (value === null || value === undefined)
    return <p className="text-sm text-muted-foreground">기록된 값이 없어요.</p>;
  return <Json value={value} />;
}

function ToolExecutionItem({ exec }: { exec: ToolExecution }) {
  const st = TOOL_STATUS[exec.status] ?? { label: exec.status, tone: 'neutral' as const };
  return (
    <Collapsible defaultOpen={exec.status !== 'succeeded'} className="rounded-lg border">
      <CollapsibleTrigger className="group flex w-full flex-wrap items-center gap-2 rounded-lg px-3 py-2.5 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
        <ChevronRightIcon
          className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-90"
          aria-hidden="true"
        />
        <Mono>{exec.toolName}</Mono>
        <Badge tone={st.tone}>{st.label}</Badge>
        <span className="text-xs text-muted-foreground">
          {TOOL_SOURCE[exec.source] ?? exec.source} · {exec.attempt}번째 시도
          {exec.durationMs !== null && ` · ${formatDuration(exec.durationMs)}`}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-3 pb-3">
        {exec.deniedReason && (
          <Notice tone="warn">
            거부 사유: {DENIED_REASON[exec.deniedReason] ?? exec.deniedReason}
          </Notice>
        )}
        {exec.errorCode && (
          <Notice tone="error">
            <Mono>{exec.errorCode}</Mono> {exec.errorMessage}
          </Notice>
        )}
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <div className="min-w-0">
            <p className="mb-1 text-xs font-medium text-muted-foreground">인자</p>
            <JsonOrEmpty value={exec.input} />
          </div>
          <div className="min-w-0">
            <p className="mb-1 text-xs font-medium text-muted-foreground">결과</p>
            <JsonOrEmpty value={exec.output} />
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
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
  kind: ControlKind | null;
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
  const checkpointId = useId();
  const restartId = useId();
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

  const control = CONTROL[kind ?? 'resume'];
  const option = (selected: boolean) =>
    cn(
      'flex items-start gap-3 rounded-lg border p-3 transition-colors',
      selected && 'border-primary bg-primary/5',
    );
  return (
    <Modal
      open={kind !== null}
      onClose={onClose}
      title={control.title}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            닫기
          </Button>
          <Button
            variant={kind === 'cancel' ? 'destructive' : 'default'}
            loading={action.pending}
            disabled={kind === 'resume' && mode === 'checkpoint' && !fromStepId}
            onClick={() => void submit()}
          >
            {control.label}
          </Button>
        </>
      }
    >
      <p className="mb-2 font-semibold">{task.title}</p>
      {kind === 'pause' && (
        <p className="mb-4 text-sm text-muted-foreground">
          실행 중인 단계는 마치고 멈춥니다. 승인 대기 · 대기 중인 작업은 바로 멈춥니다. 나중에
          checkpoint 부터 재개할 수 있어요.
        </p>
      )}
      {kind === 'cancel' && (
        <p className="mb-4 text-sm text-muted-foreground">
          중지한 작업은 다시 이어서 실행할 수 없어요. 대기 중인 승인 요청도 함께 취소됩니다.
        </p>
      )}
      {(kind === 'pause' || kind === 'cancel') && (
        <Field label="사유" hint="감사 로그에 남습니다 (선택)">
          <Textarea
            rows={3}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
      )}
      {kind === 'resume' && (
        <RadioGroup
          value={mode}
          onValueChange={(v) => setMode(v as 'checkpoint' | 'restart')}
          aria-label="재개 방식"
          className="mb-4 gap-2"
        >
          <div
            className={cn(
              option(mode === 'checkpoint'),
              !checkpoints.length && 'cursor-not-allowed opacity-60',
            )}
          >
            <RadioGroupItem
              id={checkpointId}
              value="checkpoint"
              disabled={!checkpoints.length}
              className="mt-0.5"
            />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Label
                htmlFor={checkpointId}
                className="flex-col items-start gap-1 leading-normal font-normal"
              >
                <span className="font-semibold">checkpoint 부터 재개</span>
                <span className="text-xs text-muted-foreground">
                  {checkpoints.length
                    ? '끝난 단계는 건너뛰고 저장된 지점부터 이어서 실행해요.'
                    : '저장된 checkpoint 가 없어요.'}
                </span>
              </Label>
              {mode === 'checkpoint' && checkpoints.length > 0 && (
                <NativeSelect
                  aria-label="재개할 checkpoint"
                  value={fromStepId}
                  onChange={(e) => setFromStepId(e.target.value)}
                >
                  {[...checkpoints].reverse().map((c, i) => (
                    <NativeSelectOption key={c.id} value={c.id}>
                      {c.checkpoint!.label} · #{c.seq} {STEP_NAME[c.name] ?? c.name}
                      {i === 0 ? ' (최근)' : ''}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              )}
            </div>
          </div>
          <div className={option(mode === 'restart')}>
            <RadioGroupItem id={restartId} value="restart" className="mt-0.5" />
            <Label
              htmlFor={restartId}
              className="flex-1 flex-col items-start gap-1 leading-normal font-normal"
            >
              <span className="font-semibold">처음부터 다시</span>
              <span className="text-xs text-muted-foreground">
                계획부터 새로 실행해요. 토큰 · 비용이 다시 듭니다.
              </span>
            </Label>
          </div>
        </RadioGroup>
      )}
      <ErrorNotice error={controlError(action.error)} />
    </Modal>
  );
}
