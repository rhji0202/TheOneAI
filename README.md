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

Tool 은 [test/tools.e2e-spec.ts](test/tools.e2e-spec.ts) 가 확인한다: tool 단계 → 모델의 tool call → 서버 실행 → 결과가 다음 요청 · 답변에 반영, 읽기 Tool 병렬 실행(같은 `parallelGroup`, 결과는 호출 순서), 인자 오류를 모델에게 돌려줘 고치게 함, Tool 왕복 한도(`tool_choice: none` 으로 정리), Registry 에 없는 Tool · 조건 규칙 · 등급 정책 차단(`tool.denied`), 승인 필요 Tool 은 실행하지 않음, 내장 Tool 구성이 바뀌면 새 Registry 버전(이전 버전 불변), 멱등 Tool 재시도, 시간 제한.

## 구현 현황

| 범위 | 상태 |
|---|---|
| 프로젝트 · DB 기반 (스키마, RLS, 마이그레이션, 시드) | 완료 |
| Widget API: `POST /v1/widget/bootstrap`, 대화 · 메시지, 작업 목록 · 상세 · 중지, SSE (`Last-Event-ID` 재전송, 응답 스트림 스냅샷) | 완료 |
| 비동기 실행: BullMQ `agent-tasks`, Worker heartbeat, 단계 · checkpoint 저장, 최대 단계 · 시간 제한, 중지 처리 | 완료 |
| LLM 연동: OpenAI 호환 클라이언트(OpenAI · DeepSeek · Gemini), 스트리밍 · tool call 파싱 · 재시도 · 대체 모델 · 역할별 추론 강도 | 완료 — DeepSeek 는 실제 API 로 확인, OpenAI · Gemini 는 키가 없어 단위 테스트(요청 형식)까지만 |
| Agent Loop: Context → Plan → Execute(reason · tool) → Evaluate → 재계획 → Respond(스트리밍) → Verify, 토큰 예산 | 완료 — Skill · Memory 는 아직 없음 |
| Tool Registry · Dispatcher: 작업별 Registry 버전 고정, 인자 검증(zod), 권한 판단(등급 정책 → Tool 재정의 → 조건 규칙), 읽기 Tool 병렬 실행, 시간 제한 · 취소 전파, 멱등 Tool 재시도, `tool_executions` 기록(거부 포함) · 민감정보 마스킹, `tool.called` · `tool.result` · `tool.denied` | 완료 — 내장 Tool 2개(`builtin.calculate`, `builtin.current_time`). 승인 필요 Tool 은 승인 흐름(10단계) 전까지 `approval_required` 로 거부 |
| 비용 계산 (`tasks.cost_amount`) | 다음 단계 — 모델별 단가표 필요. 토큰 수는 기록 중 |
| 승인 결정 · 재개(`resume`) · steer · 업로드 · 산출물 다운로드 | 다음 단계 (명세 §2.4 · §2.5 · §2.6) |
| `agent-recovery` · `approval-expiry` · `memory-ingest` 등 주기 잡 | 다음 단계 (명세 §6) |
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
├── infrastructure/                database(PrismaService.withTenant) · redis(공유 Pub/Sub) · queue · secrets
├── widget/                        bootstrap · identity token 검증 · 세션 토큰(ES256) · 세션 가드 · Origin 검사
├── conversations/                 대화 · 메시지 → 작업 생성
├── tasks/                         작업 조회 · 중지 · SSE 엔드포인트, 계획 · 뷰 타입
├── events/                        task_events 아웃박스 · Redis 발행 · SSE 스트림
├── llm/                           OpenAI 호환 클라이언트 · provider 별 파라미터 · JSON 출력 파싱 · 클라이언트 팩토리
├── agent-runtime/                 Agent Loop · 모델 라우터(역할별 · 대체) · Context · Executor · 프롬프트 · RunContext
├── planner/ · evaluator/          계획 생성 · 수정 / 중간 평가 · 최종 검증
├── tools/                         Tool Registry(버전 스냅샷) · 권한 정책 · Dispatcher · 내장 Tool · 마스킹 · 규칙 조건
├── workers/                       agent-tasks 프로세서 · 작업 실행 수명주기
└── agents/                        실행 · Memory 정책 스키마
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

## 개발 순서 (기획안 12장)

1. NestJS 프로젝트 · DB 기반 ✅
2. Widget 과 SSE 스트리밍 ✅
3. Agent Loop ✅ (OpenAI · DeepSeek · Gemini)
4. Tool Registry · Tool Dispatcher ✅ (내장 Tool, 권한 정책 · 규칙, 병렬 · 재시도 · 시간 제한)
5. MCP 동적 연결 ← 다음
6. SKILL.md Loader
7. BullMQ 비동기 작업 (기본 파이프라인 ✅, 복구 · 주기 잡은 8단계와 함께)
8. Checkpoint · Recovery
9. Memory
10. Permission · Approval
11. Reflection · Context Compression
12. Marketplace · Billing (P2)
