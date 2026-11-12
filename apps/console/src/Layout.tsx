import { type ReactNode, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { ROLE_LABEL } from './api';
import { useAuth } from './auth';
import { type Page, ToastProvider, useQuery } from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  end?: boolean;
  badge?: number;
}

const I = (d: string) => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={d} />
  </svg>
);

const ICONS = {
  dashboard: I('M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z'),
  tasks: I('M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01'),
  agent: I(
    'M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15.5l-1.9-4.6L5.5 9l4.6-1.4zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z',
  ),
  mcp: I('M8 3v4M16 3v4M6 7h12v4a6 6 0 01-12 0zM12 17v4'),
  skill: I('M4 4h10l6 6v10H4zM14 4v6h6M8 14h8M8 18h5'),
  approval: I('M12 3l8 3v6c0 4.5-3.4 8.4-8 9-4.6-.6-8-4.5-8-9V6zM8.5 12l2.5 2.5 4.5-5'),
  memory: I(
    'M12 4a8 3 0 100 6 8 3 0 000-6zM4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  ),
  widget: I('M4 5h16v11H8l-4 4zM8 10h8'),
  market: I('M4 7h16l-1.5 12h-13zM9 7a3 3 0 016 0'),
  billing: I('M4 6h16v12H4zM4 10h16M8 15h3'),
};

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
        { to: '/', label: '대시보드', icon: ICONS.dashboard, end: true },
        { to: '/tasks', label: '작업', icon: ICONS.tasks },
        { to: '/approvals', label: '승인 · 권한', icon: ICONS.approval, badge: pendingCount },
        { to: '/memory', label: 'Memory', icon: ICONS.memory },
      ],
    },
    {
      title: '구성',
      items: [
        { to: '/agents', label: 'Agent 설정', icon: ICONS.agent },
        { to: '/mcp', label: 'MCP 서버', icon: ICONS.mcp },
        { to: '/skills', label: 'Skill', icon: ICONS.skill },
        { to: '/widget', label: '위젯 설치', icon: ICONS.widget },
      ],
    },
    {
      title: '워크스페이스',
      items: [
        { to: '/marketplace', label: '마켓플레이스', icon: ICONS.market },
        { to: '/billing', label: '사용량 · 비용', icon: ICONS.billing },
      ],
    },
  ];

  return (
    <ToastProvider>
      <div className={menuOpen ? 'shell menu-open' : 'shell'}>
        <a href="#main" className="skip-link">
          본문으로 건너뛰기
        </a>
        <aside className="sidebar" aria-label="콘솔 메뉴">
          <div className="sidebar-brand">
            <span className="brand-mark" aria-hidden="true">
              T
            </span>
            <div>
              <p className="brand-name">TheOneAI</p>
              <p className="brand-ws">{tenantSlug ?? '워크스페이스'}</p>
            </div>
          </div>
          <nav>
            {sections.map((s) => (
              <div key={s.title} className="nav-section">
                <p className="nav-title">{s.title}</p>
                {s.items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}
                    onClick={() => setMenuOpen(false)}
                  >
                    {item.icon}
                    <span>{item.label}</span>
                    {item.badge ? (
                      <span className="nav-badge" aria-label={`대기 ${item.badge}건`}>
                        {item.badge > 99 ? '99+' : item.badge}
                      </span>
                    ) : null}
                  </NavLink>
                ))}
              </div>
            ))}
          </nav>
        </aside>
        <div className="main-col">
          <header className="topbar">
            <button
              type="button"
              className="menu-btn"
              aria-label="메뉴"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            >
              ☰
            </button>
            <div className="topbar-spacer" />
            {user && (
              <div className="user-chip">
                <span className="avatar" aria-hidden="true">
                  {(user.name || user.email).slice(0, 1).toUpperCase()}
                </span>
                <div className="user-text">
                  <p className="user-name">{user.name || user.email}</p>
                  <p className="user-role">
                    {ROLE_LABEL[user.role]} · {user.email}
                  </p>
                </div>
                <button type="button" className="btn btn-ghost btn-sm" onClick={logout}>
                  로그아웃
                </button>
              </div>
            )}
          </header>
          <main id="main" className="content" key={location.pathname.split('/')[1]}>
            <Outlet />
          </main>
        </div>
        {menuOpen && <div className="scrim" onClick={() => setMenuOpen(false)} />}
      </div>
    </ToastProvider>
  );
}
