import { assertUnboundDispatch } from './xhs-unbound-round';

describe('unbound review dispatch guard', () => {
  it('allows an empty review ledger but blocks an unbound task when any review exists', async () => {
    const tx = { $executeRawUnsafe: jest.fn(), $queryRawUnsafe: jest.fn(async (sql: string): Promise<Array<{ name?: string; value?: number }>> => {
      if (sql.includes('sqlite_master')) return [{ name: 'xhs_unbound_owner_reviews' }];
      if (sql.includes('SELECT 1 FROM xhs_unbound_owner_reviews')) return [];
      throw new Error('unexpected query');
    }) };
    await expect(assertUnboundDispatch(tx as any)).resolves.toBeUndefined();
    tx.$queryRawUnsafe.mockImplementation(async (sql: string) => {
      if (sql.includes('sqlite_master')) return [{ name: 'xhs_unbound_owner_reviews' }];
      if (sql.includes('SELECT 1 FROM xhs_unbound_owner_reviews')) return [{ value: 1 }];
      throw new Error('unexpected query');
    });
    await expect(assertUnboundDispatch(tx as any)).rejects.toThrow('APPROVED_NEW_ROUND_REQUIRED');
  });
});
