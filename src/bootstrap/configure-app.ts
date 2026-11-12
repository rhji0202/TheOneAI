import { StandardSchemaValidationPipe, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
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

  // 첨부 내용(PUT /v1/uploads/:id/content)은 형식과 상관없이 바이트 그대로 받는다 (JSON 파일이 파싱되지 않도록 먼저)
  app.use(/^\/v1\/uploads\/[^/]+\/content$/, express.raw({ type: () => true, limit: '50mb' }));

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
  serveUi(app);
  return app;
}

/**
 * 빌드한 화면을 API 서버가 함께 서빙한다 (CDN 앞단에 두는 것을 권장).
 *  - /widget/v1/loader.js : 고객사 페이지에 넣는 위젯 로더 (짧은 캐시), 나머지 파일은 내용 해시 이름이라 오래 캐시
 *  - /console/            : 콘솔 SPA — 파일이 아니면 index.html (클라이언트 라우팅)
 */
function serveUi(app: NestExpressApplication): void {
  const { ui } = app.get<AppConfig>(APP_CONFIG);
  const widgetDir = resolve(ui.widgetDir);
  if (existsSync(join(widgetDir, 'loader.js'))) {
    app.use(
      '/widget/v1',
      express.static(widgetDir, {
        index: false,
        setHeaders: (res, path) => {
          res.setHeader(
            'Cache-Control',
            path.endsWith('loader.js') || path.endsWith('.html')
              ? 'public, max-age=300'
              : 'public, max-age=31536000, immutable',
          );
          res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        },
      }),
    );
  }
  const consoleDir = resolve(ui.consoleDir);
  const consoleIndex = join(consoleDir, 'index.html');
  if (existsSync(consoleIndex)) {
    app.use(
      '/console',
      express.static(consoleDir, { index: false, maxAge: '1y', immutable: true }),
    );
    app.use(/^\/console(\/.*)?$/, (req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(consoleIndex);
    });
  }
}
