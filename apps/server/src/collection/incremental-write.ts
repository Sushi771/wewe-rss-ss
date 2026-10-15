import { AsyncLocalStorage } from 'node:async_hooks';
import { promises as fs } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import * as path from 'node:path';
import { batchStorageLock } from './batch-storage-lock';

type Admission = {
  database: string;
  identity: string;
  requiredFree: bigint;
  active: boolean;
};
const context = new AsyncLocalStorage<Admission>();
const key = (s: { dev: bigint; ino: bigint }) => `${s.dev}/${s.ino}`;

/** Physical source-volume space only. Recovery-copy count/byte budgets are unrelated. */
async function check(admission: Admission) {
  if (!admission.active) throw new Error('INCREMENTAL_ADMISSION_EXPIRED');
  const source = await fs.stat(admission.database, { bigint: true });
  if (key(source) !== admission.identity)
    throw new Error('INCREMENTAL_DATABASE_REPLACED');
  const volume = await fs.statfs(admission.database, { bigint: true });
  if (volume.bavail * volume.bsize < admission.requiredFree)
    throw new Error('INCREMENTAL_DISK_SPACE_INSUFFICIENT');
}

/** Called again after coordinator admission, before opening the engine transaction. */
export function assertIncrementalWriteAdmission() {
  const admission = context.getStore();
  return admission ? check(admission) : undefined;
}

/** Check the actual transaction connection; do not silently change user pragmas. */
export async function assertIncrementalTransaction(
  tx: Pick<PrismaClient, '$queryRawUnsafe'>,
) {
  const sync =
    await tx.$queryRawUnsafe<Array<{ synchronous: number | bigint }>>(
      'PRAGMA synchronous',
    );
  const journal = await tx.$queryRawUnsafe<Array<{ journal_mode: string }>>(
    'PRAGMA journal_mode',
  );
  if (
    ![2, 3].includes(Number(sync[0]?.synchronous)) ||
    !['delete', 'truncate', 'persist', 'wal'].includes(journal[0]?.journal_mode)
  )
    throw new Error('INCREMENTAL_DURABILITY_MODE_UNPROVED');
  await assertIncrementalWriteAdmission();
}

export async function incrementalWrite<T>(
  prisma: Pick<PrismaClient, '$queryRawUnsafe'>,
  expectedBytes: number,
  operation: () => Promise<T>,
): Promise<T> {
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 0 ||
    expectedBytes > 64 * 1024 ** 2
  )
    throw new Error('INCREMENTAL_WRITE_SIZE_LIMIT');
  const files = await prisma.$queryRawUnsafe<
    Array<{ name: string; file: string }>
  >('PRAGMA database_list');
  const main = files.find((x) => x.name === 'main');
  if (!main?.file) throw new Error('INCREMENTAL_SQLITE_DATABASE_REQUIRED');
  const database = await fs.realpath(main.file);
  const source = await fs.stat(database, { bigint: true });
  const configured =
    process.env.SQLITE_INCREMENTAL_MIN_FREE_BYTES || String(64 * 1024 ** 2);
  if (
    !/^\d+$/.test(configured) ||
    BigInt(configured) < 1024n ** 2n ||
    BigInt(configured) > 16n * 1024n ** 3n
  )
    throw new Error('INCREMENTAL_DISK_POLICY_INVALID');
  const admission: Admission = {
    database,
    identity: key(source),
    active: true,
    // Allow a full rollback journal plus bounded payload growth and a physical margin.
    requiredFree: source.size + BigInt(expectedBytes) * 2n + BigInt(configured),
  };
  await check(admission);
  const directory = path.join(path.dirname(database), '.cache-incremental');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const deadline = performance.now() + 5000;
  let release = await batchStorageLock(directory);
  while (!release && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    release = await batchStorageLock(directory);
  }
  if (!release) throw new Error('INCREMENTAL_WRITE_BUSY');
  try {
    await check(admission);
    return await context.run(admission, operation);
  } finally {
    admission.active = false;
    await release();
  }
}
