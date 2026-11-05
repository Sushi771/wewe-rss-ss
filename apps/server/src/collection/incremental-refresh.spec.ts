import { splitSqliteStatements } from '../../../../scripts/sqlite-statements.cjs';
import {
  incrementalWrite,
  assertIncrementalTransaction,
} from './incremental-write';
import {
  reserveRefreshSubmission,
  beginRefreshSubmission,
  finishRefreshSubmission,
  readRefreshSubmission,
} from './refresh-submission-claim';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { CollectionService } from './collection.service';
import { TrpcService } from '../trpc/trpc.service';
import * as registry from './provider-registry';
import { ProviderPage } from './subscription-provider';
import { canonicalArticleUrl } from './collection-format';
import { createVerifiedSqliteBackup } from './sqlite-backup';
import { Wechat2RssSubscriptionBatches } from './wechat2rss-subscription-batches';
jest.mock('./sqlite-backup', () => ({
  createVerifiedSqliteBackup: jest
    .fn()
    .mockRejectedValue(Error('SYNTHETIC_BACKUP_QUOTA_FULL')),
}));

describe('ordinary incremental transactions and durable remote claims without snapshots', () => {
  let root: string,
    database: string,
    prisma: PrismaClient,
    trpc: TrpcService,
    page: ProviderPage;
  const original = { ...process.env };
  const ids = ['MP_WXS_1234567890', 'MP_WXS_2234567890'];
  const services: TrpcService[] = [];
  const image =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  const oldBody = `<div><p>nonempty local edit</p><img src="${image}"></div>`;
  const url = (mid: number, biz = 'MTIzNDU2Nzg5MA==') =>
    `https://mp.weixin.qq.com/s?__biz=${biz}&mid=${mid}&idx=1`;
  const item = (mid: number, body = 'new canonical body') => ({
    ...canonicalArticleUrl(url(mid)),
    title: 'fixture ' + mid,
    publishTime: 1760000000 + mid,
    contentHtml: `<div class="rich_media_content"><p>${body}</p></div>`,
    picUrl: '',
  });
  const connect = () =>
    new PrismaClient({ datasources: { db: { url: 'file:' + database } } });
  const service = () => {
    const s = new TrpcService(
      prisma as any,
      { get: () => ({ url: '', updateDelayTime: 0 }) } as any,
      {} as any,
      new CollectionService(prisma as any),
    );
    services.push(s);
    return s;
  };
  const batches = (s = trpc) =>
    (s as any).subscriptionBatches as Wechat2RssSubscriptionBatches;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'incremental-synthetic-'));
    database = path.join(root, 'source.db');
    Object.assign(process.env, {
      DATABASE_URL: 'file:' + database,
      WECHAT2RSS_ENABLED: '1',
      WECHAT2RSS_BASE_URL: 'http://127.0.0.1:18080/',
      WECHAT2RSS_TOKEN: 'synthetic-local-only',
      SQLITE_PERIODIC_SNAPSHOT_ENABLED: '0',
      SQLITE_BACKUP_KIND: 'test',
      SQLITE_TEST_MAX_BYTES: '1',
      SQLITE_TEST_MAX_COPIES: '1',
      SQLITE_TEST_BACKUP_ROOT: path.join(root, 'backups'),
    });
    await fs.mkdir(path.join(root, 'backups'));
    for (let n = 0; n < 3; n++)
      await fs.writeFile(
        path.join(root, 'backups', n + '.db'),
        'synthetic retained recovery point',
      );
    prisma = connect();
    const migrations = path.resolve(__dirname, '../../prisma/migrations');
    for (const name of (await fs.readdir(migrations)).sort()) {
      const sql = await fs
        .readFile(path.join(migrations, name, 'migration.sql'), 'utf8')
        .catch(() => '');
      for (const statement of splitSqliteStatements(sql)
        .map((s) => s.trim())
        .filter(Boolean))
        await prisma.$executeRawUnsafe(statement);
    }
    await prisma.managementGroup.create({
      data: {
        id: 'kept-group',
        name: 'local classification',
        platform: 'wechat',
        order: 17,
      },
    });
    for (const id of ids)
      await prisma.feed.create({
        data: {
          id,
          mpName: 'fixture',
          mpIntro: '',
          mpCover: '',
          collectionChannel: 'wechat2rss',
          updateTime: 1760000010,
          groupId: 'kept-group',
          order: 9,
        },
      });
    await prisma.article.create({
      data: {
        id: item(9).id,
        mpId: ids[0],
        sourceUrl: item(9).url,
        verifiedSourceUrl: item(9).url,
        contentHtml: oldBody,
        lastBodyStatus: 'available',
        metrics: '{"read":99}',
        readCount: 99,
        title: 'local edited title',
        publishTime: item(9).publishTime,
        picUrl: '',
      },
    });
    page = {
      articles: [item(9), item(10)],
      upstreamCount: 2,
      bodyMissing: 0,
      imageBlocked: 0,
      coverage: 'recent-window',
    };
    trpc = service();
    jest.clearAllMocks();
  });
  afterEach(async () => {
    services.splice(0).forEach((s) => s.onModuleDestroy());
    await prisma?.$disconnect();
    jest.restoreAllMocks();
    process.env = { ...original };
    expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  async function retained() {
    const old = await prisma.article.findUniqueOrThrow({
      where: { id: item(9).id },
    });
    expect(old).toMatchObject({
      contentHtml: oldBody,
      metrics: '{"read":99}',
      readCount: 99,
      title: 'local edited title',
    });
    expect(
      await prisma.feed.findUniqueOrThrow({ where: { id: ids[0] } }),
    ).toMatchObject({ groupId: 'kept-group', order: 9 });
    expect(await fs.readdir(path.join(root, 'backups'))).toHaveLength(3);
    expect(createVerifiedSqliteBackup).not.toHaveBeenCalled();
  }
  it('commits canonical rows, final feed state and one receipt atomically despite full snapshot quotas/disabled owner', async () => {
    await trpc.syncCachedWechat2RssPage(ids[0], page, false, {
      fetchMedia: false,
    });
    await trpc.syncCachedWechat2RssPage(ids[0], page, false, {
      fetchMedia: false,
    });
    expect(await prisma.article.count()).toBe(2);
    expect(
      await prisma.$queryRawUnsafe(
        'SELECT count(*) AS n FROM cache_refresh_commits',
      ),
    ).toEqual([{ n: 1n }]);
    const feed = await prisma.feed.findUniqueOrThrow({ where: { id: ids[0] } });
    expect(JSON.parse(feed.lastCollectionResult!)).toMatchObject({
      source: 'wechat2rss',
      status: 'partial',
      created: 1,
    });
    await retained();
  });
  it('rolls back article/feed/receipt together on a late SQL failure and safely retries once', async () => {
    const transaction = prisma.$transaction.bind(prisma);
    const injected = jest
      .spyOn(prisma, '$transaction')
      .mockImplementationOnce(((fn: any, options: any) =>
        transaction(async (tx) => {
          await fn(tx);
          throw Error('SYNTHETIC_BEFORE_COMMIT');
        }, options)) as any);
    await expect(
      trpc.syncCachedWechat2RssPage(ids[0], page, false, { fetchMedia: false }),
    ).rejects.toThrow('SYNTHETIC_BEFORE_COMMIT');
    expect(await prisma.article.count()).toBe(1);
    expect(
      await prisma.$queryRawUnsafe(
        'SELECT count(*) AS n FROM cache_refresh_commits',
      ),
    ).toEqual([{ n: 0n }]);
    expect(
      (await prisma.feed.findUniqueOrThrow({ where: { id: ids[0] } }))
        .lastCollectionResult,
    ).toBeNull();
    injected.mockRestore();
    await trpc.syncCachedWechat2RssPage(ids[0], page, false, {
      fetchMedia: false,
    });
    await retained();
  });
  it('repairs legacy running state on an all-no-op replay without restoring old data', async () => {
    await trpc.syncCachedWechat2RssPage(ids[0], page, false, {
      fetchMedia: false,
    });
    await prisma.feed.update({
      where: { id: ids[0] },
      data: {
        lastCollectionResult: JSON.stringify({
          source: 'pending',
          status: 'running',
        }),
      },
    });
    const result = await trpc.syncCachedWechat2RssPage(ids[0], page, false, {
      fetchMedia: false,
    });
    expect(result).toMatchObject({ created: 0, updated: 0 });
    expect(
      JSON.parse(
        (await prisma.feed.findUniqueOrThrow({ where: { id: ids[0] } }))
          .lastCollectionResult!,
      ).status,
    ).toBe('partial');
    await retained();
  });
  it('physical data-volume shortage refuses a transaction without consulting backup quota', async () => {
    const space = jest
      .spyOn(fs, 'statfs')
      .mockResolvedValue({ bavail: 0n, bsize: 4096n } as any);
    await expect(
      trpc.syncCachedWechat2RssPage(ids[0], page, false, { fetchMedia: false }),
    ).rejects.toThrow('INCREMENTAL_DISK_SPACE_INSUFFICIENT');
    space.mockRestore();
    expect(await prisma.article.count()).toBe(1);
    await retained();
  });
  it('real SQLITE_FULL rolls back old fields and cannot publish a successful receipt', async () => {
    const rows =
      await prisma.$queryRawUnsafe<Array<{ page_count: number }>>(
        'PRAGMA page_count',
      );
    await prisma.$queryRawUnsafe(
      'PRAGMA max_page_count=' + Number(rows[0].page_count),
    );
    const large = { ...page, articles: [item(11, 'x'.repeat(1024 ** 2))] };
    await expect(
      trpc.syncCachedWechat2RssPage(ids[0], large, false, {
        fetchMedia: false,
      }),
    ).rejects.toThrow();
    expect(await prisma.article.count()).toBe(1);
    expect(
      await prisma.$queryRawUnsafe(
        'SELECT count(*) AS n FROM cache_refresh_commits',
      ),
    ).toEqual([{ n: 0n }]);
    await retained();
  });
  async function killAt(stage: string) {
    await prisma.$disconnect();
    const pageFile = path.join(root, 'page.json'),
      counter = path.join(root, 'remote-counter.txt');
    await fs.writeFile(pageFile, JSON.stringify(page));
    const child = spawn(
      process.execPath,
      [
        path.resolve(__dirname, '../../scripts/incremental-crash-fixture.cjs'),
        stage,
        database,
        counter,
        pageFile,
      ],
      {
        cwd: path.resolve(__dirname, '../..'),
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    child.stdout!.resume();
    let diagnostics = '';
    child.stderr!.on('data', (chunk) => {
      if (diagnostics.length < 4096)
        diagnostics += String(chunk).slice(0, 4096 - diagnostics.length);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(Error('SYNTHETIC_CRASH_BARRIER_TIMEOUT')),
          15000,
        );
        child.on('message', (message: any) => {
          if (message.barrier === stage) {
            clearTimeout(timer);
            resolve();
          } else if (message.error) {
            clearTimeout(timer);
            reject(Error(message.error));
          }
        });
        child.on('exit', () => {
          clearTimeout(timer);
          reject(Error('SYNTHETIC_CHILD_EARLY_EXIT: ' + diagnostics));
        });
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exit = new Promise<void>((resolve) =>
          child.once('exit', () => resolve()),
        );
        child.kill();
        await exit;
      }
    }
    prisma = connect();
    return counter;
  }
  it.each(['cache-precommit', 'cache-postcommit'])(
    'recovers an abruptly killed actual business transaction at %s',
    async (stage) => {
      await killAt(stage);
      expect(await prisma.article.count()).toBe(
        stage === 'cache-precommit' ? 1 : 2,
      );
      trpc = service();
      await trpc.syncCachedWechat2RssPage(ids[0], page, false, {
        fetchMedia: false,
      });
      expect(await prisma.article.count()).toBe(2);
      expect(
        JSON.parse(
          (await prisma.feed.findUniqueOrThrow({ where: { id: ids[0] } }))
            .lastCollectionResult!,
        ).status,
      ).toBe('partial');
      await retained();
    },
    20000,
  );
  it.each([
    'remote-attempted',
    'remote-response',
    'remote-validated-response',
    'remote-accepted',
  ])(
    'never replays an abruptly killed remote claim at %s',
    async (stage) => {
      const counter = await killAt(stage);
      let calls = 0;
      jest.spyOn(registry, 'wechat2RssProvider').mockReturnValue({
        checkAccountStatus: async () => ({
          available: true,
          challenged: false,
        }),
        prepareRefreshSubscription: async () => async () => {
          calls++;
        },
        fetchArticles: async () => page,
      } as any);
      trpc = service();
      await batches().runDue();
      await batches().runDue();
      expect(calls).toBe(0);
      const originalCalls = (await fs.readFile(counter, 'utf8').catch(() => ''))
        .trim()
        .split('\n')
        .filter(Boolean).length;
      expect(originalCalls).toBe(stage === 'remote-attempted' ? 0 : 1);
      const record = (await batches().list())[0];
      if (['remote-accepted', 'remote-validated-response'].includes(stage))
        expect(record.items[0].accepted).toBe(true);
      else expect(record.items[0].submissionUnknown).toBe(true);
      await retained();
    },
    20000,
  );
  it('truncated or unreadable historical receipts never become an empty remote history', async () => {
    const directory = path.join(root, '.wechat2rss-subscription-batches');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, '11111111-1111-1111-1111-111111111111.json'),
      '{"submissionUnknown":',
    );
    await expect(batches().enqueueRefresh(ids)).rejects.toThrow(
      'BATCH_HISTORY_UNPROVED',
    );
    await retained();
  });
  it.each([
    'WECHAT2RSS_SUBSCRIPTION_MISSING',
    'WECHAT2RSS_SUBSCRIPTION_NAME_CHANGED',
  ])(
    'isolates single-source %s from account-wide restrictions',
    async (code) => {
      jest.spyOn(registry, 'wechat2RssProvider').mockReturnValue({
        fetchArticles: async () => {
          throw Error(code);
        },
      } as any);
      expect(
        await (trpc as any).runManualRefresh(ids[0], 'cache'),
      ).toMatchObject({ state: 'failed', stopBatch: false, accepted: true });
      await retained();
    },
  );
  it('durably restores an explicitly unsent reservation and retries the same claim safely', async () => {
    const feed = await prisma.feed.findUniqueOrThrow({ where: { id: ids[0] } });
    const first = await reserveRefreshSubmission(
      prisma,
      feed,
      'unsent',
      2000000000,
    );
    await beginRefreshSubmission(prisma, first.ticket!);
    await finishRefreshSubmission(prisma, first.ticket!, 'not-sent');
    expect(
      (await prisma.feed.findUniqueOrThrow({ where: { id: ids[0] } }))
        .providerRefreshAttemptTime,
    ).toBe(feed.providerRefreshAttemptTime);
    expect(
      await readRefreshSubmission(prisma, 'unsent', ids[0]),
    ).toBeUndefined();
    const again = await reserveRefreshSubmission(
      prisma,
      feed,
      'unsent',
      2000000001,
    );
    expect(again.ticket).toBeDefined();
    await beginRefreshSubmission(prisma, again.ticket!);
    await finishRefreshSubmission(prisma, again.ticket!, 'accepted');
    expect(await readRefreshSubmission(prisma, 'unsent', ids[0])).toMatchObject(
      { accepted: true },
    );
  });
  it('rechecks a changed source binding immediately before claiming the remote attempt', async () => {
    const feed = await prisma.feed.findUniqueOrThrow({ where: { id: ids[0] } });
    const first = await reserveRefreshSubmission(
      prisma,
      feed,
      'changed-route',
      2000000000,
    );
    await prisma.feed.update({
      where: { id: ids[0] },
      data: { mpName: 'local user edit' },
    });
    await expect(beginRefreshSubmission(prisma, first.ticket!)).rejects.toThrow(
      'REFRESH_PREPARATION_CHANGED',
    );
    expect(
      await readRefreshSubmission(prisma, 'changed-route', ids[0]),
    ).toBeUndefined();
    expect(
      (
        await prisma.$queryRawUnsafe<any[]>(
          'SELECT state FROM refresh_submission_claims',
        )
      )[0].state,
    ).toBe('prepared');
  });
  it('two actual clients serialize duplicate payload commits and preserve local edits', async () => {
    const other = connect();
    try {
      const collector = new CollectionService(other as any);
      await Promise.all([
        trpc.syncCachedWechat2RssPage(ids[0], page, false, {
          fetchMedia: false,
        }),
        collector.collectWechat2RssRecent({
          mpId: ids[0],
          mpName: 'fixture',
          trigger: 'scheduled',
          cachedPage: page,
          fetchMedia: false,
        }),
      ]);
      expect(await prisma.article.count()).toBe(2);
      await retained();
    } finally {
      await other.$disconnect();
    }
  });
  it.each(['open', 'sync', 'rename'])(
    'receipt %s failure before enqueue never authorizes a remote request',
    async (stage) => {
      let calls = 0;
      jest.spyOn(registry, 'wechat2RssProvider').mockReturnValue({
        checkAccountStatus: async () => ({
          available: true,
          challenged: false,
        }),
        prepareRefreshSubscription: async () => async () => {
          calls++;
        },
      } as any);
      const open = fs.open.bind(fs),
        rename = fs.rename.bind(fs);
      const isReceipt = (file: unknown) =>
        String(file).includes('.wechat2rss-subscription-batches') &&
        String(file).endsWith('.tmp');
      const openSpy = jest
        .spyOn(fs, 'open')
        .mockImplementation(async (...args: any[]) => {
          if (stage === 'open' && isReceipt(args[0]))
            throw Object.assign(Error('synthetic receipt ENOSPC'), {
              code: 'ENOSPC',
            });
          const handle = await (open as any)(...args);
          if (stage === 'sync' && isReceipt(args[0]))
            return new Proxy(handle, {
              get(target, key) {
                if (key === 'sync')
                  return async () => {
                    throw Object.assign(Error('synthetic receipt EIO'), {
                      code: 'EIO',
                    });
                  };
                const value = Reflect.get(target, key);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            });
          return handle;
        });
      const renameSpy = jest
        .spyOn(fs, 'rename')
        .mockImplementation(async (from, to) => {
          if (stage === 'rename' && isReceipt(from))
            throw Object.assign(Error('synthetic receipt ENOSPC'), {
              code: 'ENOSPC',
            });
          return rename(from, to);
        });
      try {
        await expect(batches().enqueueRefresh(ids)).rejects.toThrow(
          'synthetic receipt',
        );
      } finally {
        openSpy.mockRestore();
        renameSpy.mockRestore();
      }
      await batches().runDue();
      expect(calls).toBe(0);
      await retained();
    },
  );
  it('rejects unsafe durability on the actual connection without changing the pragma', async () => {
    await prisma.$executeRawUnsafe('PRAGMA synchronous=OFF');
    await expect(
      incrementalWrite(prisma, 0, () =>
        prisma.$transaction((tx) => assertIncrementalTransaction(tx)),
      ),
    ).rejects.toThrow('INCREMENTAL_DURABILITY_MODE_UNPROVED');
    expect(
      Number(
        (await prisma.$queryRawUnsafe<any[]>('PRAGMA synchronous'))[0]
          .synchronous,
      ),
    ).toBe(0);
    await retained();
  });
});
