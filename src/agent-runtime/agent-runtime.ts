import type { RunContext } from './run-context.js';

/**
 * Agent Runtime 계약. Worker 는 작업마다 run() 을 한 번 호출한다.
 * 현재 구현은 PlaceholderAgentRuntime (파이프라인 검증용). 개발 순서 3단계에서
 * Context → Plan → Execute → Observe → Evaluate 를 수행하는 AgentLoop 로 교체한다.
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
