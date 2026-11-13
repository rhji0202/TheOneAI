import {
  BotIcon,
  CreditCardIcon,
  DatabaseIcon,
  FileCodeIcon,
  LayoutDashboardIcon,
  ListChecksIcon,
  type LucideIcon,
  MenuIcon,
  MessageSquareIcon,
  PlugIcon,
  ShieldCheckIcon,
  StoreIcon,
} from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
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

export function Layout() {
  const { user, tenantSlug, logout, api } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  // 승인 대기 수 — 사이드바 배지 (30초마다)
  const pending = useQuery(
    () => api.get<Page<unknown>>('/v1/admin/approvals', { status: 'pending', limit: 100 }),
    [],
    { pollMs: 30_000 },
  );
  const pendingCount = pending.data?.items.length ?? 0;

  const sections: { title: string; items: NavItem[] }[] = [
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

  return (
    <ToastProvider>
      <div className="grid min-h-screen grid-cols-[232px_minmax(0,1fr)] gap-0 max-[900px]:grid-cols-1">
        <a
          href="#main"
          className="absolute top-2 -left-[999px] z-[100] rounded-lg bg-card px-3 py-2 focus:left-2"
        >
          본문으로 건너뛰기
        </a>
        <aside
          aria-label="콘솔 메뉴"
          className={cn(
            'sticky top-0 h-screen overflow-y-auto border-r bg-sidebar px-3 py-4 text-sidebar-foreground',
            'max-[900px]:fixed max-[900px]:left-0 max-[900px]:z-40 max-[900px]:w-[260px] max-[900px]:transition-transform',
            menuOpen ? 'max-[900px]:shadow-2xl' : 'max-[900px]:-translate-x-full',
          )}
        >
          <div className="flex items-center gap-2.5 px-2 pt-1 pb-4">
            <span
              className="inline-grid size-8 place-items-center rounded-[9px] bg-primary font-bold text-primary-foreground"
              aria-hidden="true"
            >
              T
            </span>
            <div>
              <p className="font-bold">TheOneAI</p>
              <p className="text-xs text-muted-foreground">{tenantSlug ?? '워크스페이스'}</p>
            </div>
          </div>
          <nav>
            {sections.map((s) => (
              <div key={s.title} className="mt-3">
                <p className="px-2.5 py-1.5 text-xs font-semibold tracking-wide text-muted-foreground">
                  {s.title}
                </p>
                {s.items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) =>
                      cn(
                        'flex min-h-[38px] items-center gap-2.5 rounded-lg px-2.5 py-2 font-medium text-foreground/75 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                        isActive && 'bg-sidebar-accent text-primary hover:text-primary',
                      )
                    }
                    onClick={() => setMenuOpen(false)}
                  >
                    <item.icon className="size-[18px] shrink-0" aria-hidden="true" />
                    <span>{item.label}</span>
                    {item.badge ? (
                      <span
                        className="ml-auto inline-grid h-5 min-w-5 place-items-center rounded-full bg-amber-500 px-1.5 text-xs font-bold text-amber-950"
                        aria-label={`대기 ${item.badge}건`}
                      >
                        {item.badge > 99 ? '99+' : item.badge}
                      </span>
                    ) : null}
                  </NavLink>
                ))}
              </div>
            ))}
          </nav>
        </aside>
        <div className="flex min-w-0 flex-col">
          <header className="sticky top-0 z-10 flex h-14 items-center gap-3 border-b bg-background/90 px-6 backdrop-blur">
            <Button
              variant="ghost"
              size="icon"
              className="hidden max-[900px]:inline-flex"
              aria-label="메뉴"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            >
              <MenuIcon className="size-5" />
            </Button>
            <div className="flex-1" />
            {user && (
              <div className="flex items-center gap-2.5">
                <span
                  className="inline-grid size-8 place-items-center rounded-full bg-muted font-semibold"
                  aria-hidden="true"
                >
                  {(user.name || user.email).slice(0, 1).toUpperCase()}
                </span>
                <div>
                  <p className="text-sm font-semibold">{user.name || user.email}</p>
                  <p className="text-xs text-muted-foreground">
                    {ROLE_LABEL[user.role]} · {user.email}
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={logout}>
                  로그아웃
                </Button>
              </div>
            )}
          </header>
          <main
            id="main"
            className="mx-auto w-full max-w-[1280px] p-6"
            key={location.pathname.split('/')[1]}
          >
            <Outlet />
          </main>
        </div>
        {menuOpen && (
          <div
            className="fixed inset-0 z-30 bg-black/40 min-[901px]:hidden"
            onClick={() => setMenuOpen(false)}
          />
        )}
      </div>
    </ToastProvider>
  );
}
