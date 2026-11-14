import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppError, type ErrorCode, type FieldIssue } from './app-error.js';

interface ProblemBody {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  errors?: FieldIssue[];
  traceId?: string;
}

const STATUS_CODES: Record<number, ErrorCode> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  413: 'PAYLOAD_TOO_LARGE',
  429: 'RATE_LIMITED',
};

/** 모든 예외를 RFC 9457 application/problem+json 으로 응답한다. */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request & { traceId?: string }>();

    // SSE 처럼 이미 응답을 보내기 시작했으면 연결만 정리한다.
    if (res.headersSent) {
      this.logger.warn(`응답 전송 중 예외: ${String(exception)}`);
      res.end();
      return;
    }

    const body = this.toProblem(exception);
    body.traceId = req.traceId;
    if (body.status >= 500) {
      this.logger.error(
        exception instanceof Error ? (exception.stack ?? exception.message) : exception,
      );
    }
    res.status(body.status).type('application/problem+json').json(body);
  }

  private toProblem(exception: unknown): ProblemBody {
    if (exception instanceof AppError) {
      return {
        type: problemType(exception.code),
        title: exception.title,
        status: exception.status,
        code: exception.code,
        detail: exception.detail,
        errors: exception.errors,
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = STATUS_CODES[status] ?? 'INTERNAL_ERROR';
      const err = new AppError(status, code, exception.message);
      return { type: problemType(code), title: err.title, status, code, detail: exception.message };
    }
    const err = new AppError(500, 'INTERNAL_ERROR');
    return { type: problemType(err.code), title: err.title, status: 500, code: err.code };
  }
}

function problemType(code: string): string {
  return `urn:theonewidget:problem:${code.toLowerCase().replace(/_/g, '-')}`;
}
