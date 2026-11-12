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
cp .env.example .env
docker compose up -d            # PostgreSQL 16 + pgvector, Redis
npm install                     # postinstall 에서 Prisma Client 생성 → src/generated/prisma
npm run db:setup                # 마이그레이션 + 개발용 앱 계정(app_rw) + 데모 테넌트 시드

npm run start:dev               # API   http://localhost:3000
npm run start:worker:dev        # Agent Worker (다른 터미널)
```

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

## 구현 현황

| 범위 | 상태 |
|---|---|
| 프로젝트 · DB 기반 (스키마, RLS, 마이그레이션, 시드) | 완료 |
| Widget API: `POST /v1/widget/bootstrap`, 대화 · 메시지, 작업 목록 · 상세 · 중지, SSE (`Last-Event-ID` 재전송, 응답 스트림 스냅샷) | 완료 |
| 비동기 실행: BullMQ `agent-tasks`, Worker heartbeat, 단계 · checkpoint 저장, 최대 단계 · 시간 제한, 중지 처리 | 완료 |
| Agent Runtime | **임시 구현** (`PlaceholderAgentRuntime`) — LLM · Tool 없이 파이프라인만 검증. `AGENT_RUNTIME` 토큰 뒤에서 Agent Loop 로 교체 |
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
├── agent-runtime/                 AgentRuntime 계약 · RunContext · 임시 런타임
├── workers/                       agent-tasks 프로세서 · 작업 실행 수명주기
└── agents/                        실행 · Memory 정책 스키마
```

## 개발 순서 (기획안 12장)

1. NestJS 프로젝트 · DB 기반 ✅
2. Widget 과 SSE 스트리밍 ✅
3. Agent Loop ← 다음
4. Tool Registry · Tool Dispatcher
5. MCP 동적 연결
6. SKILL.md Loader
7. BullMQ 비동기 작업 (기본 파이프라인 ✅, 복구 · 주기 잡은 8단계와 함께)
8. Checkpoint · Recovery
9. Memory
10. Permission · Approval
11. Reflection · Context Compression
12. Marketplace · Billing (P2)
