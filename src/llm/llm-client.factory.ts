import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { SecretStore } from '../infrastructure/secrets/secret-store.js';
import { type LlmClient, LlmError } from './llm.types.js';
import { OpenAiCompatibleClient } from './openai-compatible.client.js';
import { DEFAULT_BASE_URLS, isSupportedProviderKind } from './provider-params.js';

export interface ProviderRecord {
  id: string;
  name: string;
  kind: string;
  baseUrl: string | null;
  secretRef: string;
}

/** providers 행 → LLM 클라이언트. API Key 는 SecretStore(Vault 참조)에서 가져오고, 키가 바뀌면 새로 만든다. */
@Injectable()
export class LlmClientFactory {
  private readonly cache = new Map<string, { fingerprint: string; client: LlmClient }>();

  constructor(
    private readonly secrets: SecretStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async create(provider: ProviderRecord): Promise<LlmClient> {
    if (!isSupportedProviderKind(provider.kind)) {
      throw new LlmError(
        'not_configured',
        `아직 지원하지 않는 provider 종류입니다: ${provider.kind}`,
      );
    }
    const baseUrl = provider.baseUrl ?? DEFAULT_BASE_URLS[provider.kind];
    if (!baseUrl) {
      throw new LlmError('not_configured', `Provider '${provider.name}' 에 base_url 이 필요합니다`);
    }
    const apiKey = await this.secrets.get(provider.secretRef);
    if (!apiKey) {
      throw new LlmError(
        'not_configured',
        `Provider '${provider.name}' 의 API Key(${provider.secretRef})를 찾을 수 없습니다`,
      );
    }

    const fingerprint = createHash('sha256')
      .update(`${provider.kind}|${baseUrl}|${apiKey}`)
      .digest('hex');
    const cached = this.cache.get(provider.id);
    if (cached?.fingerprint === fingerprint) return cached.client;

    const client = new OpenAiCompatibleClient({
      kind: provider.kind,
      baseUrl,
      apiKey,
      requestTimeoutMs: this.config.llm.requestTimeoutMs,
      idleTimeoutMs: this.config.llm.idleTimeoutMs,
      maxRetries: this.config.llm.maxRetries,
    });
    this.cache.set(provider.id, { fingerprint, client });
    return client;
  }
}
