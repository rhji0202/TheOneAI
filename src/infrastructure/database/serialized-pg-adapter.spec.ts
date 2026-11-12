import { serializeQueries } from './serialized-pg-adapter.js';

type Query = Parameters<Parameters<typeof serializeQueries>[0]['queryRaw']>[0];
const query = (sql: string) => ({ sql, args: [], argTypes: [] }) as unknown as Query;

describe('serializeQueries', () => {
  it('동시에 보낸 쿼리도 보낸 순서대로 하나씩 실행하고, 실패가 뒤 쿼리를 막지 않는다', async () => {
    const log: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const run = async (sql: string) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      log.push(`start ${sql}`);
      await new Promise((r) => setTimeout(r, sql === 'slow' ? 20 : 1));
      running--;
      log.push(`end ${sql}`);
      if (sql === 'boom') throw new Error('boom');
    };
    const tx = serializeQueries({
      queryRaw: async (q: Query) => {
        await run(q.sql);
        return { columnNames: [], columnTypes: [], rows: [] };
      },
      executeRaw: async (q: Query) => {
        await run(q.sql);
        return 1;
      },
    });

    const results = await Promise.allSettled([
      tx.queryRaw(query('slow')),
      tx.executeRaw(query('boom')),
      tx.queryRaw(query('fast')),
    ]);

    expect(maxRunning).toBe(1);
    expect(log).toEqual([
      'start slow',
      'end slow',
      'start boom',
      'end boom',
      'start fast',
      'end fast',
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  });
});
