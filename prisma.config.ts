// Prisma 7 설정. 접속 URL 은 스키마가 아니라 여기서 주입한다.
import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // 마이그레이션 전용 계정(테이블 소유자). 애플리케이션은 app_rw 역할 계정(DATABASE_URL)으로 접속한다.
    url: env('DATABASE_MIGRATION_URL'),
  },
});
