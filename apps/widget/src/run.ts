import { useEffect, useReducer, useRef } from 'react';
import { openSse, type SseMessage } from '../../shared/sse';
import type { ApprovalView, MessageView, PlanStep, TaskDetail, TaskResult, WidgetApi } from './api';

export interface ToolChip {
  executionId: string;
  toolName: string;
  status: 'running' | 'succeeded' | 'failed' | 'timeout' | 'denied';
  attempt?: number;
  preview?: string | null;
  reason?: string;
}

export interface RunState {
  loaded: boolean;
  status: string;
  title: string;
  statusReason: string | null;
  plan: { version: number; steps: PlanStep[]; revisedReason: string | null } | null;
  revisions: Array<{ version: number; reason: string }>;
  tools: ToolChip[];
  stream: { messageId: string; text: string } | null;
  approval: ApprovalView | null;
  result: TaskResult | null;
  failure: { code: string; message: string; resumable: boolean } | null;
  connection: 'connecting' | 'open' | 'reconnecting' | 'closed';
  /** step.started 의 seq → 계획 카드에 반영하는 단계인가 (step.completed 에는 종류가 없다) */
  trackedSeqs: Record<number, boolean>;
}

type Action =
  | { type: 'reset' }
  | { type: 'loaded'; detail: TaskDetail }
  | { type: 'event'; message: SseMessage }
  | { type: 'connection'; status: RunState['connection'] }
  | { type: 'approval'; approval: ApprovalView | null };

const initial: RunState = {
  loaded: false,
  status: 'queued',
  title: '',
  statusReason: null,
  plan: null,
  revisions: [],
  tools: [],
  stream: null,
  approval: null,
  result: null,
  failure: null,
  connection: 'connecting',
  trackedSeqs: {},
};

function withStepStatus(plan: NonNullable<RunState['plan']>, index: number, status: string) {
  return { ...plan, steps: plan.steps.map((s) => (s.index === index ? { ...s, status } : s)) };
}

function reduce(state: RunState, action: Action): RunState {
  switch (action.type) {
    case 'reset':
      return initial;
    case 'loaded':
      return {
        ...state,
        loaded: true,
        status: action.detail.status,
        title: action.detail.title,
        plan: action.detail.plan,
        approval: action.detail.pendingApproval,
        result: action.detail.result,
        failure: action.detail.failure,
      };
    case 'connection':
      return { ...state, connection: action.status };
    case 'approval':
      return { ...state, approval: action.approval };
    case 'event':
      return applyEvent(state, action.message);
  }
}

function applyEvent(state: RunState, { event, data }: SseMessage): RunState {
  const d = (data ?? {}) as Record<string, unknown>;
  switch (event) {
    case 'task.status':
      return {
        ...state,
        status: String(d.status),
        statusReason: typeof d.reason === 'string' ? d.reason : null,
        ...(d.status === 'queued' || d.status === 'running' ? { failure: null } : {}),
      };
    case 'task.recovering':
      return { ...state, status: 'recovering' };
    case 'task.resumed':
      return { ...state, status: 'running' };
    case 'plan.created':
    case 'plan.revised': {
      const steps = (d.steps ?? []) as PlanStep[];
      const version = Number(d.planVersion ?? 1);
      return {
        ...state,
        plan: { version, steps, revisedReason: typeof d.reason === 'string' ? d.reason : null },
        revisions:
          event === 'plan.revised'
            ? [...state.revisions, { version, reason: String(d.reason ?? '') }]
            : state.revisions,
      };
    }
    case 'step.started': {
      // Tool 호출 단계는 계획 카드 상태를 바꾸지 않는다 (서버의 trackPlan=false 와 같게)
      const tracked = d.type !== 'tool' && d.planIndex != null;
      const seqs = { ...state.trackedSeqs, [Number(d.seq)]: tracked };
      if (!tracked || !state.plan) return { ...state, trackedSeqs: seqs };
      return {
        ...state,
        trackedSeqs: seqs,
        plan: withStepStatus(state.plan, Number(d.planIndex), 'running'),
      };
    }
    case 'step.completed': {
      if (!state.plan || d.planIndex == null || !state.trackedSeqs[Number(d.seq)]) return state;
      return {
        ...state,
        plan: withStepStatus(state.plan, Number(d.planIndex), String(d.status ?? 'succeeded')),
      };
    }
    case 'tool.called':
      return {
        ...state,
        tools: [
          ...state.tools,
          {
            executionId: String(d.executionId),
            toolName: String(d.toolName),
            status: 'running',
            preview: (d.argsPreview as string) ?? null,
          },
        ],
      };
    case 'tool.result':
      return {
        ...state,
        tools: state.tools.map((t) =>
          t.executionId === d.executionId
            ? {
                ...t,
                status: d.status as ToolChip['status'],
                attempt: Number(d.attempt ?? 1),
                preview: (d.resultPreview as string) ?? t.preview,
              }
            : t,
        ),
      };
    case 'tool.denied':
      return {
        ...state,
        tools: [
          ...state.tools,
          {
            executionId: String(d.executionId),
            toolName: String(d.toolName),
            status: 'denied',
            reason: String(d.reason ?? ''),
            preview: (d.message as string) ?? null,
          },
        ],
      };
    case 'approval.required':
    case 'approval.updated':
      return { ...state, approval: d.approval as ApprovalView };
    case 'approval.resolved':
      return state.approval?.id === d.approvalId ? { ...state, approval: null } : state;
    case 'message.delta': {
      const messageId = String(d.messageId);
      const prev = state.stream?.messageId === messageId ? state.stream.text : '';
      return { ...state, stream: { messageId, text: prev + String(d.text ?? '') } };
    }
    case 'message.snapshot':
      return { ...state, stream: { messageId: String(d.messageId), text: String(d.text ?? '') } };
    case 'message.completed':
      return { ...state, stream: null };
    case 'task.completed':
      return { ...state, status: 'completed', result: d.result as TaskResult, approval: null };
    case 'task.failed':
      return {
        ...state,
        status: 'failed',
        failure: {
          code: String(d.code),
          message: String(d.message),
          resumable: Boolean(d.resumable),
        },
        stream: null,
      };
    default:
      return state;
  }
}

/** 작업 1건 — 상세로 시작하고 SSE(Last-Event-ID 이후)로 이어서 받는다 */
export function useTaskRun(
  api: WidgetApi,
  taskId: string | null,
  handlers: { onMessage?: (m: MessageView) => void; onTerminal?: (status: string) => void } = {},
  /** 바꾸면 다시 구독한다 (재개 뒤 등) */
  version = 0,
) {
  const [state, dispatch] = useReducer(reduce, initial);
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    dispatch({ type: 'reset' });
    if (!taskId) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      const detail = await api.task(taskId).catch(() => null);
      if (cancelled || !detail) return;
      dispatch({ type: 'loaded', detail });
      if (['completed', 'failed', 'cancelled'].includes(detail.status)) {
        dispatch({ type: 'connection', status: 'closed' });
        return;
      }
      stop = openSse({
        url: api.eventsUrl(taskId),
        token: () => api.token,
        lastEventId: detail.lastEventId,
        reconnectOnEnd: false,
        onStatus: (status) => dispatch({ type: 'connection', status }),
        onEvent: (message) => {
          dispatch({ type: 'event', message });
          if (message.event === 'message.completed') {
            const m = (message.data as { message?: MessageView }).message;
            if (m) ref.current.onMessage?.(m);
          }
          if (message.event === 'task.completed') ref.current.onTerminal?.('completed');
          if (message.event === 'task.failed') ref.current.onTerminal?.('failed');
          if (message.event === 'task.status') {
            const status = (message.data as { status?: string }).status;
            if (status === 'cancelled' || status === 'waiting_approval' || status === 'paused')
              ref.current.onTerminal?.(status);
          }
        },
      });
    })();
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [api, taskId, version]);

  return {
    state,
    setApproval: (approval: ApprovalView | null) => dispatch({ type: 'approval', approval }),
  };
}
