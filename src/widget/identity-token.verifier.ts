import { Injectable } from '@nestjs/common';
import { jwtVerify } from 'jose';
import { z } from 'zod';
import { AppError } from '../common/errors/app-error.js';

const MAX_LIFETIME_SEC = 600;

const identityClaims = z.object({
  sub: z.string().min(1).max(256),
  name: z.string().max(200).optional(),
  locale: z.string().max(35).optional(),
});
export type IdentityClaims = z.infer<typeof identityClaims>;

/**
 * 고객사 서버가 Widget Secret 으로 서명한 identity token(HS256) 검증 — docs/api-spec.md §1.1
 *  - aud = 위젯 공개 키, sub · iat · exp 필수, 수명(exp - iat) 10분 이하
 *  - Secret 재발급 유예 기간에는 이전 Secret 도 시도한다.
 */
@Injectable()
export class IdentityTokenVerifier {
  async verify(
    token: string,
    options: { audience: string; secrets: string[] },
  ): Promise<IdentityClaims> {
    let reason = '서명이 올바르지 않습니다';
    for (const secret of options.secrets) {
      try {
        const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
          algorithms: ['HS256'],
          audience: options.audience,
          requiredClaims: ['sub', 'iat', 'exp'],
          maxTokenAge: MAX_LIFETIME_SEC,
          clockTolerance: 30,
        });
        if (payload.exp! - payload.iat! > MAX_LIFETIME_SEC) {
          throw new AppError(401, 'IDENTITY_TOKEN_INVALID', '토큰 수명은 10분 이하여야 합니다');
        }
        const parsed = identityClaims.safeParse(payload);
        if (!parsed.success) {
          throw new AppError(
            401,
            'IDENTITY_TOKEN_INVALID',
            'sub · name · locale 형식이 올바르지 않습니다',
          );
        }
        return parsed.data;
      } catch (err) {
        if (err instanceof AppError) throw err;
        const code = (err as { code?: string }).code;
        if (code !== 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED') {
          reason = err instanceof Error ? err.message : reason;
          break; // 서명은 맞고 claim 이 틀린 경우 — 다른 Secret 을 시도할 이유가 없다.
        }
      }
    }
    throw new AppError(401, 'IDENTITY_TOKEN_INVALID', reason);
  }
}
