import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { splitSqliteStatements } from '../../../../scripts/sqlite-statements.cjs';
import {
  readLegacyXhsSourceFence,
  assertLegacyXhsSourceReady,
  LEGACY_XHS_REVIEW,
} from './xhs-legacy-source-fence';
import { XhsSourceRiskStore } from './xhs-source-risk-store';
import {
  bindXhsSourceTotalBudget,
  dispatchReviewedWholeContext,
  dispatchReviewedWholeSource,
} from './xhs-source-request-policy';
import { admitScheduledXhs, scheduledTaskId } from './xhs-scheduled-admission';
import { consumeReviewedContextPermit } from './xhs-reviewed-dispatch';
import * as attempts from './xhs-reviewed-attempt';

// Source guards are real Prisma/SQLite queries. Storage backup/host admission is
// injected here: this suite never represents a release writer-gate exercise.
jest.mock('./incremental-write', () => ({
  incrementalWrite: (_db: unknown, _bytes: number, run: () => unknown) => run(),
  assertIncrementalWriteAdmission: async () => {},
  assertIncrementalTransaction: async () => {},
  canReuseIncrementalTransactionChecks: () => false,
  withIncrementalTransactionChecks: (run: () => unknown) => run(),
}));

describe('legacy XHS facts close every candidate source lane', () => {
  let db: PrismaClient, folder: string, oldSql: string;
  const owner = '11111111-1111-4111-8111-111111111111';
  const complete = JSON.stringify({
    status: 'complete',
    added: 0,
    message: 'Synthetic complete',
  });
  const finite = JSON.stringify({
    status: 'partial',
    added: 3,
    message: 'Synthetic finite window',
  });
  const article = JSON.stringify({
    status: 'partial',
    added: 2,
    message: 'Synthetic article partial',
    failedCount: 1,
    failureScope: 'article',
  });
  beforeAll(async () => {
    folder = await fs.mkdtemp(
      path.join(os.tmpdir(), 'xhs-legacy-fence-synthetic-'),
    );
    db = new PrismaClient({
      datasources: {
        db: {
          url:
            'file:' + path.join(folder, 'fixture.sqlite').replace(/\\/g, '/'),
        },
      },
    });
    const migrations = path.resolve(__dirname, '../../prisma/migrations');
    for (const name of (await fs.readdir(migrations)).sort()) {
      if (!(await fs.stat(path.join(migrations, name))).isDirectory()) continue;
      for (const sql of splitSqliteStatements(
        await fs.readFile(path.join(migrations, name, 'migration.sql'), 'utf8'),
      ))
        await db.$executeRawUnsafe(sql);
    }
    oldSql = (
      await fs.readFile(
        path.resolve(
          __dirname,
          '../../test/redbook-isolated/fixtures/legacy-refresh-schema.sql',
        ),
        'utf8',
      )
    )
      // Current migrations use the complete BIGINT timestamp profile. Keep
      // these legacy tables coherent with the existing subscription table.
      .replace('"started_at" INTEGER NOT NULL', '"started_at" BIGINT NOT NULL')
      .replace('"created_at" INTEGER NOT NULL', '"created_at" BIGINT NOT NULL');
    await db.xhsCreator.create({
      data: {
        id: 'legacy-a',
        externalAuthorId: 'synthetic-a',
        profileUrl: 'https://example.invalid/a',
        displayName: 'Synthetic A',
      },
    });
    await db.xhsCreator.create({
      data: {
        id: 'legacy-b',
        externalAuthorId: 'synthetic-b',
        profileUrl: 'https://example.invalid/b',
        displayName: 'Synthetic B',
      },
    });
  }, 40000);
  beforeEach(async () => {
    for (const name of [
      'xhs_refresh_batch_items',
      'xhs_refresh_batches',
      'xhs_refresh_failures',
      'xhs_refresh_jobs',
    ])
      await db.$executeRawUnsafe(`DROP TABLE IF EXISTS ${name}`);
    await db.$executeRawUnsafe('DROP TABLE IF EXISTS _prisma_migrations');
    for (const sql of splitSqliteStatements(oldSql))
      await db.$executeRawUnsafe(sql);
    await db.$executeRaw`DELETE FROM xhs_subscription_tasks`;
    await db.$executeRaw`DELETE FROM xhs_request_budgets`;
    await db.$executeRaw`UPDATE xhs_source_risk SET state='clear',code=NULL,owner=NULL,http_status=NULL,endpoint=NULL WHERE id='source'`;
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await db?.$disconnect();
  });
  async function job(state = 'complete', outcome: string | null = complete) {
    await db.$executeRaw`INSERT INTO xhs_refresh_jobs(creator_id,generation,owner,started_at,state,outcome) VALUES('legacy-a',1,${owner},1,${state},${outcome})`;
  }
  async function batch(
    state = 'paused',
    itemState = 'reserved',
    outcome: string | null = null,
  ) {
    await db.$executeRaw`INSERT INTO xhs_refresh_batches(id,state,created_at) VALUES('synthetic-batch',${state},1)`;
    await db.$executeRaw`INSERT INTO xhs_refresh_batch_items(batch_id,position,creator_id,operation_id,state,outcome) VALUES('synthetic-batch',0,'legacy-a',${owner},${itemState},${outcome})`;
  }
  async function oldRows() {
    const rows = [];
    for (const name of [
      'xhs_refresh_jobs',
      'xhs_refresh_failures',
      'xhs_refresh_batches',
      'xhs_refresh_batch_items',
    ])
      rows.push(await db.$queryRawUnsafe(`SELECT * FROM ${name} ORDER BY 1,2`));
    return JSON.stringify(rows, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
  }
  const callbacks = () => {
    const found: any = {};
    bindXhsSourceTotalBudget(
      db as any,
      {
        assertSourceReady: jest.fn(),
        bindSourceAdmission: (admit: any, dispatch: any) =>
          Object.assign(found, { admit, dispatch }),
        waitForSourceRate: async () => {
          throw Error('unexpected wait');
        },
      } as any,
    );
    return found;
  };
  it.each([complete, finite, article])(
    'accepts an actual known complete job receipt: %s',
    async (raw) => {
      await job('complete', raw);
      expect(await readLegacyXhsSourceFence(db)).toEqual({ state: 'clear' });
      expect(await new XhsSourceRiskStore(db as any).read()).toBeUndefined();
    },
  );
  it('accepts a completed batch containing a recorded article partial', async () => {
    await job('complete', article);
    await batch('complete', 'partial', article);
    await db.$executeRaw`INSERT INTO xhs_refresh_failures(creator_id,generation,note_id,code) VALUES('legacy-a',1,'synthetic-note','NOTE_BODY_OR_MEDIA_INVALID')`;
    expect(await readLegacyXhsSourceFence(db)).toEqual({ state: 'clear' });
  });
  it('does not turn a proved stop/commit bookkeeping race into a source unknown', async () => {
    await job('complete', finite);
    await batch('stopped');
    expect(await readLegacyXhsSourceFence(db)).toEqual({ state: 'clear' });
  });
  it.each(['running', 'stopped'])(
    'keeps legacy %s globally closed with candidate clear and preserves every old row',
    async (state) => {
      await job(state, null);
      const before = await oldRows(),
        api = jest.fn(),
        callbacks_ = callbacks();
      expect(await new XhsSourceRiskStore(db as any).read()).toBe(
        LEGACY_XHS_REVIEW,
      );
      await expect(
        callbacks_.admit(true, undefined, async () => {}),
      ).rejects.toMatchObject({ code: LEGACY_XHS_REVIEW });
      await expect(
        callbacks_.dispatch(api, async () => {}),
      ).rejects.toMatchObject({ code: LEGACY_XHS_REVIEW });
      await expect(
        new XhsSourceRiskStore(db as any).begin(),
      ).rejects.toMatchObject({ code: LEGACY_XHS_REVIEW });
      expect(api).not.toHaveBeenCalled();
      expect(await oldRows()).toBe(before);
      expect(await db.$queryRaw`SELECT * FROM xhs_request_budgets`).toEqual([]);
      expect(
        await db.$queryRaw`SELECT state,code,owner FROM xhs_source_risk`,
      ).toEqual([{ state: 'clear', code: null, owner: null }]);
    },
  );
  it('keeps a paused batch closed even with a completed associated request', async () => {
    await job();
    await batch();
    expect(await readLegacyXhsSourceFence(db)).toMatchObject({
      state: 'blocked',
      reason: 'unresolved',
    });
  });
  it('does not accept a reserved item with no exact operation receipt', async () => {
    await batch('stopped');
    expect(await readLegacyXhsSourceFence(db)).toMatchObject({
      state: 'blocked',
    });
  });
  it.each([
    null,
    '',
    '{',
    'null',
    '[]',
    '1',
    '{"status":"unknown","added":0,"message":"x"}',
    '{"status":"complete"}',
    '{"status":"stopped","status":"complete","added":0,"message":"x"}',
    '{"status":"complete","added":0,"message":"x","nested":{"a":1,"a":2}}',
  ])(
    'fails closed on a malformed or ambiguous complete receipt %s',
    async (raw) => {
      await job('complete', raw);
      const before = await oldRows();
      await expect(assertLegacyXhsSourceReady(db)).rejects.toMatchObject({
        code: LEGACY_XHS_REVIEW,
      });
      expect(await oldRows()).toBe(before);
    },
  );
  it('rejects BLOB storage for a legacy outcome even when it contains valid JSON', async () => {
    await job();
    await db.$executeRaw`UPDATE xhs_refresh_jobs SET outcome=CAST(${complete} AS BLOB)`;
    expect(await readLegacyXhsSourceFence(db)).toMatchObject({
      state: 'blocked',
    });
  });
  it('blocks partial schema and wrong index predicates', async () => {
    await db.$executeRawUnsafe('DROP TABLE xhs_refresh_failures');
    expect(await readLegacyXhsSourceFence(db)).toMatchObject({
      state: 'blocked',
      reason: 'schema',
    });
  });
  it('only observes absence when every legacy table and receipt is absent', async () => {
    for (const name of [
      'xhs_refresh_batch_items',
      'xhs_refresh_batches',
      'xhs_refresh_failures',
      'xhs_refresh_jobs',
    ])
      await db.$executeRawUnsafe(`DROP TABLE ${name}`);
    expect(await readLegacyXhsSourceFence(db)).toEqual({ state: 'absent' });
    await db.$executeRawUnsafe(
      'CREATE TABLE _prisma_migrations(migration_name TEXT)',
    );
    await db.$executeRaw`INSERT INTO _prisma_migrations VALUES('20261105000000_xhs_refresh_ledger')`;
    expect(await readLegacyXhsSourceFence(db)).toMatchObject({
      state: 'blocked',
      reason: 'schema',
    });
  });
  it('rechecks state immediately before dispatch instead of trusting an earlier clear projection', async () => {
    await job();
    expect(await new XhsSourceRiskStore(db as any).read()).toBeUndefined();
    const { dispatch } = callbacks(),
      api = jest.fn();
    let once = false;
    await expect(
      dispatch(api, async () => {
        if (!once) {
          once = true;
          await db.$executeRaw`UPDATE xhs_refresh_jobs SET state='stopped'`;
        }
      }),
    ).rejects.toMatchObject({ code: LEGACY_XHS_REVIEW });
    expect(api).not.toHaveBeenCalled();
    expect(
      (await db.$queryRaw<any[]>`SELECT state FROM xhs_refresh_jobs`)[0].state,
    ).toBe('stopped');
  });
  it('persists a blocked scheduled receipt for another creator without changing old facts', async () => {
    await job('stopped', null);
    const before = await oldRows(),
      round = '2026-11-01/09:15',
      taskId = scheduledTaskId(round, 'legacy-b', 'basic');
    const result = await db.$transaction((tx) =>
      admitScheduledXhs(tx, {
        round,
        creatorId: 'legacy-b',
        phase: 'basic',
        now: 1,
        task: { taskId, creatorId: 'legacy-b', state: 'queued' },
      }),
    );
    expect(result).toMatchObject({
      kind: 'blocked',
      reason: 'XHS_SCHEDULE_SOURCE_BLOCKED',
    });
    expect(await oldRows()).toBe(before);
  });
  it('closes reviewed context and attempt lanes before their transports run', async () => {
    await job('stopped', null);
    const transport = jest.fn(),
      ready = jest.fn();
    await expect(
      dispatchReviewedWholeContext(
        db as any,
        {
          jobId: 'synthetic',
          id: 'context',
          authorId: 'a',
          noteId: 'n',
          phase: 'profile',
        },
        ready,
        transport,
      ),
    ).rejects.toMatchObject({ code: LEGACY_XHS_REVIEW });
    const scope: any = {
      jobId: 'synthetic',
      maxRequests: 1,
      authorId: 'a',
      noteId: 'n',
      phase: 'detail',
    };
    await expect(
      dispatchReviewedWholeSource(
        db as any,
        scope,
        'attempt',
        { authorId: 'a', noteId: 'n', phase: 'detail' },
        ready,
        transport,
        jest.fn(),
      ),
    ).rejects.toMatchObject({ code: LEGACY_XHS_REVIEW });
    expect(transport).not.toHaveBeenCalled();
  });
  it('settles an already received reviewed context result even when old state becomes blocked before settlement', async () => {
    await job();
    const binding: any = {
      jobId: 'synthetic',
      id: 'context',
      authorId: 'a',
      noteId: 'n',
      phase: 'profile',
    };
    jest.spyOn(attempts, 'startReviewedContextStage').mockResolvedValue({
      marker: 'synthetic-marker',
      owner: 'synthetic-owner',
    } as any);
    jest
      .spyOn(attempts, 'enterReviewedContextStage')
      .mockResolvedValue(undefined as any);
    // This case supplies synthetic stage ports, not a durable context record.
    const entered = jest
      .spyOn(attempts, 'assertEnteredReviewedContextStage')
      .mockResolvedValue(undefined);
    const settled = jest
      .spyOn(attempts, 'settleReviewedContextStage')
      .mockResolvedValue(undefined as any);
    const transport = async (permit: object) => {
      const capability = consumeReviewedContextPermit(permit, binding);
      const value = await capability.dispatch(async () => ({ received: true }));
      await db.$executeRaw`UPDATE xhs_refresh_jobs SET state='stopped'`;
      return value;
    };
    await expect(
      dispatchReviewedWholeContext(
        db as any,
        binding,
        async () => {},
        transport,
      ),
    ).resolves.toEqual({ received: true });
    expect(entered).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(await new XhsSourceRiskStore(db as any).read()).toBe(
      LEGACY_XHS_REVIEW,
    );
    const next = jest.fn();
    await expect(
      dispatchReviewedWholeContext(db as any, binding, async () => {}, next),
    ).rejects.toMatchObject({ code: LEGACY_XHS_REVIEW });
    expect(next).not.toHaveBeenCalled();
  });
});
