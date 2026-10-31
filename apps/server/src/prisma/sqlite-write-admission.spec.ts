beforeAll(require('../../../../scripts/local-release/writer-self.fixture.test.cjs').prepareWriterSelf);
import { splitSqliteStatements } from '../../../../scripts/sqlite-statements.cjs';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from './prisma.service';
import { createVerifiedSqliteBackup } from '../collection/sqlite-backup';

describe('real application Prisma admission with actual Python backup and SQLite', () => {
  let prisma: PrismaService, root: string;
  const originalUrl = process.env.DATABASE_URL;
  const base = path.resolve(process.env.WEWE_TEST_TEMP_ROOT || os.tmpdir());

  beforeAll(async () => {
    root = await mkdtemp(path.join(base, 'sqlite-coordinated-test-'));
    await writeFile(path.join(root,'test.db'),'',{flag:'wx'});
    process.env.DATABASE_URL = `file:${path.join(root, 'test.db').replace(/\\/g, '/')}?connection_limit=1`;
    prisma = new PrismaService();
    await prisma.onModuleInit();
    const migrations = path.resolve(__dirname, '../../prisma/migrations');
    for (const name of (await readdir(migrations)).sort()) {
      if (!(await stat(path.join(migrations, name))).isDirectory()) continue;
      for (const sql of splitSqliteStatements(
        await readFile(path.join(migrations, name, 'migration.sql'), 'utf8'),
      )
        .map((s) => s.trim())
        .filter(Boolean))
        await prisma.$executeRawUnsafe(sql);
    }
    await prisma.$executeRawUnsafe(
      'CREATE TABLE admission_counter(value INTEGER)',
    );
    await prisma.$executeRawUnsafe('INSERT INTO admission_counter VALUES(0)');
    await prisma.feed.create({
      data: {
        id: 'synthetic-feed',
        mpName: 'fixture',
        mpCover: '',
        mpIntro: '',
        updateTime: 0,
      },
    });
  }, 30000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await prisma?.$disconnect();
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
    if (root) {
      const target = path.resolve(root);
      if (
        !target.startsWith(base + path.sep) ||
        !path.basename(target).startsWith('sqlite-coordinated-test-')
      )
        throw new Error('Refuse cleanup outside synthetic test root');
      await rm(target, { recursive: true, force: true });
    }
  });

  it('queues ORM, raw SQL, batch and short interactive transactions before engine admission', async () => {
    const childProcess =
      jest.requireActual<typeof import('node:child_process')>(
        'node:child_process',
      );
    const realSpawn = childProcess.spawn;
    let started!: () => void;
    const copying = new Promise<void>((resolve) => {
      started = resolve;
    });
    const loader = [
      'import sqlite3,sys,time,runpy',
      'original=sqlite3.connect',
      'class Slow(sqlite3.Connection):',
      ' def backup(self,target,**kwargs):',
      '  original_progress=kwargs["progress"]; held=[]',
      '  def progress(*args):',
      '   if not held:',
      '    held.append(True); print("synthetic-copy-held",file=sys.stderr,flush=True); time.sleep(.25)',
      '   original_progress(*args)',
      '  kwargs["progress"]=progress; return super().backup(target,**kwargs)',
      'def connect(*args,**kwargs):',
      ' kwargs["factory"]=Slow; return original(*args,**kwargs)',
      'sqlite3.connect=connect',
      'sys.argv=sys.argv[1:]; runpy.run_path(sys.argv[0],run_name="__main__")',
    ].join('\n');
    const spy = jest
      .spyOn(childProcess, 'spawn')
      .mockImplementationOnce((executable, args, options) => {
        const child = realSpawn(
          executable,
          ['-c', loader, ...(args as string[])],
          options,
        );
        child.stderr!.on('data', (chunk) => {
          if (String(chunk).includes('synthetic-copy-held')) started();
        });
        return child;
      });
    let callbacks = 0,
      upstreamCalls = 0;
    const backup = createVerifiedSqliteBackup();
    await copying;
    // Queue longer than the transaction's entire 100ms timeout, without opening
    // that transaction. No replay of callbacks or any external side effect.
    const raw = prisma.$executeRawUnsafe(
      'UPDATE admission_counter SET value=value+1',
    );
    const orm = prisma.feed.update({
      where: { id: 'synthetic-feed' },
      data: { order: { increment: 1 } },
    });
    const batch = prisma.$transaction([
      prisma.$executeRawUnsafe('UPDATE admission_counter SET value=value+1'),
    ]);
    const interactive = prisma.$transaction(
      async (tx) => {
        callbacks++;
        upstreamCalls++; // represents a non-replayable callback effect
        await tx.$executeRawUnsafe(
          'UPDATE admission_counter SET value=value+1',
        );
        return 7;
      },
      { timeout: 100 },
    );
    const writes = Promise.all([raw, orm, batch, interactive]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(callbacks).toBe(0);
    // Read-only ORM reads remain available without queuing behind the backup.
    expect(
      (await prisma.feed.findUniqueOrThrow({ where: { id: 'synthetic-feed' } }))
        .order,
    ).toBe(0);
    const report = await backup;
    await writes;
    const after = await prisma.$queryRawUnsafe<Array<{ value: number }>>(
      'SELECT value FROM admission_counter',
    );
    expect(after[0].value).toBe(3);
    expect(callbacks).toBe(1);
    expect(upstreamCalls).toBe(1);
    expect(
      (await prisma.feed.findUniqueOrThrow({ where: { id: 'synthetic-feed' } }))
        .order,
    ).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
    if (!('backup' in report) || !report.backup)
      throw new Error('Synthetic backup missing');
    const saved = new PrismaClient({
      datasources: { db: { url: `file:${report.backup.replace(/\\/g, '/')}` } },
    });
    try {
      const rows = await saved.$queryRawUnsafe<Array<{ value: number }>>(
        'SELECT value FROM admission_counter',
      );
      expect(rows[0].value).toBe(0);
      expect(
        (
          await saved.feed.findUniqueOrThrow({
            where: { id: 'synthetic-feed' },
          })
        ).order,
      ).toBe(0);
    } finally {
      await saved.$disconnect();
      spy.mockRestore();
    }
  }, 15000);

  it('lets an already open real transaction finish before starting a queued backup', async () => {
    const native =
      jest.requireActual<typeof import('node:child_process')>(
        'node:child_process',
      );
    const spy = jest.spyOn(native, 'spawn');
    let begun!: () => void, proceed!: () => void;
    const ready = new Promise<void>((resolve) => {
      begun = resolve;
    });
    const continuation = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    const initial = await prisma.$queryRawUnsafe<Array<{ value: number }>>(
      'SELECT value FROM admission_counter',
    );
    const transaction = prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          'UPDATE admission_counter SET value=value+1',
        );
        begun();
        await continuation;
        // Middleware of this second statement must reuse valid transaction
        // admission, even though a backup is now waiting at the queue head.
        await tx.$executeRawUnsafe(
          'UPDATE admission_counter SET value=value+1',
        );
      },
      { timeout: 2000 },
    );
    await ready;
    const pending = createVerifiedSqliteBackup();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(spy).not.toHaveBeenCalled();
    proceed();
    await transaction;
    const report = await pending;
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    if (!('backup' in report) || !report.backup)
      throw new Error('Synthetic backup missing');
    const saved = new PrismaClient({
      datasources: { db: { url: `file:${report.backup.replace(/\\/g, '/')}` } },
    });
    try {
      const rows = await saved.$queryRawUnsafe<Array<{ value: number }>>(
        'SELECT value FROM admission_counter',
      );
      expect(rows[0].value).toBe(initial[0].value + 2);
    } finally {
      await saved.$disconnect();
    }
  }, 15000);
});
