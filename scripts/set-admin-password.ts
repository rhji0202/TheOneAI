/**
 * 개발용: 콘솔 멤버 비밀번호를 바꾼다 (시드가 만든 Owner 비밀번호를 잊었을 때).
 *   npm run dev:admin-password -- [--email owner@demo.local] [--workspace default] [--password <새 비밀번호>]
 * 비밀번호를 주지 않으면 생성해 출력한다. DATABASE_MIGRATION_URL(소유자 계정)로 접속한다.
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { hashPassword } from '../src/admin/auth/password.js';

const { values } = parseArgs({
  options: {
    email: { type: 'string', default: 'owner@demo.local' },
    workspace: { type: 'string', default: 'default' },
    password: { type: 'string' },
  },
});

if (process.env.NODE_ENV === 'production') {
  console.error('production 에서는 쓸 수 없습니다.');
  process.exit(1);
}
const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_MIGRATION_URL 이 없습니다.');
  process.exit(1);
}

const password = values.password ?? randomBytes(12).toString('base64url');
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const res = await client.query(
    `UPDATE users SET password_hash = $1
       WHERE email = $2 AND tenant_id = (SELECT id FROM tenants WHERE slug = $3)`,
    [await hashPassword(password), values.email, values.workspace],
  );
  if (res.rowCount !== 1) {
    console.error(`${values.workspace} / ${values.email} 계정이 없습니다.`);
    process.exitCode = 1;
  } else if (!values.password) {
    console.log(password);
  } else {
    console.log('비밀번호를 바꿨습니다.');
  }
} finally {
  await client.end();
}
