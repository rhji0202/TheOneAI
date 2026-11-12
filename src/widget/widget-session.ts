import type { Request } from 'express';

/** 위젯 세션 토큰에서 꺼낸 호출자 정보. 모든 Widget API 는 이 범위 안에서만 동작한다. */
export interface WidgetSession {
  tenantId: string;
  widgetId: string;
  agentId: string;
  endUserId: string;
  anonymous: boolean;
  /** bootstrap 시점의 Origin. 이후 요청의 Origin 과 비교한다. */
  origin: string | null;
}

export type WidgetRequest = Request & { widgetSession?: WidgetSession; traceId?: string };
