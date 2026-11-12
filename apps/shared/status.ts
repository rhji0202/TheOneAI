/** 작업 상태 배지 — 위젯과 콘솔이 같은 색 · 문구를 쓴다 (docs/screen-design.md 공통 규칙) */
export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'paused'
  | 'recovering'
  | 'completed'
  | 'failed'
  | 'cancelled';

export const TASK_STATUS: Record<TaskStatus, { label: string; bg: string; fg: string }> = {
  queued: { label: '대기', bg: '#F3F4F6', fg: '#4B5563' },
  running: { label: '실행 중', bg: '#DBEAFE', fg: '#1D4ED8' },
  waiting_approval: { label: '승인 대기', bg: '#FEF3C7', fg: '#92400E' },
  paused: { label: '일시정지', bg: '#E5E7EB', fg: '#374151' },
  recovering: { label: '복구 중', bg: '#EDE9FE', fg: '#6D28D9' },
  completed: { label: '완료', bg: '#DCFCE7', fg: '#166534' },
  failed: { label: '실패', bg: '#FEE2E2', fg: '#B91C1C' },
  cancelled: { label: '취소', bg: '#F3F4F6', fg: '#4B5563' },
};

export const ACTIVE_STATUSES: TaskStatus[] = [
  'queued',
  'running',
  'waiting_approval',
  'paused',
  'recovering',
];

export function statusOf(value: string): { label: string; bg: string; fg: string } {
  return TASK_STATUS[value as TaskStatus] ?? { label: value, bg: '#F3F4F6', fg: '#4B5563' };
}

export const RISK: Record<string, { label: string; bg: string; fg: string }> = {
  low: { label: '낮음', bg: '#DCFCE7', fg: '#166534' },
  medium: { label: '중간', bg: '#FEF3C7', fg: '#92400E' },
  high: { label: '높음', bg: '#FEE2E2', fg: '#B91C1C' },
};

export const LEVEL: Record<string, string> = {
  read: '읽기',
  write: '쓰기',
  external_send: '외부 전송',
  delete: '삭제',
  financial: '금융',
};
