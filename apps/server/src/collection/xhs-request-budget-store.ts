import { Prisma } from '@prisma/client';
import { XhsBudgetStore, XhsBudget } from './xhs-request-budget';
type Db = Pick<Prisma.TransactionClient, '$queryRaw'>;
/** One UPDATE is the reservation transaction, including concurrent callers. */
export class XhsSqliteBudgetStore implements XhsBudgetStore {
  constructor(private readonly db: Db) {}
  async reserve(id: string, now: number) {
    const rows = await this.db.$queryRaw<Array<{ id: string }>>`
      UPDATE xhs_request_budgets SET used=used+1, next_at=${BigInt(now)}+interval_ms
      WHERE id=${id} AND used < 9007199254740991 AND next_at <= ${BigInt(now)}
      RETURNING id`;
    return rows.length === 1;
  }
  async rollback(id: string, before: XhsBudget, reservedAt: number) {
    const rows = await this.db.$queryRaw<Array<{ id: string }>>`
      UPDATE xhs_request_budgets SET used=${before.used}, next_at=${BigInt(before.nextAt)}
      WHERE id=${id} AND used=${before.used + 1}
        AND next_at=${BigInt(reservedAt + before.intervalMs)} RETURNING id`;
    return rows.length === 1;
  }
  async read(id: string): Promise<XhsBudget | null> {
    const rows = await this.db.$queryRaw<
      Array<{
        id: string;
        request_limit: bigint;
        used: bigint;
        next_at: bigint;
        interval_ms: bigint;
      }>
    >`SELECT * FROM xhs_request_budgets WHERE id=${id}`;
    const row = rows[0];
    return row
      ? {
          id: row.id,
          limit: Number(row.request_limit),
          used: Number(row.used),
          nextAt: Number(row.next_at),
          intervalMs: Number(row.interval_ms),
        }
      : null;
  }
}
