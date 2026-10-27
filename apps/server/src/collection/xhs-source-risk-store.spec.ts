import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { splitSqliteStatements } from '../../../../scripts/sqlite-statements.cjs';
import { XhsSourceRiskStore } from './xhs-source-risk-store';
import { XhsSubscriptionRuntime } from './xhs-subscription-runtime';
import { XhsRequestBudget } from './xhs-request-budget';
import { XhsSubscriptionError } from './xhs-subscription-errors';

describe('durable synthetic source risk fence', () => {
  let db: PrismaClient, folder: string;
  beforeAll(async () => {
    folder = await fs.mkdtemp(path.join(os.tmpdir(), 'xhs-risk-synthetic-'));
    db = new PrismaClient({
      datasources: {
        db: {
          url: 'file:' + path.join(folder, 'risk.sqlite').replace(/\\/g, '/'),
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
  }, 40000);
  afterEach(async () => {
    await db.$executeRaw`UPDATE xhs_source_risk SET state='clear',code=NULL,owner=NULL,http_status=NULL,endpoint=NULL,updated_at=0 WHERE id='source'`;
  });
  afterAll(async () => {
    await db.$disconnect();
    await fs.rm(folder, { recursive: true, force: true });
  }, 40000);

  it('persists the actual fixed 461 classification and prevents restore, reconnect and restart dispatch', async () => {
    let enabled = true;
    const api = jest.fn(async (request: any) => ({
      status: 461,
      url: request.url,
      body: {},
    }));
    const storage = {
      status: jest.fn(async () => ({ stored: true })),
      load: jest.fn(async () => ({
        a1: 'synthetic-a1',
        web_session: 'synthetic-session',
      })),
      store: jest.fn(async () => {}),
      disconnect: jest.fn(async () => {}),
    };
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => enabled,
      api,
      vault: storage,
      requirePersistentRisk: true,
    });
    runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    await expect(
      runtime.resolve(
        'https://www.xiaohongshu.com/explore/synthetic-note?xsec_token=synthetic&xsec_source=app_share',
      ),
    ).rejects.toThrow('unknown_rejection');
    const rows = await db.$queryRaw<
      Array<{
        state: string;
        code: string;
        http_status: number;
        endpoint: string;
        owner: string | null;
      }>
    >`SELECT state,code,http_status,endpoint,owner FROM xhs_source_risk WHERE id='source'`;
    expect(rows[0]).toMatchObject({
      state: 'blocked',
      code: 'XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED',
      http_status: 461,
      endpoint: 'detail',
      owner: null,
    });
    expect(JSON.stringify(rows)).not.toContain('synthetic-session');
    enabled = false;
    expect(await runtime.connectionStatus()).toMatchObject({
      liveEnabled: false,
      sessionPresent: true,
      riskCode: 'XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED',
    });
    expect(storage.status).not.toHaveBeenCalled();
    enabled = true;
    await runtime.restoreSession();
    await runtime.disconnectSession();
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    await expect(
      runtime.resolve(
        'https://www.xiaohongshu.com/user/profile/synthetic-author',
      ),
    ).rejects.toThrow('XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED');
    runtime.onModuleDestroy();
    let restartedEnabled = false;
    const restarted = new XhsSubscriptionRuntime({
      enabled: () => restartedEnabled,
      api,
      requirePersistentRisk: true,
    });
    restarted.bindRiskStore(new XhsSourceRiskStore(db as any));
    expect(await restarted.connectionStatus()).toMatchObject({
      liveEnabled: false,
      sessionPresent: false,
      riskCode: 'XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED',
    });
    restartedEnabled = true;
    await restarted.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    await expect(
      restarted.resolve(
        'https://www.xiaohongshu.com/user/profile/synthetic-author',
      ),
    ).rejects.toThrow('XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED');
    expect(api).toHaveBeenCalledTimes(1);
    restarted.onModuleDestroy();
  }, 40000);

  it('keeps a durable pending fence across instances and failed completion', async () => {
    const first = new XhsSourceRiskStore(db as any),
      second = new XhsSourceRiskStore(db as any);
    const owner = await first.begin();
    await expect(second.begin()).rejects.toThrow(
      'XHS_SOURCE_RISK_REVIEW_REQUIRED',
    );
    await expect(
      first.finish('00000000-0000-0000-0000-000000000000'),
    ).rejects.toThrow('XHS_SOURCE_RISK_UNAVAILABLE');
    const transaction = jest
      .spyOn(db, '$transaction')
      .mockRejectedValueOnce(Error('synthetic commit failure') as never);
    try {
      await expect(first.finish(owner)).rejects.toThrow(
        'XHS_SOURCE_RISK_UNAVAILABLE',
      );
    } finally {
      transaction.mockRestore();
    }
    expect(await second.read()).toBe('XHS_SOURCE_RISK_REVIEW_REQUIRED');
    await expect(second.begin()).rejects.toThrow(
      'XHS_SOURCE_RISK_REVIEW_REQUIRED',
    );
  }, 40000);

  it('fails closed when persistent risk cannot be read or reserved', async () => {
    const store = new XhsSourceRiskStore({
      $queryRaw: jest.fn().mockRejectedValue(Error('synthetic')),
    } as any);
    await expect(store.read()).rejects.toThrow('XHS_SOURCE_RISK_UNAVAILABLE');
    await expect(store.begin()).rejects.toThrow('XHS_SOURCE_RISK_UNAVAILABLE');
  });

  it('clears only a successful pending operation and retains normal budget exhaustion without dispatch', async () => {
    const api = jest.fn(async (request: any) => ({
      status: 200,
      url: request.url,
      body: { success: true, code: 0, data: {} },
    }));
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      requirePersistentRisk: true,
      profileParser: () => ({
        id: 'author',
        name: 'Synthetic',
        profileUrl: 'https://www.xiaohongshu.com/user/profile/author',
      }),
    });
    const risk = new XhsSourceRiskStore(db as any);
    runtime.bindRiskStore(risk);
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    const profile = 'https://www.xiaohongshu.com/user/profile/author';
    await runtime.resolve(profile);
    expect(await risk.read()).toBeUndefined();
    const budget = new XhsRequestBudget({
      read: async (id) => ({ id, used: 1, limit: 1, nextAt: 0, intervalMs: 0 }),
      reserve: async () => false,
    });
    await expect(
      runtime.withRequestBudget(budget, 'synthetic', () =>
        runtime.resolve(profile),
      ),
    ).rejects.toThrow('XHS_REQUEST_BUDGET_EXHAUSTED');
    expect(await risk.read()).toBeUndefined();
    expect(api).toHaveBeenCalledTimes(1);
    await runtime.resolve(profile);
    expect(api).toHaveBeenCalledTimes(2);
    expect(await risk.read()).toBeUndefined();
    runtime.onModuleDestroy();
  }, 40000);

  it.each([false, true])(
    'distinguishes local cancellation before dispatch from cancellation after dispatch (dispatched=%s)',
    async (dispatched) => {
      let used = 0;
      const api = jest.fn(async () => {
        throw new XhsSubscriptionError('XHS_TASK_CANCELLED');
      });
      const runtime = new XhsSubscriptionRuntime({
        enabled: () => true,
        api,
        requirePersistentRisk: true,
      });
      const risk = new XhsSourceRiskStore(db as any);
      runtime.bindRiskStore(risk);
      await runtime.connectSession({
        a1: 'synthetic-a1',
        webSession: 'synthetic-session',
      });
      const budget = new XhsRequestBudget({
        read: async (id) => ({ id, used, limit: 2, nextAt: 0, intervalMs: 0 }),
        reserve: async () => {
          used++;
          return true;
        },
        rollback: async () => {
          used--;
          return true;
        },
        assertReady: async () => {
          if (!dispatched) throw new XhsSubscriptionError('XHS_TASK_CANCELLED');
        },
      });
      const operation = runtime.withRequestBudget(budget, 'synthetic', () =>
        runtime.resolve('https://www.xiaohongshu.com/user/profile/author'),
      );
      if (dispatched) await expect(operation).rejects.toThrow();
      else await expect(operation).rejects.toThrow('XHS_TASK_CANCELLED');
      expect(api).toHaveBeenCalledTimes(dispatched ? 1 : 0);
      expect(used).toBe(dispatched ? 1 : 0);
      expect(await risk.read()).toBe(
        dispatched ? 'XHS_SOURCE_RISK_REVIEW_REQUIRED' : undefined,
      );
      runtime.onModuleDestroy();
    },
    40000,
  );

  it('does not dispatch if a required risk reservation cannot be persisted', async () => {
    const api = jest.fn();
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      requirePersistentRisk: true,
    });
    runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    const transaction = jest
      .spyOn(db, '$transaction')
      .mockRejectedValueOnce(Error('synthetic write failure') as never);
    try {
      await expect(
        runtime.resolve('https://www.xiaohongshu.com/user/profile/author'),
      ).rejects.toThrow('XHS_SOURCE_RISK_UNAVAILABLE');
    } finally {
      transaction.mockRestore();
    }
    expect(api).not.toHaveBeenCalled();
    expect((await runtime.connectionStatus()).riskCode).toBe(
      'XHS_SOURCE_RISK_UNAVAILABLE',
    );
    runtime.onModuleDestroy();
  }, 40000);

  it('does not replay an uncertain risk completion after a successful source response', async () => {
    const api = jest.fn(async (request: any) => ({
      status: 200,
      url: request.url,
      body: { success: true, code: 0, data: {} },
    }));
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      requirePersistentRisk: true,
      profileParser: () => ({
        id: 'author',
        name: 'Synthetic',
        profileUrl: 'https://www.xiaohongshu.com/user/profile/author',
      }),
    });
    const risk = new XhsSourceRiskStore(db as any);
    runtime.bindRiskStore(risk);
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    const finish = jest
      .spyOn(risk, 'finish')
      .mockRejectedValueOnce(Error('synthetic unknown commit'));
    try {
      await expect(
        runtime.resolve('https://www.xiaohongshu.com/user/profile/author'),
      ).rejects.toThrow('XHS_SOURCE_RISK_UNAVAILABLE');
      expect(finish).toHaveBeenCalledTimes(1);
      expect(api).toHaveBeenCalledTimes(1);
      await expect(
        runtime.resolve('https://www.xiaohongshu.com/user/profile/author'),
      ).rejects.toThrow('XHS_SOURCE_RISK_UNAVAILABLE');
      expect(api).toHaveBeenCalledTimes(1);
    } finally {
      finish.mockRestore();
    }
    expect(await risk.read()).toBe('XHS_SOURCE_RISK_REVIEW_REQUIRED');
    runtime.onModuleDestroy();
  }, 40000);

  it('rejects a concurrent caller without poisoning the still-active owner', async () => {
    let release!: (value: any) => void;
    const api = jest.fn(
      (request: any) =>
        new Promise<{ status: number; url: string; body: unknown }>(
          (resolve) => {
            release = () =>
              resolve({
                status: 200,
                url: request.url,
                body: { success: true, code: 0, data: {} },
              });
          },
        ),
    );
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      requirePersistentRisk: true,
      profileParser: () => ({
        id: 'author',
        name: 'Synthetic',
        profileUrl: 'https://www.xiaohongshu.com/user/profile/author',
      }),
    });
    const risk = new XhsSourceRiskStore(db as any);
    runtime.bindRiskStore(risk);
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    const url = 'https://www.xiaohongshu.com/user/profile/author';
    const first = runtime.resolve(url);
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    await expect(runtime.resolve(url)).rejects.toThrow(
      'XHS_SOURCE_RISK_REVIEW_REQUIRED',
    );
    expect(api).toHaveBeenCalledTimes(1);
    release(undefined);
    await expect(first).resolves.toMatchObject({ author: { id: 'author' } });
    expect(await risk.read()).toBeUndefined();
    runtime.onModuleDestroy();
  }, 40000);

  it.each([
    ['XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED', 'blocked'],
    ['XHS_REQUEST_BUDGET_EXHAUSTED', 'clear'],
  ] as const)(
    'migrates partial only for an explicit source rejection (%s)',
    async (code, state) => {
      const legacy = new PrismaClient({
        datasources: {
          db: {
            url:
              'file:' +
              path.join(folder, `partial-${state}.sqlite`).replace(/\\/g, '/'),
          },
        },
      });
      try {
        await legacy.$executeRawUnsafe(
          'CREATE TABLE xhs_whole_creator_jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL, document TEXT NOT NULL)',
        );
        await legacy.$executeRawUnsafe(
          'CREATE TABLE xhs_subscription_tasks (id TEXT PRIMARY KEY, state TEXT NOT NULL, document TEXT NOT NULL)',
        );
        const old = JSON.stringify({ code });
        await legacy.$executeRaw`INSERT INTO xhs_subscription_tasks(id,state,document) VALUES('legacy','partial',${old})`;
        const migration = await fs.readFile(
          path.resolve(
            __dirname,
            '../../prisma/migrations/20261027100000_xhs_source_risk/migration.sql',
          ),
          'utf8',
        );
        for (const sql of splitSqliteStatements(migration))
          await legacy.$executeRawUnsafe(sql);
        const rows = await legacy.$queryRaw<
          Array<{ state: string; code: string | null }>
        >`SELECT state,code FROM xhs_source_risk WHERE id='source'`;
        expect(rows[0]).toEqual({
          state,
          code:
            state === 'blocked' ? 'XHS_SOURCE_HISTORY_REVIEW_REQUIRED' : null,
        });
        const saved = await legacy.$queryRaw<
          Array<{ document: string }>
        >`SELECT document FROM xhs_subscription_tasks WHERE id='legacy'`;
        expect(saved[0].document).toBe(old);
      } finally {
        await legacy.$disconnect();
      }
    },
    40000,
  );

  it.each([
    ['whole', 'XHS_SOURCE_VERIFICATION_BLOCKED', 'blocked'],
    ['subscription', 'XHS_SOURCE_VERIFICATION_BLOCKED', 'blocked'],
    ['whole', 'XHS_TASK_CANCELLED', 'clear'],
    ['subscription', 'XHS_TASK_CANCELLED', 'clear'],
  ] as const)(
    'migrates cancelled %s with %s only when it records a source rejection',
    async (kind, code, state) => {
      const legacy = new PrismaClient({
        datasources: {
          db: {
            url:
              'file:' +
              path
                .join(folder, `cancel-${kind}-${state}.sqlite`)
                .replace(/\\/g, '/'),
          },
        },
      });
      try {
        await legacy.$executeRawUnsafe(
          'CREATE TABLE xhs_whole_creator_jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL, document TEXT NOT NULL)',
        );
        await legacy.$executeRawUnsafe(
          'CREATE TABLE xhs_subscription_tasks (id TEXT PRIMARY KEY, state TEXT NOT NULL, document TEXT NOT NULL)',
        );
        const old = JSON.stringify({ code, stage: 'replies' });
        if (kind === 'whole')
          await legacy.$executeRaw`INSERT INTO xhs_whole_creator_jobs(id,state,document) VALUES('legacy','cancelled',${old})`;
        else
          await legacy.$executeRaw`INSERT INTO xhs_subscription_tasks(id,state,document) VALUES('legacy','cancelled',${old})`;
        const migration = await fs.readFile(
          path.resolve(
            __dirname,
            '../../prisma/migrations/20261027100000_xhs_source_risk/migration.sql',
          ),
          'utf8',
        );
        for (const sql of splitSqliteStatements(migration))
          await legacy.$executeRawUnsafe(sql);
        const rows = await legacy.$queryRaw<
          Array<{ state: string; code: string | null }>
        >`SELECT state,code FROM xhs_source_risk WHERE id='source'`;
        expect(rows[0]).toEqual({
          state,
          code:
            state === 'blocked' ? 'XHS_SOURCE_HISTORY_REVIEW_REQUIRED' : null,
        });
        const saved =
          kind === 'whole'
            ? await legacy.$queryRaw<
                Array<{ document: string }>
              >`SELECT document FROM xhs_whole_creator_jobs WHERE id='legacy'`
            : await legacy.$queryRaw<
                Array<{ document: string }>
              >`SELECT document FROM xhs_subscription_tasks WHERE id='legacy'`;
        expect(saved[0].document).toBe(old);
      } finally {
        await legacy.$disconnect();
      }
    },
    40000,
  );

  it.each(['whole', 'subscription'] as const)(
    'migrates a legacy %s source stop to unknown review without asserting verification or clearing history',
    async (kind) => {
      const legacy = new PrismaClient({
        datasources: {
          db: {
            url:
              'file:' +
              path.join(folder, `legacy-${kind}.sqlite`).replace(/\\/g, '/'),
          },
        },
      });
      try {
        await legacy.$executeRawUnsafe(
          'CREATE TABLE xhs_whole_creator_jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL, document TEXT NOT NULL)',
        );
        await legacy.$executeRawUnsafe(
          'CREATE TABLE xhs_subscription_tasks (id TEXT PRIMARY KEY, state TEXT NOT NULL, document TEXT NOT NULL)',
        );
        const old = JSON.stringify({
          code: 'XHS_SOURCE_VERIFICATION_BLOCKED',
          stage: 'replies',
        });
        if (kind === 'whole')
          await legacy.$executeRaw`INSERT INTO xhs_whole_creator_jobs(id,state,document) VALUES('legacy','paused',${old})`;
        else
          await legacy.$executeRaw`INSERT INTO xhs_subscription_tasks(id,state,document) VALUES('legacy','blocked',${old})`;
        const migration = await fs.readFile(
          path.resolve(
            __dirname,
            '../../prisma/migrations/20261027100000_xhs_source_risk/migration.sql',
          ),
          'utf8',
        );
        for (const sql of splitSqliteStatements(migration))
          await legacy.$executeRawUnsafe(sql);
        const rows = await legacy.$queryRaw<
          Array<{
            state: string;
            code: string;
            http_status: number | null;
            endpoint: string | null;
          }>
        >`SELECT state,code,http_status,endpoint FROM xhs_source_risk WHERE id='source'`;
        expect(rows[0]).toEqual({
          state: 'blocked',
          code: 'XHS_SOURCE_HISTORY_REVIEW_REQUIRED',
          http_status: null,
          endpoint: null,
        });
        const jobs =
          kind === 'whole'
            ? await legacy.$queryRaw<
                Array<{ document: string }>
              >`SELECT document FROM xhs_whole_creator_jobs WHERE id='legacy'`
            : await legacy.$queryRaw<
                Array<{ document: string }>
              >`SELECT document FROM xhs_subscription_tasks WHERE id='legacy'`;
        expect(jobs[0].document).toBe(old);
        const api = jest.fn();
        const runtime = new XhsSubscriptionRuntime({
          enabled: () => true,
          api,
          requirePersistentRisk: true,
        });
        runtime.bindRiskStore(new XhsSourceRiskStore(legacy as any));
        await runtime.connectSession({
          a1: 'synthetic-a1',
          webSession: 'synthetic-session',
        });
        await expect(
          runtime.resolve('https://www.xiaohongshu.com/user/profile/author'),
        ).rejects.toThrow('XHS_SOURCE_HISTORY_REVIEW_REQUIRED');
        expect(api).not.toHaveBeenCalled();
        runtime.onModuleDestroy();
      } finally {
        await legacy.$disconnect();
      }
    },
    40000,
  );
});
