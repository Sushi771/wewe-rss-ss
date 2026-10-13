import { Prisma, PrismaClient } from '@prisma/client';

type PageQuery = Pick<
  Prisma.ArticleFindManyArgs,
  'where' | 'take' | 'orderBy' | 'cursor'
>;

/** The list needs body presence, not potentially large archived HTML/data URLs.
 * Read metadata and presence in one snapshot; detail/export keep their body query.
 */
export function findArticleListRows(
  prisma: Pick<PrismaClient, '$transaction'>,
  query: PageQuery,
) {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.article.findMany({
      ...query,
      select: {
        id: true,
        mpId: true,
        title: true,
        picUrl: true,
        publishTime: true,
        sourceUrl: true,
        lastBodyStatus: true,
        verifiedSourceUrl: true,
        lastBodyRetry: true,
        metrics: true,
        readCount: true,
        likeCount: true,
        feed: true,
      },
    });
    if (!rows.length) return [];
    const cached = await tx.article.findMany({
      where: {
        id: { in: rows.map((row) => row.id) },
        contentHtml: { not: null },
        NOT: { contentHtml: '' },
      },
      select: { id: true },
    });
    const ids = new Set(cached.map((row) => row.id));
    return rows.map((row) => ({ ...row, bodyCached: ids.has(row.id) }));
  });
}
