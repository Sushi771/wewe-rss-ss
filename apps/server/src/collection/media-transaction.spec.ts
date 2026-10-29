import { mediaTransaction } from './media-transaction';
import { sqliteWrites } from './sqlite-write-coordinator';
import { PrismaService } from '../prisma/prisma.service';
import {
  databaseWritesAllowed,
  databaseRecoveryStatus,
  setDatabaseRecovery,
} from '../startup-audit';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { projectWriterGate } from './project-writer-boundary';

describe('owned media commit recovery', () => {
  let fixtureRoot: string, previousUrl: string | undefined;
  beforeEach(async () => {
    previousUrl = process.env.DATABASE_URL;
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'media-recovery-boundary-'));
    const file = path.join(fixtureRoot, 'synthetic.sqlite');
    await fs.writeFile(file, '', { flag: 'wx' });
    process.env.DATABASE_URL = 'file:' + file.replace(/\\/g, '/');
  });
  afterEach(async () => {
    setDatabaseRecovery('ready');
    jest.useRealTimers();
    projectWriterGate().writerForUrl(process.env.DATABASE_URL)?.close();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });
  const failure = { code: 'P2028' };
  it('does not replay or recover a successful callback', async () => {
    const db = { recoverFailedMediaTransaction: jest.fn() };
    const operation = jest.fn().mockResolvedValue('receipt');
    expect(await mediaTransaction(db, operation)).toBe('receipt');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(db.recoverFailedMediaTransaction).not.toHaveBeenCalled();
  });
  it('preserves ordinary callback failure without reconnect', async () => {
    const db = { recoverFailedMediaTransaction: jest.fn() };
    const error = Error('SAVED_MEDIA_CONFLICT');
    await expect(
      mediaTransaction(db, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(db.recoverFailedMediaTransaction).not.toHaveBeenCalled();
  });
  it('keeps queued writers outside the connection cleanup boundary', async () => {
    let entered!: () => void, finish!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const closed = new Promise<void>((r) => {
      finish = r;
    });
    const db = {
      recoverFailedMediaTransaction: jest.fn(async () => {
        entered();
        await closed;
      }),
    };
    const operation = jest.fn().mockRejectedValue(failure);
    const result = mediaTransaction(db, operation).catch((e) => e);
    await started;
    const write = jest.fn();
    const pending = sqliteWrites.write(async () => write());
    await Promise.resolve();
    expect(write).not.toHaveBeenCalled();
    finish();
    expect(await result).toBe(failure);
    await pending;
    expect(write).toHaveBeenCalledTimes(1);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(db.recoverFailedMediaTransaction).toHaveBeenCalledTimes(1);
  });
  it('deduplicates cleanup and blocks read/write entry until the probe succeeds', async () => {
    const db = new PrismaService();
    let release!: () => void;
    const close = jest.fn(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    db.$disconnect = close;
    db.$connect = jest.fn().mockResolvedValue(undefined);
    db.$queryRawUnsafe = jest.fn().mockResolvedValue([{ ok: 1 }]);
    const first = db.recoverFailedMediaTransaction();
    expect(db.recoverFailedMediaTransaction()).toBe(first);
    expect(databaseWritesAllowed()).toBe(false);
    expect(databaseRecoveryStatus()).toBe('recovering');
    await expect(db.feed.count()).rejects.toThrow(
      'SQLITE_RECOVERY_UNAVAILABLE',
    );
    await expect(db.$transaction(async () => 1)).rejects.toThrow(
      'SQLITE_RECOVERY_UNAVAILABLE',
    );
    release();
    await first;
    expect(databaseRecoveryStatus()).toBe('ready');
    expect(close).toHaveBeenCalledTimes(1);
    expect(db.$connect).toHaveBeenCalledTimes(1);
    expect(db.$queryRawUnsafe).toHaveBeenCalledWith('SELECT 1 AS ok');
  });
  it('keeps dispatch paused on disconnect failure without retrying', async () => {
    const db = new PrismaService();
    db.$disconnect = jest.fn().mockRejectedValue(Error('synthetic'));
    db.$connect = jest.fn();
    await expect(db.recoverFailedMediaTransaction()).rejects.toThrow(
      'MEDIA_TRANSACTION_RECOVERY_FAILED',
    );
    await expect(db.recoverFailedMediaTransaction()).rejects.toThrow(
      'MEDIA_TRANSACTION_RECOVERY_FAILED',
    );
    expect(db.$disconnect).toHaveBeenCalledTimes(1);
    expect(db.$connect).not.toHaveBeenCalled();
    expect(databaseRecoveryStatus()).toBe('failed');
    expect(databaseWritesAllowed()).toBe(false);
  });
  it.each(['connect', 'probe'])(
    'keeps writes paused after a failed %s stage',
    async (stage) => {
      const db = new PrismaService();
      db.$disconnect = jest.fn().mockResolvedValue(undefined);
      db.$connect =
        stage === 'connect'
          ? jest.fn().mockRejectedValue(Error('synthetic'))
          : jest.fn().mockResolvedValue(undefined);
      db.$queryRawUnsafe = jest
        .fn()
        .mockRejectedValue(Error('synthetic probe'));
      await expect(db.recoverFailedMediaTransaction()).rejects.toThrow(
        'MEDIA_TRANSACTION_RECOVERY_FAILED',
      );
      expect(databaseRecoveryStatus()).toBe('failed');
      expect(databaseWritesAllowed()).toBe(false);
      expect(db.$disconnect).toHaveBeenCalledTimes(1);
      expect(db.$connect).toHaveBeenCalledTimes(1);
    },
  );
  it('does not turn a late disconnect completion after timeout into recovery success', async () => {
    jest.useFakeTimers();
    const db = new PrismaService();
    let close!: () => void;
    db.$disconnect = jest.fn(
      () =>
        new Promise<void>((r) => {
          close = r;
        }),
    );
    db.$connect = jest.fn().mockResolvedValue(undefined);
    db.$queryRawUnsafe = jest.fn().mockResolvedValue([{ ok: 1 }]);
    const outcome = db.recoverFailedMediaTransaction().catch((e) => e);
    await jest.advanceTimersByTimeAsync(15000);
    expect((await outcome).message).toBe('MEDIA_TRANSACTION_RECOVERY_FAILED');
    close();
    await Promise.resolve();
    await Promise.resolve();
    expect(databaseRecoveryStatus()).toBe('failed');
    expect(databaseWritesAllowed()).toBe(false);
  });
  it('releases a real failed DELETE commit, preserves old body, then permits cached-data repair once', async () => {
    const previous = process.env.DATABASE_URL;
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'media-commit-synthetic-'),
    );
    const file = path.join(root, 'synthetic.sqlite');
    await fs.writeFile(file, '', { flag: 'wx' });
    process.env.DATABASE_URL = `file:${file.replace(/\\/g, '/')}?connection_limit=1`;
    const db = new PrismaService();
    const python = process.platform === 'win32' ? 'python' : 'python3';
    let reader: ReturnType<typeof spawn> | undefined;
    try {
      await db.$executeRawUnsafe(
        'CREATE TABLE synthetic (id INTEGER PRIMARY KEY, body TEXT)',
      );
      await db.$executeRawUnsafe(
        "INSERT INTO synthetic VALUES (1, 'manual text; old image')",
      );
      reader = spawn(
        python,
        [
          '-u',
          '-c',
          "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]);c.execute('begin');c.execute('select * from synthetic').fetchall();print('READY',flush=True);sys.stdin.readline();c.rollback();c.close()",
          file,
        ],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      await new Promise<void>((resolve, reject) => {
        reader!.stdout!.once('data', () => resolve());
        reader!.once('error', reject);
      });
      const operation = jest.fn(() =>
        db.$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe(
              "UPDATE synthetic SET body='new embedded image' WHERE id=1",
            );
          },
          { timeout: 15000 },
        ),
      );
      await expect(mediaTransaction(db, operation)).rejects.toMatchObject({
        code: 'P2028',
      });
      expect(operation).toHaveBeenCalledTimes(1);
      const done = new Promise<void>((resolve) =>
        reader!.once('exit', () => resolve()),
      );
      reader.stdin!.end('\n');
      await done;
      const result = execFileSync(
        python,
        [
          '-c',
          'import sqlite3,sys; c=sqlite3.connect(sys.argv[1],timeout=1);print(c.execute(\'select body from synthetic\').fetchone()[0]);c.execute("update synthetic set body=body where id=1");c.commit();c.close()',
          file,
        ],
        { windowsHide: true, encoding: 'utf8', timeout: 3000 },
      );
      expect(result.trim()).toBe('manual text; old image');
      await mediaTransaction(db, () =>
        db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            "UPDATE synthetic SET body='manual text; old image; cached PNG' WHERE id=1",
          );
        }),
      );
      expect(await db.$queryRawUnsafe('SELECT body FROM synthetic')).toEqual([
        { body: 'manual text; old image; cached PNG' },
      ]);
      const ackLost = jest.fn(async () => {
        await db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            "UPDATE synthetic SET body='manual text; old image; committed cached PNG' WHERE id=1",
          );
        });
        throw failure;
      });
      await expect(mediaTransaction(db, ackLost)).rejects.toBe(failure);
      expect(ackLost).toHaveBeenCalledTimes(1);
      expect(await db.$queryRawUnsafe('SELECT body FROM synthetic')).toEqual([
        { body: 'manual text; old image; committed cached PNG' },
      ]);
    } finally {
      reader?.stdin?.end('\n');
      await db.$disconnect();
      projectWriterGate().writerForUrl(process.env.DATABASE_URL)?.close();
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30000);
});
