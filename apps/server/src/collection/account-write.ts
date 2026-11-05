import { PrismaClient } from '@prisma/client';
import {
  incrementalWrite,
  assertIncrementalTransaction,
} from './incremental-write';
import { createVerifiedSqliteBackup } from './sqlite-backup';

const publicAccount = {
  id: true,
  name: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** A label/status edit cannot require a database recovery copy. Credentials can. */
export async function editAccount(
  prisma: PrismaClient,
  id: string,
  data: { name?: string; status?: number; token?: string },
) {
  if (data.token !== undefined) {
    await createVerifiedSqliteBackup({ allowMysqlSkip: true });
    return prisma.account.update({
      where: { id },
      data,
      select: publicAccount,
    });
  }
  const commit = () =>
    prisma.$transaction(async (tx) => {
      if ((process.env.DATABASE_URL || '').startsWith('file:'))
        await assertIncrementalTransaction(tx);
      const account = await tx.account.update({
        where: { id },
        data,
        select: publicAccount,
      });
      if ((process.env.DATABASE_URL || '').startsWith('file:'))
        await assertIncrementalTransaction(tx);
      return account;
    });
  // Preserve the existing non-desktop MySQL ordinary-write compatibility.
  if ((process.env.DATABASE_URL || '').startsWith('mysql://')) return commit();
  return incrementalWrite(
    prisma,
    Buffer.byteLength(JSON.stringify(data)),
    commit,
  );
}
