import { PrismaClient } from '@prisma/client';
import { join } from 'node:path';
import { LocalArticleStore } from './article-local-save';
import { exportSourceFromFeed } from './article-export-source';
import { prepareCachedArticleLocalExport } from './cached-article-local-export';

export const LOCAL_EXPORT_BATCH_LIMIT = 64;
const BODY_BATCH_SIZE = 8;
type Saved = Pick<
  Awaited<ReturnType<LocalArticleStore['save']>>,
  | 'markdownPath'
  | 'alreadySaved'
  | 'status'
  | 'mediaComplete'
  | 'mediaStatus'
  | 'missingImageCount'
  | 'publicationDate'
  | 'datePendingReason'
  | 'legacyLayoutRetained'
>;
export type LocalExportBatchResult = {
  results: Array<{ id: string; saved?: Saved; error?: string }>;
  cancelled: boolean;
};

/** One bounded caller-owned batch, not a persisted task or a cross-batch cache.
 * Metadata freezes lock membership before bodies are read. No database
 * transaction/connection is held during directory validation or publication. */
export async function saveCachedArticleBatch(
  prisma: Pick<PrismaClient, 'article'>,
  rawIds: readonly string[],
  directory: string,
  cancelled: () => boolean = () => false,
): Promise<LocalExportBatchResult> {
  const ids = [...new Set(rawIds)];
  if (!ids.length || ids.length > LOCAL_EXPORT_BATCH_LIMIT)
    throw new Error('LOCAL_EXPORT_BATCH_INVALID');
  const result: LocalExportBatchResult = { results: [], cancelled: false };
  if (cancelled()) return { ...result, cancelled: true };
  const metadata = await prisma.article.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      title: true,
      sourceUrl: true,
      publishTime: true,
      feed: {
        select: {
          id: true,
          mpName: true,
          group: { select: { id: true, name: true } },
        },
      },
    },
  });
  const byId = new Map(metadata.map((article) => [article.id, article]));
  if (byId.size !== ids.length) throw new Error('LOCAL_EXPORT_MEMBERS_CHANGED');
  const identities = ids.map((id) => {
    const article = byId.get(id)!;
    return {
      articleId: id,
      title: article.title,
      sourceUrl: article.sourceUrl,
      publishTime: article.publishTime,
      imageCount: 0,
      exportSource: exportSourceFromFeed(article.feed),
    };
  });
  if (cancelled()) return { ...result, cancelled: true };
  const store = new LocalArticleStore(
    join(directory, '.wewe-list-export-settings.json'),
    directory,
  );
  return store.withRetainedBatch(identities, directory, async (scoped) => {
    for (let offset = 0; offset < ids.length; offset += BODY_BATCH_SIZE) {
      if (cancelled()) return { ...result, cancelled: true };
      const next = ids.slice(offset, offset + BODY_BATCH_SIZE);
      const rows = await prisma.article.findMany({
        where: { id: { in: next } },
        select: {
          id: true,
          title: true,
          sourceUrl: true,
          publishTime: true,
          contentHtml: true,
          lastBodyStatus: true,
          metrics: true,
          feed: {
            select: {
              id: true,
              mpName: true,
              group: { select: { id: true, name: true } },
            },
          },
        },
      });
      const bodies = new Map(rows.map((article) => [article.id, article]));
      for (const id of next) {
        if (cancelled()) return { ...result, cancelled: true };
        try {
          const article = bodies.get(id);
          if (!article) throw new Error('LOCAL_EXPORT_MEMBERS_CHANGED');
          const saved = await scoped.save(
            prepareCachedArticleLocalExport(
              article,
              exportSourceFromFeed(article.feed),
            ),
            new Date(),
            directory,
          );
          // Internal receipt bytes/maps and staging paths never enter the API.
          result.results.push({
            id,
            saved: {
              markdownPath: saved.markdownPath,
              alreadySaved: saved.alreadySaved,
              status: saved.status,
              mediaComplete: saved.mediaComplete,
              mediaStatus: saved.mediaStatus,
              missingImageCount: saved.missingImageCount,
              publicationDate: saved.publicationDate,
              datePendingReason: saved.datePendingReason,
              legacyLayoutRetained: saved.legacyLayoutRetained,
            },
          });
          // Preserve stop-on-failure for the existing selected-item caller;
          // completed files remain valid, later targets are not submitted.
          if (saved.mediaComplete === false) return result;
        } catch (error) {
          result.results.push({
            id,
            error:
              error instanceof Error ? error.message : 'LOCAL_EXPORT_FAILED',
          });
          return result;
        }
      }
    }
    return result;
  });
}
