import { PrismaClient } from '@prisma/client';
import { cacheDataChanged } from '../feeds/cache-sync-state';
import { protectedDelete } from './protected-delete';

/** Preserve article.delete semantics and the existing route's returned ID. */
export async function protectedArticleDelete(prisma: PrismaClient, id: string) {
  await protectedDelete(prisma, {
    reason: 'ARTICLE_DELETE',
    read: async (db) => [await db.article.findUniqueOrThrow({ where: { id } })],
    reserve: (tx) => tx.$executeRawUnsafe('UPDATE articles SET id=id WHERE 0'),
    remove: (tx) => tx.article.delete({ where: { id } }),
  });
  cacheDataChanged(1);
  return id;
}
