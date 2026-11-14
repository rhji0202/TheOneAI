-- 콘솔 로그인 · 워크스페이스 전환: 이 이메일이 활성 멤버인 워크스페이스 (테넌트 횡단 — SECURITY DEFINER 로만)
--   로그인은 이 목록의 각 워크스페이스 계정과 비밀번호를 대조하고, 맞은 곳만 토큰에 넣어 비밀번호 없이 오가게 한다.
CREATE OR REPLACE FUNCTION app_member_workspaces(p_email text)
  RETURNS TABLE (tenant_id uuid, slug text, name text, role text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT t.id, t.slug, t.name, u.role::text
  FROM users u
  JOIN tenants t ON t.id = u.tenant_id
  WHERE u.email = lower(p_email) AND u.disabled_at IS NULL
$$;

ALTER FUNCTION app_member_workspaces(text) OWNER TO app_maintenance;
REVOKE ALL ON FUNCTION app_member_workspaces(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_member_workspaces(text) TO app_rw;
