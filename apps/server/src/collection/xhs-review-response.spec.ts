import { XhsWholeCreatorService } from './xhs-whole-creator.service';

it.each(['prepareFullHistoryUnknownReview', 'prepareScheduledPolicy'] as const)(
  '%s returns a JSON-safe response without mutating the internal review plan',
  async (method) => {
    const plan = {
      digest: 'a'.repeat(64),
      scope: { baseline: { fences: [{ next_at: 9007199254740993n }] } },
      originalRisk: { updated_at: 5n },
      budgetSnapshot: [{ used: 3n }],
      allUnresolvedRequests: [],
      ownerOperationBinding: 'unproved',
    };
    const host: any = {
      readyForMutation: async () => {},
      db: { $transaction: async () => plan },
      fullHistoryError: (e: unknown) => {
        throw e;
      },
      runtime: { fullScopeSessionBinding: () => 'b'.repeat(64) },
    };
    const result = await (XhsWholeCreatorService.prototype[method] as any).call(
      host,
      {},
    );
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(result.scope.baseline.fences[0].next_at).toBe('9007199254740993');
    expect(result.originalRisk).toBeUndefined();
    expect(result.budgetSnapshot).toBeUndefined();
    expect(plan.scope.baseline.fences[0].next_at).toBe(9007199254740993n);
  },
);
