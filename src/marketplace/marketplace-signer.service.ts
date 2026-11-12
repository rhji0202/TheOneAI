import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
  verify,
} from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { canonicalJson } from '../common/canonical-json.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { SecretStore } from '../infrastructure/secrets/secret-store.js';

/** 서명 대상 — 목록 종류 · 이름 · 버전 · 내용 해시 · manifest */
export interface SignedContent {
  kind: string;
  name: string;
  version: string;
  contentHash: string;
  manifest: unknown;
}

interface LoadedKey {
  privateKey: KeyObject;
  publicKey: KeyObject;
  keyId: string;
}

/**
 * 마켓플레이스 서명 — 플랫폼 Ed25519 키로 게시 내용을 서명하고, 설치 전에 확인한다.
 * 키는 Secret 저장소(MARKETPLACE_SIGNING_KEY_REF, PKCS#8 PEM)에 둔다. 개발 · 테스트에서는 없으면 만들어 저장하고,
 * production 에서는 미리 넣어 두어야 한다 (없으면 게시 · 설치를 거절).
 */
@Injectable()
export class MarketplaceSigner {
  private readonly logger = new Logger(MarketplaceSigner.name);
  private key: Promise<LoadedKey> | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly secrets: SecretStore,
  ) {}

  async sign(content: SignedContent): Promise<{ signature: string; keyId: string }> {
    const key = await this.load();
    const signature = sign(null, Buffer.from(canonicalJson(content)), key.privateKey);
    return { signature: signature.toString('base64'), keyId: key.keyId };
  }

  /** 지금 플랫폼 키로 만든 서명인가 — 키가 바뀌었거나 내용이 하나라도 다르면 false */
  async verify(content: SignedContent, signature: string, keyId: string): Promise<boolean> {
    const key = await this.load();
    if (keyId !== key.keyId) return false;
    try {
      return verify(
        null,
        Buffer.from(canonicalJson(content)),
        key.publicKey,
        Buffer.from(signature, 'base64'),
      );
    } catch {
      return false;
    }
  }

  async keyId(): Promise<string> {
    return (await this.load()).keyId;
  }

  private load(): Promise<LoadedKey> {
    this.key ??= this.read().catch((err: unknown) => {
      this.key = null;
      throw err;
    });
    return this.key;
  }

  private async read(): Promise<LoadedKey> {
    const ref = this.config.marketplace.signingKeyRef;
    let pem = await this.secrets.get(ref);
    if (!pem) {
      if (this.config.env === 'production') {
        throw new Error(`마켓플레이스 서명 키가 없습니다 (${ref})`);
      }
      pem = generateKeyPairSync('ed25519')
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString();
      await this.secrets.put(ref, pem);
      this.logger.warn(`마켓플레이스 서명 키를 새로 만들었습니다 (${ref}) — 개발 전용`);
    }
    const privateKey = createPrivateKey(pem);
    const publicKey = createPublicKey(privateKey);
    const der = publicKey.export({ type: 'spki', format: 'der' });
    return {
      privateKey,
      publicKey,
      keyId: createHash('sha256').update(der).digest('hex').slice(0, 16),
    };
  }
}
