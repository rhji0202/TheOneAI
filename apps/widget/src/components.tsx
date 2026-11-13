import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import {
  ArrowUpIcon,
  BanIcon,
  BracesIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleIcon,
  CircleMinusIcon,
  CirclePauseIcon,
  CircleXIcon,
  ClockIcon,
  DownloadIcon,
  FileIcon,
  FileJsonIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  ImageIcon,
  type LucideIcon,
  PaperclipIcon,
  RouteIcon,
  ShieldAlertIcon,
  SquareIcon,
  WrenchIcon,
  XIcon,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from '@/components/ui/attachment';
import { Badge } from '@/components/ui/badge';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@/components/ui/input-group';
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item';
import { Label } from '@/components/ui/label';
import { Message, MessageContent } from '@/components/ui/message';
import { Textarea } from '@/components/ui/textarea';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@/components/ui/trace';
import { cn } from '@/lib/utils';
import { formatBytes, formatRemaining } from '../../shared/format';
import { Markdown } from '../../shared/markdown';
import { LEVEL, RISK, statusOf } from '../../shared/status';
import type {
  ApprovalView,
  ArtifactView,
  ContentBlock,
  MessageView,
  PlanStep,
  WidgetApi,
} from './api';
import type { RunState, ToolChip } from './run';

type TraceStatus = 'running' | 'error' | 'pending';

export function StatusBadge({ status }: { status: string }) {
  const s = statusOf(status);
  return (
    <Badge style={{ background: s.bg, color: s.fg }} className="font-semibold">
      {s.label}
    </Badge>
  );
}

/** 타이포그래피 플러그인 없이 답변 Markdown 을 꾸민다 */
const MARKDOWN = cn(
  'min-w-0 text-sm leading-relaxed wrap-break-word',
  '[&_p]:mb-2 [&_p:last-child]:mb-0',
  '[&_:is(h3,h4,h5,h6)]:mt-2.5 [&_:is(h3,h4,h5,h6)]:mb-1.5 [&_:is(h3,h4,h5,h6)]:font-bold',
  '[&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5',
  '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-px [&_code]:font-mono [&_code]:text-xs',
  '[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:bg-muted [&_pre]:p-2.5 [&_pre]:text-xs [&_pre_code]:bg-transparent [&_pre_code]:p-0',
  '[&_blockquote]:my-1.5 [&_blockquote]:border-l-2 [&_blockquote]:pl-2.5 [&_blockquote]:text-muted-foreground',
  '[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4 [&_hr]:my-3',
  '[&_.md-table]:my-1.5 [&_.md-table]:overflow-x-auto [&_table]:min-w-full [&_table]:border-collapse [&_table]:text-[13px]',
  '[&_:is(th,td)]:border [&_:is(th,td)]:px-2 [&_:is(th,td)]:py-1 [&_:is(th,td)]:text-left [&_:is(th,td)]:align-top [&_th]:bg-muted [&_th]:font-semibold',
);

/** 첨부 형식 — 이미지는 미리보기, 나머지는 형식별 아이콘으로 구분한다 */
const PREVIEW_IMAGE = /^image\/(png|jpeg|webp|gif)$/;

function fileIcon(mimeType: string | undefined, name: string): LucideIcon {
  if (mimeType?.startsWith('image/')) return ImageIcon;
  if (mimeType === 'text/csv' || /\.(csv|tsv|xlsx?)$/i.test(name)) return FileSpreadsheetIcon;
  if (mimeType === 'application/json' || /\.json$/i.test(name)) return FileJsonIcon;
  if (mimeType?.startsWith('text/') || mimeType === 'application/pdf') return FileTextIcon;
  return FileIcon;
}

/** 첨부 이미지를 받아 object URL 로 — 화면에서 빠지면 해제한다 */
function useArtifactImage(api: WidgetApi, artifactId: string, enabled: boolean) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let objectUrl: string | null = null;
    let alive = true;
    api
      .blob(artifactId)
      .then((blob) => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [api, artifactId, enabled]);
  return { url, failed };
}

function MessageAttachment({
  block,
  api,
}: {
  block: Extract<ContentBlock, { type: 'attachment' }>;
  api: WidgetApi;
}) {
  const name = block.fileName ?? '첨부 파일';
  const isImage = PREVIEW_IMAGE.test(block.mimeType ?? '');
  const { url, failed } = useArtifactImage(api, block.artifactId, isImage);
  const size = block.sizeBytes === undefined ? '' : formatBytes(block.sizeBytes);
  if (isImage && !failed) {
    return (
      <Attachment orientation="vertical" className="w-48" state={url ? 'done' : 'processing'}>
        <AttachmentMedia
          variant="image"
          className="aspect-auto min-h-16 w-full *:[img]:aspect-auto *:[img]:max-h-48 *:[img]:object-contain"
        >
          {url ? <img src={url} alt={name} /> : <ImageIcon />}
        </AttachmentMedia>
        <AttachmentContent>
          <AttachmentTitle>{name}</AttachmentTitle>
          {size && <AttachmentDescription>{size}</AttachmentDescription>}
        </AttachmentContent>
        {url && (
          <AttachmentTrigger
            aria-label={`${name} 크게 보기`}
            onClick={() => window.open(url, '_blank', 'noopener')}
          />
        )}
      </Attachment>
    );
  }
  const Icon = fileIcon(block.mimeType, name);
  return (
    <Attachment size="sm">
      <AttachmentMedia>
        <Icon />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{name}</AttachmentTitle>
        <AttachmentDescription>
          {[(name.split('.').pop() ?? '').toUpperCase(), size].filter(Boolean).join(' · ')}
        </AttachmentDescription>
      </AttachmentContent>
    </Attachment>
  );
}

export function ChatMessage({ message, api }: { message: MessageView; api: WidgetApi }) {
  const text = message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
  const attachments = message.content.filter(
    (b): b is Extract<ContentBlock, { type: 'attachment' }> => b.type === 'attachment',
  );
  if (message.role === 'user') {
    return (
      <Message align="end">
        <MessageContent>
          {attachments.length > 0 && (
            <div className="flex flex-wrap items-start justify-end gap-1.5">
              {attachments.map((a) => (
                <MessageAttachment key={a.artifactId} block={a} api={api} />
              ))}
            </div>
          )}
          {text && (
            <Bubble align="end">
              <BubbleContent className="whitespace-pre-wrap">{text}</BubbleContent>
            </Bubble>
          )}
        </MessageContent>
      </Message>
    );
  }
  return (
    <Message>
      <MessageContent className="gap-2">
        <Markdown className={MARKDOWN} text={text} />
      </MessageContent>
    </Message>
  );
}

export function StreamingMessage({ text }: { text: string }) {
  return (
    <Message>
      <MessageContent className="gap-2">
        <Markdown className={MARKDOWN} text={text} />
        <span
          aria-hidden="true"
          className="block h-4 w-1.5 animate-pulse rounded-xs bg-primary motion-reduce:animate-none"
        />
      </MessageContent>
    </Message>
  );
}

const STEP: Record<
  string,
  { icon: LucideIcon; label: string; status?: TraceStatus; tone?: string }
> = {
  succeeded: {
    icon: CircleCheckIcon,
    label: '완료',
    tone: 'text-emerald-600 dark:text-emerald-400',
  },
  running: { icon: CircleDotIcon, label: '진행 중', status: 'running' },
  waiting_approval: {
    icon: ShieldAlertIcon,
    label: '승인 대기',
    tone: 'text-amber-600 dark:text-amber-400',
  },
  failed: { icon: CircleXIcon, label: '실패', status: 'error' },
  skipped: { icon: CircleMinusIcon, label: '건너뜀', status: 'pending' },
  cancelled: { icon: CircleMinusIcon, label: '취소', status: 'pending' },
  pending: { icon: CircleIcon, label: '대기', status: 'pending' },
};

function stepDetail(step: PlanStep, tools: ToolChip[]): string | null {
  if (step.skill) return `skill: ${step.skill.name} v${step.skill.version}`;
  if (!step.toolName) return null;
  const last = tools.filter((t) => t.toolName === step.toolName).at(-1);
  const retry = last?.attempt && last.attempt > 1 ? ` · 재시도 ${last.attempt - 1}회` : '';
  return `${step.toolName}${retry}`;
}

/** 답변 단계만 있는 계획(인사 · 간단한 질문) — 실행 계획을 보여 주지 않는다 */
export function isSimplePlan(plan: RunState['plan']): boolean {
  return Boolean(plan?.steps.every((s) => s.kind === 'respond'));
}

/** Plan — 단계는 처음부터 다 알려져 있다 (plan.created / plan.revised) */
export function PlanCard({
  plan,
  revisions,
  tools,
}: {
  plan: NonNullable<RunState['plan']>;
  revisions: RunState['revisions'];
  tools: ToolChip[];
}) {
  const [showRevision, setShowRevision] = useState(false);
  const steps = plan.steps;
  const revised = plan.version > 1;
  const done = steps.filter((s) => s.status === 'succeeded').length;
  const status: TraceStatus | undefined = steps.some((s) => s.status === 'failed')
    ? 'error'
    : steps.some((s) => s.status === 'running')
      ? 'running'
      : undefined;
  return (
    <section aria-label="실행 계획">
      <Trace>
        <TraceCollapsible defaultOpen>
          <div className="flex min-w-0 items-center justify-between gap-2">
            <TraceCollapsibleTrigger>
              <TraceLine status={status}>
                <TraceIcon>
                  <RouteIcon />
                </TraceIcon>
                <TraceTitle>실행 계획 · {steps.length}단계</TraceTitle>
                <TraceDescription>
                  {done}/{steps.length} 완료
                </TraceDescription>
              </TraceLine>
            </TraceCollapsibleTrigger>
            {revised && (
              <Badge
                asChild
                className="border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
              >
                <button
                  type="button"
                  aria-expanded={showRevision}
                  onClick={() => setShowRevision((v) => !v)}
                >
                  계획 수정됨 v{plan.version}
                </button>
              </Badge>
            )}
          </div>
          {revised && showRevision && (
            <p className="mt-2 rounded-md bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
              {(revisions.at(-1)?.reason || plan.revisedReason) ?? '결과를 보고 계획을 고쳤어요'}
            </p>
          )}
          <TraceCollapsibleContent>
            <Trace>
              {steps.map((step) => {
                const s = STEP[step.status] ?? STEP.pending!;
                const detail = stepDetail(step, tools);
                return (
                  <TraceLine key={step.index} status={s.status}>
                    <TraceIcon className={s.tone}>
                      <s.icon />
                    </TraceIcon>
                    <TraceTitle
                      className={cn(
                        (step.status === 'running' || step.status === 'waiting_approval') &&
                          'font-medium text-foreground',
                      )}
                    >
                      {step.title}
                    </TraceTitle>
                    <span className="sr-only">{s.label}</span>
                    {step.requiresApproval && step.status === 'pending' && (
                      <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                        승인 필요
                      </Badge>
                    )}
                    {detail && (
                      <TraceDescription className="min-w-0 shrink truncate font-mono text-xs">
                        {detail}
                      </TraceDescription>
                    )}
                  </TraceLine>
                );
              })}
            </Trace>
          </TraceCollapsibleContent>
        </TraceCollapsible>
        {tools.length > 0 && <ToolLog tools={tools} />}
      </Trace>
    </section>
  );
}

const TOOL: Record<ToolChip['status'], { icon: LucideIcon; label?: string; status?: TraceStatus }> =
  {
    running: { icon: WrenchIcon, label: '실행 중', status: 'running' },
    succeeded: { icon: WrenchIcon },
    failed: { icon: CircleXIcon, label: '실패', status: 'error' },
    timeout: { icon: ClockIcon, label: '시간 초과', status: 'error' },
    denied: { icon: BanIcon, label: '거부됨' },
  };

/** Tool — 실행 기록. 실행 중인 Tool 이 있으면 저절로 펼친다 */
function ToolLog({ tools }: { tools: ToolChip[] }) {
  const [open, setOpen] = useState<boolean>();
  const running = tools.some((t) => t.status === 'running');
  return (
    <TraceCollapsible open={open ?? running} onOpenChange={setOpen}>
      <TraceCollapsibleTrigger>
        <TraceLine status={running ? 'running' : undefined}>
          <TraceIcon>
            <WrenchIcon />
          </TraceIcon>
          <TraceTitle>실행 기록</TraceTitle>
          <TraceDescription>Tool {tools.length}회</TraceDescription>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <Trace>
          {tools.map((t) => (
            <ToolLine key={t.executionId} tool={t} />
          ))}
        </Trace>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

function ToolLine({ tool }: { tool: ToolChip }) {
  const s = TOOL[tool.status];
  const line = (
    <TraceLine status={s.status}>
      <TraceIcon>
        <s.icon />
      </TraceIcon>
      <TraceTitle>
        {s.label && `${s.label} · `}
        <span className="font-mono text-xs">{tool.toolName}</span>
      </TraceTitle>
    </TraceLine>
  );
  if (!tool.preview || tool.status === 'running') return line;
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <p className="font-mono text-xs break-all whitespace-pre-wrap">{tool.preview}</p>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

/** Confirmation — 승인 요청 */
export function ApprovalCard({
  approval,
  api,
  onDecided,
}: {
  approval: ApprovalView;
  api: WidgetApi;
  onDecided: (approval: ApprovalView | null) => void;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [scopeTask, setScopeTask] = useState(false);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    ref.current?.focus();
  }, [approval.id]);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1_000);
    return () => clearInterval(timer);
  }, []);
  const risk = RISK[approval.riskLevel] ?? RISK.medium!;
  const waitingOperator = approval.waitingFor === 'operator';

  const decide = async (decision: 'approve' | 'reject') => {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.decide(approval.id, {
        decision,
        ...(decision === 'approve' && scopeTask ? { scope: 'task' } : {}),
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      });
      onDecided(updated.status === 'pending' ? updated : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '처리하지 못했어요');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Item
      ref={ref}
      tabIndex={-1}
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={`${titleId}-summary`}
      variant="outline"
      size="sm"
      className="items-start bg-card shadow-xs"
    >
      <ItemMedia
        variant="icon"
        className="size-8 rounded-md bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300"
      >
        <ShieldAlertIcon />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle>
          <span id={titleId}>승인이 필요한 작업</span>
          <Badge style={{ background: risk.bg, color: risk.fg }} className="font-semibold">
            위험도 {risk.label}
          </Badge>
        </ItemTitle>
        <ItemDescription id={`${titleId}-summary`} className="line-clamp-none text-foreground">
          {approval.summary}
        </ItemDescription>
      </ItemContent>
      <div className="flex min-w-0 basis-full flex-col gap-3">
        <p className="text-xs text-muted-foreground">
          <code className="font-mono text-foreground">
            {approval.toolSource === 'mcp' ? 'MCP · ' : ''}
            {approval.toolName}
          </code>
          {' · '}
          {LEVEL[approval.permissionLevel] ?? approval.permissionLevel}
        </p>
        {approval.args.length > 0 && (
          <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-lg border bg-muted/40 px-3 py-2 text-xs">
            {approval.args.map((a) => (
              <div key={a.label} className="contents">
                <dt className="text-muted-foreground">{a.label}</dt>
                <dd className="break-all">{a.value}</dd>
              </div>
            ))}
          </dl>
        )}
        <Trace>
          <TraceCollapsible>
            <TraceCollapsibleTrigger>
              <TraceLine>
                <TraceIcon>
                  <BracesIcon />
                </TraceIcon>
                <TraceTitle className="text-xs">실행 인자 원문 보기 (JSON)</TraceTitle>
              </TraceLine>
            </TraceCollapsibleTrigger>
            <TraceCollapsibleContent>
              <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] text-foreground">
                {JSON.stringify(approval.rawArgs, null, 2)}
              </pre>
            </TraceCollapsibleContent>
          </TraceCollapsible>
        </Trace>
        {waitingOperator ? (
          <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
            {approval.requiredApprover === 'operator'
              ? '이 작업은 운영자가 확인해요. 승인되면 이어서 진행돼요.'
              : '확인해 주셨어요. 운영자 확인을 기다리고 있어요.'}
          </p>
        ) : (
          <>
            {approval.allowTaskScope && (
              <Label className="font-normal">
                <Checkbox
                  checked={scopeTask}
                  onCheckedChange={(checked) => setScopeTask(checked === true)}
                />
                이 작업 동안 같은 작업은 다시 묻지 않기
              </Label>
            )}
            <Textarea
              aria-label="수정 요청 입력"
              rows={2}
              className="min-h-14"
              placeholder="바꿔야 할 점이 있으면 적어 주세요 (거절과 함께 전달돼요)"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
            {error && (
              <p className="text-xs text-destructive" role="alert">
                {error}
              </p>
            )}
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1"
                disabled={busy}
                onClick={() => void decide('reject')}
              >
                {comment.trim() ? '수정 요청' : '거절'}
              </Button>
              <Button className="flex-1" disabled={busy} onClick={() => void decide('approve')}>
                승인하고 계속
              </Button>
            </div>
          </>
        )}
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ClockIcon className="size-3.5" aria-hidden="true" />
          {formatRemaining(approval.expiresAt)} · 응답이 없으면 작업이 일시정지돼요
        </p>
      </div>
    </Item>
  );
}

/** 완료 뒤 산출물 — Attachment */
export function Artifacts({ artifacts, api }: { artifacts: ArtifactView[]; api: WidgetApi }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <section aria-label="결과" className="flex flex-col gap-2">
      <p className="text-xs font-medium text-muted-foreground">산출물 {artifacts.length}</p>
      {artifacts.map((a) => (
        <Attachment key={a.id} className="w-full">
          <AttachmentMedia>
            <FileTextIcon />
          </AttachmentMedia>
          <AttachmentContent>
            <AttachmentTitle>{a.fileName}</AttachmentTitle>
            <AttachmentDescription>
              {(a.fileName.split('.').pop() ?? '').toUpperCase()} · {formatBytes(a.sizeBytes)}
            </AttachmentDescription>
          </AttachmentContent>
          <AttachmentActions>
            <AttachmentAction
              size="icon-sm"
              aria-label={`${a.fileName} 내려받기`}
              onClick={() => api.download(a).catch((e: Error) => setError(e.message))}
            >
              <DownloadIcon />
            </AttachmentAction>
          </AttachmentActions>
        </Attachment>
      ))}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </section>
  );
}

export function PausedCard({ reason, onResume }: { reason: string | null; onResume: () => void }) {
  return (
    <Alert role="status">
      <CirclePauseIcon />
      <AlertTitle>
        {reason === 'approval_expired'
          ? '승인 시간이 지나 일시정지됐어요'
          : '작업이 일시정지됐어요'}
      </AlertTitle>
      <AlertDescription>지금까지의 결과는 저장돼 있어요. 이어서 진행할 수 있어요.</AlertDescription>
      <div className="col-start-2 mt-2.5">
        <Button size="sm" onClick={onResume}>
          이어서 진행
        </Button>
      </div>
    </Alert>
  );
}

export function FailureCard({
  failure,
  onResume,
}: {
  failure: NonNullable<RunState['failure']>;
  onResume: (mode: 'checkpoint' | 'restart') => void;
}) {
  return (
    <Alert variant="destructive">
      <CircleAlertIcon />
      <AlertTitle>작업을 끝내지 못했어요</AlertTitle>
      <AlertDescription>{failure.message}</AlertDescription>
      <div className="col-start-2 mt-2.5 flex flex-wrap gap-2">
        {failure.resumable && (
          <Button size="sm" onClick={() => onResume('checkpoint')}>
            멈춘 단계부터 재개
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          className="text-foreground"
          onClick={() => onResume('restart')}
        >
          처음부터
        </Button>
      </div>
    </Alert>
  );
}

interface PendingFile {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  /** 이미지면 고른 파일의 object URL — 올리기 전에도 미리보기를 보여 준다 */
  previewUrl?: string;
  status: 'uploading' | 'done' | 'error';
  error?: string;
}

/** Prompt Input — Enter 전송, Shift+Enter 줄바꿈. 첨부는 올리기를 마친 것만 보낸다 */
export function Composer({
  api,
  value,
  onChange,
  onSubmit,
  placeholder,
  allowAttachments,
  accept,
  maxMb,
  stopButton,
}: {
  api: WidgetApi;
  value: string;
  onChange: (v: string) => void;
  onSubmit: (text: string, attachments: string[]) => Promise<void> | void;
  placeholder: string;
  allowAttachments: boolean;
  accept: string[];
  maxMb: number;
  stopButton?: { onStop: () => void; busy?: boolean };
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [sending, setSending] = useState(false);

  const previews = useRef(new Set<string>());
  useEffect(() => {
    const urls = previews.current;
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, []);
  const release = (removed: PendingFile[]) => {
    for (const f of removed) {
      if (!f.previewUrl) continue;
      URL.revokeObjectURL(f.previewUrl);
      previews.current.delete(f.previewUrl);
    }
  };

  const pick = async (list: FileList | null) => {
    for (const file of Array.from(list ?? [])) {
      const temp = `tmp-${Math.random().toString(36).slice(2)}`;
      const base = { id: temp, name: file.name, size: file.size, mimeType: file.type };
      if (file.size > maxMb * 1024 * 1024) {
        setFiles((f) => [...f, { ...base, status: 'error', error: `${maxMb}MB 를 넘어요` }]);
        continue;
      }
      let previewUrl: string | undefined;
      if (PREVIEW_IMAGE.test(file.type)) {
        previewUrl = URL.createObjectURL(file);
        previews.current.add(previewUrl);
      }
      setFiles((f) => [...f, { ...base, previewUrl, status: 'uploading' }]);
      try {
        const uploaded = await api.upload(file);
        setFiles((f) =>
          f.map((x) => (x.id === temp ? { ...x, id: uploaded.id, status: 'done' } : x)),
        );
      } catch (err) {
        setFiles((f) =>
          f.map((x) =>
            x.id === temp
              ? {
                  ...x,
                  status: 'error',
                  error: err instanceof Error ? err.message : '올리지 못했어요',
                }
              : x,
          ),
        );
      }
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  const ready = files.filter((f) => f.status === 'done');
  const uploading = files.some((f) => f.status === 'uploading');
  const canSend = !sending && !uploading && (value.trim().length > 0 || ready.length > 0);
  const submit = async () => {
    if (!canSend) return;
    setSending(true);
    try {
      await onSubmit(
        value.trim(),
        ready.map((f) => f.id),
      );
      release(files);
      setFiles([]);
    } finally {
      setSending(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <InputGroup className="min-w-0 rounded-xl bg-background">
        {files.length > 0 && (
          <InputGroupAddon align="block-start">
            <AttachmentGroup className="w-full">
              {files.map((f) => {
                const Icon = fileIcon(f.mimeType, f.name);
                return (
                  <Attachment key={f.id} size="sm" state={f.status}>
                    {f.previewUrl && f.status !== 'error' ? (
                      <AttachmentMedia variant="image">
                        <img src={f.previewUrl} alt="" />
                      </AttachmentMedia>
                    ) : (
                      <AttachmentMedia>
                        <Icon />
                      </AttachmentMedia>
                    )}
                    <AttachmentContent>
                      <AttachmentTitle>{f.name}</AttachmentTitle>
                      <AttachmentDescription>
                        {f.status === 'uploading'
                          ? '올리는 중…'
                          : f.status === 'error'
                            ? f.error
                            : formatBytes(f.size)}
                      </AttachmentDescription>
                    </AttachmentContent>
                    <AttachmentActions>
                      <AttachmentAction
                        aria-label={`${f.name} 빼기`}
                        onClick={() => {
                          release([f]);
                          setFiles((list) => list.filter((x) => x.id !== f.id));
                        }}
                      >
                        <XIcon />
                      </AttachmentAction>
                    </AttachmentActions>
                  </Attachment>
                );
              })}
            </AttachmentGroup>
          </InputGroupAddon>
        )}
        <InputGroupTextarea
          aria-label={stopButton ? '추가 지시 입력' : '메시지 입력'}
          className="max-h-36 min-h-12 px-3 pt-3"
          rows={1}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKey}
        />
        <InputGroupAddon align="block-end">
          {allowAttachments && !stopButton && (
            <InputGroupButton
              size="icon-sm"
              variant="outline"
              className="rounded-full"
              aria-label="파일 첨부"
              onClick={() => fileRef.current?.click()}
            >
              <PaperclipIcon />
            </InputGroupButton>
          )}
          {stopButton && !value.trim() ? (
            <InputGroupButton
              size="sm"
              variant="secondary"
              className="ml-auto h-8 rounded-full px-3"
              disabled={stopButton.busy}
              onClick={stopButton.onStop}
            >
              <SquareIcon className="size-3 fill-current" />
              중지
            </InputGroupButton>
          ) : (
            <InputGroupButton
              type="submit"
              size="icon-sm"
              variant="default"
              className="ml-auto rounded-full"
              aria-label={stopButton ? '추가 지시 보내기' : '보내기'}
              disabled={!canSend}
            >
              <ArrowUpIcon />
            </InputGroupButton>
          )}
        </InputGroupAddon>
      </InputGroup>
      {allowAttachments && (
        <input
          ref={fileRef}
          type="file"
          hidden
          multiple
          accept={accept.join(',')}
          onChange={(e) => void pick(e.target.files)}
        />
      )}
    </form>
  );
}
