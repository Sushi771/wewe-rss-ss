import { PrismaClient } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { cacheDataChanged } from '../feeds/cache-sync-state';
import { protectedDelete } from './protected-delete';

/** Both routes share the pre-action recovery boundary and atomic cascades. */
export async function protectedFeedDelete(
  prisma: PrismaClient,
  input: string[],
  requireOne = false,
) {
  const ids = [...new Set(input)].sort();
  if (!ids.length) return input;
  let removed = 0;
  await protectedDelete(prisma, {
    reason: 'FEED_DELETE',
    read: (db) =>
      db.feed.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } }),
    validate: (targets) => {
      if (requireOne && targets.length !== 1)
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Subscription no longer exists; nothing deleted.',
        });
    },
    reserve: (tx) => tx.$executeRawUnsafe('UPDATE feeds SET id=id WHERE 0'),
    remove: async (tx, targets) => {
      const result = await tx.feed.deleteMany({
        where: { id: { in: targets.map((row) => row.id) } },
      });
      if (result.count !== targets.length)
        throw new Error('FEED_DELETE_TARGETS_CHANGED');
      removed = result.count;
    },
  });
  cacheDataChanged(removed);
  return input;
}
