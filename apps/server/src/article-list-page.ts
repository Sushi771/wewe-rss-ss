import { ArticleFilter } from '@wewe-rss/shared';
import { findBodySearchIds, searchSnippet } from './article-body-search';
import { Prisma, PrismaClient } from '@prisma/client';
import { reusableArticleList } from './article-list-cache';

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
  options?: {
    databaseUrl?: string;
    search?: ArticleFilter & {
      sort?: 'publishTime' | 'readCount' | 'likeCount';
      direction?: 'asc' | 'desc';
      cursor?: string | null;
    };
  },
) {
  // This read-only snapshot can traverse overflow pages even though archived
  // bodies are not selected. Bound connection admission and snapshot lifetime
  // separately from Prisma's short defaults; do not replay a partial read.
  return reusableArticleList(
    prisma,
    { query, search: options?.search },
    options?.databaseUrl,
    () =>
      prisma.$transaction(
        async (tx) => {
          // Sort/filter/cursor only the narrow identity projection. Otherwise
          // SQLite may read metadata after large body payloads for every row
          // considered by its sorter, even though HTML is not returned.
          const page = options?.search
            ? await findBodySearchIds(tx, options.search, query.take || 21)
            : await tx.article.findMany({
                ...query,
                select: { id: true },
              });
          if (!page.length) return [];
          const rows = await tx.article.findMany({
            where: { id: { in: page.map((row) => row.id) } },
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
          const cached = await tx.article.findMany({
            where: {
              id: { in: rows.map((row) => row.id) },
              contentHtml: { not: null },
              NOT: { contentHtml: '' },
            },
            select: { id: true },
          });
          const ids = new Set(cached.map((row) => row.id));
          const documents = options?.search
            ? await tx.articleSearchDocument.findMany({
                where: {
                  articleId: { in: page.map((row) => row.id) },
                  pending: false,
                },
                select: { articleId: true, bodyText: true },
              })
            : [];
          const snippets = new Map(
            documents.map((row) => [
              row.articleId,
              searchSnippet(row.bodyText, options?.search?.search || ''),
            ]),
          );
          const byId = new Map(
            rows.map((row) => [
              row.id,
              {
                ...row,
                bodyCached: ids.has(row.id),
                searchSnippet: snippets.get(row.id) || null,
              },
            ]),
          );
          // IN has no ordering guarantee. Identity selection and hydration stay
          // in the same snapshot, including the unseen next-cursor row.
          return page.map(({ id }) => {
            const row = byId.get(id);
            if (!row) throw new Error('ARTICLE_LIST_SNAPSHOT_ROW_MISSING');
            return row;
          });
        },
        { maxWait: 15000, timeout: 30000 },
      ),
  );
}
