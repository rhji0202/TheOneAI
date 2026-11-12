/** BullMQ 큐 이름과 Job 데이터 (docs/api-spec.md §6). */
export const AGENT_TASKS_QUEUE = 'agent-tasks';

export interface AgentTaskJobData {
  tenantId: string;
  taskId: string;
  mode: 'start' | 'resume';
  fromStepId?: string;
}

/** 등록된 MCP 서버 재탐색 (주기 잡 — 서버별 주기는 MCP_SYNC_INTERVAL_SEC) */
export const MCP_SYNC_QUEUE = 'mcp-sync';
