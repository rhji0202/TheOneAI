/** BullMQ 큐 이름과 Job 데이터 (docs/api-spec.md §6). */
export const AGENT_TASKS_QUEUE = 'agent-tasks';

export interface AgentTaskJobData {
  tenantId: string;
  taskId: string;
  mode: 'start' | 'resume';
  fromStepId?: string;
}
