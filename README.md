# TheOneAI — Embedded AI Agent Widget

웹사이트에 임베딩되는 단일 Agent 플랫폼. 사용자의 요청을 스스로 계획하고, MCP Tool 과 SKILL.md 기반 Skill 로 실행하며, 위험 작업은 사람의 승인을 받는다.

| 영역 | 기술 |
|---|---|
| Backend | NestJS 12 (ESM) + TypeScript 6 |
| Frontend (Widget · Console) | React + TypeScript |
| Agent Runtime | 자체 TypeScript Runtime (Context → Plan → Execute → Observe → Evaluate) |
| 확장 | MCP (Tool) · SKILL.md (Skill) |
| DB | PostgreSQL 16 + pgvector · Prisma 7 (driver adapter `pg`) |
| Queue · Cache | Redis + BullMQ 6 |
| Streaming | SSE |
| Sandbox · Storage | Docker Worker · S3 호환 |
| Monitoring | OpenTelemetry |

## 문서

| 문서 | 내용 |
|---|---|
| [docs/screen-design.md](docs/screen-design.md) | 화면 설계 v1.0 (Widget 5 · Console 9) — 캔버스 링크 포함 |
| [docs/api-spec.md](docs/api-spec.md) | API 명세 v0.1 — 인증, Widget · Admin API, SSE 이벤트, 오류 코드, BullMQ 큐, 모듈 구성 |
| [docs/data-model.md](docs/data-model.md) | 데이터 모델 v0.1 — 테이블, RLS, JSON 컬럼 형식, 설계 결정 |
| [prisma/schema.prisma](prisma/schema.prisma) | Prisma 스키마 (31 테이블) |
| [prisma/migrations](prisma/migrations) | 마이그레이션 (init 에 RLS · 역할 · 함수 · 부분/벡터 인덱스 포함) |

## 로컬 실행

필요: Node.js 22+, **npm 11+** (npm 10 은 이 의존성 트리에서 설치 오류가 난다), Docker.

```bash
cp .env.example .env            # DEV_SECRETS 의 <DEEPSEEK_API_KEY> 를 실제 키로 바꾼다 (.env 는 커밋하지 않음)
docker compose up -d            # PostgreSQL 16 + pgvector, Redis
npm install                     # postinstall 에서 Prisma Client 생성 → src/generated/prisma
npm run db:setup                # 마이그레이션 + 개발용 앱 계정(app_rw) + 데모 테넌트 · DeepSeek 모델 시드

npm run start:dev               # API   http://localhost:3000
npm run start:worker:dev        # Agent Worker (다른 터미널)
```

LLM 키 없이 파이프라인만 보려면 `.env` 에 `AGENT_RUNTIME=placeholder` 를 둔다.

시드는 콘솔 Owner `owner@demo.local` (워크스페이스 `demo`)를 만든다. 비밀번호는 `.env` 의 `DEV_ADMIN_PASSWORD`, 비어 있으면 생성해 한 번만 출력한다.

### Skill 올려 보기

예제 [examples/skills/refund-helper](examples/skills/refund-helper) (환불 규정 참조 문서 + `demo-shop.lookup_order` · `builtin.calculate` 사용)를 zip 으로 묶어 올리고, 검증 결과를 확인한 뒤 활성화하고 Agent 에서 켠다. 번들 파일은 `OBJECT_STORAGE_DIR`(기본 `.storage/`)에 저장된다.

```bash
npm run dev:pack-skill -- examples/skills/refund-helper       # refund-helper.zip
SK=$(curl -s -X POST localhost:3000/v1/admin/skills -H "Authorization: Bearer $A" -F file=@refund-helper.zip)
echo "$SK" | jq '.version.verification'                         # 신뢰 검증 6항목
curl -s -X POST localhost:3000/v1/admin/skills/$(echo "$SK" | jq -r .skill.id)/versions/$(echo "$SK" | jq -r .version.id)/activate -H "Authorization: Bearer $A"
curl -s -X PATCH localhost:3000/v1/admin/agents/$AG/draft "${H[@]}" -d "{\"skills\":[{\"id\":\"$(echo "$SK" | jq -r .skill.id)\",\"enabled\":true}]}"
curl -s -X POST localhost:3000/v1/admin/agents/$AG/publish "${H[@]}" -d '{}'
```

### MCP 서버 연결해 보기

데모 MCP 서버(`scripts/dev-mcp-server.ts` — 주문 조회 · FAQ 검색 · 문의 티켓, SDK v2. `--legacy` 를 주면 2025 계열 프로토콜만 응답)를 띄우고 콘솔 API 로 등록한 뒤 Agent 에서 켠다. 로컬 http 엔드포인트이므로 API · Worker 를 `MCP_ALLOW_INSECURE_HTTP=true` 로 실행하고, 서버는 `allowPrivateNetwork: true`(Owner 만 가능)로 등록한다.

```bash
npm run dev:mcp-server                         # http://127.0.0.1:3901/mcp
A=$(curl -s -X POST localhost:3000/v1/admin/auth/login -H 'Content-Type: application/json' \
  -d '{"tenantSlug":"demo","email":"owner@demo.local","password":"<DEV_ADMIN_PASSWORD>"}' | jq -r .accessToken)
H=(-H "Authorization: Bearer $A" -H 'Content-Type: application/json')
S=$(curl -s -X POST localhost:3000/v1/admin/mcp-servers "${H[@]}" -d '{"name":"demo-shop","transport":"streamable_http",
  "endpointUrl":"http://127.0.0.1:3901/mcp","allowPrivateNetwork":true}' | jq -r .id)
curl -s -X POST localhost:3000/v1/admin/mcp-servers/$S/test "${H[@]}"       # ① 연결 테스트 (SSRF · 핸드셰이크)
curl -s -X POST localhost:3000/v1/admin/mcp-servers/$S/discover "${H[@]}"   # ② Tool 탐색 · 검증
curl -s -X POST localhost:3000/v1/admin/mcp-servers/$S/register "${H[@]}"   # ④ 등록 → 새 Registry 버전
AG=$(curl -s localhost:3000/v1/admin/agents "${H[@]}" | jq -r '.[0].id')
curl -s -X PATCH localhost:3000/v1/admin/agents/$AG/draft "${H[@]}" -d "{\"mcpServers\":[{\"id\":\"$S\",\"enabled\":true}]}"
curl -s -X POST localhost:3000/v1/admin/agents/$AG/publish "${H[@]}" -d '{}'  # Agent 새 버전 배포
```

## LLM 모델 설정

Agent Loop 는 역할마다 다른 모델을 쓴다 (`model_configs`, 화면 C-03 “모델 구성”). OpenAI · DeepSeek · Gemini 는 모두 각 사의 **OpenAI 호환 Chat Completions API** 로 호출하며, provider 별 차이는 [`src/llm/provider-params.ts`](src/llm/provider-params.ts) 에서 맞춘다.

| provider `kind` | 기본 base URL | 추론 강도(`reasoning_effort`) 매핑 |
|---|---|---|
| `deepseek` | `https://api.deepseek.com` | `off` → `thinking: {type: "disabled"}`, 그 외 → `reasoning_effort` (low · high · max) |
| `openai` | `https://api.openai.com/v1` | `off` → 보내지 않음, 그 외 → `reasoning_effort` (low · medium · high). 출력 토큰은 `max_completion_tokens` |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta/openai` | `off` → 보내지 않음, 그 외 → `reasoning_effort` |
| `openai_compatible` | `providers.base_url` 필수 | `reasoning_effort` |

데모 시드의 기본값 (DeepSeek, 실측 기반):

| 역할 | 모델 | 추론 | 대체 모델 | 이유 |
|---|---|---|---|---|
| planner | `deepseek-flash` | off | `deepseek-v4-pro` | 계획 단계가 첫 토큰을 늦추므로 빠른 설정 (v4-pro · low 4.1s → flash · off 2~3s) |
| executor | `deepseek-flash` | off | `deepseek-v4-pro` | 답변 스트리밍 |
| evaluator | `deepseek-flash` | low | — | JSON 검증 |

OpenAI · Gemini 를 쓰려면 `providers` 에 행(`kind`, `secret_ref`)을 추가하고 `model_configs` 의 provider · model 을 바꾼 뒤, `DEV_SECRETS` 에 같은 `secret_ref` 로 키를 넣는다. 모델 설정 Admin API(C-03)는 다음 단계다.

위젯 흐름을 직접 호출해 보기:

```bash
ID=$(npm run -s dev:identity-token -- --sub user-1)     # 고객사 서버 역할: identity token 발급
TOKEN=$(curl -s -X POST localhost:3000/v1/widget/bootstrap \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost:5173' \
  -d "{\"publicKey\":\"wk_pub_demo\",\"identityToken\":\"$ID\"}" | jq -r .sessionToken)
CONV=$(curl -s -X POST localhost:3000/v1/conversations -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{}' | jq -r .id)
TASK=$(curl -s -X POST localhost:3000/v1/conversations/$CONV/messages -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"content":[{"type":"text","text":"3월 매출 리포트 만들어줘"}]}' | jq -r .task.id)
curl -N localhost:3000/v1/tasks/$TASK/events -H "Authorization: Bearer $TOKEN"   # SSE
```

## 테스트

```bash
npm test             # 단위 테스트
npm run test:e2e     # e2e — 실제 PostgreSQL · Redis 필요 (docker compose). 테스트 DB 를 매번 새로 만들고 마이그레이션을 적용한다
npm run lint && npm run typecheck && npm run build
```

e2e 가 확인하는 것: bootstrap(허용 도메인 · identity token 서명 · aud · 수명), 세션 Origin 고정, 메시지 → 작업 → Worker → SSE 이벤트 순서, delta 와 최종 메시지 일치, 단계 · checkpoint 저장, `Last-Event-ID` 재전송(중복 없음), 대화당 진행 작업 1개(동시 요청 포함), Idempotency-Key(동시 재시도 포함), 중지, 클라이언트 연결 종료 시 구독 정리, 테넌트 · 사용자 간 격리.

Agent Loop 는 가짜 OpenAI 호환 서버([test/fake-llm-server.ts](test/fake-llm-server.ts))로 검증한다: 계획 → reason → 중간 평가 → 답변 → 검증 순서, 재계획(`plan.revised`), 계획 JSON 오류 시 기본 계획, 모델 오류 · API Key 없음 → `task.failed`, 역할별 모델 · 추론 파라미터 · 인증 헤더, 플랫폼 · 테넌트 지침, 대화 기록 포함, 토큰 사용량 기록. 실제 DeepSeek 로는 수동으로 확인했다(아래).

재개 · 복구는 [test/recovery.e2e-spec.ts](test/recovery.e2e-spec.ts) 가 확인한다: 실행 중 일시정지 → 현재 단계 마치고 paused → checkpoint 재개(끝난 단계 건너뜀), 답변 실패 → 재개 시 분석 반복 없이 완료 · 실패 실행 토큰 합산, 재개 조건(완료 · checkpoint 없음 · 처음부터), 답변 중 Worker 유실 → 복구 잡이 checkpoint 부터(답변 메시지 하나만), 복구 한도 초과, 살아 있는 작업은 복구 안 함, Worker 종료 시 넘기기, 실행 중 추가 지시 반영 · 끝난 작업 거부, 콘솔 목록 · 트레이스 · 단계 상세.

Memory 는 [test/memory.e2e-spec.ts](test/memory.e2e-spec.ts) 가 확인한다: 작업 완료 → 기억 저장(사용자 사실 · 요약은 user 범위, 처리 요령은 agent 범위, 확신도 → 검증 필요, 보존 90일, 1536차원 임베딩), 같은 내용은 병합(출처만 추가), 숨은 지시문 → 격리 · 카드 번호 마스킹, 같은 사용자의 새 대화에서 계획 · 답변 프롬프트에 기억 포함(격리 항목 제외 · 사용 횟수), 주제가 달라도 사용자 프로필은 포함, 다른 사용자에게는 user 범위 기억이 보이지 않음, 콘솔 의미 · 키워드 검색 · 격리 해제 · 수정(재임베딩) · 고정 · 삭제, 사용자 데이터 삭제 후 같은 사용자는 새 사용자로 시작.

Skill 은 [test/skills.e2e-spec.ts](test/skills.e2e-spec.ts) 가 확인한다: zip · SKILL.md 오류(줄 번호), Viewer 업로드 거부, 신뢰 검증(스크립트 경고 · 숨은 지시문 실패 → 활성화 불가), 중복 · 버전 충돌, 파일 미리보기 · 비교, 활성화 → Registry, 허용 목록 전에는 계획에 안 보임, 초안 → 배포, 위젯 추천 카드, 실행(계획에는 metadata 만 · Skill 단계에서 본문 · 파일 로딩 · allowed-tools + skill.read_file 만 제공), allowed-tools 밖 호출 거부, 일반 단계엔 skill.read_file 없음, 새 버전 활성화 후 새 버전 사용, 저장소 파일 변조 시 사용 안 함, 비활성화 · 감사 로그.

MCP 는 [test/mcp.e2e-spec.ts](test/mcp.e2e-spec.ts) 가 공식 SDK v2 로 만든 MCP 서버([test/fake-mcp-server.ts](test/fake-mcp-server.ts))로 확인한다: 프로토콜 협상(최신 서버는 `server/discover` 로 2026-07-28, 2025 계열 전용 서버는 `initialize` 로 내려감, 2025 계열로 기록된 서버는 재사용 연결에서 탐색 생략, 401 은 인증 실패로), 콘솔 로그인 · 역할(Viewer 는 조회만, 사설망 허용은 Owner 만, 위젯 토큰 거부), SSRF(사설 IP 로 해석되는 호스트를 연결 시점 DNS 검사로 차단, 메타데이터 IP 차단), 등록 마법사(연결 테스트 · API Key 전달 · 탐색 검증 · 보안 실패 Tool 제외 · 등록 → Registry 버전 · 감사 로그), 테넌트 격리, Agent 허용 목록(초안 → 배포, 허용 전 호출은 `not_allowed`), MCP Tool 실행(structuredContent · JSON Schema 인자 검증 · isError 는 재시도 안 함), 재탐색 변경 감지(검토 전에는 고정된 이전 정의 사용 → 승인 시 새 버전, 새 Tool 은 꺼진 채 추가), 서버 장애 → `error` · `tool_unavailable` → 복구 · 헬스, 연결 정보 변경 시 재검토, 비활성화 · 삭제(Secret 삭제 · 이름 재사용).

Tool 은 [test/tools.e2e-spec.ts](test/tools.e2e-spec.ts) 가 확인한다: tool 단계 → 모델의 tool call → 서버 실행 → 결과가 다음 요청 · 답변에 반영, 읽기 Tool 병렬 실행(같은 `parallelGroup`, 결과는 호출 순서), 인자 오류를 모델에게 돌려줘 고치게 함, Tool 왕복 한도(`tool_choice: none` 으로 정리), Registry 에 없는 Tool · 조건 규칙 · 등급 정책 차단(`tool.denied`), 승인 필요 Tool 은 “승인 필요” 표시와 함께 계획 · 작업 단계에 보임, 내장 Tool 구성이 바뀌면 새 Registry 버전(이전 버전 불변), 멱등 Tool 재시도, 시간 제한.

승인은 [test/approvals.e2e-spec.ts](test/approvals.e2e-spec.ts) 가 확인한다: 승인 필요 Tool 호출 → 승인 요청(카드 데이터 · 계획 카드 · 단계 상태 · checkpoint) → `waiting_approval`(Worker 해제), 승인 → 모델을 다시 부르지 않고 같은 호출 · 같은 인자로 실행 → 완료(once 승인 사용 처리), 다른 사용자 결정 불가, 거절 → 실행 안 함 · 사유를 모델에게 데이터로, task 범위 승인 → 같은 Tool 의 다음 호출은 묻지 않음, 한 응답의 읽기 + 쓰기 → 읽기는 한 번만 실행, 중지 → 승인 취소, 만료 → `paused` → 재개 시 새 승인 · 만료 직후 결정은 410, 조건 규칙(require_operator) → 사용자 승인 후에도 운영자 대기 · 규칙 승인은 task 범위 불가 · 콘솔 목록 · Viewer 거부 · 사유 필수 · 운영자 승인 → 실행 · 이력 · 감사 로그, 운영자 전용 승인(FORBIDDEN_APPROVER) · 운영자 거절, 정책 강화는 대기 중인 작업에도 즉시 · 완화는 새 작업부터, 등급 정책 교체(기본값 · task 범위 불가 등급) · 규칙 검증 · 수정 · 삭제. [test/worker-boot.e2e-spec.ts](test/worker-boot.e2e-spec.ts) 는 Worker 프로세스(WorkerModule 만)의 의존성을 확인한다.

Reflection · Context Compression 은 [test/reflection.e2e-spec.ts](test/reflection.e2e-spec.ts) 가 확인한다: 긴 대화 → 창 밖 메시지 8개 요약 · 저장 · 계획 · 작업 · 답변 프롬프트에 포함, 다음 작업은 새로 밀려난 2개만 이전 요약에 합침, 짧은 대화는 요약 안 함, 작업 노트가 길면 앞 단계 노트 압축(단계 기록 · 토큰) · 답변은 줄인 노트 사용, 재계획에 거부된 Tool 호출 전달, 작업의 실패 · 재계획 사유가 기억 추출로, 검증 오류 → 정정 메시지(두 번째 assistant 메시지) → 다시 검증, `selfCorrection` 끄면 정정 안 함.

## 구현 현황

| 범위 | 상태 |
|---|---|
| 프로젝트 · DB 기반 (스키마, RLS, 마이그레이션, 시드) | 완료 |
| Widget API: `POST /v1/widget/bootstrap`, 대화 · 메시지, 작업 목록 · 상세 · 중지, SSE (`Last-Event-ID` 재전송, 응답 스트림 스냅샷) | 완료 |
| 비동기 실행: BullMQ `agent-tasks`, Worker heartbeat, 단계 · checkpoint 저장, 최대 단계 · 시간 제한, 중지 처리 | 완료 |
| LLM 연동: OpenAI 호환 클라이언트(OpenAI · DeepSeek · Gemini), 스트리밍 · tool call 파싱 · 재시도 · 대체 모델 · 역할별 추론 강도 | 완료 — DeepSeek 는 실제 API 로 확인, OpenAI · Gemini 는 키가 없어 단위 테스트(요청 형식)까지만 |
| Agent Loop: Context → Plan → Execute(reason · tool · skill) → Evaluate → 재계획 → Respond(스트리밍) → Verify, 토큰 예산 | 완료 |
| 콘솔 인증: `POST /v1/admin/auth/login`(scrypt) · `GET /v1/admin/me`, 역할 가드(Owner > Admin > Operator > Viewer, 매 요청 DB 재확인), 감사 로그 | 완료 — refresh 쿠키 회전 · 로그아웃은 콘솔 UI 단계 |
| MCP (C-04 · C-05): Streamable HTTP 연결(공식 SDK v2 — 2026-07-28 우선, 2025 계열 서버 자동 호환), SSRF 방어(스킴 · 호스트 · DNS 해석 · 연결 시점 IP 검사, 메타데이터 IP 항상 차단), API Key(Secret 저장소), 연결 테스트 · Tool 탐색 · 검증(JSON Schema · 숨은 지시문 · 보이지 않는 문자 · 민감정보 · 제안 등급), 포함 Tool · 등록 → 새 Registry 버전, Tool 정책, 재탐색 변경 감지 → 운영자 승인, `mcp-sync` 주기 잡(장애 → error · 복구, 헬스 p95 · 오류율), 비활성화 · 삭제, Registry 버전 · diff API | 완료 — stdio(Docker Sandbox) 실행형 · OAuth 인증 · 이미지 서명 검증은 Sandbox 단계 |
| Skill (C-06): zip 업로드(zip-slip · 심볼릭 링크 · 크기 · 파일 수 검사), SKILL.md 파싱(줄 번호 오류), 신뢰 검증 6항목, 버전(내용 해시 · 중복 · 충돌) · 파일 미리보기 · 비교 · 활성화 → 새 Registry 버전 · 비활성화, Agent 허용 목록, 위젯 추천 카드. 실행: 계획에는 metadata 만, `skill` 단계에서 본문 · 파일 목록 로딩, `skill.read_file`, allowed-tools 로 Tool 범위 제한(서버 강제), 저장 파일 해시 재확인 | 완료 — Git 출처 · 서명 · test-runs · 스크립트 실행(Sandbox) · MCP 서버 Skill 은 이후 |
| Agent MCP 허용 목록: 초안(배포 버전 복사) → 배포, 실행 시 허용 목록 · 서버 상태 · Tool 사용 여부 확인(`not_allowed` · `tool_unavailable`) | 완료 — 초안 편집은 MCP 허용 목록만 (지침 · 모델 · 정책 편집은 C-03 단계) |
| Tool Registry · Dispatcher: 작업별 Registry 버전 고정, 인자 검증(zod), 권한 판단(등급 정책 → Tool 재정의 → 조건 규칙), 읽기 Tool 병렬 실행, 시간 제한 · 취소 전파, 멱등 Tool 재시도, `tool_executions` 기록(거부 포함) · 민감정보 마스킹, `tool.called` · `tool.result` · `tool.denied` | 완료 — 내장 Tool 2개(`builtin.calculate`, `builtin.current_time`). 승인 필요 Tool 은 승인 흐름으로 실행 |
| 비용 계산 (`tasks.cost_amount`) | 다음 단계 — 모델별 단가표 필요. 토큰 수는 기록 중 |
| 재개 · 복구: checkpoint 재개(계획 · 노트 · 다음 단계 · 보낸 답변) · 처음부터 다시 · 일시정지 · 실행 중 추가 지시(steer) · agent-recovery(heartbeat 끊김 → 마지막 checkpoint 부터, 한도 3회) · Worker 종료 시 넘기기 · 소유권 확인 · 콘솔 작업 목록 · 트레이스 · 단계 상세 · 일시정지 · 중지 · 재개 | 완료 |
| 승인 (W-03 · C-07): 승인 필요 Tool → 승인 요청 · `waiting_approval`(Worker 해제) → 결정 후 같은 호출부터 재개(진행 중 대화 checkpoint), once · task 범위, user · operator · user_and_operator, 인자 해시 · 사용 처리, 거절 사유 → 모델, 만료(`approval-expiry`) → paused, 중지 시 취소, 위젯 결정 API · 콘솔 목록 · 이력 · 대리 결정, 등급 정책 · 조건 규칙 관리(감사 로그), 정책 강화는 즉시 · 완화는 새 작업부터 | 완료 |
| Context Compression: 최근 대화 창 밖 메시지 → 대화별 누적 요약(증분, 시스템 프롬프트에 데이터로), 작업 노트 압축(`context.compress_notes`), 작업 단계의 오래된 Tool 결과 축약 | 완료 |
| Reflection: 재계획에 실패 · 거부된 Tool 호출 목록, 답변 검증 오류 → 정정 메시지 한 번 · 다시 검증(`selfCorrection`), 작업의 실패 · 재계획 · 검증 오류 → 처리 요령 기억의 근거 | 완료 |
| 업로드 · 산출물 다운로드 | 다음 단계 (명세 §2.6) |
| Memory (C-08): 작업 완료 → `memory-ingest`(Memory 역할이 사용자 사실 · 선호 / 요약 / 처리 요령 추출, 마스킹 · 지시문 격리 · 중복 병합 · 보존 기간), 임베딩(`local` 해시 · OpenAI · Gemini), Context 구성(사용자 프로필 + pgvector 유사도, 사용자 격리), 콘솔 검색(의미 · 키워드) · 격리 해제 · 수정(재임베딩) · 고정 · 삭제 · 사용자 데이터 삭제 | 완료 — 운영 임베딩은 키가 없어 `local` 로만 확인 |
| `metrics-rollup` · `retention` 주기 잡 | 다음 단계 (명세 §6) — `agent-recovery` · `mcp-sync` · `memory-ingest` · `approval-expiry` 는 완료 |
| Admin API · 콘솔 | 다음 단계 |
| 요청 제한 · OpenTelemetry · Vault 연동 (`SECRETS_BACKEND=local` 은 개발 전용, production 에서 시작 거부) | 다음 단계 |

## 코드 구조

```
src/
├── main.ts · worker.ts            API 서버 · Agent Worker 진입점 (별도 프로세스)
├── app.module.ts · worker.module.ts
├── bootstrap/                     공통 HTTP 설정 (버전, CORS, 검증, problem+json)
├── config/                        환경 변수 검증 (zod)
├── common/                        오류(AppError · ProblemDetailsFilter), 페이지네이션, trace id, UUIDv7
├── infrastructure/                database(PrismaService.withTenant, 트랜잭션 안 쿼리 직렬화) · redis(공유 Pub/Sub) · queue · secrets · storage
├── widget/                        bootstrap · identity token 검증 · 세션 토큰(ES256) · 세션 가드 · Origin 검사
├── conversations/                 대화 · 메시지 → 작업 생성
├── tasks/                         작업 조회 · 중지 · SSE 엔드포인트, 계획 · 뷰 타입
├── events/                        task_events 아웃박스 · Redis 발행 · SSE 스트림
├── llm/                           OpenAI 호환 클라이언트 · provider 별 파라미터 · JSON 출력 파싱 · 클라이언트 팩토리
├── agent-runtime/                 Agent Loop · 모델 라우터(역할별 · 대체) · Context · Executor · 프롬프트 · RunContext
├── planner/ · evaluator/          계획 생성 · 수정 / 중간 평가 · 최종 검증
├── tools/                         Tool Registry(버전 스냅샷) · 권한 정책 · 가용성 · Dispatcher · 내장 Tool · JSON Schema 검증 · 마스킹
├── mcp/                           MCP 연결(SDK · SSRF 가드) · 탐색 · 검사 · 변경 감지 · 재탐색(mcp-sync) · 결과 변환 · 관리 API
├── skills/                        Skill 번들(zip) · SKILL.md 파서 · 신뢰 검증 · 저장(내용 주소) · 실행 로딩 · skill.read_file · 관리 API
├── admin/                         콘솔 인증(로그인 · 토큰 · 역할 가드) · 감사 로그(AuditModule — API · Worker 공용)
├── approvals/                     승인 결정(위젯 · 콘솔 대리) · 만료 · 콘솔 승인 목록 · 이력 · 권한 정책 · 조건 규칙 관리
├── memory/                        임베딩 · MemoryRetriever(프로필 · 의미 · 키워드) · memory-ingest(추출 · 격리 · 병합) · 관리 API
├── workers/                       agent-tasks · agent-recovery · memory-ingest 프로세서 · 작업 실행 수명주기
└── agents/                        실행 · Memory 정책 스키마, Agent 초안 · 배포 API(MCP 허용 목록)
```

### 실제 DeepSeek 확인 결과 (2026-11-12)

| 요청 | 계획 | 소요 · 첫 토큰 | 검증 |
|---|---|---|---|
| 환불 정책 문의 (단순) | respond 1단계 | 10.4s · 5.3s (planner v4-pro · low) | 4개 중 1개 실패 — “부서 확인을 도와드리겠다”는 수행 불가 제안을 Evaluator 가 잡음 → 답변 프롬프트에 “Tool 없음 · 제안 금지” 추가 |
| 할인 방식 3가지 비교 · 추천 (복잡) | reason 2 + respond | 31s · 21.6s | 4/4 통과 |
| 같은 대화 후속 질문 | reason 1 + respond | 10.9s · 8.2s | 4/4 통과, 이전 답변 내용(조건 · 수치)을 이어서 사용 |
| 환불 + 주문 조회 요청 (프롬프트 수정 후) | reason 1 + respond | 15.8s · 11.5s | 4/4 통과, 주문 조회가 불가함을 밝힘 |

reason 단계가 있으면 첫 토큰이 늦다(그동안 위젯은 계획 · 단계 진행을 SSE 로 보여 준다). reason 결과 스트리밍 · 단계 병렬화는 이후 개선 대상.

Tool 연결 후 (2026-11-12, executor `deepseek-v4-flash`):

| 요청 | 계획 | 소요 · 첫 토큰 | 결과 |
|---|---|---|---|
| “지금 서울 시간 알려주고 1234*5678 계산해줘” | tool 1 + respond | 9.4s · 7.2s | 모델이 `current_time` · `calculate` 를 한 번에 요청 → 병렬 실행, 7,006,652 · 현재 시각 정확, 검증 4/4 |
| “내일 서울 날씨 어때? 월 39,000원 18개월이면 총 얼마?” | tool 2 + respond | 14.0s · 11.1s | 날씨 Tool 이 없음을 밝히고 702,000원 계산, 검증 4/4. 처음엔 1단계에서 2단계 계산까지 해 버려 중복 호출 → 작업 단계 프롬프트에 “현재 단계만 · 노트 재사용” 추가 후 중복 없음 |

MCP 연결 후 (2026-11-12, 데모 MCP 서버 `npm run dev:mcp-server` 를 콘솔 API 로 등록 · Agent 에서 허용. 아래 두 줄은 SDK v1(2025-11-25), 세 번째는 SDK v2 로 옮긴 뒤(2026-07-28)):

| 요청 | 결과 |
|---|---|
| “주문 A-1001 지금 어디쯤 왔어? 단순 변심 반품 비용은?” | 연결 테스트 61ms · Tool 3개 탐색(read · read · write) → 등록(Registry v3) → Agent v2 배포. 모델이 `demo-shop.lookup_order` · `search_faq` 를 한 번에 요청 → 병렬 실행(57ms · 35ms), 배송 현황 · 반품비 6,000원 정확, 검증 4/4 (12.1s · 첫 토큰 8.9s) |
| “주문 A-9999 상태 확인하고, 안 되면 상담원 티켓 남겨줘” | 서버가 `isError` 로 “주문 없음”을 알림 → 재시도 없이 그대로 안내. 티켓 생성(write)은 실행하지 않음. 처음엔 답변이 “승인해 주시면 남길 수 있다”고 해서 — 승인 흐름(10단계) 전까지는 모델에게 “승인 필요” 대신 “이 버전에서 사용할 수 없음”으로 알리도록 바꾼 뒤 “생성하지 못했다 · 고객센터 문의” 로 정직하게 답함 |
| “주문 A-1003 언제 도착했어? 교환하려면?” (SDK v2) | 연결 테스트에서 2026-07-28 협상(93ms). 두 Tool 병렬 실행(60ms · 35ms), 배송 완료 · 택배사 · 교환 조건(7일 · 같은 상품 옵션) 정확, 티켓 접수는 못 했다고 밝힘, 검증 4/4 (14.6s). 다만 FAQ 에 없는 “회수 후 교환품 발송” 절차를 덧붙였고 검증도 통과시킴 — 근거 없는 세부 절차 추가는 이후 Evaluator 보강 대상 |

Skill 연결 후 (2026-11-12, `refund-helper` 를 올려 검증 6항목 통과 → 활성화 → Agent 허용):

| 요청 | 결과 |
|---|---|
| “주문 A-1003 단순 변심으로 환불하면 얼마 돌려받아요? 상품 가격은 32,000원” | 계획: 주문 조회(tool) → `refund-helper`(skill) → 답변. Skill 단계에서 본문을 따라 `skill.read_file` 로 환불 규정을 읽고 `builtin.calculate` 로 32,000 − 6,000 = 26,000원 계산(앞 단계 조회 결과는 다시 부르지 않음). 7일 기한 · 미사용 조건 · 신청 방법 · 환불 시점을 규정대로 안내하고, 결제 금액은 사용자 입력이라 교차 확인하지 못했다고 밝힘. 검증 4/4 (16.0s) |

Memory 연결 후 (2026-11-12, 임베딩 `local`, Memory 역할 = evaluator `deepseek-flash`):

| 요청 | 결과 |
|---|---|
| 사용자 A: “저는 숫자 비교는 항상 표로 받는 게 좋고, 답변은 짧게 해 주세요. 월 3만9천원 24개월과 월 4만5천원 18개월 총액 비교해 줘” | 표 + 한 줄 답변(9.6s). 작업 뒤 `memory-ingest` 가 semantic(“숫자 비교는 표로, 답변은 짧게”, 확신도 0.9) · episodic(요청과 결과, 0.6 → 검증 필요) 저장. 처음 프롬프트에서는 같은 선호를 agent 범위 처리 요령(“숫자 비교는 표로 간결하게”)으로도 저장해 다른 사용자에게 퍼질 수 있었음 → “한 사용자의 선호는 처리 요령으로 만들지 않는다” 규칙 추가 후 user 범위에만 저장 |
| 사용자 A, 새 대화: “요금제 두 개 비교해 줘. 월 5만5천원 12개월이랑 월 2만9천원 24개월” | 처음에는 선호 기억이 유사도 기준(0.15)에 못 미쳐 빠지고(해시 임베딩은 단어가 겹쳐야 함) 요약만 들어가 답이 길었음 → 사용자 프로필(user 범위 semantic)을 유사도와 상관없이 넣도록 바꾼 뒤 프로필 + 요약(0.359)이 들어가 표 + 한 줄로 답함(12.4s) |
| 사용자 B, 같은 질문 | 기억 0개 (A 의 기억이 보이지 않음), 제목 · 여러 절이 있는 긴 답변 |

승인 흐름 연결 후 (2026-11-12, 데모 MCP 서버의 `create_ticket`(write, 승인 필요)):

| 요청 · 결정 | 결과 |
|---|---|
| “주문 A-9999 상태 확인해 주시고, 조회가 안 되면 상담원 티켓을 남겨 주세요. 연락은 메일로” → **승인** | 계획: 주문 조회(tool) → 판단(reason) → 티켓 생성(tool, “승인” 표시) → 답변. 조회 실패(주문 없음) 뒤 티켓 단계에서 승인 카드(요약 “상담원에게 전달할 문의 티켓을 만듭니다.”, 제목 · 본문 인자, 위험도 medium, task 범위 가능) → `waiting_approval`(9.5s). 승인하면 모델을 다시 부르지 않고 카드의 인자 그대로 티켓 T-99 생성 → 티켓 번호 · 이메일 연락 요청을 안내하고 “메일 발송은 하지 않았다”고 구분(결정 후 7.9s) |
| 같은 요청 → **거절** (“티켓은 남기지 마세요. 제가 직접 고객센터에 전화할게요.”) | 티켓을 만들지 않고(`approval_rejected`) “요청하신 티켓은 남기지 않았다 — 직접 전화하신다고 하셔서”라고 사유를 반영해 답하고, 전화할 때 전달할 내용을 안내(결정 후 7.4s) |

처음 실행에서 Worker 가 뜨지 않았다(`ApprovalsService` 가 콘솔 모듈의 `AuditService` 에 의존 — e2e 는 API + Worker 모듈을 함께 띄워 드러나지 않음) → 감사 로그를 `AuditModule` 로 분리하고 WorkerModule 만 띄우는 e2e 를 추가했다.

Context Compression 연결 후 (2026-11-12): 같은 대화에 이전 메시지 16개(주문 A-1003 문의 · 짧은 답변 선호로 시작해 반품 · 교환 · 포인트 · 쿠폰 · 멤버십 · 포장 질문, 메시지마다 부연 설명이 길다)를 넣고 “처음에 말씀드린 주문, 지금 배송 상태 어떻게 돼요?”를 물었다. 최근 창(12개)에 들지 않은 첫 4개가 요약(198자: “지난주 주문 A-1003 관련 문의, 답변은 짧게 받는 것을 선호”, 반품 규정 안내 등)으로 합쳐졌고, Agent 는 요약에서 주문 번호를 찾아 `demo-shop.lookup_order {"orderId":"A-1003"}` 를 호출해 “A-1003(노트북 파우치)은 배송 완료 상태입니다.” 로 짧게 답했다(12.3s). 주문 번호는 최근 창 밖의 첫 메시지에만 있어서, 요약이 없으면 Agent 가 알 수 없는 정보다.

## 개발 순서 (기획안 12장)

1. NestJS 프로젝트 · DB 기반 ✅
2. Widget 과 SSE 스트리밍 ✅
3. Agent Loop ✅ (OpenAI · DeepSeek · Gemini)
4. Tool Registry · Tool Dispatcher ✅ (내장 Tool, 권한 정책 · 규칙, 병렬 · 재시도 · 시간 제한)
5. MCP 동적 연결 ✅ (Streamable HTTP, SSRF, 탐색 · 검증 · 등록 · 변경 승인, 주기 재탐색, Agent 허용 목록, 콘솔 인증)
6. SKILL.md Loader ✅ (zip 업로드 · 파싱 · 신뢰 검증 · 버전 · 활성화, metadata 기반 선택 → Skill 단계에서만 로딩, allowed-tools 범위)
7. BullMQ 비동기 작업 ✅ (agent-tasks · agent-recovery · mcp-sync 주기 잡, Worker 종료 시 넘기기)
8. Checkpoint · Recovery ✅ (checkpoint 재개 · 처음부터 · 일시정지 · 추가 지시 · Worker 유실 복구 · 복구 한도)
9. Memory ✅ (memory-ingest 추출 · 마스킹 · 격리 · 병합, 임베딩, 사용자 프로필 + 유사도 검색, 콘솔 관리 · 사용자 데이터 삭제)
10. Permission · Approval ✅ (승인 대기 → 결정 → 같은 호출부터 재개, once · task 범위, 운영자 승인 · 규칙, 만료, 정책 관리 · 적용 시점)
11. Reflection · Context Compression ✅ (대화 요약 · 노트 압축 · Tool 결과 축약, 재계획 반성 · 정정 메시지 · 실패 교훈 기억)
12. Marketplace · Billing (P2) ← 다음
