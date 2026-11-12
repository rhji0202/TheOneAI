/**
 * e2e 테스트 환경. 기본값은 docker-compose.yml 의 로컬 인프라를 가정한다.
 *  - TEST_DATABASE_ADMIN_URL: 테스트 DB 를 만들고 지울 계정 (기본: theoneai_owner @ postgres DB)
 *  - TEST_REDIS_URL: 테스트 전용 Redis DB (기본: 15번, 시작 시 비움)
 */
const ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ??
  'postgresql://theoneai_owner:theoneai_owner@localhost:5432/postgres';

export const TEST_DB_NAME = 'theoneai_e2e';
export const TEST_ADMIN_URL = ADMIN_URL;
export const TEST_OWNER_URL = withDatabase(ADMIN_URL, TEST_DB_NAME);
export const TEST_APP_URL =
  process.env.TEST_DATABASE_URL ??
  `postgresql://theoneai_app:theoneai_app@${new URL(ADMIN_URL).host}/${TEST_DB_NAME}`;
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';

export const WIDGET_A = {
  publicKey: 'wk_pub_e2e_a',
  secretRef: 'vault://widgets/e2e-a',
  secret: 'e2e-secret-a',
  origin: 'https://app.example.com',
};
export const WIDGET_B = {
  publicKey: 'wk_pub_e2e_b',
  secretRef: 'vault://widgets/e2e-b',
  secret: 'e2e-secret-b',
  origin: 'https://shop.example.org',
};

export const testEnv: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: TEST_APP_URL,
  DATABASE_MIGRATION_URL: TEST_OWNER_URL,
  REDIS_URL: TEST_REDIS_URL,
  SECRETS_BACKEND: 'local',
  DEV_SECRETS: JSON.stringify({
    [WIDGET_A.secretRef]: WIDGET_A.secret,
    [WIDGET_B.secretRef]: WIDGET_B.secret,
  }),
  WIDGET_SESSION_PRIVATE_KEY: '',
  PLACEHOLDER_STREAM_DELAY_MS: '20',
  WORKER_CONCURRENCY: '4',
};

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}
