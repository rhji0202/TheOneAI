-- 승인 흐름 (개발 순서 10단계)
ALTER TABLE "approvals" ADD COLUMN "summary" TEXT NOT NULL DEFAULT '';
ALTER TABLE "approvals" ADD COLUMN "consumed_at" TIMESTAMPTZ(3);

ALTER TABLE "tool_executions" ADD COLUMN "approval_id" UUID;
ALTER TABLE "tool_executions"
  ADD CONSTRAINT "tool_executions_approval_id_fkey"
  FOREIGN KEY ("approval_id") REFERENCES "approvals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 승인 판단: 작업 · Tool 별 최근 승인
CREATE INDEX IF NOT EXISTS "approvals_task_id_tool_name_idx" ON "approvals" ("task_id", "tool_name");

-- approval-expiry: 만료된 대기 승인 (테넌트 횡단 — SECURITY DEFINER 로만)
CREATE OR REPLACE FUNCTION app_find_expired_approvals(p_limit int DEFAULT 100)
  RETURNS TABLE (approval_id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT a.id, a.tenant_id
  FROM approvals a
  WHERE a.status = 'pending' AND a.expires_at <= now()
  ORDER BY a.expires_at
  LIMIT p_limit
$$;

ALTER FUNCTION app_find_expired_approvals(int) OWNER TO app_maintenance;
REVOKE ALL ON FUNCTION app_find_expired_approvals(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_find_expired_approvals(int) TO app_rw;
