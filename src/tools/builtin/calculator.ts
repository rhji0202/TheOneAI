/**
 * 안전한 산술식 계산기 (eval 을 쓰지 않는 재귀 하강 파서).
 *   숫자(소수 · 지수 표기 · 1,234 쉼표), + - * / % ^, 괄호, 단항 ±
 *   함수: sqrt abs round floor ceil min max pow log ln exp
 *   상수: pi e
 */
const FUNCTIONS: Record<string, { arity: [number, number]; fn: (...args: number[]) => number }> = {
  sqrt: { arity: [1, 1], fn: Math.sqrt },
  abs: { arity: [1, 1], fn: Math.abs },
  floor: { arity: [1, 1], fn: Math.floor },
  ceil: { arity: [1, 1], fn: Math.ceil },
  exp: { arity: [1, 1], fn: Math.exp },
  ln: { arity: [1, 1], fn: Math.log },
  log: { arity: [1, 2], fn: (x, base = 10) => Math.log(x) / Math.log(base) },
  pow: { arity: [2, 2], fn: Math.pow },
  min: { arity: [1, 50], fn: Math.min },
  max: { arity: [1, 50], fn: Math.max },
  round: {
    arity: [1, 2],
    fn: (x, digits = 0) => {
      const factor = 10 ** Math.trunc(digits);
      return Math.round(x * factor) / factor;
    },
  },
};
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };
const MAX_LENGTH = 500;

export class CalculationError extends Error {}

type Token =
  { kind: 'num'; value: number } | { kind: 'id'; value: string } | { kind: 'op'; value: string };

export function calculate(expression: string): number {
  if (expression.length > MAX_LENGTH)
    throw new CalculationError(`식이 너무 깁니다 (최대 ${MAX_LENGTH}자)`);
  const tokens = tokenize(expression);
  let pos = 0;

  const peek = (): Token | undefined => tokens[pos];
  const isOp = (value: string): boolean => {
    const t = peek();
    return t?.kind === 'op' && t.value === value;
  };
  const expectOp = (value: string): void => {
    if (!isOp(value)) throw new CalculationError(`'${value}' 가 필요합니다`);
    pos++;
  };

  // expression := term (('+' | '-') term)*
  const parseExpression = (): number => {
    let value = parseTerm();
    while (isOp('+') || isOp('-')) {
      const op = (tokens[pos++] as { value: string }).value;
      const right = parseTerm();
      value = op === '+' ? value + right : value - right;
    }
    return value;
  };
  // term := unary (('*' | '/' | '%') unary)*
  const parseTerm = (): number => {
    let value = parseUnary();
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = (tokens[pos++] as { value: string }).value;
      const right = parseUnary();
      if ((op === '/' || op === '%') && right === 0)
        throw new CalculationError('0 으로 나눌 수 없습니다');
      value = op === '*' ? value * right : op === '/' ? value / right : value % right;
    }
    return value;
  };
  // unary := ('+' | '-') unary | power
  const parseUnary = (): number => {
    if (isOp('-')) {
      pos++;
      return -parseUnary();
    }
    if (isOp('+')) {
      pos++;
      return parseUnary();
    }
    return parsePower();
  };
  // power := primary ('^' unary)?   (오른쪽 결합)
  const parsePower = (): number => {
    const base = parsePrimary();
    if (isOp('^')) {
      pos++;
      return base ** parseUnary();
    }
    return base;
  };
  // primary := number | constant | func '(' args ')' | '(' expression ')'
  const parsePrimary = (): number => {
    const token = peek();
    if (!token) throw new CalculationError('식이 끝나지 않았습니다');
    if (token.kind === 'num') {
      pos++;
      return token.value;
    }
    if (token.kind === 'op' && token.value === '(') {
      pos++;
      const value = parseExpression();
      expectOp(')');
      return value;
    }
    if (token.kind === 'id') {
      pos++;
      const name = token.value.toLowerCase();
      if (name in CONSTANTS) return CONSTANTS[name]!;
      const fn = FUNCTIONS[name];
      if (!fn) throw new CalculationError(`알 수 없는 이름: ${token.value}`);
      expectOp('(');
      const args: number[] = [];
      if (!isOp(')')) {
        args.push(parseExpression());
        while (isOp(',')) {
          pos++;
          args.push(parseExpression());
        }
      }
      expectOp(')');
      const [minArgs, maxArgs] = fn.arity;
      if (args.length < minArgs || args.length > maxArgs) {
        throw new CalculationError(`${name} 의 인자 수가 올바르지 않습니다`);
      }
      return fn.fn(...args);
    }
    throw new CalculationError(`예상하지 못한 기호: ${token.value}`);
  };

  const result = parseExpression();
  if (pos < tokens.length)
    throw new CalculationError(`해석할 수 없는 부분: ${String(tokens[pos]!.value)}`);
  if (!Number.isFinite(result)) throw new CalculationError('결과가 유한한 수가 아닙니다');
  return result;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const number = /^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?([eE][+-]?\d+)?|^\.\d+([eE][+-]?\d+)?/.exec(
      input.slice(i),
    );
    if (number) {
      tokens.push({ kind: 'num', value: Number(number[0].replace(/,/g, '')) });
      i += number[0].length;
      continue;
    }
    const ident = /^[A-Za-z_][A-Za-z0-9_]*/.exec(input.slice(i));
    if (ident) {
      tokens.push({ kind: 'id', value: ident[0] });
      i += ident[0].length;
      continue;
    }
    if ('+-*/%^(),'.includes(ch)) {
      tokens.push({ kind: 'op', value: ch });
      i++;
      continue;
    }
    if (ch === '×') {
      tokens.push({ kind: 'op', value: '*' });
      i++;
      continue;
    }
    if (ch === '÷') {
      tokens.push({ kind: 'op', value: '/' });
      i++;
      continue;
    }
    throw new CalculationError(`쓸 수 없는 문자: ${ch}`);
  }
  if (tokens.length === 0) throw new CalculationError('식이 비어 있습니다');
  return tokens;
}
