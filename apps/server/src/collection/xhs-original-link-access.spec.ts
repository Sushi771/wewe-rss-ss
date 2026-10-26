import express from 'express';
import type { Server } from 'node:http';
import { XhsRequestBudget } from './xhs-request-budget';
import { XhsSqliteBudgetStore } from './xhs-request-budget-store';
import { ConfigService } from '@nestjs/config';
import { TrpcRouter } from '../trpc/trpc.router';
import { TrpcService } from '../trpc/trpc.service';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { PrismaClient } from '@prisma/client';
import { splitSqliteStatements } from '../../../../scripts/sqlite-statements.cjs';
import { XhsSubscriptionRuntime } from './xhs-subscription-runtime';
import { XhsSubscriptionService } from './xhs-subscription.service';
import { RedbookSubscriptionAdapter } from './xhs-redbook-subscription';
import {
  sourceOriginalLink,
  sourceUserPcLink,
} from './xhs-source-original-link';
import {
  bindXhsSourceTotalBudget,
  configureXhsSourceBudget,
  readXhsSourceBudget,
  prepareXhsOriginalLink,
  resolveXhsSubscriptionWithBudget,
} from './xhs-source-request-policy';
import { XhsSubscriptionError } from './xhs-subscription-errors';
const external = 'Author00A',
  creatorId = 'creator-A',
  rawNote = '00AbC123';
const noteId = JSON.stringify(['xiaohongshu', 'note', rawNote]);
const supplied = `https://www.xiaohongshu.com/explore/${rawNote}?xsec_token=synthetic-note-only&xsec_source=pc_share`;
const profile = `https://www.xiaohongshu.com/user/profile/${external}`;
const scope = { purpose: 'original-link' as const, creatorId };
const cookies = {
  a1: 'synthetic-a1-only',
  webSession: 'synthetic-session-only',
};
let now = 1800000000000;
function fixture(options: { status?: number; shortLinks?: boolean } = {}) {
  const requests: string[] = [];
  const api = jest.fn(async (request: any) => {
    requests.push(new URL(request.url).pathname);
    // Simulated response latency advances after synchronous transport entry.
    queueMicrotask(() => {
      now += 2000;
    });
    const url = new URL(request.url);
    let data: any;
    if (url.pathname.endsWith('otherinfo'))
      data = { author: url.searchParams.get('target_user_id') };
    else if (url.pathname.endsWith('user_posted'))
      data = {
        notes: [
          {
            note_id: rawNote,
            user: { user_id: external },
            xsec_token: 'synthetic-list-only',
            display_title: 'Synthetic',
          },
        ],
        has_more: false,
        cursor: '',
      };
    else
      data = {
        items: [
          {
            id: rawNote,
            note_card: {
              note_id: rawNote,
              user: { user_id: external, nickname: 'Synthetic' },
            },
          },
        ],
      };
    return {
      url: request.url,
      status: options.status ?? 200,
      body: options.status ? {} : { success: true, code: 0, data },
    };
  });
  const redirects = jest.fn(async (url: URL) => {
    queueMicrotask(() => {
      now += 2000;
    });
    return {
      status: 302,
      url: url.href,
      location:
        url.hostname === 'xhslink.cn'
          ? 'https://xhslink.com/a/SyntheticNext'
          : supplied,
    };
  });
  const parser = (raw: any, expected: string) => {
    if (raw.author !== expected)
      throw new XhsSubscriptionError('XHS_AUTHOR_MISMATCH');
    return {
      id: expected,
      name: 'Synthetic',
      profileUrl: `https://www.xiaohongshu.com/user/profile/${expected}`,
    };
  };
  const runtime = new XhsSubscriptionRuntime({
    enabled: () => true,
    api,
    profileParser: parser,
    ...(options.shortLinks ? { shortLinks: redirects } : {}),
  });
  return { runtime, api, requests, redirects, parser };
}
describe('protected transient original links and durable source budgets (offline only)', () => {
  let folder: string, db: PrismaClient;
  beforeAll(async () => {
    folder = await fs.mkdtemp(path.join(tmpdir(), 'xhs-link-synthetic-'));
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
      for (const sql of splitSqliteStatements(
        await fs.readFile(path.join(migrations, name, 'migration.sql'), 'utf8'),
      ))
        await db.$executeRawUnsafe(sql);
    }
    await db.xhsCreator.create({
      data: {
        id: creatorId,
        externalAuthorId: external,
        displayName: 'Synthetic',
        profileUrl: profile,
      },
    });
    await db.xhsCreator.create({
      data: {
        id: 'creator-B',
        externalAuthorId: 'AuthorB',
        displayName: 'Synthetic B',
        profileUrl: 'https://www.xiaohongshu.com/user/profile/AuthorB',
      },
    });
    await db.xhsNote.create({
      data: {
        id: noteId,
        creatorId,
        title: 'Synthetic',
        status: 'listed',
        publishTime: 0,
      },
    });
    await db.xhsNote.create({
      data: {
        id: JSON.stringify(['xiaohongshu', 'note', 'Other00B']),
        creatorId: 'creator-B',
        title: 'Synthetic',
        status: 'listed',
        publishTime: 0,
      },
    });
  }, 40000);
  beforeEach(async () => {
    now = 1800000000000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    await db.$executeRaw`DELETE FROM xhs_request_budgets`;
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await db.$disconnect();
    await fs.rm(folder, { recursive: true, force: true });
  });
  it('explicit stable policies preserve used/cooldown and never modify legacy task grants', async () => {
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,interval_ms,next_at) VALUES('legacy-synthetic',31,7,1000,99)`;
    const p = await configureXhsSourceBudget(db as any, scope, 20, 1000);
    await db.$executeRaw`UPDATE xhs_request_budgets SET used=3,next_at=123 WHERE id IN (${p.budgetId},'xhs:source-total')`;
    const again = await configureXhsSourceBudget(db as any, scope, 20, 1000);
    expect(again.used).toBe(3);
    expect(again.nextAt).toBe(123);
    expect(again.limit).toBe(20);
    await expect(
      configureXhsSourceBudget(db as any, scope, 2, 1000),
    ).rejects.toThrow('XHS_REQUEST_POLICY_INVALID');
    const legacy = await db.$queryRaw<
      any[]
    >`SELECT used,request_limit,next_at FROM xhs_request_budgets WHERE id='legacy-synthetic'`;
    expect(Number(legacy[0].used)).toBe(7);
    expect(Number(legacy[0].request_limit)).toBe(31);
    expect(Number(legacy[0].next_at)).toBe(99);
  });
  it('blocks ordinary resolution before transport without a policy, then counts its profile exactly once', async () => {
    const f = fixture();
    await f.runtime.connectSession(cookies);
    const subscriptions = new XhsSubscriptionService(db as any, f.runtime);
    await expect(
      resolveXhsSubscriptionWithBudget(db as any, f.runtime, subscriptions, {
        url: profile,
      }),
    ).rejects.toThrow('XHS_REQUEST_BUDGET_REQUIRED');
    expect(f.api).not.toHaveBeenCalled();
    await configureXhsSourceBudget(
      db as any,
      { purpose: 'resolution' },
      20,
      1000,
    );
    const resolved = await resolveXhsSubscriptionWithBudget(
      db as any,
      f.runtime,
      subscriptions,
      { url: profile },
    );
    expect(resolved.author.id).toBe(external);
    expect(f.api).toHaveBeenCalledTimes(1);
    expect(
      (await readXhsSourceBudget(db as any, { purpose: 'resolution' }))!.used,
    ).toBe(1);
  });
  it('returns only supplied verified note URLs, preserving case/leading zero with free cached clicks', async () => {
    const f = fixture();
    await f.runtime.connectSession(cookies);
    const subscriptions = new XhsSubscriptionService(db as any, f.runtime);
    await configureXhsSourceBudget(
      db as any,
      { purpose: 'resolution' },
      20,
      1000,
    );
    const resolution = await resolveXhsSubscriptionWithBudget(
      db as any,
      f.runtime,
      subscriptions,
      { url: supplied },
    );
    expect(JSON.stringify(resolution)).not.toContain('synthetic-note-only');
    expect(
      await prepareXhsOriginalLink(db as any, f.runtime, { noteId }),
    ).toEqual({ state: 'ready', url: supplied });
    expect(
      await prepareXhsOriginalLink(db as any, f.runtime, { noteId }),
    ).toEqual({ state: 'ready', url: supplied });
    expect(f.api).toHaveBeenCalledTimes(1);
    expect((await readXhsSourceBudget(db as any, scope))!.used).toBe(1);
    expect(JSON.stringify(await db.xhsNote.findMany())).not.toContain(
      'synthetic-note-only',
    );
  });
  it('charges cold profile/list, applies official User-route parameters, and reuses the link', async () => {
    const f = fixture();
    await f.runtime.connectSession(cookies);
    await configureXhsSourceBudget(db as any, scope, 20, 1000);
    expect(
      await prepareXhsOriginalLink(db as any, f.runtime, { noteId }),
    ).toEqual({
      state: 'ready',
      url: `https://www.xiaohongshu.com/explore/${rawNote}?xsec_token=synthetic-list-only&xsec_source=pc_user`,
    });
    expect(f.api).toHaveBeenCalledTimes(2);
    expect((await readXhsSourceBudget(db as any, scope))!.used).toBe(2);
    expect(
      await prepareXhsOriginalLink(db as any, f.runtime, { noteId }),
    ).toEqual({
      state: 'ready',
      url: `https://www.xiaohongshu.com/explore/${rawNote}?xsec_token=synthetic-list-only&xsec_source=pc_user`,
    });
    expect(f.api).toHaveBeenCalledTimes(2);
  });
  it('rejects budget/author scope mismatch and malformed identities before any source request', async () => {
    const f = fixture();
    await f.runtime.connectSession(cookies);
    const p = await configureXhsSourceBudget(db as any, scope, 20, 1000);
    expect(
      await prepareXhsOriginalLink(db as any, f.runtime, {
        noteId: JSON.stringify(['xiaohongshu', 'note', 'Other00B']),
        budgetId: p.budgetId,
      }),
    ).toEqual({ state: 'not_ready', code: 'XHS_BUDGET_SCOPE_MISMATCH' });
    expect(
      await prepareXhsOriginalLink(db as any, f.runtime, {
        noteId: '["xiaohongshu", "note", "00AbC123"]',
      }),
    ).toEqual({ state: 'not_ready', code: 'XHS_NOTE_ID_INVALID' });
    expect(f.api).not.toHaveBeenCalled();
  });
  it('exhaustion pauses before list dispatch, keeps spent quota, and never retries', async () => {
    const f = fixture();
    await f.runtime.connectSession(cookies);
    await configureXhsSourceBudget(db as any, scope, 1, 1000);
    expect(
      await prepareXhsOriginalLink(db as any, f.runtime, { noteId }),
    ).toEqual({ state: 'not_ready', code: 'XHS_REQUEST_BUDGET_EXHAUSTED' });
    expect(f.api).toHaveBeenCalledTimes(1);
    expect((await readXhsSourceBudget(db as any, scope))!.used).toBe(1);
    expect(
      (await prepareXhsOriginalLink(db as any, f.runtime, { noteId })).state,
    ).toBe('not_ready');
    expect(f.api).toHaveBeenCalledTimes(1);
  });
  it('preserves a future cooldown without dispatch or changing used', async () => {
    const f = fixture();
    await f.runtime.connectSession(cookies);
    const p = await configureXhsSourceBudget(db as any, scope, 20, 1000);
    await db.$executeRaw`UPDATE xhs_request_budgets SET next_at=${BigInt(now + 60000)} WHERE id=${p.budgetId}`;
    expect(
      await prepareXhsOriginalLink(db as any, f.runtime, { noteId }),
    ).toEqual({ state: 'not_ready', code: 'XHS_REQUEST_RATE_PAUSED' });
    expect(f.api).not.toHaveBeenCalled();
    expect((await readXhsSourceBudget(db as any, scope))!.used).toBe(0);
  });
  it('unknown refusal stops the shared session; later clicks cannot clear risk or dispatch', async () => {
    const f = fixture({ status: 461 });
    await f.runtime.connectSession(cookies);
    await configureXhsSourceBudget(db as any, scope, 20, 1000);
    expect(
      await prepareXhsOriginalLink(db as any, f.runtime, {
        noteId,
        refreshContext: true,
      }),
    ).toEqual({
      state: 'not_ready',
      code: 'XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED',
    });
    expect(
      await prepareXhsOriginalLink(db as any, f.runtime, {
        noteId,
        refreshContext: true,
      }),
    ).toEqual({
      state: 'not_ready',
      code: 'XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED',
    });
    expect(f.api).toHaveBeenCalledTimes(1);
    expect(f.runtime.capability().canRefresh).toBe(false);
    expect((await readXhsSourceBudget(db as any, scope))!.used).toBe(1);
  });
  it('charges both allowed redirects and detail, without a second outer reservation', async () => {
    const f = fixture({ shortLinks: true });
    await f.runtime.connectSession(cookies);
    const subscriptions = new XhsSubscriptionService(db as any, f.runtime);
    await configureXhsSourceBudget(
      db as any,
      { purpose: 'resolution' },
      20,
      1000,
    );
    await resolveXhsSubscriptionWithBudget(
      db as any,
      f.runtime,
      subscriptions,
      { url: 'https://xhslink.cn/o/SyntheticStart' },
    );
    expect(f.redirects).toHaveBeenCalledTimes(2);
    expect(f.api).toHaveBeenCalledTimes(1);
    expect(
      (await readXhsSourceBudget(db as any, { purpose: 'resolution' }))!.used,
    ).toBe(3);
    expect(
      await prepareXhsOriginalLink(db as any, f.runtime, { noteId }),
    ).toEqual({ state: 'ready', url: supplied });
  });
  it('concurrent resolution consumes the one reservation once and never overspends', async () => {
    const f = fixture();
    await f.runtime.connectSession(cookies);
    const subscriptions = new XhsSubscriptionService(db as any, f.runtime);
    await configureXhsSourceBudget(
      db as any,
      { purpose: 'resolution' },
      1,
      1000,
    );
    const results = await Promise.allSettled([
      resolveXhsSubscriptionWithBudget(db as any, f.runtime, subscriptions, {
        url: profile,
      }),
      resolveXhsSubscriptionWithBudget(db as any, f.runtime, subscriptions, {
        url: profile,
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(f.api).toHaveBeenCalledTimes(1);
    expect(
      (await readXhsSourceBudget(db as any, { purpose: 'resolution' }))!.used,
    ).toBe(1);
  });
  it('expires a supplied URL and rebuilds only legal same-author context', async () => {
    let clock = 0;
    const calls: string[] = [];
    const client: any = {
      getNoteById: async () => ({
        items: [
          {
            id: rawNote,
            note_card: {
              note_id: rawNote,
              user: { user_id: external, nickname: 'Synthetic' },
            },
          },
        ],
      }),
      getUserInfo: async () => {
        calls.push('profile');
        return { author: external };
      },
      getUserNotes: async () => {
        calls.push('list');
        return {
          notes: [
            {
              note_id: rawNote,
              user: { user_id: external },
              xsec_token: 'synthetic-list-only',
            },
          ],
          has_more: false,
          cursor: '',
        };
      },
    };
    const f = fixture();
    const adapter = new RedbookSubscriptionAdapter(client, {
      now: () => clock,
      contextLifetimeMs: 10,
      profileParser: f.parser,
    });
    await adapter.resolve(supplied);
    expect(adapter.cachedOriginalLink(external, rawNote)).toEqual({
      state: 'ready',
      url: supplied,
    });
    clock = 11;
    expect(adapter.cachedOriginalLink(external, rawNote)).toBeUndefined();
    expect(await adapter.prepareOriginalLink(external, rawNote)).toEqual({
      state: 'ready',
      url: `https://www.xiaohongshu.com/explore/${rawNote}?xsec_token=synthetic-list-only&xsec_source=pc_user`,
    });
    expect(calls).toEqual(['profile', 'list']);
  });
  it('rejects injected or unassociated URLs rather than guessing missing parameters', () => {
    for (const raw of [
      'javascript:alert(1)',
      'https://evil.invalid/explore/' + rawNote,
      supplied + '#fragment',
      supplied + '&redirect=https://evil.invalid',
      supplied + '&xsec_source=other',
    ])
      expect(
        sourceOriginalLink(
          raw,
          new URL(raw.startsWith('https:') ? raw : supplied),
          rawNote,
        ),
      ).toBeUndefined();
    expect(
      sourceOriginalLink(supplied, new URL(supplied), 'Other00B'),
    ).toBeUndefined();
    expect(
      sourceOriginalLink(
        'https://www.xiaohongshu.com/explore/' + rawNote,
        new URL('https://www.xiaohongshu.com/explore/' + rawNote),
        rawNote,
      ),
    ).toBeUndefined();
  });
  it('shares the same total across resolution and original-link scopes rather than multiplying grants', async () => {
    const f = fixture();
    await f.runtime.connectSession(cookies);
    const subscriptions = new XhsSubscriptionService(db as any, f.runtime);
    await configureXhsSourceBudget(
      db as any,
      { purpose: 'resolution' },
      2,
      1000,
    );
    await configureXhsSourceBudget(db as any, scope, 2, 1000);
    await resolveXhsSubscriptionWithBudget(
      db as any,
      f.runtime,
      subscriptions,
      { url: profile },
    );
    expect(
      (await prepareXhsOriginalLink(db as any, f.runtime, { noteId })).state,
    ).toBe('ready');
    await expect(
      resolveXhsSubscriptionWithBudget(db as any, f.runtime, subscriptions, {
        url: profile,
      }),
    ).rejects.toThrow('XHS_REQUEST_BUDGET_EXHAUSTED');
    expect(f.api).toHaveBeenCalledTimes(2);
    expect((await readXhsSourceBudget(db as any, scope))!.used).toBe(2);
    expect(
      (await readXhsSourceBudget(db as any, { purpose: 'resolution' }))!
        .remaining,
    ).toBe(0);
  });
  it('preserves an outer operator cap through the public resolution wrapper', async () => {
    const f = fixture();
    await f.runtime.connectSession(cookies);
    const subscriptions = new XhsSubscriptionService(db as any, f.runtime);
    await configureXhsSourceBudget(
      db as any,
      { purpose: 'resolution' },
      20,
      1000,
    );
    let used = 0;
    const outer = new XhsRequestBudget({
      reserve: async () => {
        if (used >= 1) return false;
        used++;
        return true;
      },
      read: async (id) => ({ id, limit: 1, used, nextAt: 0, intervalMs: 0 }),
    });
    await f.runtime.withRequestBudget(
      outer,
      'synthetic-outer-cap',
      async () => {
        await resolveXhsSubscriptionWithBudget(
          db as any,
          f.runtime,
          subscriptions,
          { url: profile },
        );
        await expect(
          resolveXhsSubscriptionWithBudget(
            db as any,
            f.runtime,
            subscriptions,
            { url: profile },
          ),
        ).rejects.toThrow('XHS_REQUEST_BUDGET_EXHAUSTED');
      },
    );
    expect(used).toBe(1);
    expect(f.api).toHaveBeenCalledTimes(1);
  });
  it('does not reserve the same nested caller budget twice', async () => {
    const f = fixture();
    await f.runtime.connectSession(cookies);
    let used = 0;
    const budget = new XhsRequestBudget({
      reserve: async () => {
        used++;
        return true;
      },
      read: async (id) => ({ id, limit: 20, used, nextAt: 0, intervalMs: 0 }),
    });
    await f.runtime.withRequestBudget(budget, 'same-gate', () =>
      f.runtime.withRequestBudget(budget, 'same-gate', () =>
        f.runtime.resolve(profile),
      ),
    );
    expect(used).toBe(1);
    expect(f.api).toHaveBeenCalledTimes(1);
  });
  it('rejects forged creator configuration without creating a grant', async () => {
    await expect(
      configureXhsSourceBudget(
        db as any,
        { purpose: 'original-link', creatorId: 'missing-creator' },
        20,
        1000,
      ),
    ).rejects.toThrow('XHS_SUBSCRIPTION_REQUIRED');
    expect(
      await db.$queryRaw<any[]>`SELECT id FROM xhs_request_budgets`,
    ).toEqual([]);
  });
  it('protects new routes against remote/read-only callers and normalizes raw failures', async () => {
    const f = fixture();
    await f.runtime.connectSession(cookies);
    const config = new ConfigService({
      auth: { code: 'synthetic-auth' },
      platform: { url: '' },
      feed: { updateDelayTime: 0 },
    });
    const subscriptions = new XhsSubscriptionService(db as any, f.runtime);
    const router = new TrpcRouter(
      new TrpcService(db as any, config, {} as any, {} as any),
      db as any,
      config,
      {} as any,
      {} as any,
      undefined,
      subscriptions,
      f.runtime,
    ).appRouter;
    const remote = router.createCaller({ errorMsg: null, isLocalSave: false });
    await expect(
      remote.xiaohongshu.prepareOriginalLink({ noteId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      remote.xiaohongshu.configureSourceRequestBudget({
        scope,
        totalLimit: 20,
        intervalMs: 1000,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const readonly = router.createCaller({
      errorMsg: null,
      isLocalXhsRead: true,
    });
    await expect(
      readonly.xiaohongshu.prepareOriginalLink({ noteId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const local = router.createCaller({ errorMsg: null, isLocalSave: true });
    await expect(
      local.xiaohongshu.resolveSubscription({ url: profile }),
    ).rejects.toMatchObject({ message: 'XHS_REQUEST_BUDGET_REQUIRED' });
    expect(f.api).not.toHaveBeenCalled();
    await local.xiaohongshu.configureSourceRequestBudget({
      scope: { purpose: 'resolution' },
      totalLimit: 20,
      intervalMs: 1000,
    });
    await local.xiaohongshu.resolveSubscription({ url: profile });
    expect(f.api).toHaveBeenCalledTimes(1);
  });

  it('one source configuration covers normal link restoration without creating per-click or per-author allowances', async () => {
    const f = fixture();
    await f.runtime.connectSession(cookies);
    await configureXhsSourceBudget(
      db as any,
      { purpose: 'resolution' },
      20,
      1000,
    );
    expect(
      (await prepareXhsOriginalLink(db as any, f.runtime, { noteId })).state,
    ).toBe('ready');
    expect((await readXhsSourceBudget(db as any, scope))!.used).toBe(2);
    const ids = await db.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM xhs_request_budgets ORDER BY id`;
    expect(ids.map((x) => x.id)).toEqual([
      'xhs:resolution',
      'xhs:source-total',
    ]);
  });
  it('rejects a real list identity mismatch rather than pairing another author token', async () => {
    const f = fixture();
    await f.runtime.connectSession(cookies);
    await configureXhsSourceBudget(
      db as any,
      { purpose: 'resolution' },
      20,
      1000,
    );
    const other = JSON.stringify(['xiaohongshu', 'note', 'Other00B']);
    expect(
      await prepareXhsOriginalLink(db as any, f.runtime, { noteId: other }),
    ).toEqual({ state: 'not_ready', code: 'XHS_AUTHOR_MISMATCH' });
    expect(f.api).toHaveBeenCalledTimes(2);
    expect(f.runtime.cachedOriginalLink('AuthorB', 'Other00B')).toBeUndefined();
  });
  it('returns fixed public route errors without provider text, URLs or token values', async () => {
    const f = fixture();
    await f.runtime.connectSession(cookies);
    const config = new ConfigService({
      auth: { code: 'synthetic-auth' },
      platform: { url: '' },
      feed: { updateDelayTime: 0 },
    });
    const poisoned = {
      $queryRaw: jest.fn(async () => {
        throw Error('https://evil.invalid/?xsec_token=synthetic-private-error');
      }),
      xhsNote: {
        findUnique: async () => {
          throw Error('synthetic-private-error');
        },
      },
    } as any;
    const router = new TrpcRouter(
      new TrpcService(poisoned, config, {} as any, {} as any),
      poisoned,
      config,
      {} as any,
      {} as any,
      undefined,
      new XhsSubscriptionService(poisoned, f.runtime),
      f.runtime,
    ).appRouter;
    const local = router.createCaller({ errorMsg: null, isLocalSave: true });
    await expect(
      local.xiaohongshu.resolveSubscription({ url: profile }),
    ).rejects.toMatchObject({ message: 'XHS_REQUEST_POLICY_UNAVAILABLE' });
    expect(await local.xiaohongshu.prepareOriginalLink({ noteId })).toEqual({
      state: 'not_ready',
      code: 'XHS_ORIGINAL_LINK_NOT_READY',
    });
    expect(f.api).not.toHaveBeenCalled();
  });
  it('serves transient ready links with no-store/referrer headers through actual protected HTTP wiring', async () => {
    const f = fixture();
    await f.runtime.connectSession(cookies);
    const config = new ConfigService({
      auth: { code: 'synthetic-auth' },
      platform: { url: '' },
      feed: { updateDelayTime: 0 },
    });
    const subscriptions = new XhsSubscriptionService(db as any, f.runtime);
    await configureXhsSourceBudget(
      db as any,
      { purpose: 'resolution' },
      1,
      1000,
    );
    await resolveXhsSubscriptionWithBudget(
      db as any,
      f.runtime,
      subscriptions,
      { url: supplied },
    );
    const router = new TrpcRouter(
      new TrpcService(db as any, config, {} as any, {} as any),
      db as any,
      config,
      {} as any,
      {} as any,
      undefined,
      subscriptions,
      f.runtime,
    );
    const app = express();
    app.use(express.json());
    await router.applyMiddleware(app as any);
    const server: Server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    try {
      const address = server.address() as { port: number };
      const origin = 'http://127.0.0.1:' + address.port;
      const response = await fetch(
        origin + '/trpc/xiaohongshu.prepareOriginalLink',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'synthetic-auth',
            origin,
          },
          body: JSON.stringify({ noteId }),
        },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect((await response.json()).result.data).toEqual({
        state: 'ready',
        url: supplied,
      });
      const denied = await fetch(
        origin + '/trpc/xiaohongshu.prepareOriginalLink',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'synthetic-auth',
            origin: 'https://evil.invalid',
          },
          body: JSON.stringify({ noteId }),
        },
      );
      expect(denied.status).toBe(403);
      expect(f.api).toHaveBeenCalledTimes(1);
      expect(
        (await readXhsSourceBudget(db as any, { purpose: 'resolution' }))!.used,
      ).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('coalesces concurrent cold clicks instead of repeating profile/list dispatch or charging twice', async () => {
    const f = fixture();
    await f.runtime.connectSession(cookies);
    await configureXhsSourceBudget(
      db as any,
      { purpose: 'resolution' },
      20,
      1000,
    );
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => (release = r)),
      started = new Promise<void>((r) => (entered = r));
    f.api.mockImplementationOnce(async (request: any) => {
      entered();
      await gate;
      now += 2000;
      return {
        url: request.url,
        status: 200,
        body: { success: true, code: 0, data: { author: external } },
      };
    });
    const first = prepareXhsOriginalLink(db as any, f.runtime, { noteId });
    await started;
    const second = prepareXhsOriginalLink(db as any, f.runtime, { noteId });
    release();
    const results = await Promise.all([first, second]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0].state).toBe('ready');
    expect(f.api).toHaveBeenCalledTimes(2);
    expect((await readXhsSourceBudget(db as any, scope))!.used).toBe(2);
  });
  it('retains allowed supplied PC route parameters instead of replacing them with a guessed source', () => {
    const full =
      supplied +
      '&m_source=synthetic&note_flow_source=synthetic-flow&source=synthetic-source';
    expect(sourceOriginalLink(full, new URL(full), rawNote)).toBe(full);
    expect(
      sourceOriginalLink(supplied, new URL(full), rawNote),
    ).toBeUndefined();
  });

  it('the bound source total caps direct runtime profile calls outside a route wrapper too', async () => {
    const f = fixture();
    await f.runtime.connectSession(cookies);
    await configureXhsSourceBudget(
      db as any,
      { purpose: 'resolution' },
      1,
      1000,
    );
    bindXhsSourceTotalBudget(db as any, f.runtime);
    await f.runtime.resolve(profile);
    await expect(f.runtime.resolve(profile)).rejects.toThrow(
      'XHS_REQUEST_BUDGET_EXHAUSTED',
    );
    expect(f.api).toHaveBeenCalledTimes(1);
    expect(
      (await readXhsSourceBudget(db as any, { purpose: 'resolution' }))!.used,
    ).toBe(1);
  });
  it('reconnecting cannot reset a bound durable source total', async () => {
    const f = fixture();
    await f.runtime.connectSession(cookies);
    await configureXhsSourceBudget(
      db as any,
      { purpose: 'resolution' },
      1,
      1000,
    );
    bindXhsSourceTotalBudget(db as any, f.runtime);
    await f.runtime.resolve(profile);
    await f.runtime.connectSession(cookies);
    await expect(f.runtime.resolve(profile)).rejects.toThrow(
      'XHS_REQUEST_BUDGET_EXHAUSTED',
    );
    expect(f.api).toHaveBeenCalledTimes(1);
  });
  it('production binding rejects an otherwise unbudgeted direct dispatch before a source grant exists', async () => {
    const f = fixture();
    await f.runtime.connectSession(cookies);
    bindXhsSourceTotalBudget(db as any, f.runtime);
    await expect(f.runtime.resolve(profile)).rejects.toThrow(
      'XHS_REQUEST_BUDGET_REQUIRED',
    );
    expect(f.api).not.toHaveBeenCalled();
  });
  it('bounds generated PC URLs and never accepts an empty or control-bearing source token', () => {
    for (const token of ['', 'synthetic\nvalue', '中'.repeat(2000)])
      expect(() => sourceUserPcLink(rawNote, token)).toThrow(
        'XHS_ORIGINAL_LINK_CONTEXT_UNAVAILABLE',
      );
    const url = sourceUserPcLink(rawNote, 'synthetic&opaque=token');
    expect(new URL(url).searchParams.get('xsec_token')).toBe(
      'synthetic&opaque=token',
    );
    expect(new URL(url).searchParams.getAll('xsec_source')).toEqual([
      'pc_user',
    ]);
  });
  it('explicit context renewal obtains a fresh same-author list token under the existing cap', async () => {
    const f = fixture();
    await f.runtime.connectSession(cookies);
    const subscriptions = new XhsSubscriptionService(db as any, f.runtime);
    await configureXhsSourceBudget(
      db as any,
      { purpose: 'resolution' },
      20,
      1000,
    );
    await resolveXhsSubscriptionWithBudget(
      db as any,
      f.runtime,
      subscriptions,
      { url: supplied },
    );
    expect(
      await prepareXhsOriginalLink(db as any, f.runtime, { noteId }),
    ).toEqual({ state: 'ready', url: supplied });
    const adapter = (f.runtime as any).adapter;
    const checkpoint = {
      cursor: 'synthetic-other-progress',
      ended: true,
      expiresAt: now + 60000,
    };
    adapter.rebuildCursors.set(external, checkpoint);
    const fresh = await prepareXhsOriginalLink(db as any, f.runtime, {
      noteId,
      refreshContext: true,
    });
    expect(fresh).toEqual({
      state: 'ready',
      url: `https://www.xiaohongshu.com/explore/${rawNote}?xsec_token=synthetic-list-only&xsec_source=pc_user`,
    });
    expect(f.api).toHaveBeenCalledTimes(2);
    expect((await readXhsSourceBudget(db as any, scope))!.used).toBe(2);
    expect(adapter.rebuildCursors.get(external)).toEqual(checkpoint);
    expect(
      await prepareXhsOriginalLink(db as any, f.runtime, { noteId }),
    ).toEqual(fresh);
    expect(f.api).toHaveBeenCalledTimes(2);
  });
  it('explicit renewal cannot bypass an exhausted source budget', async () => {
    const f = fixture();
    await f.runtime.connectSession(cookies);
    const subscriptions = new XhsSubscriptionService(db as any, f.runtime);
    await configureXhsSourceBudget(
      db as any,
      { purpose: 'resolution' },
      1,
      1000,
    );
    await resolveXhsSubscriptionWithBudget(
      db as any,
      f.runtime,
      subscriptions,
      { url: supplied },
    );
    expect(
      await prepareXhsOriginalLink(db as any, f.runtime, {
        noteId,
        refreshContext: true,
      }),
    ).toEqual({ state: 'not_ready', code: 'XHS_REQUEST_BUDGET_EXHAUSTED' });
    expect(f.api).toHaveBeenCalledTimes(1);
  });
  it.each(['exhausted', 'cooldown', 'reserve-race'])(
    'an outer %s rejection cannot charge the shared source ledger',
    async (mode) => {
      const f = fixture();
      await f.runtime.connectSession(cookies);
      await configureXhsSourceBudget(db as any, scope, 20, 1000);
      const reserve = jest.fn(async () => false);
      const outer = new XhsRequestBudget({
        reserve,
        read: async (id) => ({
          id,
          limit: 1,
          used: mode === 'exhausted' ? 1 : 0,
          nextAt: mode === 'cooldown' ? now + 60000 : 0,
          intervalMs: 0,
        }),
      });
      const before = await readXhsSourceBudget(db as any, scope);
      const result = await f.runtime.withRequestBudget(
        outer,
        'synthetic-outer',
        () => prepareXhsOriginalLink(db as any, f.runtime, { noteId }),
      );
      expect(result.state).toBe('not_ready');
      expect(f.api).not.toHaveBeenCalled();
      expect(await readXhsSourceBudget(db as any, scope)).toEqual(before);
    },
  );
  it('shared exhaustion or cooldown cannot spend an available outer cap', async () => {
    for (const mode of ['exhausted', 'cooldown']) {
      const f = fixture();
      await f.runtime.connectSession(cookies);
      await configureXhsSourceBudget(db as any, scope, 20, 1000);
      await db.$executeRaw`UPDATE xhs_request_budgets SET used=${mode === 'exhausted' ? 20 : 0},next_at=${BigInt(mode === 'cooldown' ? now + 60000 : 0)}`;
      const reserve = jest.fn(async () => true),
        outer = new XhsRequestBudget({
          reserve,
          read: async (id) => ({
            id,
            limit: 20,
            used: 0,
            nextAt: 0,
            intervalMs: 0,
          }),
        });
      expect(
        (
          await f.runtime.withRequestBudget(outer, 'synthetic-outer', () =>
            prepareXhsOriginalLink(db as any, f.runtime, { noteId }),
          )
        ).state,
      ).toBe('not_ready');
      expect(reserve).not.toHaveBeenCalled();
      expect(f.api).not.toHaveBeenCalled();
      await db.$executeRaw`DELETE FROM xhs_request_budgets`;
    }
  });
  it.each([true, false])(
    'a refresh wins over the older in-flight response, newer finishes first=%s',
    async (newerFirst) => {
      const f = fixture();
      await f.runtime.connectSession(cookies);
      await configureXhsSourceBudget(db as any, scope, 20, 1000);
      const original = f.api.getMockImplementation()!;
      const finish: Array<() => void> = [];
      let first!: () => void, second!: () => void;
      const firstStarted = new Promise<void>((r) => (first = r)),
        secondStarted = new Promise<void>((r) => (second = r));
      f.api.mockImplementation(async (req: any) => {
        const result = await original(req);
        if (!req.url.includes('user_posted')) return result;
        const index = finish.length;
        result.body.data.notes[0].xsec_token =
          index === 0 ? 'synthetic-older' : 'synthetic-newer';
        return new Promise<any>((resolve) => {
          finish.push(() => resolve(result));
          if (index === 0) first();
          else second();
        });
      });
      const older = prepareXhsOriginalLink(db as any, f.runtime, { noteId });
      await firstStarted;
      const newer = prepareXhsOriginalLink(db as any, f.runtime, {
        noteId,
        refreshContext: true,
      });
      await secondStarted;
      if (newerFirst) {
        finish[1]();
        await newer;
        finish[0]();
      } else {
        finish[0]();
        await older;
        finish[1]();
      }
      await Promise.all([older, newer]);
      expect(
        (
          (await prepareXhsOriginalLink(db as any, f.runtime, {
            noteId,
          })) as any
        ).url,
      ).toContain('synthetic-newer');
      expect(f.api).toHaveBeenCalledTimes(3);
      expect((await readXhsSourceBudget(db as any, scope))!.used).toBe(3);
    },
  );
  it('preserves the single safe comment anchor while rejecting fragment injection and unknown anchors', () => {
    const base = supplied.replace('/explore/', '/discovery/item/');
    expect(
      sourceOriginalLink(
        base + '#comment-section',
        new URL(base + '#comment-section'),
        rawNote,
      ),
    ).toBe(base + '#comment-section');
    for (const hash of [
      '#javascript:alert(1)',
      '#xsec_token=synthetic',
      '#%63omment-section',
      '#comment-section/../../bad',
      '#comment-section?token=synthetic',
      '#other',
    ])
      expect(
        sourceOriginalLink(base + hash, new URL(base + hash), rawNote),
      ).toBeUndefined();
  });
  it('rolls back only its own undispatched SQLite reservation, never a later reservation', async () => {
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,interval_ms,next_at) VALUES('synthetic-cas',5,0,0,0)`;
    const store = new XhsSqliteBudgetStore(db as any),
      budget = new XhsRequestBudget(store);
    const first = await budget.reserve('synthetic-cas', now);
    expect((await store.read('synthetic-cas'))!.used).toBe(1);
    await first();
    expect((await store.read('synthetic-cas'))!.used).toBe(0);
    expect((await store.read('synthetic-cas'))!.nextAt).toBe(0);
    const second = await budget.reserve('synthetic-cas', now);
    await store.reserve('synthetic-cas', now + 1);
    await second();
    expect((await store.read('synthetic-cas'))!.used).toBe(2);
  });
});
