-- 삭제(보관)한 Agent 의 이름은 다시 쓸 수 있다: 이름 유니크는 보관되지 않은 Agent 끼리만
DROP INDEX "agents_tenant_id_name_key";
CREATE UNIQUE INDEX agents_tenant_id_name_active_key ON agents (tenant_id, name) WHERE archived_at IS NULL;
