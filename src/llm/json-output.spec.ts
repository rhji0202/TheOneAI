import { z } from 'zod';
import { extractJson, parseJsonOutput } from './json-output.js';

describe('extractJson', () => {
  it('순수 JSON · 코드 펜스 · 앞뒤 설명이 붙은 출력을 모두 읽는다', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('계획입니다:\n{"a":3}\n끝')).toEqual({ a: 3 });
  });

  it('JSON 이 없으면 SyntaxError', () => {
    expect(() => extractJson('그냥 문장')).toThrow(SyntaxError);
  });
});

describe('parseJsonOutput', () => {
  const schema = z.object({ verdict: z.enum(['pass', 'fail']) });

  it('스키마에 맞으면 값을, 아니면 경로가 담긴 오류를 준다', () => {
    expect(parseJsonOutput('{"verdict":"pass"}', schema)).toEqual({
      ok: true,
      value: { verdict: 'pass' },
    });
    const bad = parseJsonOutput('{"verdict":"maybe"}', schema);
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toContain('verdict');
  });
});
