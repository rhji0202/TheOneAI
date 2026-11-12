import { PrismaPg } from '@prisma/adapter-pg';

type PgAdapter = Awaited<ReturnType<PrismaPg['connect']>>;
type PgTransaction = Awaited<ReturnType<PgAdapter['startTransaction']>>;
type Queryable = Pick<PgTransaction, 'queryRaw' | 'executeRaw'>;

/**
 * 트랜잭션 하나는 연결 하나다. Prisma 쿼리 해석기는 include 한 관계를 동시에 읽고,
 * 코드에서 Promise.all 로 여러 쿼리를 보낼 수도 있는데, 그러면 같은 pg 연결에 쿼리가 겹쳐
 * 쌓인다 (pg 8 은 경고 후 줄 세우고, pg 9 부터는 지원하지 않는다).
 * 트랜잭션의 쿼리를 보낸 순서대로 하나씩 실행해 연결을 안전하게 쓴다. 트랜잭션 밖 쿼리는
 * 풀에서 연결을 따로 받으므로 그대로 동시에 실행한다.
 */
export function serializeQueries<T extends Queryable>(tx: T): T {
  let tail: Promise<unknown> = Promise.resolve();
  const inOrder = <R>(run: () => Promise<R>): Promise<R> => {
    const next = tail.then(run, run);
    tail = next.catch(() => undefined);
    return next;
  };
  const queryRaw = tx.queryRaw.bind(tx);
  const executeRaw = tx.executeRaw.bind(tx);
  tx.queryRaw = (query) => inOrder(() => queryRaw(query));
  tx.executeRaw = (query) => inOrder(() => executeRaw(query));
  return tx;
}

/** PrismaPg 와 같지만 트랜잭션 안의 쿼리를 차례로 실행한다 */
export class SerializedPrismaPg extends PrismaPg {
  override async connect(): Promise<PgAdapter> {
    const adapter = await super.connect();
    const start = adapter.startTransaction.bind(adapter);
    adapter.startTransaction = async (isolationLevel) =>
      serializeQueries(await start(isolationLevel));
    return adapter;
  }
}
