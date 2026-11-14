import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';

const ISSUER = 'theonewidget';
const AUDIENCE = 'admin';

const verifiedSchema = z.object({ tid: z.string(), sub: z.string() });

const claimsSchema = z.object({
  sub: z.string(),
  tid: z.string(),
  role: z.enum(['owner', 'admin', 'operator', 'viewer']),
  /** 이 로그인에서 비밀번호를 확인한 워크스페이스 멤버십 — 이 안에서는 비밀번호 없이 전환한다 */
  ws: z.array(verifiedSchema).default([]),
  exp: z.number(),
});

export type VerifiedMembership = z.infer<typeof verifiedSchema>;
export type AdminTokenClaims = z.infer<typeof claimsSchema>;
export type AdminTokenInput = Omit<AdminTokenClaims, 'exp'>;

/**
 * 콘솔 access token (ES256 JWT, aud=admin). 위젯 세션 토큰과 다른 키 · audience 를 쓴다.
 * 개발 · 테스트에서 키가 없으면 프로세스 임시 키 (Admin API 는 API 프로세스에서만 검증한다).
 */
@Injectable()
export class AdminTokenService {
  private readonly logger = new Logger(AdminTokenService.name);
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  readonly ttlSec: number;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.ttlSec = config.adminSession.ttlSec;
    if (config.adminSession.privateKeyPem) {
      this.privateKey = createPrivateKey(config.adminSession.privateKeyPem);
    } else {
      this.privateKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
      if (config.env !== 'test') {
        this.logger.warn(
          'ADMIN_SESSION_PRIVATE_KEY 가 없어 임시 서명 키를 사용합니다 (개발 전용, 재시작하면 다시 로그인).',
        );
      }
    }
    this.publicKey = createPublicKey(this.privateKey);
  }

  /** expiresAt 을 주면 그 시각에 끝난다 — 워크스페이스 전환이 로그인 시간을 늘리지 않게 */
  async issue(claims: AdminTokenInput, until?: Date): Promise<{ token: string; expiresAt: Date }> {
    const expSec = Math.floor((until?.getTime() ?? Date.now() + this.ttlSec * 1_000) / 1_000);
    const token = await new SignJWT({ tid: claims.tid, role: claims.role, ws: claims.ws })
      .setProtectedHeader({ alg: 'ES256', typ: 'JWT' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(claims.sub)
      .setIssuedAt()
      .setExpirationTime(expSec)
      .sign(this.privateKey);
    return { token, expiresAt: new Date(expSec * 1_000) };
  }

  async verify(token: string): Promise<AdminTokenClaims> {
    try {
      const { payload } = await jwtVerify(token, this.publicKey, {
        algorithms: ['ES256'],
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      return claimsSchema.parse(payload);
    } catch {
      throw AppError.unauthenticated('콘솔 로그인이 만료되었거나 올바르지 않습니다');
    }
  }
}
