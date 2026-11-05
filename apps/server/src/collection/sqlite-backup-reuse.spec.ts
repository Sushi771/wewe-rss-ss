import { PrismaClient } from '@prisma/client';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { reuseVerifiedSqliteBackup } from './sqlite-backup-reuse';
import { SqliteWriteCoordinator } from './sqlite-write-coordinator';

describe('verified backup reuse with real isolated SQLite commits', () => {
  let directory: string;
  let database: string;
  let db: PrismaClient;
  let create: jest.Mock;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'synthetic-backup-reuse-'));
    database = path.join(directory, 'source.db');
    db = new PrismaClient({ datasources: { db: { url: 'file:' + database } } });
    await db.$executeRawUnsafe(
      'CREATE TABLE probe(id INTEGER PRIMARY KEY, value INTEGER)',
    );
    await db.$executeRawUnsafe('INSERT INTO probe VALUES(1,0)');
    create = jest.fn(async () => {
      const backup = path.join(
        directory,
        `verified-${create.mock.calls.length}.db`,
      );
      await copyFile(database, backup);
      return { backup, sha256: 'a'.repeat(64), integrityCheck: 'ok' };
    });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await db.$disconnect();
    await rm(directory, { recursive: true, force: true });
  });

  it('reuses an unchanged commit, but a real committed write forces fresh protection', async () => {
    const first = await reuseVerifiedSqliteBackup(database, create);
    expect(await reuseVerifiedSqliteBackup(database, create)).toEqual(first);
    expect(create).toHaveBeenCalledTimes(1);
    await db.$executeRawUnsafe('UPDATE probe SET value=1');
    expect((await reuseVerifiedSqliteBackup(database, create)).backup).not.toBe(
      first.backup,
    );
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('does not mask a failed fresh backup with the previous verified report', async () => {
    await reuseVerifiedSqliteBackup(database, create);
    await db.$executeRawUnsafe('UPDATE probe SET value=2');
    create.mockRejectedValueOnce(new Error('Synthetic verification failure'));
    await expect(reuseVerifiedSqliteBackup(database, create)).rejects.toThrow(
      'verification failure',
    );
    await reuseVerifiedSqliteBackup(database, create);
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('does not cache a snapshot if an external commit changed the source during creation', async () => {
    const copy = create.getMockImplementation()!;
    create.mockImplementationOnce(async () => {
      const report = await copy();
      await db.$executeRawUnsafe('UPDATE probe SET value=3');
      return report;
    });
    await reuseVerifiedSqliteBackup(database, create);
    await reuseVerifiedSqliteBackup(database, create);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('requires a fresh snapshot after artifact deletion, corruption, or TTL expiry', async () => {
    const first = await reuseVerifiedSqliteBackup(database, create);
    await rm(first.backup);
    const second = await reuseVerifiedSqliteBackup(database, create);
    await writeFile(second.backup, 'corrupted fixture');
    await reuseVerifiedSqliteBackup(database, create);
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + 30001);
    await reuseVerifiedSqliteBackup(database, create);
    expect(create).toHaveBeenCalledTimes(4);
  });

  it('bypasses reuse in WAL mode and with an active journal', async () => {
    await reuseVerifiedSqliteBackup(database, create);
    await writeFile(database + '-journal', 'synthetic active journal');
    await reuseVerifiedSqliteBackup(database, create);
    await reuseVerifiedSqliteBackup(database, create);
    expect(create).toHaveBeenCalledTimes(3);
    await rm(database + '-journal');
    await db.$queryRawUnsafe('PRAGMA journal_mode=WAL');
    await reuseVerifiedSqliteBackup(database, create);
    await reuseVerifiedSqliteBackup(database, create);
    expect(create).toHaveBeenCalledTimes(5);
  });

  it('coalesces queued preparation checks while keeping writes outside the backup permit', async () => {
    const coordinator = new SqliteWriteCoordinator();
    let release: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realCreate = create.getMockImplementation()!;
    create.mockImplementationOnce(async () => {
      await held;
      return realCreate();
    });
    const first = coordinator.snapshot(() =>
      reuseVerifiedSqliteBackup(database, create),
    );
    const second = coordinator.snapshot(() =>
      reuseVerifiedSqliteBackup(database, create),
    );
    let entered = false;
    const writer = coordinator.write(async () => {
      entered = true;
      // The transaction timeout starts only once backup admission releases.
      await db.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe('UPDATE probe SET value=value+1');
        },
        { timeout: 100 },
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(entered).toBe(false);
    release!();
    expect(await second).toEqual(await first);
    await writer;
    expect(create).toHaveBeenCalledTimes(1);
    expect(await db.$queryRawUnsafe('SELECT value FROM probe')).toEqual([
      { value: 1 },
    ]);
    await coordinator.snapshot(() =>
      reuseVerifiedSqliteBackup(database, create),
    );
    expect(create).toHaveBeenCalledTimes(2);
  });
});
