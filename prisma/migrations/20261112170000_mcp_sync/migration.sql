-- mcp-sync: 재탐색할 MCP 서버 찾기 (테넌트 횡단 — id 와 tenant 만 반환)
--   연결됨 서버는 p_interval 마다, 오류 상태 서버는 더 자주(최대 5분) 다시 확인해 복구를 빨리 감지한다.
CREATE OR REPLACE FUNCTION app_list_mcp_servers_due_for_sync(p_interval interval, p_limit int DEFAULT 20)
  RETURNS TABLE (server_id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT s.id, s.tenant_id
  FROM mcp_servers s
  WHERE s.deleted_at IS NULL
    AND s.status IN ('connected', 'error')
    AND (
      s.last_synced_at IS NULL
      OR s.last_synced_at < now() - CASE
        WHEN s.status = 'error' THEN least(p_interval, interval '5 minutes')
        ELSE p_interval
      END
    )
  ORDER BY s.last_synced_at NULLS FIRST
  LIMIT p_limit
$$;

ALTER FUNCTION app_list_mcp_servers_due_for_sync(interval, int) OWNER TO app_maintenance;
REVOKE ALL ON FUNCTION app_list_mcp_servers_due_for_sync(interval, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_list_mcp_servers_due_for_sync(interval, int) TO app_rw;
