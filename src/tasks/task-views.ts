import type { Prisma, TaskStatus } from '../generated/prisma/client.js';

/** 위젯 홈 · 작업 목록의 “진행 중” */
export const ACTIVE_STATUSES: TaskStatus[] = [
  'queued',
  'running',
  'waiting_approval',
  'recovering',
  'paused',
];
/** 같은 대화에서 새 요청을 막는 상태 (paused 는 새 요청 허용) */
export const BLOCKING_STATUSES: TaskStatus[] = [
  'queued',
  'running',
  'waiting_approval',
  'recovering',
];
export const TERMINAL_STATUSES: TaskStatus[] = ['completed', 'failed', 'cancelled'];

/** 작업 예산(단계 수 · 토큰)을 다 써 실패 — 예산은 작업 전체 기준이라 재개 · 다시 실행해도 바로 다시 실패한다 */
export function isBudgetExhausted(failureCode: string | null): boolean {
  return failureCode === 'STEP_LIMIT_EXCEEDED' || failureCode === 'TOKEN_BUDGET_EXCEEDED';
}

export const TASK_GROUPS = {
  active: ACTIVE_STATUSES,
  completed: ['completed'] as TaskStatus[],
  failed: ['failed', 'cancelled'] as TaskStatus[],
} as const;
export type TaskGroup = keyof typeof TASK_GROUPS;

export const taskSummarySelect = {
  id: true,
  title: true,
  status: true,
  conversationId: true,
  completedSteps: true,
  totalSteps: true,
  failureCode: true,
  failureMessage: true,
  lastCheckpointStepId: true,
  createdAt: true,
  finishedAt: true,
  approvals: {
    where: { status: 'pending' },
    select: { id: true, expiresAt: true },
    orderBy: { createdAt: 'desc' },
    take: 1,
  },
} satisfies Prisma.TaskSelect;

export type TaskSummaryRow = Prisma.TaskGetPayload<{ select: typeof taskSummarySelect }>;

/** docs/api-spec.md §0 TaskSummary */
export interface TaskSummaryView {
  id: string;
  title: string;
  status: TaskStatus;
  progress: { completed: number; total: number | null };
  conversationId: string;
  pendingApproval: { id: string; expiresAt: string } | null;
  failure: { code: string; message: string; resumable: boolean } | null;
  createdAt: string;
  finishedAt: string | null;
}

export function toTaskSummary(task: TaskSummaryRow): TaskSummaryView {
  const approval = task.approvals[0];
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    progress: { completed: task.completedSteps, total: task.totalSteps },
    conversationId: task.conversationId,
    pendingApproval: approval
      ? { id: approval.id, expiresAt: approval.expiresAt.toISOString() }
      : null,
    failure:
      task.status === 'failed'
        ? {
            code: task.failureCode ?? 'RUNTIME_ERROR',
            message: task.failureMessage ?? '',
            resumable: task.lastCheckpointStepId !== null && !isBudgetExhausted(task.failureCode),
          }
        : null,
    createdAt: task.createdAt.toISOString(),
    finishedAt: task.finishedAt?.toISOString() ?? null,
  };
}
