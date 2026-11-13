import { execSync } from 'node:child_process';
import { PrismaPg } from '@prisma/adapter-pg';
import { Redis } from 'ioredis';
import pg from 'pg';
import { ensureAppLogin } from '../prisma/seed.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { redisOptionsFromUrl } from '../src/infrastructure/redis/redis-options.js';
import {
  TEST_ADMIN_URL,
  TEST_APP_URL,
  TEST_DB_NAME,
  TEST_OWNER_URL,
  TEST_REDIS_URL,
} from './test-env.js';

/** 테스트 DB 를 새로 만들고 실제 마이그레이션(RLS 포함)을 적용한다. */
export default async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: TEST_ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB_NAME}`);
  await admin.end();

  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_MIGRATION_URL: TEST_OWNER_URL },
    stdio: 'pipe',
  });

  const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_OWNER_URL }) });
  await ensureAppLogin(owner, TEST_APP_URL);
  await owner.$disconnect();

  const redis = new Redis(redisOptionsFromUrl(TEST_REDIS_URL));
  await redis.flushdb();
  await redis.quit();
}
