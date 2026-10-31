import { XhsSubscriptionError } from './xhs-subscription-errors';
import { LocalArticleStore, ArticlePreparation } from '../article-local-save';
import { xhsLocalSnapshotPublisher } from './xhs-local-snapshot';
import { XhsSubscriptionService } from './xhs-subscription.service';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { PrismaClient } from '@prisma/client';
import { splitSqliteStatements } from '../../../../scripts/sqlite-statements.cjs';
import { XhsWholeCreatorService } from './xhs-whole-creator.service';
import { XhsEngagementService } from './xhs-engagement.service';
import { xhsNoteMetrics, mapXhsComments } from './xhs-engagement-contract';
import { RedbookSubscriptionAdapter } from './xhs-redbook-subscription';
import { XhsSubscriptionRuntime } from './xhs-subscription-runtime';
import { XhsRequestBudget } from './xhs-request-budget';
import { XhsSqliteBudgetStore } from './xhs-request-budget-store';
import { bindXhsSourceTotalBudget } from './xhs-source-request-policy';
import { batchStorageLock } from './batch-storage-lock';

const noteId = JSON.stringify(['xiaohongshu', 'note', 'note']);
describe('whole creator durable offline closure', () => {
  let db: PrismaClient, folder: string;
  const nativeTests: Promise<unknown>[] = [];
  const nativeLanes: Array<() => Promise<unknown>> = [];
  async function finishNativeWork() {
    await Promise.allSettled(nativeTests);
    for (const lane of nativeLanes) await lane();
  }
  beforeAll(async () => {
    folder = await fs.mkdtemp(path.join(tmpdir(), 'whole-synthetic-'));
    db = new PrismaClient({
      datasources: {
        db: {
          url:
            'file:' + path.join(folder, 'synthetic.sqlite').replace(/\\/g, '/'),
        },
      },
    });
    const migrations = path.resolve(__dirname, '../../prisma/migrations');
    for (const name of (await fs.readdir(migrations)).sort()) {
      if (!(await fs.stat(path.join(migrations, name))).isDirectory()) continue;
      const sql = await fs.readFile(
        path.join(migrations, name, 'migration.sql'),
        'utf8',
      );
      for (const statement of splitSqliteStatements(sql))
        await db.$executeRawUnsafe(statement);
    }
    await db.xhsCreator.create({
      data: {
        id: 'creator',
        externalAuthorId: 'author',
        profileUrl: 'https://www.xiaohongshu.com/user/profile/author',
        displayName: 'Synthetic',
      },
    });
  }, 30000);
  afterAll(async () => {
    await finishNativeWork();
    await db.$disconnect();
    await fs.rm(folder, { recursive: true, force: true });
  }, 40000);
  it('reads and atomically reserves real SQLite budgets', async () => {
    const { XhsSqliteBudgetStore } = await import('./xhs-request-budget-store');
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,interval_ms) VALUES('probe',7,1000)`;
    const store = new XhsSqliteBudgetStore(db);
    expect((await store.read('probe'))!.used).toBe(0);
    expect(await store.reserve('probe', Date.now())).toBe(true);
    expect((await store.read('probe'))!.used).toBe(1);
  });
  it.each(['missing', 'exhausted'] as const)(
    'handles %s legacy budget metadata without touching any reservation',
    async (state) => {
      const reserve = jest.fn(async () => true);
      const budget = new XhsRequestBudget({
        reserve,
        read: async () =>
          state === 'missing'
            ? null
            : {
                id: 'synthetic',
                used: 1,
                limit: 1,
                nextAt: 9999,
                intervalMs: 1000,
              },
      });
      if (state === 'missing') await expect(budget.check('synthetic', 0)).rejects.toThrow('XHS_REQUEST_BUDGET_REQUIRED');
      else await expect(budget.check('synthetic', 0)).resolves.toBeUndefined();
      expect(reserve).not.toHaveBeenCalled();
    },
  );
  it('prechecks cooldown only for an explicit policy without bypassing reserve', async () => {
    const store = {
      read: async () => ({
        id: 'synthetic',
        used: 0,
        limit: 2,
        nextAt: 2000,
        intervalMs: 1000,
      }),
      reserve: jest.fn(async () => false),
    };
    const legacy = new XhsRequestBudget(store);
    await expect(legacy.check('synthetic', 1000)).resolves.toBeUndefined();
    await expect(legacy.reserve('synthetic', 1000)).rejects.toThrow(
      'XHS_REQUEST_RATE_PAUSED',
    );
    expect(store.reserve).toHaveBeenCalledTimes(1);
    const immediate = new XhsRequestBudget({ ...store, waitAllowanceMs: 0 });
    await expect(immediate.check('synthetic', 1000)).rejects.toThrow(
      'XHS_REQUEST_RATE_PAUSED',
    );
    const bounded = new XhsRequestBudget({ ...store, waitAllowanceMs: 1000 });
    await expect(bounded.check('synthetic', 1000)).resolves.toBeUndefined();
    await expect(bounded.check('synthetic', 999)).rejects.toThrow(
      'XHS_REQUEST_RATE_PAUSED',
    );
    expect(store.reserve).toHaveBeenCalledTimes(1);
  });
  const legacyRuntimeRate = async (
    mode:
      | 'complete'
      | 'cancel'
      | 'exhausted'
      | 'shared-cancel'
      | 'shared-exhausted',
  ) => {
    const creatorId = `synthetic-rate-${mode}`;
    const shared = mode.startsWith('shared-');
    const cancelling = mode.endsWith('cancel');
    const profile = `https://www.xiaohongshu.com/user/profile/${creatorId}`;
    await db.xhsCreator.create({
      data: {
        id: creatorId,
        externalAuthorId: creatorId,
        profileUrl: profile,
        displayName: 'Synthetic rate',
      },
    });
    if (shared)
      await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,interval_ms)
        VALUES('xhs:source-total',${mode === 'shared-exhausted' ? 1 : 2},1000)`;
    const api = jest.fn(async (request) => ({
      status: 200,
      url: request.url,
      body: { success: true, code: 0, data: {} },
    }));
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      profileParser: () => ({
        id: creatorId,
        name: 'Synthetic rate',
        profileUrl: profile,
      }),
    });
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    bindXhsSourceTotalBudget(db as any, runtime);
    let jobId = '',
      firstTotal: Awaited<ReturnType<XhsSqliteBudgetStore['read']>>;
    const attempts: Array<{
      at: number;
      accepted: boolean;
      priorNextAt: number;
    }> = [];
    let waiting!: () => void;
    const cooldown = new Promise<void>((resolve) => (waiting = resolve));
    const originalWait = runtime.waitForSourceRate.bind(runtime);
    const waitSpy = jest.spyOn(runtime, 'waitForSourceRate').mockImplementation(async ms => { if (cancelling) waiting(); return originalWait(ms); });
    const originalReserve = XhsSqliteBudgetStore.prototype.reserve;
    const reserve = jest
      .spyOn(XhsSqliteBudgetStore.prototype, 'reserve')
      .mockImplementation(async function (this: XhsSqliteBudgetStore, id, now) {
        const before = await this.read(id);
        const accepted = await originalReserve.call(this, id, now);
        if (id === jobId) {
          attempts.push({ at: now, accepted, priorNextAt: before!.nextAt });
          if (!accepted && before!.used < before!.limit && before!.nextAt > now)
            waiting();
        }
        return accepted;
      });
    const subscriptions: any = {
      refresh: async () => {
        const rows = await db.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM xhs_whole_creator_jobs WHERE creator_id=${creatorId}`;
        jobId = rows[0].id;
        await runtime.resolve(profile);
        firstTotal = await new XhsSqliteBudgetStore(db).read(
          'xhs:source-total',
        );
        await runtime.resolve(profile);
        return { taskId: 'synthetic-rate-list' };
      },
      task: async () => ({ state: 'completed' }),
      cancelTask: jest.fn(async () => ({})),
    };
    const whole = new XhsWholeCreatorService(
      db as any,
      subscriptions,
      runtime,
      {
        refreshMetrics: async () => ({ collectedAt: 1 }),
      } as any,
    );
    nativeLanes.push(() => (whole as any).lane);
    try {
      const started = await whole.start({
        creatorId,
        requestLimit: mode === 'exhausted' ? 1 : 2,
        intervalMs: shared ? 5000 : 1000,
      });
      if (cancelling) {
        // Observe the actual old wrapper's rejected SQLite reservation, not a copied waiter.
        const reachedWait = await Promise.race([
          cooldown.then(() => true),
          (whole as any).lane.then(() => false),
        ]);
        expect(reachedWait).toBe(true);
        expect(waitSpy).toHaveBeenCalled();
        await whole.cancel(started.id);
      }
      await (whole as any).lane;
      const result = await whole.view(started.id);
      expect(result.state).toBe(
        cancelling ? 'cancelled' : 'completed',
      );
      if (cancelling) expect(result.code).toBe('XHS_TASK_CANCELLED');
      const count = cancelling ? 1 : 2;
      expect(api).toHaveBeenCalledTimes(count);
      expect(result.budget!.used).toBe(count);
      const admitted = attempts.filter((attempt) => attempt.accepted);
      expect(admitted).toHaveLength(count);
      if (!cancelling) {
        expect(admitted[1].at).toBeGreaterThanOrEqual(admitted[1].priorNextAt);
        expect(admitted[1].at - admitted[0].at).toBeGreaterThanOrEqual(1000);
      }
      if (shared) {
        // Cancellation after total reservation rolls back only the undispatched request.
        const total = await new XhsSqliteBudgetStore(db).read(
          'xhs:source-total',
        );
        if (cancelling) expect(total).toEqual(firstTotal!);
        expect(total!.used).toBe(count);
      }
    } finally {
      await (whole as any).lane;
      reserve.mockRestore();
      waitSpy.mockRestore();
      runtime.onModuleDestroy();
      await db.$executeRaw`DELETE FROM xhs_request_budgets WHERE id='xhs:source-total'`;
    }
  };
  it.each([
    'complete',
    'cancel',
    'exhausted',
    'shared-cancel',
    'shared-exhausted',
  ] as const)(
    'keeps real runtime admission compatible with the legacy whole-task waiter: %s',
    (mode) => {
      const pending = legacyRuntimeRate(mode);
      nativeTests.push(pending);
      return pending;
    },
    40000,
  );
  let dispatchFixture = 0;
  const dispatchClock = async (mode: string) => {
    const creatorId = `synthetic-dispatch-${mode}-${++dispatchFixture}`;
    const profile = `https://www.xiaohongshu.com/user/profile/${creatorId}`;
    await db.xhsCreator.create({
      data: {
        id: creatorId,
        externalAuthorId: creatorId,
        profileUrl: profile,
        displayName: 'Synthetic dispatch clock',
      },
    });
    const limit = mode === 'exhausted' ? 2 : mode === 'race-exhausted' ? 3 : 6;
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,interval_ms)
      VALUES('xhs:source-total',${limit},1000)`;
    const times: number[] = [];
    const api = jest.fn(async (request) => {
      times.push(Date.now());
      return {
        status: 200,
        url: request.url,
        body: { success: true, code: 0, data: {} },
      };
    });
    const makeRuntime = () =>
      new XhsSubscriptionRuntime({
        enabled: () => true,
        api,
        profileParser: () => ({
          id: creatorId,
          name: 'Synthetic',
          profileUrl: profile,
        }),
      });
    const runtime = makeRuntime(),
      ordinary = makeRuntime();
    for (const instance of [runtime, ordinary]) {
      await instance.connectSession({
        a1: 'synthetic-a1',
        webSession: 'synthetic-session',
      });
      bindXhsSourceTotalBudget(db as any, instance);
    }
    let jobId = '',
      signalWait!: () => void,
      signalFinal!: () => void;
    const legacyWaiting = new Promise<void>((r) => (signalWait = r));
    const finalWaiting = new Promise<void>((r) => (signalFinal = r));
    let localAdmitted = 0;
    const original = XhsSqliteBudgetStore.prototype.reserve;
    const spy = jest
      .spyOn(XhsSqliteBudgetStore.prototype, 'reserve')
      .mockImplementation(async function (this: XhsSqliteBudgetStore, id, now) {
        const accepted = await original.call(this, id, now);
        if (id === jobId) {
          if (accepted) localAdmitted++;
          else signalWait();
        }
        return accepted;
      });
    const wait = runtime.waitForSourceRate.bind(runtime);
    jest.spyOn(runtime, 'waitForSourceRate').mockImplementation(async (ms) => {
      if (localAdmitted === 2) signalFinal();
      return wait(ms);
    });
    const subscriptions: any = {
      refresh: async () => {
        const rows = await db.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM xhs_whole_creator_jobs WHERE creator_id=${creatorId}`;
        jobId = rows[0].id;
        await runtime.resolve(profile);
        await runtime.resolve(profile);
        return { taskId: 'synthetic-clock-list' };
      },
      task: async () => ({ state: 'completed' }),
      cancelTask: async () => ({}),
    };
    const whole = new XhsWholeCreatorService(
      db as any,
      subscriptions,
      runtime,
      { refreshMetrics: async () => ({ collectedAt: 1 }) } as any,
    );
    nativeLanes.push(() => (whole as any).lane);
    const pending: Promise<unknown>[] = [];
    try {
      const started = await whole.start({
        creatorId,
        requestLimit: 2,
        intervalMs: mode === 'final-cancel' ? 1500 : 2200,
      });
      if (mode === 'interleave' || mode === 'final-cancel') {
        await legacyWaiting;
        await ordinary.resolve(profile);
        if (mode === 'final-cancel') {
          expect(
            await Promise.race([
              finalWaiting.then(() => true),
              (whole as any).lane.then(() => false),
            ]),
          ).toBe(true);
          await whole.cancel(started.id);
        }
      }
      await (whole as any).lane;
      if (mode === 'serial') await ordinary.resolve(profile);
      if (mode === 'concurrent' || mode === 'race-exhausted') {
        pending.push(runtime.resolve(profile), ordinary.resolve(profile));
        const results = await Promise.allSettled(pending);
        expect(
          results
            .filter((r) => r.status === 'rejected')
            .map((r) => (r as PromiseRejectedResult).reason.message),
        ).toEqual([]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
      }
      if (mode === 'exhausted') await ordinary.resolve(profile);
      const expected =
        mode === 'concurrent' || mode === 'race-exhausted'
          ? 4
          : mode === 'final-cancel' ? 2 : 3;
      expect(api).toHaveBeenCalledTimes(expected);
      for (let i = 1; i < times.length; i++)
        expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(1000);
      const total = await new XhsSqliteBudgetStore(db).read('xhs:source-total');
      expect(total!.used).toBe(expected);
      expect(total!.nextAt).toBeGreaterThanOrEqual(
        times[times.length - 1] + 1000,
      );
      const job = await whole.view(started.id);
      expect(job.state).toBe(
        mode === 'final-cancel' ? 'cancelled' : 'completed',
      );
      expect(job.budget!.used).toBe(mode === 'final-cancel' ? 1 : 2);
    } finally {
      await Promise.allSettled(pending);
      await (whole as any).lane;
      spy.mockRestore();
      for (const instance of [runtime, ordinary]) instance.onModuleDestroy();
      await db.$executeRaw`DELETE FROM xhs_request_budgets WHERE id='xhs:source-total'`;
    }
  };
  it.each([
    'serial',
    'interleave',
    'final-cancel',
    'concurrent',
    'race-exhausted',
    'exhausted',
  ])(
    'spaces actual shared transport starts after whole-task waits: %s',
    (mode) => {
      const pending = (async () => {
        for (let run = 0; run < (mode === 'concurrent' ? 3 : 1); run++)
          await dispatchClock(mode);
      })();
      nativeTests.push(pending);
      return pending;
    },
    40000,
  );
  it('a non-dispatch receipt is consumed once even if cleanup is called again', async () => {
    let used = 0;
    const rollback = jest.fn(async () => {
      used--;
      return true;
    });
    const gate = new XhsRequestBudget({
      read: async (id) => ({ id, used, limit: 3, intervalMs: 0, nextAt: 0 }),
      reserve: async () => {
        used++;
        return true;
      },
      rollback,
    });
    const undo = await gate.reserve('synthetic');
    await undo();
    await undo();
    expect(used).toBe(0);
    expect(rollback).toHaveBeenCalledTimes(1);
  });
  it.each(['response', 'commit-ack'])(
    'keeps the shared charge and never replays after an uncertain %s',
    async (mode) => {
      await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,interval_ms)
        VALUES('xhs:source-total',3,1000)`;
      const api = jest.fn(async (request) => {
        if (mode === 'response')
          throw new Error('synthetic transport receipt lost');
        return {
          status: 200,
          url: request.url,
          body: { success: true, code: 0, data: {} },
        };
      });
      const runtime = new XhsSubscriptionRuntime({
        enabled: () => true,
        api,
        profileParser: () => ({
          id: 'synthetic',
          name: 'Synthetic',
          profileUrl: 'https://www.xiaohongshu.com/user/profile/synthetic',
        }),
      });
      await runtime.connectSession({
        a1: 'synthetic-a1',
        webSession: 'synthetic-session',
      });
      bindXhsSourceTotalBudget(db as any, runtime);
      const original = db.$transaction.bind(db);
      let lost = false;
      const transaction = jest
        .spyOn(db, '$transaction')
        .mockImplementation((async (...args: any[]) => {
          const result = await (original as any)(...args);
          if (mode === 'commit-ack' && api.mock.calls.length && !lost) {
            lost = true;
            throw new Error('synthetic dispatch commit acknowledgment lost');
          }
          return result;
        }) as any);
      try {
        await expect(
          runtime.resolve('https://www.xiaohongshu.com/user/profile/synthetic'),
        ).rejects.toThrow();
        expect(api).toHaveBeenCalledTimes(1);
        expect(
          (await new XhsSqliteBudgetStore(db).read('xhs:source-total'))!.used,
        ).toBe(1);
        if (mode === 'commit-ack') expect(lost).toBe(true);
      } finally {
        transaction.mockRestore();
        runtime.onModuleDestroy();
        await db.$executeRaw`DELETE FROM xhs_request_budgets WHERE id='xhs:source-total'`;
      }
    },
    40000,
  );
  it.each(['ENOENT', 'EACCES'])(
    'handles only a released admission lock while preserving other read errors: %s',
    async (code) => {
      const directory = path.join(folder, `lock-${code}`);
      await fs.mkdir(directory);
      const lock = path.join(directory, 'worker.lock');
      // A claim created outside this module exercises the cross-process read path.
      await fs.writeFile(lock, String(process.pid));
      const release = async () => fs.unlink(lock);
      const readFile = fs.readFile.bind(fs);
      let released = false;
      const read = jest.spyOn(fs, 'readFile').mockImplementation((async (
        ...args: any[]
      ) => {
        if (args[0] === lock) {
          if (code === 'ENOENT') {
            await release();
            released = true;
          } else
            throw Object.assign(new Error('synthetic denied lock read'), {
              code,
            });
        }
        return (readFile as any)(...args);
      }) as any);
      try {
        if (code === 'ENOENT')
          await expect(batchStorageLock(directory)).resolves.toBeUndefined();
        else
          await expect(batchStorageLock(directory)).rejects.toMatchObject({
            code,
          });
        expect(read).toHaveBeenCalledWith(lock, 'utf8');
      } finally {
        read.mockRestore();
        if (!released) await release();
      }
      await expect(fs.access(lock + '.recovery')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      const next = await batchStorageLock(directory);
      expect(next).toEqual(expect.any(Function));
      await next!();
    },
  );
  it.each(['before-fence', 'after-fence'])(
    'observes committed cancellation at the final boundary: %s',
    async (mode) => {
      const creatorId = `synthetic-boundary-${mode}`;
      const profile = `https://www.xiaohongshu.com/user/profile/${creatorId}`;
      await db.xhsCreator.create({
        data: {
          id: creatorId,
          externalAuthorId: creatorId,
          profileUrl: profile,
          displayName: 'Synthetic cancellation',
        },
      });
      await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,interval_ms)
        VALUES('xhs:source-total',2,1000)`;
      const api = jest.fn(async (request) => ({
        status: 200,
        url: request.url,
        body: { success: true, code: 0, data: {} },
      }));
      const runtime = new XhsSubscriptionRuntime({
        enabled: () => true,
        api,
        profileParser: () => ({
          id: creatorId,
          name: 'Synthetic',
          profileUrl: profile,
        }),
      });
      await runtime.connectSession({
        a1: 'synthetic-a1',
        webSession: 'synthetic-session',
      });
      bindXhsSourceTotalBudget(db as any, runtime);
      let jobId = '',
        reserved = false,
        injected = false;
      const subscriptions: any = {
        refresh: async () => {
          const rows = await db.$queryRaw<
            Array<{ id: string }>
          >`SELECT id FROM xhs_whole_creator_jobs WHERE creator_id=${creatorId}`;
          jobId = rows[0].id;
          await runtime.resolve(profile);
          return { taskId: 'synthetic-boundary-list' };
        },
        task: async () => ({ state: 'completed' }),
        cancelTask: async () => ({}),
      };
      const whole = new XhsWholeCreatorService(
        db as any,
        subscriptions,
        runtime,
        { refreshMetrics: async () => ({ collectedAt: 1 }) } as any,
      );
      nativeLanes.push(() => (whole as any).lane);
      const originalReserve = XhsSqliteBudgetStore.prototype.reserve;
      const reserve = jest
        .spyOn(XhsSqliteBudgetStore.prototype, 'reserve')
        .mockImplementation(async function (
          this: XhsSqliteBudgetStore,
          id,
          now,
        ) {
          const result = await originalReserve.call(this, id, now);
          if (id === jobId && result) reserved = true;
          return result;
        });
      const query = db.$queryRaw.bind(db);
      const read = jest.spyOn(db, '$queryRaw').mockImplementation((async (
        ...args: any[]
      ) => {
        const result = await (query as any)(...args);
        if (
          mode === 'before-fence' &&
          reserved &&
          !injected &&
          String(args[0]).includes('SELECT * FROM xhs_request_budgets') &&
          args.includes('xhs:source-total')
        ) {
          injected = true;
          await whole.cancel(jobId);
        }
        return result;
      }) as any);
      const unsafeQuery = db.$queryRawUnsafe.bind(db);
      const boundary = jest
        .spyOn(db, '$queryRawUnsafe')
        .mockImplementation((async (...args: any[]) => {
          const result = await (unsafeQuery as any)(...args);
          // This is after the first write helper has released its file lock, but
          // before the second helper acquires admission and the SQLite write lock.
          if (
            mode === 'after-fence' &&
            reserved &&
            !injected &&
            args[0] === 'PRAGMA database_list'
          ) {
            const markers = await query<Array<{ id: string }>>`
            SELECT id FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%'`;
            if (markers.length) {
              injected = true;
              await whole.cancel(jobId);
            }
          }
          return result;
        }) as any);
      try {
        const started = await whole.start({
          creatorId,
          requestLimit: 2,
          intervalMs: 1000,
        });
        await (whole as any).lane;
        expect(injected).toBe(true);
        expect(api).not.toHaveBeenCalled();
        const job = await whole.view(started.id);
        expect(job.state).toBe('cancelled');
        expect(job.code).toBe('XHS_TASK_CANCELLED');
        expect(job.budget!.used).toBe(0);
        expect(
          (await new XhsSqliteBudgetStore(db).read('xhs:source-total'))!.used,
        ).toBe(0);
        expect(
          await query`SELECT id FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%'`,
        ).toEqual([]);
      } finally {
        await (whole as any).lane;
        boundary.mockRestore();
        read.mockRestore();
        reserve.mockRestore();
        runtime.onModuleDestroy();
        await db.$executeRaw`DELETE FROM xhs_request_budgets WHERE id='xhs:source-total'`;
      }
    },
    40000,
  );
  it.each(['before-start', 'after-start'])(
    'keeps a durable cross-runtime fence when the actual transaction rolls back: %s',
    async (mode) => {
      await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,interval_ms)
        VALUES('xhs:source-total',3,1000)`;
      const profile =
        'https://www.xiaohongshu.com/user/profile/synthetic-fence';
      const api = jest.fn(async (request) => ({
        status: 200,
        url: request.url,
        body: { success: true, code: 0, data: {} },
      }));
      const makeRuntime = () =>
        new XhsSubscriptionRuntime({
          enabled: () => true,
          api,
          profileParser: () => ({
            id: 'synthetic-fence',
            name: 'Synthetic',
            profileUrl: profile,
          }),
        });
      const runtime = makeRuntime();
      await runtime.connectSession({
        a1: 'synthetic-a1',
        webSession: 'synthetic-session',
      });
      bindXhsSourceTotalBudget(db as any, runtime);
      const original = db.$transaction.bind(db);
      let rolledBack = false;
      const transaction = jest.spyOn(db, '$transaction').mockImplementation(((
        callback: any,
        ...args: any[]
      ) =>
        (original as any)(
          async (tx: any) => {
            const result = await callback(tx);
            const markers =
              await tx.$queryRaw`SELECT id FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%'`;
            if (
              !rolledBack &&
              ((mode === 'after-start' && api.mock.calls.length === 1) ||
                (mode === 'before-start' && markers.length === 1))
            ) {
              rolledBack = true;
              throw new Error('synthetic transaction rollback before COMMIT');
            }
            return result;
          },
          ...args,
        )) as any);
      let reopened: PrismaClient | undefined,
        second: XhsSubscriptionRuntime | undefined;
      try {
        await expect(runtime.resolve(profile)).rejects.toThrow();
        expect(rolledBack).toBe(true);
        const expected = mode === 'after-start' ? 1 : 0;
        expect(api).toHaveBeenCalledTimes(expected);
        expect(
          (await new XhsSqliteBudgetStore(db).read('xhs:source-total'))!.used,
        ).toBe(expected);
        expect(
          (await new XhsSqliteBudgetStore(db).read('xhs:source-total'))!.nextAt,
        ).toBe(0);
        transaction.mockRestore();
        runtime.onModuleDestroy();
        reopened = new PrismaClient({
          datasources: {
            db: {
              url:
                'file:' +
                path.join(folder, 'synthetic.sqlite').replace(/\\/g, '/'),
            },
          },
        });
        second = makeRuntime();
        await second.connectSession({
          a1: 'synthetic-a1',
          webSession: 'synthetic-session',
        });
        bindXhsSourceTotalBudget(reopened as any, second);
        const markers = await reopened.$queryRaw<
          Array<{ id: string }>
        >`SELECT id FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%'`;
        expect(markers).toHaveLength(expected);
        if (mode === 'after-start') {
          await expect(second.resolve(profile)).rejects.toThrow(
            'XHS_REQUEST_RATE_PAUSED',
          );
          expect(api).toHaveBeenCalledTimes(1);
          expect(
            (await new XhsSqliteBudgetStore(reopened).read('xhs:source-total'))!
              .used,
          ).toBe(1);
          expect(
            await reopened.$queryRaw`SELECT id FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%'`,
          ).toEqual(markers);
        } else {
          await second.resolve(profile);
          expect(api).toHaveBeenCalledTimes(1);
          expect(
            (await new XhsSqliteBudgetStore(reopened).read('xhs:source-total'))!
              .used,
          ).toBe(1);
        }
      } finally {
        transaction.mockRestore();
        runtime.onModuleDestroy();
        second?.onModuleDestroy();
        await reopened?.$disconnect();
        await db.$executeRaw`DELETE FROM xhs_request_budgets WHERE id='xhs:source-total' OR id LIKE 'xhs:dispatch-pending:%'`;
      }
    },
    40000,
  );
  it('resumes legacy reply-stage jobs with metrics only, preserves old comments and budget, and refreshes incrementally', async () => {
    let budget: any;
    let pauseOnce = true;
    const replyCalls: string[] = [];
    const source: any = {
      metrics: async (_author: string, note?: string) => {
        await budget.admit('budget-unused');
        if (pauseOnce) { pauseOnce = false; throw new XhsSubscriptionError('XHS_SOURCE_VERIFICATION_BLOCKED'); }
        return xhsNoteMetrics({
          interact_info: {
            liked_count: '0',
            comment_count: note === 'new-note' ? undefined : '7',
          },
        });
      },
      comments: jest.fn(
        async (
          _author: string,
          _note: string,
          cursor: string,
          root?: string,
        ) => {
          await budget.admit('budget-unused');
          if (root) {
            replyCalls.push(cursor);
          }
          return mapXhsComments(
            {
              comments: [
                {
                  id: root ? (cursor ? 'child2' : 'child1') : 'root',
                  content: 'Synthetic',
                  like_count: '0',
                  user_info: { user_id: 'u', nickname: 'Synthetic' },
                },
              ],
              has_more: !!root && !cursor,
              cursor: root && !cursor ? 'next' : '',
            },
            root ?? null,
          );
        },
      ),
      capability: () => ({ canCollectComments: true }),
    };
    const engagement = new XhsEngagementService(db as any, source);
    const subscriptions: any = {
      refresh: async () => {
        await db.xhsNote.upsert({
          where: { id: noteId },
          update: {},
          create: {
            id: noteId,
            creatorId: 'creator',
            title: 'Synthetic',
            publishTime: 0,
            kind: 'image-text',
            status: 'complete',
            contentHtml: '<p>Synthetic</p>',
          },
        });
        return { taskId: 'list' };
      },
      task: async () => ({ state: 'completed' }),
      downloadNotes: async () => ({ taskId: 'download' }),
      confirmedLocalSaves: async () =>
        (await db.xhsNote.findMany({ where: { creatorId: 'creator' } })).map(
          (note) => ({
            noteId: note.id,
            savedAt: Date.now(),
            supplementStatus: 'new',
          }),
        ),
      cancelTask: async () => ({}),
    };
    subscriptions.confirmedLocalArchives = subscriptions.confirmedLocalSaves;
    let actualId = '';
    const runtime: any = {
      withRequestBudget: async (b: any, id: string, work: any) => {
        actualId = id;
        budget = { admit: () => b.admit(id) };
        return work();
      },
    };
    let service = new XhsWholeCreatorService(
      db as any,
      subscriptions,
      runtime,
      engagement,
    );
    const started = await service.start({
      creatorId: 'creator',
      requestLimit: 1,
      intervalMs: 1000,
    });
    async function settled() {
      for (let n = 0; n < 200; n++) {
        const v = await service.view(started.id);
        if (!['queued', 'running'].includes(v.state)) return v;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw Error('test timeout');
    }
    const paused = await settled();
    expect(paused.state).toBe('paused');
    expect(paused.code).toBe('XHS_SOURCE_VERIFICATION_BLOCKED');
    expect(paused.budget!.used).toBe(1);
    const oldComment = JSON.stringify({
      id: 'root',
      rootId: null,
      parentId: null,
      content: 'historical',
      collectedAt: 1,
    });
    await db.$executeRaw`INSERT INTO xhs_saved_comments(note_id,comment_id,root_id,parent_id,document) VALUES(${noteId},'root',NULL,NULL,${oldComment})`;
    const oldSnapshot = xhsNoteMetrics(
      { interact_info: { comment_count: '7' } },
      123,
    );
    await db.$executeRaw`INSERT INTO xhs_metric_snapshots(owner_kind,owner_id,document) VALUES('note',${noteId},${JSON.stringify(oldSnapshot)})`;
    const savedRows = await db.$queryRaw<
      Array<{ document: string }>
    >`SELECT document FROM xhs_whole_creator_jobs WHERE id=${started.id}`;
    const legacy = JSON.parse(savedRows[0].document);
    legacy.stage = 'replies';
    legacy.currentNote = noteId;
    legacy.code = 'XHS_SOURCE_VERIFICATION_BLOCKED';
    legacy.items[noteId].metrics = 123;
    legacy.items[noteId].top = 1;
    await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(legacy)} WHERE id=${started.id}`;
    service = new XhsWholeCreatorService(
      db as any,
      subscriptions,
      runtime,
      engagement,
    );
    await service.onModuleInit();
    await service.resume(started.id);
    const completed = await settled();
    expect(completed.state).toBe('completed');
    expect(completed.lastPauseCode).toBe('XHS_SOURCE_VERIFICATION_BLOCKED');
    expect(completed.items[0].replies).toBeUndefined();
    expect(completed.items[0].engagement).toBe('metrics-only');
    expect(completed.items[0].supplement).toBe('saved');
    expect(replyCalls).toEqual([]);
    expect(source.comments).not.toHaveBeenCalled();
    expect(completed.budget!.used).toBe(2);
    expect(actualId).toBe(started.id);
    const rows = await db.$queryRaw<
      Array<{ n: bigint }>
    >`SELECT count(*) n FROM xhs_saved_comments WHERE note_id=${noteId}`;
    expect(Number(rows[0].n)).toBe(1);
    const historical = await db.$queryRaw<
      Array<{ document: string }>
    >`SELECT document FROM xhs_saved_comments WHERE note_id=${noteId} AND comment_id='root'`;
    expect(historical[0].document).toBe(oldComment);
    const preserved = await db.$queryRaw<
      Array<{ document: string }>
    >`SELECT document FROM xhs_metric_snapshots WHERE owner_kind='note' AND owner_id=${noteId}`;
    expect(JSON.parse(preserved[0].document).values.comments).toBe(7);
    // A new finite generation refreshes existing metrics and discovers new notes.
    subscriptions.refresh = async () => {
      await db.xhsNote.upsert({
        where: { id: noteId },
        update: {},
        create: {
          id: noteId,
          creatorId: 'creator',
          title: 'Synthetic',
          publishTime: 0,
          kind: 'image-text',
          status: 'complete',
        },
      });
      await db.xhsNote.create({
        data: {
          id: JSON.stringify(['xiaohongshu', 'note', 'new-note']),
          creatorId: 'creator',
          title: 'New synthetic',
          publishTime: 0,
          kind: 'image-text',
          status: 'complete',
        },
      });
      return { taskId: 'list2' };
    };
    const next = await service.start({
      creatorId: 'creator',
      requestLimit: 20,
      intervalMs: 1000,
    });
    async function wait(id: string) {
      for (let n = 0; n < 300; n++) {
        const value = await service.view(id);
        if (!['queued', 'running'].includes(value.state)) return value;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw Error('incremental timeout');
    }
    const increment = await wait(next.id);
    expect(increment.state).toBe('completed');
    expect(increment.items).toHaveLength(2);
    const newId = JSON.stringify(['xiaohongshu', 'note', 'new-note']);
    const unknown = await db.$queryRaw<
      Array<{ document: string }>
    >`SELECT document FROM xhs_metric_snapshots WHERE owner_kind='note' AND owner_id=${newId}`;
    expect(JSON.parse(unknown[0].document).values.comments).toBeNull();
    expect(increment.budget!.used).toBe(3);
    expect(replyCalls).toHaveLength(0);
    expect(source.comments).not.toHaveBeenCalled();
    subscriptions.refresh = async () => ({ taskId: 'list3' });
    const bounded = await service.start({
      creatorId: 'creator',
      requestLimit: 2,
      intervalMs: 1000,
    });
    const observed = await wait(bounded.id);
    expect(observed.state).toBe('completed');
    expect(observed.budget!.used).toBe(3);
    expect(replyCalls).toHaveLength(0);
  }, 40000);
  it('explicitly consumes cancelled state once while ordinary late saves remain fenced', async () => {
    const id = 'synthetic-cancelled';
    const job = {
      id,
      creatorId: 'creator',
      state: 'cancelled',
      updatedAt: 1,
      listEnd: true,
      items: {},
    };
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,interval_ms) VALUES(${id},7,1000)`;
    await db.$executeRaw`INSERT INTO xhs_whole_creator_jobs(id,creator_id,state,document,updated_at)
      VALUES(${id},'creator','cancelled',${JSON.stringify(job)},1)`;
    const service = new XhsWholeCreatorService(
      db as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const schedule = jest
      .spyOn(service as any, 'schedule')
      .mockImplementation(() => {});
    await expect(
      (service as any).save({ ...job, state: 'running' }),
    ).rejects.toThrow('XHS_TASK_STATE_CHANGED');
    expect((await service.view(id)).state).toBe('cancelled');
    const attempts = await Promise.allSettled([
      service.resume(id),
      service.resume(id),
    ]);
    expect(
      attempts.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(schedule).toHaveBeenCalledTimes(1);
    expect((await service.view(id)).state).toBe('queued');
    expect((await service.view(id)).budget!.limit).toBe(7);
    expect((await service.view(id)).budget!.used).toBe(0);
    schedule.mockRestore();
    await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET state='cancelled' WHERE id=${id}`;
  });
  it('cancels a newly dispatched child when cancellation wins its parent checkpoint', async () => {
    const creatorId = 'spawn-cancel-creator';
    await db.xhsCreator.create({
      data: {
        id: creatorId,
        externalAuthorId: 'spawn-author',
        profileUrl: 'https://www.xiaohongshu.com/user/profile/spawn-author',
        displayName: 'Synthetic spawn',
      },
    });
    const cancelTask = jest.fn(async () => ({}));
    const subscriptions: any = {
      cancelTask,
      refresh: async () => {
        const rows = await db.$queryRaw<
          Array<{ id: string }>
        >`SELECT id FROM xhs_whole_creator_jobs WHERE creator_id=${creatorId} AND state='running'`;
        await whole.cancel(rows[0].id);
        return { taskId: 'synthetic-child' };
      },
    };
    const whole = new XhsWholeCreatorService(
      db as any,
      subscriptions,
      {
        withRequestBudget: async (_b: any, _id: string, work: any) => work(),
      } as any,
      {} as any,
    );
    const started = await whole.start({
      creatorId,
      requestLimit: 7,
      intervalMs: 1000,
    });
    await (whole as any).lane;
    expect((await whole.view(started.id)).state).toBe('cancelled');
    expect(cancelTask).toHaveBeenCalledTimes(1);
    expect(cancelTask).toHaveBeenCalledWith({ taskId: 'synthetic-child' });
    expect((await whole.view(started.id)).budget!.used).toBe(0);
  });
  const nativeVideoRoundtrip = async () => {
    const creatorId = 'video-creator',
      video = JSON.stringify(['xiaohongshu', 'note', 'late-video']);
    await db.xhsCreator.create({
      data: {
        id: creatorId,
        externalAuthorId: 'video-author',
        profileUrl: 'https://www.xiaohongshu.com/user/profile/video-author',
        displayName: 'Synthetic video',
      },
    });
    const source: any = {
      list: async () => ({
        authorId: 'video-author',
        notes: [
          {
            authorId: 'video-author',
            noteId: 'late-video',
            title: 'Synthetic late video',
            publishedAt: 0,
            kind: 'video',
          },
        ],
        nextCursor: null,
      }),
      metrics: async () =>
        xhsNoteMetrics({ interact_info: { liked_count: '0' } }),
      comments: async () => mapXhsComments({ comments: [], has_more: false }),
      capability: () => ({ canCollectComments: true }),
      detail: jest.fn(async () => {
        throw Error('unexpected detail');
      }),
    };
    const subscriptions = new XhsSubscriptionService(db as any, source);
    const directory = path.join(folder, 'native-video');
    await fs.mkdir(directory);
    const store = new LocalArticleStore(
      path.join(folder, 'native-preferences.json'),
      directory,
    );
    let savedResult: any;
    let saveFailure: unknown;
    let actualSaves = 0;
    subscriptions.bindLocalSaver(
      async () => directory,
      async (_creator, id, target) => {
        const prepare: ArticlePreparation = async (stage) => {
          await fs.mkdir(path.join(stage, 'image'));
          await fs.writeFile(
            path.join(stage, 'index.md'),
            '# Synthetic cached body\n\nBody preserved',
          );
          return {
            articleId: id,
            title: 'Synthetic late video',
            imageCount: 0,
            mediaComplete: true,
            exportSource: { feedId: creatorId, feedName: 'Synthetic video' },
          };
        };
        prepare.afterSave = xhsLocalSnapshotPublisher(
          id,
          'Synthetic late video',
          'Synthetic completed comments',
        );
        try {
          savedResult = await store.save(prepare, new Date(), target);
        } catch (error) {
          saveFailure = error;
          throw error;
        }
        actualSaves++;
        return savedResult;
      },
    );
    const runtime: any = {
      withRequestBudget: async (_budget: any, _id: string, work: any) => work(),
    };
    const whole = new XhsWholeCreatorService(
      db as any,
      subscriptions,
      runtime,
      new XhsEngagementService(db as any, source),
    );
    nativeLanes.push(
      () => (whole as any).lane,
      () => (subscriptions as any).lane,
    );
    const started = await whole.start({
      creatorId,
      requestLimit: 7,
      intervalMs: 1000,
    });
    await (whole as any).lane;
    const first = await whole.view(started.id);
    expect(first.state).toBe('partial');
    expect(first.items[0].supplement).toBe('pending');
    const priorTask = first.downloadTask!;
    expect(
      await subscriptions.confirmedLocalSaves({ taskId: priorTask }),
    ).toEqual([]);
    expect(actualSaves).toBe(0);
    await whole.cancel(started.id);
    expect((await whole.view(started.id)).state).toBe('cancelled');
    // Synthetic cache completion alone is not a publication receipt.
    await db.xhsNote.update({
      where: { id: video },
      data: { status: 'complete', contentHtml: '<p>Synthetic cached body</p>' },
    });
    expect((await whole.view(started.id)).items[0].supplement).toBe('pending');
    await whole.resume(started.id);
    await (whole as any).lane;
    const completed = await whole.view(started.id);
    expect(saveFailure).toBeUndefined();
    expect(completed.state).toBe('completed');
    expect(completed.downloadTask).not.toBe(priorTask);
    expect(actualSaves).toBe(2);
    expect(completed.items[0].supplement).toBe('saved');
    expect((await fs.stat(savedResult.markdownPath)).isFile()).toBe(true);
    expect((await fs.stat(savedResult.supplement.path)).isFile()).toBe(true);
    const receipts = await subscriptions.confirmedLocalSaves({
      taskId: completed.downloadTask!,
    });
    expect(receipts).toHaveLength(1);
    expect(receipts[0].noteId).toBe(video);
    expect(completed.items[0].supplement).toBe('saved');
    expect(source.detail).not.toHaveBeenCalled();
  };
  it('requeues a formerly skipped video after cache completion and requires actual native body/companion receipts', () => {
    const pending = nativeVideoRoundtrip();
    nativeTests.push(pending);
    return pending;
  }, 40000);
});

describe('expired access context reconstruction', () => {
  const author = {
    id: 'author',
    name: 'Synthetic',
    profileUrl: 'https://www.xiaohongshu.com/user/profile/author',
  };
  it('rebuilds through all list pages and never stores a note token as author credential', async () => {
    const client: any = {
      getUserInfo: jest.fn(async () => ({})),
      getUserNotes: jest.fn(async (_id: string, cursor: string) => ({
        notes: [
          {
            note_id: cursor ? 'target' : 'other',
            user: { user_id: 'author' },
            xsec_token: 'synthetic',
            type: 'normal',
          },
        ],
        has_more: !cursor,
        cursor: cursor ? '' : 'next',
      })),
    };
    const adapter = new RedbookSubscriptionAdapter(client, {
      profileParser: () => author,
    });
    await adapter.restoreContext('author', 'other');
    await adapter.restoreContext('author', 'target');
    expect(client.getUserNotes.mock.calls.map((c: any) => c[1])).toEqual([
      '',
      'next',
    ]);
    await adapter.restoreContext('author', 'target');
    expect(client.getUserNotes).toHaveBeenCalledTimes(2);
    adapter.clearAccessContext();
    await adapter.restoreContext('author', 'target');
    expect(client.getUserInfo).toHaveBeenCalledTimes(2);
  });
  it('stops on author mismatch before requesting a list', async () => {
    const client: any = {
      getUserInfo: async () => ({}),
      getUserNotes: jest.fn(),
    };
    const adapter = new RedbookSubscriptionAdapter(client, {
      profileParser: () => ({ ...author, id: 'other' }),
    });
    await expect(adapter.restoreContext('author', 'target')).rejects.toThrow(
      'XHS_AUTHOR_MISMATCH',
    );
    expect(client.getUserNotes).not.toHaveBeenCalled();
  });
});
