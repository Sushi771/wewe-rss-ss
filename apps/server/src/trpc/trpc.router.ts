import { buildArticleMarkdown } from '../article-export';
import { findArticleListRows } from '../article-list-page';
import { INestApplication, Injectable, Logger, Optional } from '@nestjs/common';
import { XiaohongshuService } from '../collection/xiaohongshu.service';
import { z } from 'zod';
import {
  AccountSchemas,
  ArticleSchemas,
  FeedSchemas,
  PlatformSchemas,
} from '@wewe-rss/shared';
import { TrpcService } from '@server/trpc/trpc.service';
import * as trpcExpress from '@trpc/server/adapters/express';
import { TRPCError } from '@trpc/server';
import { PrismaService } from '@server/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { ConfigurationType } from '@server/configuration';
import dayjs from 'dayjs';
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

@Injectable()
export class TrpcRouter {
  constructor(
    private readonly trpcService: TrpcService,
    private readonly prismaService: PrismaService,
    private readonly configService: ConfigService,
    private readonly wereadService: WereadService,
    private readonly collectionService: CollectionService,
    @Optional() private readonly xiaohongshuService?: XiaohongshuService,
  ) {}

  private get xhs() {
    return (
      this.xiaohongshuService ?? new XiaohongshuService(this.prismaService)
    );
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
  async buildOfflineFeedDirectory(feedId: string, directory: string) {
    const feed = await this.prismaService.feed.findUnique({
      where: { id: feedId },
    });
    if (!feed) return null;
    const articles = await this.prismaService.article.findMany({
      where: { mpId: feedId },
      orderBy: [{ publishTime: 'desc' }, { id: 'asc' }],
      select: { id: true, title: true, sourceUrl: true, contentHtml: true },
    });
    if (articles.length > 5000) throw new Error('离线导出文章超过上限');
    await fs.promises.mkdir(directory, { recursive: true });
    let complete = 0;
    const incomplete: string[] = [];
    for (const [index, article] of articles.entries()) {
      const safeTitle =
        article.title
          .replace(/[\\/:*?"<>|\x00-\x1f]/g, '-')
          .replace(/[. ]+$/g, '')
          .slice(0, 75) || '未命名';
      const relative = `articles/${String(index + 1).padStart(4, '0')}-${safeTitle}`;
      const articleDirectory = path.join(directory, relative);
      await fs.promises.mkdir(articleDirectory, { recursive: true });
      let markdown: string;
      if (article.contentHtml) {
        try {
          markdown = (
            await this.getArticleMarkdown(article.id, articleDirectory)
          ).markdown;
          complete++;
        } catch {
          incomplete.push(relative);
          markdown = `# ${article.title}\n\n正文或图片未能完整归档，本篇未通过离线验收。\n\n原文：${article.sourceUrl || '未记录'}\n`;
        }
      } else {
        incomplete.push(relative);
        markdown = `# ${article.title}\n\n正文尚未缓存，本篇无法离线阅读。\n\n原文：${article.sourceUrl || '未记录'}\n`;
      }
      await fs.promises.writeFile(
        path.join(articleDirectory, 'index.md'),
        markdown,
      );
    }
    await fs.promises.writeFile(
      path.join(directory, 'README.md'),
      `# ${feed.mpName}\n\n共 ${articles.length} 篇；正文与图片离线完整 ${complete} 篇；未完整 ${incomplete.length} 篇。\n\n` +
        '文章位于 articles/ 下，每篇的图片路径相对其 index.md。未完整篇目在各自文件中明确标注。\n',
    );
    return {
      name: feed.mpName,
      articles: articles.length,
      complete,
      incomplete,
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
        await this.prismaService.feed.delete({ where: { id } });
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
      .input(z.array(z.string()))
      .mutation(async ({ input: ids }) => {
        await this.prismaService.feed.deleteMany({
          where: {
            id: {
              in: ids,
            },
          },
        });
        return ids;
      }),

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
    summary: this.trpcService.protectedProcedure
      .input(
        z.object({
          mpId: z.string().optional(),
          search: z.string().optional(),
        }),
      )
      .query(async ({ input }) => {
        const where = {
          mpId: input.mpId || undefined,
          ...(input.search
            ? {
                OR: [
                  { title: { contains: input.search } },
                  { feed: { mpName: { contains: input.search } } },
                ],
              }
            : {}),
        };
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
        const { cursor, mpId, search } = input;

        const where: any = {};
        if (mpId) where.mpId = mpId;
        if (search) {
          where.OR = [
            { title: { contains: search } },
            { feed: { mpName: { contains: search } } },
          ];
        }

        const items = await findArticleListRows(this.prismaService, {
          orderBy: [
            {
              [input.sort || 'publishTime']: 'desc',
            },
            { id: 'desc' },
          ],
          take: limit + 1,
          where,
          cursor: cursor
            ? {
                id: cursor,
              }
            : undefined,
        });
        let nextCursor: typeof cursor | undefined = undefined;
        if (items.length > limit) {
          // Remove the last item and use it as next cursor

          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          const nextItem = items.pop()!;
          nextCursor = nextItem.id;
        }

        return {
          items: items.map((item) => ({
            ...item,
            bodyRetry: bodyRetryAvailability(item, !!(ctx as any).isLocal),
            bodyRetryResult: readBodyRetryResult(item.lastBodyRetry),
          })),
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
        await this.prismaService.article.delete({ where: { id } });
        return id;
      }),
    exportMarkdown: this.trpcService.protectedProcedure
      .input(z.string())
      .mutation(async ({ input: id }) => {
        try {
          const { markdown, title } = await this.getArticleMarkdown(id);
          // Browser Markdown must not overwrite an Obsidian file with proxy image URLs.
          return { markdown, title };
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
          const dateFolder = dayjs().format('YYYY-MM-DD');
          const finalPath = path.join(obsidianPath, dateFolder);
          const { markdown, title } = await this.getArticleMarkdown(
            id,
            finalPath,
          );

          if (!fs.existsSync(finalPath)) {
            await fs.promises.mkdir(finalPath, { recursive: true });
          }

          const safeTitle = title.replace(/[\\/:*?"<>|]/g, '-').slice(0, 100);
          const filePath = path.join(finalPath, `${safeTitle}-${id}.md`);

          await fs.promises.writeFile(filePath, markdown);

          return { success: true, path: filePath };
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
    });
    if (!article) throw new Error(`No article with id '${id}'`);
    const { originUrl } = this.configService.get('feed');
    return buildArticleMarkdown(
      article,
      originUrl || 'http://localhost:4000',
      downloadPath,
    );
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
    capability: this.trpcService.protectedProcedure.query(() =>
      this.xhs.capability(),
    ),
    list: this.trpcService.protectedProcedure.query(() => this.xhs.list()),
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
      .input(z.object({ creatorId: z.string().min(1).max(128) }).strict())
      .query(({ input }) => this.xhs.notes(input.creatorId)),
    body: this.trpcService.protectedProcedure
      .input(
        z
          .object({
            creatorId: z.string().min(1).max(128),
            noteId: z.string().min(1).max(300),
          })
          .strict(),
      )
      .query(({ input }) => this.xhs.body(input.creatorId, input.noteId)),
    refresh: this.trpcService.protectedProcedure
      .input(z.object({ id: z.string().min(1).max(128) }).strict())
      .mutation(({ input }) => this.xhs.refresh(input.id)),
    export: this.trpcService.protectedProcedure
      .input(z.object({ creatorId: z.string().min(1).max(128) }).strict())
      .mutation(({ input }) => this.xhs.export(input.creatorId)),
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
