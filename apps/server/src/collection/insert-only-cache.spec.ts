import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PrismaClient, Feed } from '@prisma/client';
import { canonicalArticleUrl } from './collection-format';
import { ProviderPage } from './subscription-provider';
import { tryInsertOnlyCachedPage } from './insert-only-cache';
import * as guard from './sqlite-snapshot-guard';
import { createVerifiedSqliteBackup } from './sqlite-backup';
import { cacheRevision } from '../feeds/cache-sync-state';
import { TrpcService } from '../trpc/trpc.service';
import { CollectionService } from './collection.service';

jest.mock('./sqlite-snapshot-guard', () => ({
  recentVerifiedSqliteSnapshot: jest.fn(),
  assertInsertOnlySnapshotPermit: jest.fn(),
  notifySqliteSnapshotDirty: jest.fn(),
}));
jest.mock('./sqlite-backup', () => ({
  createVerifiedSqliteBackup: jest
    .fn()
    .mockResolvedValue({ integrityCheck: 'ok' }),
}));
const probe = guard.recentVerifiedSqliteSnapshot as jest.Mock;
const assertLease = guard.assertInsertOnlySnapshotPermit as jest.Mock;
const dirty = guard.notifySqliteSnapshotDirty as jest.Mock;
const backup = createVerifiedSqliteBackup as jest.Mock;
const mpId = 'MP_WXS_1234567890';
const makePage = (count = 2, body: string | null = null): ProviderPage => ({
  articles: Array.from({ length: count }, (_, index) => ({
    ...canonicalArticleUrl(
      `https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA==&mid=${10 + index}&idx=1`,
    ),
    title: `fixture-${index}`,
    publishTime: 1760000000 + index,
    contentHtml: body,
    picUrl: '',
  })),
  coverage: 'recent-window',
  upstreamCount: count,
  bodyMissing: body ? 0 : count,
  imageBlocked: 0,
});

describe('opt-in pure INSERT transaction (real isolated SQLite, zero external IO)', () => {
  let directory: string,
    prisma: PrismaClient,
    expected: Feed,
    trpc: TrpcService;
  let failSecondInsert = false,
    insertCount = 0;
  const keys = [
    'DATABASE_URL',
    'SQLITE_INSERT_ONLY_FAST_PATH',
    'SQLITE_INSERT_ONLY_MAX_SNAPSHOT_AGE_MS',
    'WECHAT2RSS_ENABLED',
    'WECHAT2RSS_BASE_URL',
    'WECHAT2RSS_TOKEN',
  ];
  const oldEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const ledger = () => prisma.$queryRaw<
    Array<{ id: string; created_count: number }>
  >`
    SELECT id, created_count FROM cache_insert_batches
  `;
  const insert = (page = makePage(), listOnly = true) =>
    tryInsertOnlyCachedPage(prisma, expected, page, listOnly);
  const initSql = async (file: string) => {
    const sql = await fs.readFile(file, 'utf8');
    for (const statement of sql
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean))
      await prisma.$executeRawUnsafe(statement);
  };
  beforeAll(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-insert-only-'));
    process.env.DATABASE_URL = `file:${path.join(directory, 'fixture.db').replace(/\\/g, '/')}`;
    process.env.WECHAT2RSS_ENABLED = '1';
    process.env.WECHAT2RSS_BASE_URL = 'http://127.0.0.1:18080/';
    process.env.WECHAT2RSS_TOKEN = 'synthetic-unused-token';
    prisma = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
    });
    prisma.$use(async (params, next) => {
      if (params.model === 'Article' && params.action === 'create') {
        insertCount++;
        if (failSecondInsert && insertCount === 2)
          throw Error('SYNTHETIC_INSERT_FAILURE');
      }
      return next(params);
    });
    const migrations = path.resolve(__dirname, '../../prisma/migrations');
    for (const name of (await fs.readdir(migrations)).sort()) {
      const file = path.join(migrations, name, 'migration.sql');
      if (await fs.stat(file).catch(() => null)) await initSql(file);
    }
    trpc = new TrpcService(
      prisma as any,
      { get: () => ({ url: '', updateDelayTime: 0 }) } as any,
      {} as any,
      new CollectionService(prisma as any),
    );
  });
  beforeEach(async () => {
    process.env.SQLITE_INSERT_ONLY_FAST_PATH = '1';
    delete process.env.SQLITE_INSERT_ONLY_MAX_SNAPSHOT_AGE_MS;
    await prisma.article.deleteMany();
    await prisma.feed.deleteMany();
    await prisma.$executeRaw`DELETE FROM cache_insert_batches`;
    expected = await prisma.feed.create({
      data: {
        id: mpId,
        mpName: 'fixture',
        mpCover: 'protected-avatar',
        mpIntro: 'protected-intro',
        updateTime: 1,
        status: 1,
        collectionChannel: 'wechat2rss',
        localDirectory: 'synthetic-local-source',
        providerRefreshAttemptTime: 19,
      },
    });
    probe.mockReset().mockResolvedValue({
      source: path.join(directory, 'fixture.db'),
      sha256: 'e'.repeat(64),
      verifiedAtMs: Date.now(),
      lease: {
        token: 'a'.repeat(32),
        generation: 'b'.repeat(32),
        snapshotGeneration: 'c'.repeat(32),
        databasePath: path.join(directory, 'fixture.db'),
        databaseIdentity: ['0', '0'],
        schemaVersion: 1,
        schemaSha256: 'd'.repeat(64),
        validUntilMs: Date.now() + 60000,
        backupStartedAtMs: Date.now(),
        backupSucceededAtMs: Date.now(),
        coverageAtMs: Date.now(),
        elapsedSinceBackupSuccessMs: 0,
        conservativeRecoveryWindowMs: 0,
      },
    });
    dirty.mockReset().mockResolvedValue(undefined);
    assertLease.mockReset().mockImplementation(async (tx, permit) => {
      const lease = permit.lease;
      const files = await tx.$queryRawUnsafe('PRAGMA database_list');
      if (
        files.find((row) => row.name === 'main')?.file.replace(/\\/g, '/') !==
          lease.databasePath.replace(/\\/g, '/') ||
        Date.now() >= lease.validUntilMs
      )
        throw Error('SYNTHETIC_LEASE_INVALID');
    });
    backup.mockClear();
    insertCount = 0;
    failSecondInsert = false;
  });
  afterAll(async () => {
    trpc?.onModuleDestroy();
    await prisma?.$disconnect();
    for (const key of keys) {
      if (oldEnv[key] === undefined) delete process.env[key];
      else process.env[key] = oldEnv[key];
    }
    if (
      path.dirname(directory) === os.tmpdir() &&
      path.basename(directory).startsWith('wewe-insert-only-')
    )
      await fs.rm(directory, { recursive: true, force: true });
  });
  it('commits articles, immutable batch and final local state together; publishes revision only after commit', async () => {
    const version = cacheRevision().revision;
    const result = await trpc.syncCachedWechat2RssPage(mpId, makePage(), true);
    expect(result).toMatchObject({
      created: 2,
      updated: 0,
      bodyReady: false,
      bodyMissing: 2,
    });
    expect(await prisma.article.count()).toBe(2);
    expect(await ledger()).toEqual([
      { id: expect.stringMatching(/^[a-f0-9]{64}$/), created_count: 2 },
    ]);
    const feed = await prisma.feed.findUniqueOrThrow({ where: { id: mpId } });
    expect(feed).toMatchObject({
      mpCover: expected.mpCover,
      mpIntro: expected.mpIntro,
      localDirectory: expected.localDirectory,
      providerRefreshAttemptTime: 19,
      collectionChannel: 'wechat2rss',
      syncTime: 0,
    });
    expect(JSON.parse(feed.lastCollectionResult!)).toMatchObject(result);
    expect(cacheRevision().revision).not.toBe(version);
    expect(dirty).toHaveBeenCalledTimes(1);
    expect(backup).not.toHaveBeenCalled();
  });
  it('repeated delivery is a no-op even after a user edit; no row, batch or revision duplication', async () => {
    await trpc.syncCachedWechat2RssPage(mpId, makePage(), true);
    await prisma.article.update({
      where: { id: makePage().articles[0].id },
      data: {
        title: 'user title',
        contentHtml: '<p>user note</p>',
        picUrl: 'user cover',
        metrics: '{"read":19}',
        readCount: 19,
        likeCount: 8,
        lastBodyRetry: 'user retry',
        lastBodyStatus: 'user body state',
      },
    });
    const old = await prisma.article.findMany({ orderBy: { id: 'asc' } });
    const version = cacheRevision().revision;
    expect(
      await trpc.syncCachedWechat2RssPage(mpId, makePage(), true),
    ).toMatchObject({ created: 0, updated: 0 });
    expect(await prisma.article.findMany({ orderBy: { id: 'asc' } })).toEqual(
      old,
    );
    expect(await ledger()).toHaveLength(1);
    expect(cacheRevision().revision).toBe(version);
    expect(dirty).toHaveBeenCalledTimes(1);
  });
  it.each(['disabled', 'expired', 'missing', 'unreadable', 'guard-rejected'])(
    '%s guard returns to original full-backup path',
    async (kind) => {
      if (kind === 'disabled') delete process.env.SQLITE_INSERT_ONLY_FAST_PATH;
      if (kind === 'expired') probe.mockResolvedValue(null);
      if (kind === 'missing') probe.mockResolvedValue(null);
      if (kind === 'unreadable')
        probe.mockRejectedValue(Error('SYNTHETIC_GUARD_UNREADABLE'));
      if (kind === 'guard-rejected')
        assertLease.mockRejectedValue(Error('SYNTHETIC_LEASE_INVALID'));
      expect(
        await trpc.syncCachedWechat2RssPage(mpId, makePage(), true),
      ).toMatchObject({ created: 2 });
      expect(backup).toHaveBeenCalledTimes(1);
      expect(await ledger()).toHaveLength(0);
      expect(dirty).not.toHaveBeenCalled();
    },
  );
  it('rejects a valid-looking lease for a different actual SQLite connection', async () => {
    const health = await probe();
    health.lease.databasePath = path.join(directory, 'other.db');
    health.source = health.lease.databasePath;
    probe.mockResolvedValue(health);
    expect(await insert()).toBeNull();
    expect(await prisma.article.count()).toBe(0);
  });
  it('without additive ledger schema safely uses full backup; does not auto-migrate', async () => {
    await prisma.$executeRaw`DROP TABLE cache_insert_batches`;
    try {
      expect(
        await trpc.syncCachedWechat2RssPage(mpId, makePage(), true),
      ).toMatchObject({ created: 2 });
      expect(backup).toHaveBeenCalledTimes(1);
    } finally {
      await initSql(
        path.resolve(
          __dirname,
          '../../prisma/migrations/20261011090000_cache_insert_batches/migration.sql',
        ),
      );
    }
  });
  it('half failure rolls back every article, batch and feed field; no premature dirty/revision', async () => {
    failSecondInsert = true;
    const version = cacheRevision().revision;
    await expect(insert()).rejects.toThrow('SYNTHETIC_INSERT_FAILURE');
    expect(await prisma.article.count()).toBe(0);
    expect(await ledger()).toHaveLength(0);
    expect(
      await prisma.feed.findUniqueOrThrow({ where: { id: mpId } }),
    ).toEqual(expected);
    expect(cacheRevision().revision).toBe(version);
    expect(dirty).not.toHaveBeenCalled();
    failSecondInsert = false;
    expect(await insert()).toMatchObject({ created: 2 });
    expect(await ledger()).toHaveLength(1);
  });
  it('lease revoked after local state write rolls back and then invokes original backup', async () => {
    assertLease
      .mockReset()
      .mockResolvedValue(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Error('SYNTHETIC_LEASE_REVOKED'));
    backup.mockImplementationOnce(async () => {
      expect(await prisma.article.count()).toBe(0);
      expect(await ledger()).toHaveLength(0);
      expect(
        await prisma.feed.findUniqueOrThrow({ where: { id: mpId } }),
      ).toEqual(expected);
      return { integrityCheck: 'ok' };
    });
    expect(
      await trpc.syncCachedWechat2RssPage(mpId, makePage(), true),
    ).toMatchObject({ created: 2 });
    expect(backup).toHaveBeenCalledTimes(1);
    expect(await ledger()).toHaveLength(0);
    expect(dirty).not.toHaveBeenCalled();
  });
  it('rechecks source/name/status in transaction, preserving a concurrent user source edit', async () => {
    await prisma.feed.update({
      where: { id: mpId },
      data: { collectionChannel: 'owner-web-search', mpName: 'edited' },
    });
    const before = await prisma.feed.findUniqueOrThrow({ where: { id: mpId } });
    expect(await insert()).toBeNull();
    expect(
      await prisma.feed.findUniqueOrThrow({ where: { id: mpId } }),
    ).toEqual(before);
    expect(await prisma.article.count()).toBe(0);
  });
  it('protects all old fields and routes mixed existing/new media updates through backup', async () => {
    await trpc.syncCachedWechat2RssPage(mpId, makePage(1), true);
    await prisma.article.update({
      where: { id: makePage(1).articles[0].id },
      data: {
        metrics: '{"read":41}',
        readCount: 41,
        likeCount: 7,
        lastBodyRetry: 'note',
      },
    });
    const old = await prisma.article.findUniqueOrThrow({
      where: { id: makePage(1).articles[0].id },
    });
    expect(
      await trpc.syncCachedWechat2RssPage(
        mpId,
        makePage(2, '<div class="rich_media_content">body</div>'),
        false,
      ),
    ).toMatchObject({ created: 1, updated: 1 });
    expect(backup).toHaveBeenCalledTimes(1);
    const saved = await prisma.article.findUniqueOrThrow({
      where: { id: old.id },
    });
    expect(saved).toMatchObject({
      metrics: old.metrics,
      readCount: old.readCount,
      likeCount: old.likeCount,
      lastBodyRetry: old.lastBodyRetry,
      sourceUrl: old.sourceUrl,
      verifiedSourceUrl: old.verifiedSourceUrl,
      createdAt: old.createdAt,
    });
    expect(await ledger()).toHaveLength(1);
  });
  it('ambiguous short-link row is quarantined by original path without title guesses', async () => {
    await prisma.article.create({
      data: {
        id: 'legacy-opaque',
        mpId,
        title: makePage().articles[0].title,
        publishTime: makePage().articles[0].publishTime,
        picUrl: 'protected',
        sourceUrl: `https://mp.weixin.qq.com/s/${'a'.repeat(22)}`,
        contentHtml: '<p>old note</p>',
        metrics: '{"read":7}',
      },
    });
    const before = await prisma.article.findUniqueOrThrow({
      where: { id: 'legacy-opaque' },
    });
    expect(
      await trpc.syncCachedWechat2RssPage(mpId, makePage(), true),
    ).toMatchObject({ created: 1, identitySkipped: 1 });
    expect(backup).toHaveBeenCalledTimes(1);
    expect(
      await prisma.article.findUniqueOrThrow({ where: { id: before.id } }),
    ).toEqual(before);
    expect(await ledger()).toHaveLength(0);
  });
  it('protects alternate URL order and cross-feed stable identity conflicts', async () => {
    const first = makePage().articles[0];
    await prisma.feed.create({
      data: {
        id: 'MP_WXS_9999999999',
        mpName: 'foreign',
        mpIntro: '',
        mpCover: '',
        updateTime: 0,
      },
    });
    await prisma.article.create({
      data: {
        id: 'legacy-cross-feed',
        mpId: 'MP_WXS_9999999999',
        title: 'other title',
        publishTime: first.publishTime,
        picUrl: '',
        sourceUrl:
          'https://mp.weixin.qq.com/s?idx=1&mid=10&__biz=MTIzNDU2Nzg5MA==',
      },
    });
    const before = await prisma.article.findMany();
    await expect(
      trpc.syncCachedWechat2RssPage(mpId, makePage(), true),
    ).rejects.toThrow('CACHE_INSERT_IDENTITY_CONFLICT');
    expect(await prisma.article.findMany()).toEqual(before);
    expect(backup).not.toHaveBeenCalled();
    expect(await ledger()).toHaveLength(0);
  });
  it('two simultaneous database writers cannot duplicate or partially commit one batch', async () => {
    const other = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
    });
    try {
      const outcomes = await Promise.allSettled([
        insert(),
        tryInsertOnlyCachedPage(other, expected, makePage(), true),
      ]);
      expect(
        outcomes.filter(
          (entry) => entry.status === 'fulfilled' && entry.value?.created === 2,
        ),
      ).toHaveLength(1);
      expect(await prisma.article.count()).toBe(2);
      expect(await ledger()).toHaveLength(1);
      expect(dirty).toHaveBeenCalledTimes(1);
    } finally {
      await other.$disconnect();
    }
  });
  it('body/media readiness requires actual archived bytes and does not fetch remote images', async () => {
    const request = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(Error('NETWORK_FORBIDDEN'));
    try {
      expect(
        await insert(
          makePage(
            1,
            '<div class="rich_media_content"><img src="https://mmbiz.qpic.cn/fixture"></div>',
          ),
          false,
        ),
      ).toBeNull();
      expect(request).not.toHaveBeenCalled();
      expect(
        await insert(
          makePage(
            1,
            '<div class="rich_media_content">actual cached body</div>',
          ),
          false,
        ),
      ).toMatchObject({ bodyReady: true, bodyMissing: 0 });
    } finally {
      request.mockRestore();
    }
  });
  it('failed fallback backup makes no article, batch, status, dirty or revision change', async () => {
    probe.mockResolvedValue(null);
    backup.mockRejectedValueOnce(Error('SYNTHETIC_BACKUP_FAILED'));
    const version = cacheRevision().revision;
    await expect(
      trpc.syncCachedWechat2RssPage(mpId, makePage(), true),
    ).rejects.toThrow('SYNTHETIC_BACKUP_FAILED');
    expect(await prisma.article.count()).toBe(0);
    expect(await ledger()).toHaveLength(0);
    expect(
      await prisma.feed.findUniqueOrThrow({ where: { id: mpId } }),
    ).toEqual(expected);
    expect(cacheRevision().revision).toBe(version);
    expect(dirty).not.toHaveBeenCalled();
  });
  it('preserves every existing article column when inserting distinct peers', async () => {
    const identity = canonicalArticleUrl(
      'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA==&mid=999&idx=1',
    );
    const old = await prisma.article.create({
      data: {
        id: identity.id,
        mpId,
        sourceUrl: identity.url,
        verifiedSourceUrl: identity.url,
        title: 'edited old title',
        publishTime: 1750000000,
        picUrl: 'edited cover',
        contentHtml: '<p>edited body and note</p>',
        metrics: '{"read":0}',
        readCount: 0,
        likeCount: 7,
        lastBodyRetry: 'edited retry',
        lastBodyStatus: 'edited status',
      },
    });
    expect(await insert()).toMatchObject({ created: 2 });
    expect(
      await prisma.article.findUniqueOrThrow({ where: { id: old.id } }),
    ).toEqual(old);
  });
  it('unknown legacy ID without any source requires original full protection even with different title/time', async () => {
    const old = await prisma.article.create({
      data: {
        id: 'opaque-unknown',
        mpId,
        title: 'unrelated old label',
        publishTime: 1750000000,
        picUrl: '',
        contentHtml: '<p>old note</p>',
        metrics: '{"read":3}',
      },
    });
    expect(
      await trpc.syncCachedWechat2RssPage(mpId, makePage(), true),
    ).toMatchObject({ created: 2 });
    expect(backup).toHaveBeenCalledTimes(1);
    expect(await ledger()).toHaveLength(0);
    expect(
      await prisma.article.findUniqueOrThrow({ where: { id: old.id } }),
    ).toEqual(old);
  });
  it('checks id/biz/mid/idx and duplicate inputs before any transaction writes', async () => {
    const bad = makePage();
    bad.articles[0].url = bad.articles[1].url;
    await expect(insert(bad)).rejects.toThrow(
      'PROVIDER_ARTICLE_IDENTITY_INVALID',
    );
    const duplicate = makePage();
    duplicate.articles[1] = duplicate.articles[0];
    await expect(insert(duplicate)).rejects.toThrow(
      'PROVIDER_ARTICLE_IDENTITY_INVALID',
    );
    expect(await prisma.article.count()).toBe(0);
    expect(await ledger()).toHaveLength(0);
  });
  it('postcommit dirty failure never re-enters backup or reports a rolled-back batch', async () => {
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    dirty.mockRejectedValueOnce(Error('SYNTHETIC_DIRTY_FAILURE'));
    try {
      expect(
        await trpc.syncCachedWechat2RssPage(mpId, makePage(), true),
      ).toMatchObject({ created: 2 });
      expect(await prisma.article.count()).toBe(2);
      expect(await ledger()).toHaveLength(1);
      expect(backup).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledWith(
        'SQLITE_SNAPSHOT_DIRTY_NOTIFICATION_FAILED',
      );
    } finally {
      warning.mockRestore();
    }
  });
  it('dirty notification observes committed articles and batch plus published revision', async () => {
    const version = cacheRevision().revision;
    dirty.mockImplementationOnce(async () => {
      expect(await prisma.article.count()).toBe(2);
      expect(await ledger()).toHaveLength(1);
      expect(cacheRevision().revision).not.toBe(version);
    });
    expect(await insert()).toMatchObject({ created: 2 });
  });
});
