import { calculateTool, currentTimeTool } from './builtin/builtin-tools.js';
import { CalculationError, calculate } from './builtin/calculator.js';
import { maskSensitive, preview } from './masking.js';
import { evaluateCondition } from './rule-condition.js';
import { matchesToolPattern, toLlmName } from './tool-names.js';

describe('calculate', () => {
  it.each([
    ['1 + 2 * 3', 7],
    ['(1 + 2) * 3', 9],
    ['2 ^ 3 ^ 2', 512],
    ['-2 ^ 2', -4],
    ['1,234 * 5,678', 7_006_652],
    ['10 % 3', 1],
    ['round(10 / 3, 2)', 3.33],
    ['sqrt(16) + abs(-2)', 6],
    ['max(1, 5, 3) - min(4, 2)', 3],
    ['log(1000)', 3],
    ['1.5e3 / 3', 500],
    ['3 × 4 ÷ 2', 6],
  ])('%s = %s', (expr, expected) => {
    expect(calculate(expr)).toBeCloseTo(expected, 10);
  });

  it.each(['', '1 +', '(1 + 2', '1 / 0', 'foo(1)', 'process.exit()', '1; 2', 'x'.repeat(501)])(
    '잘못된 식은 CalculationError: %s',
    (expr) => {
      expect(() => calculate(expr)).toThrow(CalculationError);
    },
  );

  it('Tool 은 계산 오류를 예외 대신 결과로 돌려준다', async () => {
    const ctx = {
      tenantId: 't',
      taskId: 't',
      endUserId: 'u',
      conversationId: 'c',
      registryVersionId: 'r',
      agentVersionId: 'av',
      signal: new AbortController().signal,
    };
    await expect(calculateTool.execute({ expression: '1/0' }, ctx)).resolves.toMatchObject({
      error: expect.any(String),
    });
    await expect(calculateTool.execute({ expression: '6*7' }, ctx)).resolves.toEqual({
      expression: '6*7',
      result: 42,
    });
  });
});

describe('builtin.current_time', () => {
  const ctx = {
    tenantId: 't',
    taskId: 't',
    endUserId: 'u',
    conversationId: 'c',
    registryVersionId: 'r',
    agentVersionId: 'av',
    signal: new AbortController().signal,
  };

  it('시간대를 검증하고 현지 시각을 돌려준다', async () => {
    const args = currentTimeTool.input.parse({ timezone: 'Asia/Seoul' });
    const result = (await currentTimeTool.execute(args, ctx)) as Record<string, string>;
    expect(result.local).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(result.utcOffset).toBe('+09:00');
    expect(currentTimeTool.input.safeParse({ timezone: 'Mars/Base' }).success).toBe(false);
    expect(currentTimeTool.input.parse({})).toEqual({ timezone: 'Asia/Seoul' });
  });
});

describe('Tool 이름', () => {
  it('LLM function 이름으로 바꾸고, 패턴을 비교한다', () => {
    expect(toLlmName('builtin.calculate')).toBe('builtin__calculate');
    expect(toLlmName('google-drive.upload_file')).toBe('google-drive__upload_file');
    expect(matchesToolPattern('google-drive.upload_file', 'google-drive.*')).toBe(true);
    expect(matchesToolPattern('google-drive.upload_file', 'google-drive.list_files')).toBe(false);
  });
});

describe('maskSensitive', () => {
  it('민감한 키 · 토큰 · 카드번호를 가린다', () => {
    expect(
      maskSensitive({
        user: 'kim',
        password: 'hunter2',
        nested: { apiKey: 'abc', note: 'call with Bearer abcdefghijklmnop' },
        card: '4111 1111 1111 1234',
        key: 'sk-abcdefghijklmnopqrstu',
      }),
    ).toEqual({
      user: 'kim',
      password: '***',
      nested: { apiKey: '***', note: 'call with Bearer ***' },
      card: '****-****-****-1234',
      key: 'sk-***',
    });
  });

  it('preview 는 가린 뒤 자른다', () => {
    expect(preview({ token: 'x', text: 'a'.repeat(400) }, 50)).toHaveLength(50);
    expect(preview({ token: 'x' })).toBe('{"token":"***"}');
  });
});

describe('evaluateCondition', () => {
  it('인자 비교 · all/any', () => {
    expect(
      evaluateCondition({ arg: 'amount', op: 'gt', value: 100_000 }, { amount: 150_000 }),
    ).toBe(true);
    expect(evaluateCondition({ arg: 'amount', op: 'gt', value: 100_000 }, { amount: 50_000 })).toBe(
      false,
    );
    expect(
      evaluateCondition(
        { arg: 'order.items.0', op: 'eq', value: 'A' },
        { order: { items: ['A'] } },
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        {
          all: [{ arg: 'a', op: 'eq', value: 1 }, { any: [{ arg: 'b', op: 'in', value: [2, 3] }] }],
        },
        { a: 1, b: 3 },
      ),
    ).toBe(true);
    expect(
      evaluateCondition({ arg: 'q', op: 'matches', value: '^drop\\s' }, { q: 'DROP table' }),
    ).toBe(true);
  });

  it('도메인 조건: 허용 목록 밖이 하나라도 있으면 일치', () => {
    const rule = { argDomainNotIn: 'to', domains: ['example.com'] };
    expect(evaluateCondition(rule, { to: ['a@example.com', 'b@sub.example.com'] })).toBe(false);
    expect(evaluateCondition(rule, { to: ['a@example.com', 'x@evil.io'] })).toBe(true);
  });

  it('시간 조건: 업무 시간 밖이면 일치', () => {
    const rule = {
      timeOutside: { days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00', tz: 'Asia/Seoul' },
    };
    expect(evaluateCondition(rule, {}, new Date('2026-11-12T02:00:00Z'))).toBe(false); // 목 11:00 KST
    expect(evaluateCondition(rule, {}, new Date('2026-11-12T12:00:00Z'))).toBe(true); // 목 21:00 KST
    expect(evaluateCondition(rule, {}, new Date('2026-11-15T02:00:00Z'))).toBe(true); // 일 11:00 KST
  });

  it('형식이 잘못된 조건은 일치로 본다 (fail-closed)', () => {
    expect(evaluateCondition({ nonsense: true }, {})).toBe(true);
  });
});
