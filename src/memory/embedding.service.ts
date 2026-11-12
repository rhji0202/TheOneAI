import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { SecretStore } from '../infrastructure/secrets/secret-store.js';

/** memories.embedding 은 vector(1536) — 모든 provider 를 이 차원으로 맞춘다 */
export const EMBEDDING_DIMENSIONS = 1536;

const DEFAULT_BASE_URL = {
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
} as const;

export class EmbeddingError extends Error {}

/**
 * 임베딩 — Memory 저장 · 검색 · 콘솔 검색이 같은 모델을 쓴다 (memories.embedding_model 로 구분, 다른 모델끼리는 비교하지 않는다).
 *  - local: 문자 n-gram · 단어 특징 해싱 (외부 호출 없음). 한국어는 음절 2·3-gram 이 어미 변화를 흡수한다.
 *    의미 검색 품질은 실제 임베딩 모델보다 낮다 — 운영에서는 openai · gemini 를 쓴다.
 *  - openai · gemini: OpenAI 호환 POST /embeddings (dimensions = 1536)
 */
@Injectable()
export class EmbeddingService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly secrets: SecretStore,
  ) {}

  get model(): string {
    return this.config.embedding.model;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (this.config.embedding.provider === 'local') return texts.map(hashEmbedding);
    return this.remote(texts);
  }

  async embedOne(text: string): Promise<number[]> {
    const [vector] = await this.embed([text]);
    return vector!;
  }

  private async remote(texts: string[]): Promise<number[][]> {
    const { provider, model, baseUrl, secretRef } = this.config.embedding;
    const key = secretRef ? await this.secrets.get(secretRef) : null;
    if (!key)
      throw new EmbeddingError(`임베딩 API Key(${secretRef ?? 'EMBEDDING_SECRET_REF'})가 없습니다`);
    const url = `${(baseUrl ?? DEFAULT_BASE_URL[provider as 'openai' | 'gemini']).replace(/\/$/, '')}/embeddings`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, input: texts, dimensions: EMBEDDING_DIMENSIONS }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new EmbeddingError(`임베딩 요청 실패 (${res.status})`);
    const body = (await res.json()) as { data?: Array<{ embedding: number[]; index: number }> };
    const data = [...(body.data ?? [])].sort((a, b) => a.index - b.index);
    if (
      data.length !== texts.length ||
      data.some((d) => d.embedding.length !== EMBEDDING_DIMENSIONS)
    ) {
      throw new EmbeddingError(
        `임베딩 응답 형식이 맞지 않습니다 (${EMBEDDING_DIMENSIONS}차원 필요)`,
      );
    }
    return data.map((d) => d.embedding);
  }
}

/** pgvector 리터럴 */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.map((v) => (Number.isFinite(v) ? v.toFixed(6) : '0')).join(',')}]`;
}

/**
 * 해시 임베딩 (local-hash-v1) — 단어(가중 1) · 단어 안 문자 2-gram(0.5) · 3-gram(0.5)을
 * FNV-1a 로 1536 차원에 부호와 함께 더하고 L2 정규화한다.
 */
export function hashEmbedding(text: string): number[] {
  const vector = Array.from<number>({ length: EMBEDDING_DIMENSIONS }).fill(0);
  const words = text
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const add = (feature: string, weight: number) => {
    const h = fnv1a(feature);
    vector[h % EMBEDDING_DIMENSIONS]! += (h & 0x80000000 ? -1 : 1) * weight;
  };
  for (const word of words) {
    add(`w:${word}`, 1);
    const chars = Array.from(word); // 글자(code point) 단위 — 단어에는 문자 · 숫자만 남아 있다
    for (let n = 2; n <= 3; n++) {
      for (let i = 0; i + n <= chars.length; i++)
        add(`c${n}:${chars.slice(i, i + n).join('')}`, 0.5);
    }
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) {
    vector[0] = 1; // 빈 텍스트 — 0 벡터는 cosine 거리가 정의되지 않는다
    return vector;
  }
  return vector.map((v) => v / norm);
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
