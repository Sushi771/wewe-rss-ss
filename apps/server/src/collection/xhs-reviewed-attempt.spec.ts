import { dispatchReviewedWholeSource } from './xhs-source-request-policy';
import {
  consumeReviewedTransportPermit,
  dispatchReviewedSource as dispatchReviewedDirect,
  type RecoveryWriter,
} from './xhs-reviewed-dispatch';
const dispatchReviewedSource = (
  db: any,
  scope: any,
  id: string,
  request: any,
  ready: any,
  transport: any,
  checkpoint: any,
) =>
  dispatchReviewedWholeSource(
    db,
    scope,
    id,
    request,
    ready,
    (permit) =>
      consumeReviewedTransportPermit(permit, scope).dispatch(() => transport()),
    checkpoint,
  );
jest.mock('./xhs-dispatch-owner-observation', () => ({
  observeDispatchOwner: jest.fn(() => 'dead'),
}));
jest.mock('./xhs-dispatch-owner', () => ({
  createDispatchOwner: () => ({
    pid: 22,
    startIdentity: '638000000000000001',
    nonce: '00000000-0000-4000-8000-000000000002',
  }),
  ownsDispatch: (v: any, e: any) =>
    v?.nonce === e?.nonce &&
    v?.pid === e?.pid &&
    v?.startIdentity === e?.startIdentity,
}));
import { PrismaClient } from '@prisma/client';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  attemptDigest,
  originalAttemptDigest,
  createReviewedAttempt,
  consumeReviewedAttempt,
  AttemptScope,
} from './xhs-reviewed-attempt';
import { observeDispatchOwner } from './xhs-dispatch-owner-observation';
describe('reviewed attempt transactional handoff', () => {
  let db: PrismaClient, folder: string, input: AttemptScope;
  const now = 1000;
  beforeAll(async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'reviewed-attempt-'));
    db = new PrismaClient({
      datasources: {
        db: { url: 'file:' + path.join(folder, 's.db').replace(/\\/g, '/') },
      },
    });
    await db.$executeRawUnsafe(
      'CREATE TABLE xhs_source_risk(id TEXT PRIMARY KEY,state TEXT,code TEXT)',
    );
    await db.$executeRaw`INSERT INTO xhs_source_risk VALUES('source','blocked','XHS_SOURCE_HISTORY_REVIEW_REQUIRED')`;
    await db.$executeRawUnsafe(
      'CREATE TABLE xhs_creators(id TEXT PRIMARY KEY,external_author_id TEXT,enabled INTEGER DEFAULT 1)',
    );
    await db.$executeRawUnsafe(
      'CREATE TABLE xhs_whole_creator_jobs(id TEXT PRIMARY KEY,creator_id TEXT,state TEXT,document TEXT)',
    );
    await db.$executeRawUnsafe(
      'CREATE TABLE xhs_limited_recovery(id TEXT PRIMARY KEY,note_id TEXT,author_id TEXT,state TEXT)',
    );
    await db.$executeRawUnsafe(
      'CREATE TABLE xhs_limited_recovery_append(id TEXT PRIMARY KEY,note_id TEXT,author_id TEXT,state TEXT)',
    );
    await db.$executeRawUnsafe(
      'CREATE TABLE xhs_request_budgets(id TEXT PRIMARY KEY,used INTEGER,request_limit INTEGER,next_at BIGINT,interval_ms INTEGER DEFAULT 10000)',
    );
  });
  beforeEach(async () => {
    await db.$executeRaw`UPDATE xhs_source_risk SET code='XHS_SOURCE_HISTORY_REVIEW_REQUIRED'`;
    await db.$executeRaw`DELETE FROM xhs_request_budgets`;
    await db.$executeRaw`DELETE FROM xhs_whole_creator_jobs`;
    await db.$executeRaw`DELETE FROM xhs_creators`;
    const owner = {
      pid: 11,
      startIdentity: '638000000000000000',
      nonce: '00000000-0000-4000-8000-000000000001',
    };
    const grant = { used: { detail: 1 }, limits: { detail: 5 } };
    const doc: any = {
      sourceFence: {
        marker: 'xhs:dispatch-pending:whole:old',
        phase: 'detail',
        noteId: 'note',
        state: 'started',
        owner,
      },
      code: 'XHS_DOWNLOAD_BLOCKED',
      sourceGrant: grant,
    };
    doc.unknownReview = {
      marker: doc.sourceFence.marker,
      owner,
      decision: 'request-retry',
      originalCode: doc.code,
      originalGrant: grant,
      recordedAt: 10,
    };
    await db.$executeRaw`INSERT INTO xhs_creators(id,external_author_id) VALUES('creator','author')`;
    await db.$executeRaw`INSERT INTO xhs_whole_creator_jobs VALUES('job','creator','paused',${JSON.stringify(doc)})`;
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,used,request_limit,next_at) VALUES('job',6,310,10000),('xhs:source-total',8,312,10000),('xhs:dispatch-pending:whole:old',1,1,0)`;
    input = {
      jobId: 'job',
      authorId: 'author',
      noteId: 'note',
      phase: 'detail',
      originalHash: originalAttemptDigest(doc),
      reviewId: attemptDigest(doc.unknownReview),
      maxRequests: 1,
      taskUsedCeiling: 7,
      sharedUsedCeiling: 9,
      expiresAt: 2000,
    };
  });
  afterAll(async () => {
    await db.$disconnect();
    await rm(folder, { recursive: true, force: true });
  });
  it('creates idempotently and hands off once while keeping unknown and all budget rows', async () => {
    const first = await db.$transaction((tx) =>
      createReviewedAttempt(tx, input, now),
    );
    expect(
      await db.$transaction((tx) => createReviewedAttempt(tx, input, now)),
    ).toEqual(first);
    const network = jest.fn();
    await db.$transaction((tx) =>
      consumeReviewedAttempt(tx, input, first.id, now),
    );
    network();
    await expect(
      db.$transaction((tx) => consumeReviewedAttempt(tx, input, first.id, now)),
    ).rejects.toThrow();
    expect(network).toHaveBeenCalledTimes(1);
    const rows = await db.$queryRaw<
      Array<{ document: string }>
    >`SELECT document FROM xhs_whole_creator_jobs WHERE id='job'`;
    expect(JSON.parse(rows[0].document).sourceFence.state).toBe('started');
    expect(JSON.parse(rows[0].document).code).toBe('XHS_DOWNLOAD_BLOCKED');
    expect(
      await db.$queryRaw`SELECT used,next_at FROM xhs_request_budgets WHERE id='xhs:source-total'`,
    ).toEqual([{ used: 8, next_at: BigInt(10000) }]);
    expect(
      (
        await db.$queryRaw<
          Array<{ id: string }>
        >`SELECT id FROM xhs_request_budgets`
      ).length,
    ).toBe(3);
  });
  it('consumes at most once under concurrent transactions', async () => {
    const a = await db.$transaction((tx) =>
      createReviewedAttempt(tx, input, now),
    );
    const r = await Promise.allSettled([
      db.$transaction((tx) => consumeReviewedAttempt(tx, input, a.id, now)),
      db.$transaction((tx) => consumeReviewedAttempt(tx, input, a.id, now)),
    ]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  });
  it('does not replay a consumed intent after caller interruption', async () => {
    const a = await db.$transaction((tx) =>
      createReviewedAttempt(tx, input, now),
    );
    await db.$transaction((tx) => consumeReviewedAttempt(tx, input, a.id, now));
    await expect(
      db.$transaction((tx) => consumeReviewedAttempt(tx, input, a.id, now)),
    ).rejects.toThrow();
  });
  it('rolls back a failed consumption before commit', async () => {
    const a = await db.$transaction((tx) =>
      createReviewedAttempt(tx, input, now),
    );
    await expect(
      db.$transaction(async (tx) => {
        await consumeReviewedAttempt(tx, input, a.id, now);
        throw Error('crash');
      }),
    ).rejects.toThrow();
    await expect(
      db.$transaction((tx) => consumeReviewedAttempt(tx, input, a.id, now)),
    ).resolves.toMatchObject({ state: 'consumed' });
  });
  it('refuses expired, mismatched scope or exhausted budget', async () => {
    await expect(
      db.$transaction((tx) =>
        createReviewedAttempt(tx, { ...input, noteId: 'other' }, now),
      ),
    ).rejects.toThrow();
    await expect(
      db.$transaction((tx) => createReviewedAttempt(tx, input, 3000)),
    ).rejects.toThrow();
    await expect(
      db.$transaction((tx) =>
        createReviewedAttempt(tx, { ...input, taskUsedCeiling: 6 }, now),
      ),
    ).rejects.toThrow();
  });
  it('refuses budget changes after preparation', async () => {
    const a = await db.$transaction((tx) =>
      createReviewedAttempt(tx, input, now),
    );
    await db.$executeRaw`UPDATE xhs_request_budgets SET used=used+1 WHERE id='xhs:source-total'`;
    await expect(
      db.$transaction((tx) => consumeReviewedAttempt(tx, input, a.id, now)),
    ).rejects.toThrow();
  });
  it('refuses legacy owner, live or unknown owners', async () => {
    (observeDispatchOwner as jest.Mock).mockReturnValueOnce('alive');
    await expect(
      db.$transaction((tx) => createReviewedAttempt(tx, input, now)),
    ).rejects.toThrow();
    (observeDispatchOwner as jest.Mock).mockReturnValueOnce('unknown');
    await expect(
      db.$transaction((tx) => createReviewedAttempt(tx, input, now)),
    ).rejects.toThrow();
    await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=json_remove(document,'$.sourceFence.owner') WHERE id='job'`;
    await expect(
      db.$transaction((tx) => createReviewedAttempt(tx, input, now)),
    ).rejects.toThrow();
  });
  it('refuses a new source verification block', async () => {
    await db.$executeRaw`UPDATE xhs_source_risk SET code='XHS_SOURCE_VERIFICATION_BLOCKED'`;
    await expect(
      db.$transaction((tx) => createReviewedAttempt(tx, input, now)),
    ).rejects.toThrow();
  });
  async function prepared() {
    input = { ...input, expiresAt: Date.now() + 60000 };
    await db.$executeRaw`UPDATE xhs_request_budgets SET next_at=0`;
    return db.$transaction((tx) => createReviewedAttempt(tx, input));
  }
  const descriptor = { authorId: 'author', noteId: 'note', phase: 'detail' };
  const write: any = (fn: any) => db.$transaction(fn);
  void write;
  it('dispatches exactly once, preserves unknown, and accumulates both budgets', async () => {
    const a = await prepared(),
      network = jest.fn(async () => ({ ok: true }));
    const call = () =>
      dispatchReviewedSource(
        db as any,
        input,
        a.id,
        descriptor,
        () => {},
        network,
        async (_tx, value) => value,
      );
    await expect(call()).resolves.toEqual({ ok: true });
    await expect(call()).rejects.toThrow();
    expect(network).toHaveBeenCalledTimes(1);
    expect(
      await db.$queryRaw`SELECT id,used FROM xhs_request_budgets WHERE id IN ('job','xhs:source-total') ORDER BY id`,
    ).toEqual([
      { id: 'job', used: 7 },
      { id: 'xhs:source-total', used: 9 },
    ]);
    expect(
      (
        await db.$queryRaw<
          Array<{ id: string }>
        >`SELECT id FROM xhs_request_budgets WHERE id='xhs:dispatch-pending:whole:old'`
      ).length,
    ).toBe(1);
    const rows = await db.$queryRaw<
      Array<{ document: string }>
    >`SELECT document FROM xhs_whole_creator_jobs WHERE id='job'`;
    expect(JSON.parse(rows[0].document).sourceFence.state).toBe('started');
  });
  it('dispatches at most once under concurrent calls', async () => {
    const a = await prepared(),
      network = jest.fn(async () => 1);
    const results = await Promise.allSettled([
      dispatchReviewedSource(
        db as any,
        input,
        a.id,
        descriptor,
        () => {},
        network,
        async () => 1,
      ),
      dispatchReviewedSource(
        db as any,
        input,
        a.id,
        descriptor,
        () => {},
        network,
        async () => 1,
      ),
    ]);
    expect(network).toHaveBeenCalledTimes(1);
    expect(results.filter((v) => v.status === 'fulfilled')).toHaveLength(1);
  });
  it('does not replay after a crash between durable consumption and transport', async () => {
    const a = await prepared(),
      network = jest.fn(async () => 1);
    let checks = 0;
    await expect(
      dispatchReviewedSource(
        db as any,
        input,
        a.id,
        descriptor,
        () => {
          if (++checks === 2) throw Error('crash');
        },
        network,
        async () => 1,
      ),
    ).rejects.toThrow();
    await expect(
      dispatchReviewedSource(
        db as any,
        input,
        a.id,
        descriptor,
        () => {},
        network,
        async () => 1,
      ),
    ).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
  });
  it('does not replay a network refusal', async () => {
    const a = await prepared(),
      network = jest.fn(async () => {
        throw Error('synthetic refusal');
      });
    await expect(
      dispatchReviewedSource(
        db as any,
        input,
        a.id,
        descriptor,
        () => {},
        network,
        async () => 1,
      ),
    ).rejects.toThrow();
    await expect(
      dispatchReviewedSource(
        db as any,
        input,
        a.id,
        descriptor,
        () => {},
        network,
        async () => 1,
      ),
    ).rejects.toThrow();
    expect(network).toHaveBeenCalledTimes(1);
  });
  it('rejects early rate admission and wrong scope without consumption', async () => {
    const a = await prepared(),
      network = jest.fn(async () => 1);
    await db.$executeRaw`UPDATE xhs_request_budgets SET next_at=${BigInt(Date.now() + 60000)} WHERE id='job'`;
    await expect(
      dispatchReviewedSource(
        db as any,
        input,
        a.id,
        descriptor,
        () => {},
        network,
        async () => 1,
      ),
    ).rejects.toThrow();
    await expect(
      dispatchReviewedSource(
        db as any,
        input,
        a.id,
        { ...descriptor, noteId: 'other' },
        () => {},
        network,
        async () => 1,
      ),
    ).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
  });

  it.each(['noteId', 'maxRequests'])(
    'rejects persisted scope tampering of %s with unchanged id',
    async (key) => {
      const a = await db.$transaction((tx) =>
        createReviewedAttempt(tx, input, now),
      );
      const field = '$.reviewAttempt.scope.' + key,
        value = key === 'noteId' ? 'another-note' : 2;
      await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=json_set(document,${field},${value}) WHERE id='job'`;
      await expect(
        db.$transaction((tx) => createReviewedAttempt(tx, input, now)),
      ).rejects.toThrow();
      await expect(
        db.$transaction((tx) => consumeReviewedAttempt(tx, input, a.id, now)),
      ).rejects.toThrow();
    },
  );

  it('retains consumed status and charge after failed business checkpoint', async () => {
    const a = await prepared(),
      network = jest.fn(async () => 1);
    await expect(
      dispatchReviewedSource(
        db as any,
        input,
        a.id,
        descriptor,
        () => {},
        network,
        async () => {
          throw Error('checkpoint failure');
        },
      ),
    ).rejects.toThrow();
    await expect(
      dispatchReviewedSource(
        db as any,
        input,
        a.id,
        descriptor,
        () => {},
        network,
        async () => 1,
      ),
    ).rejects.toThrow();
    expect(network).toHaveBeenCalledTimes(1);
    expect(
      (
        await db.$queryRaw<
          Array<{ used: number }>
        >`SELECT used FROM xhs_request_budgets WHERE id='xhs:source-total'`
      )[0].used,
    ).toBe(9);
  });

  it.each([
    { used: 1 },
    { used: 1, limit: null },
    { used: 1, limit: -1 },
    { used: 1, limit: 1.5 },
    { used: 1, limit: 1 },
    { limit: 5 },
    { used: -1, limit: 5 },
    { used: 0.5, limit: 5 },
  ])(
    'refuses invalid phase counters %j and rolls back admission',
    async (counters) => {
      const row = await db.$queryRaw<
        Array<{ document: string }>
      >`SELECT document FROM xhs_whole_creator_jobs WHERE id='job'`;
      const doc = JSON.parse(row[0].document);
      doc.sourceGrant = {
        used: { detail: counters.used },
        limits: { detail: counters.limit },
      };
      doc.unknownReview.originalGrant = doc.sourceGrant;
      input = {
        ...input,
        originalHash: originalAttemptDigest(doc),
        reviewId: attemptDigest(doc.unknownReview),
      };
      await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(doc)} WHERE id='job'`;
      const a = await prepared(),
        network = jest.fn(async () => 1);
      await expect(
        dispatchReviewedSource(
          db as any,
          input,
          a.id,
          descriptor,
          () => {},
          network,
          async () => 1,
        ),
      ).rejects.toThrow();
      expect(network).not.toHaveBeenCalled();
      const saved = await db.$queryRaw<
        Array<{ document: string }>
      >`SELECT document FROM xhs_whole_creator_jobs WHERE id='job'`;
      expect(JSON.parse(saved[0].document).reviewAttempt.state).toBe(
        'prepared',
      );
      expect(
        (
          await db.$queryRaw<
            Array<{ used: number }>
          >`SELECT used FROM xhs_request_budgets WHERE id='xhs:source-total'`
        )[0].used,
      ).toBe(8);
    },
  );
  async function assertPreservedDispatchEvidence(charged: boolean) {
    const rows = await db.$queryRaw<Array<{ document: string }>>`
      SELECT document FROM xhs_whole_creator_jobs WHERE id='job'`;
    const job = JSON.parse(rows[0].document);
    expect(job.sourceFence).toMatchObject({
      marker: 'xhs:dispatch-pending:whole:old',
      phase: 'detail',
      noteId: 'note',
      state: 'started',
    });
    expect(job.unknownReview.originalCode).toBe('XHS_DOWNLOAD_BLOCKED');
    expect(
      await db.$queryRaw`
      SELECT id,used FROM xhs_request_budgets
      WHERE id IN ('job','xhs:source-total','xhs:dispatch-pending:whole:old') ORDER BY id
    `,
    ).toEqual([
      { id: 'job', used: charged ? 7 : 6 },
      { id: 'xhs:dispatch-pending:whole:old', used: 1 },
      { id: 'xhs:source-total', used: charged ? 9 : 8 },
    ]);
    return job;
  }
  function directCall(
    id: string,
    writer: RecoveryWriter,
    reader: RecoveryWriter | undefined,
    network: () => Promise<number>,
  ) {
    return dispatchReviewedDirect(
      writer,
      input,
      id,
      descriptor,
      () => {},
      (permit) =>
        consumeReviewedTransportPermit(permit, input).dispatch(network),
      async (_tx, value) => value,
      undefined,
      reader,
    );
  }
  it('starts a single physical send only after both writes and the fresh reader finish', async () => {
    const a = await prepared();
    let writing = false,
      reading = false,
      commits = 0,
      readComplete = false;
    const writer: RecoveryWriter = async (work) => {
      writing = true;
      try {
        const result = await db.$transaction(work);
        commits++;
        return result;
      } finally {
        writing = false;
      }
    };
    const reader: RecoveryWriter = async (work) => {
      reading = true;
      try {
        return await db.$transaction(work);
      } finally {
        reading = false;
        readComplete = true;
      }
    };
    const network = jest.fn(async () => {
      expect(writing).toBe(false);
      expect(reading).toBe(false);
      expect(commits).toBe(2);
      expect(readComplete).toBe(true);
      const rows = await db.$queryRaw<Array<{ document: string }>>`
        SELECT document FROM xhs_whole_creator_jobs WHERE id='job'`;
      expect(
        JSON.parse(rows[0].document).reviewAttempt.dispatch.transportEntered,
      ).toBe(true);
      return 42;
    });
    await expect(directCall(a.id, writer, reader, network)).resolves.toBe(42);
    expect(network).toHaveBeenCalledTimes(1);
    expect(commits).toBe(3);
    await assertPreservedDispatchEvidence(true);
  });
  it('keeps consumed unknown and charges when the fresh reader fails without sending', async () => {
    const a = await prepared();
    const network = jest.fn(async () => 1);
    const reader: RecoveryWriter = async () => {
      throw new Error('synthetic reader failure');
    };
    await expect(directCall(a.id, write, reader, network)).rejects.toThrow(
      'synthetic reader failure',
    );
    expect(network).not.toHaveBeenCalled();
    const job = await assertPreservedDispatchEvidence(true);
    expect(job.reviewAttempt.state).toBe('consumed');
    expect(job.reviewAttempt.dispatch.transportEntered).toBe(true);
  });
  it('never sends if the second write rolls back after its callback succeeds', async () => {
    const a = await prepared();
    let transactions = 0;
    const writer: RecoveryWriter = (work) =>
      db.$transaction(async (tx) => {
        const value = await work(tx);
        if (++transactions === 2) throw new Error('synthetic commit failure');
        return value;
      });
    const readerCalled = jest.fn();
    const reader: RecoveryWriter = (work) => {
      readerCalled();
      return db.$transaction(work);
    };
    const network = jest.fn(async () => 1);
    await expect(directCall(a.id, writer, reader, network)).rejects.toThrow(
      'synthetic commit failure',
    );
    expect(network).not.toHaveBeenCalled();
    expect(readerCalled).not.toHaveBeenCalled();
    const job = await assertPreservedDispatchEvidence(true);
    expect(job.reviewAttempt.state).toBe('consumed');
    expect(job.reviewAttempt.dispatch.transportEntered).not.toBe(true);
  });
  it('rejects durable platform risk changed after entry commit before any physical send', async () => {
    const a = await prepared();
    const reader: RecoveryWriter = async (work) => {
      await db.$executeRaw`UPDATE xhs_source_risk SET code='XHS_SOURCE_RATE_LIMIT_BLOCKED' WHERE id='source'`;
      return db.$transaction(work);
    };
    const network = jest.fn(async () => 1);
    await expect(directCall(a.id, write, reader, network)).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
    await assertPreservedDispatchEvidence(true);
    expect(
      await db.$queryRaw`SELECT state,code FROM xhs_source_risk WHERE id='source'`,
    ).toEqual([{ state: 'blocked', code: 'XHS_SOURCE_RATE_LIMIT_BLOCKED' }]);
  });
  it('fails closed without a reader before consuming a reviewed single attempt', async () => {
    const a = await prepared();
    const network = jest.fn(async () => 1);
    await expect(directCall(a.id, write, undefined, network)).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
    const job = await assertPreservedDispatchEvidence(false);
    expect(job.reviewAttempt.state).toBe('prepared');
  });
  it.each([false, true])(
    'retains response-time cooldown after a slow reader (longer existing deadline=%s)',
    async (longerDeadline) => {
      const a = await prepared();
      let clock = Date.now();
      let deadline = 0;
      const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => clock);
      try {
        const reader: RecoveryWriter = async (work) => {
          const value = await db.$transaction(work);
          clock += 20000;
          return value;
        };
        const network = jest.fn(async () => {
          if (longerDeadline) {
            deadline = clock + 60000;
            await db.$executeRaw`UPDATE xhs_request_budgets SET next_at=${BigInt(deadline)}
              WHERE id IN ('job','xhs:source-total')`;
          }
          clock += 1000;
          return 1;
        });
        await expect(directCall(a.id, write, reader, network)).resolves.toBe(1);
        const budgets = await db.$queryRaw<
          Array<{
            id: string;
            used: number;
            request_limit: number;
            next_at: bigint;
            interval_ms: number;
          }>
        >`SELECT id,used,request_limit,next_at,interval_ms FROM xhs_request_budgets
          WHERE id IN ('job','xhs:source-total') ORDER BY id`;
        expect(
          budgets.map(({ id, used, request_limit }) => ({
            id,
            used,
            request_limit,
          })),
        ).toEqual([
          { id: 'job', used: 7, request_limit: 310 },
          { id: 'xhs:source-total', used: 9, request_limit: 312 },
        ]);
        for (const row of budgets) {
          expect(Number(row.next_at)).toBeGreaterThanOrEqual(
            clock + row.interval_ms,
          );
          if (longerDeadline) expect(Number(row.next_at)).toBe(deadline);
        }
        await assertPreservedDispatchEvidence(true);
        await expect(
          directCall(a.id, write, reader, network),
        ).rejects.toThrow();
        expect(network).toHaveBeenCalledTimes(1);
      } finally {
        nowSpy.mockRestore();
      }
    },
  );
});
