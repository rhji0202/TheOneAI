import { z } from 'zod';
import type { BuiltinTool } from '../tools/tool.types.js';
import type { ArtifactsService } from './artifacts.service.js';

export const QUERY_TABLE = 'builtin.query_table';

const input = z.object({
  file: z.string().min(1).max(255).describe('Attached file name, e.g. 재고_상세내역.xlsx'),
  sql: z
    .string()
    .min(1)
    .max(4_000)
    .describe(
      'One read-only SQLite SELECT. Tables are the sheet names (CSV: the file name without extension); quote names with double quotes.',
    ),
});

/**
 * 첨부 표 질의 — 사용자가 올린 XLSX · CSV 를 메모리 SQLite 에 올려 SELECT 하나를 실행한다 (extract_text.py).
 * 합계 · 개수 · 그룹 집계를 숫자를 옮겨 적지 않고 원본 데이터에서 바로 계산한다. 읽기만 한다.
 */
export function queryTableTool(artifacts: ArtifactsService): BuiltinTool<z.infer<typeof input>> {
  return {
    name: QUERY_TABLE,
    description:
      'Run one read-only SQL SELECT over a spreadsheet (XLSX) or CSV file the user attached in this conversation. Use it for totals, counts, averages, filters and grouping instead of adding numbers by hand; returns the columns and up to 200 rows.',
    level: 'read',
    idempotent: true,
    timeoutMs: 60_000,
    input,
    execute: (args, ctx) =>
      artifacts.queryAttachment({
        tenantId: ctx.tenantId,
        taskId: ctx.taskId,
        fileName: args.file,
        sql: args.sql,
      }),
  };
}
