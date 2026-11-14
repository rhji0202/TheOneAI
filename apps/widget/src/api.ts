/** Widget API 클라이언트 (docs/api-spec.md §1.1 · §2) — 세션 토큰은 메모리에만 둔다 */
export interface Suggestion {
  skillName: string;
  title: string;
  description: string;
  prompt: string;
}

export interface Theme {
  brandColor: string;
  position: 'bottom-right' | 'bottom-left';
  darkMode: 'system' | 'light' | 'dark';
  /** 콘솔에서 올린 위젯 아이콘 (API 기준 경로) — 없으면 기본 아이콘 */
  iconUrl: string | null;
}

export interface Behavior {
  autoOpen: boolean;
  language: string;
  attachments: { types: string[]; maxMb: number };
  noticeText: string;
  showPoweredBy: boolean;
  /** 새 대화 화면의 제시어 — 누르면 그대로 보낸다 (콘솔 위젯 설정) */
  starterPrompts: string[];
}

export interface TaskSummary {
  id: string;
  title: string;
  status: string;
  progress: { completed: number; total: number | null };
  conversationId: string;
  pendingApproval: { id: string; expiresAt: string } | null;
  failure: { code: string; message: string; resumable: boolean } | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface Bootstrap {
  sessionToken: string;
  expiresAt: string;
  endUser: { id: string; anonymous: boolean };
  agent: { id: string; name: string; avatarUrl: string | null; welcomeMessage: string };
  theme: Theme;
  behavior: Behavior;
  suggestions: Suggestion[];
  activeTasks: TaskSummary[];
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'attachment';
      artifactId: string;
      /** 서버가 응답에 채운다 */
      fileName?: string;
      mimeType?: string;
      sizeBytes?: number;
    };

export interface MessageView {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: ContentBlock[];
  taskId: string | null;
  createdAt: string;
}

export interface PlanStep {
  index: number;
  title: string;
  kind: 'reason' | 'tool' | 'skill' | 'respond';
  toolName?: string;
  skill?: { name: string; version: string };
  requiresApproval: boolean;
  status: string;
}

export interface ApprovalView {
  id: string;
  taskId: string;
  toolName: string;
  toolSource: string;
  permissionLevel: string;
  riskLevel: 'low' | 'medium' | 'high';
  summary: string;
  args: Array<{ label: string; value: string }>;
  rawArgs: Record<string, unknown>;
  reason: string;
  requiredApprover: 'user' | 'operator' | 'user_and_operator';
  allowTaskScope: boolean;
  status: string;
  waitingFor: 'user' | 'operator' | 'user_and_operator' | null;
  expiresAt: string;
}

export interface ArtifactView {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  previewable: boolean;
  createdAt: string;
}

export interface TaskResult {
  messageId: string | null;
  summary: {
    steps: number;
    toolCalls: number;
    retries: number;
    replans: number;
    durationMs: number;
  };
  artifacts: ArtifactView[];
}

export interface TaskDetail extends Omit<TaskSummary, 'pendingApproval'> {
  plan: { version: number; steps: PlanStep[]; revisedReason: string | null } | null;
  pendingApproval: ApprovalView | null;
  result: TaskResult | null;
  lastEventId: string | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class WidgetApi {
  token: string | null = null;

  constructor(
    readonly base: string,
    readonly widgetKey: string,
  ) {}

  async bootstrap(identity: { identityToken?: string; anonymousId?: string }): Promise<Bootstrap> {
    const res = await this.request<Bootstrap>('POST', '/v1/widget/bootstrap', {
      publicKey: this.widgetKey,
      ...identity,
    });
    this.token = res.sessionToken;
    return res;
  }

  createConversation() {
    return this.request<{ id: string }>('POST', '/v1/conversations', {});
  }

  messages(conversationId: string) {
    return this.request<{ items: MessageView[] }>(
      'GET',
      `/v1/conversations/${conversationId}/messages?limit=100`,
    );
  }

  send(conversationId: string, content: ContentBlock[]) {
    return this.request<{ message: MessageView; task: TaskSummary; eventsUrl: string }>(
      'POST',
      `/v1/conversations/${conversationId}/messages`,
      { content },
    );
  }

  tasks(group: 'active' | 'completed' | 'failed') {
    return this.request<{ items: TaskSummary[] }>('GET', `/v1/tasks?group=${group}&limit=30`);
  }

  task(id: string) {
    return this.request<TaskDetail>('GET', `/v1/tasks/${id}`);
  }

  cancel(id: string) {
    return this.request<TaskSummary>('POST', `/v1/tasks/${id}/cancel`, {});
  }

  steer(id: string, text: string) {
    return this.request<{ messageId: string }>('POST', `/v1/tasks/${id}/steer`, { text });
  }

  resume(id: string, mode: 'checkpoint' | 'restart') {
    return this.request<TaskSummary>('POST', `/v1/tasks/${id}/resume`, { mode });
  }

  decide(
    approvalId: string,
    body: { decision: 'approve' | 'reject'; scope?: 'once' | 'task'; comment?: string },
  ) {
    return this.request<ApprovalView>('POST', `/v1/approvals/${approvalId}/decision`, body);
  }

  artifacts(taskId: string) {
    return this.request<ArtifactView[]>('GET', `/v1/tasks/${taskId}/artifacts`);
  }

  /** 업로드 — 시작(메타데이터) → 내용 PUT */
  async upload(file: File): Promise<ArtifactView> {
    const data = new Uint8Array(await file.arrayBuffer());
    const digest = await crypto.subtle.digest('SHA-256', data);
    const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const started = await this.request<{
      artifactId: string;
      uploadUrl: string;
      headers: Record<string, string>;
    }>('POST', '/v1/uploads', {
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
      sha256,
    });
    const url = started.uploadUrl.startsWith('http')
      ? started.uploadUrl
      : `${this.base}${started.uploadUrl}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        ...started.headers,
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: data,
    });
    return this.parse<ArtifactView>(res);
  }

  /** 파일 내용 — 내려받기 · 이미지 미리보기 (인증 헤더가 필요해 img src 로 바로 쓸 수 없다) */
  async blob(artifactId: string): Promise<Blob> {
    const res = await fetch(`${this.base}/v1/artifacts/${artifactId}/download`, {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
    });
    if (!res.ok) throw new ApiError(res.status, 'DOWNLOAD_FAILED', '파일을 내려받지 못했어요');
    return res.blob();
  }

  async download(artifact: ArtifactView): Promise<void> {
    const url = URL.createObjectURL(await this.blob(artifact.id));
    const a = document.createElement('a');
    a.href = url;
    a.download = artifact.fileName;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  eventsUrl(taskId: string): string {
    return `${this.base}/v1/tasks/${taskId}/events`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return this.parse<T>(res);
  }

  private async parse<T>(res: Response): Promise<T> {
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) {
      throw new ApiError(
        res.status,
        typeof json.code === 'string' ? json.code : 'ERROR',
        typeof json.detail === 'string'
          ? json.detail
          : typeof json.title === 'string'
            ? json.title
            : '요청을 처리하지 못했어요',
      );
    }
    return json as T;
  }
}
