import { PrismaClient } from '@prisma/client';
import { promises as fs } from 'node:fs';
import { TRPCError } from '@trpc/server';
import { createVerifiedSqliteBackup } from './sqlite-backup';
import { sqliteWrites } from './sqlite-write-coordinator';
import { assertIncrementalTransaction } from './incremental-write';
import { cacheDataChanged } from '../feeds/cache-sync-state';

async function databasePath(prisma: Pick<PrismaClient, '$queryRawUnsafe'>) {
  const files = await prisma.$queryRawUnsafe<
    Array<{ name: string; file: string }>
  >('PRAGMA database_list');
  const file = files.find((x) => x.name === 'main')?.file;
  if (!file) throw new Error('FEED_DELETE_SQLITE_DATABASE_REQUIRED');
  return fs.realpath(file);
}
async function fingerprint(database: string) {
  return JSON.stringify(
    await Promise.all(
      [database, database + '-wal', database + '-journal'].map(async (file) => {
        try {
          const stat = await fs.stat(file, { bigint: true });
          if (!stat.isFile() || !stat.ino)
            throw new Error('FEED_DELETE_DATABASE_IDENTITY_UNPROVED');
          return [
            stat.dev,
            stat.ino,
            stat.size,
            stat.mtimeNs,
            stat.ctimeNs,
          ].map(String);
        } catch (error) {
          if (
            file !== database &&
            (error as NodeJS.ErrnoException).code === 'ENOENT'
          )
            return null;
          throw error;
        }
      }),
    ),
  );
}

/** Both routes use the same pre-action backup and one atomic cascading transaction. */
export async function protectedFeedDelete(
  prisma: PrismaClient,
  input: string[],
  requireOne = false,
) {
  const ids = [...new Set(input)].sort();
  if (!ids.length) return input;
  const initial = await prisma.feed.findMany({
    where: { id: { in: ids } },
    orderBy: { id: 'asc' },
  });
  if (requireOne && initial.length !== 1)
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Subscription no longer exists; nothing deleted.',
    });
  if (!initial.length) return input;
  const selection = JSON.stringify(initial),
    targets = initial.map((feed) => feed.id);
  let database: string, version: string;
  await sqliteWrites.protectedWrite(
    async () => {
      database = await databasePath(prisma);
      version = await fingerprint(database);
      const feeds = await prisma.feed.findMany({
        where: { id: { in: ids } },
        orderBy: { id: 'asc' },
      });
      if (JSON.stringify(feeds) !== selection)
        throw new Error('FEED_DELETE_TARGETS_CHANGED');
      const report = await createVerifiedSqliteBackup();
      const origin = (
        report as { recoveryOrigin?: { format?: string; kind?: string } }
      ).recoveryOrigin;
      if (
        !('source' in report) ||
        typeof report.source !== 'string' ||
        (await fs.realpath(report.source)) !== database ||
        origin?.format !== 'sqlite-recovery-origin-v1' ||
        origin.kind !== 'protected'
      )
        throw new Error('FEED_DELETE_PROTECTED_BACKUP_REQUIRED');
    },
    async () => {
      if (!targets.length) return;
      await prisma.$transaction(async (tx) => {
        // Reserve the SQLite writer before business reads; no row changes.
        // Avoid a stale WAL read-to-write upgrade; never replay a delete.
        await tx.$executeRawUnsafe('UPDATE feeds SET id=id WHERE 0');
        await assertIncrementalTransaction(tx);
        const keys = await tx.$queryRawUnsafe<
          Array<{ foreign_keys: number | bigint }>
        >('PRAGMA foreign_keys');
        if (Number(keys[0]?.foreign_keys) !== 1)
          throw new Error('FEED_DELETE_FOREIGN_KEYS_REQUIRED');
        if ((await databasePath(tx)) !== database)
          throw new Error('FEED_DELETE_DATABASE_CHANGED');
        const feeds = await tx.feed.findMany({
          where: { id: { in: ids } },
          orderBy: { id: 'asc' },
        });
        if (
          JSON.stringify(feeds) !== selection ||
          (await fingerprint(database)) !== version
        )
          throw new Error('FEED_DELETE_DATABASE_CHANGED');
        const result = await tx.feed.deleteMany({
          where: { id: { in: targets } },
        });
        if (result.count !== targets.length)
          throw new Error('FEED_DELETE_TARGETS_CHANGED');
      });
    },
  );
  cacheDataChanged(targets.length);
  return input;
}
