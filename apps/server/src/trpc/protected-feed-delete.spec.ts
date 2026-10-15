import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { TrpcService } from './trpc.service';
import { TrpcRouter } from './trpc.router';
import * as backup from '../collection/sqlite-backup';
import { sqliteWrites } from '../collection/sqlite-write-coordinator';

jest.setTimeout(30000);
const pause = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
describe('protected feed deletion through actual router and SQLite middleware', () => {
  let root: string,
    database: string,
    prisma: PrismaService,
    other: PrismaClient;
  let api: ReturnType<TrpcRouter['appRouter']['createCaller']>;
  const original = { ...process.env };
  const ids = ['MP_WXS_1234567890', 'MP_WXS_2234567890', 'MP_WXS_3234567890'];
  const realBackup = backup.createVerifiedSqliteBackup;
  const snapshot = async () => ({
    feeds: await prisma.feed.findMany({ orderBy: { id: 'asc' } }),
    articles: await prisma.article.findMany({ orderBy: { id: 'asc' } }),
    groups: await prisma.managementGroup.findMany(),
    claims: await prisma.$queryRawUnsafe(
      'SELECT * FROM refresh_submission_claims',
    ),
  });
  function caller(errorMsg: string | null = null) {
    const config = new ConfigService({
      auth: { code: 'fixture' },
      platform: { url: '' },
      feed: { updateDelayTime: 0 },
    });
    const service = new TrpcService(prisma, config, {} as any, {} as any);
    return new TrpcRouter(
      service,
      prisma,
      config,
      {} as any,
      {} as any,
    ).appRouter.createCaller({ errorMsg, isLocal: true });
  }
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-protected-delete-'));
    database = path.join(root, 'source.db');
    Object.assign(process.env, {
      DATABASE_URL: 'file:' + database,
      SQLITE_BACKUP_KIND: 'test',
      SQLITE_TEST_BACKUP_ROOT: path.join(root, 'backups'),
      SQLITE_TEST_MAX_BYTES: String(10 * 1024 ** 2),
      SQLITE_TEST_MAX_COPIES: '12',
      SQLITE_TEST_MIN_FREE_BYTES: '1048576',
      SQLITE_PERIODIC_SNAPSHOT_ENABLED: '0',
    });
    prisma = new PrismaService();
    other = new PrismaClient({
      datasources: { db: { url: 'file:' + database } },
    });
    const migrations = path.resolve(__dirname, '../../prisma/migrations');
    for (const name of (await fs.readdir(migrations)).sort()) {
      const sql = await fs
        .readFile(path.join(migrations, name, 'migration.sql'), 'utf8')
        .catch(() => '');
      for (const statement of sql
        .split(';')
        .map((x) => x.trim())
        .filter(Boolean))
        await prisma.$executeRawUnsafe(statement);
    }
    await prisma.managementGroup.create({
      data: {
        id: 'kept-group',
        name: 'retained classification',
        platform: 'wechat',
      },
    });
    for (const [i, id] of ids.entries()) {
      await prisma.feed.create({
        data: {
          id,
          mpName: 'local name ' + i,
          mpCover: '',
          mpIntro: 'local note',
          updateTime: 100 + i,
          groupId: 'kept-group',
          collectionChannel: 'wechat2rss',
        },
      });
      await prisma.article.create({
        data: {
          id: 'article-' + i,
          mpId: id,
          title: 'local article ' + i,
          picUrl: '',
          publishTime: 100 + i,
          contentHtml:
            '<p>local body</p><img src="data:image/png;base64,retained-synthetic-bytes">',
          metrics: '{"read":99}',
          readCount: 99,
        },
      });
    }
    await prisma.$executeRawUnsafe(
      "INSERT INTO refresh_submission_claims VALUES ('unknown-claim',?,'unknown',2,1,3)",
      ids[0],
    );
    jest
      .spyOn(backup, 'createVerifiedSqliteBackup')
      .mockImplementation(realBackup);
    api = caller();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await other.$disconnect();
    await prisma.$disconnect();
    expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(root)).toMatch(/^wewe-protected-delete-/);
    await fs.rm(root, { recursive: true, force: true });
    process.env = { ...original };
  });
  it.each(['delete', 'batchDelete'] as const)(
    '%s refuses all cascading deletion when required backup fails',
    async (operation) => {
      const before = await snapshot();
      jest
        .mocked(backup.createVerifiedSqliteBackup)
        .mockRejectedValueOnce(Error('SYNTHETIC_BACKUP_QUOTA_FULL'));
      const action =
        operation === 'delete'
          ? api.feed.delete(ids[0])
          : api.feed.batchDelete(ids.slice(0, 2));
      await expect(action).rejects.toThrow('SYNTHETIC_BACKUP_QUOTA_FULL');
      expect(backup.createVerifiedSqliteBackup).toHaveBeenCalledTimes(1);
      expect(await snapshot()).toEqual(before);
    },
  );
  it.each(['delete', 'batchDelete'] as const)(
    '%s commits only selected cascades after a real verified protected backup',
    async (operation) => {
      const input = [ids[0], ids[1], ids[0]];
      expect(
        await (operation === 'delete'
          ? api.feed.delete(ids[0])
          : api.feed.batchDelete(input)),
      ).toEqual(operation === 'delete' ? ids[0] : input);
      const report = await jest.mocked(backup.createVerifiedSqliteBackup).mock
        .results[0].value;
      expect(report.recoveryOrigin).toEqual({
        format: 'sqlite-recovery-origin-v1',
        kind: 'protected',
      });
      expect(
        createHash('sha256')
          .update(await fs.readFile(report.backup))
          .digest('hex'),
      ).toBe(report.sha256);
      // Node 24 built-in; keep compatibility with the project's older Node typings.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { DatabaseSync } = require('node:sqlite');
      const saved = new DatabaseSync(report.backup, { readOnly: true });
      try {
        expect(saved.prepare('SELECT count(*) AS n FROM feeds').get().n).toBe(
          3,
        );
        expect(
          saved.prepare('SELECT count(*) AS n FROM articles').get().n,
        ).toBe(3);
        expect(
          saved.prepare('PRAGMA integrity_check').get().integrity_check,
        ).toBe('ok');
      } finally {
        saved.close();
      }
      expect(await prisma.feed.count()).toBe(operation === 'delete' ? 2 : 1);
      expect(await prisma.article.count()).toBe(operation === 'delete' ? 2 : 1);
      expect(
        await prisma.feed.findUniqueOrThrow({ where: { id: ids[2] } }),
      ).toMatchObject({ mpIntro: 'local note', groupId: 'kept-group' });
      expect(
        await prisma.article.findUniqueOrThrow({ where: { id: 'article-2' } }),
      ).toMatchObject({ readCount: 99, metrics: '{"read":99}' });
      expect(await prisma.managementGroup.count()).toBe(1);
      expect(
        await prisma.$queryRawUnsafe(
          'SELECT state FROM refresh_submission_claims',
        ),
      ).toEqual([{ state: 'unknown' }]);
    },
  );
  it('backs up no-op empty/missing batches zero times and refuses a missing single target', async () => {
    expect(await api.feed.batchDelete([])).toEqual([]);
    expect(await api.feed.batchDelete(['missing'])).toEqual(['missing']);
    await expect(api.feed.delete('missing')).rejects.toThrow(
      'Subscription no longer exists',
    );
    expect(backup.createVerifiedSqliteBackup).not.toHaveBeenCalled();
    expect(await prisma.feed.count()).toBe(3);
  });
  it.each(['feed', 'article'] as const)(
    'rejects external %s edits during backup without deleting either target',
    async (kind) => {
      jest
        .mocked(backup.createVerifiedSqliteBackup)
        .mockImplementationOnce(async (options) => {
          const result = await realBackup(options);
          if (kind === 'feed')
            await other.feed.update({
              where: { id: ids[0] },
              data: { localDirectory: 'new local edit' },
            });
          else
            await other.article.update({
              where: { id: 'article-0' },
              data: { contentHtml: '<p>new body after snapshot</p>' },
            });
          return result;
        });
      await expect(api.feed.batchDelete(ids.slice(0, 2))).rejects.toThrow(
        'FEED_DELETE_DATABASE_CHANGED',
      );
      expect(await prisma.feed.count()).toBe(3);
      expect(await prisma.article.count()).toBe(3);
      if (kind === 'feed')
        expect(
          (await prisma.feed.findUniqueOrThrow({ where: { id: ids[0] } }))
            .localDirectory,
        ).toBe('new local edit');
      else
        expect(
          (
            await prisma.article.findUniqueOrThrow({
              where: { id: 'article-0' },
            })
          ).contentHtml,
        ).toBe('<p>new body after snapshot</p>');
    },
  );
  it('rejects a replaced actual source file after backup', async () => {
    jest
      .mocked(backup.createVerifiedSqliteBackup)
      .mockImplementationOnce(async (options) => {
        const result = await realBackup(options);
        await other.$disconnect();
        await prisma.$disconnect();
        const old = path.join(root, 'preserved-original.db');
        expect(path.dirname(database)).toBe(root);
        await fs.rename(database, old);
        await fs.copyFile(old, database);
        return result;
      });
    await expect(api.feed.batchDelete(ids.slice(0, 2))).rejects.toThrow(
      'FEED_DELETE_DATABASE_CHANGED',
    );
    expect(await prisma.feed.count()).toBe(3);
    expect(await prisma.article.count()).toBe(3);
  });
  it('rolls back preceding cascades when a later target triggers an actual SQL failure', async () => {
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER synthetic_delete_failure BEFORE DELETE ON feeds WHEN OLD.id='${ids[1]}' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_DELETE_ABORT'); END`,
    );
    const before = await snapshot();
    await expect(api.feed.batchDelete(ids.slice(0, 2))).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    expect(backup.createVerifiedSqliteBackup).toHaveBeenCalledTimes(1);
  });
  it('cannot lose an external WAL write at the delete transaction boundary', async () => {
    await prisma.$queryRawUnsafe('PRAGMA journal_mode=WAL');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require('node:sqlite');
    const outside = new DatabaseSync(database, { timeout: 100 });
    outside.prepare('SELECT count(*) FROM feeds').get();
    let entered = false,
      externalError: unknown;
    const transaction = prisma.$transaction.bind(prisma);
    jest.spyOn(prisma, '$transaction').mockImplementationOnce(((
      fn: any,
      options: any,
    ) =>
      transaction(async (tx) => {
        const guarded = new Proxy(tx, {
          get(target, key) {
            if (key === 'feed')
              return new Proxy(target.feed, {
                get(delegate, method) {
                  if (method === 'deleteMany')
                    return async (args: any) => {
                      entered = true;
                      try {
                        outside.exec(
                          "UPDATE articles SET content_html='<p>WAL edit after recheck</p>' WHERE id='article-0'",
                        );
                      } catch (error) {
                        externalError = error;
                      }
                      return delegate.deleteMany(args);
                    };
                  const value = Reflect.get(delegate, method);
                  return typeof value === 'function'
                    ? value.bind(delegate)
                    : value;
                },
              });
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        return fn(guarded);
      }, options)) as any);
    try {
      await api.feed.batchDelete(ids.slice(0, 2));
      expect(entered).toBe(true);
      expect(String(externalError)).toMatch(/locked|busy|timeout|timed out/i);
      expect(await prisma.feed.count()).toBe(1);
      expect(await prisma.article.count()).toBe(1);
      expect(outside.prepare('SELECT count(*) AS n FROM feeds').get().n).toBe(
        1,
      );
    } finally {
      outside.close();
    }
  });
  it('holds queued application writers out throughout backup and deletion without deadlocking middleware', async () => {
    const begun = pause(),
      release = pause();
    let wrote = false;
    jest
      .mocked(backup.createVerifiedSqliteBackup)
      .mockImplementationOnce(async (options) => {
        const result = await realBackup(options);
        begun.resolve();
        await release.promise;
        return result;
      });
    const deleting = api.feed.batchDelete(ids.slice(0, 2));
    await begun.promise;
    const writing = prisma.feed
      .update({ where: { id: ids[2] }, data: { mpIntro: 'queued safe edit' } })
      .then(() => {
        wrote = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(wrote).toBe(false);
    release.resolve();
    await deleting;
    await writing;
    expect(await prisma.feed.count()).toBe(1);
    expect(
      (await prisma.feed.findUniqueOrThrow({ where: { id: ids[2] } })).mpIntro,
    ).toBe('queued safe edit');
  });
  it('serializes overlapping deletes and refuses the stale second selection', async () => {
    const input = ids.slice(0, 2),
      held = pause(),
      release = pause(),
      read = pause();
    const gate = sqliteWrites.write(async () => {
      held.resolve();
      await release.promise;
    });
    await held.promise;
    const find = prisma.feed.findMany.bind(prisma.feed);
    let seen = 0;
    jest.spyOn(prisma.feed, 'findMany').mockImplementation(((...args: any[]) =>
      (find as any)(...args).then((rows: any) => {
        if (++seen === 2) read.resolve();
        return rows;
      })) as any);
    const both = Promise.allSettled([
      api.feed.batchDelete(input),
      api.feed.batchDelete(input),
    ]);
    await read.promise;
    release.resolve();
    await gate;
    const results = await both;
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((x) => x.status === 'rejected')).toHaveLength(1);
    expect(backup.createVerifiedSqliteBackup).toHaveBeenCalledTimes(1);
    expect(await prisma.feed.count()).toBe(1);
    expect(await prisma.article.count()).toBe(1);
  });
  it('rejects a target changed while waiting for admission before making any backup', async () => {
    const held = pause(),
      release = pause(),
      selected = pause();
    const gate = sqliteWrites.write(async () => {
      held.resolve();
      await release.promise;
    });
    await held.promise;
    const find = prisma.feed.findMany.bind(prisma.feed);
    jest.spyOn(prisma.feed, 'findMany').mockImplementationOnce(((
      ...args: any[]
    ) =>
      (find as any)(...args).then((rows: any) => {
        selected.resolve();
        return rows;
      })) as any);
    const deleting = api.feed.batchDelete(ids.slice(0, 2));
    const rejected = expect(deleting).rejects.toThrow(
      'FEED_DELETE_TARGETS_CHANGED',
    );
    await selected.promise;
    await other.feed.update({
      where: { id: ids[0] },
      data: { mpName: 'new target identity' },
    });
    release.resolve();
    await gate;
    await rejected;
    expect(backup.createVerifiedSqliteBackup).not.toHaveBeenCalled();
    expect(await prisma.feed.count()).toBe(3);
    expect(await prisma.article.count()).toBe(3);
  });
  it('refuses deletion with disabled actual foreign keys', async () => {
    await prisma.$executeRawUnsafe('PRAGMA foreign_keys=OFF');
    const before = await snapshot();
    await expect(api.feed.batchDelete(ids.slice(0, 2))).rejects.toThrow(
      'FEED_DELETE_FOREIGN_KEYS_REQUIRED',
    );
    expect(await snapshot()).toEqual(before);
  });
  it('retains all rows if an uncertain child fence is raised before the delete transaction', async () => {
    const owner = {};
    const before = await snapshot();
    jest
      .mocked(backup.createVerifiedSqliteBackup)
      .mockImplementationOnce(async (options) => {
        const result = await realBackup(options);
        sqliteWrites.fence(owner);
        return result;
      });
    try {
      await expect(api.feed.batchDelete(ids.slice(0, 2))).rejects.toThrow(
        'SQLite write fenced',
      );
    } finally {
      sqliteWrites.unfence(owner);
    }
    expect(await snapshot()).toEqual(before);
  });
  it('requires the correct protected source proof and rejects an ordinary or wrong-source receipt', async () => {
    const before = await snapshot();
    for (const report of [
      {
        source: database,
        recoveryOrigin: {
          format: 'sqlite-recovery-origin-v1',
          kind: 'periodic',
        },
      },
      {
        source: path.join(root, 'different.db'),
        recoveryOrigin: {
          format: 'sqlite-recovery-origin-v1',
          kind: 'protected',
        },
      },
    ]) {
      jest
        .mocked(backup.createVerifiedSqliteBackup)
        .mockResolvedValueOnce(report as any);
      await expect(api.feed.batchDelete(ids.slice(0, 2))).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    }
  });
  it('rejects unauthenticated callers before backup or deletion', async () => {
    const before = await snapshot();
    await expect(
      caller('login required').feed.batchDelete(ids.slice(0, 2)),
    ).rejects.toThrow();
    expect(backup.createVerifiedSqliteBackup).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });
});
