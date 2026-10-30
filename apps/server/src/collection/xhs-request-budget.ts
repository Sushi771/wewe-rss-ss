import type { Prisma } from '@prisma/client';
import { XhsSubscriptionError } from './xhs-subscription-errors';
/** Durable request admission. Reservations are never refunded after an unknown receipt. */
export type XhsBudget = {
  id: string;
  limit: number;
  used: number;
  nextAt: number;
  intervalMs: number;
};
export interface XhsBudgetStore {
  /** Must atomically compare used/nextAt and increment before returning true. */
  reserve(id: string, now: number): Promise<boolean>;
  read(id: string): Promise<XhsBudget | null>;
  rollback?(
    id: string,
    before: XhsBudget,
    reservedAt: number,
  ): Promise<boolean>;
  /** Explicit cooldown precheck; otherwise reserve owns any cancellable waiting. */
  waitAllowanceMs?: number;
  assertReady?(tx?: Prisma.TransactionClient): Promise<void>;
}
export class XhsRequestBudget {
  constructor(private readonly store: XhsBudgetStore) {}
  async assertReady(tx?: Prisma.TransactionClient) {
    await this.store.assertReady?.(tx);
  }
  async check(id: string, now = Date.now()) {
    const budget = await this.store.read(id);
    if (!budget) throw new XhsSubscriptionError('XHS_REQUEST_BUDGET_REQUIRED');
    if (
      this.store.waitAllowanceMs !== undefined &&
      budget.nextAt > now + this.store.waitAllowanceMs
    )
      throw new XhsSubscriptionError('XHS_REQUEST_RATE_PAUSED');
  }
  /** Reversible only while the caller proves no transport dispatch has started. */
  async reserve(id: string, now = Date.now()): Promise<() => Promise<void>> {
    const before = await this.store.read(id);
    await this.admit(id, now);
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      if (before && this.store.rollback)
        await this.store.rollback(id, before, now);
    };
  }
  async admit(id: string, now = Date.now()) {
    if (!(await this.store.reserve(id, now))) {
      const budget = await this.store.read(id);
      if (!budget)
        throw new XhsSubscriptionError('XHS_REQUEST_BUDGET_REQUIRED');
      throw new XhsSubscriptionError('XHS_REQUEST_RATE_PAUSED');
    }
  }
}
