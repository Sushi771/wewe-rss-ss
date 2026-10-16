import { PrismaClient } from '@prisma/client';
import { mkdtemp, readFile, readdir, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  SqliteSnapshotGuard,
  FastInsertSnapshotLease,
  recentVerifiedSqliteSnapshot,
  startSqliteSnapshotGuard,
  stopSqliteSnapshotGuard,
  assertInsertOnlySnapshotPermit,
  notifySqliteSnapshotDirty,
} from './sqlite-snapshot-guard';

describe('snapshot owner with real local Python / Prisma SQLite only', () => {
  const originalEnv = { ...process.env };
  const originalCwd = process.cwd();
  let root: string;
  let database: string;
  let prisma: PrismaClient;
  let owners: SqliteSnapshotGuard[];

  async function newOwner() {
    const owner = new SqliteSnapshotGuard();
    owners.push(owner);
    const firstStart = owner.start();
    expect(owner.start()).toBe(firstStart);
    await firstStart;
    return owner;
  }

  async function waitForLease(owner: SqliteSnapshotGuard) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const health = await owner.query();
      if (health.verified && health.fresh && health.lease) return health.lease;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error('Synthetic snapshot did not become available');
  }

  beforeEach(async () => {
    process.chdir(path.resolve(__dirname, '..', '..'));
    root = await mkdtemp(path.join(tmpdir(), 'wewe-guard-prisma-test-'));
    database = path.join(root, 'fixture.db');
    process.env.SQLITE_PERIODIC_SNAPSHOT_ENABLED = '1';
    process.env.DATABASE_URL = 'file:' + database;
    process.env.SQLITE_SNAPSHOT_INTERVAL_SECONDS = '900';
    process.env.SQLITE_SNAPSHOT_MAX_AGE_SECONDS = '900';
    prisma = new PrismaClient({
      datasources: { db: { url: 'file:' + database } },
    });
    owners = [];
    await prisma.$queryRawUnsafe('PRAGMA journal_mode=WAL');
    await prisma.$executeRawUnsafe('CREATE TABLE feeds(id TEXT PRIMARY KEY)');
    await prisma.$executeRawUnsafe(
      'CREATE TABLE articles(id TEXT PRIMARY KEY, body TEXT)',
    );
    await prisma.$executeRawUnsafe(
      'CREATE TABLE cache_insert_batches(id TEXT PRIMARY KEY)',
    );
    await prisma.$executeRawUnsafe("INSERT INTO feeds VALUES ('old-feed')");
    await prisma.$executeRawUnsafe(
      "INSERT INTO articles VALUES ('old-article','Complete old body')",
    );
  });

  afterEach(async () => {
    for (const owner of owners) owner.stop();
    stopSqliteSnapshotGuard();
    await prisma.$disconnect();
    // Wait for killed worker handles to close before removing this exact fixture.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(path.dirname(root)).toBe(tmpdir());
    expect(path.basename(root)).toMatch(/^wewe-guard-prisma-test-/);
    await rm(root, { recursive: true, force: true });
    for (const key of Object.keys(process.env))
      if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    process.chdir(originalCwd);
  });

  it('periodic snapshots use the exact configured production root', async () => {
    process.env.SQLITE_PRODUCTION_BACKUP_ROOT = path.join(
      root,
      'configured-backups',
    );
    const owner = await newOwner();
    await waitForLease(owner);
    expect(
      (await readdir(process.env.SQLITE_PRODUCTION_BACKUP_ROOT)).some((name) =>
        name.startsWith('periodic-snapshot-'),
      ),
    ).toBe(true);
    await expect(readdir(path.join(root, 'backups'))).rejects.toThrow();
  });
  it('defaults to rejection with scheduling disabled', async () => {
    process.env.SQLITE_PERIODIC_SNAPSHOT_ENABLED = '0';
    const owner = await newOwner();
    expect(await owner.query()).toMatchObject({
      verified: false,
      fresh: false,
      reason: 'periodic-snapshot-disabled',
    });
    await expect(readdir(path.join(root, 'backups'))).rejects.toThrow();
  });

  it('validates source identity/schema and commits inserts + batch atomically', async () => {
    const owner = await newOwner();
    const lease = await waitForLease(owner);
    expect(lease.validUntilMs - Date.now()).toBeLessThanOrEqual(5000);
    await prisma.$transaction(async (tx) => {
      await owner.assertLease(tx, lease);
      await tx.$executeRawUnsafe(
        "INSERT INTO articles VALUES ('new-article','New complete body')",
      );
      await tx.$executeRawUnsafe(
        "INSERT INTO cache_insert_batches VALUES ('batch')",
      );
      await owner.assertLease(tx, lease);
    });
    await owner.markDirty(lease);
    const rows = await prisma.$queryRawUnsafe<
      Array<{ id: string; body: string }>
    >('SELECT * FROM articles ORDER BY id');
    expect(rows).toEqual([
      { id: 'new-article', body: 'New complete body' },
      { id: 'old-article', body: 'Complete old body' },
    ]);
    expect(
      await prisma.$queryRawUnsafe('SELECT * FROM cache_insert_batches'),
    ).toEqual([{ id: 'batch' }]);
    const names = await readdir(path.join(root, 'backups'));
    const receipt = names.find((name) =>
      /^snapshot-owner-.*\.json$/.test(name),
    )!;
    expect(
      JSON.parse(await readFile(path.join(root, 'backups', receipt), 'utf8'))
        .dirty,
    ).toBe(true);
    expect(
      names.filter((name) => name.startsWith('periodic-snapshot-')),
    ).toHaveLength(1);
    expect((await owner.query()).fresh).toBe(true);
  });

  it('rolls back inserts and batch when the saved snapshot disappears mid transaction', async () => {
    const owner = await newOwner();
    const lease = await waitForLease(owner);
    const dirs = await readdir(path.join(root, 'backups'));
    const saved = dirs.find((name) => name.startsWith('periodic-snapshot-'))!;
    await expect(
      prisma.$transaction(async (tx) => {
        await owner.assertLease(tx, lease);
        await tx.$executeRawUnsafe(
          "INSERT INTO articles VALUES ('new','body')",
        );
        await tx.$executeRawUnsafe(
          "INSERT INTO cache_insert_batches VALUES ('batch')",
        );
        await unlink(path.join(root, 'backups', saved, 'wewe-rss.db'));
        await owner.assertLease(tx, lease);
      }),
    ).rejects.toThrow('full backup required');
    expect(await prisma.$queryRawUnsafe('SELECT * FROM articles')).toEqual([
      { id: 'old-article', body: 'Complete old body' },
    ]);
    expect(
      await prisma.$queryRawUnsafe('SELECT * FROM cache_insert_batches'),
    ).toEqual([]);
    expect((await owner.query()).fresh).toBe(false);
  });

  it('rejects a copied token object, changed generation and stopped owner', async () => {
    const owner = await newOwner();
    const lease = await waitForLease(owner);
    await expect(
      prisma.$transaction((tx) => owner.assertLease(tx, { ...lease })),
    ).rejects.toThrow('full backup required');
    const foreign = {
      ...lease,
      generation: '0'.repeat(32),
    } as FastInsertSnapshotLease;
    await expect(
      prisma.$transaction((tx) => owner.assertLease(tx, foreign)),
    ).rejects.toThrow('full backup required');
    owner.stop();
    await expect(
      prisma.$transaction((tx) => owner.assertLease(tx, lease)),
    ).rejects.toThrow('full backup required');
  });

  it('rejects the wrong actual Prisma database connection', async () => {
    const owner = await newOwner();
    const lease = await waitForLease(owner);
    const other = new PrismaClient({
      datasources: { db: { url: 'file:' + path.join(root, 'other.db') } },
    });
    try {
      await other.$executeRawUnsafe('CREATE TABLE articles(id TEXT)');
      await expect(
        other.$transaction((tx) => owner.assertLease(tx, lease)),
      ).rejects.toThrow('database changed');
      expect(await other.$queryRawUnsafe('SELECT * FROM articles')).toEqual([]);
    } finally {
      await other.$disconnect();
    }
  });

  it('exposes the final consumer contract and validates the original embedded lease', async () => {
    await startSqliteSnapshotGuard();
    let permit = await recentVerifiedSqliteSnapshot();
    for (let attempt = 0; !permit && attempt < 30; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      permit = await recentVerifiedSqliteSnapshot();
    }
    expect(permit).not.toBeNull();
    expect(permit!.source).toBe(permit!.lease.databasePath);
    expect(permit!.sha256).toBe(permit!.lease.snapshotSha256);
    expect(permit!.verifiedAtMs).toBe(permit!.lease.backupSucceededAtMs);
    // The consumer may copy the outer metadata object; the embedded lease stays
    // the exact owner-issued object and original capability.
    const outerCopy = { ...permit! };
    await prisma.$transaction(async (tx) => {
      await assertInsertOnlySnapshotPermit(tx, outerCopy);
      await tx.$executeRawUnsafe("INSERT INTO articles VALUES ('new','body')");
      await assertInsertOnlySnapshotPermit(tx, outerCopy);
    });
    await notifySqliteSnapshotDirty(outerCopy);
  });
  it.each(['0', '1'])(
    'reports periodic quota failure without blocking ordinary writes with history review enabled=%s',
    async (historyEnabled) => {
      Object.assign(process.env, {
        SQLITE_ARTICLE_HISTORY_REVIEW_ENABLED: historyEnabled,
        SQLITE_BACKUP_KIND: 'test',
        SQLITE_TEST_MAX_BYTES: '1',
        SQLITE_TEST_MAX_COPIES: '1',
        SQLITE_TEST_BACKUP_ROOT: path.join(root, 'full-budget'),
      });
      const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const owner = await newOwner();
        for (
          let n = 0;
          n < 50 &&
          !warning.mock.calls.some(
            (args) => args[0] === '[SQLITE_PERIODIC_SNAPSHOT_FAILED]',
          );
          n++
        )
          await new Promise((resolve) => setTimeout(resolve, 30));
        expect(
          warning.mock.calls.filter(
            (args) => args[0] === '[SQLITE_PERIODIC_SNAPSHOT_FAILED]',
          ),
        ).toHaveLength(1);
        expect((await owner.query()).fresh).toBe(false);
        await prisma.$executeRawUnsafe(
          "INSERT INTO articles VALUES ('ordinary-after-backup-failure','retained')",
        );
        expect(
          await prisma.$queryRawUnsafe(
            "SELECT body FROM articles WHERE id='ordinary-after-backup-failure'",
          ),
        ).toEqual([{ body: 'retained' }]);
      } finally {
        warning.mockRestore();
      }
    },
  );
});
