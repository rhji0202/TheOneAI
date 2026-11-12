import { randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const TRACE_ID = /^[0-9a-f]{32}$/;

/**
 * 요청마다 trace id 를 정한다. W3C traceparent 가 있으면 그 trace-id 를, 없으면 새로 만든다.
 * OpenTelemetry 연동 시 SDK 의 활성 span 값으로 대체한다.
 */
export function traceIdMiddleware(
  req: Request & { traceId?: string },
  res: Response,
  next: NextFunction,
): void {
  const fromHeader = req.header('traceparent')?.split('-')[1];
  const traceId =
    fromHeader && TRACE_ID.test(fromHeader) ? fromHeader : randomBytes(16).toString('hex');
  req.traceId = traceId;
  res.setHeader('X-Trace-Id', traceId);
  next();
}
