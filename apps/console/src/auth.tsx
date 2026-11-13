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
import { CircleAlertIcon, TriangleAlertIcon } from 'lucide-react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
    <main className="grid min-h-screen place-items-center p-4">
      <form
        className="flex w-full max-w-[400px] flex-col gap-4 rounded-2xl border bg-card p-7 shadow-xl"
        onSubmit={submit}
        aria-labelledby="login-title"
      >
        <div className="flex items-center gap-2.5 font-bold">
          <span
            className="inline-grid size-8 place-items-center rounded-[9px] bg-primary text-primary-foreground"
            aria-hidden="true"
          >
            T
          </span>
          <span>TheOneAI 콘솔</span>
        </div>
        <h1 id="login-title" className="text-xl font-semibold">
          로그인
        </h1>
        {state?.expired && !error && (
          <Alert
            role="status"
            className="border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
          >
            <TriangleAlertIcon aria-hidden="true" />
            <AlertDescription className="text-current">
              로그인이 만료됐어요. 다시 로그인해 주세요.
            </AlertDescription>
          </Alert>
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="login-workspace">워크스페이스</Label>
          <Input
            id="login-workspace"
            required
            autoComplete="organization"
            value={tenantSlug}
            onChange={(e) => setTenantSlug(e.target.value)}
            placeholder="예: demo"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="login-email">이메일</Label>
          <Input
            id="login-email"
            type="email"
            required
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="login-password">비밀번호</Label>
          <Input
            id="login-password"
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error && (
          <Alert variant="destructive">
            <CircleAlertIcon aria-hidden="true" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? '확인하는 중…' : '로그인'}
        </Button>
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
