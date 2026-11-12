import type { RunContext } from './run-context.js';

/**
 * Agent Runtime 계약. Worker 는 작업마다 run() 을 한 번 호출한다.
 * AgentLoopRuntime(Context → Plan → Execute → Evaluate → Respond → Verify) 과
 * 파이프라인 확인용 PlaceholderAgentRuntime 이 있다. 재개면 ctx.resume 에 checkpoint 가 있다.
 */
export interface AgentRuntime {
  run(ctx: RunContext): Promise<RunResult>;
}

export interface RunResult {
  messageId: string | null;
  verification: Array<{ label: string; passed: boolean }>;
}

export const AGENT_RUNTIME = Symbol('AGENT_RUNTIME');

/** 사용자가 중지했거나 작업이 취소됨 */
export class TaskCancelledError extends Error {
  constructor() {
    super('작업이 취소되었습니다');
    this.name = 'TaskCancelledError';
  }
}

/** 일시정지 요청 — 현재 단계를 마친 뒤 멈춘다 (checkpoint 유지, 재개 가능) */
export class TaskPausedError extends Error {
  constructor(readonly reason: string) {
    super('작업이 일시정지되었습니다');
    this.name = 'TaskPausedError';
  }
}

/** Worker 종료 · 소유권 상실 — 작업은 실패가 아니라 복구 대상이다 */
export class WorkerStopError extends Error {
  constructor(readonly reason: 'worker_shutdown' | 'ownership_lost') {
    super(
      reason === 'worker_shutdown'
        ? 'Worker 가 종료되어 작업을 넘깁니다'
        : '다른 Worker 가 작업을 가져갔습니다',
    );
    this.name = 'WorkerStopError';
  }
}

/** 사용자에게 보여 줄 수 있는 실행 오류 (task.failed 의 code · message) */
export class RuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeError';
  }
}
