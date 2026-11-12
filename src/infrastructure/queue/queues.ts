/** BullMQ 큐 이름과 Job 데이터 (docs/api-spec.md §6). */
export const AGENT_TASKS_QUEUE = 'agent-tasks';

export interface AgentTaskJobData {
  tenantId: string;
  taskId: string;
  mode: 'start' | 'resume';
  /** resume: 이 단계의 checkpoint 부터 (없으면 마지막 checkpoint) */
  fromStepId?: string;
  /** resume: checkpoint 를 쓰지 않고 처음부터 (단계 기록은 유지) */
  restart?: boolean;
}

/** 등록된 MCP 서버 재탐색 (주기 잡 — 서버별 주기는 MCP_SYNC_INTERVAL_SEC) */
export const MCP_SYNC_QUEUE = 'mcp-sync';

/** 작업 완료 후 기억 추출 · 저장 */
export const MEMORY_INGEST_QUEUE = 'memory-ingest';
export interface MemoryIngestJobData {
  tenantId: string;
  taskId: string;
}

/** 만료된 승인 요청 → expired, 작업 paused (주기 잡) */
export const APPROVAL_EXPIRY_QUEUE = 'approval-expiry';

/** heartbeat 가 끊긴 작업을 찾아 재투입 (주기 잡) */
export const AGENT_RECOVERY_QUEUE = 'agent-recovery';

/** 같은 작업의 재개 · 복구 Job 은 매번 다른 id (BullMQ 는 완료된 같은 id 를 다시 받지 않는다) */
export function resumeJobId(
  taskId: string,
  kind: 'resume' | 'recover',
  n: number | string,
): string {
  return `${taskId}:${kind}:${n}`;
}
