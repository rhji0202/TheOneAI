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

const ISSUER = 'theoneai';
const AUDIENCE = 'admin';

const claimsSchema = z.object({
  sub: z.string(),
  tid: z.string(),
  role: z.enum(['owner', 'admin', 'operator', 'viewer']),
});

export type AdminTokenClaims = z.infer<typeof claimsSchema>;

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

  async issue(claims: AdminTokenClaims): Promise<{ token: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + this.ttlSec * 1_000);
    const token = await new SignJWT({ tid: claims.tid, role: claims.role })
      .setProtectedHeader({ alg: 'ES256', typ: 'JWT' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(claims.sub)
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1_000))
      .sign(this.privateKey);
    return { token, expiresAt };
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
