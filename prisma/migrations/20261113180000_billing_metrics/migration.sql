-- Billing · Metrics (개발 순서 12단계)

ALTER TABLE "tenants" ADD COLUMN "monthly_budget" DECIMAL(14,4);
ALTER TABLE "tenants" ADD COLUMN "budget_currency" CHAR(3) NOT NULL DEFAULT 'USD';
ALTER TABLE "metrics_daily" ADD COLUMN "aggregated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now();

CREATE TABLE "model_prices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "provider_kind" "provider_kind" NOT NULL,
    "model" TEXT NOT NULL,
    "input_per_mtok" DECIMAL(12,6) NOT NULL,
    "cached_input_per_mtok" DECIMAL(12,6),
    "output_per_mtok" DECIMAL(12,6) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "model_prices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "model_prices_tenant_id_provider_kind_model_key" ON "model_prices"("tenant_id", "provider_kind", "model");
ALTER TABLE "model_prices" ADD CONSTRAINT "model_prices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "usage_records" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "task_id" UUID,
    "purpose" TEXT NOT NULL,
    "role" "model_role" NOT NULL,
    "provider_kind" "provider_kind" NOT NULL,
    "model" TEXT NOT NULL,
    "calls" INTEGER NOT NULL,
    "input_tokens" INTEGER NOT NULL,
    "cached_input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL,
    "cost_amount" DECIMAL(16,8) NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "priced" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "usage_records_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "usage_records_tenant_id_created_at_idx" ON "usage_records"("tenant_id", "created_at");
CREATE INDEX "usage_records_task_id_idx" ON "usage_records"("task_id");
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 테넌트 격리 (init 과 같은 정책)
GRANT SELECT, INSERT, UPDATE, DELETE ON "model_prices", "usage_records" TO app_rw, app_maintenance;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['model_prices', 'usage_records'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = app_current_tenant())
         WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;

-- metrics-rollup: p_since 이후(UTC 날짜) 의 일별 지표를 다시 계산한다 (테넌트 횡단 — SECURITY DEFINER 로만)
--  tasks_*      : 그날 만든 작업 (성공 = completed, 실패 = failed)
--  tool_*       : 그날 시작한 Tool 실행 — tool_calls 는 실제 실행(거부 제외), tool_denied 는 무단 호출(unknown_tool · not_allowed · blocked_*)
--  recoveries_* : 복구된 적 있는 작업 수 · 그중 완료된 수
--  human_interventions : 승인 요청 + 사용자 · 운영자의 재개 요청
CREATE OR REPLACE FUNCTION app_rollup_metrics(p_since date)
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  affected integer;
BEGIN
  WITH t AS (
    SELECT tenant_id, agent_id, (created_at AT TIME ZONE 'UTC')::date AS d,
           count(*) AS total,
           count(*) FILTER (WHERE status = 'completed') AS ok,
           count(*) FILTER (WHERE status = 'failed') AS failed,
           count(*) FILTER (WHERE recovery_count > 0) AS rec_attempted,
           count(*) FILTER (WHERE recovery_count > 0 AND status = 'completed') AS rec_ok,
           coalesce(sum(input_tokens), 0) AS itok,
           coalesce(sum(output_tokens), 0) AS otok,
           coalesce(sum(cost_amount), 0) AS cost,
           coalesce(sum(CASE WHEN status IN ('completed', 'failed') AND started_at IS NOT NULL AND finished_at IS NOT NULL
                             THEN (extract(epoch FROM finished_at - started_at) * 1000)::bigint ELSE 0 END), 0) AS dur
    FROM tasks
    WHERE created_at >= p_since
    GROUP BY 1, 2, 3
  ), x AS (
    SELECT t.tenant_id, t.agent_id, (e.started_at AT TIME ZONE 'UTC')::date AS d,
           count(*) FILTER (WHERE e.status <> 'denied') AS calls,
           count(*) FILTER (WHERE e.status = 'succeeded') AS ok,
           count(*) FILTER (WHERE e.status = 'denied'
                              AND e.denied_reason IN ('unknown_tool', 'not_allowed', 'blocked_by_policy', 'blocked_by_rule')) AS denied
    FROM tool_executions e JOIN tasks t ON t.id = e.task_id
    WHERE e.started_at >= p_since
    GROUP BY 1, 2, 3
  ), h AS (
    SELECT tenant_id, agent_id, d, sum(n) AS n FROM (
      SELECT t.tenant_id, t.agent_id, (a.created_at AT TIME ZONE 'UTC')::date AS d, count(*) AS n
      FROM approvals a JOIN tasks t ON t.id = a.task_id
      WHERE a.created_at >= p_since
      GROUP BY 1, 2, 3
      UNION ALL
      SELECT t.tenant_id, t.agent_id, (ev.created_at AT TIME ZONE 'UTC')::date, count(*)
      FROM task_events ev JOIN tasks t ON t.id = ev.task_id
      WHERE ev.type = 'task.status'
        AND ev.payload->>'reason' IN ('resume_requested', 'restart_requested')
        AND ev.created_at >= p_since
      GROUP BY 1, 2, 3
    ) s
    GROUP BY 1, 2, 3
  ), k AS (
    SELECT tenant_id, agent_id, d FROM t
    UNION SELECT tenant_id, agent_id, d FROM x
    UNION SELECT tenant_id, agent_id, d FROM h
  )
  INSERT INTO metrics_daily AS m (
    tenant_id, agent_id, date, tasks_total, tasks_succeeded, tasks_failed, tool_calls, tool_succeeded,
    tool_denied, recoveries_attempted, recoveries_succeeded, human_interventions, input_tokens,
    output_tokens, cost_amount, total_duration_ms, aggregated_at
  )
  SELECT k.tenant_id, k.agent_id, k.d,
         coalesce(t.total, 0), coalesce(t.ok, 0), coalesce(t.failed, 0),
         coalesce(x.calls, 0), coalesce(x.ok, 0), coalesce(x.denied, 0),
         coalesce(t.rec_attempted, 0), coalesce(t.rec_ok, 0), coalesce(h.n, 0),
         coalesce(t.itok, 0), coalesce(t.otok, 0), coalesce(t.cost, 0), coalesce(t.dur, 0), now()
  FROM k
  LEFT JOIN t ON t.tenant_id = k.tenant_id AND t.agent_id = k.agent_id AND t.d = k.d
  LEFT JOIN x ON x.tenant_id = k.tenant_id AND x.agent_id = k.agent_id AND x.d = k.d
  LEFT JOIN h ON h.tenant_id = k.tenant_id AND h.agent_id = k.agent_id AND h.d = k.d
  ON CONFLICT (tenant_id, agent_id, date) DO UPDATE SET
    tasks_total = EXCLUDED.tasks_total,
    tasks_succeeded = EXCLUDED.tasks_succeeded,
    tasks_failed = EXCLUDED.tasks_failed,
    tool_calls = EXCLUDED.tool_calls,
    tool_succeeded = EXCLUDED.tool_succeeded,
    tool_denied = EXCLUDED.tool_denied,
    recoveries_attempted = EXCLUDED.recoveries_attempted,
    recoveries_succeeded = EXCLUDED.recoveries_succeeded,
    human_interventions = EXCLUDED.human_interventions,
    input_tokens = EXCLUDED.input_tokens,
    output_tokens = EXCLUDED.output_tokens,
    cost_amount = EXCLUDED.cost_amount,
    total_duration_ms = EXCLUDED.total_duration_ms,
    aggregated_at = EXCLUDED.aggregated_at;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END
$$;

ALTER FUNCTION app_rollup_metrics(date) OWNER TO app_maintenance;
REVOKE ALL ON FUNCTION app_rollup_metrics(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_rollup_metrics(date) TO app_rw;
