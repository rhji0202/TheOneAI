/**
 * 콘솔 공용 UI — 데이터 훅(useQuery · useAction · usePaged) 과 기본 컴포넌트.
 * 페이지는 이 파일의 컴포넌트 + console.css 토큰만 써서 같은 모양을 유지한다.
 */
import {
  cloneElement,
  createContext,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { Link } from 'react-router';
import { formatDateTime, formatRelative } from '../../shared/format';
import { statusOf } from '../../shared/status';
import type { MemberRole } from './api';
import { useAuth } from './auth';

/* ───────────── 데이터 훅 ───────────── */

export interface Query<T> {
  data: T | undefined;
  error: Error | null;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (update: T | ((prev: T | undefined) => T)) => void;
}

/**
 * 조회 훅 — deps 가 바뀌면 다시 부른다. pollMs 를 주면 탭이 보일 때만 주기적으로 갱신.
 * 이전 데이터를 유지한 채 다시 불러오므로 화면이 깜빡이지 않는다.
 */
export function useQuery<T>(
  fn: () => Promise<T>,
  deps: readonly unknown[],
  opts: { pollMs?: number; enabled?: boolean } = {},
): Query<T> {
  const [data, setDataState] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(opts.enabled !== false);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const result = await fnRef.current();
      if (mine === seq.current) {
        setDataState(result);
        setError(null);
      }
    } catch (err) {
      if (mine === seq.current) setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (opts.enabled === false) {
      setLoading(false);
      return;
    }
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, opts.enabled]);

  useEffect(() => {
    if (!opts.pollMs || opts.enabled === false) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void reload();
    }, opts.pollMs);
    return () => clearInterval(timer);
  }, [opts.pollMs, opts.enabled, reload]);

  const setData = useCallback((update: T | ((prev: T | undefined) => T)) => {
    setDataState((prev) =>
      typeof update === 'function' ? (update as (p: T | undefined) => T)(prev) : update,
    );
  }, []);

  return { data, error, loading, reload, setData };
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** 커서 페이지 목록 — 첫 페이지 + "더 보기" */
export function usePaged<T>(
  fetchPage: (cursor: string | undefined) => Promise<Page<T>>,
  deps: readonly unknown[],
  opts: { pollMs?: number } = {},
) {
  const [extra, setExtra] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [moreLoading, setMoreLoading] = useState(false);
  const first = useQuery(() => fetchPage(undefined), deps, opts);
  useEffect(() => {
    setExtra([]);
    setCursor(first.data?.nextCursor ?? null);
    // 첫 페이지를 다시 받으면 더 본 항목은 버린다
  }, [first.data]);
  const loadMore = async () => {
    if (!cursor) return;
    setMoreLoading(true);
    try {
      const next = await fetchPage(cursor);
      setExtra((prev) => [...prev, ...next.items]);
      setCursor(next.nextCursor);
    } finally {
      setMoreLoading(false);
    }
  };
  return {
    items: [...(first.data?.items ?? []), ...extra],
    loading: first.loading,
    error: first.error,
    reload: first.reload,
    hasMore: Boolean(cursor),
    loadMore,
    moreLoading,
  };
}

/** 변경 요청 훅 — 실패하면 error 에 담고 undefined 를 돌려준다 */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const run = useCallback(async (...args: A): Promise<R | undefined> => {
    setPending(true);
    setError(null);
    try {
      return await fnRef.current(...args);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      return undefined;
    } finally {
      setPending(false);
    }
  }, []);
  return { run, pending, error, reset: () => setError(null) };
}

/* ───────────── 토스트 ───────────── */

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'purple';
interface ToastItem {
  id: number;
  message: string;
  tone: Tone;
}
const ToastContext = createContext<(message: string, tone?: Tone) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((message: string, tone: Tone = 'success') => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev.slice(-3), { id, message, tone }]);
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

/* ───────────── 레이아웃 조각 ───────────── */

export function PageHeader({
  title,
  description,
  actions,
  back,
  meta,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  back?: { to: string; label: string };
  meta?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div className="page-head-main">
        {back && (
          <Link to={back.to} className="back-link">
            ← {back.label}
          </Link>
        )}
        <h1 className="page-title">{title}</h1>
        {meta && <div className="page-meta">{meta}</div>}
        {description && <p className="page-desc">{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function Card({
  title,
  description,
  actions,
  children,
  className,
  flush,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  /** 본문 여백 없이 (표 · 목록) */
  flush?: boolean;
}) {
  return (
    <section className={`card${className ? ` ${className}` : ''}`}>
      {(title || actions) && (
        <div className="card-head">
          <div>
            {title && <h2 className="card-title">{title}</h2>}
            {description && <p className="card-desc">{description}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </div>
      )}
      <div className={flush ? 'card-body flush' : 'card-body'}>{children}</div>
    </section>
  );
}

export function Button({
  variant = 'secondary',
  size,
  loading,
  children,
  className,
  type = 'button',
  ...rest
}: {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm';
  loading?: boolean;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={`btn btn-${variant}${size ? ` btn-${size}` : ''}${className ? ` ${className}` : ''}`}
      disabled={rest.disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <span className="spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  const s = statusOf(status);
  return (
    <span className="badge" style={{ background: s.bg, color: s.fg }}>
      {s.label}
    </span>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: { id: T; label: ReactNode; count?: number }[];
  value: T;
  onChange: (id: T) => void;
  label?: string;
}) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={value === t.id}
          className={value === t.id ? 'tab active' : 'tab'}
          onClick={() => onChange(t.id)}
        >
          {t.label}
          {t.count !== undefined && <span className="tab-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  width?: string;
  align?: 'left' | 'right' | 'center';
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  empty,
  loading,
  label,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  empty?: ReactNode;
  loading?: boolean;
  label?: string;
}) {
  return (
    <div className="table-wrap">
      <table className="table" aria-label={label}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} style={{ width: c.width, textAlign: c.align }}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              className={onRowClick ? 'clickable' : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={
                onRowClick
                  ? (e) => {
                      if (e.key === 'Enter') onRowClick(row);
                    }
                  : undefined
              }
              tabIndex={onRowClick ? 0 : undefined}
            >
              {columns.map((c) => (
                <td key={c.key} style={{ textAlign: c.align }}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 &&
        (loading ? <Loading /> : <div className="table-empty">{empty ?? '항목이 없어요'}</div>)}
    </div>
  );
}

export function MoreButton({
  hasMore,
  loading,
  onClick,
}: {
  hasMore: boolean;
  loading?: boolean;
  onClick: () => void;
}) {
  if (!hasMore) return null;
  return (
    <div className="more">
      <Button size="sm" loading={loading} onClick={onClick}>
        더 보기
      </Button>
    </div>
  );
}

export function Empty({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

export function ErrorNotice({ error, onRetry }: { error: Error | null; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div className="notice notice-error" role="alert">
      <span>{error.message}</span>
      {onRetry && (
        <Button size="sm" variant="ghost" onClick={onRetry}>
          다시 시도
        </Button>
      )}
    </div>
  );
}

export function Notice({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn' | 'error' | 'success';
  children: ReactNode;
}) {
  return <div className={`notice notice-${tone}`}>{children}</div>;
}

export function Loading({ label = '불러오는 중…' }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </div>
  );
}

const LABELABLE = new Set(['input', 'select', 'textarea']);

/**
 * 폼 칸 — 입력 요소 하나면 label[for] 로 잇고 도움말은 aria-describedby 로 (접근성 이름에 도움말이 섞이지 않게).
 * 여러 요소 · 컴포넌트면 label 로 감싼다.
 */
export function Field({
  label,
  hint,
  error,
  children,
  required,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  required?: boolean;
}) {
  const id = useId();
  const noteId = `${id}-note`;
  const note = error ? (
    <span id={noteId} className="field-error">
      {error}
    </span>
  ) : hint ? (
    <span id={noteId} className="field-hint">
      {hint}
    </span>
  ) : null;
  const labelText = (
    <>
      {label}
      {required && <span className="req"> *</span>}
    </>
  );
  if (
    isValidElement(children) &&
    typeof children.type === 'string' &&
    LABELABLE.has(children.type)
  ) {
    const control = children as ReactElement<Record<string, unknown>>;
    const controlId = (control.props.id as string | undefined) ?? `${id}-control`;
    const describedBy = [control.props['aria-describedby'], note ? noteId : null]
      .filter(Boolean)
      .join(' ');
    return (
      <div className="field">
        <label className="field-label" htmlFor={controlId}>
          {labelText}
        </label>
        {cloneElement(control, {
          id: controlId,
          'aria-describedby': describedBy || undefined,
          ...(error ? { 'aria-invalid': true } : {}),
        })}
        {note}
      </div>
    );
  }
  return (
    <div className="field">
      <label className="field-wrap">
        <span className="field-label">{labelText}</span>
        {children}
      </label>
      {note}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={`toggle${disabled ? ' disabled' : ''}`}>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="toggle-track" aria-hidden="true" />
      <span>{label}</span>
    </label>
  );
}

export function Modal({
  title,
  open,
  onClose,
  children,
  footer,
  wide,
}: {
  title: ReactNode;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>(
      'input, textarea, select, button:not(.modal-close)',
    );
    (first ?? ref.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className={wide ? 'modal wide' : 'modal'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="modal-close" aria-label="닫기" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/** 위험한 작업 확인 — 사유 입력이 필요하면 requireReason */
export function ConfirmModal({
  open,
  title,
  body,
  confirmLabel,
  danger,
  requireReason,
  reasonLabel = '사유',
  pending,
  error,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: ReactNode;
  body?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  requireReason?: boolean;
  reasonLabel?: string;
  pending?: boolean;
  error?: Error | null;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) setReason('');
  }, [open]);
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>취소</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            loading={pending}
            disabled={requireReason && !reason.trim()}
            onClick={() => onConfirm(reason.trim())}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {body}
      {requireReason && (
        <Field label={reasonLabel} required>
          <textarea
            className="input"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
      )}
      <ErrorNotice error={error ?? null} />
    </Modal>
  );
}

export function KeyValue({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv">
      {items.map(([k, v], i) => (
        <div key={i}>
          <dt>{k}</dt>
          <dd>{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Kpi({
  label,
  value,
  delta,
  goodWhenUp = true,
  hint,
  target,
}: {
  label: ReactNode;
  value: ReactNode;
  /** 직전 기간 대비 변화 (비율 · 차이) — 화면에는 텍스트로 */
  delta?: { text: string; direction: 'up' | 'down' | 'flat' } | null;
  goodWhenUp?: boolean;
  hint?: ReactNode;
  target?: ReactNode;
}) {
  const good =
    delta && delta.direction !== 'flat' ? (delta.direction === 'up') === goodWhenUp : null;
  return (
    <div className="kpi">
      <p className="kpi-label">{label}</p>
      <p className="kpi-value">{value}</p>
      <div className="kpi-foot">
        {delta && (
          <span className={`kpi-delta ${good === null ? 'flat' : good ? 'good' : 'bad'}`}>
            {delta.direction === 'up' ? '▲' : delta.direction === 'down' ? '▼' : '–'} {delta.text}
          </span>
        )}
        {target && <span className="kpi-target">{target}</span>}
        {hint && <span className="kpi-hint">{hint}</span>}
      </div>
    </div>
  );
}

export function Mono({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <code className="mono" title={title}>
      {children}
    </code>
  );
}

/** 긴 ID 는 앞 8자만 — 전체는 title */
export function ShortId({ id }: { id: string }) {
  return <Mono title={id}>{id.slice(0, 8)}</Mono>;
}

export function CodeBlock({ code, label }: { code: string; label?: string }) {
  return (
    <div className="code-block">
      {label && <div className="code-label">{label}</div>}
      <pre>
        <code>{code}</code>
      </pre>
      <CopyButton text={code} />
    </div>
  );
}

export function Json({ value }: { value: unknown }) {
  return <CodeBlock code={JSON.stringify(value, null, 2) ?? 'null'} />;
}

export function CopyButton({ text, label = '복사' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="copy-btn"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? '복사됨' : label}
    </button>
  );
}

export function Time({ iso, absolute }: { iso: string | null | undefined; absolute?: boolean }) {
  if (!iso) return <span className="muted">—</span>;
  return (
    <time dateTime={iso} title={formatDateTime(iso)}>
      {absolute ? formatDateTime(iso) : formatRelative(iso)}
    </time>
  );
}

/** 역할이 모자라면 숨김(또는 fallback) */
export function RoleGate({
  min,
  children,
  fallback = null,
}: {
  min: MemberRole;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { can } = useAuth();
  return can(min) ? children : fallback;
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  label: string;
}) {
  return (
    <input
      type="search"
      className="input search"
      aria-label={label}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="toolbar">{children}</div>;
}

/** 위젯 사용자는 가명으로만 표시 (화면 설계 공통 규칙) */
export function pseudonym(endUserId: string | null | undefined): string {
  if (!endUserId) return '—';
  return `user_${endUserId.replace(/-/g, '').slice(-4)}`;
}
