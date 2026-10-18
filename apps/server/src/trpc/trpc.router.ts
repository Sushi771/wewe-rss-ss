import { buildArticleMarkdown } from '../article-export';
import { prepareCachedArticleLocalExport } from '../cached-article-local-export';
import { LocalArticleStore } from '../article-local-save';
import {
  exportSourceFromFeed,
  exportSourceMarkdown,
} from '../article-export-source';
import { savedMediaIds } from '../collection/saved-media-writeback';
import { findArticleListRows } from '../article-list-page';
import { cacheRevision, cacheSyncStatus } from '../feeds/cache-sync-state';
import { protectedFeedDelete } from '../collection/protected-feed-delete';
import { protectedArticleDelete } from '../collection/protected-article-delete';
import { INestApplication, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import {
  AccountSchemas,
  ArticleSchemas,
  articleFilterSchema,
  FeedSchemas,
  PlatformSchemas,
} from '@wewe-rss/shared';
import { TrpcService } from '@server/trpc/trpc.service';
import * as trpcExpress from '@trpc/server/adapters/express';
import { TRPCError } from '@trpc/server';
import { PrismaService } from '@server/prisma/prisma.service';
import { articleListWhere, articleListOrder } from '../article-list-filter';
import { ConfigService } from '@nestjs/config';
import { ConfigurationType } from '@server/configuration';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WereadService } from '@server/weread/weread.service';
import { CollectionService } from '../collection/collection.service';
import { createVerifiedSqliteBackup } from '../collection/sqlite-backup';
import { resolveCollectionRoute } from '../collection/collection-channel';
import { hasPrivateSession, privateOnlineMode } from '../private-access';
import {
  bodyRetryAvailability,
  BodyRetryBlockedError,
  readBodyRetryResult,
} from '../collection/article-body-retry';
import {
  canonicalArticleUrl,
  csvCell,
  metricLabels,
  Metrics,
} from '../collection/collection-format';
import { scanOwnerCandidates } from '../collection/owner-candidate-scan';

const searchCandidateSnapshotSchema = z.object({
  mpId: z
    .string()
    .regex(/^MP_WXS_\d{5,15}$/)
    .optional(),
  result: z.object({
    candidates: z
      .array(
        z.object({
          id: z.string().regex(/^WX_\d{5,15}_\d{1,20}_[1-9]\d{0,3}$/),
          mpId: z.string().regex(/^MP_WXS_\d{5,15}$/),
          url: z.string().max(2000),
          title: z.string().trim().min(1).max(1000),
          indexTimestamp: z
            .number()
            .int()
            .positive()
            .max(4102444800)
            .nullable(),
        }),
      )
      .max(500),
    pages: z.number().int().min(0).max(5),
    requests: z.number().int().min(0).max(5),
    capturedAt: z.string().datetime({ offset: true }),
    truncated: z.boolean(),
    termination: z.enum(['upstream_exhausted', 'page_budget', 'repeated_page']),
    coverage: z.literal('search-results'),
    complete: z.boolean(),
  }),
});

@Injectable()
export class TrpcRouter {
  constructor(
    private readonly trpcService: TrpcService,
    private readonly prismaService: PrismaService,
    private readonly configService: ConfigService,
    private readonly wereadService: WereadService,
    private readonly collectionService: CollectionService,
  ) {}

  private readonly logger = new Logger(this.constructor.name);

  /** Read only an explicitly bound private snapshot; never return its request parameters or paths. */
  private async readSearchCandidateSnapshot(mpId: string) {
    const boundFeedId = process.env.OWNER_SEARCH_CANDIDATE_FEED_ID;
    const snapshotFile = process.env.OWNER_SEARCH_CANDIDATE_SNAPSHOT_FILE;
    if (mpId !== boundFeedId || !snapshotFile) return null;
    try {
      if (!path.isAbsolute(snapshotFile)) throw new Error();
      const stat = await fs.promises.lstat(snapshotFile);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error();
      const raw = await fs.promises.readFile(snapshotFile);
      if (raw.length > 2 * 1024 * 1024) throw new Error();
      const snapshot = searchCandidateSnapshotSchema.parse(
        JSON.parse(raw.toString('utf8')),
      );
      const { result } = snapshot;
      if (
        (snapshot.mpId && snapshot.mpId !== mpId) ||
        (!result.candidates.length && snapshot.mpId !== mpId)
      )
        throw new Error();
      const identities = new Set<string>();
      const expectedBiz = Buffer.from(mpId.slice('MP_WXS_'.length)).toString(
        'base64',
      );
      const candidates = result.candidates.map((candidate) => {
        const url = new URL(candidate.url);
        if (
          candidate.mpId !== mpId ||
          url.protocol !== 'https:' ||
          /[\s\\\x00-\x1f\x7f]/.test(candidate.url) ||
          url.hash ||
          ['__biz', 'mid', 'idx', 'sn'].some(
            (key) => url.searchParams.getAll(key).length !== 1,
          ) ||
          url.searchParams.get('__biz') !== expectedBiz ||
          !/^[a-fA-F0-9]{4,64}$/.test(url.searchParams.get('sn') || '')
        )
          throw new Error();
        const identity = canonicalArticleUrl(candidate.url);
        if (
          identity.id !== candidate.id ||
          identity.mpId !== mpId ||
          identities.has(candidate.id)
        )
          throw new Error();
        identities.add(candidate.id);
        return {
          id: candidate.id,
          mpId,
          title: candidate.title,
          url: identity.url,
          indexTimestamp: candidate.indexTimestamp,
        };
      });
      return {
        mpId,
        candidates,
        capturedAt: result.capturedAt,
        pages: result.pages,
        requests: result.requests,
        truncated: result.truncated,
        termination: result.termination,
        coverage: 'search-results' as const,
        // Exhausting a search cursor does not prove a complete account list.
        complete: false as const,
      };
    } catch {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: '搜索候选快照不可用，请检查服务器私有配置或重新核验快照。',
      });
    }
  }

  /** Stage one feed for an authenticated browser ZIP download. Never write to OBSIDIAN_PATH. */
  async buildOfflineFeedDirectory(
    feedId: string,
    directory: string,
    filter: Parameters<typeof articleListWhere>[0] = {},
    cancelled: () => boolean = () => false,
  ) {
    const feed = await this.prismaService.feed.findUnique({
      where: { id: feedId },
      include: { group: true },
    });
    if (!feed) return null;
    const articles = await this.prismaService.article.findMany({
      where: articleListWhere({ ...filter, mpId: feedId }),
      take: 5001,
      orderBy: [{ publishTime: 'desc' }, { id: 'asc' }],
      select: {
        id: true,
        title: true,
        sourceUrl: true,
        contentHtml: true,
        lastBodyStatus: true,
        metrics: true,
        publishTime: true,
      },
    });
    if (articles.length > 5000) throw new Error('离线导出文章超过上限');
    await fs.promises.mkdir(directory, { recursive: true });
    let complete = 0;
    const incomplete: string[] = [];
    const incompleteDetails: {
      path: string;
      reason: 'body-not-cached' | 'missing' | 'unconfirmed' | 'export-failed';
      missingImageCount?: number;
    }[] = [];
    const source = exportSourceFromFeed(feed);
    const store = new LocalArticleStore(
      path.join(directory, '.unused-settings.json'),
      directory,
    );
    for (const article of articles) {
      if (cancelled()) throw new Error('导出已取消');
      try {
        const saved = await store.save(
          prepareCachedArticleLocalExport(article, source),
          new Date(),
          directory,
        );
        if (saved.mediaComplete === false) {
          incomplete.push(
            path
              .relative(directory, saved.markdownPath)
              .split(path.sep)
              .join('/'),
          );
          incompleteDetails.push({
            path: incomplete[incomplete.length - 1],
            reason: saved.mediaStatus === 'missing' ? 'missing' : 'unconfirmed',
            missingImageCount: saved.missingImageCount,
          });
        } else complete++;
      } catch {
        if (cancelled()) throw new Error('导出已取消');
        const result = await store.save(
          async (stage) => {
            await fs.promises.mkdir(path.join(stage, 'image'));
            await fs.promises.writeFile(
              path.join(stage, 'index.md'),
              `# ${article.title.replace(/[\r\n]/g, ' ')}\n\n正文或图片尚未完整归档，本篇无法完整离线阅读。\n`,
            );
            return {
              articleId: article.id,
              title: article.title,
              imageCount: 0,
              mediaComplete: false,
              exportSource: source,
              sourceUrl: article.sourceUrl,
              publishTime: article.publishTime,
            };
          },
          new Date(),
          directory,
        );
        incomplete.push(
          path
            .relative(directory, result.markdownPath)
            .split(path.sep)
            .join('/'),
        );
        incompleteDetails.push({
          path: incomplete[incomplete.length - 1],
          reason: article.contentHtml ? 'export-failed' : 'body-not-cached',
        });
      }
    }
    await fs.promises.writeFile(
      path.join(directory, 'README.md'),
      `# ${feed.mpName}\n\n共 ${articles.length} 篇；正文与图片离线完整 ${complete} 篇；未完整 ${incomplete.length} 篇。\n\n` +
        `范围：${filter.dateStart || '不限开始'} 至 ${filter.dateEnd || '不限结束'}（上海日期）；搜索：${filter.search || '无'}；分组筛选：${filter.group || 'all'}。这是本次范围完整快照，不检测本地下载历史。\n\n` +
        `分组：${source.groupName || '未分组'}\n\n文章位于 YYYY-MM-DD_分组/公众号文件夹中；日期采用原文发布日期（上海时间），不同日期分别保存，缺可信日期为日期待核并写明原因，正常文件名保留文章标题，冲突时加稳定身份后缀；该号共用 image/，图片按文章身份隔离，正文使用相对引用。未完整篇目在各自文件中明确标注。\n`,
    );
    // Stable reason codes keep cache absence separate from body media failures.
    const incompleteLabels = {
      'body-not-cached': '正文未缓存',
      missing: '已知正文图片未取得',
      unconfirmed: '媒体完整性未确认',
      'export-failed': '导出未完成',
    };
    if (incompleteDetails.length)
      await fs.promises.appendFile(
        path.join(directory, 'README.md'),
        '\n' +
          incompleteDetails
            .map(
              (item) =>
                `- ${item.path}: ${incompleteLabels[item.reason]}${item.missingImageCount ? ` (${item.missingImageCount})` : ''}\n`,
            )
            .join(''),
      );
    return {
      name: feed.mpName,
      articles: articles.length,
      complete,
      incomplete,
      incompleteDetails,
    };
  }

  collectionRouter = this.trpcService.router({
    collectPublicAlbums: this.trpcService.protectedProcedure
      .input(
        z.object({
          mpId: z.string().regex(/^MP_WXS_\d{5,15}$/),
          albumIds: z
            .array(z.string().regex(/^\d{10,30}$/))
            .min(1)
            .max(10),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        if (!(ctx as any).isLocal)
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: '公开合集绑定只能在服务器本机操作',
          });
        return this.trpcService.collectPublicAlbums(input);
      }),
    preview: this.trpcService.protectedProcedure
      .input(
        z.object({
          directory: z.string().min(1).max(1000),
          mpId: z.string().optional(),
          mpName: z.string().max(100).optional(),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        if (!(ctx as any).isLocal)
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: '本地采集只能在服务器本机操作',
          });
        return this.collectionService.preview(input);
      }),
    importDirectory: this.trpcService.protectedProcedure
      .input(
        z.object({
          directory: z.string().min(1).max(1000),
          mpId: z.string().optional(),
          mpName: z.string().max(100).optional(),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        if (!(ctx as any).isLocal)
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: '本地采集只能在服务器本机操作',
          });
        await createVerifiedSqliteBackup({ allowMysqlSkip: true });
        return this.collectionService.importDirectory(input);
      }),
    exportMetrics: this.trpcService.protectedProcedure
      .input(
        z.object({
          mpId: z.string().optional(),
          search: z.string().optional(),
          ids: z.array(z.string()).max(5000).optional(),
        }),
      )
      .mutation(async ({ input }) => {
        const where = {
          mpId: input.mpId || undefined,
          id: input.ids ? { in: input.ids } : undefined,
          ...(input.search
            ? {
                OR: [
                  { title: { contains: input.search } },
                  { feed: { mpName: { contains: input.search } } },
                ],
              }
            : {}),
        };
        const count = await this.prismaService.article.count({ where });
        if (count > 10000)
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: '单次最多导出 10000 篇，请选择公众号或缩小搜索范围',
          });
        const articles = await this.prismaService.article.findMany({
          where,
          orderBy: [{ publishTime: 'desc' }, { id: 'desc' }],
          select: {
            id: true,
            title: true,
            sourceUrl: true,
            publishTime: true,
            metrics: true,
            feed: { select: { mpName: true } },
          },
        });
        const keys = Object.keys(metricLabels) as (keyof Metrics)[];
        const rows: unknown[][] = [
          [
            '标题',
            '公众号',
            '链接',
            '发布时间（北京时间）',
            ...keys.flatMap((k) => [
              `${metricLabels[k]}（原始值）`,
              `${metricLabels[k]}（数值/下限）`,
              `${metricLabels[k]}数据文件时间（UTC）`,
            ]),
            '数据来源',
          ],
        ];
        for (const a of articles) {
          const metrics: Metrics = JSON.parse(a.metrics || '{}');
          rows.push([
            a.title,
            a.feed.mpName,
            a.sourceUrl || `https://mp.weixin.qq.com/s/${a.id}`,
            new Date(a.publishTime * 1000 + 8 * 3600000)
              .toISOString()
              .slice(0, 19)
              .replace('T', ' '),
            ...keys.flatMap((k) => [
              metrics[k]?.display ?? '',
              metrics[k]?.value ?? '',
              metrics[k]?.fileTime ?? '',
            ]),
            Object.keys(metrics).length
              ? 'WeChatDownload CSV 指标'
              : '未获取指标',
          ]);
        }
        return {
          csv:
            '\uFEFF' +
            rows.map((row) => row.map(csvCell).join(',')).join('\r\n'),
          count: articles.length,
        };
      }),
  });

  // Private mode uses the existing signed site session. It must not disable
  // the owner's account management along with anonymous access.
  private legacyAccountProcedure = this.trpcService.protectedProcedure;

  accountRouter = this.trpcService.router({
    list: this.legacyAccountProcedure
      .input(AccountSchemas.list)
      .query(async ({ input }) => {
        const limit = input.limit ?? 1000;
        const { cursor } = input;

        const items = await this.prismaService.account.findMany({
          take: limit + 1,
          where: {},
          select: {
            id: true,
            name: true,
            status: true,
            createdAt: true,
            updatedAt: true,
            token: false,
          },
          cursor: cursor
            ? {
                id: cursor,
              }
            : undefined,
          orderBy: {
            createdAt: 'asc',
          },
        });
        let nextCursor: typeof cursor | undefined = undefined;
        if (items.length > limit) {
          // Remove the last item and use it as next cursor

          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          const nextItem = items.pop()!;
          nextCursor = nextItem.id;
        }

        const disabledAccounts = this.trpcService.getBlockedAccountIds();
        return {
          blocks: disabledAccounts,
          items,
          nextCursor,
        };
      }),
    byId: this.legacyAccountProcedure
      .input(z.string())
      .query(async ({ input: id }) => {
        const account = await this.prismaService.account.findUnique({
          where: { id },
          select: {
            id: true,
            name: true,
            status: true,
            createdAt: true,
            updatedAt: true,
          },
        });
        if (!account) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `No account with id '${id}'`,
          });
        }
        return account;
      }),
    add: this.legacyAccountProcedure
      .input(AccountSchemas.add)
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        await createVerifiedSqliteBackup({ allowMysqlSkip: true });
        const account = await this.prismaService.account.upsert({
          where: {
            id,
          },
          update: data,
          create: input,
          select: {
            id: true,
            name: true,
            status: true,
            createdAt: true,
            updatedAt: true,
          },
        });
        this.trpcService.removeBlockedAccount(id);

        return account;
      }),
    edit: this.legacyAccountProcedure
      .input(AccountSchemas.edit)
      .mutation(async ({ input }) => {
        const { id, data } = input;
        await createVerifiedSqliteBackup({ allowMysqlSkip: true });
        const account = await this.prismaService.account.update({
          where: { id },
          data,
          select: {
            id: true,
            name: true,
            status: true,
            createdAt: true,
            updatedAt: true,
          },
        });
        this.trpcService.removeBlockedAccount(id);
        return account;
      }),
    delete: this.legacyAccountProcedure
      .input(z.string())
      .mutation(async ({ input: id }) => {
        await createVerifiedSqliteBackup({ allowMysqlSkip: true });
        await this.prismaService.account.delete({ where: { id } });
        this.trpcService.removeBlockedAccount(id);

        return id;
      }),
  });

  feedRouter = this.trpcService.router({
    cacheRevision: this.trpcService.protectedProcedure.query(() =>
      cacheRevision(),
    ),
    cacheSyncStatus: this.trpcService.protectedProcedure.query(() =>
      cacheSyncStatus(),
    ),
    subscriptionTasks: this.trpcService.protectedProcedure.query(async () => ({
      items: await this.trpcService.subscriptionTaskList(),
    })),
    addSubscriptionBatch: this.trpcService.protectedProcedure
      .input(
        z
          .object({ articleUrls: z.array(z.string().max(4096)).min(1).max(20) })
          .strict(),
      )
      .mutation(({ input }) =>
        this.trpcService.addSubscriptionBatch(input.articleUrls),
      ),
    subscriptionBatches: this.trpcService.protectedProcedure.query(
      async () => ({ items: await this.trpcService.subscriptionBatchList() }),
    ),
    manualRefreshBatches: this.trpcService.protectedProcedure.query(
      async () => ({
        items: (await this.trpcService.subscriptionBatchList(true)).filter(
          (batch) => batch.purpose === 'manual-refresh',
        ),
      }),
    ),
    beginRefreshAll: this.trpcService.protectedProcedure
      .input(
        z
          .object({
            feedIds: z
              .array(z.string().regex(/^MP_WXS_\d{5,15}$/))
              .min(1)
              .max(1000)
              .optional(),
            intentKey: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
          })
          .optional(),
      )
      .mutation(({ ctx, input }) => {
        if (!(ctx as any).isLocal)
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: '提交上游更新仅限本机手动入口。',
          });
        return this.trpcService.beginManualRefreshAll(
          input?.feedIds,
          input?.intentKey,
        );
      }),
    stopSubscriptionBatch: this.trpcService.protectedProcedure
      .input(z.object({ batchId: z.string().uuid() }))
      .mutation(({ input }) =>
        this.trpcService.stopSubscriptionBatch(input.batchId),
      ),
    unknownRefreshReleaseBinding: this.trpcService.protectedProcedure
      .input(
        z.object({
          batchId: z.string().uuid(),
          feedId: z.string().regex(/^MP_WXS_\d{5,15}$/),
        }),
      )
      .query(({ input, ctx }) => {
        if (!(ctx as any).isLocal)
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Local explicit disposition only.',
          });
        return this.trpcService.unknownRefreshReleaseBinding(
          input.batchId,
          input.feedId,
        );
      }),
    releaseUnknownRefreshOccupancy: this.trpcService.protectedProcedure
      .input(
        z.object({
          batchId: z.string().uuid(),
          feedId: z.string().regex(/^MP_WXS_\d{5,15}$/),
          approvalFile: z
            .string()
            .min(1)
            .max(4096)
            .regex(/^[^\0\r\n]+$/),
          approvalSha256: z.string().regex(/^[a-f0-9]{64}$/),
          evidenceFile: z
            .string()
            .min(1)
            .max(4096)
            .regex(/^[^\0\r\n]+$/),
        }),
      )
      .mutation(({ input, ctx }) => {
        if (!(ctx as any).isLocal)
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Local explicit disposition only.',
          });
        return this.trpcService.releaseUnknownRefreshOccupancy(input);
      }),
    resumeSubscriptionBatch: this.trpcService.protectedProcedure
      .input(z.object({ batchId: z.string().uuid() }))
      .mutation(({ input }) =>
        this.trpcService.resumeSubscriptionBatch(input.batchId),
      ),
    subscriptionTask: this.trpcService.protectedProcedure
      .input(z.object({ taskId: z.string().regex(/^[a-f0-9]{64}$/) }))
      .query(({ input }) => this.trpcService.subscriptionTask(input.taskId)),
    resumeSubscriptionTask: this.trpcService.protectedProcedure
      .input(z.object({ taskId: z.string().regex(/^[a-f0-9]{64}$/) }))
      .mutation(({ input }) =>
        this.trpcService.resumeSubscriptionTask(input.taskId),
      ),
    searchCandidates: this.trpcService.protectedProcedure
      .input(z.object({ mpId: z.string().regex(/^MP_WXS_\d{5,15}$/) }))
      .query(({ input }) => this.readSearchCandidateSnapshot(input.mpId)),
    scanCandidates: this.trpcService.protectedProcedure
      .input(z.object({ mpId: z.string().regex(/^MP_WXS_\d{5,15}$/) }))
      .mutation(async ({ input }) => {
        if (
          input.mpId !== process.env.OWNER_SEARCH_CANDIDATE_FEED_ID ||
          !process.env.OWNER_SEARCH_CANDIDATE_SNAPSHOT_FILE
        )
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: '该公众号未配置候选扫描。',
          });
        try {
          return await scanOwnerCandidates(input.mpId);
        } catch {
          // Search keeps its own durable cooldown and access-stop reason.
          // Do not leak session/config paths or upstream response details.
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message:
              '候选扫描未完成；请检查私人搜索会话、冷却或停止记录。旧候选快照已保留。',
          });
        }
      }),
    addFromArticle: this.trpcService.protectedProcedure
      .input(z.object({ articleUrl: z.string().url() }))
      .mutation(async ({ input }) =>
        this.trpcService.addSubscriptionFromArticle(input.articleUrl),
      ),
    list: this.trpcService.protectedProcedure
      .input(FeedSchemas.list)
      .query(async ({ input }) => {
        const limit = input.limit ?? 1000;
        const { cursor } = input;

        const items = await this.prismaService.feed.findMany({
          take: limit + 1,
          where: {},
          cursor: cursor
            ? {
                id: cursor,
              }
            : undefined,
          orderBy: [{ order: 'asc' } as any, { createdAt: 'asc' }],
        });
        let nextCursor: typeof cursor | undefined = undefined;
        if (items.length > limit) {
          // Remove the last item and use it as next cursor

          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          const nextItem = items.pop()!;
          nextCursor = nextItem.id;
        }

        return {
          items: items.map((feed) => ({
            ...feed,
            collectionRoute: resolveCollectionRoute(feed),
          })),
          nextCursor,
        };
      }),
    byId: this.trpcService.protectedProcedure
      .input(z.string())
      .query(async ({ input: id }) => {
        const feed = await this.prismaService.feed.findUnique({
          where: { id },
        });
        if (!feed) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `No feed with id '${id}'`,
          });
        }
        return { ...feed, collectionRoute: resolveCollectionRoute(feed) };
      }),
    add: this.trpcService.protectedProcedure
      .input(FeedSchemas.add)
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        const feed = await this.prismaService.feed.upsert({
          where: {
            id,
          },
          update: data,
          create: input,
        });

        return feed;
      }),
    edit: this.trpcService.protectedProcedure
      .input(FeedSchemas.edit)
      .mutation(async ({ input }) => {
        const { id, data } = input;
        const feed = await this.prismaService.feed.update({
          where: { id },
          data,
        });
        return feed;
      }),
    delete: this.trpcService.protectedProcedure
      .input(z.string())
      .mutation(async ({ input: id }) => {
        await protectedFeedDelete(this.prismaService, [id], true);
        return id;
      }),
    updateOrder: this.trpcService.protectedProcedure
      .input(FeedSchemas.updateOrder)
      .mutation(async ({ input }) => {
        const updates = input.map(({ id, order }) =>
          this.prismaService.feed.update({
            where: { id },
            data: { order } as any,
          }),
        );
        await this.prismaService.$transaction(updates);
        return true;
      }),
    batchDelete: this.trpcService.protectedProcedure
      .input(z.array(z.string().min(1).max(128)).max(1000))
      .mutation(async ({ input: ids }) =>
        protectedFeedDelete(this.prismaService, ids),
      ),

    refreshArticles: this.trpcService.protectedProcedure
      .input(
        z.object({
          mpId: z.string().optional(),
        }),
      )
      .mutation(async ({ input: { mpId }, ctx }) => {
        const trigger = (ctx as any).isLocal ? 'local-manual' : 'public';
        if (mpId) {
          return [
            await this.trpcService.refreshMpArticlesAndUpdateFeed(
              mpId,
              1,
              trigger,
            ),
          ];
        } else {
          return this.trpcService.refreshAllMpArticlesAndUpdateFeed(trigger);
        }
      }),

    isRefreshAllMpArticlesRunning: this.trpcService.protectedProcedure.query(
      async () => {
        return this.trpcService.isRefreshAllMpArticlesRunning;
      },
    ),
    getHistoryArticles: this.trpcService.protectedProcedure
      .input(
        z.object({
          mpId: z.string().optional(),
        }),
      )
      .mutation(async ({ input: { mpId = '' } }) => {
        return this.trpcService.getHistoryMpArticles(mpId);
      }),
    getInProgressHistoryMp: this.trpcService.protectedProcedure.query(
      async () => {
        return this.trpcService.inProgressHistoryMp;
      },
    ),
  });

  articleRouter = this.trpcService.router({
    supplementSavedMedia: this.trpcService.protectedProcedure
      .input(z.object({ ids: savedMediaIds }).strict())
      .mutation(({ input, ctx }) => {
        if (!(ctx as any).isLocal) throw new TRPCError({ code: 'FORBIDDEN' });
        return this.trpcService.supplementSavedArticleMedia(input.ids);
      }),
    summary: this.trpcService.protectedProcedure
      .input(articleFilterSchema)
      .query(async ({ input }) => {
        const where = articleListWhere(input);
        const [range, readAvailable, likeAvailable, cachedBodies] =
          await this.prismaService.$transaction([
            this.prismaService.article.aggregate({
              where,
              _count: true,
              _min: { publishTime: true },
              _max: { publishTime: true },
            }),
            this.prismaService.article.count({
              where: { ...where, readCount: { not: null } },
            }),
            this.prismaService.article.count({
              where: { ...where, likeCount: { not: null } },
            }),
            this.prismaService.article.count({
              where: { ...where, contentHtml: { not: null } },
            }),
          ]);
        return {
          articles: range._count,
          readAvailable,
          likeAvailable,
          cachedBodies,
          oldestPublishTime: range._min.publishTime,
          newestPublishTime: range._max.publishTime,
        };
      }),
    list: this.trpcService.protectedProcedure
      .input(ArticleSchemas.list)
      .query(async ({ input, ctx }) => {
        const limit = input.limit ?? 1000;
        const { cursor } = input;
        const where = articleListWhere(input);

        const items = await findArticleListRows(
          this.prismaService,
          {
            orderBy: articleListOrder(input),
            take: limit + 1,
            where,
            cursor: cursor
              ? {
                  id: cursor,
                }
              : undefined,
          },
          { databaseUrl: process.env.DATABASE_URL },
        );
        let nextCursor: typeof cursor | undefined = undefined;
        if (items.length > limit) {
          // Remove the last item and use it as next cursor

          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          const nextItem = items.pop()!;
          nextCursor = nextItem.id;
        }

        return {
          items: items.map((item) => {
            const { lastBodyRetry, ...publicItem } = item;
            return {
              ...publicItem,
              bodyRetry: bodyRetryAvailability(item, !!(ctx as any).isLocal),
              bodyRetryResult: readBodyRetryResult(lastBodyRetry),
            };
          }),
          nextCursor,
        };
      }),
    byId: this.trpcService.protectedProcedure
      .input(z.string())
      .query(async ({ input: id, ctx }) => {
        const article = await this.prismaService.article.findUnique({
          where: { id },
        });
        if (!article) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `No article with id '${id}'`,
          });
        }
        return {
          ...article,
          bodyCached: Boolean(article.contentHtml),
          bodyRetry: bodyRetryAvailability(article, !!(ctx as any).isLocal),
          bodyRetryResult: readBodyRetryResult(article.lastBodyRetry),
        };
      }),

    retryBody: this.trpcService.protectedProcedure
      .input(z.string().min(1).max(200))
      .mutation(async ({ input: id, ctx }) => {
        if (!(ctx as any).isLocal)
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: '单篇正文重试只能在服务器本机操作',
          });
        try {
          return await this.trpcService.retryArticleBody(id);
        } catch (error) {
          throw new TRPCError({
            code:
              error instanceof BodyRetryBlockedError
                ? 'BAD_REQUEST'
                : 'INTERNAL_SERVER_ERROR',
            message:
              error instanceof BodyRetryBlockedError
                ? error.message
                : '正文重试未完成，请重新读取文章状态。',
          });
        }
      }),

    add: this.trpcService.protectedProcedure
      .input(ArticleSchemas.add)
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        const article = await this.prismaService.article.upsert({
          where: {
            id,
          },
          update: data,
          create: input,
        });

        return article;
      }),
    delete: this.trpcService.protectedProcedure
      .input(z.string())
      .mutation(async ({ input: id }) => {
        await protectedArticleDelete(this.prismaService, id);
        return id;
      }),
    exportMarkdown: this.trpcService.protectedProcedure
      .input(z.string())
      .mutation(async ({ input: id }) => {
        try {
          const {
            markdown,
            title,
            mediaComplete,
            mediaStatus,
            missingImageCount,
          } = await this.getArticleMarkdown(id);
          // Browser Markdown must not overwrite an Obsidian file with proxy image URLs.
          return {
            markdown,
            title,
            mediaComplete,
            mediaStatus,
            missingImageCount,
          };
        } catch (err: any) {
          this.logger.error(`Export Markdown error for ${id}: ${err.message}`);
          if (err instanceof TRPCError) throw err;
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: '获取文章内容失败',
            cause: err.stack,
          });
        }
      }),

    saveToObsidian: this.trpcService.protectedProcedure
      .input(z.string())
      .mutation(async ({ input: id }) => {
        if (privateOnlineMode())
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: '线上站点只支持浏览器 ZIP 下载',
          });
        const article = await this.prismaService.article.findUnique({
          where: { id },
          include: { feed: { include: { group: true } } },
        });
        if (!article) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `No article with id '${id}'`,
          });
        }

        const { obsidianPath } =
          this.configService.get<ConfigurationType['feed']>('feed')!;

        try {
          // Batch export calls this same mutation per ID. Share the tool's
          // isolated directory, atomic publication and edited-note protection.
          const store = new LocalArticleStore(
            path.join(obsidianPath, '.wewe-list-export-settings.json'),
            obsidianPath,
          );
          const result = await store.save(
            prepareCachedArticleLocalExport(
              article,
              exportSourceFromFeed(article.feed),
            ),
            new Date(),
            obsidianPath,
          );
          return {
            success: result.mediaComplete !== false,
            mediaStatus:
              result.mediaStatus ??
              (result.mediaComplete === false ? 'unconfirmed' : 'complete'),
            missingImageCount: result.missingImageCount,
            path: result.markdownPath,
            alreadySaved: result.alreadySaved,
            status:
              result.status ??
              (result.mediaComplete === false
                ? 'failed'
                : result.alreadySaved
                  ? 'skipped'
                  : 'new'),
            publicationDate: result.publicationDate,
            ...(result.datePendingReason
              ? { datePendingReason: result.datePendingReason }
              : {}),
            ...(result.legacyLayoutRetained
              ? { legacyLayoutRetained: true }
              : {}),
            ...(result.mediaComplete === false ? { mediaComplete: false } : {}),
          };
        } catch (err: any) {
          this.logger.error(`Save to Obsidian error for ${id}: ${err.message}`);
          if (err instanceof TRPCError) throw err;
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: `保存到 Obsidian 失败: ${err.message}`,
            cause: err.stack,
          });
        }
      }),
  });

  private async getArticleMarkdown(id: string, downloadPath?: string) {
    const article = await this.prismaService.article.findUnique({
      where: { id },
      include: { feed: { include: { group: true } } },
    });
    if (!article) throw new Error(`No article with id '${id}'`);
    const { originUrl } = this.configService.get('feed');
    const exported = await buildArticleMarkdown(
      article,
      originUrl || 'http://localhost:4000',
      downloadPath,
    );
    return {
      ...exported,
      markdown:
        exportSourceMarkdown(
          exportSourceFromFeed(article.feed),
          article.sourceUrl,
          article.publishTime,
        ) + exported.markdown,
    };
  }

  platformRouter = this.trpcService.router({
    getMpArticles: this.legacyAccountProcedure
      .input(PlatformSchemas.getMpArticles)
      .mutation(async ({ input: { mpId } }) => {
        try {
          const results = await this.trpcService.getMpArticles(mpId);
          return results;
        } catch (err: any) {
          this.logger.log('getMpArticles err: ', err);
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: err.response?.data?.message || err.message,
            cause: err.stack,
          });
        }
      }),
    getMpInfo: this.legacyAccountProcedure
      .input(PlatformSchemas.getMpInfo)
      .mutation(async ({ input: { wxsLink: url } }) => {
        try {
          const results = await this.trpcService.getMpInfo(url);
          return results;
        } catch (err: any) {
          this.logger.log('getMpInfo err: ', err);
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: err.response?.data?.message || err.message,
            cause: err.stack,
          });
        }
      }),

    createLoginUrl: this.legacyAccountProcedure.mutation(async () => {
      try {
        return await this.trpcService.createLoginUrl();
      } catch (err: any) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: err.message || '获取微信登录二维码失败',
          cause: err.stack,
        });
      }
    }),
    getLoginResult: this.legacyAccountProcedure
      .input(PlatformSchemas.getLoginResult)
      .query(async ({ input }) => {
        try {
          return await this.trpcService.getLoginResult(input.id);
        } catch (err: any) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: err.message || '轮询登录状态失败',
            cause: err.stack,
          });
        }
      }),
  });

  appRouter = this.trpcService.router({
    feed: this.feedRouter,
    account: this.accountRouter,
    article: this.articleRouter,
    platform: this.platformRouter,
    collection: this.collectionRouter,
  });

  async applyMiddleware(app: INestApplication) {
    app.use(
      `/trpc`,
      trpcExpress.createExpressMiddleware({
        router: this.appRouter,
        createContext: ({ req }) => {
          const authCode =
            this.configService.get<ConfigurationType['auth']>('auth')!.code;

          if (privateOnlineMode() && !hasPrivateSession(req)) {
            return { errorMsg: '请先登录' };
          }
          if (
            !privateOnlineMode() &&
            authCode &&
            req.headers.authorization !== authCode
          ) {
            return {
              errorMsg: 'authCode不正确！',
            };
          }
          return {
            errorMsg: null,
            isLocal:
              ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(
                req.socket.remoteAddress || '',
              ) &&
              (!req.headers.origin ||
                /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(
                  req.headers.origin,
                )),
          };
        },
        middleware: (req, res, next) => {
          next();
        },
      }),
    );
  }
}

export type AppRouter = TrpcRouter[`appRouter`];
