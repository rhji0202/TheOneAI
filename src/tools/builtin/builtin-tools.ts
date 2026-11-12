import { z } from 'zod';
import type { BuiltinTool } from '../tool.types.js';
import { CalculationError, calculate } from './calculator.js';

/** 내장 Tool — 외부 연동 없이 안전하게 쓸 수 있는 것만 둔다. 업무 Tool 은 MCP 로 붙인다. */

const calculateInput = z.object({
  expression: z
    .string()
    .min(1)
    .max(500)
    .describe('Arithmetic expression, e.g. "(1200 * 0.9 + 3000) / 3", "sqrt(2)", "round(10/3, 2)"'),
});

export const calculateTool: BuiltinTool<z.infer<typeof calculateInput>> = {
  name: 'builtin.calculate',
  description:
    'Evaluate an arithmetic expression exactly. Supports + - * / % ^, parentheses, sqrt abs round floor ceil min max pow log ln exp, pi and e. Use it instead of doing arithmetic in your head.',
  level: 'read',
  idempotent: true,
  timeoutMs: 1_000,
  input: calculateInput,
  async execute({ expression }) {
    try {
      return { expression, result: calculate(expression) };
    } catch (err) {
      if (err instanceof CalculationError) return { expression, error: err.message };
      throw err;
    }
  },
};

const currentTimeInput = z.object({
  timezone: z
    .string()
    .max(64)
    .default('Asia/Seoul')
    .refine(isValidTimeZone, '알 수 없는 IANA 시간대입니다')
    .describe(
      'IANA time zone name, e.g. "Asia/Seoul", "America/New_York". Defaults to Asia/Seoul.',
    ),
});

export const currentTimeTool: BuiltinTool<z.infer<typeof currentTimeInput>> = {
  name: 'builtin.current_time',
  description:
    "Get the current date, time and weekday in a time zone. Use it whenever the answer depends on today's date or the current time.",
  level: 'read',
  idempotent: false,
  timeoutMs: 1_000,
  input: currentTimeInput,
  async execute({ timezone }) {
    const now = new Date();
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        weekday: 'long',
        hourCycle: 'h23',
        timeZoneName: 'longOffset',
      })
        .formatToParts(now)
        .map((p) => [p.type, p.value]),
    );
    return {
      timezone,
      local: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`,
      weekday: parts.weekday,
      utcOffset: (parts.timeZoneName ?? 'GMT').replace('GMT', '') || '+00:00',
      utc: now.toISOString(),
    };
  },
};

export const DEFAULT_BUILTIN_TOOLS: BuiltinTool[] = [
  calculateTool as BuiltinTool,
  currentTimeTool as BuiltinTool,
];

function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
