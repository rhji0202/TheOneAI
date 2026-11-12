import { SignJWT } from 'jose';
import { AppError } from '../common/errors/app-error.js';
import { IdentityTokenVerifier } from './identity-token.verifier.js';

const AUD = 'wk_pub_demo';
const SECRET = 'current-secret';
const PREVIOUS = 'previous-secret';

async function sign(
  opts: {
    secret?: string;
    aud?: string;
    sub?: string;
    ttlSec?: number;
    iatOffsetSec?: number;
  } = {},
) {
  const now = Math.floor(Date.now() / 1000) + (opts.iatOffsetSec ?? 0);
  const jwt = new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(opts.aud ?? AUD)
    .setIssuedAt(now)
    .setExpirationTime(now + (opts.ttlSec ?? 300));
  if (opts.sub !== '') jwt.setSubject(opts.sub ?? 'user-1');
  return jwt.sign(new TextEncoder().encode(opts.secret ?? SECRET));
}

async function expectInvalid(promise: Promise<unknown>) {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe('IDENTITY_TOKEN_INVALID');
}

describe('IdentityTokenVerifier', () => {
  const verifier = new IdentityTokenVerifier();

  it('올바른 토큰이면 sub 를 돌려준다', async () => {
    const claims = await verifier.verify(await sign(), { audience: AUD, secrets: [SECRET] });
    expect(claims.sub).toBe('user-1');
  });

  it('재발급 유예 기간에는 이전 Secret 으로 서명한 토큰도 받는다', async () => {
    const claims = await verifier.verify(await sign({ secret: PREVIOUS }), {
      audience: AUD,
      secrets: [SECRET, PREVIOUS],
    });
    expect(claims.sub).toBe('user-1');
  });

  it('다른 Secret 으로 서명하면 거부한다', async () => {
    await expectInvalid(
      verifier.verify(await sign({ secret: 'attacker' }), { audience: AUD, secrets: [SECRET] }),
    );
  });

  it('다른 위젯(aud)용 토큰은 거부한다', async () => {
    await expectInvalid(
      verifier.verify(await sign({ aud: 'wk_pub_other' }), { audience: AUD, secrets: [SECRET] }),
    );
  });

  it('수명이 10분을 넘으면 거부한다', async () => {
    await expectInvalid(
      verifier.verify(await sign({ ttlSec: 3600 }), { audience: AUD, secrets: [SECRET] }),
    );
  });

  it('발급 후 10분이 지난 토큰은 거부한다', async () => {
    await expectInvalid(
      verifier.verify(await sign({ iatOffsetSec: -900, ttlSec: 600 }), {
        audience: AUD,
        secrets: [SECRET],
      }),
    );
  });

  it('sub 가 없으면 거부한다', async () => {
    await expectInvalid(
      verifier.verify(await sign({ sub: '' }), { audience: AUD, secrets: [SECRET] }),
    );
  });
});
