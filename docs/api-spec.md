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
  kind: 'reason' | 'tool' | 'skill' | 'respond'; // reason = Tool 없이 분석 · 초안 작성, tool = Tool 을 써서 조회 · 실행
  toolName?: string;           // "sales-db.query" — tool 단계가 주로 쓸 Tool (Registry 이름). 단계 안에서 다른 Tool 을 함께 부를 수 있다
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
  waitingFor: 'user' | 'operator' | 'user_and_operator' | null; // 대기 중일 때 남은 승인자 (user_and_operator 의 한쪽이 승인했으면 다른 쪽)
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
- 구현 상태: login · me · 역할 가드 · 감사 로그. access token 서명 키는 `ADMIN_SESSION_PRIVATE_KEY`(위젯 키와 별도). 비밀번호는 scrypt, 계정이 없어도 같은 비용으로 비교하고 실패 응답은 하나(“워크스페이스 · 이메일 · 비밀번호를 확인해 주세요”). 토큰이 유효해도 매 요청 멤버 상태 · 역할을 DB 에서 다시 확인한다. refresh 쿠키 회전 · 로그아웃은 콘솔 UI 단계.

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
    correctionMessageId?: string; // Reflection — 검증에서 나온 오류를 바로잡은 후속 메시지 (있을 때)
    verification: Array<{ label: string; passed: boolean }>; // W-04 "결과 검증" (정정했으면 정정 후 검증)
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

구현 메모 (7 · 8단계)

| 항목 | 동작 |
|---|---|
| steer | `messages` 에 `task_id` 를 붙여 저장하고 `task.steered` 이벤트. Agent Loop 가 다음 작업 단계 · 답변 직전에 아직 반영하지 않은 지시를 요청 뒤에 붙인다(`task.steer_applied`). 반영 위치는 checkpoint 의 `workingMemory.steerCursor` 로 남는다. 대기 · 실행 · 승인 대기 · 복구 · 일시정지 상태에서 받는다 |
| resume | `checkpoint`(기본): 마지막 checkpoint(콘솔은 `fromStepId` 지정 가능)의 계획 · 작업 노트 · 다음 단계에서 이어 간다 — 끝난 단계는 다시 하지 않고, 답변까지 보낸 뒤 멈췄으면 검증만 한다(`task.resumed`). `restart`: 계획부터 다시(단계 기록은 유지). 같은 대화에 진행 중인 작업이 있으면 `TASK_ALREADY_ACTIVE` |
| cancel · pause | 대기 · 승인 대기 · 일시정지 중이면 바로, 실행 · 복구 중이면 Worker 가 현재 단계를 끝낸 뒤 처리한다. 일시정지는 콘솔(§4.2)에서 |
| 토큰 | 실패 · 중지 · 일시정지 · Worker 종료 때도 그 실행의 토큰을 작업 합계에 더하고, 토큰 예산은 작업 전체(이전 실행 포함) 기준이다 |

### 2.5 `POST /v1/approvals/:id/decision`

```ts
interface ApprovalDecisionRequest {
  decision: 'approve' | 'reject';
  scope?: 'once' | 'task';     // task 는 allowTaskScope = true 일 때만
  comment?: string;            // 거절 · 수정 요청 내용 (W-03 입력창) → Planner 재계획 입력
}
// 200: ApprovalView
```

- `requiredApprover = user_and_operator` 이면 사용자 승인 후에도 `pending`(운영자 대기, `approval.updated` 이벤트). 어느 쪽이든 거절하면 바로 `rejected`.
- 오류: `APPROVAL_EXPIRED`(410), `APPROVAL_ALREADY_RESOLVED`(409), `APPROVAL_SCOPE_NOT_ALLOWED`(422), `FORBIDDEN_APPROVER`(403).

구현 메모:

- **승인 요청**: 작업 단계에서 모델이 승인 필요 Tool 을 부르면, Dispatcher 가 인자를 검증하고 권한 판단(차단 → 단계 범위 → 승인 필요) 뒤 `approvals` 를 만들고 `approval.required` 를 보낸다. 작업 단계는 진행 중이던 대화(모델의 Tool 호출 · 이미 끝난 호출 결과)를 checkpoint 의 `workingMemory.pendingWork` 에 남기고 `waiting_approval` 로 멈춘다. 작업은 `waiting_approval`, Worker 를 놓는다. 한 응답에 여러 호출이 있으면 승인이 필요 없는 앞 호출은 먼저 실행하고 결과를 함께 남긴다.
- **결정 후 재개**: 작업에 대기 중인 승인이 더 없으면 `queued` 로 바꾸고 재개 Job 을 넣는다. 재개하면 모델을 다시 부르지 않고 멈춘 호출부터 이어 간다 — 승인한 인자 그대로 실행된다(인자 해시 확인). `once` 승인은 실행에 한 번만 쓰이고(`consumed_at`), `task` 범위 승인은 같은 Tool 의 이후 호출(같은 승인자 요구, 조건 규칙에 걸리지 않은 호출)을 묻지 않는다.
- **거절**: 실행하지 않고(`tool.denied` · `approval_rejected`) 모델에게 거절과 사유(데이터로)를 알린다. 모델은 다른 방법을 찾거나 사유에 맞게 고친 호출(새 승인)을 하거나 답변에서 밝힌다. 사유가 수정을 요구하는데 반영되지 않았으면 Evaluator 가 재계획한다.
- **경쟁**: 결정 · 만료 · 중지와 Worker 의 `waiting_approval` 전환은 모두 작업 행을 먼저 잠근다. Worker 가 멈추기 직전에 결정이 나면 Worker 가 대기 승인이 없음을 보고 바로 다시 큐에 넣는다.
- **중지**: 대기 중인 승인은 `cancelled` (`approval.resolved`, `decidedBy: 'system'`).

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
| `tool.result` | Observe | `{ seq, executionId, toolName, status, attempt, durationMs, resultPreview }` — `status`: `succeeded` · `failed` · `timeout`, `attempt`: 시도 횟수(멱등 Tool 재시도 포함) | Tool 칩 결과 · 재시도 표시 |
| `tool.denied` | 권한 검증 | `{ seq, executionId, toolName, reason: DeniedReason, message }` | Tool 칩 “거부됨” |
| `approval.required` | 권한 검증 | `{ approval: ApprovalView }` | 승인 카드 · 런처 뱃지 |
| `approval.updated` | user_and_operator 의 한쪽 승인 | `{ approval: ApprovalView }` (`waitingFor` 갱신) | “운영자 확인 대기” 표시 |
| `approval.resolved` | 승인 처리 · 만료 · 중지 | `{ approvalId, status, decidedBy: 'user' \| 'operator' \| 'system' }` | 카드 닫기 |
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

`DeniedReason`

| 값 | 의미 | 무단 호출 지표 |
|---|---|---|
| `unknown_tool` | 작업이 고정한 Registry 버전에 없는 Tool (또는 실행 구현이 없는 Tool) | 포함 |
| `blocked_by_policy` | 등급 정책 · Tool 재정의가 `block` | 포함 |
| `blocked_by_rule` | 조건 규칙(`tool_policy_rules`, effect `block`)에 걸림. `tool_executions.output.matchedRuleIds` 에 규칙 기록 | 포함 |
| `not_allowed` | 이 단계에서 모델에게 주지 않은 Tool — Agent 허용 목록(`agent_version_mcp_servers`)에 없는 MCP 서버의 Tool, Skill 단계의 `allowed-tools` 밖 Tool, 일반 단계의 Skill 전용 Tool | 포함 |
| `approval_rejected` | 승인 요청을 사용자 · 운영자가 거절함 (승인 대기 자체는 거부가 아니라 `waiting_approval`) | 제외 |
| `tool_unavailable` | 작업 중에 MCP 서버가 오류 · 비활성 · 삭제 상태가 되었거나 운영자가 Tool 을 껐음 | 제외 |

거부 · 인자 오류(`INVALID_ARGUMENTS`) · 실행 오류(`TOOL_ERROR`) · 시간 초과(`TOOL_TIMEOUT`)는 모두 `tool_executions` 에 남고, 작업을 실패시키지 않고 모델에게 `{ ok: false, error, message }` 로 돌려준다. 모델이 인자를 고치거나 다른 방법을 찾거나, 답변에서 한계를 밝힌다.

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

구현 상태: `GET /admin/agents` · `GET /admin/agents/:id`(배포 버전 · 초안) · `PATCH …/draft` · `POST …/publish`. 초안이 없으면 배포 버전(모델 설정 · Skill · MCP 허용 목록 포함)을 복사해 만든다. 지금 초안에서 받는 필드는 `mcpServers` 뿐이고 다른 필드는 400 으로 거부한다. 배포 시 executor 모델과 허용 서버가 `connected` 인지 확인하고, 이전 배포 버전은 `archived`.

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
  defaultInclude: boolean;                         // 스키마 오류 · 보안 경고 · 삭제 · 금전 등급이면 false
}
```

구현 메모 (5단계)

| 항목 | 동작 |
|---|---|
| 연결 | Streamable HTTP (공식 TypeScript SDK v2 `@modelcontextprotocol/client`). `stdio_sandbox` 는 `MCP_TRANSPORT_UNSUPPORTED`, `oauth` 는 `MCP_AUTH_UNSUPPORTED` (Sandbox 단계). API Key 는 `Authorization: Bearer` 로 보낸다 |
| 프로토콜 버전 | `versionNegotiation: 'auto'` — `server/discover` 로 2026-07-28 을 먼저 확인하고, 2025 계열 서버면 `initialize` 핸드셰이크로 내려간다(왕복 1회 추가). 401 · 403 은 버전 근거로 쓰지 않고 인증 실패로 알린다. 협상 결과는 `mcp_servers.protocol_version` 에 남기고, 2025 계열로 기록된 서버는 Worker 의 재사용 연결에서 탐색을 건너뛴다(`prior: legacy`, 재탐색이 매시간 갱신). 연결 테스트 응답에 `era: 'modern' \| 'legacy'` |
| SSRF | https 만(개발 `MCP_ALLOW_INSECURE_HTTP`). 요청마다 스킴 · 호스트(엔드포인트 + `allowedHosts`) 검사, 소켓 연결 시점에 DNS 해석 결과 전부 검사(DNS rebinding 대응), 리다이렉트는 같은 origin 만. 사설 · 루프백 · 링크로컬은 `allowPrivateNetwork`(Owner 만)일 때만, 클라우드 메타데이터 IP 는 항상 차단 |
| 연결 테스트 | 실패해도 200 + `handshake: 'failed'`(화면이 원인 표시). 탐색 실패는 422 `MCP_SSRF_BLOCKED` · `MCP_HANDSHAKE_FAILED` |
| 탐색 | 등록 전 서버(draft · pending_review · disabled): 결과를 바로 반영(운영자가 고른 포함 여부 · 등급 유지) → `pending_review`. 등록된 서버(connected · error): 차이를 `mcp_tools.pending_change` 로만 기록 → `changes` 응답 |
| 보안 검사 | 설명 · 제목 · 파라미터 설명 · enum 속 숨은 지시문(“이전 지시 무시”, `<IMPORTANT>`, “다른 Tool 전에”, 자격 증명 반출 등) · 보이지 않는 문자(제로폭 · 방향 제어 · 태그 문자) → `failed`(포함 불가). 외부 URL · 민감정보 인자 · 대량 반출 징후 → `warning`(기본 제외, 운영자가 선택 가능) |
| 제안 등급 | 이름 · 설명 키워드와 서버 annotations(`readOnlyHint` · `destructiveHint`) 중 더 엄격한 쪽. annotations 만으로 위험한 이름을 read 로 낮추지 않는다 |
| 등록 | `pending_review` 에서만, 포함 Tool 1개 이상 → `connected` · `trust = verified` → 새 Registry 버전 |
| 변경 승인 | added → 정의 반영 후 **꺼진 채** 추가(운영자가 Tool 정책에서 켬), changed → 정의 반영(스키마 오류 · 보안 실패면 끔), removed → `removed`. 승인 전까지 실행은 Registry 에 고정된 이전 정의를 쓴다 |
| 연결 정보 수정 | 등록된 서버의 엔드포인트 · 인증 · 허용 호스트 · 사설망 설정이 바뀌면 `pending_review` 로 돌아가고 Tool 이 Registry 에서 빠진다 (탐색 → 등록 다시) |
| 비활성화 · 삭제 | 새 Registry 버전에서 빠지고, 실행 중 작업도 다음 호출부터 `tool_unavailable`. 삭제는 soft delete + Secret 삭제 + 이름 재사용 가능 |
| 응답 · 오류 | `tools/call` 결과는 `structuredContent` 우선, 없으면 텍스트(JSON 이면 파싱). 이미지 · 오디오는 형식만. `isError` 와 서버의 JSON-RPC 오류(`ProtocolError`, 예: 모르는 Tool)는 `TOOL_ERROR` 로 모델에게 알리고 재시도하지 않는다(연결 유지). 인자는 Registry 에 고정된 JSON Schema 로 먼저 검증(Ajv) — 틀리면 서버로 보내지 않는다. 호출 시 고정된 정의를 `toolDefinition` 으로 넘겨 재사용 연결에서 `tools/list` 를 다시 부르지 않는다 |

### 4.6 Skill (C-06)

| Method | Path | 설명 |
|---|---|---|
| GET | `/v1/admin/skills` | 목록 `?status&q` |
| POST | `/v1/admin/skills` | `multipart/form-data` (`file` = zip, 최대 20MB) → 번들 · SKILL.md 검사 · 신뢰 검증 → `201` (구현: 검증을 요청 안에서 끝내고 결과를 바로 돌려준다) |
| POST | `/v1/admin/skills/git` | `{ repoUrl, ref, path? }` (태그 · 커밋 고정) → `202` |
| GET | `/v1/admin/skills/:id` | 상세 |
| GET | `/v1/admin/skills/:id/versions` | 버전 목록 |
| GET | `/v1/admin/skills/:id/versions/:versionId` | metadata · 파일 트리 · 검증 결과 |
| GET | `/v1/admin/skills/:id/versions/:versionId/file?path=` | 파일 내용 (텍스트, 1MB 이하) |
| GET | `/v1/admin/skills/:id/versions/:versionId/diff` | `?against=<versionId>` |
| POST | `/v1/admin/skills/:id/versions/:versionId/activate` | 활성 버전 변경 → 새 Registry 버전 (검증 통과 버전만) |
| POST | `/v1/admin/skills/:id/disable` | 비활성화 |
| POST | `/v1/admin/skills/:id/test-runs` | `{ prompt }` → 선택 여부 · 실행 결과 |

검증 항목(`skill_versions.verification`): `source` · `hash` · `signature` · `script_static` · `instruction_risk` · `tool_scope`. 하나라도 `failed` 면 활성화 불가(`SKILL_VERIFICATION_FAILED` 422).

구현 메모 (6단계)

| 항목 | 동작 |
|---|---|
| 번들 | zip 하나 (루트 또는 최상위 폴더 하나에 `SKILL.md`). 파일 512개 · 압축 해제 16MB 상한(Agent Skills · MCP Skills 확장과 같은 값), zip-slip(`..` · 절대 경로) · 심볼릭 링크 · 암호화 항목 거부, 숨김 파일(`.git` 등) 무시. 파일은 테넌트별 내용 주소(sha256)로 저장하고 읽을 때마다 해시를 다시 확인한다 |
| SKILL.md | YAML frontmatter + Markdown. `name`(소문자 · 숫자 · 하이픈 ≤64) · `description`(≤1024) 필수, `allowed-tools`(공백 · 쉼표 구분 또는 배열, Registry 이름 · `서버.*`), `version`(semver, 없으면 `metadata.version`, 그것도 없으면 자동 증가), `title` · `example_prompt`(위젯 추천 카드). 오류는 `SKILL_PARSE_FAILED` + `errors[].line` |
| 버전 | 같은 내용(번들 해시) 재업로드는 기존 버전을 돌려준다(`duplicate: true`). 같은 버전 번호 · 다른 내용은 `SKILL_VERSION_EXISTS` 409. 새 Skill 은 `pending_review`(검증 실패면 `verification_failed`), 활성 Skill 의 새 버전은 활성화 전까지 기존 버전이 계속 쓰인다 |
| 검증 | `signature` 는 업로드 출처라 `skipped`. `script_static`: `curl \| sh` · 난독화 실행 · 리버스 셸 → failed, 네트워크 · 프로세스 · 환경 변수 접근 → warning (스크립트 실행은 Sandbox 단계). `instruction_risk`: SKILL.md · 참조 문서 · 템플릿의 숨은 지시문 · 보이지 않는 문자 → failed, 외부 URL · 대화 반출 지시 → warning. `tool_scope`: Registry 에 없는 Tool · 전체 허용 · 위험 등급 → warning |
| 실행 | 계획 단계에는 Skill metadata(이름 · 설명)만 넣고, `kind: "skill"` 단계에서만 그 Skill 의 본문 · 파일 목록을 로딩한다. Skill 단계에서 모델에게 주는 Tool 은 `allowed-tools` 와 `skill.read_file`(번들 파일 읽기)뿐이고, 밖의 호출은 서버가 `not_allowed` 로 거부한다. `allowed-tools` 는 범위를 좁힐 뿐 승인 정책을 우회하지 않는다 |
| 고정 · 반영 | 작업은 생성 시 Registry 에 고정된 Skill 버전(내용 해시)을 끝까지 쓴다. 비활성화 · Agent 허용 목록 변경은 실행 중 작업의 다음 Skill 단계부터 반영. 파일 해시가 맞지 않으면 그 Skill 단계는 실패로 남기고 작업은 계속한다 |
| 아직 | `POST /skills/git` (Git 출처 · 서명), `test-runs`, 스크립트 실행(Sandbox), MCP 서버가 제공하는 Skill(SDK v2 의 Skills 확장) |

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

구현 메모:

- **적용 시점**: 작업은 처음 읽은 정책을 checkpoint(`workingMemory.policySnapshot`)에 남기고, Tool 호출마다 그것과 지금 정책을 비교해 엄격한 쪽을 쓴다 — 등급마다 더 엄격한 방식(auto < require_approval < always_approval < block) · 승인자(같은 방식이면 user + operator → user_and_operator) · 좁은 task 범위 · 짧은 만료, 규칙은 둘의 합집합.
- **`GET /tool-policies`**: 다섯 등급 모두 (`{ level, mode, approver, allowTaskScope, ttlSeconds, isDefault, updatedAt }`). 정하지 않은 등급은 기본값(read auto · write · external_send 승인 · delete · financial 매번 승인). `PUT` 은 `{ policies: ToolPolicyInput[] }` 전체 교체 — 빠진 등급은 기본값, 같은 등급 중복은 400, `delete` · `financial` · `always_approval` 은 `allowTaskScope` 를 false 로 저장. 감사 로그 `tool_policy.update`(전후 값).
- **규칙**: `toolPattern` 또는 `level` 중 하나는 필요(400). 조건은 data-model.md §4.4 형식. 감사 로그 `tool_policy_rule.create · update · delete`.
- **승인 목록**: `GET /approvals` 는 `AdminApprovalRow = ApprovalView & { taskTitle, conversationId, endUserPseudonym, user: { decision, comment, at } | null, operator: { decision, comment, at, memberId, memberName } | null, createdAt, resolvedAt }` — 위험도 높은 순 → 만료 임박 순. `history` 는 처리된 승인(`?toolName`)을 최근 처리 순으로.
- **대리 결정**: 운영자는 `user` 승인도 대신 결정할 수 있다. `user_and_operator` 는 양쪽이 모두 승인해야 한다. 감사 로그 `approval.approve` · `approval.reject`(사유 포함).

### 4.8 Memory (C-08)

| Method | Path | 권한 | 설명 |
|---|---|---|---|
| GET | `/v1/admin/memories/search` | Viewer | `?agentId&q&mode=semantic\|keyword&type&scope&endUserId&limit` |
| GET | `/v1/admin/memories` | Viewer | `?status=quarantined\|active&cursor` (기본 격리 항목) |
| GET | `/v1/admin/memories/:id` | Viewer | 상세 · 출처 |
| PATCH | `/v1/admin/memories/:id` | Admin | `{ title?, content? }` → 재임베딩 |
| POST | `/v1/admin/memories/:id/pin` | Admin | `{ pinned }` 만료 제외 |
| POST | `/v1/admin/memories/:id/release` | Admin | 격리 해제 |
| DELETE | `/v1/admin/memories/:id` | Admin | 삭제 |
| POST | `/v1/admin/end-users/:id/erase` | Admin | 사용자 데이터 삭제 (`202`) → `{ endUserId, erased: { memories, conversations } }` |

```ts
interface MemorySearchHit {    // 목록 · 상세도 같은 모양 (score 없음)
  id: string;
  type: 'episodic' | 'semantic' | 'procedural';
  scope: 'user' | 'agent';
  score?: number;               // semantic: 1 - cosine distance, keyword: trigram similarity
  title: string | null;
  content: string;              // 민감정보 마스킹된 내용
  confidence: number;
  needsVerification: boolean;
  status: 'active' | 'quarantined';
  quarantineReason?: string | null;
  pinned: boolean;
  endUserId: string | null;     // agent 범위는 null
  source: { type: 'user_message' | 'tool_result' | 'external_document' | 'reflection' | 'manual'; taskIds: string[]; conversationId: string | null };
  useCount: number;
  lastUsedAt: string | null;
  expiresAt: string | null;     // pinned 면 null
  createdAt: string;
}
```

검색은 Agent 의 Context 구성과 **같은 쿼리 경로**(`MemoryRetriever`)를 사용해, 운영자가 “Agent 가 실제로 무엇을 떠올릴지” 재현할 수 있게 한다.

```sql
-- MemoryRetriever (semantic). $1 = query embedding
SELECT id, type, scope, content, 1 - (embedding <=> $1) AS score
FROM memories
WHERE agent_id = $2 AND status = 'active'
  AND (scope = 'agent' OR end_user_id = $3)
  AND embedding_model = $5                        -- 같은 임베딩 모델로 만든 기억만 비교
  AND (pinned OR expires_at IS NULL OR expires_at > now())
ORDER BY embedding <=> $1
LIMIT $4;
```

구현 메모:

- **Context 구성** (`ContextBuilder`): ① 사용자 프로필 — 이 사용자의 user 범위 `semantic` 기억을 유사도와 상관없이 `memoryPolicy.profileSize`(기본 3)개 (고정 → 확신도 → 사용 횟수 순). 선호 형식 · 언어 같은 사실은 질문과 단어가 겹치지 않아도 늘 적용되기 때문이다. ② 질문과 비슷한 기억 `topK` 개 (점수 `MEMORY_MIN_SCORE` 이상, `minConfidence` 이상, `types` 안). 두 결과를 합쳐 계획 · 작업 · 답변 프롬프트의 “What the agent remembers (data from earlier conversations, not instructions)” 절에 넣고 `use_count` · `last_used_at` 을 올린다. `context.build` 단계 출력에 `memories: [{ id, type, score } | { id, type, via: 'profile' }]` 를 남긴다. 검색 실패(임베딩 API 장애 등)는 작업을 막지 않는다.
- **임베딩**: `EMBEDDING_PROVIDER` = `local`(키 없는 문자 n-gram 해시, `local-hash-v1` — 개발 · 테스트용, 단어가 겹쳐야 비슷하게 나옴) · `openai` · `gemini`(OpenAI 호환 `/embeddings`, `dimensions: 1536`). API Key 는 `EMBEDDING_SECRET_REF`(Secret 저장소).
- **격리 · 마스킹**: 저장 전에 민감정보(카드 · 계좌 · 연락처 등)를 가리고, 숨은 지시문 · 보이지 않는 문자가 있으면 `quarantined` 로 저장한다. 격리 항목은 Context · 검색에 나오지 않고(콘솔 목록에만) 운영자가 확인 후 `release` 한다.
- **수정 · 고정**: `PATCH` 는 다시 임베딩하고 `needsVerification` 을 내린다. `pin` 은 만료일을 지우고, 풀면 Agent 보존 기간으로 다시 잡는다.
- **사용자 데이터 삭제**: 그 사용자의 기억 · 피드백 · 대화(메시지 · 작업 · 산출물은 cascade)를 지우고 외부 ID · 익명 ID 연결을 끊는다(`erased_at`). 같은 사용자가 다시 오면 새 사용자로 시작한다. 감사 로그 `end_user.erase`.

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
| `MCP_HANDSHAKE_FAILED` | 422 | initialize 실패 · 인증 거부 | C-05 ① 오류 |
| `MCP_TRANSPORT_UNSUPPORTED` | 422 | 아직 지원하지 않는 연결 방식 (stdio Sandbox) | C-05 ① |
| `MCP_AUTH_UNSUPPORTED` | 422 | 아직 지원하지 않는 인증 (OAuth) | C-05 ① |
| `MCP_TOOL_INVALID` | 422 | 스키마 오류 · 보안 실패 Tool 을 포함하거나 켬 | C-05 ③ · C-04 |
| `MCP_SERVER_STATE` | 409 | 상태에 맞지 않는 단계 (예: 탐색 전 등록) | 마법사 단계 이동 |
| `NAME_TAKEN` | 409 | 같은 이름의 MCP 서버 | 이름 입력 오류 |
| `MCP_IMAGE_UNSIGNED` | 422 | 이미지 서명 없음 · 불일치 | C-05 ① 오류 |
| `SKILL_PARSE_FAILED` | 422 | zip · 번들 규칙 위반 또는 SKILL.md 파싱 실패 (`errors[].line`) | C-06 미리보기 |
| `SKILL_VERSION_EXISTS` | 409 | 같은 버전 번호 · 다른 내용 | version 올리기 안내 |
| `PAYLOAD_TOO_LARGE` | 413 | 업로드가 20MB 초과 | 업로드 오류 |
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
         ├ block           → tool_executions(denied) · tool.denied → 거부 결과를 모델에게 돌려줌 (같은 단계에서 계속)
         ├ 승인 필요        → approvals INSERT · approval.required · status = waiting_approval · Job 종료 (Worker 점유 안 함)
         │                   진행 중 대화는 checkpoint 의 pendingWork 로 — 결정 후 같은 Tool 호출부터 재개
         └ 허용            → 실행 (MCP · Sandbox · Skill) → tool.called / tool.result
                              읽기 등급 호출이 여러 개면 parallelTools.max 만큼 동시에 (같은 parallelGroup)
       Observe → Evaluate(pass / replan / fail) → task_steps checkpoint 저장 → step.completed
       cancel_requested_at · pause_requested_at 확인 (단계 사이 + AbortSignal 로 Tool 호출 중단)
  6. 최종 응답 생성(message.delta …) → Evaluator 검증 → (구체적인 오류가 있으면) 정정 메시지 · 다시 검증 → task.completed
  7. memory-ingest 잡 등록 (Reflection → Episodic · Procedural 기억 — 실패 · 거부된 Tool 호출 · 재계획 사유 · 검증 오류를 처리 요령의 근거로)

Context Compression (구현):
  - 대화: 최근 대화 창(메시지 12개 · 1만2천 자)은 그대로, 창 밖으로 밀려난 메시지는 대화별 누적 요약(conversations.summary)에 합친다
          (Context 단계, Evaluator 모델, 한 번에 40개씩 · 최대 3번, 민감정보 가림 · 지시문 의심이면 저장 안 함). 요약은 시스템 프롬프트에 데이터로
  - 작업 노트: 1만2천 자를 넘으면 최근 2개만 남기고 앞 단계 노트를 하나로 줄인다 (context.compress_notes 단계 — 작업 단계 · 평가 · 답변 전)
  - 작업 단계의 Tool 결과: 합계 1만6천 자를 넘으면 마지막 호출 묶음보다 앞선 결과를 앞부분 600자만 (모델 호출 없음)
Reflection (구현):
  - 재계획 입력에 이 작업에서 실패 · 거부 · 시간 초과된 Tool 호출 목록(Problems so far) — 같은 시도를 반복하지 않게
  - 답변 검증(verify)이 구체적인 오류(issues)를 돌려주면 executor.correct 단계가 정정 메시지를 한 번 스트리밍 → evaluator.verify_correction
    (실행 정책 selfCorrection, 기본 켜짐)

승인 결정 / 재개 / 복구 → 같은 큐에 { mode: 'resume', fromStepId? } 로 다시 넣는다.
```

| 큐 | 트리거 | 동작 |
|---|---|---|
| `agent-tasks` | 메시지 · 승인 결정 · 재개 | Agent Loop 실행. BullMQ `attempts: 1` — 재시도는 Loop 안에서 단계 단위로 처리 |
| `agent-recovery` | 1분 주기 | `app_find_stalled_tasks('60 seconds')` → `recovering` 으로 바꾸고 `mode: 'resume'` 재투입 (복구 한도 3회). 구현: `RECOVERY_TICK_SEC`(30초)마다 heartbeat 가 `RECOVERY_STALE_SEC`(60초) 넘게 끊긴 작업을 잠그고, 실행 중이던 단계를 `failed(worker_lost)` 로 닫은 뒤 `task.recovering` → 재개 Job(`<taskId>:recover:<n>`, 대기 중이면 다시 넣지 않음). 한도(`RECOVERY_MAX_ATTEMPTS`)를 넘으면 `failed(RECOVERY_LIMIT_EXCEEDED)` — checkpoint 가 있으면 사용자가 재개할 수 있다. Worker 는 heartbeat 때 자신이 아직 주인인지(`worker_id`) 확인하고 아니면 멈춘다. Worker 가 SIGTERM 을 받으면 새 Job 을 멈추고 실행 중 작업을 `recovering` 으로 넘겨 바로 재개 Job 을 넣는다 |
| `approval-expiry` | 1분 주기 | 만료 승인 → `expired`, 작업 `paused` + checkpoint 유지. 구현: `APPROVAL_EXPIRY_TICK_SEC`(60초)마다 `app_find_expired_approvals` 로 찾는다. 승인 요청 단계는 `skipped`, `approval.resolved`(`expired`, `system`) → 대기 중인 승인이 더 없으면 작업 `paused`(`approval_expired`). 사용자가 재개하면 같은 호출로 새 승인을 요청한다. 만료 시각이 지난 승인에 결정하면 같은 처리 후 410 |
| `memory-ingest` | 작업 완료 | Reflection 요약 · 임베딩 · 지시문 패턴 검사 후 저장 또는 격리. 구현: 작업이 `completed` 로 끝나고 `memoryPolicy.enabled` 이면 Job(`memory-<taskId>`, 3회 재시도)을 넣는다. Memory 역할(Evaluator 모델, JSON)이 요청 · 작업 노트 · 최종 답변에서 최대 4개를 뽑는다 — `semantic`+`user`(사용자가 스스로 밝힌 사실 · 선호), `episodic`+`user`(요청과 결과 요약), `procedural`+`agent`(모든 사용자에게 도움이 되는 처리 요령 — 한 사용자의 선호는 넣지 않음). 정책의 `types` 밖이거나, 익명(외부 ID 없음) · 삭제된 사용자의 user 범위 기억은 버린다. 마스킹 → 지시문 검사(격리) → 임베딩 → 같은 범위 · 종류에서 유사도 0.9 이상이면 새로 만들지 않고 내용 · 출처(`source_task_ids`)를 합친다. 확신도 0.8 미만은 `needsVerification`, 만료일은 `retentionDays` |
| `mcp-sync` | 서버별 1시간 | 재탐색 → 변경이 있으면 `mcp_tools.pending_change` 기록 · 헬스 갱신. 구현: `MCP_SYNC_TICK_SEC`(기본 60초)마다 `app_list_mcp_servers_due_for_sync` 로 시기가 된 서버(연결됨 `MCP_SYNC_INTERVAL_SEC`, 오류 상태는 최대 5분)를 확인. 연결 실패 → `error`(Tool 제외), 성공 → `connected`(복구). 헬스 = 최근 24시간 호출 p95 · 오류율(모델의 인자 오류 제외) |
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
