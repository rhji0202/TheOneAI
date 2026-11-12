import { StandardSchemaValidationPipe, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppError } from '../common/errors/app-error.js';
import { ProblemDetailsFilter } from '../common/errors/problem-details.filter.js';
import { traceIdMiddleware } from '../common/http/trace-id.js';

/** main.ts 와 e2e 테스트가 같은 HTTP 설정을 쓰도록 한곳에 둔다. */
export function configureApp(app: NestExpressApplication): NestExpressApplication {
  app.enableShutdownHooks();
  app.disable('x-powered-by');
  app.use(traceIdMiddleware);

  // Widget API 는 고객사 도메인에서 호출된다. 인증은 쿠키가 아니라 Bearer 토큰이므로 Origin 을 반사하고
  // credentials 는 허용하지 않는다. 실제 Origin 검사는 bootstrap(허용 도메인)과 세션 가드(토큰의 org)가 한다.
  // Admin API(refresh 쿠키)를 붙일 때는 콘솔 도메인만 허용하는 별도 정책이 필요하다.
  app.enableCors({
    origin: true,
    credentials: false,
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'Idempotency-Key',
      'Last-Event-ID',
      'traceparent',
    ],
    exposedHeaders: ['X-Trace-Id'],
    maxAge: 600,
  });

  app.enableVersioning({ type: VersioningType.URI });
  app.useGlobalPipes(
    new StandardSchemaValidationPipe({
      exceptionFactory: (issues) =>
        new AppError(
          400,
          'VALIDATION_FAILED',
          undefined,
          issues.map((issue) => ({
            path: (issue.path ?? [])
              .map((segment) => String(typeof segment === 'object' ? segment.key : segment))
              .join('.'),
            message: issue.message,
          })),
        ),
    }),
  );
  app.useGlobalFilters(new ProblemDetailsFilter());
  return app;
}
