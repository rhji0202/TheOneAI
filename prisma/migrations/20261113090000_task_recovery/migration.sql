-- 작업 복구 횟수 (agent-recovery · Worker 종료 시 재투입)
ALTER TABLE "tasks" ADD COLUMN "recovery_count" INTEGER NOT NULL DEFAULT 0;
