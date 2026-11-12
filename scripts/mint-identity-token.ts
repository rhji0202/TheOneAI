/**
 * 개발용: 고객사 서버 역할을 대신해 위젯 identity token(HS256)을 발급한다.
 *   npm run dev:identity-token -- --sub user-1 [--key wk_pub_demo] [--ref vault://widgets/demo]
 * 운영에서는 고객사 서버가 Widget Secret 으로 직접 서명한다 (docs/api-spec.md §1.1).
 */
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { SignJWT } from 'jose';

const { values } = parseArgs({
  options: {
    sub: { type: 'string', default: 'user-1' },
    name: { type: 'string' },
    key: { type: 'string', default: 'wk_pub_demo' },
    ref: { type: 'string', default: 'vault://widgets/demo' },
    ttl: { type: 'string', default: '10m' },
  },
});

const secrets = JSON.parse(process.env.DEV_SECRETS ?? '{}') as Record<string, string>;
const secret = secrets[values.ref];
if (!secret) {
  console.error(`DEV_SECRETS 에 ${values.ref} 값이 없습니다.`);
  process.exit(1);
}

const token = await new SignJWT(values.name ? { name: values.name } : {})
  .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
  .setSubject(values.sub)
  .setAudience(values.key)
  .setIssuedAt()
  .setExpirationTime(values.ttl)
  .sign(new TextEncoder().encode(secret));

console.log(token);
