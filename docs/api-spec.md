# NestJS API 명세 v0.1

- 기준: 기획안 v2.0 · [화면 설계](screen-design.md) · [데이터 모델](data-model.md)
- 대상: NestJS 12 · TypeScript · Prisma 7 · BullMQ · Redis · SSE
- 이 문서의 경로는 화면 설계서의 API 표기와 같다(화면에서는 `/v1` 을 생략해 표기).

---

## 0. 공통 규약

| 항목 | 규칙 |
|---|---|
| Base URL | `https://api.[YOUR-DOMAIN]/v1` (URI 버전 관리: `app.enableVersioning({ type: VersioningType.URI })`) |
| API 표면 | **Widget API** — 위젯 세션 토큰. `/v1/widget`, `/v1/conversations`, `/v1/tasks`, `/v1/approvals`, `/v1/artifacts`, `/v1/uploads`<br>**Admin API** — 콘솔 멤버 토큰. `/v1/admin/**` |
| 형식 | JSON, 필드 camelCase, 시간 ISO 8601(UTC), ID 는 UUIDv7 문자열, enum 은 소문자 snake_case (DB 와 동일) |
| 페이지네이션 | 커서 방식 `?limit=20&cursor=<opaque>` → `{ items: T[], nextCursor: string \| null }` (limit 최대 100) |
| 멱등성 | 생성 · 상태 변경 POST 는 `Idempotency-Key` 헤더 지원 (Redis 24시간 보관, 같은 키 + 다른 본문이면 `409 IDEMPOTENCY_KEY_REUSED`) |
| 오류 | RFC 9457 `application/problem+json` — §5 |
| 추적 | W3C `traceparent` 수신 · 전파, 모든 응답에 `X-Trace-Id` (OpenTelemetry) |
| 요청 제한 | Widget: 세션당 메시지 30회/분, 기타 120회/분 · Admin: 사용자당 600회/분 · 초과 시 `429` + `Retry-After` |
| 마스킹 | Tool 인자 · 결과 · checkpoint 는 서버에서 Secret · 토큰 · 개인정보를 마스킹한 뒤 응답한다 |

공통 타입 (이후 섹션에서 참조):

```ts
type TaskStatus = 'queued' | 'running' | 'waiting_approval' | 'paused' | 'recovering' | 'completed' | 'failed' | 'cancelled';
type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'waiting_approval' | 'cancelled';
type PermissionLevel = 'read' | 'write' | 'external_send' | 'delete' | 'financial';
type RiskLevel = 'low' | 'medium' | 'high';
type Page<T> = { items: T[]; nextCursor: string | null };

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'attachment'; artifactId: string };

interface MessageView {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: ContentBlock[];
  taskId: string | null;
  createdAt: string;
}

interface PlanStep {
  index: number;               // 1부터. 위젯 계획 카드의 n / total
  title: string;               // "3월 매출 데이터 조회"
  kind: 'reason' | 'tool' | 'skill' | 'respond'; // reason = Tool 없이 분석 · 초안 작성
  toolName?: string;           // "sales-db.query"
  skill?: { name: string; version: string };
  requiresApproval: boolean;   // 정책상 승인 대상이면 true (계획 단계에서 미리 표시)
  status: StepStatus;
}

interface TaskSummary {
  id: string;
  title: string;
  status: TaskStatus;
  progress: { completed: number; total: number | null }; // 재계획 시 total 이 바뀔 수 있음
  conversationId: string;
  pendingApproval: { id: string; expiresAt: string } | null;
  failure: { code: string; message: string; resumable: boolean } | null;
  createdAt: string;
  finishedAt: string | null;
}

interface ApprovalView {
  id: string;
  taskId: string;
  toolName: string;            // "google-drive.upload_file"
  toolSource: 'mcp' | 'sandbox' | 'builtin' | 'skill_script';
  permissionLevel: PermissionLevel;
  riskLevel: RiskLevel;
  summary: string;             // "외부 저장소에 파일을 업로드하고 영업팀 그룹에 공유합니다."
  args: Array<{ label: string; value: string }>; // 사람이 읽는 인자 (마스킹 완료)
  rawArgs: Record<string, unknown>;               // JSON 원문 보기 (마스킹 완료)
  reason: string;
  requiredApprover: 'user' | 'operator' | 'user_and_operator';
  allowTaskScope: boolean;     // "이 작업 동안 다시 묻지 않기" 노출 여부
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';
  expiresAt: string;
}

interface ArtifactView {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  previewable: boolean;
  createdAt: string;
}
```

---

## 1. 인증

### 1.1 Widget

```
loader.js ──POST /v1/widget/bootstrap { publicKey, identityToken?, anonymousId? }──▶ API
                Origin 헤더 검사 (widget_configs.allowed_origins)
                identityToken 검증 (identity_mode = signed_token)
          ◀── { sessionToken (1h), agent, theme, suggestions, activeTasks }
이후 요청:  Authorization: Bearer <sessionToken>
만료 5분 전 loader 가 bootstrap 을 다시 호출해 갱신
```

**identity token** — 고객사 서버가 발급해 페이지에 전달한다. 브라우저에서 사용자 ID 를 직접 받지 않는다.

| 항목 | 값 |
|---|---|
| 서명 | HS256, Widget Secret (C-09 에서 발급, 재발급 후 24시간 동안 이전 Secret 도 허용) |
| `sub` | 고객사 사용자 ID (필수) → `end_users.external_id` |
| `aud` | 위젯 공개 키 (`wk_pub_...`) |
| `exp` | 발급 후 10분 이내 |
| `name`, `locale` | 선택 |

**session token** — 플랫폼이 발급하는 JWT(ES256). claims: `tid`(tenant), `wid`(widget), `aid`(agent), `euid`(end user), `anon`(boolean), `aud: "widget"`.

익명 모드(`identity_mode = anonymous`)는 loader 가 만든 `anonymousId` 로 세션을 묶는다. 사용자 범위 Memory 저장과 승인 이력 조회는 하지 않는다.

### 1.2 Admin

| Method | Path | 설명 |
|---|---|---|
| POST | `/v1/admin/auth/login` | `{ tenantSlug, email, password }` → `{ accessToken, expiresAt, user }` + refresh 쿠키 |
| POST | `/v1/admin/auth/refresh` | refresh 쿠키 회전 → 새 accessToken |
| POST | `/v1/admin/auth/logout` | refresh 무효화 |
| GET | `/v1/admin/me` | 현재 멤버 · 역할 · 테넌트 |

- access token: JWT 15분, claims `tid`, `sub`, `role`, `aud: "admin"`
- refresh token: `HttpOnly; Secure; SameSite=Strict` 쿠키, 14일, 사용할 때마다 회전(재사용 감지 시 전체 세션 폐기)
- SSO(OIDC)는 2차. `users.sso_subject` 컬럼만 준비.

**역할별 권한 (RBAC)**

| 기능 | Owner | Admin | Operator | Viewer |
|---|:-:|:-:|:-:|:-:|
| 대시보드 · 작업 · 대화 조회 | ✓ | ✓ | ✓ | ✓ |
| 작업 일시정지 · 취소 · 재개 | ✓ | ✓ | ✓ | |
| 승인 대리 처리 | ✓ | ✓ | ✓ | |
| Agent 초안 편집 · 테스트 | ✓ | ✓ | | |
| Agent 배포 · 롤백 | ✓ | ✓ | | |
| MCP · Skill 등록 · 정책 변경 | ✓ | ✓ | | |
| Memory 수정 · 삭제 · 사용자 데이터 삭제 | ✓ | ✓ | | |
| Widget 설정 | ✓ | ✓ | | |
| Widget Secret 재발급 · 멤버 관리 | ✓ | | | |

NestJS: `@Roles('admin')` 데코레이터 + `RolesGuard`. 모든 변경 요청은 `AuditInterceptor` 가 `audit_logs` 에 기록한다.

---

## 2. Widget API

| Method | Path | 설명 | 화면 |
|---|---|---|---|
| POST | `/v1/widget/bootstrap` | 세션 발급 + 위젯 초기 데이터 | W-01 |
| GET | `/v1/conversations` | 내 대화 목록 | W-01 |
| POST | `/v1/conversations` | 새 대화 | W-01 |
| GET | `/v1/conversations/:id/messages` | 메시지 목록 | W-02 |
| POST | `/v1/conversations/:id/messages` | 요청 전송 → 작업 생성 (`202`) | W-02 |
| POST | `/v1/uploads` | 첨부 업로드 URL 발급 | W-01 |
| POST | `/v1/uploads/:artifactId/complete` | 업로드 완료 확인 (크기 · 해시 · 형식 검사) | W-01 |
| GET | `/v1/tasks` | 작업 목록 (`group=active\|completed\|failed`) | W-05 |
| GET | `/v1/tasks/:id` | 작업 상태 · 계획 · 대기 중 승인 | W-02 |
| GET | `/v1/tasks/:id/events` | 실행 이벤트 스트림 (SSE) | W-02 ~ W-05 |
| POST | `/v1/tasks/:id/steer` | 실행 중 추가 지시 | W-02 |
| POST | `/v1/tasks/:id/cancel` | 중지 | W-02 |
| POST | `/v1/tasks/:id/resume` | 재개 (`checkpoint` \| `restart`) | W-05 |
| POST | `/v1/approvals/:id/decision` | 승인 · 거절 | W-03 |
| GET | `/v1/tasks/:id/artifacts` | 산출물 목록 | W-04 |
| GET | `/v1/artifacts/:id/download` | presigned URL 로 `302` (`?disposition=inline` 미리보기) | W-04 |
| POST | `/v1/tasks/:id/feedback` | 도움됨 · 개선 필요 | W-04 |

### 2.1 `POST /v1/widget/bootstrap`

인증 없음. `Origin` 헤더 필수.

```ts
// Request
interface WidgetBootstrapRequest {
  publicKey: string;          // wk_pub_...
  identityToken?: string;     // identity_mode = signed_token 이면 필수
  anonymousId?: string;       // identity_mode = anonymous 이면 필수
}

// 200
interface WidgetBootstrapResponse {
  sessionToken: string;
  expiresAt: string;
  endUser: { id: string; anonymous: boolean };
  agent: { id: string; name: string; avatarUrl: string | null; welcomeMessage: string };
  theme: { brandColor: string; position: 'bottom-right' | 'bottom-left'; darkMode: 'system' | 'light' | 'dark' };
  behavior: { autoOpen: boolean; language: string; attachments: { types: string[]; maxMb: number }; noticeText: string; showPoweredBy: boolean };
  suggestions: Array<{ skillName: string; title: string; description: string; prompt: string }>; // 활성 Skill metadata
  activeTasks: TaskSummary[];  // 진행 중 + 승인 대기
}
```

오류: `ORIGIN_NOT_ALLOWED`(403), `WIDGET_DISABLED`(403), `IDENTITY_TOKEN_INVALID`(401), `IDENTITY_TOKEN_REQUIRED`(401).

### 2.2 `POST /v1/conversations/:id/messages`

```ts
// Request (Idempotency-Key 권장)
interface SendMessageRequest {
  content: ContentBlock[];     // text 최대 8,000자, attachment 최대 5개 (업로드 완료된 것만)
}

// 202
interface SendMessageResponse {
  message: MessageView;
  task: TaskSummary;           // status = 'queued'
  eventsUrl: string;           // /v1/tasks/:id/events
}
```

- 한 트랜잭션에서 `messages` · `tasks` 를 만들고 커밋 후 BullMQ `agent-tasks` 에 `jobId = taskId` 로 넣는다(§6).
- 작업은 **배포된 Agent 버전**과 **최신 Tool Registry 버전**으로 고정된다.
- 같은 대화에 실행 중 작업이 있으면 `409 TASK_ALREADY_ACTIVE` — 위젯은 `steer` 로 보낸다. 동시 요청 경쟁은 DB 부분 유니크 인덱스(`tasks_one_active_per_conversation`)가 최종 판단한다.
- `Idempotency-Key` 는 `messages(conversation_id, idempotency_key)` 유니크로 보장한다. 같은 키 + 같은 본문이면 처음 만든 작업을 그대로 돌려준다.
- 메시지 목록(`GET /conversations/:id/messages`)은 최신순으로 돌려준다.

### 2.3 `GET /v1/tasks/:id`

```ts
interface TaskDetail extends Omit<TaskSummary, 'pendingApproval'> {
  plan: { version: number; steps: PlanStep[]; revisedReason: string | null } | null;
  pendingApproval: ApprovalView | null;          // 대기 중이면 승인 카드 전체 데이터
  result: {
    messageId: string;
    verification: Array<{ label: string; passed: boolean }>; // W-04 "결과 검증"
    summary: { steps: number; toolCalls: number; retries: number; replans: number; durationMs: number };
    artifacts: ArtifactView[];
  } | null;
  lastEventId: string | null;  // SSE 재연결 기준
}
```

### 2.4 `POST /v1/tasks/:id/steer` · `/cancel` · `/resume`

```ts
// steer — 202. 다음 단계 Context 에 반영 (Agent 는 하나로 유지)
interface SteerRequest { text: string }

// cancel — 202. 현재 Tool 을 안전하게 끝낸 뒤 checkpoint 저장 후 cancelled
// resume — 202. failed · paused 상태에서만
interface ResumeRequest { mode: 'checkpoint' | 'restart' }
```

오류: `TASK_NOT_ACTIVE`(409), `TASK_NOT_RESUMABLE`(409), `CHECKPOINT_NOT_FOUND`(409).

### 2.5 `POST /v1/approvals/:id/decision`

```ts
interface ApprovalDecisionRequest {
  decision: 'approve' | 'reject';
  scope?: 'once' | 'task';     // task 는 allowTaskScope = true 일 때만
  comment?: string;            // 거절 · 수정 요청 내용 (W-03 입력창) → Planner 재계획 입력
}
// 200: ApprovalView
```

- `requiredApprover = user_and_operator` 이면 사용자 승인 후에도 `pending`(운영자 대기).
- 오류: `APPROVAL_EXPIRED`(410), `APPROVAL_ALREADY_RESOLVED`(409), `APPROVAL_SCOPE_NOT_ALLOWED`(422), `FORBIDDEN_APPROVER`(403).

### 2.6 `POST /v1/uploads`

```ts
interface CreateUploadRequest { fileName: string; mimeType: string; sizeBytes: number; sha256: string }
interface CreateUploadResponse { artifactId: string; uploadUrl: string; headers: Record<string, string>; expiresAt: string }
```

형식 · 크기는 `widget_configs.behavior.attachments` 로 검사(`ATTACHMENT_NOT_ALLOWED` 422). 완료 확인 전에는 메시지에 첨부할 수 없다.

---

## 3. SSE 이벤트

### 3.1 연결

| 항목 | 규칙 |
|---|---|
| Widget | `GET /v1/tasks/:id/events` — 작업 1개 구독 |
| Admin | `GET /v1/admin/stream` — 테넌트 전체 작업 · 승인 변경 구독 |
| 인증 | `Authorization` 헤더 사용을 위해 fetch 기반 클라이언트(`@microsoft/fetch-event-source`) 사용. 네이티브 `EventSource` 가 필요하면 `POST /v1/tasks/:id/events/ticket` 으로 30초 일회용 `?ticket=` 발급 |
| 형식 | `id: <task_events.id>` · `event: <type>` · `data: <JSON>` |
| keep-alive | 15초마다 `: ping` 주석, 30초마다 `heartbeat` 이벤트 |
| 재연결 | 클라이언트가 `Last-Event-ID` 를 보내면 `task_events` 에서 그 이후 이벤트를 먼저 재전송하고 실시간 구독(Redis Pub/Sub `task:{taskId}`)으로 넘어간다 |
| 토큰 스트림 | `message.delta` 는 저장하지 않는다(id 없음). 재연결 시 지금까지의 본문을 `message.snapshot` 으로 한 번 보낸다 |
| 종료 | `task.completed` · `task.failed` · `task.status(cancelled)` 후 서버가 스트림을 닫는다 |

NestJS: 컨트롤러에서 `@Sse()` 대신 `Response` 를 직접 쓰는 `SseStreamService` 로 구현한다(재전송 → 실시간 전환, `Last-Event-ID` 처리 때문).

### 3.2 작업 이벤트

| event | 시점 (Agent Loop) | data | UI 반영 |
|---|---|---|---|
| `task.status` | 상태 변경 | `{ status, reason? }` | 헤더 상태 · 배지 |
| `plan.created` | Plan | `{ planVersion, steps: PlanStep[] }` | 실행 계획 카드 |
| `plan.revised` | Evaluate → 재계획 | `{ planVersion, reason, steps: PlanStep[], diff: { added: number[]; removed: number[]; changed: number[] } }` | “계획 수정됨” 배지 |
| `step.started` | Execute | `{ seq, planIndex, type, name, parallelGroup? }` | 현재 단계 강조 |
| `step.completed` | Observe | `{ seq, planIndex, status, durationMs, summary, checkpointSaved }` | 단계 아이콘 · 진행률 |
| `tool.called` | Execute | `{ seq, executionId, toolName, source, argsPreview }` | Tool 칩 |
| `tool.result` | Observe | `{ seq, executionId, status, attempt, durationMs, resultPreview }` | Tool 칩 결과 · 재시도 표시 |
| `approval.required` | 권한 검증 | `{ approval: ApprovalView }` | 승인 카드 · 런처 뱃지 |
| `approval.resolved` | 승인 처리 | `{ approvalId, status, decidedBy: 'user' \| 'operator' }` | 카드 닫기 |
| `message.delta` | 응답 생성 | `{ messageId, text }` | 스트리밍 텍스트 |
| `message.snapshot` | 재연결 직후 | `{ messageId, text }` | 누적 본문 복원 |
| `message.completed` | 응답 완료 | `{ message: MessageView }` | 최종 메시지 |
| `task.completed` | Evaluate 성공 | `{ result: TaskDetail['result'] }` | 결과 · 산출물 카드 |
| `task.failed` | 한도 초과 | `{ code, message, resumable, lastCheckpoint: { seq, planIndex } \| null }` | 오류 + 재개 버튼 |
| `task.recovering` | Worker 장애 감지 | `{ reason, fromPlanIndex }` | “복구 중” 배지 |
| `heartbeat` | 30초 | `{ serverTime }` | 연결 상태 |

### 3.3 Admin 스트림 이벤트

| event | data |
|---|---|
| `task.updated` | `AdminTaskRow` (§4.3) |
| `approval.created` | `ApprovalView & { taskTitle: string; endUserPseudonym: string }` |
| `approval.resolved` | `{ approvalId, status }` |
| `tool.denied` | `{ taskId, toolName, reason }` — 무단 Tool 호출 즉시 알림 |

---

## 4. Admin API

### 4.1 대시보드 (C-01)

| Method | Path | 설명 |
|---|---|---|
| GET | `/v1/admin/metrics` | `?agentId&range=24h\|7d\|30d` 품질 지표 |
| GET | `/v1/admin/stream` | SSE (§3.3) |

```ts
interface Kpi { value: number; previous: number; target?: number; higherIsBetter: boolean; status: 'ok' | 'warn' }
interface MetricsResponse {
  range: '24h' | '7d' | '30d';
  lastAggregatedAt: string;
  kpis: {
    taskSuccessRate: Kpi;          // tasks_succeeded / tasks_total
    evalSuccessRate: Kpi | null;   // 고정 평가셋 최근 실행 (eval_runs)
    toolSuccessRate: Kpi;
    recoverySuccessRate: Kpi;
    humanInterventionRate: Kpi;
    unauthorizedToolCalls: Kpi;    // tool_denied 합계, target 0
    avgCostPerTask: Kpi & { currency: string };
    avgDurationMs: Kpi;
    tasksTotal: Kpi;
  };
  recentFailures: Array<{ taskId: string; title: string; failedStep: string; cause: FailureCause; recovery: string; at: string }>;
}
type FailureCause = 'tool_timeout' | 'schema_validation' | 'permission_denied' | 'sandbox_resource' | 'approval_rejected' | 'budget_exceeded' | 'model_error';
```

### 4.2 작업 (C-02)

| Method | Path | 설명 |
|---|---|---|
| GET | `/v1/admin/tasks` | `?status&agentId&endUserId&from&to&cursor` |
| GET | `/v1/admin/tasks/:id/trace` | 실행 트레이스 |
| GET | `/v1/admin/tasks/:id/steps/:stepId` | 단계 상세 (입력 · 출력 · 시도 · 샌드박스 · checkpoint) |
| POST | `/v1/admin/tasks/:id/pause` | 현재 단계 종료 후 일시정지 |
| POST | `/v1/admin/tasks/:id/cancel` | `{ reason }` 취소 |
| POST | `/v1/admin/tasks/:id/resume` | `{ fromStepId? }` 생략 시 마지막 checkpoint |

```ts
interface AdminTaskRow extends TaskSummary { agentName: string; endUserPseudonym: string; elapsedMs: number; workerId: string | null }

interface TaskTrace {
  task: AdminTaskRow & {
    agentVersion: number;
    registryVersion: number;       // 고정된 Tool Registry 버전
    traceId: string | null;
    usage: { inputTokens: number; outputTokens: number; byRole: Record<'planner' | 'executor' | 'evaluator', { inputTokens: number; outputTokens: number }> };
    cost: { amount: string; currency: string };
  };
  stats: { steps: { completed: number; total: number | null }; toolCalls: number; retries: number; replans: number };
  plans: Array<{ version: number; steps: PlanStep[]; reason: string | null; createdAt: string }>;
  steps: Array<{
    id: string; seq: number; planIndex: number | null;
    type: 'context' | 'plan' | 'reason' | 'tool' | 'skill' | 'evaluate' | 'respond';
    name: string; status: StepStatus; summary: string | null;
    parallelGroup: string | null; durationMs: number | null;
    checkpoint: { label: string; at: string } | null;  // "cp-4"
  }>;
  approvals: ApprovalView[];
}
```

### 4.3 대화 기록

| Method | Path | 설명 |
|---|---|---|
| GET | `/v1/admin/conversations` | `?agentId&endUserId&cursor` |
| GET | `/v1/admin/conversations/:id/messages` | 메시지 (C-02 “대화 보기”) |

### 4.4 Agent · 모델 (C-03)

| Method | Path | 권한 | 설명 |
|---|---|---|---|
| GET | `/v1/admin/agents` | Viewer | 목록 |
| POST | `/v1/admin/agents` | Admin | 생성 (초안 v1 함께 생성) |
| GET | `/v1/admin/agents/:id` | Viewer | 배포 버전 + 초안 |
| PATCH | `/v1/admin/agents/:id/draft` | Admin | 초안 수정 (자동 저장) |
| POST | `/v1/admin/agents/:id/eval-runs` | Admin | 테스트 실행 `{ target: 'draft' \| 'published', caseIds? }` → `EvalRun` |
| GET | `/v1/admin/eval-runs/:id` | Viewer | 테스트 결과 |
| POST | `/v1/admin/agents/:id/publish` | Admin | `{ changeNote? }` → 새 버전 배포 |
| GET | `/v1/admin/agents/:id/versions` | Viewer | 버전 기록 |
| GET | `/v1/admin/agents/:id/versions/:version/diff` | Viewer | `?against=<version\|draft>` |
| POST | `/v1/admin/agents/:id/versions/:version/rollback` | Admin | 해당 버전을 복사해 새 버전으로 배포 |
| GET | `/v1/admin/providers` | Viewer | LLM Provider 목록 |
| POST | `/v1/admin/providers` | Owner | `{ name, kind, baseUrl?, apiKey }` — apiKey 는 Vault 에 저장하고 응답에 포함하지 않음 |
| GET | `/v1/admin/providers/:id/models` | Viewer | 선택 가능한 모델 |

```ts
interface AgentDraftInput {
  name?: string;
  description?: string;
  welcomeMessage?: string;
  systemPrompt?: string;                 // 플랫폼 보안 지침은 별도로 앞에 붙고 수정 불가
  models?: Array<{ role: 'planner' | 'executor' | 'evaluator'; providerId: string; model: string; maxOutputTokens: number; temperature: number; fallback?: { providerId: string; model: string } }>;
  mcpServers?: Array<{ id: string; enabled: boolean }>;   // 오류 · 검토 대기 서버는 enabled=true 불가
  skills?: Array<{ id: string; enabled: boolean }>;
  executionPolicy?: Partial<ExecutionPolicy>;             // data-model.md §4.1
  memoryPolicy?: Partial<MemoryPolicy>;                   // data-model.md §4.2
}
```

배포 규칙: 초안 검증(모델 3역할 지정, 허용 목록의 서버 · Skill 이 활성 상태) 통과 시 `agent_versions.status = published`, `agents.published_version_id` 교체. 실행 중 작업은 영향 없음.

### 4.5 MCP · Tool Registry (C-04 · C-05)

| Method | Path | 설명 |
|---|---|---|
| GET | `/v1/admin/mcp-servers` | 목록 `?status&q` |
| POST | `/v1/admin/mcp-servers` | ① 연결 정보 저장 (status = draft) |
| GET | `/v1/admin/mcp-servers/:id` | 상세 · 헬스 |
| PATCH | `/v1/admin/mcp-servers/:id` | 연결 정보 수정 |
| POST | `/v1/admin/mcp-servers/:id/test` | 연결 테스트 |
| POST | `/v1/admin/mcp-servers/:id/discover` | ② Tool 탐색 · 검증 |
| PUT | `/v1/admin/mcp-servers/:id/tool-selection` | ③ 포함할 Tool · 등급 · 승인 재정의 |
| POST | `/v1/admin/mcp-servers/:id/register` | ④ 등록 → 새 Registry 버전 |
| GET | `/v1/admin/mcp-servers/:id/tools` | 등록된 Tool |
| PUT | `/v1/admin/mcp-tools/:id/policy` | `{ permissionLevel?, approvalModeOverride?, enabled? }` → 새 Registry 버전 |
| GET | `/v1/admin/mcp-servers/:id/changes` | 재탐색에서 감지된 변경 |
| POST | `/v1/admin/mcp-servers/:id/changes/approve` | `{ toolNames }` 변경 반영 → 새 Registry 버전 |
| POST | `/v1/admin/mcp-servers/:id/disable` | 비활성화 (Planner 에서 즉시 제외) |
| DELETE | `/v1/admin/mcp-servers/:id` | 삭제 (soft delete) |
| GET | `/v1/admin/tool-registry/versions` | Registry 버전 목록 |
| GET | `/v1/admin/tool-registry/versions/:version` | 스냅샷 |
| GET | `/v1/admin/tool-registry/versions/:version/diff` | `?from=<version>` |

```ts
interface CreateMcpServerRequest {
  name: string;                                   // ^[a-z0-9][a-z0-9-]{1,40}$  (Tool 이름 접두어)
  transport: 'streamable_http' | 'stdio_sandbox';
  endpointUrl?: string;                           // https 만 허용
  image?: string;                                 // repo@sha256:... (다이제스트 필수)
  authType: 'none' | 'api_key' | 'oauth';
  secret?: string;                                // write-only → Vault, 응답에 포함하지 않음
  allowedHosts: string[];
  allowPrivateNetwork?: boolean;                  // Owner 만 true 가능
}

interface ConnectionTestResult {
  handshake: 'ok' | 'failed';
  protocolVersion: string | null;
  latencyMs: number | null;
  ssrf: { resolvedIps: string[]; allowed: boolean; blockedReason?: 'private_ip' | 'link_local' | 'metadata' | 'host_not_allowed' };
  imageSignature?: 'verified' | 'unsigned' | 'invalid';
  error?: string;
}

interface DiscoveredTool {
  name: string;
  description: string | null;
  schema: { result: 'valid' | 'warning' | 'error'; issues: string[] };
  security: { result: 'passed' | 'warning' | 'failed'; issues: string[] }; // 설명 속 지시문, 대량 개인정보 반출 등
  suggestedLevel: PermissionLevel;
  defaultInclude: boolean;                         // 스키마 오류 · 보안 경고면 false
}
```

### 4.6 Skill (C-06)

| Method | Path | 설명 |
|---|---|---|
| GET | `/v1/admin/skills` | 목록 `?status&q` |
| POST | `/v1/admin/skills` | `multipart/form-data` zip 업로드 (최대 20MB) → 검증 잡 시작, `202` |
| POST | `/v1/admin/skills/git` | `{ repoUrl, ref, path? }` (태그 · 커밋 고정) → `202` |
| GET | `/v1/admin/skills/:id` | 상세 |
| GET | `/v1/admin/skills/:id/versions` | 버전 목록 |
| GET | `/v1/admin/skills/:id/versions/:versionId` | metadata · 파일 트리 · 검증 결과 |
| GET | `/v1/admin/skills/:id/versions/:versionId/files/*path` | 파일 내용 (텍스트, 1MB 이하) |
| GET | `/v1/admin/skills/:id/versions/:versionId/diff` | `?against=<versionId>` |
| POST | `/v1/admin/skills/:id/versions/:versionId/activate` | 활성 버전 변경 → 새 Registry 버전 (검증 통과 버전만) |
| POST | `/v1/admin/skills/:id/disable` | 비활성화 |
| POST | `/v1/admin/skills/:id/test-runs` | `{ prompt }` → 선택 여부 · 실행 결과 |

검증 항목(`skill_versions.verification`): `source` · `hash` · `signature` · `script_static` · `instruction_risk` · `tool_scope`. 하나라도 `failed` 면 활성화 불가(`SKILL_VERIFICATION_FAILED` 422).

### 4.7 승인 · 권한 정책 (C-07)

| Method | Path | 권한 | 설명 |
|---|---|---|---|
| GET | `/v1/admin/approvals` | Viewer | `?status=pending&cursor` 위험도 · 만료 순 |
| POST | `/v1/admin/approvals/:id/decision` | Operator | `{ decision, comment }` (comment 필수) 대리 승인 · 거절 |
| GET | `/v1/admin/approvals/history` | Viewer | 처리 이력 (감사 로그 필터) |
| GET | `/v1/admin/tool-policies` | Viewer | 등급별 기본 정책 |
| PUT | `/v1/admin/tool-policies` | Admin | 전체 교체 |
| GET | `/v1/admin/tool-policy-rules` | Viewer | 조건 규칙 |
| POST | `/v1/admin/tool-policy-rules` | Admin | 생성 |
| PATCH | `/v1/admin/tool-policy-rules/:id` | Admin | 수정 |
| DELETE | `/v1/admin/tool-policy-rules/:id` | Admin | 삭제 |

```ts
interface ToolPolicyInput {
  level: PermissionLevel;
  mode: 'auto' | 'require_approval' | 'always_approval' | 'block';
  approver?: 'user' | 'operator' | 'user_and_operator';
  allowTaskScope: boolean;      // delete · financial 은 false 고정
  ttlSeconds: number;           // 60 ~ 86400
}

interface ToolPolicyRuleInput {
  name: string;
  toolPattern?: string;         // "payment.refund", "google-drive.*"
  level?: PermissionLevel;
  condition: RuleCondition;     // data-model.md §4.4
  effect: 'require_operator' | 'block';
  priority?: number;
  enabled?: boolean;
}
```

정책 적용 시점: 강화(승인 추가 · 차단)는 실행 중 작업에도 즉시, 완화는 새 작업부터.

### 4.8 Memory (C-08)

| Method | Path | 권한 | 설명 |
|---|---|---|---|
| GET | `/v1/admin/memories/search` | Viewer | `?agentId&q&mode=semantic\|keyword&type&scope&endUserId&limit` |
| GET | `/v1/admin/memories` | Viewer | `?status=quarantined&cursor` 격리 항목 |
| GET | `/v1/admin/memories/:id` | Viewer | 상세 · 출처 |
| PATCH | `/v1/admin/memories/:id` | Admin | `{ title?, content? }` → 재임베딩 |
| POST | `/v1/admin/memories/:id/pin` | Admin | `{ pinned }` 만료 제외 |
| POST | `/v1/admin/memories/:id/release` | Admin | 격리 해제 |
| DELETE | `/v1/admin/memories/:id` | Admin | 삭제 |
| POST | `/v1/admin/end-users/:id/erase` | Admin | 사용자 데이터 삭제 (`202`, 잡) |

```ts
interface MemorySearchHit {
  id: string;
  type: 'episodic' | 'semantic' | 'procedural';
  scope: 'user' | 'agent';
  score: number;                // semantic: 1 - cosine distance, keyword: trigram similarity
  title: string | null;
  content: string;
  needsVerification: boolean;
  source: { type: 'user_message' | 'tool_result' | 'external_document' | 'reflection' | 'manual'; taskIds: string[]; conversationId: string | null };
  useCount: number;
  lastUsedAt: string | null;
  expiresAt: string | null;
}
```

검색은 Agent 의 Context 구성과 **같은 쿼리 경로**(`MemoryRetriever`)를 사용해, 운영자가 “Agent 가 실제로 무엇을 떠올릴지” 재현할 수 있게 한다.

```sql
-- MemoryRetriever (semantic). $1 = query embedding
SELECT id, type, scope, content, 1 - (embedding <=> $1) AS score
FROM memories
WHERE agent_id = $2 AND status = 'active'
  AND (scope = 'agent' OR end_user_id = $3)
ORDER BY embedding <=> $1
LIMIT $4;
```

### 4.9 Widget (C-09)

| Method | Path | 권한 | 설명 |
|---|---|---|---|
| GET | `/v1/admin/widget-configs` | Viewer | 목록 |
| POST | `/v1/admin/widget-configs` | Admin | 생성 → 공개 키 · Secret(1회 표시) 발급 |
| GET | `/v1/admin/widget-configs/:id` | Viewer | 상세 (Secret 제외) |
| PATCH | `/v1/admin/widget-configs/:id` | Admin | 허용 도메인 · 사용자 연동 · 테마 · 동작 |
| POST | `/v1/admin/widget-configs/:id/rotate-secret` | Owner | 새 Secret(1회 표시), 이전 Secret 24시간 유예 |

```ts
interface WidgetConfigInput {
  agentId?: string;
  allowedOrigins?: string[];        // https://host[:port], 와일드카드는 서브도메인 1단계만 (https://*.example.com)
  identityMode?: 'anonymous' | 'signed_token';
  theme?: { brandColor: string; position: 'bottom-right' | 'bottom-left'; darkMode: 'system' | 'light' | 'dark' };
  behavior?: { autoOpen: boolean; language: string; attachments: { types: string[]; maxMb: number }; noticeText: string; showPoweredBy: boolean };
}
// 응답에 contrast: { ratio: number; passes: boolean } 포함 (브랜드 색 vs 흰 글자, 4.5:1 기준)
```

### 4.10 감사 로그

| Method | Path | 설명 |
|---|---|---|
| GET | `/v1/admin/audit-logs` | `?action&actorType&targetType&targetId&from&to&cursor` |

---

## 5. 오류

```json
{
  "type": "urn:theoneai:problem:approval-expired",
  "title": "승인 기한이 지났습니다",
  "status": 410,
  "code": "APPROVAL_EXPIRED",
  "detail": "작업이 일시정지되었습니다. 작업 목록에서 재개할 수 있습니다.",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

| code | HTTP | 의미 | 화면 처리 |
|---|---|---|---|
| `VALIDATION_FAILED` | 400 | DTO 검증 실패 (`errors[]` 에 필드별 사유) | 필드 오류 표시 |
| `UNAUTHENTICATED` | 401 | 토큰 없음 · 만료 | 위젯: bootstrap 재호출 / 콘솔: refresh |
| `IDENTITY_TOKEN_INVALID` | 401 | 서명 · aud · exp 불일치 | 위젯 미노출, 콘솔 경고 로그 |
| `FORBIDDEN` | 403 | 역할 권한 없음 | 버튼 숨김 (방어적 처리) |
| `ORIGIN_NOT_ALLOWED` | 403 | 허용 도메인 아님 | 위젯 미노출 |
| `TOOL_NOT_ALLOWED` | 403 | 허용 목록 · 정책상 실행 불가 (내부적으로 `tool_executions.status = denied`) | Agent 가 대안 계획 |
| `NOT_FOUND` | 404 | 없거나 다른 테넌트 (RLS 로 구분 불가 — 항상 404) | |
| `TASK_ALREADY_ACTIVE` | 409 | 같은 대화에 실행 중 작업 | steer 로 전환 |
| `TASK_NOT_ACTIVE` | 409 | 이미 끝난 작업에 steer · cancel | 상태 새로고침 |
| `TASK_NOT_RESUMABLE` | 409 | failed · paused 가 아님 | |
| `CHECKPOINT_NOT_FOUND` | 409 | 재개할 checkpoint 없음 | “처음부터”만 노출 |
| `APPROVAL_ALREADY_RESOLVED` | 409 | 이미 처리됨 | 카드 갱신 |
| `IDEMPOTENCY_KEY_REUSED` | 409 | 같은 키, 다른 본문 | |
| `APPROVAL_EXPIRED` | 410 | 승인 만료 | W-05 재개 안내 |
| `REGISTRY_CHANGED` | 409 | 검토 중 다른 변경으로 Registry 가 바뀜 | 변경 다시 검토 |
| `APPROVAL_SCOPE_NOT_ALLOWED` | 422 | 범위 승인 불가 등급 | |
| `ATTACHMENT_NOT_ALLOWED` | 422 | 형식 · 크기 위반 | 입력창 오류 |
| `MCP_SSRF_BLOCKED` | 422 | 사설 · 메타데이터 IP, 허용 호스트 밖 | C-05 ① 오류 |
| `MCP_HANDSHAKE_FAILED` | 422 | initialize 실패 | C-05 ① 오류 |
| `MCP_IMAGE_UNSIGNED` | 422 | 이미지 서명 없음 · 불일치 | C-05 ① 오류 |
| `SKILL_PARSE_FAILED` | 422 | SKILL.md 파싱 실패 (`errors[].line`) | C-06 미리보기 |
| `SKILL_VERIFICATION_FAILED` | 422 | 신뢰 검증 실패 | 활성화 버튼 비활성 |
| `AGENT_DRAFT_INVALID` | 422 | 배포 전 검증 실패 | 섹션별 오류 |

`task.failed` 의 `code` (HTTP 오류가 아니라 작업 실패 사유):

| code | 의미 |
|---|---|
| `MODEL_NOT_CONFIGURED` | 역할별 모델 설정이 없거나 provider API Key(`secret_ref`)를 찾을 수 없음 |
| `MODEL_AUTH_FAILED` | provider 인증 실패 (API Key 확인) |
| `MODEL_RATE_LIMITED` | provider 호출 한도 초과 (재시도 · 대체 모델 후에도) |
| `MODEL_TIMEOUT` | 응답 시간 초과 (`LLM_REQUEST_TIMEOUT_MS` · `LLM_IDLE_TIMEOUT_MS`) |
| `MODEL_ERROR` | 그 밖의 provider 오류 (재시도 · 대체 모델 후에도) |
| `MODEL_EMPTY_RESPONSE` | 모델이 빈 결과를 돌려줌 |
| `STEP_LIMIT_EXCEEDED` · `TOKEN_BUDGET_EXCEEDED` · `TIME_LIMIT_EXCEEDED` | 실행 정책(`execution_policy`) 한도 초과 |
| `QUEUE_UNAVAILABLE` · `RUNTIME_ERROR` | 작업 큐 등록 실패 · 그 밖의 내부 오류 |
| `AGENT_NOT_PUBLISHED` | 503 | 배포된 Agent 버전 없음 | 위젯 “준비 중” 표시 |
| `RATE_LIMITED` | 429 | 요청 제한 | 재시도 안내 |
| `SERVICE_UNAVAILABLE` | 503 | 작업 큐 등 내부 의존성 장애 (작업은 `failed · QUEUE_UNAVAILABLE`) | 잠시 후 재시도 |

---

## 6. 비동기 실행 (BullMQ)

HTTP 요청은 작업을 만들고 큐에 넣을 뿐, Agent 를 직접 실행하지 않는다.

```
POST /conversations/:id/messages
  └─ TX: messages INSERT · tasks INSERT(queued, agent_version_id, registry_version_id 고정)
  └─ commit 후 queue.add('run', { tenantId, taskId, mode: 'start' }, { jobId: taskId })   → 202

agent.worker (queue: agent-tasks)
  1. forTenant(tenantId) · tasks 잠금(SELECT … FOR UPDATE SKIP LOCKED) · status = running
  2. checkpoint 로드 (재개면 last_checkpoint_step_id, 아니면 빈 상태)
  3. Context 구성 (지침 + Memory 검색 + Skill metadata + 대화 + 추가 지시)
  4. Plan 생성/재사용 → plan.created
  5. 단계마다:
       권한 검증 (allowlist → 등급 정책 → Tool 재정의 → 조건 규칙)
         ├ block           → tool_executions(denied) · tool.denied → 재계획
         ├ 승인 필요        → approvals INSERT · approval.required · status = waiting_approval · Job 종료 (Worker 점유 안 함)
         └ 허용            → 실행 (MCP · Sandbox · Skill) → tool.called / tool.result
       Observe → Evaluate(pass / replan / fail) → task_steps checkpoint 저장 → step.completed
       cancel_requested_at · pause_requested_at 확인 (단계 사이 + AbortSignal 로 Tool 호출 중단)
  6. 최종 응답 생성(message.delta …) → Evaluator 검증 → task.completed
  7. memory-ingest 잡 등록 (Reflection → Episodic · Procedural 기억)

승인 결정 / 재개 / 복구 → 같은 큐에 { mode: 'resume', fromStepId? } 로 다시 넣는다.
```

| 큐 | 트리거 | 동작 |
|---|---|---|
| `agent-tasks` | 메시지 · 승인 결정 · 재개 | Agent Loop 실행. BullMQ `attempts: 1` — 재시도는 Loop 안에서 단계 단위로 처리 |
| `agent-recovery` | 1분 주기 | `app_find_stalled_tasks('60 seconds')` → `recovering` 으로 바꾸고 `mode: 'resume'` 재투입 (복구 한도 3회) |
| `approval-expiry` | 1분 주기 | 만료 승인 → `expired`, 작업 `paused` + checkpoint 유지 |
| `memory-ingest` | 작업 완료 | Reflection 요약 · 임베딩 · 지시문 패턴 검사 후 저장 또는 격리 |
| `mcp-sync` | 서버별 1시간 | 재탐색 → 변경이 있으면 `mcp_tools.pending_change` 기록 · 헬스 갱신 |
| `skill-verify` | 업로드 · Git 등록 | 파싱 · 해시 · 서명 · 정적 검사 → `skill_versions.verification` |
| `eval-runs` | C-03 테스트 실행 | 평가셋 실행 (실제 외부 쓰기 Tool 은 dry-run) |
| `metrics-rollup` | 5분 주기 | `metrics_daily` 갱신 |
| `retention` | 매일 | `task_events` · 만료 Memory · Artifact 정리 |

- Worker heartbeat: 실행 중 15초마다 `tasks.last_heartbeat_at` 갱신. 60초 이상 끊기면 복구 대상.
- 병렬 Tool 실행: 같은 단계 안에서 읽기 등급 Tool 만 `Promise.allSettled` (최대 `parallelTools.max`). Agent 는 하나.
- 이벤트 발행: `TaskEventsService.emit()` → `task_events` INSERT 후 Redis `PUBLISH task:{taskId}` (delta 는 PUBLISH 만).

---

## 7. NestJS 모듈 구성

기획안 4장의 폴더 구조를 기준으로, 화면 · API 에 필요한 모듈을 더했다(★).

| 모듈 | 컨트롤러 (경로) | 주요 서비스 |
|---|---|---|
| `auth` | `admin/auth` | `AdminAuthService`, `JwtStrategy`, `RolesGuard` |
| ★ `widget` | `widget` | `WidgetBootstrapService`, `IdentityTokenVerifier`, `OriginGuard` |
| `tenants` | — | `TenantContextInterceptor`, `forTenant()` |
| `users` | `admin/members` (2차) | `MembersService` |
| `agents` | `admin/agents`, `admin/eval-runs` | `AgentsService`, `AgentDraftService`, `AgentPublishService` |
| `providers` | `admin/providers` | `ProvidersService`, `LlmClientFactory` |
| `conversations` · `messages` | `conversations`, `admin/conversations` | `ConversationsService`, `MessagesService` |
| `tasks` | `tasks`, `admin/tasks` | `TasksService`, `TaskControlService`(pause · cancel · resume · steer) |
| ★ `events` | `tasks/:id/events`, `admin/stream` | `TaskEventsService`, `SseStreamService` |
| `agent-runtime` | — | `AgentLoopService`, `ContextService`, `ExecutionService` |
| `planner` · `evaluator` | — | `PlannerService`, `EvaluatorService`(Reflection) |
| `tools` | `admin/tool-registry` | `ToolRegistryService`, `ToolDispatcherService`, `ToolPermissionService` |
| `mcp` | `admin/mcp-servers`, `admin/mcp-tools` | `McpManagerService`, `McpConnectionService`, `McpDiscoveryService`, `SsrfGuard` |
| `skills` | `admin/skills` | `SkillLoaderService`, `SkillParserService`, `SkillSelectorService`, `SkillVerifierService` |
| `memory` | `admin/memories`, `admin/end-users` | `MemoryRetriever`, `MemoryIngestService`, `EmbeddingService` |
| `approvals` | `approvals`, `admin/approvals`, `admin/tool-policies`, `admin/tool-policy-rules` | `ApprovalsService`, `PolicyEvaluator` |
| `artifacts` | `uploads`, `artifacts`, `tasks/:id/artifacts` | `ArtifactsService`, `StorageService`(S3 presign) |
| ★ `metrics` | `admin/metrics` | `MetricsService`, `MetricsRollupProcessor` |
| ★ `audit` | `admin/audit-logs` | `AuditInterceptor`, `AuditService` |
| `workers` | — | `agent.worker.ts`, `recovery.worker.ts`, 기타 §6 Processor |
| `infrastructure` | — | `PrismaService`, `RedisService`, `StorageService`, `SandboxService`(Docker), `VaultService` |

---

## 8. 화면 ↔ API 매핑

| 화면 | API |
|---|---|
| W-01 위젯 홈 | `POST /widget/bootstrap` · `POST /conversations` · `POST /uploads` |
| W-02 대화 · 실행 | `POST /conversations/:id/messages` · `GET /tasks/:id` · `GET /tasks/:id/events` · `POST /tasks/:id/steer` · `POST /tasks/:id/cancel` |
| W-03 승인 요청 | SSE `approval.required` · `POST /approvals/:id/decision` |
| W-04 결과 · 산출물 | SSE `task.completed` · `GET /tasks/:id/artifacts` · `GET /artifacts/:id/download` · `POST /tasks/:id/feedback` |
| W-05 작업 목록 · 복구 | `GET /tasks?group=` · `POST /tasks/:id/resume` · SSE 재연결(`Last-Event-ID`) |
| C-01 대시보드 | `GET /admin/metrics` · `GET /admin/stream` · `GET /admin/approvals?status=pending` |
| C-02 작업 상세 | `GET /admin/tasks/:id/trace` · `GET /admin/tasks/:id/steps/:stepId` · `POST /admin/tasks/:id/pause\|cancel\|resume` |
| C-03 Agent 설정 | `GET /admin/agents/:id` · `PATCH /admin/agents/:id/draft` · `POST /admin/agents/:id/eval-runs` · `POST /admin/agents/:id/publish` · `GET /admin/providers/:id/models` |
| C-04 MCP 서버 | `GET /admin/mcp-servers` · `GET /admin/mcp-servers/:id/tools` · `PUT /admin/mcp-tools/:id/policy` · `GET\|POST /admin/mcp-servers/:id/changes` · `GET /admin/tool-registry/versions` |
| C-05 MCP 연결 | `POST /admin/mcp-servers` · `POST …/test` · `POST …/discover` · `PUT …/tool-selection` · `POST …/register` |
| C-06 Skill | `GET /admin/skills` · `POST /admin/skills` · `POST /admin/skills/git` · `GET …/versions/:versionId` · `POST …/activate` · `POST …/test-runs` |
| C-07 승인 · 정책 | `GET /admin/approvals` · `POST /admin/approvals/:id/decision` · `PUT /admin/tool-policies` · `/admin/tool-policy-rules` |
| C-08 Memory | `GET /admin/memories/search` · `PATCH\|DELETE /admin/memories/:id` · `POST /admin/end-users/:id/erase` |
| C-09 Widget 설치 | `GET\|PATCH /admin/widget-configs/:id` · `POST /admin/widget-configs/:id/rotate-secret` |
