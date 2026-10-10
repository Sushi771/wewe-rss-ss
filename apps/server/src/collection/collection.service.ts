import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { load } from 'cheerio';
import {
  canonicalArticleUrl,
  parseCsv,
  parsePublishTime,
  readMetrics,
  mergeMetrics,
  Metrics,
} from './collection-format';
import { resolvePublicArticle } from './public-album';
import {
  archiveProviderImages,
  supplementSavedBodyImages,
} from './archive-provider-images';
import { decodeInlineImage } from './image-fetch';
import { fetchMp2RssRecent20 } from './mp2rss';
import { publicAlbumProvider, wechat2RssProvider } from './provider-registry';
import { createVerifiedSqliteBackup } from './sqlite-backup';
import { assertProviderPage, ProviderPage } from './subscription-provider';
import {
  readOwnerSearchConfig,
  fetchLiveOwnerArticles,
  OwnerUpdateStopped,
} from './owner-search-update';
import { prepareSearchReplay } from './search-replay';
import { prepareBrowserDomReplay } from './browser-dom-adapter';
import { fetchOwnerWereadLatest } from './owner-weread-latest';
import {
  continueVerifiedWereadCandidate,
  VerifiedWereadPublisherCandidate,
} from './weread-publisher-validation';
import { prepareWereadDirectoryReplay } from './weread-directory';
import {
  assertSavedArticleIdentity,
  bodyRetryTarget,
  bodyRetryFailure,
  bodyRetryMessages,
  BodyRetryResult,
  BodyRetryBlockedError,
  fetchArticleBody,
} from './article-body-retry';

type CollectedArticle = ReturnType<typeof canonicalArticleUrl> & {
  title: string;
  publishTime: number;
  metrics: Metrics;
  contentHtml?: string;
};
type ImportInput = { directory: string; mpId?: string; mpName?: string };

@Injectable()
export class CollectionService {
  constructor(private readonly prisma: PrismaService) {}

  private readonly publicCollections = new Set<string>();

  /** Saved official directory/body samples, isolated SQLite rehearsal only.
   * No live source binding, deletions, or advancement of refresh success time.
   */
  async replayWereadDirectory(
    mpId: string,
    replay: ReturnType<typeof prepareWereadDirectoryReplay>,
  ) {
    const raw = process.env.DATABASE_URL || '';
    if (!raw.startsWith('file:') || !path.isAbsolute(raw.slice(5)))
      throw new Error('WEREAD_REPLAY_REQUIRES_ISOLATED_SQLITE');
    const database = await fs.realpath(raw.slice(5));
    const marker = JSON.parse(
      await fs.readFile(database + '.weread-directory-replay.json', 'utf8'),
    );
    if (
      marker.mode !== 'saved-weread-directory' ||
      (await fs.realpath(marker.sourceDatabase)).toLowerCase() ===
        database.toLowerCase()
    )
      throw new Error('WEREAD_REPLAY_REQUIRES_ISOLATED_SQLITE');
    const page = assertProviderPage(replay.page, mpId);
    if (
      replay.discovery !== 'saved-weread-directory' ||
      replay.networkRequests !== 0 ||
      !page.articles.length ||
      page.bodyMissing !== 0 ||
      page.imageBlocked !== 0 ||
      replay.verified.length !== page.articles.length ||
      page.articles.some(
        (article, index) =>
          JSON.stringify(article) !==
          JSON.stringify(replay.verified[index].article),
      )
    )
      throw new Error('WEREAD_REPLAY_PROVENANCE_INVALID');
    if (this.publicCollections.has(mpId)) throw new Error('该公众号正在更新');
    this.publicCollections.add(mpId);
    try {
      // Offline cache binding already supplied inline bytes; reuse the original
      // image archive/limits before persistence, without permitting cache misses.
      if (
        page.articles.some((article) =>
          load(article.contentHtml || '')('img')
            .toArray()
            .some((image) => !(image.attribs.src || '').startsWith('data:')),
        )
      )
        throw new Error('WEREAD_REPLAY_IMAGE_CACHE_MISSING');
      await archiveProviderImages(page, { stopOnFailure: true });
      await createVerifiedSqliteBackup();
      const saved = await this.saveVerifiedSearchPage(mpId, page, false);
      return {
        mode: 'saved-weread-directory' as const,
        ...saved,
        articles: page.articles.length,
        unverifiedCandidates: replay.unverified.length,
        latestWindowReady: replay.latestWindowReady,
        complete: false as const,
        productionSourceEnabled: false as const,
      };
    } finally {
      this.publicCollections.delete(mpId);
    }
  }

  /** Offline rehearsal only. No production source binding or feed success time.
   * Live updates use a separate network adapter and the same protected persistence.
   */
  async replayVerifiedSearch(
    mpId: string,
    replay: Awaited<ReturnType<typeof prepareSearchReplay>>,
  ) {
    const raw = process.env.DATABASE_URL || '';
    if (!raw.startsWith('file:') || !path.isAbsolute(raw.slice(5)))
      throw new Error('SEARCH_REPLAY_REQUIRES_ISOLATED_SQLITE');
    const database = await fs.realpath(raw.slice(5));
    const marker = JSON.parse(
      await fs.readFile(database + '.search-replay.json', 'utf8'),
    );
    if (
      marker.mode !== 'real-response-replay' ||
      (await fs.realpath(marker.sourceDatabase)).toLowerCase() ===
        database.toLowerCase()
    )
      throw new Error('SEARCH_REPLAY_REQUIRES_ISOLATED_SQLITE');
    if (this.publicCollections.has(mpId)) throw new Error('该公众号正在更新');
    this.publicCollections.add(mpId);
    try {
      const page = assertProviderPage(replay.page, mpId);
      if (
        replay.discovery !== 'real-response-replay' ||
        replay.originalNetworkRequests !== 0 ||
        replay.imageNetworkRequests !== 0 ||
        replay.verified.length !== page.articles.length ||
        page.articles.some(
          (item, index) =>
            JSON.stringify(item) !==
            JSON.stringify(replay.verified[index].article),
        )
      )
        throw new Error('SEARCH_REPLAY_PROVENANCE_INVALID');
      await createVerifiedSqliteBackup();
      const { created, updated } = await this.saveVerifiedSearchPage(
        mpId,
        page,
      );
      return {
        mode: 'real-response-replay' as const,
        created,
        updated,
        articles: page.articles.length,
        unverifiedCandidates: replay.unverified.length,
        coverage: 'search-results' as const,
        complete: false as const,
        productionSourceEnabled: false as const,
      };
    } finally {
      this.publicCollections.delete(mpId);
    }
  }

  /** Offline browser-assisted update slice. No production writes, no Tencent requests.
   * Inserts genuine owner-confirmed browser-DOM evidence into an isolated SQLite copy.
   */
  async replayBrowserDomUpdate(
    mpId: string,
    replay: ReturnType<typeof prepareBrowserDomReplay>,
  ) {
    const raw = process.env.DATABASE_URL || '';
    if (!raw.startsWith('file:') || !path.isAbsolute(raw.slice(5)))
      throw new Error('BROWSER_DOM_REPLAY_REQUIRES_ISOLATED_SQLITE');
    const database = await fs.realpath(raw.slice(5));
    let marker: { mode: string; sourceDatabase: string } | null = null;
    for (const suffix of ['.browser-dom-replay.json', '.search-replay.json']) {
      try {
        marker = JSON.parse(await fs.readFile(database + suffix, 'utf8'));
        break;
      } catch {}
    }
    if (
      !marker ||
      !['owner-confirmed-browser-dom', 'real-response-replay'].includes(
        marker.mode,
      ) ||
      (await fs.realpath(marker.sourceDatabase)).toLowerCase() ===
        database.toLowerCase()
    )
      throw new Error('BROWSER_DOM_REPLAY_REQUIRES_ISOLATED_SQLITE');
    if (this.publicCollections.has(mpId)) throw new Error('该公众号正在更新');
    this.publicCollections.add(mpId);
    try {
      const page = assertProviderPage(replay.page, mpId);
      if (
        replay.discovery !== 'owner-confirmed-browser-dom' ||
        replay.networkRequests !== 0 ||
        replay.verified.article.id !== page.articles[0]?.id
      )
        throw new Error('BROWSER_DOM_REPLAY_PROVENANCE_INVALID');
      await createVerifiedSqliteBackup();
      const { created, updated } = await this.saveVerifiedSearchPage(
        mpId,
        page,
        false, // Keep syncTime and updateTime untouched in offline rehearsal
      );
      return {
        mode: 'owner-confirmed-browser-dom' as const,
        created,
        updated,
        articles: page.articles.length,
        unarchivedImages: replay.unarchivedImages,
        offlineImagesReady: replay.unarchivedImages === 0,
        coverage: page.coverage,
        complete: false as const,
        productionSourceEnabled: false as const,
      };
    } finally {
      this.publicCollections.delete(mpId);
    }
  }

  /** One-time, explicitly invoked backfill of independently verified cached
   * originals. It does not change feed sync time or enable a live source.
   * The expected one-row insert is enforced inside the save transaction.
   */
  async importVerifiedSearchBackfill(
    mpId: string,
    replay: Awaited<ReturnType<typeof prepareSearchReplay>>,
  ) {
    const page = assertProviderPage(replay.page, mpId);
    if (
      replay.discovery !== 'real-response-replay' ||
      replay.originalNetworkRequests !== 0 ||
      replay.imageNetworkRequests !== 0 ||
      replay.verified.length !== page.articles.length ||
      page.articles.some(
        (item, index) =>
          JSON.stringify(item) !==
          JSON.stringify(replay.verified[index].article),
      )
    )
      throw new Error('SEARCH_BACKFILL_PROVENANCE_INVALID');
    if (this.publicCollections.has(mpId)) throw new Error('该公众号正在更新');
    this.publicCollections.add(mpId);
    try {
      await createVerifiedSqliteBackup();
      const { created, updated } = await this.saveVerifiedSearchPage(
        mpId,
        page,
        false,
        { created: 1, updated: 0 },
      );
      return {
        mode: 'verified-cache-backfill' as const,
        created,
        updated,
        articles: page.articles.length,
        coverage: 'search-results' as const,
        complete: false as const,
        productionSourceEnabled: false as const,
      };
    } finally {
      this.publicCollections.delete(mpId);
    }
  }

  /** Shared identity-preserving persistence; callers prove live or offline provenance. */
  private async saveVerifiedSearchPage(
    mpId: string,
    page: ProviderPage,
    advanceSync = false,
    expected?: { created: number; updated: number },
  ) {
    let created = 0,
      updated = 0;
    await this.prisma.$transaction(
      async (tx) => {
        const currentFeed = await tx.feed.findUniqueOrThrow({
          where: { id: mpId },
        });
        for (const item of page.articles) {
          const identity = canonicalArticleUrl(item.url);
          const base = new URL(identity.url);
          base.searchParams.delete('sn');
          const matches = await tx.article.findMany({
            where: {
              mpId,
              OR: [
                { id: item.id },
                ...(item.shortUrl
                  ? [
                      { id: item.shortUrl.split('/').at(-1)! },
                      { sourceUrl: item.shortUrl },
                      { verifiedSourceUrl: item.shortUrl },
                    ]
                  : []),
                { sourceUrl: base.toString() },
                { sourceUrl: { startsWith: base.toString() + '&sn=' } },
                { verifiedSourceUrl: base.toString() },
                {
                  verifiedSourceUrl: { startsWith: base.toString() + '&sn=' },
                },
              ],
            },
          });
          if (matches.length > 1)
            throw new Error('SEARCH_REPLAY_AMBIGUOUS_OLD_ID');
          const existing = matches[0];
          if (existing) {
            assertSavedArticleIdentity(existing, {
              ...identity,
              ...(item.shortUrl ? { shortUrl: item.shortUrl } : {}),
            });
            // Search gets no album-specific 60-second relaxation. Every old
            // title, trusted time and known signature must remain consistent.
            if (
              existing.publishTime !== item.publishTime ||
              existing.title.normalize('NFKC').replace(/\s+/gu, '') !==
                item.title.normalize('NFKC').replace(/\s+/gu, '')
            )
              throw new Error('SEARCH_REPLAY_SAVED_METADATA_CONFLICT');
            for (const url of [
              existing.sourceUrl,
              existing.verifiedSourceUrl,
            ]) {
              if (
                url &&
                new URL(url).pathname === '/s' &&
                canonicalArticleUrl(url).url !== item.url
              )
                throw new Error('SEARCH_REPLAY_SAVED_SIGNATURE_CONFLICT');
            }
            const supplemented = existing.contentHtml
              ? supplementSavedBodyImages(existing.contentHtml, item)
              : undefined;
            const data = {
              ...(!existing.sourceUrl ? { sourceUrl: item.url } : {}),
              ...(!existing.verifiedSourceUrl
                ? { verifiedSourceUrl: item.url }
                : {}),
              ...(!existing.contentHtml && item.contentHtml
                ? {
                    contentHtml: item.contentHtml,
                    lastBodyStatus: 'available',
                  }
                : {}),
              ...(supplemented ? { contentHtml: supplemented } : {}),
            };
            if (Object.keys(data).length) {
              await tx.article.update({ where: { id: existing.id }, data });
              updated++;
            }
          } else {
            // A title collision with an opaque legacy ID cannot be merged or
            // duplicated without independent identity evidence.
            if (
              await tx.article.findFirst({
                where: {
                  mpId,
                  title: item.title,
                  sourceUrl: null,
                  verifiedSourceUrl: null,
                },
              })
            )
              throw new Error('SEARCH_REPLAY_UNRESOLVED_LEGACY_ID');
            await tx.article.create({
              data: {
                id: item.id,
                mpId,
                title: item.title,
                publishTime: item.publishTime,
                sourceUrl: item.url,
                verifiedSourceUrl: item.url,
                contentHtml: item.contentHtml,
                picUrl: item.picUrl,
                lastBodyStatus: 'available',
              },
            });
            created++;
          }
        }
        if (
          expected &&
          (created !== expected.created || updated !== expected.updated)
        )
          throw new Error('SEARCH_BACKFILL_UNEXPECTED_WRITE_SET');
        if (advanceSync && page.articles.length) {
          await tx.feed.update({
            where: { id: mpId },
            data: {
              syncTime: Math.floor(Date.now() / 1000),
              updateTime: Math.max(
                currentFeed.updateTime,
                ...page.articles.map((item) => item.publishTime),
              ),
            },
          });
        }
      },
      { timeout: 60000 },
    );
    return { created, updated };
  }

  async collectOwnerSearch(mpId: string) {
    if (this.publicCollections.has(mpId)) throw new Error('该公众号正在更新');
    this.publicCollections.add(mpId);
    try {
      const config = await readOwnerSearchConfig(mpId);
      // Preflight retains the existing platform stop before even searching.
      const page = await fetchLiveOwnerArticles(config);
      await createVerifiedSqliteBackup();
      const saved = await this.saveVerifiedSearchPage(mpId, page, true);
      return {
        source: 'owner-web-search' as const,
        status: 'partial' as const,
        complete: false as const,
        coverage: 'search-results' as const,
        articles: page.articles.length,
        ...saved,
        pages: page.pages,
        message: `腾讯号名搜索：取得正文 ${page.articles.length} 篇，新增 ${saved.created}、补全 ${saved.updated}。搜索结果可能漏文；本轮未发现不代表公众号没有更新。`,
      };
    } catch (error) {
      if (!(error instanceof OwnerUpdateStopped)) throw error;
      return {
        source: 'owner-web-search' as const,
        status: 'blocked' as const,
        complete: false as const,
        coverage: 'search-results' as const,
        articles: 0,
        message: error.message,
      };
    } finally {
      this.publicCollections.delete(mpId);
    }
  }

  /** Server-only continuation of a success-bound new publisher. Reuses its
   * actual first directory and the original backup/identity-preserving saver.
   * An opaque result is required; raw client ProviderPages cannot enter here.
   */
  async collectVerifiedWereadCandidate(
    result: VerifiedWereadPublisherCandidate,
  ) {
    const mpId = result.candidate.mpId;
    if (this.publicCollections.has(mpId)) throw new Error('该公众号正在更新');
    this.publicCollections.add(mpId);
    try {
      const feed = await this.prisma.feed.findUniqueOrThrow({
        where: { id: mpId },
      });
      if (
        feed.collectionChannel !== 'owner-weread-latest' ||
        feed.mpName.normalize('NFKC').replace(/\s+/gu, '') !==
          result.candidate.name.normalize('NFKC').replace(/\s+/gu, '')
      )
        throw new Error('候选公众号尚未成功绑定或订阅身份已变化。');
      const page = await continueVerifiedWereadCandidate(result);
      await createVerifiedSqliteBackup();
      const saved = await this.saveVerifiedSearchPage(mpId, page, true);
      return {
        source: 'owner-weread-latest' as const,
        status: 'partial' as const,
        complete: false as const,
        coverage: 'recent-window' as const,
        articles: page.articles.length,
        ...saved,
        message: `最近10篇正文及图片已保存：新增 ${saved.created}、补全 ${saved.updated}；旧文章与正文保留。`,
      };
    } finally {
      this.publicCollections.delete(mpId);
    }
  }

  async collectOwnerWereadLatest(
    mpId: string,
    trigger: 'local-manual' | 'scheduled' | 'public' = 'public',
  ) {
    if (this.publicCollections.has(mpId)) throw new Error('该公众号正在更新');
    this.publicCollections.add(mpId);
    try {
      const config = await readOwnerSearchConfig(mpId);
      const page = await fetchOwnerWereadLatest(config, trigger);
      await createVerifiedSqliteBackup();
      const saved = await this.saveVerifiedSearchPage(mpId, page, true);
      return {
        source: 'owner-weread-latest' as const,
        status: 'partial' as const,
        complete: false as const,
        coverage: 'recent-window' as const,
        articles: page.articles.length,
        ...saved,
        message:
          config.wereadDirectoryEnabled === true
            ? `最近10篇正文及图片已保存：新增 ${saved.created}、补全 ${saved.updated}；旧文章与正文保留。`
            : `腾讯读书当前提供的1篇：取得正文，新增 ${saved.created}、补全 ${saved.updated}。文章列表接口受限；此来源只返回读书提供的一篇，不代表微信最新文章齐全。`,
      };
    } catch (e) {
      if (!(e instanceof OwnerUpdateStopped)) throw e;
      return {
        source: 'owner-weread-latest' as const,
        status: 'blocked' as const,
        complete: false as const,
        coverage: 'recent-window' as const,
        articles: 0,
        message: e.message,
      };
    } finally {
      this.publicCollections.delete(mpId);
    }
  }

  async collectWechat2RssRecent(input: {
    mpId: string;
    mpName: string;
    trigger: 'local-manual' | 'scheduled' | 'public';
    /** Internal, receipt-proved cache path; never accepted from public input. */
    acceptedFeedPath?: string;
    listOnly?: boolean;
  }) {
    if (this.publicCollections.has(input.mpId))
      throw new Error('该公众号正在更新，请等待本次结束');
    this.publicCollections.add(input.mpId);
    try {
      const feed = await this.prisma.feed.findUniqueOrThrow({
        where: { id: input.mpId },
      });
      if (feed.mpName !== input.mpName)
        throw new Error('订阅名称已变化，本次未写入');
      const provider = wechat2RssProvider();
      const account = await provider.checkAccountStatus();
      if (!account.available) {
        return {
          source: 'wechat2rss' as const,
          status: 'blocked' as const,
          complete: false as const,
          coverage: 'none' as const,
          articles: 0,
          created: 0,
          updated: 0,
          message: account.challenged
            ? '上游账号受限，等待本人在私有实例处理；本次未读取文章。'
            : '私有实例没有可用登录账号；本次未读取文章。',
        };
      }
      // All ordinary refreshes only consume cache. /addurl is reserved for an
      // explicit new-subscription action; /add also updates already subscribed feeds.
      const accepted = false;
      const fetched = input.acceptedFeedPath
        ? await provider.fetchAcceptedArticles(
            input.acceptedFeedPath,
            input.mpId,
          )
        : await provider.fetchArticles(input.mpId, input.mpName);
      if (
        !fetched ||
        !Array.isArray(fetched.articles) ||
        fetched.articles.length > 1000
      )
        throw new Error('PROVIDER_PAGE_INVALID');
      // The storage contract accepts only canonical HTTPS URLs. Normalize
      // upstream parameter order before validating IDs and saving any article.
      const normalized = {
        ...fetched,
        articles: fetched.articles.map((item) => {
          try {
            if (new URL(item.url).protocol !== 'https:') throw new Error();
            return { ...item, url: canonicalArticleUrl(item.url).url };
          } catch {
            throw new Error('PROVIDER_ARTICLE_IDENTITY_INVALID');
          }
        }),
      };
      const validated = assertProviderPage(normalized, input.mpId);
      // The first visible list contains real identities/times, with no false body
      // readiness. Full body/image archiving follows in the durable task.
      const page = input.listOnly
        ? {
            ...validated,
            articles: validated.articles.map((item) => ({
              ...item,
              contentHtml: null,
              picUrl: '',
            })),
            bodyMissing: validated.articles.length,
          }
        : await archiveProviderImages(validated);
      if (!page.articles.length) {
        return {
          source: 'wechat2rss' as const,
          status: 'pending' as const,
          complete: false as const,
          coverage: 'none' as const,
          articles: 0,
          created: 0,
          updated: 0,
          accepted,
          message:
            '订阅已保留，当前缓存尚无可核验文章；稍后使用更新读取缓存，本次未提交上游更新。',
        };
      }
      let created = 0;
      let updated = 0;
      await this.prisma.$transaction(
        async (tx) => {
          for (const item of page.articles) {
            // Title and time only detect a possible legacy collision; never merge by them.
            // Normalize the new URL before matching old short-ID rows. The sn
            // signature may change while biz/mid/idx still name the same article.
            const identity = canonicalArticleUrl(item.url);
            const sourceWithoutSn = new URL(identity.url);
            sourceWithoutSn.searchParams.delete('sn');
            const sourceBase = sourceWithoutSn.toString();
            const sourceWithSn = `${sourceBase}&sn=`;
            const matches = await tx.article.findMany({
              where: {
                OR: [
                  { id: item.id },
                  { sourceUrl: sourceBase },
                  { sourceUrl: { startsWith: sourceWithSn } },
                  { verifiedSourceUrl: sourceBase },
                  { verifiedSourceUrl: { startsWith: sourceWithSn } },
                ],
              },
            });
            if (matches.length > 1)
              throw new Error('原文身份对应多条旧记录，本批未写入');
            const existing = matches[0];
            if (existing) assertSavedArticleIdentity(existing, identity);
            if (!existing) {
              const possibleLegacy = await tx.article.findFirst({
                where: {
                  mpId: input.mpId,
                  title: item.title,
                  publishTime: item.publishTime,
                },
              });
              if (possibleLegacy)
                throw new Error('疑似旧短链身份未核实，本批未写入');
              await tx.article.create({
                data: {
                  id: item.id,
                  mpId: input.mpId,
                  title: item.title,
                  publishTime: item.publishTime,
                  sourceUrl: identity.url,
                  verifiedSourceUrl: identity.url,
                  contentHtml: item.contentHtml,
                  picUrl: item.picUrl,
                  lastBodyStatus: item.contentHtml
                    ? 'available'
                    : 'unavailable',
                },
              });
              created++;
            } else {
              const supplemented = existing.contentHtml
                ? supplementSavedBodyImages(existing.contentHtml, item)
                : undefined;
              const data = {
                ...(!existing.sourceUrl ? { sourceUrl: identity.url } : {}),
                ...(!existing.verifiedSourceUrl
                  ? { verifiedSourceUrl: identity.url }
                  : {}),
                ...(!existing.contentHtml && item.contentHtml
                  ? { contentHtml: item.contentHtml }
                  : {}),
                ...(supplemented ? { contentHtml: supplemented } : {}),
                ...(!existing.picUrl && item.picUrl
                  ? { picUrl: item.picUrl }
                  : {}),
                ...(!existing.contentHtml && item.contentHtml
                  ? { lastBodyStatus: 'available' }
                  : {}),
              };
              if (Object.keys(data).length) {
                await tx.article.update({ where: { id: existing.id }, data });
                updated++;
              }
            }
          }
          const latest = await tx.article.aggregate({
            where: { mpId: input.mpId },
            _max: { publishTime: true },
          });
          await tx.feed.update({
            where: { id: input.mpId },
            data: {
              collectionChannel: 'wechat2rss',
              ...(input.listOnly
                ? {}
                : { syncTime: Math.floor(Date.now() / 1000) }),
              updateTime: latest._max.publishTime || feed.updateTime,
              hasHistory: -1,
            },
          });
        },
        { timeout: 60000 },
      );
      return {
        source: 'wechat2rss' as const,
        status: 'partial' as const,
        complete: false as const,
        coverage: page.coverage,
        articles: page.articles.length,
        created,
        updated,
        accepted,
        bodyMissing: page.bodyMissing,
        listReady: page.articles.length > 0,
        bodyReady:
          !input.listOnly && page.bodyMissing === 0 && page.imageBlocked === 0,
        imageBlocked: page.imageBlocked,
        message:
          `读取私有实例缓存 ${page.articles.length} 篇，归档新增 ${created}、补全 ${updated}。` +
          (accepted ? '上游新任务仍可能进行中。' : '') +
          ` 正文缺失 ${page.bodyMissing}，图片受限 ${page.imageBlocked}；订阅前历史与非群发不保证覆盖。`,
      };
    } finally {
      this.publicCollections.delete(input.mpId);
    }
  }

  async retryArticleBody(id: string): Promise<BodyRetryResult> {
    const initial = await this.prisma.article.findUniqueOrThrow({
      where: { id },
    });
    if (this.publicCollections.has(initial.mpId))
      throw new BodyRetryBlockedError(
        '该公众号正在采集或重试正文，请等待本次结束',
      );
    this.publicCollections.add(initial.mpId);
    try {
      bodyRetryTarget(initial);
      // 失败状态也属于写入；备份失败时没有网络请求或数据库变化。
      try {
        await createVerifiedSqliteBackup();
      } catch {
        throw new BodyRetryBlockedError(
          '一致性备份失败，本次未请求原文或写入状态。',
        );
      }
      const article = await this.prisma.article.findUniqueOrThrow({
        where: { id },
      });
      if (article.mpId !== initial.mpId)
        throw new BodyRetryBlockedError('文章所属订阅已变更，请重新读取文章。');
      bodyRetryTarget(article);
      const attemptedAt = Math.floor(Date.now() / 1000);
      const unchangedIdentity = (current: typeof article) => {
        if (
          [
            'mpId',
            'title',
            'publishTime',
            'sourceUrl',
            'verifiedSourceUrl',
          ].some((key) => current[key] !== article[key])
        )
          throw new BodyRetryBlockedError(
            '文章信息在重试期间已变更，请重新读取文章。',
          );
      };
      try {
        const fetched = await fetchArticleBody(article);
        return await this.prisma.$transaction(async (tx) => {
          const current = await tx.article.findUniqueOrThrow({ where: { id } });
          unchangedIdentity(current);
          const status = fetched.contentHtml ? 'available' : 'unavailable';
          const result: BodyRetryResult = {
            status,
            code: status,
            attemptedAt,
            cached: Boolean(current.contentHtml || fetched.contentHtml),
            filled: Boolean(!current.contentHtml && fetched.contentHtml),
            message: bodyRetryMessages[status],
          };
          await tx.article.update({
            where: { id },
            data: {
              lastBodyStatus: status,
              // Only the identity-checked original ct may replace an
              // unverified album list timestamp.
              ...(!current.verifiedSourceUrl &&
              current.publishTime !== fetched.originalPublishTime
                ? { publishTime: fetched.originalPublishTime }
                : {}),
              verifiedSourceUrl:
                current.verifiedSourceUrl || fetched.verifiedSourceUrl,
              lastBodyRetry: JSON.stringify(result),
              ...(!current.contentHtml && fetched.contentHtml
                ? { contentHtml: fetched.contentHtml }
                : {}),
            },
          });
          return result;
        });
      } catch (error) {
        const code = bodyRetryFailure(error);
        // 不持久化 HTTP/数据库错误原文，避免带出请求参数或正文。
        return await this.prisma.$transaction(async (tx) => {
          const current = await tx.article.findUniqueOrThrow({ where: { id } });
          unchangedIdentity(current);
          const result: BodyRetryResult = {
            status: 'failed',
            code,
            attemptedAt,
            cached: Boolean(current.contentHtml),
            filled: false,
            message: bodyRetryMessages[code],
          };
          await tx.article.update({
            where: { id },
            data: { lastBodyRetry: JSON.stringify(result) },
          });
          return result;
        });
      }
    } finally {
      this.publicCollections.delete(initial.mpId);
    }
  }

  async collectMp2RssRecent20(input: { mpId: string; mpName: string }) {
    if (this.publicCollections.has(input.mpId))
      throw new Error('该公众号正在更新，请等待本次结束');
    this.publicCollections.add(input.mpId);
    try {
      const feed = await this.prisma.feed.findUniqueOrThrow({
        where: { id: input.mpId },
      });
      if (feed.mpName !== input.mpName)
        throw new Error('订阅号名称已变化，本次未写入文章');
      // The complete upstream page and all original identities are checked before a write.
      const articles = await fetchMp2RssRecent20(input.mpId, input.mpName);
      let created = 0;
      let updated = 0;
      await this.prisma.$transaction(
        async (tx) => {
          for (const item of articles) {
            const baseUrl = item.url.split('&sn=')[0];
            const matches = await tx.article.findMany({
              where: {
                mpId: input.mpId,
                OR: [
                  { id: item.id },
                  ...(item.shortUrl
                    ? [{ id: item.shortUrl.split('/').at(-1)! }]
                    : []),
                  ...(item.shortUrl ? [{ sourceUrl: item.shortUrl }] : []),
                  { sourceUrl: item.url },
                  { sourceUrl: baseUrl },
                  { sourceUrl: { startsWith: `${baseUrl}&sn=` } },
                  { verifiedSourceUrl: baseUrl },
                  { verifiedSourceUrl: { startsWith: `${baseUrl}&sn=` } },
                ],
              },
            });
            if (matches.length > 1)
              throw new Error('同一原文对应多条旧记录，本次未写入文章');
            const existing = matches[0];
            if (existing)
              assertSavedArticleIdentity(existing, {
                ...item,
                shortUrl: item.shortUrl || undefined,
              });
            if (existing) {
              const data = {
                title: item.title,
                publishTime: item.publishTime!,
                verifiedSourceUrl: existing.verifiedSourceUrl || item.url,
                lastBodyStatus: item.contentHtml ? 'available' : 'unavailable',
                ...(existing.sourceUrl
                  ? {}
                  : { sourceUrl: item.shortUrl || item.url }),
                ...(existing.picUrl ? {} : { picUrl: item.picUrl }),
                ...(existing.contentHtml
                  ? {}
                  : { contentHtml: item.contentHtml }),
              };
              if (
                existing.title !== data.title ||
                existing.publishTime !== data.publishTime ||
                !existing.verifiedSourceUrl ||
                (!existing.sourceUrl && data.sourceUrl) ||
                (!existing.picUrl && item.picUrl) ||
                (!existing.contentHtml && item.contentHtml) ||
                existing.lastBodyStatus !== data.lastBodyStatus
              ) {
                await tx.article.update({ where: { id: existing.id }, data });
                updated++;
              }
            } else {
              await tx.article.create({
                data: {
                  id: item.id,
                  mpId: input.mpId,
                  title: item.title,
                  publishTime: item.publishTime!,
                  sourceUrl: item.shortUrl || item.url,
                  verifiedSourceUrl: item.url,
                  picUrl: item.picUrl,
                  contentHtml: item.contentHtml,
                  lastBodyStatus: item.contentHtml
                    ? 'available'
                    : 'unavailable',
                },
              });
              created++;
            }
          }
          const latest = await tx.article.aggregate({
            where: { mpId: input.mpId },
            _max: { publishTime: true },
          });
          await tx.feed.update({
            where: { id: input.mpId },
            data: {
              collectionChannel: 'mp2rss',
              syncTime: Math.floor(Date.now() / 1000),
              updateTime: latest._max.publishTime || 0,
              hasHistory: -1,
            },
          });
        },
        { timeout: 60000 },
      );
      return {
        source: 'mp2rss' as const,
        status: 'partial' as const,
        complete: false as const,
        coverage: 'provider-recent-20' as const,
        articles: articles.length,
        created,
        updated,
        hasHistory: -1,
        message: `后台来源取得并核验 ${articles.length} 篇（新增 ${created}，更新 ${updated}）。Mp2RSS 首次订阅不回补历史；更早文章、收录延迟和其他内容类型覆盖仍需实测。`,
      };
    } finally {
      this.publicCollections.delete(input.mpId);
    }
  }

  async collectPublicAlbums(input: { mpId: string; albumIds: string[] }) {
    if (this.publicCollections.has(input.mpId))
      throw new Error('该公众号正在采集公开合集，请等待本次结束');
    this.publicCollections.add(input.mpId);
    try {
      await this.prisma.feed.findUniqueOrThrow({ where: { id: input.mpId } });
      const result = await publicAlbumProvider(
        input.mpId,
        input.albumIds,
      ).fetchArticles(input.mpId);
      const saved = await this.prisma.article.findMany({
        where: { mpId: input.mpId },
      });
      const legacy = new Map<string, (typeof saved)[number]>();
      const verifiedLegacy = new Set<string>();
      // Titles only identify candidates; resolve a real original before reusing an old ID.
      for (const candidate of saved.filter(
        (old) =>
          !old.sourceUrl &&
          !old.verifiedSourceUrl &&
          result.articles.some((item) => item.title === old.title),
      )) {
        const identity = await resolvePublicArticle(candidate.id, input.mpId);
        if (!result.articles.some((item) => item.id === identity.id)) continue;
        if (legacy.has(identity.id))
          throw new Error('多条旧记录指向同一原文，本批未写入');
        legacy.set(identity.id, candidate);
        if (
          identity.publishTime &&
          identity.url ===
            result.articles.find((item) => item.id === identity.id)?.url
        )
          verifiedLegacy.add(identity.id);
      }
      const matchesFor = (item: (typeof result.articles)[number]) =>
        saved.filter((old) => {
          if (old.id === item.id || old.id === legacy.get(item.id)?.id)
            return true;
          return [old.sourceUrl, old.verifiedSourceUrl].some((url) => {
            if (!url) return false;
            try {
              return canonicalArticleUrl(url).id === item.id;
            } catch {
              return false;
            }
          });
        });
      let succeeded = 0,
        retained = 0,
        available = 0,
        bodyBytes = 0;
      const prepared: Array<{
        item: (typeof result.articles)[number];
        existingId?: string;
        verified: boolean;
        originalPublishTime?: number;
        listPublishTime: number;
        correctPublishTime: boolean;
      }> = [];
      for (const article of result.articles) {
        const matches = matchesFor(article);
        if (matches.length > 1)
          throw new Error('原文身份对应多条旧记录，需先核对；本批未写入');
        const existing = matches[0];
        const identity = canonicalArticleUrl(article.url);
        if (existing) assertSavedArticleIdentity(existing, identity);
        // Any cached body is protected. Repeated updates never re-fetch it or overwrite it.
        let item = article;
        let verified = Boolean(existing?.verifiedSourceUrl);
        let originalPublishTime: number | undefined;
        let correctPublishTime = false;
        if (existing?.contentHtml) {
          retained++;
          const $ = load(existing.contentHtml);
          if (
            !$('img')
              .toArray()
              .some((img) => {
                try {
                  decodeInlineImage($(img).attr('src') || '');
                  return false;
                } catch {
                  return true;
                }
              })
          )
            available++;
          verified ||= verifiedLegacy.has(article.id);
        } else {
          if (
            !existing &&
            saved.some(
              (old) =>
                old.title === article.title &&
                old.publishTime === article.publishTime,
            )
          )
            throw new Error('疑似旧短链身份未核实，本批未写入');
          // ct is read from the original; list create_time is never promoted to a verified date.
          let body: Awaited<ReturnType<typeof fetchArticleBody>>;
          try {
            body = await fetchArticleBody(
              {
                id: existing?.id || article.id,
                mpId: input.mpId,
                title: existing?.title || article.title,
                publishTime: existing?.publishTime || article.publishTime,
                sourceUrl: article.url,
                verifiedSourceUrl: existing?.verifiedSourceUrl || null,
              },
              article.requestUrl,
            );
          } catch {
            throw new Error(
              '公开合集原文受限或身份、发布时间不一致，已停止后续请求；本批未写入',
            );
          }
          if (!body.contentHtml)
            throw new Error(
              '公开合集原文没有可缓存正文，已停止后续请求；本批未写入',
            );
          originalPublishTime = body.originalPublishTime;
          correctPublishTime = Boolean(
            existing &&
            /^WX_\d{5,15}_\d+_[1-9]\d*$/.test(existing.id) &&
            !existing.contentHtml &&
            !existing.verifiedSourceUrl &&
            existing.publishTime === article.publishTime &&
            existing.publishTime !== originalPublishTime &&
            Math.abs(existing.publishTime - originalPublishTime) <= 60,
          );
          if (
            existing &&
            existing.publishTime !== originalPublishTime &&
            !correctPublishTime
          )
            throw new Error(
              '已存发布时间无法证明为未经核验的合集列表时间，本批未写入',
            );
          const archived = await archiveProviderImages(
            {
              ...result,
              articles: [{ ...article, contentHtml: body.contentHtml }],
              bodyMissing: 0,
              imageBlocked: 0,
            },
            { stopOnFailure: true },
          );
          item = {
            ...archived.articles[0],
            publishTime: correctPublishTime
              ? body.originalPublishTime
              : existing?.publishTime || body.originalPublishTime,
          };
          if (!item.contentHtml)
            throw new Error('公开合集正文图片未完整取得，本批未写入');
          bodyBytes += Buffer.byteLength(item.contentHtml);
          if (bodyBytes > 200 * 1024 * 1024)
            throw new Error('公开合集正文图片超过 200 MB，本批未写入');
          succeeded++;
          available++;
          verified = true;
          // Bound traffic: each next original waits after the preceding original and its images.
          if (article !== result.articles.at(-1))
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        prepared.push({
          item,
          existingId: existing?.id,
          verified,
          originalPublishTime,
          listPublishTime: article.publishTime,
          correctPublishTime,
        });
      }
      let created = 0,
        updated = 0,
        correctedPublishTimes = 0;
      // All network and identity validation finishes before any article or binding write.
      await this.prisma.$transaction(
        async (tx) => {
          for (const entry of prepared) {
            const { item, verified } = entry;
            const existing = entry.existingId
              ? await tx.article.findUniqueOrThrow({
                  where: { id: entry.existingId },
                })
              : null;
            if (existing) {
              assertSavedArticleIdentity(
                existing,
                canonicalArticleUrl(item.url),
              );
              if (
                entry.correctPublishTime &&
                (!/^WX_\d{5,15}_\d+_[1-9]\d*$/.test(existing.id) ||
                  existing.contentHtml ||
                  existing.verifiedSourceUrl ||
                  existing.publishTime !== entry.listPublishTime ||
                  !entry.originalPublishTime ||
                  Math.abs(existing.publishTime - entry.originalPublishTime) >
                    60)
              )
                throw new Error('原文时间校正条件已变化，本批未写入');
              const data = {
                ...(entry.correctPublishTime
                  ? { publishTime: entry.originalPublishTime }
                  : {}),
                ...(!existing.sourceUrl ? { sourceUrl: item.url } : {}),
                ...(!existing.verifiedSourceUrl && verified
                  ? { verifiedSourceUrl: item.url }
                  : {}),
                ...(!existing.contentHtml && item.contentHtml
                  ? {
                      contentHtml: item.contentHtml,
                      lastBodyStatus: 'available',
                    }
                  : {}),
                ...(!existing.picUrl && item.picUrl
                  ? { picUrl: item.picUrl }
                  : {}),
              };
              if (Object.keys(data).length) {
                await tx.article.update({ where: { id: existing.id }, data });
                updated++;
                if (entry.correctPublishTime) correctedPublishTimes++;
              }
            } else {
              await tx.article.create({
                data: {
                  id: item.id,
                  mpId: input.mpId,
                  title: item.title,
                  publishTime: item.publishTime,
                  picUrl: item.picUrl,
                  sourceUrl: item.url,
                  verifiedSourceUrl: verified ? item.url : null,
                  contentHtml: item.contentHtml,
                  lastBodyStatus: 'available',
                },
              });
              created++;
            }
          }
          const latest = await tx.article.aggregate({
            where: { mpId: input.mpId },
            _max: { publishTime: true },
          });
          await tx.feed.update({
            where: { id: input.mpId },
            data: {
              publicAlbumIds: JSON.stringify([...new Set(input.albumIds)]),
              collectionChannel: 'public-album',
              localDirectory: null,
              syncTime: Math.floor(Date.now() / 1000),
              updateTime: latest._max.publishTime || 0,
              hasHistory: -1,
            },
          });
        },
        { timeout: 60000 },
      );
      return {
        source: 'public-album' as const,
        status: 'partial' as const,
        complete: false as const,
        coverage: 'selected-albums' as const,
        hasHistory: -1,
        articles: result.articles.length,
        created,
        updated,
        correctedPublishTimes,
        merged: 0,
        pages: result.pages,
        albums: result.albums,
        bodyFetch: { succeeded, unavailable: 0 },
        bodyCache: {
          available,
          retained,
          missing: result.articles.length - available,
        },
        oldestPublishTime: Math.min(...prepared.map((a) => a.item.publishTime)),
        newestPublishTime: Math.max(...prepared.map((a) => a.item.publishTime)),
        message: `所选官方合集订阅读取 ${result.articles.length} 篇（新增 ${created}，补充 ${updated}），共 ${result.pages} 页；新取正文及本地图片 ${succeeded} 篇，保留旧正文 ${retained} 篇，核实并校正未验证列表时间 ${correctedPublishTimes} 篇。仅覆盖所选合集，未覆盖合集外近期文章，公众号级近期发现尚未恢复；不代表公众号全部历史；阅读、点赞、收藏未获取。`,
      };
    } finally {
      this.publicCollections.delete(input.mpId);
    }
  }

  private async scan(input: ImportInput) {
    if (!path.isAbsolute(input.directory))
      throw new Error('请输入采集目录的完整绝对路径');
    const root = await fs.realpath(input.directory.trim());
    if (!(await fs.stat(root)).isDirectory())
      throw new Error('采集路径不是目录');
    const files: { path: string; time: string }[] = [];
    let entries = 0,
      bytes = 0;
    const visit = async (dir: string, depth: number) => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (++entries > 10000)
          throw new Error('目录超过 10000 个文件，请选择单个公众号的采集目录');
        if (entry.isSymbolicLink()) continue;
        const target = path.join(dir, entry.name);
        if (entry.isDirectory() && depth < 3) await visit(target, depth + 1);
        if (entry.isFile() && /\.(csv|html?)$/i.test(entry.name)) {
          const stat = await fs.stat(target);
          bytes += stat.size;
          if (stat.size > 10 * 1024 * 1024 || bytes > 200 * 1024 * 1024)
            throw new Error(
              '单文件超过 10 MB 或本次导入超过 200 MB，请分批导入',
            );
          files.push({ path: target, time: stat.mtime.toISOString() });
        }
      }
    };
    await visit(root, 0);
    const articles = new Map<string, CollectedArticle>();
    let bodyBytes = 0;
    const warnings: string[] = [];
    let csvFiles = 0;
    for (const file of files
      .filter((f) => /\.csv$/i.test(f.path))
      .sort(
        (a, b) => a.time.localeCompare(b.time) || a.path.localeCompare(b.path),
      )) {
      const rows = parseCsv(await fs.readFile(file.path, 'utf8'));
      if (!rows.length) continue;
      const get = (row: Record<string, string>, keys: string[]) =>
        keys.map((k) => row[k]).find((v) => v !== undefined) || '';
      if (
        !['title', '标题', '文章标题'].some((k) => k in rows[0]) ||
        !['url', '链接', '文章链接'].some((k) => k in rows[0])
      ) {
        warnings.push(`忽略非文章 CSV：${path.basename(file.path)}`);
        continue;
      }
      csvFiles++;
      for (let i = 0; i < rows.length; i++) {
        try {
          const row = rows[i];
          const identity = canonicalArticleUrl(
            get(row, ['url', '链接', '文章链接']),
          );
          if (input.mpId && identity.mpId !== input.mpId) continue;
          const title = get(row, ['title', '标题', '文章标题']);
          if (!title || title.length > 1000) throw new Error('标题为空或过长');
          const article = {
            ...identity,
            title,
            publishTime: parsePublishTime(
              get(row, ['time', '发布时间', '日期']),
            ),
            metrics: mergeMetrics(
              articles.get(identity.id)?.metrics || {},
              readMetrics(row, file.time),
            ),
          };
          articles.set(identity.id, article);
          if (articles.size > 5000)
            throw new Error('单次最多导入 5000 篇，请缩小日期范围');
        } catch (err: any) {
          throw new Error(
            `${path.basename(file.path)} 第 ${i + 2} 行：${err.message}`,
          );
        }
      }
    }
    if (!articles.size)
      throw new Error(
        '未找到匹配的文章 CSV；请在 WeChatDownload 导出文章数据到此目录',
      );
    for (const file of files.filter((f) => /\.html?$/i.test(f.path))) {
      const $ = load(await fs.readFile(file.path, 'utf8'));
      const url =
        $('meta[property="og:url"]').attr('content') ||
        $('link[rel="canonical"]').attr('href');
      if (!url) continue;
      let id: string;
      try {
        id = canonicalArticleUrl(url).id;
      } catch {
        continue;
      }
      const article = articles.get(id);
      if (!article) continue;
      const content = $('#js_content').first().length
        ? $('#js_content').first()
        : $('.rich_media_content').first();
      if (
        !content.length ||
        (!content.text().trim() && !content.find('img').length)
      ) {
        warnings.push(`正文为空：${path.basename(file.path)}`);
        continue;
      }
      content
        .find(
          'script,style,iframe,object,embed,form,input,button,link,meta,svg,base',
        )
        .remove();
      const allowed = new Set([
        'href',
        'src',
        'alt',
        'title',
        'colspan',
        'rowspan',
      ]);
      for (const element of content.find('*').toArray()) {
        const node = $(element);
        const src = node.attr('src');
        const source =
          src && !/^(?:https?:|data:|\/\/)/i.test(src)
            ? src
            : node.attr('data-src') || src;
        for (const attr of Object.keys(element['attribs'] || {}))
          if (!allowed.has(attr)) node.removeAttr(attr);
        const href = node.attr('href');
        if (href && !/^https?:\/\//i.test(href)) node.removeAttr('href');
        if (element['tagName'] === 'img') {
          node.removeAttr('src');
          if (!source) continue;
          if (/^https?:\/\//i.test(source)) {
            const imageUrl = new URL(source);
            if (
              /(^|\.)(qpic\.cn|qlogo\.cn|qq\.com)$/.test(imageUrl.hostname) &&
              !imageUrl.port &&
              !imageUrl.username
            )
              node.attr('src', source);
          } else if (!/^[a-z]+:/i.test(source) && !source.startsWith('//')) {
            try {
              const local = await fs.realpath(
                path.resolve(
                  path.dirname(file.path),
                  decodeURIComponent(source.split(/[?#]/)[0]),
                ),
              );
              const relative = path.relative(root, local);
              if (relative.startsWith('..') || path.isAbsolute(relative))
                throw new Error('图片位于采集目录之外');
              const stat = await fs.stat(local);
              if (stat.size > 5 * 1024 * 1024) throw new Error('图片超过 5 MB');
              const buffer = await fs.readFile(local);
              const mime = buffer
                .subarray(0, 8)
                .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
                ? 'png'
                : buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255
                  ? 'jpeg'
                  : ['GIF87a', 'GIF89a'].includes(
                        buffer.subarray(0, 6).toString(),
                      )
                    ? 'gif'
                    : buffer.subarray(0, 4).toString() === 'RIFF' &&
                        buffer.subarray(8, 12).toString() === 'WEBP'
                      ? 'webp'
                      : '';
              if (!mime) throw new Error('不是支持的图片格式');
              node.attr(
                'src',
                `data:image/${mime};base64,${buffer.toString('base64')}`,
              );
            } catch {
              warnings.push(`本地图片未读入：${path.basename(file.path)}`);
            }
          }
        } else node.removeAttr('src');
      }
      bodyBytes -= Buffer.byteLength(article.contentHtml || '');
      article.contentHtml = `<div class="rich_media_content" id="js_content">${content.html()}</div>`;
      bodyBytes += Buffer.byteLength(article.contentHtml);
      if (bodyBytes > 200 * 1024 * 1024)
        throw new Error('正文与图片总量超过 200 MB，请分批导入');
      if (Buffer.byteLength(article.contentHtml) > 20 * 1024 * 1024)
        throw new Error('单篇正文及图片超过 20 MB，请关闭下载图片后分批采集');
    }
    const items = [...articles.values()];
    if (
      items.reduce((n, a) => n + Buffer.byteLength(a.contentHtml || ''), 0) >
      200 * 1024 * 1024
    )
      throw new Error('正文与图片总量超过 200 MB，请分批导入');
    return { root, items, csvFiles, warnings: [...new Set(warnings)] };
  }

  async preview(input: ImportInput) {
    const scan = await this.scan(input);
    const feeds = [...new Set(scan.items.map((a) => a.mpId))];
    const existing = await this.prisma.feed.findMany({
      where: { id: { in: feeds } },
      select: { id: true, mpName: true },
    });
    return {
      directory: scan.root,
      articles: scan.items.length,
      bodies: scan.items.filter((a) => a.contentHtml).length,
      csvFiles: scan.csvFiles,
      feeds: feeds.map((id) => ({
        id,
        name: existing.find((f) => f.id === id)?.mpName || input.mpName || id,
      })),
      warnings: scan.warnings,
      sample: scan.items
        .slice(0, 5)
        .map((a) => ({ title: a.title, url: a.url, metrics: a.metrics })),
    };
  }

  async importDirectory(input: ImportInput) {
    const scan = await this.scan(input);
    // A CSV title/date is not proof that a legacy short link is this article.
    // Resolve all candidates before the transaction so a challenge leaves the DB unchanged.
    const legacy = new Map<
      string,
      { id: string; publishTime: number | null }
    >();
    for (const mpId of new Set(scan.items.map((item) => item.mpId))) {
      const items = scan.items.filter((item) => item.mpId === mpId);
      const candidates = await this.prisma.article.findMany({
        where: {
          mpId,
          sourceUrl: null,
          title: { in: items.map((item) => item.title) },
        },
        select: { id: true },
      });
      for (const candidate of candidates) {
        const identity = await resolvePublicArticle(candidate.id, mpId);
        if (!items.some((item) => item.id === identity.id)) continue;
        if (legacy.has(identity.id))
          throw new Error(
            '多条旧记录指向同一原文，需要先核对重复身份；本次未写入',
          );
        legacy.set(identity.id, {
          id: candidate.id,
          publishTime: identity.publishTime,
        });
      }
    }
    let created = 0,
      updated = 0,
      merged = 0;
    await this.prisma.$transaction(
      async (tx) => {
        const ids = [...new Set(scan.items.map((a) => a.mpId))];
        const known = await tx.feed.count({ where: { id: { in: ids } } });
        if (ids.length - known > 1)
          throw new Error('本次包含多个新公众号，请按单个公众号分别导入并命名');
        for (const mpId of new Set(scan.items.map((a) => a.mpId))) {
          const existing = await tx.feed.findUnique({ where: { id: mpId } });
          if (!existing && !input.mpName?.trim())
            throw new Error(`新公众号 ${mpId} 需要填写公众号名称`);
          const maxTime = Math.max(
            ...scan.items
              .filter((a) => a.mpId === mpId)
              .map((a) => a.publishTime),
          );
          await tx.feed.upsert({
            where: { id: mpId },
            create: {
              id: mpId,
              mpName: input.mpName?.trim() || existing?.mpName || mpId,
              mpCover: '',
              mpIntro: '历史文件一次性导入',
              updateTime: maxTime,
              hasHistory: -1,
              status: 0,
            },
            update: {
              updateTime: Math.max(existing?.updateTime || 0, maxTime),
            },
          });
        }
        for (const item of scan.items) {
          const baseUrl = item.url.split('&sn=')[0];
          let existing = await tx.article.findFirst({
            where: {
              OR: [
                { id: item.id },
                { sourceUrl: baseUrl },
                { sourceUrl: { startsWith: `${baseUrl}&sn=` } },
              ],
            },
          });
          const original = legacy.get(item.id);
          if (original) {
            const old = await tx.article.findUniqueOrThrow({
              where: { id: original.id },
            });
            if (existing && existing.id !== old.id) {
              const metrics = mergeMetrics(
                JSON.parse(existing.metrics || '{}'),
                JSON.parse(old.metrics || '{}'),
              );
              const preserved = {
                ...old,
                sourceUrl: old.sourceUrl || existing.sourceUrl,
                contentHtml: old.contentHtml || existing.contentHtml,
                metrics: JSON.stringify(metrics),
                readCount:
                  metrics.read?.value ?? old.readCount ?? existing.readCount,
                likeCount:
                  metrics.like?.value ?? old.likeCount ?? existing.likeCount,
              };
              await tx.article.delete({ where: { id: existing.id } });
              existing = preserved;
              merged++;
            } else existing = old;
          }
          const metrics = mergeMetrics(
            JSON.parse(existing?.metrics || '{}'),
            item.metrics,
          );
          const data = {
            title: item.title,
            publishTime:
              original?.publishTime ??
              existing?.publishTime ??
              item.publishTime,
            sourceUrl: item.url.includes('&sn=')
              ? item.url
              : existing?.sourceUrl || item.url,
            contentHtml: item.contentHtml || existing?.contentHtml,
            metrics: JSON.stringify(metrics),
            readCount: metrics.read?.value ?? existing?.readCount ?? null,
            likeCount: metrics.like?.value ?? existing?.likeCount ?? null,
          };
          if (existing) {
            await tx.article.update({ where: { id: existing.id }, data });
            updated++;
          } else {
            await tx.article.create({
              data: { ...data, id: item.id, mpId: item.mpId, picUrl: '' },
            });
            created++;
          }
        }
      },
      { timeout: 60000 },
    );
    return {
      created,
      updated,
      merged,
      articles: scan.items.length,
      bodies: scan.items.filter((a) => a.contentHtml).length,
      warnings: scan.warnings,
      source: 'local' as const,
      status: 'partial' as const,
      complete: false as const,
      coverage: 'imported-files' as const,
      hasHistory: -1,
      message: `一次性导入 ${scan.items.length} 篇（新增 ${created}，更新 ${updated}）。仅导入所选历史文件，不代表公众号完整更新，也不绑定目录或启用定时订阅。`,
    };
  }
}
