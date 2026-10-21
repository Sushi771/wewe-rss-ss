import { Prisma } from '@prisma/client';
import { ArticleFilter, articlePublicationRange } from '@wewe-rss/shared';

/** Metadata/legacy title scope. Body-aware routes use article-body-search
 * for literal matching of title, publisher and normalized visible body text. */
export function articleListWhere(
  input: ArticleFilter,
): Prisma.ArticleWhereInput {
  return {
    mpId: input.mpId || undefined,
    publishTime: articlePublicationRange(input),
    ...(input.group && input.group !== 'all'
      ? { feed: { groupId: input.group === 'ungrouped' ? null : input.group } }
      : {}),
    ...(input.search
      ? {
          OR: [
            { title: { contains: input.search } },
            { feed: { mpName: { contains: input.search } } },
          ],
        }
      : {}),
  };
}

export function articleListOrder(input: {
  sort?: 'publishTime' | 'readCount' | 'likeCount';
  direction?: 'asc' | 'desc';
}): Prisma.ArticleOrderByWithRelationInput[] {
  const direction =
    !input.sort || input.sort === 'publishTime'
      ? input.direction || 'desc'
      : 'desc';
  return [{ [input.sort || 'publishTime']: direction }, { id: direction }];
}
