import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import { AppError } from '../common/errors/app-error.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import type { WidgetSession } from './widget-session.js';

const ISSUER = 'theoneai';
const AUDIENCE = 'widget';

const claimsSchema = z.object({
  sub: z.string(),
  tid: z.string(),
  wid: z.string(),
  aid: z.string(),
  anon: z.boolean(),
  org: z.string().nullable(),
});

/**
 * 위젯 세션 토큰 (ES256 JWT). claims: sub=end user, tid, wid, aid, anon, org.
 * 개발 · 테스트에서 키가 없으면 프로세스 임시 키를 만든다 (재시작 · 다중 인스턴스에서는 공유되지 않음).
 */
@Injectable()
export class SessionTokenService {
  private readonly logger = new Logger(SessionTokenService.name);
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private readonly ttlSec: number;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.ttlSec = config.widgetSession.ttlSec;
    if (config.widgetSession.privateKeyPem) {
      this.privateKey = createPrivateKey(config.widgetSession.privateKeyPem);
      this.publicKey = createPublicKey(this.privateKey);
    } else {
      const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      this.privateKey = pair.privateKey;
      this.publicKey = pair.publicKey;
      if (config.env !== 'test') {
        this.logger.warn(
          'WIDGET_SESSION_PRIVATE_KEY 가 없어 임시 서명 키를 사용합니다 (개발 전용).',
        );
      }
    }
  }

  async issue(session: WidgetSession): Promise<{ token: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + this.ttlSec * 1_000);
    const token = await new SignJWT({
      tid: session.tenantId,
      wid: session.widgetId,
      aid: session.agentId,
      anon: session.anonymous,
      org: session.origin,
    })
      .setProtectedHeader({ alg: 'ES256', typ: 'JWT' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(session.endUserId)
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1_000))
      .sign(this.privateKey);
    return { token, expiresAt };
  }

  async verify(token: string): Promise<WidgetSession> {
    try {
      const { payload } = await jwtVerify(token, this.publicKey, {
        algorithms: ['ES256'],
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const claims = claimsSchema.parse(payload);
      return {
        tenantId: claims.tid,
        widgetId: claims.wid,
        agentId: claims.aid,
        endUserId: claims.sub,
        anonymous: claims.anon,
        origin: claims.org,
      };
    } catch {
      throw AppError.unauthenticated(
        '세션이 만료되었거나 올바르지 않습니다. 위젯을 다시 시작하세요.',
      );
    }
  }
}
