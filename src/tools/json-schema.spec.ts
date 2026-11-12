import { canonicalJson, compileSchema, validateAgainst } from './json-schema.js';

describe('validateAgainst', () => {
  const schema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: {
      orderId: { type: 'string', pattern: '^A-\\d+$' },
      qty: { type: 'integer', minimum: 1 },
    },
    required: ['orderId'],
    additionalProperties: false,
  };

  it('맞는 인자는 통과', () => {
    expect(validateAgainst(schema, { orderId: 'A-1', qty: 2 })).toEqual({ ok: true });
  });

  it('틀리면 경로 · 이유를 알려 준다', () => {
    const res = validateAgainst(schema, { order: 'x', qty: 0 });
    expect(res.ok).toBe(false);
    const message = (res as { message: string }).message;
    expect(message).toContain("must have required property 'orderId'");
    expect(message).toContain("'order'");
    expect(message).toContain('/qty');
  });

  it('2020-12 스키마 · 같은 $id 를 쓰는 서로 다른 스키마도 컴파일된다', () => {
    const a = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'x',
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      dependentRequired: { a: ['b'] },
    };
    const b = { $id: 'x', type: 'object', properties: { a: { type: 'string' } } };
    const compiledA = compileSchema(a);
    expect(compiledA.ok).toBe(true);
    expect(compileSchema(b).ok).toBe(true);
    // 2020-12 키워드가 실제로 적용된다
    expect(validateAgainst(a, { a: 'x' }).ok).toBe(false);
    expect(validateAgainst(a, { a: 'x', b: 'y' }).ok).toBe(true);
  });

  it('잘못된 스키마는 컴파일 오류', () => {
    expect(compileSchema({ type: 'object', properties: { a: { type: 'nope' } } }).ok).toBe(false);
    expect(compileSchema('x').ok).toBe(false);
  });
});

it('canonicalJson 은 키 순서와 무관하다', () => {
  expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(
    canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }),
  );
  expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
});
