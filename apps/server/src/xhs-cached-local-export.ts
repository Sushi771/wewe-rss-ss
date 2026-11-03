import { PrismaClient } from '@prisma/client';
import {
  LocalArticleStore,
  ArticlePreparation,
  PreparedArticle,
} from './article-local-save';
import { LOCAL_EXPORT_BATCH_LIMIT } from './article-local-export-batch';
import { xhsOriginalLink } from './collection/xhs-original-link';
import { ArticleDownloadError } from './article-download';

export const XHS_CACHED_SCOPE_LIMIT = 5000; // Same frozen-selection limit as article.exportIds.
export type XhsCachedTarget = { id: string; creatorId: string };
export async function freezeCachedXhsSelection(
  prisma: Pick<PrismaClient, 'xhsNote'>,
  items: readonly XhsCachedTarget[],
) {
  if (
    !items.length ||
    items.length > XHS_CACHED_SCOPE_LIMIT ||
    new Set(items.map((x) => x.id)).size !== items.length
  )
    throw new Error('XHS_CACHED_SCOPE_INVALID');
  const rows = await prisma.xhsNote.findMany({
    where: { id: { in: items.map((x) => x.id) } },
    select: {
      id: true,
      creatorId: true,
      title: true,
      publishTime: true,
      kind: true,
      creator: {
        select: {
          id: true,
          displayName: true,
          group: { select: { id: true, name: true } },
        },
      },
    },
  });
  const byId = new Map(rows.map((x) => [x.id, x]));
  return items.map((item) => {
    const row = byId.get(item.id);
    if (!row || row.creatorId !== item.creatorId)
      throw new Error('XHS_SELECTION_CHANGED');
    const identity: PreparedArticle = {
      articleId: row.id,
      title: row.title,
      imageCount: 0,
      videoCount: row.kind === 'video' ? 1 : 0,
      publishTime: row.publishTime,
      sourceUrl: xhsOriginalLink(row.id),
      exportSource: {
        feedId: row.creator.id,
        feedName: row.creator.displayName,
        groupId: row.creator.group?.id,
        groupName: row.creator.group?.name,
        platform: 'xiaohongshu',
      },
    };
    return { ...item, identity };
  });
}
export async function saveFrozenXhsCache(
  frozen: Awaited<ReturnType<typeof freezeCachedXhsSelection>>,
  store: LocalArticleStore,
  directory: string,
  prepareCached: (creatorId: string, id: string) => Promise<ArticlePreparation>,
  cancelled: () => boolean = () => false,
) {
  const receipt: {
    results: Array<{
      id: string;
      saved?: { markdownPath: string; alreadySaved: boolean; status?: string };
      error?: string;
    }>;
    cancelled: boolean;
  } = { results: [], cancelled: false };
  for (
    let offset = 0;
    offset < frozen.length;
    offset += LOCAL_EXPORT_BATCH_LIMIT
  ) {
    if (cancelled()) {
      receipt.cancelled = true;
      break;
    }
    const batch = frozen.slice(offset, offset + LOCAL_EXPORT_BATCH_LIMIT);
    await store.withRetainedBatch(
      batch.map((x) => x.identity),
      directory,
      async (scoped) => {
        for (const item of batch) {
          if (cancelled()) {
            receipt.cancelled = true;
            break;
          }
          try {
            const prepare = await prepareCached(item.creatorId, item.id);
            if (cancelled()) {
              receipt.cancelled = true;
              break;
            }
            const wrapped: ArticlePreparation = async (stage) => {
              const value = await prepare(stage);
              if (
                value.articleId !== item.id ||
                (value.videoCount || 0) !== (item.identity.videoCount || 0)
              )
                throw Error('XHS_CACHED_IDENTITY_CHANGED');
              return {
                ...value,
                title: item.identity.title,
                publishTime: item.identity.publishTime,
                sourceUrl: item.identity.sourceUrl,
                exportSource: item.identity.exportSource,
              };
            };
            wrapped.identity = item.identity;
            wrapped.afterSave = prepare.afterSave;
            const saved = await scoped.save(wrapped, new Date(), directory);
            if (saved.mediaComplete === false) {
              receipt.results.push({
                id: item.id,
                error: 'XHS_CACHED_MEDIA_INCOMPLETE',
              });
              continue;
            }
            receipt.results.push({
              id: item.id,
              saved: {
                markdownPath: saved.markdownPath,
                alreadySaved: saved.alreadySaved,
                status: saved.status,
              },
            });
          } catch (error) {
            const code =
              error instanceof ArticleDownloadError
                ? error.diagnostic.code
                : 'XHS_CACHED_SAVE_FAILED';
            receipt.results.push({ id: item.id, error: code });
          }
        }
      },
    );
    if (receipt.cancelled) break;
  }
  return receipt;
}
