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
}
export class XhsRequestBudget {
  constructor(private readonly store: XhsBudgetStore) {}
  async admit(id: string, now = Date.now()) {
    if (!(await this.store.reserve(id, now))) {
      const budget = await this.store.read(id);
      if (!budget)
        throw new XhsSubscriptionError('XHS_REQUEST_BUDGET_REQUIRED');
      if (budget.used >= budget.limit)
        throw new XhsSubscriptionError('XHS_REQUEST_BUDGET_EXHAUSTED');
      throw new XhsSubscriptionError('XHS_REQUEST_RATE_PAUSED');
    }
  }
}
