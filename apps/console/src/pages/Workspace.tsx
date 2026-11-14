/**
 * 워크스페이스 — 현재 워크스페이스 정보 · 이름 변경(Admin), 내 워크스페이스 목록 · 이동, 새 워크스페이스(Owner),
 * 삭제(Owner, 기본 워크스페이스 제외).
 * API: /v1/admin/workspace · /v1/admin/workspaces (src/workspaces/admin/*)
 */
import { ArrowRightIcon, CheckIcon, LockIcon, type LucideIcon, PlusIcon } from 'lucide-react';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { Link, useOutletContext } from 'react-router';
import { type LoginResponse, type MemberRole, ROLE_LABEL } from '../api';
import { useApi, useAuth } from '../auth';
import { useWorkspaceSwitch } from '../Layout';
import {
  Badge,
  ErrorNotice,
  Field,
  Loading,
  Modal,
  Mono,
  PageHeader,
  Panel,
  SectionLabel,
  Time,
  useAction,
  useQuery,
  useToast,
} from '../ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/* ───────────── API 타입 (src/workspaces/admin/workspaces-admin.service.ts) ───────────── */

interface WorkspaceView {
  id: string;
  slug: string;
  name: string;
  plan: string;
  isDefault: boolean;
  createdAt: string;
}

export interface WorkspaceItem {
  slug: string;
  name: string;
  role: MemberRole;
  isDefault: boolean;
  current: boolean;
  /** 이 로그인에서 비밀번호를 확인해 바로 옮겨 갈 수 있는가 (아니면 그 워크스페이스의 비밀번호를 받는다) */
  switchable: boolean;
}

/** Layout 이 Outlet 으로 내려 주는 워크스페이스 목록 (사이드바 메뉴와 같은 데이터) */
export interface WorkspaceOutlet {
  workspaces: WorkspaceItem[] | undefined;
  reloadWorkspaces: () => Promise<void>;
}

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** 이 로그인에서 그 워크스페이스로 어떻게 옮겨 가는가 */
type Access = 'current' | 'direct' | 'password';

const ACCESS: Record<Access, { label: string; action: string | null; icon: LucideIcon }> = {
  current: { label: '지금 보는 곳', action: null, icon: CheckIcon },
  direct: { label: '같은 계정으로 바로 이동', action: '이동', icon: ArrowRightIcon },
  password: { label: '이 워크스페이스의 비밀번호 필요', action: '비밀번호로 이동', icon: LockIcon },
};

const accessOf = (w: WorkspaceItem): Access =>
  w.current ? 'current' : w.switchable ? 'direct' : 'password';

/* ───────────── 페이지 ───────────── */

export function WorkspacePage() {
  const api = useApi();
  const { can } = useAuth();
  const { workspaces, reloadWorkspaces } = useOutletContext<WorkspaceOutlet>();
  const workspace = useQuery(() => api.get<WorkspaceView>('/v1/admin/workspace'), []);
  const ws = workspace.data;

  return (
    <>
      <PageHeader
        title="워크스페이스"
        description="워크스페이스마다 Agent · 위젯 · 대화 · 멤버가 따로 있어요. 다른 워크스페이스로는 아래 목록이나 사이드바 위 메뉴에서 옮길 수 있어요."
      />
      <ErrorNotice error={workspace.error} onRetry={() => void workspace.reload()} />
      {!ws ? (
        workspace.loading && <Loading />
      ) : (
        <>
          <HeroPanel
            workspace={ws}
            onRenamed={(next) => {
              workspace.setData(next);
              void reloadWorkspaces();
            }}
          />
          <WorkspaceCards workspaces={workspaces} />
          {can('owner') && (
            <DangerZone
              workspace={ws}
              fallbackSlug={workspaces?.find((w) => !w.current && w.switchable)?.slug}
            />
          )}
        </>
      )}
    </>
  );
}

function WorkspaceAvatar({
  name,
  current,
  large,
}: {
  name: string;
  current: boolean;
  large?: boolean;
}) {
  return (
    <span
      className={cn(
        'inline-grid shrink-0 place-items-center font-bold',
        large ? 'size-12 rounded-[13px] text-xl' : 'size-9 rounded-[10px] text-[15px]',
        current ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
      )}
      aria-hidden="true"
    >
      {[...name.trim()][0]?.toUpperCase() ?? '?'}
    </span>
  );
}

/* ───────────── 현재 워크스페이스 · 이름 변경 ───────────── */

function HeroPanel({
  workspace,
  onRenamed,
}: {
  workspace: WorkspaceView;
  onRenamed: (next: WorkspaceView) => void;
}) {
  const api = useApi();
  const { can, user } = useAuth();
  const toast = useToast();
  const nameId = useId();
  const [name, setName] = useState(workspace.name);
  useEffect(() => setName(workspace.name), [workspace.name]);
  const rename = useAction((next: string) =>
    api.patch<WorkspaceView>('/v1/admin/workspace', { name: next }),
  );
  const trimmed = name.trim();

  const submit = async () => {
    const updated = await rename.run(trimmed);
    if (updated) {
      toast('이름을 바꿨어요');
      onRenamed(updated);
    }
  };

  return (
    <Panel className="px-4 py-4 sm:px-[22px] sm:py-5">
      <div className="flex min-w-0 items-center gap-3">
        <WorkspaceAvatar name={workspace.name} current large />
        <div className="grid min-w-0 leading-tight">
          <span className="flex min-w-0 items-center gap-2">
            <b className="truncate text-[19px] font-semibold">{workspace.name}</b>
            {workspace.isDefault && <Badge tone="info">기본</Badge>}
          </span>
          <span className="truncate font-mono text-[12.5px] text-muted-foreground">
            {workspace.slug}
          </span>
        </div>
      </div>
      <div className="mt-4 grid items-end gap-x-7 gap-y-[18px] border-t pt-4 @[60rem]:grid-cols-[minmax(260px,420px)_minmax(0,1fr)]">
        {can('admin') ? (
          <form
            className="min-w-0"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <Label htmlFor={nameId} className="text-muted-foreground">
              이름
            </Label>
            <div className="mt-1.5 flex min-w-0 gap-2">
              <Input
                id={nameId}
                className="min-w-0 flex-1"
                value={name}
                maxLength={100}
                onChange={(e) => setName(e.target.value)}
              />
              <Button
                type="submit"
                loading={rename.pending}
                disabled={!trimmed || trimmed === workspace.name}
              >
                저장
              </Button>
            </div>
            <ErrorNotice error={rename.error} />
          </form>
        ) : (
          <p className="text-xs text-muted-foreground">이름은 Admin 이상만 바꿀 수 있어요.</p>
        )}
        <dl className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-x-[18px] gap-y-3.5">
          <Fact label="주소" note="만든 뒤에는 바꿀 수 없어요">
            <Mono>{workspace.slug}</Mono>
          </Fact>
          <Fact
            label="요금제"
            note={
              <Link to="/billing" className="text-primary hover:underline">
                사용량 보기
              </Link>
            }
          >
            {workspace.plan}
          </Fact>
          <Fact label="만든 날">
            <Time iso={workspace.createdAt} absolute />
          </Fact>
          <Fact label="내 역할">{user ? ROLE_LABEL[user.role] : '-'}</Fact>
        </dl>
      </div>
    </Panel>
  );
}

function Fact({ label, note, children }: { label: string; note?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-[14.5px] font-medium">{children}</dd>
      {note && <dd className="text-xs text-muted-foreground">{note}</dd>}
    </div>
  );
}

/* ───────────── 내 워크스페이스 ───────────── */

function WorkspaceCards({ workspaces }: { workspaces: WorkspaceItem[] | undefined }) {
  const { can } = useAuth();
  const move = useWorkspaceSwitch();
  const [creating, setCreating] = useState(false);
  return (
    <>
      <SectionLabel title="내 워크스페이스" count={workspaces?.length} />
      {!workspaces ? (
        <Loading />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(270px,100%),1fr))] gap-3">
          {workspaces.map((w) => {
            const access = ACCESS[accessOf(w)];
            return (
              <Panel
                key={w.slug}
                className={cn(
                  'flex flex-col items-start gap-3 p-4',
                  w.current && 'border-primary/40 ring-3 ring-primary/10',
                )}
              >
                <div className="flex w-full min-w-0 items-center gap-2.5">
                  <WorkspaceAvatar name={w.name} current={w.current} />
                  <div className="grid min-w-0 flex-1 leading-tight">
                    <b className="truncate text-[15px] font-semibold">{w.name}</b>
                    <span className="truncate font-mono text-[12.5px] text-muted-foreground">
                      {w.slug}
                    </span>
                  </div>
                  {w.isDefault && <Badge>기본</Badge>}
                </div>
                <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
                  <span className="rounded-md bg-muted px-[7px] py-px font-mono text-xs">
                    {ROLE_LABEL[w.role]}
                  </span>
                  {access.action && <span>{access.label}</span>}
                </div>
                {access.action ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-auto"
                    aria-label={`${w.name} — ${access.action}`}
                    onClick={() => move.go(w)}
                  >
                    <access.icon aria-hidden="true" />
                    {access.action}
                  </Button>
                ) : (
                  <span className="mt-auto inline-flex items-center gap-1 rounded-md bg-emerald-50 px-[7px] py-px text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                    <access.icon className="size-[13px]" aria-hidden="true" />
                    {access.label}
                  </span>
                )}
              </Panel>
            );
          })}
          {!can('owner') ? (
            <div className="grid min-h-[150px] place-items-center rounded-[14px] border-[1.5px] border-dashed p-4 text-center text-sm text-muted-foreground">
              워크스페이스를 만들거나 지우는 건 Owner 만 할 수 있어요.
            </div>
          ) : creating ? (
            <Panel className="col-span-full p-4">
              <CreateForm onCancel={() => setCreating(false)} />
            </Panel>
          ) : (
            <button
              type="button"
              className="flex min-h-[150px] flex-col items-center justify-center gap-1 rounded-[14px] border-[1.5px] border-dashed p-4 text-center text-muted-foreground transition-colors hover:border-primary hover:bg-accent hover:text-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              onClick={() => setCreating(true)}
            >
              <PlusIcon className="size-[22px]" aria-hidden="true" />
              <b className="font-semibold">새 워크스페이스</b>
              <span className="text-[12.5px] text-muted-foreground">
                Agent 와 위젯을 따로 쓰는 공간
              </span>
            </button>
          )}
        </div>
      )}
      {move.dialog}
    </>
  );
}

/* ───────────── 새 워크스페이스 ───────────── */

function CreateForm({ onCancel }: { onCancel: () => void }) {
  const api = useApi();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const create = useAction((body: { slug: string; name: string }) =>
    api.post<LoginResponse>('/v1/admin/workspaces', body),
  );
  const slugInvalid = slug !== '' && !SLUG_PATTERN.test(slug);

  const submit = async () => {
    const created = await create.run({ slug, name: name.trim() });
    if (!created) return;
    api.adopt(created);
    // 사이드바 · 화면이 들고 있는 이전 워크스페이스 데이터를 모두 버리고 새로 연다
    window.location.reload();
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h3 className="mb-1 font-semibold">새 워크스페이스</h3>
      <p className="mb-4 text-sm text-muted-foreground">
        기본 Agent 와 위젯이 들어 있는 빈 워크스페이스를 만들고, 내 계정(같은 이메일 · 비밀번호)을
        Owner 로 넣어요.
      </p>
      <div className="grid gap-x-3 sm:grid-cols-2">
        <Field label="이름" required>
          <Input
            value={name}
            maxLength={100}
            placeholder="예: 쇼핑몰 고객지원"
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field
          label="주소"
          required
          hint="영문 소문자 · 숫자 · 하이픈, 만든 뒤에는 바꿀 수 없어요."
          error={
            slugInvalid
              ? '영문 소문자 · 숫자 · 하이픈(-)만, 하이픈으로 시작하거나 끝날 수 없어요'
              : undefined
          }
        >
          <Input
            value={slug}
            maxLength={40}
            placeholder="예: shop"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
          />
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          loading={create.pending}
          disabled={!name.trim() || !slug || slugInvalid}
        >
          만들고 이동
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          취소
        </Button>
      </div>
      <ErrorNotice error={create.error} />
    </form>
  );
}

/* ───────────── 삭제 ───────────── */

function DangerZone({
  workspace,
  fallbackSlug,
}: {
  workspace: WorkspaceView;
  fallbackSlug: string | undefined;
}) {
  const api = useApi();
  const { switchWorkspace, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const remove = useAction(async () => {
    await api.delete('/v1/admin/workspace', { confirmSlug: workspace.slug });
    return true;
  });

  const submit = async () => {
    if (!(await remove.run())) return;
    // 지운 워크스페이스의 토큰으로도 이 로그인에서 확인한 다른 워크스페이스로 옮겨 갈 수 있다. 없으면 다시 로그인.
    if (!fallbackSlug) return logout();
    await switchWorkspace(fallbackSlug).catch(logout);
  };

  return (
    <>
      <SectionLabel title="위험 구역" />
      <Panel className="grid items-center gap-4 border-destructive/30 px-4 py-4 sm:px-5 md:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <b className="text-[14.5px] font-semibold">워크스페이스 삭제</b>
          <p className="mt-1 text-[13.5px] text-muted-foreground">
            {workspace.isDefault
              ? '기본 워크스페이스는 삭제할 수 없어요.'
              : 'Agent · 위젯 · 대화 · 작업 · 멤버 등 이 워크스페이스의 모든 데이터가 지워지고 되돌릴 수 없어요.'}
          </p>
        </div>
        {!workspace.isDefault && (
          <Button
            variant="destructive"
            className="justify-self-start"
            onClick={() => {
              setConfirm('');
              remove.reset();
              setOpen(true);
            }}
          >
            워크스페이스 삭제
          </Button>
        )}
      </Panel>
      <Modal
        open={open}
        title={`${workspace.name} 삭제`}
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>
              취소
            </Button>
            <Button
              variant="destructive"
              loading={remove.pending}
              disabled={confirm.trim() !== workspace.slug}
              onClick={() => void submit()}
            >
              삭제
            </Button>
          </>
        }
      >
        <p className="mb-4 text-sm">
          이 워크스페이스의 모든 데이터가 지워지고 되돌릴 수 없어요. 삭제한 뒤에는 다른
          워크스페이스로 이동해요.
        </p>
        <Field
          label={
            <>
              확인을 위해 주소 <Mono>{workspace.slug}</Mono> 를 입력해 주세요
            </>
          }
        >
          <Input
            value={confirm}
            autoCapitalize="none"
            spellCheck={false}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
        <ErrorNotice error={remove.error} />
      </Modal>
    </>
  );
}
