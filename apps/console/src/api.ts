/**
 * 콘솔 Admin API 클라이언트 — `/v1/admin/...` 를 Bearer 토큰으로 부른다.
 * 토큰은 sessionStorage 에만 둔다(탭을 닫으면 사라짐). 401 이면 로그인 화면으로.
 * 화면별 응답 타입은 각 페이지 파일에 둔다.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** problem+json 의 나머지 필드 (policyIssues · issues 등) */
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export type MemberRole = 'owner' | 'admin' | 'operator' | 'viewer';

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: MemberRole;
  tenantId: string;
}

export interface Session {
  accessToken: string;
  expiresAt: string;
  user: AdminUser;
  tenantSlug: string;
}

type Query = Record<string, string | number | boolean | null | undefined>;

const SESSION_KEY = 'theoneai:console:session';

export class AdminApi {
  private session: Session | null = loadSession();
  onUnauthorized: (() => void) | null = null;

  constructor(readonly base = '') {}

  get current(): Session | null {
    if (this.session && Date.parse(this.session.expiresAt) <= Date.now()) this.clear();
    return this.session;
  }

  async login(input: { tenantSlug: string; email: string; password: string }): Promise<Session> {
    const res = await this.raw<Omit<Session, 'tenantSlug'>>('POST', '/v1/admin/auth/login', {
      body: input,
      auth: false,
    });
    this.session = { ...res, tenantSlug: input.tenantSlug };
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(this.session));
    } catch {
      // 저장소를 못 쓰면 이 탭에서만 유지
    }
    return this.session;
  }

  clear(): void {
    this.session = null;
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      // 무시
    }
  }

  get<T>(path: string, query?: Query): Promise<T> {
    return this.raw<T>('GET', path, { query });
  }
  post<T>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
    return this.raw<T>('POST', path, { body: body ?? {}, headers });
  }
  put<T>(path: string, body: unknown): Promise<T> {
    return this.raw<T>('PUT', path, { body });
  }
  patch<T>(path: string, body: unknown): Promise<T> {
    return this.raw<T>('PATCH', path, { body });
  }
  delete<T = void>(path: string, body?: unknown): Promise<T> {
    return this.raw<T>('DELETE', path, { body });
  }

  /** multipart 업로드 (Skill zip 등) */
  upload<T>(path: string, form: FormData): Promise<T> {
    return this.raw<T>('POST', path, { form });
  }

  /** 인증이 필요한 파일 다운로드 → 브라우저 저장 */
  async download(path: string, fallbackName = 'download'): Promise<void> {
    const res = await fetch(this.url(path), { headers: this.authHeader() });
    if (!res.ok) await this.fail(res);
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') ?? '';
    const name =
      /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1] ??
      /filename="([^"]+)"/i.exec(disposition)?.[1] ??
      fallbackName;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = decodeURIComponent(name);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  private async raw<T>(
    method: string,
    path: string,
    opts: {
      query?: Query;
      body?: unknown;
      form?: FormData;
      headers?: Record<string, string>;
      auth?: boolean;
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      ...(opts.auth === false ? {} : this.authHeader()),
      ...(opts.body !== undefined && !opts.form ? { 'Content-Type': 'application/json' } : {}),
      ...opts.headers,
    };
    const res = await fetch(this.url(path, opts.query), {
      method,
      headers,
      body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    });
    if (!res.ok) await this.fail(res, opts.auth !== false);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private url(path: string, query?: Query): string {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
    }
    const qs = q.toString();
    return `${this.base}${path}${qs ? `?${qs}` : ''}`;
  }

  private authHeader(): Record<string, string> {
    const token = this.current?.accessToken;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  private async fail(res: Response, authed = true): Promise<never> {
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      // 본문 없음
    }
    if (res.status === 401 && authed) {
      this.clear();
      this.onUnauthorized?.();
    }
    const message =
      typeof body.detail === 'string'
        ? body.detail
        : typeof body.title === 'string'
          ? body.title
          : `요청을 처리하지 못했어요 (${res.status})`;
    throw new ApiError(
      res.status,
      typeof body.code === 'string' ? body.code : 'ERROR',
      message,
      body,
    );
  }
}

function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

const RANK: Record<MemberRole, number> = { viewer: 0, operator: 1, admin: 2, owner: 3 };

/** 역할 비교 — Owner > Admin > Operator > Viewer */
export function atLeast(role: MemberRole | undefined, min: MemberRole): boolean {
  return role ? RANK[role] >= RANK[min] : false;
}

export const ROLE_LABEL: Record<MemberRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  operator: 'Operator',
  viewer: 'Viewer',
};
