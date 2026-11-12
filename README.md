# TheOneAI — Embedded AI Agent Widget

웹사이트에 임베딩되는 단일 Agent 플랫폼. 사용자의 요청을 스스로 계획하고, MCP Tool 과 SKILL.md 기반 Skill 로 실행하며, 위험 작업은 사람의 승인을 받는다.

| 영역 | 기술 |
|---|---|
| Backend | NestJS + TypeScript |
| Frontend (Widget · Console) | React + TypeScript |
| Agent Runtime | 자체 TypeScript Runtime (Context → Plan → Execute → Observe → Evaluate) |
| 확장 | MCP (Tool) · SKILL.md (Skill) |
| DB | PostgreSQL 16 + pgvector · Prisma 7 |
| Queue · Cache | Redis + BullMQ |
| Streaming | SSE |
| Sandbox · Storage | Docker Worker · S3 호환 |
| Monitoring | OpenTelemetry |

## 문서

| 문서 | 내용 |
|---|---|
| [docs/screen-design.md](docs/screen-design.md) | 화면 설계 v1.0 (Widget 5 · Console 9) — 캔버스 링크 포함 |
| [docs/api-spec.md](docs/api-spec.md) | NestJS API 명세 v0.1 — 인증, Widget · Admin API, SSE 이벤트, 오류 코드, BullMQ 큐, 모듈 구성 |
| [docs/data-model.md](docs/data-model.md) | 데이터 모델 v0.1 — 테이블, RLS, JSON 컬럼 형식, 설계 결정 |
| [prisma/schema.prisma](prisma/schema.prisma) | Prisma 스키마 (31 테이블) |
| [prisma/sql/001_rls_and_indexes.sql](prisma/sql/001_rls_and_indexes.sql) | RLS 정책 · DB 역할 · SECURITY DEFINER 함수 · 부분/벡터 인덱스 · CHECK 제약 |

## 데이터베이스 준비 (NestJS 프로젝트 생성 후)

```bash
npm i -D prisma@7 && npm i @prisma/client@7 dotenv

# .env
#   DATABASE_MIGRATION_URL  마이그레이션 계정 (테이블 소유자)
#   DATABASE_URL            애플리케이션 계정 (app_rw 역할)

npx prisma migrate dev --create-only --name init
# prisma/migrations/<timestamp>_init/migration.sql 끝에 prisma/sql/001_rls_and_indexes.sql 내용을 붙여 넣는다
npx prisma migrate dev
npx prisma generate      # → src/generated/prisma
```

PostgreSQL 에 `vector` · `pg_trgm` 확장이 설치되어 있어야 한다.

## 개발 순서 (기획안 12장)

1. NestJS 프로젝트 · DB 기반 ← 스키마 준비됨
2. Widget 과 SSE 스트리밍
3. Agent Loop
4. Tool Registry · Tool Dispatcher
5. MCP 동적 연결
6. SKILL.md Loader
7. BullMQ 비동기 작업
8. Checkpoint · Recovery
9. Memory
10. Permission · Approval
11. Reflection · Context Compression
12. Marketplace · Billing (P2)
