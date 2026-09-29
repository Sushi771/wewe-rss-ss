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
import { fetchPublicAlbums, resolvePublicArticle } from './public-album';
import { archiveProviderImages } from './archive-provider-images';
import { fetchMp2RssRecent20 } from './mp2rss';
import { wechat2RssProvider } from './provider-registry';
import { createVerifiedSqliteBackup } from './sqlite-backup';
import { assertProviderPage } from './subscription-provider';
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

  async collectWechat2RssRecent(input: {
    mpId: string;
    mpName: string;
    trigger: 'local-manual' | 'scheduled' | 'public';
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
      // /add accepts an asynchronous job. Scheduled reads avoid submitting one per feed.
      const now = Math.floor(Date.now() / 1000);
      // Reserve before the HTTP call. A crash or uncertain response must not
      // submit a second asynchronous /add job immediately after restart.
      const reserved =
        input.trigger !== 'scheduled' &&
        (
          await this.prisma.feed.updateMany({
            where: {
              id: input.mpId,
              providerRefreshAttemptTime: { lte: now - 15 * 60 },
            },
            data: { providerRefreshAttemptTime: now },
          })
        ).count === 1;
      let accepted = false;
      if (reserved) {
        const result = await provider.refreshSubscription(input.mpId);
        accepted = result.accepted;
      }
      const fetched = await provider.fetchArticles(input.mpId, input.mpName);
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
      const page = await archiveProviderImages(
        assertProviderPage(normalized, input.mpId),
      );
      if (!page.articles.length) {
        return {
          source: 'wechat2rss' as const,
          status:
            accepted ||
            reserved ||
            feed.providerRefreshAttemptTime > now - 15 * 60
              ? ('pending' as const)
              : ('blocked' as const),
          complete: false as const,
          coverage: 'none' as const,
          articles: 0,
          created: 0,
          updated: 0,
          accepted,
          message: accepted
            ? '上游已受理更新任务，当前缓存还没有可核验文章；稍后读取，不代表更新成功。'
            : reserved || feed.providerRefreshAttemptTime > now - 15 * 60
              ? '上游更新请求处于冷却期，缓存尚无可核验文章；稍后只读检查。'
              : '上游缓存没有可核验文章；本次未写入。',
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
              const data = {
                ...(!existing.sourceUrl ? { sourceUrl: identity.url } : {}),
                ...(!existing.verifiedSourceUrl
                  ? { verifiedSourceUrl: identity.url }
                  : {}),
                ...(!existing.contentHtml && item.contentHtml
                  ? { contentHtml: item.contentHtml }
                  : {}),
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
              syncTime: Math.floor(Date.now() / 1000),
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
      const result = await fetchPublicAlbums(input.mpId, input.albumIds);
      // Album create_time and original ct differ by seconds. Titles only select candidates;
      // an original page's biz/mid/idx must prove identity before a legacy ID is reused.
      const candidates = await this.prisma.article.findMany({
        where: {
          mpId: input.mpId,
          sourceUrl: null,
          title: { in: result.articles.map((a) => a.title) },
        },
        select: { id: true, title: true },
      });
      const legacy = new Map<
        string,
        { id: string; publishTime: number | null }
      >();
      for (const candidate of candidates) {
        const identity = await resolvePublicArticle(candidate.id, input.mpId);
        if (!result.articles.some((item) => item.id === identity.id)) continue;
        if (legacy.has(identity.id))
          throw new Error(
            '多条旧记录指向同一原文，需要先核对重复身份；本次未写入',
          );
        legacy.set(identity.id, {
          id: candidate.id,
          publishTime: identity.publishTime,
        });
      }
      let created = 0,
        updated = 0,
        merged = 0;
      // Fetch every selected album page before writing. Partial or challenged responses never mark a successful import.
      await this.prisma.$transaction(
        async (tx) => {
          for (const item of result.articles) {
            const baseUrl = item.url.split('&sn=')[0];
            let existing = await tx.article.findFirst({
              where: {
                mpId: input.mpId,
                OR: [
                  { id: item.id },
                  { sourceUrl: baseUrl },
                  { sourceUrl: { startsWith: `${baseUrl}&sn=` } },
                ],
              },
            });
            const original = legacy.get(item.id);
            const knownSourceUrl = existing?.sourceUrl;
            let mergedFields = {};
            if (original) {
              const old = await tx.article.findUniqueOrThrow({
                where: { id: original.id },
              });
              if (existing && existing.id !== old.id) {
                const metrics = mergeMetrics(
                  JSON.parse(existing.metrics || '{}'),
                  JSON.parse(old.metrics || '{}'),
                );
                mergedFields = {
                  contentHtml: old.contentHtml || existing.contentHtml,
                  metrics: JSON.stringify(metrics),
                  readCount:
                    metrics.read?.value ?? old.readCount ?? existing.readCount,
                  likeCount:
                    metrics.like?.value ?? old.likeCount ?? existing.likeCount,
                };
                await tx.article.delete({ where: { id: existing.id } });
                merged++;
              }
              existing = old;
            }
            const data = {
              title: item.title,
              // Retain a verified original publication date after canonical identity is bound.
              publishTime:
                original?.publishTime ??
                existing?.publishTime ??
                item.publishTime,
              ...mergedFields,
              sourceUrl: item.url.includes('&sn=')
                ? item.url
                : existing?.sourceUrl || knownSourceUrl || item.url,
              picUrl: item.picUrl,
            };
            if (existing) {
              await tx.article.update({ where: { id: existing.id }, data });
              updated++;
            } else {
              await tx.article.create({
                data: { ...data, id: item.id, mpId: input.mpId },
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
        merged,
        pages: result.pages,
        albums: result.albums,
        oldestPublishTime: Math.min(
          ...result.articles.map((a) => a.publishTime),
        ),
        newestPublishTime: Math.max(
          ...result.articles.map((a) => a.publishTime),
        ),
        message: `公开合集在线取得 ${result.articles.length} 篇（新增 ${created}，更新 ${updated}，合并已核验重复 ${merged}），共 ${result.pages} 页。仅覆盖所选合集；合集外文章与次条完整性未验证，阅读、点赞、收藏未获取。`,
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
