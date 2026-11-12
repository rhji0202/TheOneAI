import { z } from 'zod';

/** 커서 페이지네이션 — UUIDv7 은 시간순이므로 id 를 그대로 커서로 쓴다 (최신순). */
export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.uuid().optional(),
});
export type PageQuery = z.infer<typeof pageQuerySchema>;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** limit + 1 개를 조회한 결과로 다음 커서를 만든다. */
export function toPage<T extends { id: string }, V>(
  rows: T[],
  limit: number,
  map: (row: T) => V,
): Page<V> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items: items.map(map), nextCursor: hasMore ? items[items.length - 1]!.id : null };
}
