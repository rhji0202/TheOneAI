import { defineConfig } from 'vitest/config';
import { testEnv } from './test/test-env.js';

// e2e 는 실제 PostgreSQL(pgvector) · Redis 가 필요하다 (docker compose up -d). 테스트 DB 는 매번 새로 만든다.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    globalSetup: ['./test/global-setup.ts'],
    env: testEnv,
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 90_000,
  },
});
