import { EMBEDDING_DIMENSIONS, hashEmbedding, toVectorLiteral } from './embedding.service.js';

const cosine = (a: number[], b: number[]) => a.reduce((sum, v, i) => sum + v * b[i]!, 0);

describe('hashEmbedding (local-hash-v1)', () => {
  it('1536차원 · 단위 벡터 · 같은 글은 같은 벡터', () => {
    const v = hashEmbedding('사용자는 표로 받기를 선호한다');
    expect(v).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(Math.sqrt(cosine(v, v))).toBeCloseTo(1, 6);
    expect(hashEmbedding('사용자는 표로 받기를 선호한다')).toEqual(v);
  });

  it('겹치는 말이 많을수록 가깝고, 관련 없는 글은 0 에 가깝다', () => {
    const memory = hashEmbedding('사용자는 비교 결과를 표로 받기를 선호한다');
    const related = cosine(hashEmbedding('비교 결과를 표로 보여 줘'), memory);
    const unrelated = cosine(hashEmbedding('오늘 날씨 어때'), memory);
    expect(related).toBeGreaterThan(0.2);
    expect(Math.abs(unrelated)).toBeLessThan(0.05);
  });

  it('대소문자 · 전각 문자 차이를 흡수하고, 빈 글도 0 벡터가 아니다', () => {
    expect(cosine(hashEmbedding('Refund POLICY'), hashEmbedding('refund policy'))).toBeCloseTo(
      1,
      6,
    );
    expect(cosine(hashEmbedding('ＡＢＣ'), hashEmbedding('abc'))).toBeCloseTo(1, 6);
    expect(hashEmbedding('').some((x) => x !== 0)).toBe(true);
  });

  it('pgvector 리터럴', () => {
    expect(toVectorLiteral([0.5, -1, Number.NaN])).toBe('[0.500000,-1.000000,0]');
  });
});
