import { Prisma, PrismaClient } from '@prisma/client';
import { promises as fs } from 'node:fs';
import { createVerifiedSqliteBackup } from './sqlite-backup';
import { sqliteWrites } from './sqlite-write-coordinator';
import { assertIncrementalTransaction } from './incremental-write';

async function databasePath(prisma: Pick<PrismaClient, '$queryRawUnsafe'>) {
  const files = await prisma.$queryRawUnsafe<
    Array<{ name: string; file: string }>
  >('PRAGMA database_list');
  const file = files.find((x) => x.name === 'main')?.file;
  if (!file) throw new Error('DELETE_SQLITE_DATABASE_REQUIRED');
  return fs.realpath(file);
}
async function fingerprint(database: string) {
  return JSON.stringify(
    await Promise.all(
      [database, database + '-wal', database + '-journal'].map(async (file) => {
        try {
          const stat = await fs.stat(file, { bigint: true });
          if (!stat.isFile() || !stat.ino)
            throw new Error('DELETE_DATABASE_IDENTITY_UNPROVED');
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

/** One recovery boundary for existing deletion routes; never retries a deletion. */
export async function protectedDelete<T>(
  prisma: PrismaClient,
  options: {
    reason: 'FEED_DELETE' | 'ARTICLE_DELETE';
    read: (db: Prisma.TransactionClient) => Promise<T[]>;
    validate?: (targets: T[]) => void;
    reserve: (tx: Prisma.TransactionClient) => Promise<unknown>;
    remove: (tx: Prisma.TransactionClient, targets: T[]) => Promise<unknown>;
  },
) {
  const initial = await options.read(prisma);
  options.validate?.(initial);
  if (!initial.length) return;
  const selection = JSON.stringify(initial);
  const fail = (suffix: string): never => {
    throw new Error(`${options.reason}_${suffix}`);
  };
  let database: string, version: string;
  await sqliteWrites.protectedWrite(
    async () => {
      database = await databasePath(prisma);
      version = await fingerprint(database);
      if (JSON.stringify(await options.read(prisma)) !== selection)
        fail('TARGETS_CHANGED');
      const report = await createVerifiedSqliteBackup();
      const origin = (
        report as { recoveryOrigin?: { format?: string; kind?: string } }
      ).recoveryOrigin;
      if (
        !('source' in report) ||
        typeof report.source !== 'string' ||
        (await fs.realpath(report.source)) !== database ||
        report.integrityCheck !== 'ok' ||
        !report.backup ||
        !/^[a-f0-9]{64}$/.test(report.sha256) ||
        origin?.format !== 'sqlite-recovery-origin-v1' ||
        origin.kind !== 'protected'
      )
        fail('PROTECTED_BACKUP_REQUIRED');
    },
    async () => {
      await prisma.$transaction(async (tx) => {
        // Acquire the writer before targets; callers supply a zero-row statement.
        await options.reserve(tx);
        await assertIncrementalTransaction(tx);
        const keys = await tx.$queryRawUnsafe<
          Array<{ foreign_keys: number | bigint }>
        >('PRAGMA foreign_keys');
        if (Number(keys[0]?.foreign_keys) !== 1) fail('FOREIGN_KEYS_REQUIRED');
        if ((await databasePath(tx)) !== database) fail('DATABASE_CHANGED');
        if (
          JSON.stringify(await options.read(tx)) !== selection ||
          (await fingerprint(database)) !== version
        )
          fail('DATABASE_CHANGED');
        await options.remove(tx, initial);
      });
    },
  );
}
