import {
  readXhsSourceBudget,
  configureXhsSourceBudget,
  prepareXhsOriginalLink,
  resolveXhsSubscriptionWithBudget,
} from '../collection/xhs-source-request-policy';
import { XhsWholeCreatorService } from '../collection/xhs-whole-creator.service';
import {
  prepareBodySearch,
  bodySearchCoverage,
  findBodySearchIds,
  bodySearchSummary,
} from '../article-body-search';
import {
  LOCAL_EXPORT_BATCH_LIMIT,
  saveCachedArticleBatch,
} from '../article-local-export-batch';
import { protectedFeedDelete } from '../collection/protected-feed-delete';
import { protectedArticleDelete } from '../collection/protected-article-delete';
import { editAccount } from '../collection/account-write';
import { buildArticleMarkdown } from '../article-export';
import { cacheRevision, cacheSyncStatus } from '../feeds/cache-sync-state';
import { prepareCachedArticleLocalExport } from '../cached-article-local-export';
import { LocalArticleStore } from '../article-local-save';
import {
  exportSourceFromFeed,
  exportSourceMarkdown,
} from '../article-export-source';
import { findArticleListRows } from '../article-list-page';
import { savedMediaIds } from '../collection/saved-media-writeback';
import { articleListWhere, articleListOrder } from '../article-list-filter';
import { Wechat2RssAccounts } from '../wechat2rss-account';
import { INestApplication, Injectable, Logger, Optional } from '@nestjs/common';
import { XiaohongshuService } from '../collection/xiaohongshu.service';
import { XhsSubscriptionService } from '../collection/xhs-subscription.service';
import { XhsBatchSubscriptionService } from '../collection/xhs-batch-subscription.service';
import { XhsSubscriptionRuntime } from '../collection/xhs-subscription-runtime';
import { xhsPublicCode } from '../collection/xhs-subscription-errors';
import { xhsNoteFilterSchema } from '@wewe-rss/shared';
import { XhsEngagementService } from '../collection/xhs-engagement.service';
import {
  xhsCreatorFilterSchema,
  xhsNumericFilterShape,
  xhsNumericRange,
} from '@wewe-rss/shared';
import { z } from 'zod';
import {
  AccountSchemas,
  ArticleSchemas,
  articleFilterShape,
  articleFilterSchema,
  orderedArticleDates,
  FeedSchemas,
  PlatformSchemas,
} from '@wewe-rss/shared';
import { TrpcService } from '@server/trpc/trpc.service';
import * as trpcExpress from '@trpc/server/adapters/express';
import { TRPCError } from '@trpc/server';
import { PrismaService } from '@server/prisma/prisma.service';
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
import {
  readOwnerVerificationStatus,
  readOwnerAccountAccess,
} from '../collection/owner-verification-status';
import {
  ownerConfigFile,
  previewManualWereadBinding,
  confirmManualWereadBinding,
  nativeAccountLoginAt,
  nativeAccountProfile,
} from '../collection/owner-weread-binding';

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

export function isLocalXhsStatusRequest(input: {
  method: string;
  protocol: string;
  host: string;
  remoteAddress?: string;
  origin?: string;
}): boolean {
  const origin = `${input.protocol}://${input.host}`;
  return (
    input.method === 'GET' &&
    ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(
      input.remoteAddress || '',
    ) &&
    /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(origin) &&
    (input.origin === undefined || input.origin === origin)
  );
}

@Injectable()
export class TrpcRouter {
  private readonly wechat2RssAccounts = new Wechat2RssAccounts();

  constructor(
    private readonly trpcService: TrpcService,
    private readonly prismaService: PrismaService,
    private readonly configService: ConfigService,
    private readonly wereadService: WereadService,
    private readonly collectionService: CollectionService,
    @Optional() private readonly xiaohongshuService?: XiaohongshuService,
    @Optional() private readonly xhsSubscriptions?: XhsSubscriptionService,
    @Optional() private readonly xhsRuntime?: XhsSubscriptionRuntime,
    @Optional() private readonly xhsEngagement?: XhsEngagementService,
    @Optional() private readonly xhsWhole?: XhsWholeCreatorService,
    @Optional() private readonly xhsBatch?: XhsBatchSubscriptionService,
  ) {}

  private get xhs() {
    return (
      this.xiaohongshuService ?? new XiaohongshuService(this.prismaService)
    );
  }
  private requireLocalXhsAccess(ctx: unknown, readOnly = false) {
    if (
      !(
        (ctx as { isLocalSave?: boolean }).isLocalSave ||
        (readOnly && (ctx as { isLocalXhsRead?: boolean }).isLocalXhsRead)
      ) ||
      privateOnlineMode() ||
      process.env.WEWE_ACCEPTANCE_MODE === '1'
    )
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: '小红书来源访问仅允许本机同源页面使用。',
      });
  }
  private async xhsSourceOperation<T>(work: () => Promise<T>) {
    try {
      return await work();
    } catch (error) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: xhsPublicCode(error, 'XHS_REQUEST_POLICY_UNAVAILABLE'),
      });
    }
  }
  private requireLocalXhsConnection(ctx: unknown, readOnly = false) {
    this.requireLocalXhsAccess(ctx, readOnly);
    if (!this.xhsRuntime)
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'XHS_RUNTIME_UNAVAILABLE',
      });
  }

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
    const identities = filter.search
      ? await findBodySearchIds(
          this.prismaService,
          { ...filter, mpId: feedId },
          5001,
          true,
        )
      : await this.prismaService.article.findMany({
          where: articleListWhere({ ...filter, mpId: feedId }),
          take: 5001,
          orderBy: [{ publishTime: 'desc' }, { id: 'asc' }],
          select: { id: true },
        });
    if (identities.length > 5000)
      throw new Error('Offline export article limit exceeded');
    // Freeze membership/order without retaining every cached body. Each body and
    // its export metadata are read together; later insertions cannot enter this request.
    const articles = async function* (
      prisma: PrismaService,
      members: typeof identities,
    ) {
      for (let offset = 0; offset < members.length; offset += 8) {
        if (cancelled()) throw new Error('导出已取消');
        const ids = members.slice(offset, offset + 8).map((row) => row.id);
        const batch = await prisma.article.findMany({
          where: { mpId: feedId, id: { in: ids } },
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
        const byId = new Map(batch.map((article) => [article.id, article]));
        for (const id of ids) {
          const article = byId.get(id);
          // Do not silently claim a complete archive after concurrent deletion.
          if (!article)
            throw new Error('Offline export membership changed; retry');
          yield article;
        }
      }
    };
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
    const render = async (
      active: LocalArticleStore,
      members: typeof identities,
    ) => {
      for await (const article of articles(this.prismaService, members)) {
        if (cancelled()) throw new Error('导出已取消');
        try {
          const saved = await active.save(
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
              reason:
                saved.mediaStatus === 'missing' ? 'missing' : 'unconfirmed',
              missingImageCount: saved.missingImageCount,
            });
          } else complete++;
        } catch {
          if (cancelled()) throw new Error('导出已取消');
          const result = await active.save(
            Object.assign(
              async (stage: string) => {
                await fs.promises.mkdir(path.join(stage, 'image'));
                await fs.promises.writeFile(
                  path.join(stage, 'index.md'),
                  '正文或图片尚未完整归档，本篇无法完整离线阅读。\n',
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
              {
                identity: {
                  articleId: article.id,
                  title: article.title,
                  imageCount: 0,
                  exportSource: source,
                },
              },
            ),
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
    };
    for (let offset = 0; offset < identities.length; offset += 64) {
      if (cancelled()) throw new Error('导出已取消');
      const members = identities.slice(offset, offset + 64);
      await store.withRetainedBatch(
        members.map(({ id }) => ({
          articleId: id,
          title: id,
          imageCount: 0,
          exportSource: source,
        })),
        directory,
        (active) => render(active, members),
      );
    }
    await fs.promises.writeFile(
      path.join(directory, 'README.md'),
      `# ${feed.mpName}\n\n共 ${identities.length} 篇；正文与图片离线完整 ${complete} 篇；未完整 ${incomplete.length} 篇。\n\n` +
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
      articles: identities.length,
      complete,
      incomplete,
      incompleteDetails,
    };
  }

  collectionRouter = this.trpcService.router({
    verificationStatus: this.trpcService.protectedProcedure.query(
      async ({ ctx }) => {
        if (!(ctx as any).isLocal)
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: '官方验证状态只能在服务器本机查看。',
          });
        const feeds = await this.prismaService.feed.findMany({
          select: { id: true, mpName: true, collectionChannel: true },
        });
        return readOwnerVerificationStatus(
          process.env.OWNER_SEARCH_CONFIG_FILE,
          feeds,
          async (id) => {
            const nativeLoginAt = await nativeAccountLoginAt(id);
            const profile = await nativeAccountProfile(id, nativeLoginAt);
            return { name: profile?.name || null, nativeLoginAt };
          },
        );
      },
    ),
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
        z
          .object({
            ...articleFilterShape,
            ids: z.array(z.string()).max(5000).optional(),
          })
          .refine(orderedArticleDates, {
            message: '结束日期不能早于开始日期',
            path: ['dateEnd'],
          }),
      )
      .mutation(async ({ input }) => {
        const where = {
          ...articleListWhere(input),
          id: input.ids ? { in: input.ids } : undefined,
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
    wechat2rssAccounts: this.trpcService.protectedProcedure.query(() =>
      this.wechat2RssAccounts.list(),
    ),
    wechat2rssLoginStart: this.trpcService.protectedProcedure.mutation(() =>
      this.wechat2RssAccounts.start(),
    ),
    wechat2rssLoginPoll: this.trpcService.protectedProcedure
      .input(z.object({ sessionId: z.string().uuid() }))
      .mutation(({ input }) => this.wechat2RssAccounts.poll(input.sessionId)),
    wechat2rssLoginClose: this.trpcService.protectedProcedure
      .input(z.object({ sessionId: z.string().uuid() }))
      .mutation(({ input }) => this.wechat2RssAccounts.close(input.sessionId)),
    wechat2rssStatus: this.trpcService.protectedProcedure.query(() =>
      this.trpcService.wechat2rssStatus(),
    ),
    manualRefreshOptions: this.legacyAccountProcedure
      .input(z.object({ accountId: z.string().regex(/^\d+$/) }))
      .query(async ({ input, ctx }) => {
        if (!(ctx as any).isLocal)
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: '手动更新账号连接只能在服务器本机操作。',
          });
        try {
          const account = await this.prismaService.account.findUniqueOrThrow({
            where: { id: input.accountId },
          });
          const config = JSON.parse(
            await fs.promises.readFile(ownerConfigFile(), 'utf8'),
          );
          const feeds = await this.prismaService.feed.findMany({
            orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
          });
          const options = await Promise.all(
            feeds.map(async (feed) => {
              // Show every saved subscription. An absent private source or an
              // existing different channel must remain an explicit disabled
              // choice, never an automatic account/channel switch.
              const configured = !!config.feeds?.[feed.id];
              if (
                !configured ||
                feed.collectionChannel !== 'owner-weread-latest'
              )
                return {
                  mpId: feed.id,
                  name: feed.mpName,
                  revision: '',
                  ready: false,
                  connected: false,
                  connectedAt: null,
                  refreshRequired: false,
                  configured,
                  reason: configured
                    ? 'different-channel'
                    : 'source-unconfigured',
                  message: configured
                    ? '该订阅使用其他更新通道；需先明确选择手动读书来源，当前通道保持不变。'
                    : '该订阅尚未配置手动读书来源；账号登录不会自动绑定，也不会批量取文。',
                };
              const preview = await previewManualWereadBinding(
                account,
                feed.id,
              );
              let refreshAfterConnection = false;
              try {
                const result = JSON.parse(feed.lastCollectionResult || 'null');
                refreshAfterConnection =
                  preview.connected &&
                  result?.source === 'owner-weread-latest' &&
                  Number.isSafeInteger(result.attemptedAt) &&
                  // Whole-second legacy receipts cannot prove ordering inside
                  // the connection's fractional second. Keep that case pending.
                  result.attemptedAt * 1000 >= Date.parse(preview.connectedAt!);
              } catch {
                // A malformed/old receipt cannot claim the new login refreshed.
              }
              return {
                ...preview,
                name: feed.mpName,
                configured,
                reason: preview.ready ? null : 'session-unavailable',
                refreshRequired: preview.connected && !refreshAfterConnection,
                ...(preview.connected && !refreshAfterConnection
                  ? {
                      message:
                        '已连接此账号，尚无连接后的取文结果。请在该公众号页使用“更新本号”；连接确认仅保存授权。',
                    }
                  : {}),
              };
            }),
          );
          const profile = await nativeAccountProfile(
            account.id,
            await nativeAccountLoginAt(account.id),
          );
          return {
            accountLabel:
              profile?.name ||
              (!account.name || account.name === `WeRead_${account.id}`
                ? '昵称未读取'
                : `保存名称：${account.name}`),
            options,
          };
        } catch {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: '无法预览手动更新连接，请检查私有配置和正常Web登录。',
          });
        }
      }),
    connectManualRefresh: this.legacyAccountProcedure
      .input(
        z.object({
          accountId: z.string().regex(/^\d+$/),
          mpId: z.string().regex(/^MP_WXS_\d{5,15}$/),
          revision: z.string().regex(/^[a-f0-9]{64}$/),
          confirm: z.literal(true),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        if (!(ctx as any).isLocal)
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: '手动更新账号连接只能在服务器本机操作。',
          });
        try {
          const account = await this.prismaService.account.findUniqueOrThrow({
            where: { id: input.accountId },
          });
          const feed = await this.prismaService.feed.findUniqueOrThrow({
            where: { id: input.mpId },
          });
          if (feed.collectionChannel !== 'owner-weread-latest')
            throw new Error('INVALID_CHANNEL');
          return await confirmManualWereadBinding(
            account,
            input.mpId,
            input.revision,
          );
        } catch {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message:
              '连接未完成：请重新预览并核对正常Web登录、停止或正在更新状态；未发取文请求。',
          });
        }
      }),
    list: this.legacyAccountProcedure
      .input(AccountSchemas.list)
      .query(async ({ input, ctx }) => {
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
        const identifiedItems = await Promise.all(
          items.map(async (item) => {
            const nativeLoginAt = await nativeAccountLoginAt(item.id);
            const profile = await nativeAccountProfile(item.id, nativeLoginAt);
            return {
              ...item,
              nativeLoginAt,
              platformName: profile?.name || null,
              platformAvatar: profile?.avatar || null,
            };
          }),
        );
        const access = await readOwnerAccountAccess(
          (ctx as any).isLocal
            ? process.env.OWNER_SEARCH_CONFIG_FILE
            : undefined,
          (ctx as any).isLocal && process.env.OWNER_SEARCH_CONFIG_FILE
            ? await this.prismaService.feed.findMany({
                select: { id: true, mpName: true, collectionChannel: true },
              })
            : [],
          identifiedItems,
        );
        return {
          blocks: disabledAccounts,
          items: identifiedItems.map((item) => ({
            ...item,
            ...access.get(item.id),
          })),
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
        const account = await editAccount(this.prismaService, id, data);
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
    reorderGroups: this.trpcService.protectedProcedure
      .input(
        z
          .object({
            ids: z.array(z.string().min(1).max(128)).min(1).max(1000),
            expectedIds: z.array(z.string().min(1).max(128)).min(1).max(1000),
          })
          .strict(),
      )
      .mutation(({ input }) => this.trpcService.reorderGroups(input)),
    groups: this.trpcService.protectedProcedure.query(() =>
      this.trpcService.groups(),
    ),
    saveGroup: this.trpcService.protectedProcedure
      .input(
        z
          .object({
            id: z.string().min(1).max(128).optional(),
            name: z.string().trim().min(1).max(80),
          })
          .strict(),
      )
      .mutation(({ input }) => this.trpcService.saveGroup(input)),
    removeGroup: this.trpcService.protectedProcedure
      .input(z.object({ id: z.string().min(1).max(128) }).strict())
      .mutation(({ input }) => this.trpcService.removeGroup(input.id)),
    moveFeeds: this.trpcService.protectedProcedure
      .input(
        z
          .object({
            ids: z.array(z.string().min(1).max(128)).min(1).max(100),
            groupId: z.string().min(1).max(128).nullable(),
          })
          .strict(),
      )
      .mutation(({ input }) =>
        this.trpcService.moveFeeds(input.ids, input.groupId),
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
    addCapability: this.trpcService.protectedProcedure
      .input(
        z
          .object({ source: z.enum(['native', 'wechat2rss']).optional() })
          .strict()
          .optional(),
      )
      .query(({ input }) =>
        this.trpcService.subscriptionAddCapability(input?.source),
      ),
    repairNativeSource: this.trpcService.protectedProcedure
      .input(
        z
          .object({
            feedId: z.string().regex(/^MP_WXS_\d{5,15}$/),
            accountId: z.string().regex(/^\d{1,20}$/),
            confirmed: z.literal(true),
          })
          .strict(),
      )
      .mutation(({ input, ctx }) =>
        this.trpcService.repairExistingSubscription(
          input.feedId,
          input.accountId,
          !!(ctx as any).isLocal,
        ),
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
    addFromArticle: this.trpcService.protectedProcedure
      .input(
        z.object({
          articleUrl: z.string().url().max(4096),
          source: z.enum(['native', 'wechat2rss']).optional(),
          accountId: z
            .string()
            .regex(/^\d{1,20}$/)
            .optional(),
        }),
      )
      .mutation(async ({ input, ctx }) =>
        this.trpcService.addSubscriptionFromArticle(
          input.articleUrl,
          input.accountId,
          !!(ctx as any).isLocal,
          input.source,
        ),
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
      .input(
        z
          .array(
            z
              .object({
                id: z.string().min(1).max(128),
                order: z
                  .number()
                  .int()
                  .nonnegative()
                  .max(Number.MAX_SAFE_INTEGER),
                expectedOrder: z.number().int().nonnegative().optional(),
                expectedGroupId: z
                  .string()
                  .min(1)
                  .max(128)
                  .nullable()
                  .optional(),
              })
              .strict(),
          )
          .min(1)
          .max(1000),
      )
      .mutation(({ input }) => this.trpcService.reorderFeeds(input)),
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
    searchStatus: this.trpcService.protectedProcedure.query(() =>
      bodySearchCoverage(this.prismaService),
    ),
    prepareSearch: this.trpcService.protectedProcedure.mutation(() =>
      prepareBodySearch(this.prismaService),
    ),
    supplementSavedMedia: this.trpcService.protectedProcedure
      .input(z.object({ ids: savedMediaIds }).strict())
      .mutation(({ input, ctx }) => {
        if (!(ctx as any).isLocal) throw new TRPCError({ code: 'FORBIDDEN' });
        return this.trpcService.supplementSavedArticleMedia(input.ids);
      }),
    exportIds: this.trpcService.protectedProcedure
      .input(articleFilterSchema)
      .query(async ({ input }) => {
        // One frozen identity list avoids live cursor drift during a long export.
        const items = input.search?.trim()
          ? await findBodySearchIds(this.prismaService, input, 5001, true)
          : await this.prismaService.article.findMany({
              where: articleListWhere(input),
              orderBy: [{ publishTime: 'desc' }, { id: 'asc' }],
              select: { id: true },
              take: 5001,
            });
        if (items.length > 5000)
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: '当前筛选超过5000篇，请缩小日期范围。',
          });
        return items.map((item) => item.id);
      }),
    summary: this.trpcService.protectedProcedure
      .input(articleFilterSchema)
      .query(async ({ input }) => {
        if (input.search?.trim())
          return bodySearchSummary(this.prismaService, input);
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
          {
            databaseUrl: process.env.DATABASE_URL,
            search: input.search?.trim() ? input : undefined,
          },
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
        const { lastBodyRetry, ...publicArticle } = article;
        return {
          ...publicArticle,
          bodyCached: Boolean(article.contentHtml),
          bodyRetry: bodyRetryAvailability(article, !!(ctx as any).isLocal),
          bodyRetryResult: readBodyRetryResult(lastBodyRetry),
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

    saveToObsidianBatch: this.trpcService.protectedProcedure
      .input(
        z
          .object({
            ids: z
              .array(z.string().min(1).max(200))
              .min(1)
              .max(LOCAL_EXPORT_BATCH_LIMIT),
          })
          .strict(),
      )
      .mutation(async ({ input, ctx }) => {
        if (privateOnlineMode())
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: '线上站点只支持浏览器 ZIP 下载',
          });
        const { obsidianPath } =
          this.configService.get<ConfigurationType['feed']>('feed')!;
        return saveCachedArticleBatch(
          this.prismaService,
          input.ids,
          obsidianPath,
          () => Boolean((ctx as any).isExportCancelled?.()),
          true,
        );
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
      undefined,
      undefined,
      undefined,
      undefined,
      { includeSourceLink: false },
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

  xiaohongshuRouter = this.trpcService.router({
    connectionStatus: this.trpcService.protectedProcedure.query(({ ctx }) => {
      this.requireLocalXhsConnection(ctx, true);
      return this.xhsRuntime!.connectionStatus();
    }),
    connectSession: this.trpcService.protectedProcedure
      .input(
        z
          .object({
            a1: z.string().min(1).max(8192),
            webSession: z.string().min(1).max(8192),
            persist: z.boolean().optional(),
          })
          .strict(),
      )
      .mutation(async ({ input, ctx }) => {
        this.requireLocalXhsConnection(ctx);
        try {
          return await this.xhsRuntime!.connectSession(input);
        } catch (error) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: xhsPublicCode(error, 'XHS_CONNECTION_FAILED'),
          });
        }
      }),
    restoreSession: this.trpcService.protectedProcedure.mutation(
      async ({ ctx }) => {
        this.requireLocalXhsConnection(ctx);
        try {
          return await this.xhsRuntime!.restoreSession();
        } catch (error) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: xhsPublicCode(error, 'XHS_CONNECTION_FAILED'),
          });
        }
      },
    ),
    disconnectSession: this.trpcService.protectedProcedure.mutation(
      ({ ctx }) => {
        this.requireLocalXhsConnection(ctx);
        return this.xhsRuntime!.disconnectSession();
      },
    ),
    sourceRequestBudget: this.trpcService.protectedProcedure
      .input(
        z.discriminatedUnion('purpose', [
          z.object({ purpose: z.literal('resolution') }).strict(),
          z
            .object({
              purpose: z.literal('original-link'),
              creatorId: z.string().min(1).max(128),
            })
            .strict(),
        ]),
      )
      .query(({ input, ctx }) => {
        this.requireLocalXhsConnection(ctx, true);
        return this.xhsSourceOperation(() =>
          readXhsSourceBudget(this.prismaService, input),
        );
      }),
    configureSourceRequestBudget: this.trpcService.protectedProcedure
      .input(
        z
          .object({
            scope: z.discriminatedUnion('purpose', [
              z.object({ purpose: z.literal('resolution') }).strict(),
              z
                .object({
                  purpose: z.literal('original-link'),
                  creatorId: z.string().min(1).max(128),
                })
                .strict(),
            ]),
            totalLimit: z.number().int().min(1).max(100000),
            intervalMs: z.number().int().min(1000).max(60000),
          })
          .strict(),
      )
      .mutation(({ input, ctx }) => {
        this.requireLocalXhsConnection(ctx);
        return this.xhsSourceOperation(() =>
          configureXhsSourceBudget(
            this.prismaService,
            input.scope,
            input.totalLimit,
            input.intervalMs,
          ),
        );
      }),
    prepareOriginalLink: this.trpcService.protectedProcedure
      .input(
        z
          .object({
            noteId: z.string().min(1).max(300),
            budgetId: z.string().min(1).max(256).optional(),
            refreshContext: z.boolean().optional(),
          })
          .strict(),
      )
      .mutation(({ input, ctx }) => {
        this.requireLocalXhsConnection(ctx);
        return prepareXhsOriginalLink(
          this.prismaService,
          this.xhsRuntime!,
          input,
        );
      }),
    recoverSingleNote: this.trpcService.protectedProcedure
      .input(
        z
          .object({
            url: z.string().min(1).max(8192),
            expectedAuthorId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
            confirmLimitedRecovery: z.literal(true),
            appendUnknownAttempt: z.literal(true).optional(),
          })
          .strict(),
      )
      .mutation(({ input, ctx }) => {
        this.requireLocalXhsConnection(ctx);
        return this.xhsSourceOperation(async () => {
          const result = await this.xhsRuntime!.resolveLimitedRecovery(
            input.url,
            input.expectedAuthorId,
            (ctx as { isExportCancelled?: () => boolean }).isExportCancelled,
            input.appendUnknownAttempt === true,
          );
          const saved =
            await this.xhsSubscriptions!.commitLimitedRecovery(result);
          return { ...saved, originalUrl: result.originalUrl };
        });
      }),
    startSubscriptionBatch: this.trpcService.protectedProcedure
      .input(
        z
          .object({
            clientRequestId: z.string().uuid(),
            text: z.string().min(1).max(65536),
            groupId: z.string().min(1).max(128).optional(),
          })
          .strict(),
      )
      .mutation(({ input, ctx }) => {
        this.requireLocalXhsConnection(ctx);
        return this.xhsSourceOperation(() => this.xhsBatch!.start(input));
      }),
    subscriptionBatch: this.trpcService.protectedProcedure
      .input(z.object({ batchId: z.string().uuid() }).strict())
      .query(({ input, ctx }) => {
        this.requireLocalXhsConnection(ctx, true);
        return this.xhsSourceOperation(() => this.xhsBatch!.status(input));
      }),
    resumeSubscriptionBatch: this.trpcService.protectedProcedure
      .input(
        z
          .object({
            batchId: z.string().uuid(),
            text: z.string().min(1).max(65536),
          })
          .strict(),
      )
      .mutation(({ input, ctx }) => {
        this.requireLocalXhsConnection(ctx);
        return this.xhsSourceOperation(() => this.xhsBatch!.resume(input));
      }),
    cancelSubscriptionBatch: this.trpcService.protectedProcedure
      .input(z.object({ batchId: z.string().uuid() }).strict())
      .mutation(({ input, ctx }) => {
        this.requireLocalXhsConnection(ctx);
        return this.xhsSourceOperation(() => this.xhsBatch!.cancel(input));
      }),
    resolveSubscription: this.trpcService.protectedProcedure
      .input(
        z
          .object({
            url: z.string().min(1).max(8192),
            budgetId: z.string().min(1).max(256).optional(),
          })
          .strict(),
      )
      .mutation(({ input, ctx }) => {
        this.requireLocalXhsConnection(ctx);
        return this.xhsSourceOperation(() =>
          resolveXhsSubscriptionWithBudget(
            this.prismaService,
            this.xhsRuntime!,
            this.xhsSubscriptions!,
            input,
          ),
        );
      }),
    subscribe: this.trpcService.protectedProcedure
      .input(
        z
          .object({
            resolutionId: z.string().uuid(),
            groupId: z.string().min(1).max(128).optional(),
          })
          .strict(),
      )
      .mutation(({ input }) => this.xhsSubscriptions!.subscribe(input)),
    downloadNotes: this.trpcService.protectedProcedure
      .input(
        z
          .object({
            creatorId: z.string().min(1).max(128),
            noteIds: z.array(z.string().min(1).max(300)).min(1),
            pickToken: z.string().max(128).optional(),
          })
          .strict(),
      )
      .mutation(({ input, ctx }) => {
        if (
          !(ctx as { isLocalSave?: boolean }).isLocalSave ||
          privateOnlineMode() ||
          process.env.WEWE_ACCEPTANCE_MODE === '1'
        )
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: '本地下载仅允许本机使用。',
          });
        return this.xhsSubscriptions!.downloadNotes(input);
      }),
    task: this.trpcService.protectedProcedure
      .input(z.object({ taskId: z.string().uuid() }).strict())
      .query(({ input }) => this.xhsSubscriptions!.task(input)),
    recentTasks: this.trpcService.protectedProcedure
      .input(
        z
          .object({
            creatorId: z.string().min(1).max(128).optional(),
            limit: z.number().int().min(1).max(20).optional(),
          })
          .strict()
          .optional(),
      )
      .query(({ input }) => this.xhsSubscriptions!.recentTasks(input)),
    cancelTask: this.trpcService.protectedProcedure
      .input(z.object({ taskId: z.string().uuid() }).strict())
      .mutation(({ input }) => this.xhsSubscriptions!.cancelTask(input)),
    resumeTask: this.trpcService.protectedProcedure
      .input(
        z
          .object({
            taskId: z.string().uuid(),
            pickToken: z.string().max(128).optional(),
          })
          .strict(),
      )
      .mutation(({ input, ctx }) => {
        if (
          !(ctx as { isLocalSave?: boolean }).isLocalSave ||
          privateOnlineMode() ||
          process.env.WEWE_ACCEPTANCE_MODE === '1'
        )
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: '任务续跑仅允许本机同源页面使用。',
          });
        return this.xhsSubscriptions!.resumeTask(input);
      }),
    capability: this.trpcService.protectedProcedure.query(() => ({
      ...this.xhs.capability(),
      ...this.xhsSubscriptions?.capability(),
    })),
    list: this.trpcService.protectedProcedure
      .input(xhsCreatorFilterSchema.optional())
      .query(({ input }) => this.xhs.list(input)),
    groups: this.trpcService.protectedProcedure.query(() => this.xhs.groups()),
    saveGroup: this.trpcService.protectedProcedure
      .input(
        z
          .object({
            id: z.string().min(1).max(128).optional(),
            name: z.string().trim().min(1).max(80),
          })
          .strict(),
      )
      .mutation(({ input }) => this.xhs.saveGroup(input)),
    removeGroup: this.trpcService.protectedProcedure
      .input(z.object({ id: z.string().min(1).max(128) }).strict())
      .mutation(({ input }) => this.xhs.removeGroup(input.id)),
    moveCreators: this.trpcService.protectedProcedure
      .input(
        z
          .object({
            ids: z.array(z.string().min(1).max(128)).min(1).max(100),
            groupId: z.string().min(1).max(128).nullable(),
          })
          .strict(),
      )
      .mutation(({ input }) => this.xhs.moveCreators(input.ids, input.groupId)),
    add: this.trpcService.protectedProcedure
      .input(
        z
          .object({
            displayName: z.string().trim().min(1).max(120),
            profileUrl: z.string().max(2000),
          })
          .strict(),
      )
      .mutation(({ input }) =>
        this.xhs.add(input.displayName, input.profileUrl),
      ),
    edit: this.trpcService.protectedProcedure
      .input(
        z
          .object({ id: z.string().min(1).max(128), enabled: z.boolean() })
          .strict(),
      )
      .mutation(({ input }) => this.xhs.edit(input.id, input.enabled)),
    remove: this.trpcService.protectedProcedure
      .input(z.object({ id: z.string().min(1).max(128) }).strict())
      .mutation(({ input }) => this.xhs.remove(input.id)),
    notes: this.trpcService.protectedProcedure
      .input(xhsNoteFilterSchema)
      .query(({ input }) => this.xhs.notes(input.creatorId, input)),
    engagement: this.trpcService.protectedProcedure
      .input(
        z
          .object({
            creatorId: z.string().min(1).max(128),
            noteId: z.string().min(1).max(300),
            offset: z.number().int().min(0).max(1000000).optional(),
            limit: z.number().int().min(1).max(200).optional(),
          })
          .strict(),
      )
      .query(({ input }) => this.xhs.engagement(input)),
    collectComments: this.trpcService.protectedProcedure
      .input(
        z
          .object({
            creatorId: z.string().min(1).max(128),
            noteId: z.string().min(1).max(300),
            rootId: z
              .string()
              .regex(/^[a-zA-Z0-9_-]{1,128}$/)
              .optional(),
            maxPages: z.number().int().min(1).max(5),
            maxItems: z.number().int().min(1).max(200),
            restart: z.boolean().optional(),
          })
          .strict(),
      )
      .mutation(({ input, ctx }) => {
        this.requireLocalXhsAccess(ctx);
        return this.xhsEngagement!.collect(input);
      }),
    prepareWholeCreatorGeneration: this.trpcService.protectedProcedure
      .input(z.object({ jobId:z.string().min(1).max(128), profileUrl:z.string().min(1).max(8192), confirmUnknown:z.literal(true),
        phaseLimits:z.object({profile:z.number().int().nonnegative(),list:z.number().int().nonnegative(),detail:z.number().int().nonnegative(),media:z.number().int().nonnegative(),metrics:z.number().int().nonnegative()}).strict() }).strict())
      .mutation(({input,ctx})=>{this.requireLocalXhsAccess(ctx);return this.xhsSourceOperation(()=>this.xhsWhole!.prepareGeneration(input));}),
    executeWholeCreatorGeneration: this.trpcService.protectedProcedure
      .input(z.object({jobId:z.string().min(1).max(128),generationId:z.string().uuid(),confirmUnknown:z.literal(true)}).strict())
      .mutation(({input,ctx})=>{this.requireLocalXhsAccess(ctx);return this.xhsSourceOperation(()=>this.xhsWhole!.executeGeneration(input));}),
    prepareWholeCreatorReviewedAttempt: this.trpcService.protectedProcedure
      .input(z.object({jobId:z.string().min(1).max(128),confirmUnknownRetry:z.literal(true),confirmLegacyUnknown:z.literal(true).optional()}).strict())
      .mutation(({input,ctx})=>{this.requireLocalXhsAccess(ctx);return this.xhsSourceOperation(()=>this.xhsWhole!.prepareReviewedAttempt(input));}),
    executeWholeCreatorReviewedAttempt: this.trpcService.protectedProcedure
      .input(z.object({jobId:z.string().min(1).max(128),attemptId:z.string().regex(/^[a-f0-9]{64}$/),url:z.string().min(1).max(8192),confirmUnknownRetry:z.literal(true)}).strict())
      .mutation(({input,ctx})=>{this.requireLocalXhsAccess(ctx);return this.xhsSourceOperation(()=>this.xhsWhole!.executeReviewedAttempt(input));}),
    reviewWholeCreatorUnknown: this.trpcService.protectedProcedure
      .input(z.object({jobId:z.string().min(1).max(128),expectedAuthorId:z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),expectedMarker:z.string().regex(/^xhs:dispatch-pending:whole:[a-f0-9-]{36}$/),expectedNoteId:z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),decision:z.enum(['defer','request-retry'])}).strict())
      .mutation(({input,ctx}) => {
        this.requireLocalXhsAccess(ctx);
        return this.xhsWhole!.reviewUnknown(input);
      }),
    wholeCreatorJobs: this.trpcService.protectedProcedure
      .input(z.object({ creatorId: z.string().min(1).max(128) }).strict())
      .query(({ input, ctx }) => {
        this.requireLocalXhsAccess(ctx, true);
        return this.xhsWhole!.recent(input.creatorId);
      }),
    startWholeCreator: this.trpcService.protectedProcedure
      .input(
        z
          .object({
            creatorId: z.string().min(1).max(128),
            requestLimit: z.number().int().min(1).max(100000),
            intervalMs: z.number().int().min(1000).max(60000),
          })
          .strict(),
      )
      .mutation(({ input, ctx }) => {
        this.requireLocalXhsAccess(ctx);
        return this.xhsWhole!.start(input);
      }),
    prepareWholeCreatorHistoryGrant: this.trpcService.protectedProcedure
      .input(
        z
          .object({
            creatorId: z.string().min(1).max(128),
            expectedAuthorId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
            jobId: z.string().uuid().optional(),
            requestLimit: z.number().int().min(1).max(100000),
            intervalMs: z.number().int().min(1000).max(60000),
            phaseLimits: z
              .object({
                profile: z.number().int().nonnegative(),
                list: z.number().int().nonnegative(),
                detail: z.number().int().nonnegative(),
                media: z.number().int().nonnegative(),
                metrics: z.number().int().nonnegative(),
              })
              .strict(),
            confirmHistoryGrant: z.literal(true),
          })
          .strict(),
      )
      .mutation(({ input, ctx }) => {
        this.requireLocalXhsAccess(ctx);
        return this.xhsSourceOperation(() =>
          this.xhsWhole!.prepareHistoryGrant(input),
        );
      }),
    extendWholeCreatorHistoryPhase: this.trpcService.protectedProcedure
      .input(
        z
          .object({
            id: z.string().uuid(),
            phase: z.enum(['profile', 'list', 'detail', 'media', 'metrics']),
            newLimit: z.number().int().min(1).max(100000),
            confirmHistoryGrant: z.literal(true),
          })
          .strict(),
      )
      .mutation(({ input, ctx }) => {
        this.requireLocalXhsAccess(ctx);
        return this.xhsSourceOperation(() =>
          this.xhsWhole!.extendHistoryPhase(input),
        );
      }),
    resumeWholeCreator: this.trpcService.protectedProcedure
      .input(z.object({ id: z.string().uuid() }).strict())
      .mutation(({ input, ctx }) => {
        this.requireLocalXhsAccess(ctx);
        return this.xhsWhole!.resume(input.id);
      }),
    extendWholeCreatorBudget: this.trpcService.protectedProcedure
      .input(
        z
          .object({
            id: z.string().uuid(),
            additional: z.number().int().min(1).max(100000),
          })
          .strict(),
      )
      .mutation(({ input, ctx }) => {
        this.requireLocalXhsAccess(ctx);
        return this.xhsWhole!.extend(input.id, input.additional);
      }),
    cancelWholeCreator: this.trpcService.protectedProcedure
      .input(z.object({ id: z.string().uuid() }).strict())
      .mutation(({ input, ctx }) => {
        this.requireLocalXhsAccess(ctx);
        return this.xhsWhole!.cancel(input.id);
      }),
    refreshMetrics: this.trpcService.protectedProcedure
      .input(
        z
          .object({
            creatorId: z.string().min(1).max(128),
            noteId: z.string().min(1).max(300).optional(),
          })
          .strict(),
      )
      .mutation(({ input, ctx }) => {
        this.requireLocalXhsAccess(ctx);
        return this.xhsEngagement!.refreshMetrics(input);
      }),
    refresh: this.trpcService.protectedProcedure
      .input(
        z
          .object({
            id: z.string().min(1).max(128),
            maxPages: z.number().int().min(1).max(10).optional(),
          })
          .strict(),
      )
      .mutation(({ input, ctx }) => {
        this.requireLocalXhsAccess(ctx);
        return this.xhsSubscriptions!.refresh(input);
      }),
    export: this.trpcService.protectedProcedure
      .input(
        z
          .object({
            creatorId: z.string().min(1).max(128).optional(),
            groupId: z.string().min(1).max(128).nullable().optional(),
            ...xhsNumericFilterShape,
            search: articleFilterShape.search,
            dateStart: articleFilterShape.dateStart,
            dateEnd: articleFilterShape.dateEnd,
            noteIds: z
              .array(z.string().min(1).max(300))
              .min(1)
              .max(100)
              .optional(),
          })
          .strict()
          .refine(orderedArticleDates)
          .refine(xhsNumericRange),
      )
      .mutation(({ input }) =>
        this.xhs.export(input.creatorId, input.noteIds, input),
      ),
  });

  appRouter = this.trpcService.router({
    feed: this.feedRouter,
    account: this.accountRouter,
    article: this.articleRouter,
    platform: this.platformRouter,
    collection: this.collectionRouter,
    xiaohongshu: this.xiaohongshuRouter,
  });

  async applyMiddleware(app: INestApplication) {
    app.use(
      `/trpc`,
      trpcExpress.createExpressMiddleware({
        router: this.appRouter,
        createContext: ({ req, res }) => {
          if (
            req.url
              .split('?')[0]
              .split(',')
              .some(
                (name) =>
                  name.endsWith('xiaohongshu.prepareOriginalLink') ||
                  name.endsWith('xiaohongshu.recoverSingleNote'),
              )
          ) {
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('Referrer-Policy', 'no-referrer');
          }
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
            // A disconnected download stops after the current atomic article.
            isExportCancelled: () => res.destroyed,
            // Browser same-origin GETs omit Origin. This flag grants status
            // reads only; mutations still require explicit same-origin proof.
            isLocalXhsRead: isLocalXhsStatusRequest({
              method: req.method,
              protocol: req.protocol,
              host: req.get('host') || '',
              remoteAddress: req.socket.remoteAddress,
              origin: req.headers.origin,
            }),
            isLocalSave:
              ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(
                req.socket.remoteAddress || '',
              ) &&
              /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(
                `${req.protocol}://${req.get('host')}`,
              ) &&
              req.headers.origin === `${req.protocol}://${req.get('host')}`,
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
