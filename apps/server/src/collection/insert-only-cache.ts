import { PrismaClient, Feed } from '@prisma/client';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { load } from 'cheerio';
import { databaseWritesAllowed } from '../startup-audit';
import { cacheDataChanged } from '../feeds/cache-sync-state';
import { canonicalArticleUrl } from './collection-format';
import { assertProviderPage, ProviderPage } from './subscription-provider';
import { archiveProviderImages } from './archive-provider-images';
import { batchStorageLock } from './batch-storage-lock';
import {
  recentVerifiedSqliteSnapshot,
  assertInsertOnlySnapshotPermit,
  notifySqliteSnapshotDirty,
  InsertOnlySnapshot,
} from './sqlite-snapshot-guard';

class UseProtectedSaver extends Error {}
class IdentityConflict extends Error {
  constructor() {
    super('CACHE_INSERT_IDENTITY_CONFLICT');
  }
}
const fallback = () => {
  throw new UseProtectedSaver();
};
async function snapshotPermit(): Promise<InsertOnlySnapshot | null> {
  if (
    process.env.SQLITE_INSERT_ONLY_FAST_PATH !== '1' ||
    !process.env.DATABASE_URL?.startsWith('file:') ||
    !databaseWritesAllowed()
  )
    return null;
  try {
    return await recentVerifiedSqliteSnapshot();
  } catch {
    return null;
  }
}

/** An internal cached-page continuation only. null requests the original
 * prewrite full backup and saver. Failures after a transaction starts always
 * roll back; infrastructure/unknown failures propagate without writing status.
 * The caller must hold its existing per-feed collection lock. */
export async function tryInsertOnlyCachedPage(
  prisma: Pick<PrismaClient, '$transaction'>,
  expected: Feed,
  incoming: ProviderPage,
  listOnly: boolean,
) {
  const permit = await snapshotPermit();
  if (!permit || !incoming.articles.length) return null;
  // This first check is not the authorization to write: the exact page and
  // all identities are checked again within the SQLite write transaction.
  assertProviderPage(incoming, expected.id);
  // Take a private copy: a provider/caller cannot mutate pending inputs while
  // the async snapshot check/SQLite lock is outstanding.
  const copied: ProviderPage = JSON.parse(JSON.stringify(incoming));
  // Reuse media validation without starting image downloads. Remote or
  // retryable image content goes through the original full-backup path.
  if (
    !listOnly &&
    copied.articles.some((item) =>
      load(item.contentHtml || '')('img')
        .toArray()
        .some((img) => !img.attribs.src?.startsWith('data:')),
    )
  )
    return null;
  const page: ProviderPage = listOnly
    ? {
        ...copied,
        articles: copied.articles.map((item) => ({
          ...item,
          contentHtml: null,
          picUrl: '',
        })),
        bodyMissing: copied.articles.length,
      }
    : await archiveProviderImages(copied, { stopOnFailure: true });
  let result: Awaited<ReturnType<typeof runTransaction>>;
  const checkPermit = async (
    tx: Parameters<typeof assertInsertOnlySnapshotPermit>[0],
  ) => {
    try {
      if (!databaseWritesAllowed()) fallback();
      await assertInsertOnlySnapshotPermit(tx, permit);
    } catch {
      fallback();
    }
  };
  const runTransaction = () =>
    prisma.$transaction(
      async (tx) => {
        await checkPermit(tx);
        const tables = await tx.$queryRaw<Array<{ name: string }>>`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name = 'cache_insert_batches'
        `;
        if (tables.length !== 1) fallback();
        const feed = await tx.feed.findUnique({ where: { id: expected.id } });
        if (
          !feed ||
          feed.status !== 1 ||
          feed.collectionChannel !== 'wechat2rss' ||
          [
            'mpName',
            'collectionChannel',
            'localDirectory',
            'publicAlbumIds',
          ].some((key) => feed[key] !== expected[key])
        )
          fallback();
        assertProviderPage(page, expected.id);
        // Compare ALL saved source representations, including legacy parameter
        // order/alternate mid names. Titles detect ambiguity only, never identity.
        const saved = await tx.article.findMany({
          where: { mpId: expected.id },
          select: {
            id: true,
            mpId: true,
            title: true,
            publishTime: true,
            sourceUrl: true,
            verifiedSourceUrl: true,
          },
        });
        const incomingIds = new Set(page.articles.map((item) => item.id));
        const globalIds = await tx.article.findMany({
          where: { id: { in: [...incomingIds] } },
          select: { id: true },
        });
        if (globalIds.length) fallback();
        for (const row of saved) {
          if (incomingIds.has(row.id)) fallback();
          if (
            !/^WX_\d{5,15}_\d+_[1-9]\d*$/.test(row.id) &&
            !row.sourceUrl &&
            !row.verifiedSourceUrl
          )
            fallback();
          for (const url of [row.sourceUrl, row.verifiedSourceUrl]) {
            if (!url) continue;
            try {
              const identity = canonicalArticleUrl(url);
              if (incomingIds.has(identity.id)) {
                // A differently ordered legacy source may evade the old
                // saver's SQL prefix match. Quarantine this proved conflict.
                throw new IdentityConflict();
              }
            } catch (error) {
              if (
                error instanceof UseProtectedSaver ||
                error instanceof IdentityConflict
              )
                throw error;
              // Any unverifiable source could conceal an identity collision.
              fallback();
            }
          }
          if (
            page.articles.some(
              (item) =>
                item.title === row.title &&
                item.publishTime === row.publishTime,
            )
          )
            fallback();
        }
        // Cross-feed source conflicts (including malformed legacy ownership)
        // are checked by canonical identity inside this same transaction.
        const foreign = await tx.article.findMany({
          where: {
            mpId: { not: expected.id },
            OR: [
              { sourceUrl: { contains: '__biz=' } },
              { verifiedSourceUrl: { contains: '__biz=' } },
            ],
          },
          select: { sourceUrl: true, verifiedSourceUrl: true },
        });
        for (const row of foreign)
          for (const url of [row.sourceUrl, row.verifiedSourceUrl]) {
            if (!url) continue;
            try {
              if (incomingIds.has(canonicalArticleUrl(url).id))
                throw new IdentityConflict();
            } catch (error) {
              if (
                error instanceof UseProtectedSaver ||
                error instanceof IdentityConflict
              )
                throw error;
            }
          }
        await checkPermit(tx);
        for (const item of page.articles) {
          const identity = canonicalArticleUrl(item.url);
          // No UPSERT/updateMany/skipDuplicates: a concurrent uniqueness
          // conflict aborts this entire transaction and re-enters protection.
          await tx.article.create({
            data: {
              id: identity.id,
              mpId: expected.id,
              title: item.title,
              publishTime: item.publishTime,
              sourceUrl: identity.url,
              verifiedSourceUrl: identity.url,
              contentHtml: item.contentHtml,
              picUrl: item.picUrl,
              lastBodyStatus: item.contentHtml
                ? item.contentHtml.includes('data-wewe-image-pending=')
                  ? 'images-pending'
                  : 'available'
                : 'unavailable',
            },
          });
        }
        const latest = await tx.article.aggregate({
          where: { mpId: expected.id },
          _max: { publishTime: true },
        });
        const bodyReady =
          !listOnly &&
          !page.bodyMissing &&
          !page.imageBlocked &&
          page.articles.every(
            (item) =>
              !!item.contentHtml &&
              !item.contentHtml.includes('data-wewe-image-pending='),
          );
        const result = {
          source: 'wechat2rss' as const,
          status: 'partial' as const,
          complete: false as const,
          coverage: page.coverage,
          articles: page.articles.length,
          created: page.articles.length,
          updated: 0,
          accepted: false,
          bodyMissing: page.bodyMissing,
          identitySkipped: 0,
          identitySkippedArticles: [],
          listReady: true,
          bodyReady,
          imageBlocked: page.imageBlocked,
          message: `缓存归档新增 ${page.articles.length} 篇；正文缺失 ${page.bodyMissing}，图片受限 ${page.imageBlocked}；历史覆盖仍不保证。`,
        };
        const manifest = JSON.stringify(
          page.articles.map((item) => ({
            id: item.id,
            sourceUrl: item.url,
            contentSha256: createHash('sha256')
              .update(JSON.stringify(item))
              .digest('hex'),
          })),
        );
        const batchId = createHash('sha256')
          .update(JSON.stringify([1, expected.id, listOnly, manifest]))
          .digest('hex');
        const committedAtMs = Date.now();
        await tx.$executeRaw`
          INSERT INTO cache_insert_batches
            (id, mp_id, article_manifest, snapshot_generation, guard_generation,
             backup_started_at_ms, coverage_at_ms, created_count, committed_at_ms)
          VALUES (${batchId}, ${expected.id}, ${manifest}, ${permit.lease.snapshotGeneration}, ${permit.lease.generation},
            ${permit.lease.backupStartedAtMs}, ${permit.lease.coverageAtMs}, ${result.created}, ${committedAtMs})
        `;
        await tx.feed.update({
          where: { id: expected.id },
          data: {
            ...(bodyReady
              ? { syncTime: Math.floor(committedAtMs / 1000) }
              : {}),
            updateTime: Math.max(
              feed!.updateTime,
              latest._max.publishTime || 0,
            ),
            hasHistory: -1,
            lastCollectionResult: JSON.stringify({
              ...result,
              attemptedAt: Math.floor(committedAtMs / 1000),
            }),
          },
        });
        await checkPermit(tx);
        return result;
      },
      { timeout: 60000 },
    );
  // Narrow same-host lock for this INSERT path only. SQLite/Prisma may panic
  // when two deferred transactions simultaneously upgrade their read locks.
  // Reuse the project's durable PID mutex; never introduce a timed lease that
  // could expire while a transaction is committing.
  const directory = path.join(
    path.dirname(permit.source),
    '.cache-insert-only',
  );
  let release: (() => Promise<void>) | undefined;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    release = await batchStorageLock(directory);
  } catch {
    return null;
  }
  if (!release) return null;
  try {
    result = await runTransaction();
  } catch (error) {
    if (
      error instanceof UseProtectedSaver ||
      (error as { code?: string })?.code === 'P2002' ||
      (error as { code?: string })?.code === 'P2034'
    )
      return null;
    throw error;
  } finally {
    try {
      await release();
    } catch {
      console.warn('SQLITE_INSERT_ONLY_LOCK_RELEASE_FAILED');
    }
  }
  // COMMIT has already succeeded. Notification failure must not report a
  // rolled-back batch or re-enter the protected saver after a successful INSERT.
  cacheDataChanged(result.created);
  try {
    await notifySqliteSnapshotDirty(permit);
  } catch {
    console.warn('SQLITE_SNAPSHOT_DIRTY_NOTIFICATION_FAILED');
  }
  return result;
}
