-- =============================================================================
-- 001_rls_and_indexes.sql
--
-- Prisma 가 만들지 않는 DB 객체:
--   1) 애플리케이션 역할과 권한
--   2) Tenant 격리 RLS 정책
--   3) 테넌트가 정해지기 전에 필요한 조회용 SECURITY DEFINER 함수
--   4) 부분 · 벡터 인덱스, CHECK 제약
--      (Prisma 는 부분 인덱스 · CHECK 제약을 관리하지 않으므로 이후 마이그레이션에서도 지워지지 않는다.
--       일반 인덱스는 schema.prisma 에 선언해야 한다 — 선언하지 않으면 다음 migrate 에서 DROP 된다.)
--
-- 적용 방법
--   이 내용은 prisma/migrations/*_init/migration.sql 끝에 그대로 포함되어 있다(원본 보관용).
--   새 테넌트 테이블을 추가하면 아래 RLS 목록에 넣은 새 마이그레이션을 만든다.
--   재실행해도 안전하도록 작성했다(idempotent).
--
-- 테넌트 컨텍스트
--   애플리케이션은 트랜잭션마다 아래를 먼저 실행한다 (docs/data-model.md §3).
--     SELECT set_config('app.tenant_id', '<tenant uuid>', true);
--   값이 없으면 app_current_tenant() 가 NULL 이 되어 어떤 행도 보이지 않는다 (fail-closed).
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) 역할
--   app_rw          API 서버 · agent.worker 가 사용하는 역할. RLS 적용 대상.
--   app_maintenance recovery · metrics-rollup · 보존 정리 잡 전용. 테넌트 횡단이 필요해 BYPASSRLS.
--                   아래 SECURITY DEFINER 함수의 소유자이기도 하다.
--   실제 접속 계정은 운영 환경에서 만들고 이 역할을 부여한다:
--     CREATE ROLE theonewidget_api LOGIN PASSWORD '...' IN ROLE app_rw;
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    CREATE ROLE app_rw NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_maintenance') THEN
    CREATE ROLE app_maintenance NOLOGIN BYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO app_rw, app_maintenance;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rw, app_maintenance;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rw, app_maintenance;
-- 마이그레이션 이력 테이블은 애플리케이션이 볼 필요가 없다 (shadow DB 에는 없으므로 존재할 때만).
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    REVOKE ALL ON TABLE "_prisma_migrations" FROM app_rw, app_maintenance;
  END IF;
END $$;

-- 감사 로그는 append-only. 보존 기간 정리는 app_maintenance 만 한다.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_logs FROM app_rw;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) RLS
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'end_users',
    'agents', 'agent_versions', 'providers', 'model_configs',
    'agent_version_mcp_servers', 'agent_version_skills',
    'conversations', 'messages',
    'tasks', 'task_steps', 'task_events',
    'tool_registry_versions', 'mcp_servers', 'mcp_tools', 'tool_executions',
    'tool_policies', 'tool_policy_rules', 'approvals',
    'skills', 'skill_versions',
    'memories', 'artifacts', 'feedbacks',
    'widget_configs', 'audit_logs', 'metrics_daily',
    'eval_cases', 'eval_runs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- 테이블 소유자에게도 RLS 를 적용한다 (소유자 계정으로 앱을 띄우는 실수 방지).
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = app_current_tenant())
         WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_self ON tenants;
CREATE POLICY tenant_self ON tenants
  USING (id = app_current_tenant())
  WITH CHECK (id = app_current_tenant());

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) 테넌트가 정해지기 전에 필요한 조회 (SECURITY DEFINER, 최소 컬럼만 반환)
--    소유자는 BYPASSRLS 역할인 app_maintenance. app_rw 에는 EXECUTE 만 허용한다.
-- ─────────────────────────────────────────────────────────────────────────────

-- 위젯 bootstrap: 공개 키 → 테넌트 · 위젯 설정 (POST /v1/widget/bootstrap)
CREATE OR REPLACE FUNCTION app_resolve_widget(p_public_key text)
  RETURNS TABLE (widget_id uuid, tenant_id uuid, agent_id uuid, allowed_origins text[], identity_mode identity_mode)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT w.id, w.tenant_id, w.agent_id, w.allowed_origins, w.identity_mode
  FROM widget_configs w
  WHERE w.public_key = p_public_key AND w.enabled
$$;

-- 콘솔 로그인: 테넌트 slug → tenant id (POST /v1/admin/auth/login)
CREATE OR REPLACE FUNCTION app_resolve_tenant(p_slug text)
  RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$ SELECT t.id FROM tenants t WHERE t.slug = p_slug $$;

-- recovery.worker: heartbeat 가 끊긴 작업 찾기 (id 와 tenant 만 반환)
CREATE OR REPLACE FUNCTION app_find_stalled_tasks(p_stale_after interval, p_limit int DEFAULT 100)
  RETURNS TABLE (task_id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT t.id, t.tenant_id
  FROM tasks t
  WHERE t.status IN ('running', 'recovering')
    AND t.last_heartbeat_at < now() - p_stale_after
  ORDER BY t.last_heartbeat_at
  LIMIT p_limit
$$;

ALTER FUNCTION app_resolve_widget(text) OWNER TO app_maintenance;
ALTER FUNCTION app_resolve_tenant(text) OWNER TO app_maintenance;
ALTER FUNCTION app_find_stalled_tasks(interval, int) OWNER TO app_maintenance;
REVOKE ALL ON FUNCTION app_resolve_widget(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_resolve_tenant(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_find_stalled_tasks(interval, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_resolve_widget(text) TO app_rw;
GRANT EXECUTE ON FUNCTION app_resolve_tenant(text) TO app_rw;
GRANT EXECUTE ON FUNCTION app_find_stalled_tasks(interval, int) TO app_rw;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) 인덱스 · 제약
-- ─────────────────────────────────────────────────────────────────────────────

-- Agent 당 초안(draft)은 하나
CREATE UNIQUE INDEX IF NOT EXISTS agent_versions_one_draft
  ON agent_versions (agent_id) WHERE status = 'draft';

-- Memory 의미 검색 (코사인 거리). 활성 항목만 색인.
CREATE INDEX IF NOT EXISTS memories_embedding_hnsw
  ON memories USING hnsw (embedding vector_cosine_ops) WHERE status = 'active';

-- 만료 처리 잡이 훑는 대기 중 승인
CREATE INDEX IF NOT EXISTS approvals_pending_expiry
  ON approvals (expires_at) WHERE status = 'pending';

-- scope = user 이면 end_user_id 필수, scope = agent 이면 사용자 정보 없음
ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_scope_end_user_chk;
ALTER TABLE memories ADD CONSTRAINT memories_scope_end_user_chk
  CHECK ((scope = 'user') = (end_user_id IS NOT NULL));

-- 전송 방식별 필수 값
ALTER TABLE mcp_servers DROP CONSTRAINT IF EXISTS mcp_servers_transport_chk;
ALTER TABLE mcp_servers ADD CONSTRAINT mcp_servers_transport_chk
  CHECK (
    (transport = 'streamable_http' AND endpoint_url IS NOT NULL)
    OR (transport = 'stdio_sandbox' AND image IS NOT NULL)
  );

-- 이중 승인 · 사용자 승인 주체 정합성
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_operator_fields_chk;
ALTER TABLE approvals ADD CONSTRAINT approvals_operator_fields_chk
  CHECK ((operator_decision IS NULL) = (operator_id IS NULL));

-- 승인 만료 시간 범위 (1분 ~ 24시간)
ALTER TABLE tool_policies DROP CONSTRAINT IF EXISTS tool_policies_ttl_chk;
ALTER TABLE tool_policies ADD CONSTRAINT tool_policies_ttl_chk
  CHECK (ttl_seconds BETWEEN 60 AND 86400);
