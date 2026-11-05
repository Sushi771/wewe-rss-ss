import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { XhsSubscriptionRuntime } from './xhs-subscription-runtime';
import { XhsSourceRiskStore } from './xhs-source-risk-store';
import { bindXhsSourceTotalBudget } from './xhs-source-request-policy';
import { XhsEngagementService } from './xhs-engagement.service';
import { applyFixtureMigrations } from '../../test/redbook-isolated/fixture-migrations';
jest.setTimeout(60000);

it('keeps an unknown source outcome closed across another account and runtime recreation', async () => {
  const root = await fs.mkdtemp(
      path.join(tmpdir(), 'xhs-global-unknown-fixture-'),
    ),
    file = path.join(root, 'fixture.sqlite');
  const db = new PrismaClient({
    datasources: { db: { url: 'file:' + file.replace(/\\/g, '/') } },
  });
  const deny = jest
    .spyOn(global, 'fetch')
    .mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
  await applyFixtureMigrations(db);
  const entries = ['a', 'b'].map((label) => ({
    creator: 'creator-' + label,
    author: 'author-' + label,
    note: 'note-' + label,
    key: JSON.stringify(['xiaohongshu', 'note', 'note-' + label]),
  }));
  const api = jest.fn(async () => {
    throw Error('synthetic unknown');
  });
  async function connect() {
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      commentsEnabled: () => true,
      api,
      requirePersistentRisk: true,
    });
    runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    bindXhsSourceTotalBudget(db as any, runtime);
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    for (const e of entries)
      (runtime as any).adapter.tokens.set(JSON.stringify([e.author, e.note]), {
        token: 'synthetic',
        source: 'pc_user',
        expiresAt: Date.now() + 60000,
      });
    const service: any = new XhsEngagementService(db as any, runtime);
    service.write = async (fn: any) => db.$transaction(fn);
    return { runtime, service };
  }
  try {
    for (const e of entries) {
      await db.xhsCreator.create({
        data: {
          id: e.creator,
          externalAuthorId: e.author,
          profileUrl: 'https://example.invalid/' + e.author,
          displayName: 'Synthetic',
        },
      });
      await db.xhsNote.create({
        data: {
          id: e.key,
          creatorId: e.creator,
          title: 'Synthetic',
          publishTime: 1,
          kind: 'image-text',
          status: 'complete',
        },
      });
    }
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,0)`;
    const a = await connect();
    const first = await a.service.collect({
      creatorId: entries[0].creator,
      noteId: entries[0].key,
      maxPages: 1,
      maxItems: 200,
    });
    expect(first.windows[0].state).toBe('failed');
    expect(api).toHaveBeenCalledTimes(1);
    a.runtime.onModuleDestroy();
    const b = await connect();
    try {
      await b.service.collect({
        creatorId: entries[1].creator,
        noteId: entries[1].key,
        maxPages: 1,
        maxItems: 200,
      });
    } catch {
      /* fail closed */
    }
    expect(api).toHaveBeenCalledTimes(1);
    expect(deny).not.toHaveBeenCalled();
    b.runtime.onModuleDestroy();
  } finally {
    deny.mockRestore();
    await db.$disconnect();
  }
});

it.each([
  'started',
  'malformed',
  'missing-state',
  'mismatched-state',
  'completed-started',
  'running-started',
  'queued-started',
  'malformed-active',
  'unknown-state',
  'valid-batch',
  'bad-batch',
] as const)(
  'checks cross-account dispatch for retained evidence %s without a marker',
  async (mode) => {
    const root = await fs.mkdtemp(
        path.join(tmpdir(), 'xhs-global-started-fixture-'),
      ),
      file = path.join(root, 'fixture.sqlite');
    const db = new PrismaClient({
      datasources: { db: { url: 'file:' + file.replace(/\\/g, '/') } },
    });
    const deny = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
    await applyFixtureMigrations(db);
    const creator = 'creator-b',
      author = 'author-b',
      note = 'note-b',
      key = JSON.stringify(['xiaohongshu', 'note', note]);
    const api = jest.fn(async () => {
      throw Error('MUST_NOT_DISPATCH');
    });
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      commentsEnabled: () => true,
      api,
      requirePersistentRisk: true,
    });
    try {
      await db.xhsCreator.create({
        data: {
          id: creator,
          externalAuthorId: author,
          profileUrl: 'https://example.invalid/b',
          displayName: 'Synthetic',
        },
      });
      await db.xhsNote.create({
        data: {
          id: key,
          creatorId: creator,
          title: 'Synthetic',
          publishTime: 1,
          kind: 'image-text',
          status: 'complete',
        },
      });
      const state =
        mode === 'completed-started'
          ? 'completed'
          : mode === 'running-started'
            ? 'running'
            : mode === 'queued-started'
              ? 'queued'
              : mode === 'unknown-state'
                ? 'unexpected'
                : mode === 'valid-batch' || mode === 'bad-batch'
                  ? 'batch_running'
                  : 'blocked';
      const old =
        mode === 'malformed'
          ? '{broken'
          : mode === 'valid-batch' || mode === 'bad-batch'
            ? JSON.stringify({
                batchId: mode === 'valid-batch' ? 'abc' : 'wrong',
                state: 'running',
              })
            : JSON.stringify({
                taskId: 'old-a',
                creatorId: 'creator-a',
                ...(mode === 'missing-state'
                  ? {}
                  : {
                      state: mode === 'mismatched-state' ? 'completed' : state,
                    }),
                ...(mode === 'malformed-active'
                  ? { sourceActive: {} }
                  : [
                        'started',
                        'completed-started',
                        'running-started',
                        'queued-started',
                      ].includes(mode)
                    ? { sourceActive: { outcome: 'started' } }
                    : {}),
              });
      const oldId =
          mode === 'valid-batch' || mode === 'bad-batch'
            ? 'batch:abc'
            : 'old-a',
        oldCreator = oldId.startsWith('batch:') ? '__batch__' : 'creator-a';
      await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES(${oldId},${oldCreator},${state},${old},1)`;
      await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,0)`;
      runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
      bindXhsSourceTotalBudget(db as any, runtime);
      await runtime.connectSession({
        a1: 'synthetic-a1',
        webSession: 'synthetic-session',
      });
      (runtime as any).adapter.tokens.set(JSON.stringify([author, note]), {
        token: 'synthetic',
        source: 'pc_user',
        expiresAt: Date.now() + 60000,
      });
      const service: any = new XhsEngagementService(db as any, runtime);
      service.write = async (fn: any) => db.$transaction(fn);
      try {
        await service.collect({
          creatorId: creator,
          noteId: key,
          maxPages: 1,
          maxItems: 200,
        });
      } catch {
        /* fail closed */
      }
      expect(api).toHaveBeenCalledTimes(mode === 'valid-batch' ? 1 : 0);
      expect(deny).not.toHaveBeenCalled();
    } finally {
      runtime.onModuleDestroy();
      deny.mockRestore();
      await db.$disconnect();
    }
  },
);
