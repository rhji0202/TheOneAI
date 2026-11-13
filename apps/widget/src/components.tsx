import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { formatBytes, formatRemaining } from '../../shared/format';
import { Markdown } from '../../shared/markdown';
import { LEVEL, RISK, statusOf } from '../../shared/status';
import type {
  ApprovalView,
  ArtifactView,
  ContentBlock,
  MessageView,
  PlanStep,
  TaskResult,
  WidgetApi,
} from './api';
import { Alert, Check, Clip, Close, Download, File, Send, Shield } from './icons';
import type { RunState, ToolChip } from './run';

export function StatusBadge({ status }: { status: string }) {
  const s = statusOf(status);
  return (
    <span className="badge" style={{ background: s.bg, color: s.fg }}>
      {s.label}
    </span>
  );
}

export function Bubble({ message, api }: { message: MessageView; api: WidgetApi }) {
  const text = message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
  const attachments = message.content.filter(
    (b): b is Extract<ContentBlock, { type: 'attachment' }> => b.type === 'attachment',
  );
  if (message.role === 'user') {
    return (
      <div className="msg msg-user">
        {text && <p>{text}</p>}
        {attachments.map((a) => (
          <span key={a.artifactId} className="attach-chip">
            <File /> 첨부 파일
          </span>
        ))}
      </div>
    );
  }
  void api;
  return (
    <div className="msg msg-agent">
      <span className="avatar" aria-hidden="true">
        <SparkMini />
      </span>
      <Markdown className="md" text={text} />
    </div>
  );
}

function SparkMini() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.8 2.8M14.9 14.9l2.8 2.8M6.3 17.7l2.8-2.8M14.9 9.1l2.8-2.8" />
    </svg>
  );
}

export function StreamingBubble({ text }: { text: string }) {
  return (
    <div className="msg msg-agent">
      <span className="avatar" aria-hidden="true">
        <SparkMini />
      </span>
      <div aria-live="polite" className="md">
        <Markdown text={text} />
        <span className="cursor" aria-hidden="true" />
      </div>
    </div>
  );
}

const STEP_ICON: Record<string, { cls: string; label: string }> = {
  succeeded: { cls: 'step-done', label: '완료' },
  running: { cls: 'step-running', label: '진행 중' },
  failed: { cls: 'step-failed', label: '실패' },
  waiting_approval: { cls: 'step-wait', label: '승인 대기' },
  skipped: { cls: 'step-skipped', label: '건너뜀' },
  cancelled: { cls: 'step-skipped', label: '취소' },
  pending: { cls: 'step-pending', label: '대기' },
};

function StepMark({ status }: { status: string }) {
  const icon = STEP_ICON[status] ?? STEP_ICON.pending!;
  return (
    <span className={`step-mark ${icon.cls}`} role="img" aria-label={icon.label}>
      {status === 'succeeded' && <Check />}
      {status === 'running' && <span className="dot" />}
      {(status === 'failed' || status === 'waiting_approval') && <Alert size={12} />}
    </span>
  );
}

function stepDetail(step: PlanStep, tools: ToolChip[]): string | null {
  if (step.skill) return `skill: ${step.skill.name} v${step.skill.version}`;
  if (step.toolName) {
    const used = tools.filter((t) => t.toolName === step.toolName);
    const last = used.at(-1);
    if (!last) return step.toolName;
    const retry = last.attempt && last.attempt > 1 ? ` · 재시도 ${last.attempt - 1}회` : '';
    return `${step.toolName}${retry}`;
  }
  if (step.kind === 'respond') return null;
  return null;
}

/** 답변 단계만 있는 계획(인사 · 간단한 질문) — 실행 계획을 보여 주지 않는다 */
export function isSimplePlan(plan: RunState['plan']): boolean {
  return Boolean(plan?.steps.every((s) => s.kind === 'respond'));
}

export function PlanCard({ run }: { run: RunState }) {
  const [showRevision, setShowRevision] = useState(false);
  if (!run.plan || isSimplePlan(run.plan)) return null;
  const steps = run.plan.steps;
  const revised = run.plan.version > 1;
  return (
    <section className="card plan" aria-label="실행 계획">
      <header className="card-head">
        <h3>실행 계획 · {steps.length}단계</h3>
        {revised && (
          <button
            type="button"
            className="badge badge-warn badge-button"
            onClick={() => setShowRevision((v) => !v)}
            aria-expanded={showRevision}
          >
            계획 수정됨 v{run.plan.version}
          </button>
        )}
      </header>
      {revised && showRevision && (
        <p className="revision-note">
          {(run.revisions.at(-1)?.reason || run.plan.revisedReason) ??
            '결과를 보고 계획을 고쳤어요'}
        </p>
      )}
      <ol className="steps">
        {steps.map((step) => {
          const detail = stepDetail(step, run.tools);
          const current = step.status === 'running' || step.status === 'waiting_approval';
          return (
            <li key={step.index} className={current ? 'step current' : 'step'}>
              <StepMark status={step.status} />
              <span className="step-body">
                <span className={step.status === 'pending' ? 'step-title muted' : 'step-title'}>
                  {step.title}
                  {step.requiresApproval && step.status === 'pending' && (
                    <span className="tag tag-warn">승인 필요</span>
                  )}
                </span>
                {detail && (
                  <code className="step-detail">
                    {detail}
                    {step.status === 'running' ? ' · 진행 중' : ''}
                  </code>
                )}
              </span>
            </li>
          );
        })}
      </ol>
      {run.tools.length > 0 && (
        <details className="tool-log">
          <summary>실행 기록 보기 (Tool {run.tools.length}회)</summary>
          <ul>
            {run.tools.map((t) => (
              <li key={t.executionId}>
                <span className={`tool-status tool-${t.status}`}>{TOOL_STATUS[t.status]}</span>
                <code>{t.toolName}</code>
                {t.preview && <span className="tool-preview">{t.preview}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

const TOOL_STATUS: Record<ToolChip['status'], string> = {
  running: '실행 중',
  succeeded: '성공',
  failed: '실패',
  timeout: '시간 초과',
  denied: '거부됨',
};

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
  const ref = useRef<HTMLElement>(null);
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
    <section
      ref={ref}
      tabIndex={-1}
      role="alertdialog"
      aria-labelledby={titleId}
      className="card approval"
    >
      <header className="card-head">
        <h3 id={titleId}>
          <Shield /> 승인이 필요한 작업
        </h3>
        <span className="badge" style={{ background: risk.bg, color: risk.fg }}>
          위험도 {risk.label}
        </span>
      </header>
      <p className="approval-summary">{approval.summary}</p>
      <p className="approval-tool">
        <code>
          {approval.toolSource === 'mcp' ? 'MCP · ' : ''}
          {approval.toolName}
        </code>
        <span className="muted">
          {' '}
          · {LEVEL[approval.permissionLevel] ?? approval.permissionLevel}
        </span>
      </p>
      {approval.args.length > 0 && (
        <dl className="args">
          {approval.args.map((a) => (
            <div key={a.label}>
              <dt>{a.label}</dt>
              <dd>{a.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <details className="raw">
        <summary>실행 인자 원문 보기 (JSON)</summary>
        <pre>{JSON.stringify(approval.rawArgs, null, 2)}</pre>
      </details>
      {waitingOperator ? (
        <p className="notice">
          {approval.requiredApprover === 'operator'
            ? '이 작업은 운영자가 확인해요. 승인되면 이어서 진행돼요.'
            : '확인해 주셨어요. 운영자 확인을 기다리고 있어요.'}
        </p>
      ) : (
        <>
          {approval.allowTaskScope && (
            <label className="check">
              <input
                type="checkbox"
                checked={scopeTask}
                onChange={(e) => setScopeTask(e.target.checked)}
              />
              이 작업 동안 같은 작업은 다시 묻지 않기
            </label>
          )}
          <label className="sr-only" htmlFor={`${titleId}-comment`}>
            수정 요청 입력
          </label>
          <textarea
            id={`${titleId}-comment`}
            className="comment"
            rows={2}
            placeholder="바꿔야 할 점이 있으면 적어 주세요 (거절과 함께 전달돼요)"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="actions">
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void decide('reject')}
            >
              {comment.trim() ? '수정 요청' : '거절'}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void decide('approve')}
            >
              승인하고 계속
            </button>
          </div>
        </>
      )}
      <p className="expires">
        {formatRemaining(approval.expiresAt)} · 응답이 없으면 작업이 일시정지돼요
      </p>
    </section>
  );
}

export function ResultCard({ result, api }: { result: TaskResult; api: WidgetApi }) {
  if (result.artifacts.length === 0) return null;
  return (
    <section className="card result" aria-label="결과">
      <Artifacts api={api} artifacts={result.artifacts} />
    </section>
  );
}

function Artifacts({ api, artifacts }: { api: WidgetApi; artifacts: ArtifactView[] }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="artifacts">
      <p className="section-label">산출물 {artifacts.length}</p>
      <ul>
        {artifacts.map((a) => (
          <li key={a.id}>
            <span className="file-kind">{(a.fileName.split('.').pop() ?? '').toUpperCase()}</span>
            <span className="file-meta">
              <span className="file-name">{a.fileName}</span>
              <span className="muted">{formatBytes(a.sizeBytes)}</span>
            </span>
            <button
              type="button"
              className="icon-btn"
              aria-label={`${a.fileName} 내려받기`}
              onClick={() => api.download(a).catch((e: Error) => setError(e.message))}
            >
              <Download />
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

export function FailureCard({
  failure,
  status,
  reason,
  onResume,
}: {
  failure: RunState['failure'];
  status: string;
  reason: string | null;
  onResume: (mode: 'checkpoint' | 'restart') => void;
}) {
  if (status === 'paused') {
    return (
      <section className="card failure">
        <p className="failure-title">
          {reason === 'approval_expired'
            ? '승인 시간이 지나 일시정지됐어요'
            : '작업이 일시정지됐어요'}
        </p>
        <p className="muted">지금까지의 결과는 저장돼 있어요. 이어서 진행할 수 있어요.</p>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={() => onResume('checkpoint')}>
            이어서 진행
          </button>
        </div>
      </section>
    );
  }
  if (!failure) return null;
  return (
    <section className="card failure" role="alert">
      <p className="failure-title">작업을 끝내지 못했어요</p>
      <p>{failure.message}</p>
      <div className="actions">
        {failure.resumable && (
          <button type="button" className="btn btn-primary" onClick={() => onResume('checkpoint')}>
            멈춘 단계부터 재개
          </button>
        )}
        <button type="button" className="btn" onClick={() => onResume('restart')}>
          처음부터
        </button>
      </div>
    </section>
  );
}

export interface Attachment {
  id: string;
  name: string;
  size: number;
  status: 'uploading' | 'ready' | 'error';
  error?: string;
}

/** 입력창 — Enter 전송, Shift+Enter 줄바꿈. 첨부는 올리기를 마친 것만 보낸다 */
export function Composer({
  api,
  value,
  onChange,
  onSubmit,
  disabled,
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
  disabled?: boolean;
  placeholder: string;
  allowAttachments: boolean;
  accept: string[];
  maxMb: number;
  stopButton?: { onStop: () => void; busy?: boolean };
}) {
  const inputId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [value]);

  const pick = async (list: FileList | null) => {
    for (const file of Array.from(list ?? [])) {
      const temp = `tmp-${Math.random().toString(36).slice(2)}`;
      if (file.size > maxMb * 1024 * 1024) {
        setFiles((f) => [
          ...f,
          {
            id: temp,
            name: file.name,
            size: file.size,
            status: 'error',
            error: `${maxMb}MB 를 넘어요`,
          },
        ]);
        continue;
      }
      setFiles((f) => [...f, { id: temp, name: file.name, size: file.size, status: 'uploading' }]);
      try {
        const uploaded = await api.upload(file);
        setFiles((f) =>
          f.map((x) => (x.id === temp ? { ...x, id: uploaded.id, status: 'ready' } : x)),
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

  const ready = files.filter((f) => f.status === 'ready');
  const uploading = files.some((f) => f.status === 'uploading');
  const canSend =
    !disabled && !sending && !uploading && (value.trim().length > 0 || ready.length > 0);
  const submit = async () => {
    if (!canSend) return;
    setSending(true);
    try {
      await onSubmit(
        value.trim(),
        ready.map((f) => f.id),
      );
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
    <div className="composer">
      {files.length > 0 && (
        <ul className="pending-files">
          {files.map((f) => (
            <li key={f.id} className={f.status === 'error' ? 'file-error' : ''}>
              <File />
              <span className="file-name">{f.name}</span>
              <span className="muted">
                {f.status === 'uploading'
                  ? '올리는 중…'
                  : f.status === 'error'
                    ? f.error
                    : formatBytes(f.size)}
              </span>
              <button
                type="button"
                className="icon-btn sm"
                aria-label={`${f.name} 빼기`}
                onClick={() => setFiles((list) => list.filter((x) => x.id !== f.id))}
              >
                <Close size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <label htmlFor={inputId} className="sr-only">
        {stopButton ? '추가 지시 입력' : '메시지 입력'}
      </label>
      <div className="composer-box">
        {allowAttachments && !stopButton && (
          <>
            <button
              type="button"
              className="icon-btn"
              aria-label="파일 첨부"
              onClick={() => fileRef.current?.click()}
            >
              <Clip />
            </button>
            <input
              ref={fileRef}
              type="file"
              hidden
              multiple
              accept={accept.join(',')}
              onChange={(e) => void pick(e.target.files)}
            />
          </>
        )}
        <textarea
          ref={textRef}
          id={inputId}
          rows={1}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKey}
        />
        {stopButton ? (
          value.trim() ? (
            <button
              type="button"
              className="send-btn"
              aria-label="추가 지시 보내기"
              disabled={!canSend}
              onClick={() => void submit()}
            >
              <Send />
            </button>
          ) : (
            <button
              type="button"
              className="btn stop-btn"
              disabled={stopButton.busy}
              onClick={stopButton.onStop}
            >
              <span className="stop-square" aria-hidden="true" />
              중지
            </button>
          )
        ) : (
          <button
            type="button"
            className="send-btn"
            aria-label="보내기"
            disabled={!canSend}
            onClick={() => void submit()}
          >
            <Send />
          </button>
        )}
      </div>
    </div>
  );
}
