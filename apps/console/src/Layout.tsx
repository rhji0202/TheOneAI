import {
  BotIcon,
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
  ShieldCheckIcon,
  StoreIcon,
} from 'lucide-react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { type Page, ToastProvider, useQuery } from './ui';

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
  const { tenantSlug, api } = useAuth();
  const { pathname } = useLocation();
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
        { to: '/agents', label: 'Agent 설정', icon: BotIcon },
        { to: '/mcp', label: 'MCP 서버', icon: PlugIcon },
        { to: '/skills', label: 'Skill', icon: FileCodeIcon },
        { to: '/widget', label: '위젯 설치', icon: MessageSquareIcon },
      ],
    },
    {
      title: '워크스페이스',
      items: [
        { to: '/marketplace', label: '마켓플레이스', icon: StoreIcon },
        { to: '/billing', label: '사용량 · 비용', icon: CreditCardIcon },
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
            <div className="flex items-center gap-2 overflow-hidden p-1">
              <span
                className="inline-grid size-8 shrink-0 place-items-center rounded-lg bg-sidebar-primary font-bold text-sidebar-primary-foreground"
                aria-hidden="true"
              >
                T
              </span>
              <div className="grid min-w-0 leading-tight group-data-[collapsible=icon]:hidden">
                <span className="truncate font-semibold">TheOneAI</span>
                <span className="truncate text-xs text-muted-foreground">
                  {tenantSlug ?? '워크스페이스'}
                </span>
              </div>
            </div>
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
            className="mx-auto w-full max-w-[1280px] p-6"
            key={pathname.split('/')[1]}
          >
            <Outlet />
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
