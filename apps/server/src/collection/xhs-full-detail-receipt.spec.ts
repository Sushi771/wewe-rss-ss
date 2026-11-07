import { XhsSubscriptionRuntime } from './xhs-subscription-runtime';
import { fullHistoryContext } from './xhs-full-history-scope';
import {
  XhsDetailIdentityMismatchError,
  XhsSourceParseError,
} from './xhs-subscription-errors';

/** Control-flow ports only: no physical dispatch, SQLite, credentials or source.
 * Exercise the real runtime catch boundary with synthetic per-attempt admission
 * and a reader that implements the exact request/risk query contract. */
describe('full detail exact response receipt', () => {
  const runtimes: XhsSubscriptionRuntime[] = [];
  afterEach(() => {
    for (const runtime of runtimes.splice(0)) runtime.onModuleDestroy();
  });
  const context = {
    reviewId: 'synthetic-review',
    jobId: 'synthetic-job',
    creatorId: 'synthetic-creator',
    authorId: 'synthetic-author',
  };
  const target = 'synthetic-note';
  const exact = {
    operationId: 'current-operation',
    reviewId: context.reviewId,
    taskId: context.jobId,
    creatorId: context.creatorId,
    target,
  };
  const clearRisk = {
    state: 'clear',
    owner: null,
    code: null,
    http_status: null,
    endpoint: null,
  };

  function fixture() {
    const source = jest.fn(async () => {
      throw new Error('synthetic source must never be called');
    });
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api: source,
      media: source,
      shortLinks: source,
    });
    runtimes.push(runtime);
    // These are explicit synthetic control-flow ports, not a replacement of
    // requireSession/assertFullScopeSession or of the receipt decision itself.
    const ports = runtime as any;
    ports.cookies = { a1: 'synthetic-only', web_session: 'synthetic-only' };
    const admission: any = { id: 'synthetic-admission' };
    const mismatch = new XhsDetailIdentityMismatchError();
    const records = [
      { ...exact, operationId: 'old-operation', outcome: 'response-received' },
      { ...exact, outcome: 'response-received' },
    ];
    let risk = { ...clearRisk };
    let readerFailure = false;
    let duringRead = () => {};
    const query = jest.fn(async (sql: string, ...args: unknown[]) => {
      if (sql.includes('FROM xhs_source_risk')) return [{ ...risk }];
      expect(sql).toContain("phase='detail' AND logical_target=?");
      expect(args).toEqual([
        exact.operationId,
        context.reviewId,
        context.jobId,
        context.creatorId,
        target,
      ]);
      return records
        .filter((row) =>
          [
            row.operationId,
            row.reviewId,
            row.taskId,
            row.creatorId,
            row.target,
          ].every((value, index) => value === args[index]),
        )
        .map((row) => ({
          operation_id: row.operationId,
          outcome: row.outcome,
        }));
    });
    const reader = jest.fn(async (work) => {
      if (readerFailure) throw new Error('synthetic reader failure');
      const result = await work({ $queryRawUnsafe: query });
      await Promise.resolve();
      duringRead();
      return result;
    });
    runtime.bindFullHistoryReader(reader);
    async function run(receipt: typeof exact | null = exact) {
      const sessionBinding = runtime.fullScopeSessionBinding();
      return fullHistoryContext.run({ ...context, sessionBinding }, () =>
        ports.fullHistoryNote.run(target, () =>
          ports.budgetScope.run(admission, () =>
            ports.withSessionOwned(async () => {
              if (receipt) admission.receivedFullDetail = { ...receipt };
              throw mismatch;
            }),
          ),
        ),
      );
    }
    return {
      runtime,
      ports,
      admission,
      mismatch,
      records,
      query,
      reader,
      source,
      run,
      setRisk: (next: Partial<typeof clearRisk>) => {
        risk = { ...risk, ...next };
      },
      failReader: () => {
        readerFailure = true;
      },
      duringRead: (work: () => void) => {
        duringRead = work;
      },
    };
  }

  it('maps only this exact settled response and completely clear durable risk', async () => {
    const f = fixture();
    const error = await f.run().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(XhsSourceParseError);
    expect(error).toMatchObject({ code: 'XHS_DETAIL_PARSE_FAILED' });
    expect(f.query).toHaveBeenCalledTimes(2);
    expect(f.source).not.toHaveBeenCalled();
  });

  it('does not substitute an old settled response for this unknown operation', async () => {
    const f = fixture();
    f.records[1].outcome = 'unknown';
    await expect(f.run()).rejects.toBe(f.mismatch);
    expect(f.query).toHaveBeenCalledTimes(2);
    expect(f.records[0].outcome).toBe('response-received');
    expect(f.records[1].outcome).toBe('unknown');
    expect(f.source).not.toHaveBeenCalled();
  });

  it('clears stale admission proof before the current attempt begins', async () => {
    const f = fixture();
    f.admission.receivedFullDetail = { ...exact, operationId: 'old-operation' };
    await expect(f.run(null)).rejects.toBe(f.mismatch);
    expect(f.reader).not.toHaveBeenCalled();
    expect(f.admission.receivedFullDetail).toBeUndefined();
  });

  it.each(['reviewId', 'taskId', 'creatorId', 'target'] as const)(
    'rejects receipt with a different %s binding',
    async (field) => {
      const f = fixture();
      await expect(f.run({ ...exact, [field]: 'wrong-binding' })).rejects.toBe(
        f.mismatch,
      );
      expect(f.reader).not.toHaveBeenCalled();
    },
  );

  it('does not map a failed durable reader to article-local parsing', async () => {
    const f = fixture();
    f.failReader();
    await expect(f.run()).rejects.toBe(f.mismatch);
  });

  it.each([
    { state: 'pending' },
    { owner: 'pending-owner' },
    { code: 'XHS_SOURCE_RATE_LIMIT_BLOCKED' },
    { http_status: 429 },
    { endpoint: 'detail' },
  ])('rejects residual durable risk %j', async (risk) => {
    const f = fixture();
    f.setRisk(risk as any);
    await expect(f.run()).rejects.toBe(f.mismatch);
  });

  it('rechecks session generation after awaiting the durable reader', async () => {
    const f = fixture();
    f.duringRead(() => {
      f.ports.generation++;
    });
    await expect(f.run()).rejects.toMatchObject({
      code: 'XHS_SESSION_CHANGED',
    });
  });

  it('rechecks the current stop after awaiting the durable reader', async () => {
    const f = fixture();
    f.duringRead(() => {
      f.ports.stopCode = 'XHS_SOURCE_RATE_LIMIT_BLOCKED';
    });
    await expect(f.run()).rejects.toMatchObject({
      code: 'XHS_SOURCE_RATE_LIMIT_BLOCKED',
    });
  });
});
