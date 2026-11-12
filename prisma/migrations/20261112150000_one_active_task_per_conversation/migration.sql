-- 같은 대화에서 동시에 진행되는 작업은 하나뿐이다 (동시 요청 경쟁 방지).
-- paused 는 새 요청을 막지 않는다 (src/tasks/task-views.ts BLOCKING_STATUSES 와 동일).
-- 부분 인덱스는 Prisma 가 관리하지 않으므로 이후 migrate 에서 지워지지 않는다.
CREATE UNIQUE INDEX IF NOT EXISTS tasks_one_active_per_conversation
  ON tasks (conversation_id)
  WHERE status IN ('queued', 'running', 'waiting_approval', 'recovering');
