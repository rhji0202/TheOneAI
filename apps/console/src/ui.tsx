/**
 * 콘솔 공용 UI — 데이터 훅(useQuery · useAction · usePaged) 과 shadcn/ui 위에 만든 화면 조각.
 * 단순한 버튼 · 입력 · 표 조각은 페이지가 '@/components/ui/*' 를 바로 쓴다.
 */
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CopyIcon,
  InfoIcon,
  Loader2Icon,
  MinusIcon,
  SearchIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import {
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Badge as UiBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  Card as UiCard,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs as UiTabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Toaster } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';
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

/* ───────────── 색 · 토스트 ───────────── */

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'purple';

/** 상태 색 — 배지 · 강조 칩이 같은 색을 쓰도록 한 곳에 둔다 */
export const TONE_CLASS: Record<Tone, string> = {
  neutral: 'bg-muted text-muted-foreground',
  info: 'bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  success: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  warning: 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  danger: 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300',
  purple: 'bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300',
};

function notify(message: string, tone: Tone = 'success') {
  if (tone === 'success') toast.success(message);
  else if (tone === 'danger') toast.error(message);
  else if (tone === 'warning') toast.warning(message);
  else if (tone === 'info') toast.info(message);
  else toast(message);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <Toaster position="bottom-right" />
    </>
  );
}

export function useToast() {
  return notify;
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
    <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        {back && (
          <Link
            to={back.to}
            className="mb-1.5 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeftIcon className="size-4" aria-hidden="true" />
            {back.label}
          </Link>
        )}
        <h1 className="text-2xl font-semibold tracking-tight break-words">{title}</h1>
        {meta && (
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {meta}
          </div>
        )}
        {description && <p className="mt-1 text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
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
    <UiCard className={cn('mb-4 min-w-0 gap-0 py-0', className)}>
      {(title || actions) && (
        <CardHeader className="border-b px-4 py-3.5 [.border-b]:pb-3.5">
          {title && <h2 className="leading-snug font-semibold">{title}</h2>}
          {description && <CardDescription>{description}</CardDescription>}
          {actions && <CardAction className="flex items-center gap-2">{actions}</CardAction>}
        </CardHeader>
      )}
      <CardContent className={flush ? 'p-0' : 'p-4'}>{children}</CardContent>
    </UiCard>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <UiBadge className={TONE_CLASS[tone]}>{children}</UiBadge>;
}

export function StatusBadge({ status }: { status: string }) {
  const s = statusOf(status);
  return (
    <UiBadge style={{ background: s.bg, color: s.fg }} className="font-semibold">
      {s.label}
    </UiBadge>
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
    <UiTabs value={value} onValueChange={(v) => onChange(v as T)} className="mb-4">
      <TabsList
        variant="line"
        aria-label={label}
        className="w-full justify-start overflow-x-auto border-b"
      >
        {tabs.map((t) => (
          <TabsTrigger key={t.id} value={t.id} className="flex-none px-3">
            {t.label}
            {t.count !== undefined && (
              <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground tabular-nums">
                {t.count}
              </span>
            )}
          </TabsTrigger>
        ))}
      </TabsList>
    </UiTabs>
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
    <div>
      <Table aria-label={label}>
        <TableHeader className="bg-muted/50">
          <TableRow>
            {columns.map((c) => (
              <TableHead
                key={c.key}
                style={{ width: c.width, textAlign: c.align }}
                className="px-3.5 text-xs text-muted-foreground"
              >
                {c.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              key={rowKey(row)}
              className={onRowClick ? 'cursor-pointer' : undefined}
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
                <TableCell key={c.key} style={{ textAlign: c.align }} className="px-3.5 py-2.5">
                  {c.render(row)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {rows.length === 0 &&
        (loading ? (
          <Loading />
        ) : (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            {empty ?? '항목이 없어요'}
          </div>
        ))}
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
    <div className="flex justify-center p-3">
      <Button variant="outline" size="sm" loading={loading} onClick={onClick}>
        더 보기
      </Button>
    </div>
  );
}

export function Empty({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="px-4 py-10 text-center text-muted-foreground">
      <p className="font-semibold text-foreground">{title}</p>
      {children && <div className="mt-1.5 text-sm">{children}</div>}
    </div>
  );
}

export function ErrorNotice({ error, onRetry }: { error: Error | null; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <Alert variant="destructive" className="mb-3 flex items-center gap-3 border-destructive/30">
      <CircleAlertIcon className="size-4 shrink-0" aria-hidden="true" />
      <span className="flex-1">{error.message}</span>
      {onRetry && (
        <Button size="sm" variant="ghost" onClick={onRetry}>
          다시 시도
        </Button>
      )}
    </Alert>
  );
}

const NOTICE: Record<
  'info' | 'warn' | 'error' | 'success',
  { icon: typeof InfoIcon; className: string }
> = {
  info: {
    icon: InfoIcon,
    className:
      'border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200',
  },
  warn: {
    icon: TriangleAlertIcon,
    className:
      'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200',
  },
  error: {
    icon: CircleAlertIcon,
    className:
      'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200',
  },
  success: {
    icon: CircleCheckIcon,
    className:
      'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  },
};

export function Notice({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn' | 'error' | 'success';
  children: ReactNode;
}) {
  const { icon: Icon, className: toneClass } = NOTICE[tone];
  return (
    <Alert
      role={undefined}
      className={cn('mb-3 flex items-start gap-2.5 [&>svg]:translate-y-0.5', toneClass)}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">{children}</div>
    </Alert>
  );
}

export function Loading({ label = '불러오는 중…' }: { label?: string }) {
  return (
    <div
      className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground"
      role="status"
    >
      <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
      {label}
    </div>
  );
}

const LABELABLE = new Set<unknown>(['input', 'select', 'textarea', Input, Textarea, NativeSelect]);

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
    <span id={noteId} className="text-xs text-destructive">
      {error}
    </span>
  ) : hint ? (
    <span id={noteId} className="text-xs text-muted-foreground">
      {hint}
    </span>
  ) : null;
  const labelText = (
    <>
      {label}
      {required && <span className="text-destructive"> *</span>}
    </>
  );
  if (isValidElement(children) && LABELABLE.has(children.type)) {
    const control = children as ReactElement<Record<string, unknown>>;
    const controlId = (control.props.id as string | undefined) ?? `${id}-control`;
    const describedBy = [control.props['aria-describedby'], note ? noteId : null]
      .filter(Boolean)
      .join(' ');
    return (
      <div className="mb-4 flex flex-col gap-1.5">
        <Label htmlFor={controlId} className="text-muted-foreground">
          {labelText}
        </Label>
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
    <div className="mb-4 flex flex-col gap-1.5">
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-muted-foreground">{labelText}</span>
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
  const id = useId();
  return (
    <div className={cn('inline-flex min-h-8 items-center gap-2.5', disabled && 'opacity-55')}>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
      <Label htmlFor={id} className="font-normal">
        {label}
      </Label>
    </div>
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
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        className={cn(
          'flex max-h-[calc(100vh-2rem)] flex-col gap-0 p-0',
          wide ? 'sm:max-w-[880px]' : 'sm:max-w-[520px]',
        )}
      >
        <DialogHeader className="px-5 pt-4 pb-3">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="overflow-y-auto px-5 pt-1 pb-4">{children}</div>
        {footer && <DialogFooter className="border-t px-5 py-3">{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
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
          <Button variant="outline" onClick={onClose}>
            취소
          </Button>
          <Button
            variant={danger ? 'destructive' : 'default'}
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
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      )}
      <ErrorNotice error={error ?? null} />
    </Modal>
  );
}

export function KeyValue({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="m-0 grid gap-0">
      {items.map(([k, v], i) => (
        <div
          key={i}
          className="grid grid-cols-[140px_minmax(0,1fr)] gap-3 border-b py-2 last:border-b-0"
        >
          <dt className="text-sm text-muted-foreground">{k}</dt>
          <dd className="m-0 min-w-0 break-words">{v ?? '—'}</dd>
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
  const DeltaIcon =
    delta?.direction === 'up'
      ? ArrowUpIcon
      : delta?.direction === 'down'
        ? ArrowDownIcon
        : MinusIcon;
  return (
    <UiCard className="min-w-0 gap-1 px-4 py-3.5">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        {delta && (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 font-semibold',
              good === null
                ? 'text-muted-foreground'
                : good
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-red-600 dark:text-red-400',
            )}
          >
            <DeltaIcon className="size-3" aria-hidden="true" /> {delta.text}
          </span>
        )}
        {target && <span>{target}</span>}
        {hint && <span>{hint}</span>}
      </div>
    </UiCard>
  );
}

export function Mono({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <code className="rounded bg-muted px-1.5 py-px font-mono text-[12.5px] break-all" title={title}>
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
    <div className="relative overflow-hidden rounded-lg border bg-muted/60">
      {label && <div className="border-b px-3 py-1.5 text-xs text-muted-foreground">{label}</div>}
      <pre className="m-0 max-h-[420px] overflow-auto p-3 font-mono text-[12.5px] break-words whitespace-pre-wrap">
        <code>{code}</code>
      </pre>
      <CopyButton text={code} className="absolute top-1.5 right-1.5" />
    </div>
  );
}

export function Json({ value }: { value: unknown }) {
  return <CodeBlock code={JSON.stringify(value, null, 2) ?? 'null'} />;
}

export function CopyButton({
  text,
  label = '복사',
  className,
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="outline"
      size="xs"
      className={cn('bg-background', className)}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
      {done ? '복사됨' : label}
    </Button>
  );
}

export function Time({ iso, absolute }: { iso: string | null | undefined; absolute?: boolean }) {
  if (!iso) return <span className="text-muted-foreground">—</span>;
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
    <div className="relative w-full max-w-xs">
      <SearchIcon
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        type="search"
        className="pl-8"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="mb-3 flex flex-wrap items-center gap-2">{children}</div>;
}

/** 위젯 사용자는 가명으로만 표시 (화면 설계 공통 규칙) */
export function pseudonym(endUserId: string | null | undefined): string {
  if (!endUserId) return '—';
  return `user_${endUserId.replace(/-/g, '').slice(-4)}`;
}
