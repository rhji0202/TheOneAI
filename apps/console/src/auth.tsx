import {
  createContext,
  type FormEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { AdminApi, type AdminUser, ApiError, atLeast, type MemberRole } from './api';

interface AuthState {
  api: AdminApi;
  user: AdminUser | null;
  tenantSlug: string | null;
  login(input: { tenantSlug: string; email: string; password: string }): Promise<void>;
  logout(): void;
  /** 현재 사용자가 이 역할 이상인지 */
  can(min: MemberRole): boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const api = useMemo(() => new AdminApi(), []);
  const [user, setUser] = useState<AdminUser | null>(api.current?.user ?? null);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    api.onUnauthorized = () => {
      setUser(null);
      navigate('/login', { replace: true, state: { from: location.pathname, expired: true } });
    };
  }, [api, navigate, location.pathname]);

  // 새로고침 뒤: 토큰이 아직 유효한지 · 역할이 바뀌지 않았는지 확인
  useEffect(() => {
    if (!api.current) return;
    api
      .get<AdminUser>('/v1/admin/me')
      .then(setUser)
      .catch(() => undefined);
  }, [api]);

  const login = useCallback(
    async (input: { tenantSlug: string; email: string; password: string }) => {
      const session = await api.login(input);
      setUser(session.user);
    },
    [api],
  );

  const logout = useCallback(() => {
    api.clear();
    setUser(null);
    navigate('/login', { replace: true });
  }, [api, navigate]);

  const value = useMemo<AuthState>(
    () => ({
      api,
      user,
      tenantSlug: api.current?.tenantSlug ?? null,
      login,
      logout,
      can: (min) => atLeast(user?.role, min),
    }),
    [api, user, login, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('AuthProvider 밖에서 useAuth');
  return ctx;
}

export function useApi(): AdminApi {
  return useAuth().api;
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const location = useLocation();
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}

export function LoginPage() {
  const { login, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state as { from?: string; expired?: boolean } | null;
  const [tenantSlug, setTenantSlug] = useState(() => lastWorkspace());
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (user) return <Navigate to={state?.from ?? '/'} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      await login({ tenantSlug: tenantSlug.trim(), email: email.trim(), password });
      try {
        localStorage.setItem('theoneai:console:workspace', tenantSlug.trim());
      } catch {
        // 무시
      }
      navigate(state?.from && state.from !== '/login' ? state.from : '/', { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 429
          ? '로그인 시도가 너무 많아요. 잠시 후 다시 시도해 주세요.'
          : err instanceof Error
            ? err.message
            : '로그인하지 못했어요',
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="login">
      <form className="login-card" onSubmit={submit} aria-labelledby="login-title">
        <div className="login-brand">
          <span className="brand-mark" aria-hidden="true">
            T
          </span>
          <span>TheOneAI 콘솔</span>
        </div>
        <h1 id="login-title">로그인</h1>
        {state?.expired && !error && (
          <p className="notice notice-warn" role="status">
            로그인이 만료됐어요. 다시 로그인해 주세요.
          </p>
        )}
        <label className="field">
          <span className="field-label">워크스페이스</span>
          <input
            className="input"
            required
            autoComplete="organization"
            value={tenantSlug}
            onChange={(e) => setTenantSlug(e.target.value)}
            placeholder="예: demo"
          />
        </label>
        <label className="field">
          <span className="field-label">이메일</span>
          <input
            className="input"
            type="email"
            required
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">비밀번호</span>
          <input
            className="input"
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary btn-block" disabled={pending}>
          {pending ? '확인하는 중…' : '로그인'}
        </button>
      </form>
    </main>
  );
}

function lastWorkspace(): string {
  try {
    return localStorage.getItem('theoneai:console:workspace') ?? '';
  } catch {
    return '';
  }
}
