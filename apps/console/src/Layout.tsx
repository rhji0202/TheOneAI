import {
  BotIcon,
  CheckIcon,
  ChevronsUpDownIcon,
  CreditCardIcon,
  DatabaseIcon,
  FileCodeIcon,
  LayoutDashboardIcon,
  ListChecksIcon,
  LogOutIcon,
  type LucideIcon,
  MessageSquareIcon,
  PlugIcon,
  SettingsIcon,
  ShieldCheckIcon,
  StoreIcon,
} from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import { ROLE_LABEL } from './api';
import { useAuth } from './auth';
import type { WorkspaceItem, WorkspaceOutlet } from './pages/Workspace';
import {
  Badge,
  ErrorNotice,
  Field,
  Modal,
  type Page,
  type Query,
  ToastProvider,
  useAction,
  useQuery,
} from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  badge?: number;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

function isActive(item: NavItem, pathname: string): boolean {
  return item.end ? pathname === item.to : pathname.startsWith(item.to);
}

export function Layout() {
  const { api } = useAuth();
  const { pathname } = useLocation();
  const workspaces = useQuery(() => api.get<WorkspaceItem[]>('/v1/admin/workspaces'), []);
  // 승인 대기 수 — 사이드바 배지 (30초마다)
  const pending = useQuery(
    () => api.get<Page<unknown>>('/v1/admin/approvals', { status: 'pending', limit: 100 }),
    [],
    { pollMs: 30_000 },
  );
  const pendingCount = pending.data?.items.length ?? 0;

  const sections: NavSection[] = [
    {
      title: '운영',
      items: [
        { to: '/', label: '대시보드', icon: LayoutDashboardIcon, end: true },
        { to: '/tasks', label: '작업', icon: ListChecksIcon },
        { to: '/approvals', label: '승인 · 권한', icon: ShieldCheckIcon, badge: pendingCount },
        { to: '/memory', label: 'Memory', icon: DatabaseIcon },
      ],
    },
    {
      title: '구성',
      items: [
        { to: '/agents', label: 'Agent', icon: BotIcon },
        { to: '/mcp', label: 'MCP', icon: PlugIcon },
        { to: '/skills', label: 'Skill', icon: FileCodeIcon },
        { to: '/widget', label: '위젯', icon: MessageSquareIcon },
      ],
    },
    {
      title: '워크스페이스',
      items: [
        { to: '/marketplace', label: '마켓플레이스', icon: StoreIcon },
        { to: '/billing', label: '사용량 · 비용', icon: CreditCardIcon },
        { to: '/workspace', label: '워크스페이스', icon: SettingsIcon },
      ],
    },
  ];
  const current = sections.flatMap((s) =>
    s.items.filter((i) => isActive(i, pathname)).map((i) => ({ section: s.title, label: i.label })),
  )[0];

  return (
    <ToastProvider>
      <SidebarProvider>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:rounded-lg focus:bg-card focus:px-3 focus:py-2"
        >
          본문으로 건너뛰기
        </a>
        <Sidebar collapsible="icon">
          <SidebarHeader>
            <WorkspaceSwitcher workspaces={workspaces} />
          </SidebarHeader>
          <SidebarContent>
            <nav aria-label="콘솔 메뉴">
              {sections.map((s) => (
                <SidebarGroup key={s.title}>
                  <SidebarGroupLabel>{s.title}</SidebarGroupLabel>
                  <SidebarMenu>
                    {s.items.map((item) => (
                      <NavItemLink key={item.to} item={item} active={isActive(item, pathname)} />
                    ))}
                  </SidebarMenu>
                </SidebarGroup>
              ))}
            </nav>
          </SidebarContent>
          <SidebarFooter>
            <NavUser />
          </SidebarFooter>
          <SidebarRail />
        </Sidebar>
        <SidebarInset className="min-w-0">
          <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background/90 px-4 backdrop-blur">
            <SidebarTrigger className="-ml-1" />
            {current && (
              <>
                <Separator
                  orientation="vertical"
                  className="mr-1 data-[orientation=vertical]:h-4"
                />
                <p className="text-sm text-muted-foreground">
                  {current.section}
                  <span className="mx-1.5" aria-hidden="true">
                    /
                  </span>
                  <span className="font-medium text-foreground">{current.label}</span>
                </p>
              </>
            )}
          </header>
          <main
            id="main"
            className="@container w-full min-w-0 px-4 pt-4 pb-10 md:px-6 lg:px-10 lg:pt-[22px] lg:pb-[60px]"
            key={pathname.split('/')[1]}
          >
            <Outlet
              context={
                {
                  workspaces: workspaces.data,
                  reloadWorkspaces: workspaces.reload,
                } satisfies WorkspaceOutlet
              }
            />
          </main>
        </SidebarInset>
      </SidebarProvider>
    </ToastProvider>
  );
}

function NavItemLink({ item, active }: { item: NavItem; active: boolean }) {
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active} tooltip={item.label}>
        <NavLink to={item.to} end={item.end} onClick={() => isMobile && setOpenMobile(false)}>
          <item.icon />
          <span>{item.label}</span>
        </NavLink>
      </SidebarMenuButton>
      {item.badge ? (
        <SidebarMenuBadge className="rounded-full bg-amber-500 font-bold text-amber-950 peer-hover/menu-button:text-amber-950 peer-data-[active=true]/menu-button:text-amber-950">
          <span className="sr-only">대기 </span>
          {item.badge > 99 ? '99+' : item.badge}
          <span className="sr-only">건</span>
        </SidebarMenuBadge>
      ) : null}
    </SidebarMenuItem>
  );
}

/**
 * 사이드바 위 — 현재 워크스페이스, 누르면 내가 멤버인 워크스페이스 목록.
 * 이 로그인에서 비밀번호를 확인한 워크스페이스는 바로 옮겨 가고, 아니면 그 워크스페이스의 비밀번호를 묻는다.
 */
function WorkspaceSwitcher({ workspaces }: { workspaces: Query<WorkspaceItem[]> }) {
  const { tenantSlug } = useAuth();
  const { isMobile, setOpenMobile } = useSidebar();
  const navigate = useNavigate();
  const move = useWorkspaceSwitch();
  const current = workspaces.data?.find((w) => w.current);
  const name = current?.name ?? tenantSlug ?? '워크스페이스';
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu onOpenChange={(open) => open && void workspaces.reload()}>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <span
                className="inline-grid size-8 shrink-0 place-items-center rounded-lg bg-sidebar-primary font-bold text-sidebar-primary-foreground"
                aria-hidden="true"
              >
                {name.slice(0, 1).toUpperCase()}
              </span>
              <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">{name}</span>
                <span className="truncate text-xs text-muted-foreground">{tenantSlug}</span>
              </div>
              <ChevronsUpDownIcon className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            side={isMobile ? 'bottom' : 'right'}
            align="start"
            sideOffset={4}
          >
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              워크스페이스
            </DropdownMenuLabel>
            {(workspaces.data ?? []).map((w) => (
              <DropdownMenuItem key={w.slug} className="gap-2 p-2" onSelect={() => move.go(w)}>
                <span
                  className="inline-grid size-6 shrink-0 place-items-center rounded-md border text-xs font-semibold"
                  aria-hidden="true"
                >
                  {w.name.slice(0, 1).toUpperCase()}
                </span>
                <div className="grid min-w-0 flex-1 leading-tight">
                  <span className="truncate">{w.name}</span>
                  <span className="truncate text-xs text-muted-foreground">{w.slug}</span>
                </div>
                {w.isDefault && <Badge>기본</Badge>}
                {w.current && <CheckIcon className="size-4" aria-label="현재 워크스페이스" />}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="gap-2 p-2"
              onSelect={() => {
                if (isMobile) setOpenMobile(false);
                navigate('/workspace');
              }}
            >
              <SettingsIcon />
              워크스페이스
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
      {move.dialog}
    </SidebarMenu>
  );
}

/** 사이드바 메뉴와 워크스페이스 관리 화면이 같이 쓴다 — `dialog` 를 그려 둬야 비밀번호 창이 열린다 */
export function useWorkspaceSwitch() {
  const { switchWorkspace } = useAuth();
  const [asking, setAsking] = useState<WorkspaceItem | null>(null);
  const go = (w: WorkspaceItem) => {
    if (w.current) return;
    if (!w.switchable) return setAsking(w);
    switchWorkspace(w.slug).catch(() => setAsking(w));
  };
  return {
    go,
    dialog: <WorkspacePasswordDialog workspace={asking} onClose={() => setAsking(null)} />,
  };
}

/** 이 로그인에서 확인하지 않은 워크스페이스 — 같은 이메일이라도 워크스페이스마다 비밀번호가 따로다 */
function WorkspacePasswordDialog({
  workspace,
  onClose,
}: {
  workspace: WorkspaceItem | null;
  onClose: () => void;
}) {
  const { switchWorkspace } = useAuth();
  const [password, setPassword] = useState('');
  const move = useAction((slug: string, pw: string) => switchWorkspace(slug, pw));
  const close = () => {
    setPassword('');
    move.reset();
    onClose();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (workspace) void move.run(workspace.slug, password);
  };
  return (
    <Modal
      open={workspace !== null}
      title={`${workspace?.name ?? ''}(으)로 이동`}
      onClose={close}
      footer={
        <>
          <Button variant="outline" onClick={close}>
            취소
          </Button>
          <Button
            type="submit"
            form="workspace-password"
            loading={move.pending}
            disabled={!password}
          >
            이동
          </Button>
        </>
      }
    >
      <form id="workspace-password" onSubmit={submit}>
        <p className="mb-4 text-sm text-muted-foreground">
          이 워크스페이스는 비밀번호가 달라요. 이 워크스페이스의 비밀번호를 입력해 주세요.
        </p>
        <Field label="비밀번호">
          <Input
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <ErrorNotice error={move.error} />
      </form>
    </Modal>
  );
}

/** 로그인한 사용자 — 사이드바 맨 아래, 누르면 계정 메뉴(로그아웃) */
function NavUser() {
  const { user, logout } = useAuth();
  const { isMobile } = useSidebar();
  if (!user) return null;
  const name = user.name || user.email;
  const avatar = (
    <Avatar className="size-8 rounded-lg">
      <AvatarFallback className="rounded-lg font-semibold">
        {name.slice(0, 1).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              {avatar}
              <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">{name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {ROLE_LABEL[user.role]} · {user.email}
                </span>
              </div>
              <ChevronsUpDownIcon className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            side={isMobile ? 'bottom' : 'right'}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuLabel className="flex items-center gap-2 font-normal">
              {avatar}
              <div className="grid min-w-0 flex-1 leading-tight">
                <span className="truncate font-semibold">{name}</span>
                <span className="truncate text-xs text-muted-foreground">{user.email}</span>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={logout}>
              <LogOutIcon />
              로그아웃
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
