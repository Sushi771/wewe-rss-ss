import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConfigurationType } from '@server/configuration';
import { statusMap } from '@server/constants';
import { PrismaService } from '@server/prisma/prisma.service';
import { TRPCError, initTRPC } from '@trpc/server';
import Axios, { AxiosInstance } from 'axios';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import { CollectionService } from '../collection/collection.service';
import { wechat2RssProvider } from '../collection/provider-registry';
import { Wechat2RssProvider } from '../collection/providers/wechat2rss';
import { createVerifiedSqliteBackup } from '../collection/sqlite-backup';
import { wechat2RssAddReceipt } from '../collection/wechat2rss-add-receipt';
import { canonicalArticleUrl } from '../collection/collection-format';
import {
  managementGroups,
  saveManagementGroup,
  removeManagementGroup,
  moveManagementMembers,
  managementMemberIds,
} from '../collection/xiaohongshu.service';
import {
  addNativeSubscription,
  repairNativeSubscription,
  SUBSCRIPTION_DISCOVERY,
  subscriptionArticleUrl,
  subscriptionDiscoveryUnavailable,
  SubscriptionDiscoveryValidator,
} from '../collection/subscription-add';
import { BodyRetryBlockedError } from '../collection/article-body-retry';
import { Feed } from '@prisma/client';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { ownerSessionCookie } from '../collection/owner-web-search';
import {
  saveNativeAccountSession,
  saveNativeAccountProfile,
} from '../collection/owner-weread-binding';
import {
  CollectionRoute,
  parseBoundAlbumIds,
  resolveCollectionRoute,
} from '../collection/collection-channel';

dayjs.extend(utc);
dayjs.extend(timezone);

type SubscriptionAddSource = 'native' | 'wechat2rss';

/**
 * 读书账号每日小黑屋
 */
const blockedAccountsMap = new Map<string, string[]>();

import {
  WereadService,
  TokenInvalidError,
} from '@server/weread/weread.service';

@Injectable()
export class TrpcService {
  groups() {
    return managementGroups(this.prismaService, 'wechat');
  }
  saveGroup(input: { id?: string; name: string }) {
    return saveManagementGroup(this.prismaService, 'wechat', input);
  }
  removeGroup(id: string) {
    return removeManagementGroup(this.prismaService, 'wechat', id);
  }
  async moveFeeds(ids: string[], groupId: string | null) {
    const unique = managementMemberIds(ids);
    if (unique.some((id) => this.activeCollections.has(id)))
      throw new TRPCError({
        code: 'CONFLICT',
        message: '公众号正在处理，请等待完成后移动。',
      });
    unique.forEach((id) => this.activeCollections.add(id));
    try {
      return await moveManagementMembers(
        this.prismaService,
        'wechat',
        unique,
        groupId,
      );
    } finally {
      unique.forEach((id) => this.activeCollections.delete(id));
    }
  }
  trpc = initTRPC.create();
  publicProcedure = this.trpc.procedure;
  protectedProcedure = this.trpc.procedure.use(({ ctx, next, type, path }) => {
    const errorMsg = (ctx as any).errorMsg;
    if (errorMsg) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: errorMsg });
    }
    // Read/export trial uses the original UI but never replays cached discovery
    // under an update button or sends other subscriptions' live requests.
    if (
      process.env.WEWE_ACCEPTANCE_MODE === '1' &&
      type === 'mutation' &&
      !['article.exportMarkdown', 'article.saveToObsidian'].includes(path)
    )
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message:
          '隔离测试：普通更新尚未接通，未发联网请求。已核验原文缓存2篇，近期待核验3篇；原文来源受腾讯官方验证限制，已有正文保持。',
      });
    return next({ ctx });
  });
  router = this.trpc.router;
  mergeRouters = this.trpc.mergeRouters;
  request: AxiosInstance;
  updateDelayTime = 60;

  private readonly logger = new Logger(this.constructor.name);

  constructor(
    private readonly prismaService: PrismaService,
    private readonly configService: ConfigService,
    private readonly wereadService: WereadService,
    private readonly collectionService: CollectionService,
    @Optional()
    @Inject(SUBSCRIPTION_DISCOVERY)
    private readonly subscriptionDiscovery?: SubscriptionDiscoveryValidator,
  ) {
    const { url } =
      this.configService.get<ConfigurationType['platform']>('platform')!;
    this.updateDelayTime =
      this.configService.get<ConfigurationType['feed']>(
        'feed',
      )!.updateDelayTime;

    this.request = Axios.create({ baseURL: url, timeout: 30 * 1e3 });

    this.request.interceptors.response.use(
      (response) => {
        return response;
      },
      async (error) => {
        const errMsg = error.response?.data?.message || '';
        const id = (error.config?.headers as any)?.xid;

        const blockAccountIfNeeded = () => {
          if (id) {
            const today = this.getTodayDate();
            const blockedAccounts = blockedAccountsMap.get(today) ?? [];
            if (!blockedAccounts.includes(id)) {
              blockedAccounts.push(id);
            }
            blockedAccountsMap.set(today, blockedAccounts);
          }
        };

        if (errMsg.includes('WeReadError401')) {
          // Token 永久失效，写库禁用，并抛出特殊错误阻止重试
          if (id) {
            await this.prismaService.account
              .update({
                where: { id },
                data: { status: statusMap.INVALID },
              })
              .catch(() => {
                /* 账号可能不存在，忽略 */
              });
            this.logger.error(
              `账号（${id}）登录失效，已禁用，请在账号页面重新登录`,
            );
          }
          blockAccountIfNeeded();
          return Promise.reject(new TokenInvalidError(id ?? 'unknown'));
        } else if (errMsg.includes('WeReadError429')) {
          this.logger.warn(`账号（${id}）请求频繁，已加入今日小黑屋`);
          blockAccountIfNeeded();
        } else if (errMsg.includes('WeReadError400')) {
          this.logger.error(`账号（${id}）处理请求参数出错: ${errMsg}`);
          // 10s 后重试
          await new Promise((resolve) => setTimeout(resolve, 10 * 1e3));
        } else if (
          error.code === 'ECONNABORTED' ||
          error.message.includes('timeout')
        ) {
          this.logger.warn(`账号（${id}）请求超时 (15s+)，将自动重试`);
          // 超时不封号，直接进入重试逻辑
        } else if (
          error.response?.status === 502 ||
          error.response?.status === 504
        ) {
          this.logger.error(
            `微信读书中转服务异常 (${error.response.status})：上游服务器 (${error.config?.baseURL}) 无法连接或源站已离线`,
          );
        } else {
          this.logger.error(
            "Can't handle this error:",
            errMsg || error.message,
          );
        }

        return Promise.reject(error);
      },
    );
  }

  removeBlockedAccount = (vid: string) => {
    const today = this.getTodayDate();

    const blockedAccounts = blockedAccountsMap.get(today);
    if (Array.isArray(blockedAccounts)) {
      const newBlockedAccounts = blockedAccounts.filter((id) => id !== vid);
      blockedAccountsMap.set(today, newBlockedAccounts);
    }
  };

  private getTodayDate() {
    return dayjs.tz(new Date(), 'Asia/Shanghai').format('YYYY-MM-DD');
  }

  getBlockedAccountIds() {
    const today = this.getTodayDate();
    const disabledAccounts = blockedAccountsMap.get(today) || [];
    this.logger.debug('disabledAccounts: ', disabledAccounts);
    return disabledAccounts.filter(Boolean);
  }

  private async getAvailableAccount() {
    const disabledAccounts = this.getBlockedAccountIds();
    const account = await this.prismaService.account.findMany({
      where: {
        status: statusMap.ENABLE,
        NOT: {
          id: { in: disabledAccounts },
        },
      },
      take: 10,
    });

    if (!account || account.length === 0) {
      throw new Error('暂无可用读书账号!');
    }

    return account[Math.floor(Math.random() * account.length)];
  }

  async getMpArticles(
    mpId: string,
    page = 1,
    retryCount = 3,
  ): Promise<Awaited<ReturnType<WereadService['getMpArticles']>>> {
    void mpId;
    void page;
    void retryCount;
    throw new Error('旧微信读书文章接口已停用。');
  }

  async refreshMpArticlesAndUpdateFeed(
    mpId: string,
    page = 1,
    trigger: 'local-manual' | 'scheduled' | 'public' = 'public',
  ) {
    this.logger.debug(`Backend update trigger: ${trigger}`);
    let route: CollectionRoute;
    return this.recordCollectionResult(
      mpId,
      (feed) => this.refreshArticles(feed, page, route, trigger),
      (feed) => {
        route = resolveCollectionRoute(feed);
        return (
          route.channel === 'wechat2rss' ||
          route.channel === 'public-album' ||
          route.channel === 'owner-web-search' ||
          route.channel === 'owner-weread-latest'
        );
      },
    );
  }

  async collectPublicAlbums(input: { mpId: string; albumIds: string[] }) {
    return this.recordCollectionResult(
      input.mpId,
      () => this.collectionService.collectPublicAlbums(input),
      true,
    );
  }

  private readonly activeCollections = new Set<string>();

  async retryArticleBody(id: string) {
    const article = await this.prismaService.article.findUniqueOrThrow({
      where: { id },
    });
    if (this.activeCollections.has(article.mpId))
      throw new BodyRetryBlockedError(
        '该公众号正在采集或重试正文，请等待本次结束',
      );
    this.activeCollections.add(article.mpId);
    try {
      return await this.collectionService.retryArticleBody(id);
    } finally {
      this.activeCollections.delete(article.mpId);
    }
  }

  private async recordCollectionResult<
    T extends {
      source: string;
      status: string;
      complete: false;
      coverage: string;
      articles: number;
      message: string;
      bodyFetch?: { succeeded: number; unavailable: number };
      bodyCache?: { available: number; retained: number; missing: number };
      bodyUnavailable?: { id: string; cached: boolean }[];
      created?: number;
      updated?: number;
      correctedPublishTimes?: number;
      accepted?: boolean;
      bodyMissing?: number;
      imageBlocked?: number;
      pages?: number;
      albums?: Array<{
        id: string;
        title: string;
        pages: number;
        articles: number;
      }>;
    },
  >(
    mpId: string,
    collect: (feed: Feed) => Promise<T>,
    requireSqlite: boolean | ((feed: Feed) => boolean) = false,
  ): Promise<T> {
    if (this.activeCollections.has(mpId))
      throw new Error('该公众号正在采集，请等待本次结束');
    this.activeCollections.add(mpId);
    try {
      const feed = await this.prismaService.feed.findUniqueOrThrow({
        where: { id: mpId },
      });
      const sqliteRequired =
        typeof requireSqlite === 'function'
          ? requireSqlite(feed)
          : requireSqlite;
      // 包括 running/failed 状态在内，任何本次采集写入都必须晚于备份核验。
      await createVerifiedSqliteBackup({ allowMysqlSkip: !sqliteRequired });
      await this.prismaService.feed.update({
        where: { id: mpId },
        data: {
          lastCollectionResult: JSON.stringify({
            source: 'pending',
            status: 'running',
            complete: false,
            coverage: 'none',
            articles: 0,
            message: '正在采集，尚未完成更新。',
            attemptedAt: Math.floor(Date.now() / 1000),
          }),
        },
      });
      let result: T;
      try {
        result = await collect(feed);
      } catch (error: any) {
        // Never persist raw HTTP errors: their config/URL may contain credentials.
        const message =
          error?.isAxiosError || error?.options || error?.config
            ? '采集请求失败，请检查网络或上游访问状态；本次未完成更新。'
            : String(error?.message || '采集失败')
                .replace(/https?:\/\/[^\s]+/gi, '[链接已隐藏]')
                .replace(
                  /\b(token|key|pass_ticket|uin|cookie|authorization)\s*[:=]\s*[^\s,;]+/gi,
                  '$1=[已隐藏]',
                )
                .slice(0, 500);
        await this.prismaService.feed.update({
          where: { id: mpId },
          data: {
            lastCollectionResult: JSON.stringify({
              source: 'error',
              status: 'failed',
              complete: false,
              coverage: 'none',
              articles: 0,
              message,
              attemptedAt: Math.floor(Date.now() / 1000),
            }),
          },
        });
        throw new Error(message);
      }
      await this.prismaService.feed.update({
        where: { id: mpId },
        data: {
          lastCollectionResult: JSON.stringify({
            source: result.source,
            status: result.status,
            complete: result.complete,
            coverage: result.coverage,
            articles: result.articles,
            message: result.message,
            bodyFetch: result.bodyFetch,
            bodyCache: result.bodyCache,
            bodyUnavailable: result.bodyUnavailable,
            created: result.created,
            updated: result.updated,
            correctedPublishTimes: result.correctedPublishTimes,
            accepted: result.accepted,
            bodyMissing: result.bodyMissing,
            imageBlocked: result.imageBlocked,
            pages: result.pages,
            albums: result.albums,
            attemptedAt: Math.floor(Date.now() / 1000),
          }),
        },
      });
      return result;
    } finally {
      this.activeCollections.delete(mpId);
    }
  }

  private async refreshArticles(
    feed: Feed,
    page: number,
    route: CollectionRoute,
    trigger: 'local-manual' | 'scheduled' | 'public',
  ) {
    const mpId = feed.id;
    if (route.channel === 'owner-weread-latest') {
      if (page !== 1) throw new Error('读书最新篇来源不提供分页');
      return this.collectionService.collectOwnerWereadLatest(mpId, trigger);
    }
    if (route.channel === 'owner-web-search') {
      if (page !== 1) return this.unavailableCollection();
      return this.collectionService.collectOwnerSearch(mpId);
    }
    if (route.channel === 'wechat2rss') {
      if (page !== 1) return this.unavailableCollection();
      return this.collectionService.collectWechat2RssRecent({
        mpId,
        mpName: feed.mpName,
        trigger,
      });
    }
    if (route.channel === 'public-album') {
      const albumIds = parseBoundAlbumIds(feed.publicAlbumIds);
      if (!albumIds) return this.unavailableAlbums();
      return this.collectionService.collectPublicAlbums({ mpId, albumIds });
    }
    return this.unavailableCollection(
      route.selectedBy === 'invalid'
        ? '后台来源配置无效，本次未更新。'
        : '该订阅暂无可用后台来源，本次未更新。',
    );
  }

  private unavailableAlbums() {
    return this.unavailableCollection(
      '所选公开合集通道缺少有效的合集绑定，本次未采集。请在本机重新绑定合集。',
    );
  }

  private unavailableCollection(
    message = '完整公众号列表通道尚未验证，本次未采集。历史文件仅可显式一次性导入；更新和定时任务不会读取外部目录。',
  ) {
    return {
      source: 'unavailable' as const,
      status: 'blocked' as const,
      complete: false as const,
      coverage: 'none' as const,
      reason: 'NO_VERIFIED_LIST_CHANNEL' as const,
      hasHistory: -1,
      articles: 0,
      message,
    };
  }

  inProgressHistoryMp = {
    id: '',
    page: 1,
  };

  async getHistoryMpArticles(mpId: string) {
    return this.recordCollectionResult(
      mpId,
      (feed) => this.collectHistory(feed),
      (feed) => resolveCollectionRoute(feed).channel === 'public-album',
    );
  }

  private async collectHistory(feed: Feed) {
    const route = resolveCollectionRoute(feed);
    if (route.channel === 'wechat2rss')
      return this.unavailableCollection(
        '订阅前历史查询尚未通过私有实例验证；已有本地历史保留。',
      );
    if (route.channel === 'public-album') {
      const albumIds = parseBoundAlbumIds(feed.publicAlbumIds);
      if (!albumIds) return this.unavailableAlbums();
      return this.collectionService.collectPublicAlbums({
        mpId: feed.id,
        albumIds,
      });
    }
    return this.unavailableCollection();
  }

  isRefreshAllMpArticlesRunning = false;

  async refreshAllMpArticlesAndUpdateFeed(
    trigger: 'local-manual' | 'public' = 'public',
  ) {
    if (this.isRefreshAllMpArticlesRunning) {
      throw new Error('批量更新正在进行，请稍后再试');
    }
    const mps = await this.prismaService.feed.findMany({
      orderBy: [{ order: 'asc' } as any, { createdAt: 'asc' }],
    });
    const results: {
      id: string;
      name: string;
      source: string;
      status: 'partial' | 'pending' | 'blocked' | 'failed';
      complete: false;
      coverage: string;
      message: string;
      articles: number;
    }[] = [];
    this.isRefreshAllMpArticlesRunning = true;
    try {
      for (const { id, mpName } of mps) {
        try {
          this.logger.log(
            `[Batch Update] Starting update for: ${mpName} (${id})`,
          );
          const result = await this.refreshMpArticlesAndUpdateFeed(
            id,
            1,
            trigger,
          );
          results.push({ id, name: mpName, ...result });
          this.logger.warn(
            `[Batch Update] ${result.status} (${result.coverage}): ${mpName} (${id})`,
          );
        } catch (err: any) {
          results.push({
            id,
            name: mpName,
            source: 'error',
            status: 'failed',
            complete: false,
            coverage: 'none',
            message: err.message,
            articles: 0,
          });
          this.logger.error(
            `[Batch Update] Failed to update ${mpName} (${id}): ${err.message}`,
          );
        }

        await new Promise((resolve) =>
          setTimeout(resolve, this.updateDelayTime * 1e3),
        );
      }
    } finally {
      this.isRefreshAllMpArticlesRunning = false;
    }
    return results;
  }

  async getMpInfo(
    url: string,
  ): Promise<Awaited<ReturnType<WereadService['getMpInfo']>>> {
    void url;
    throw new Error('旧微信读书订阅入口已停用；请使用私有实例添加订阅。');
  }

  /** Read-only source selection. Configuration is not evidence of live coverage. */
  subscriptionAddCapability(source?: SubscriptionAddSource) {
    if (source !== undefined && !['native', 'wechat2rss'].includes(source))
      throw new TRPCError({ code: 'BAD_REQUEST', message: '新增来源无效。' });
    const native = {
      source: 'native' as const,
      available: !!this.subscriptionDiscovery,
      requiresAccount: true,
      code: this.subscriptionDiscovery
        ? 'NATIVE_DIRECTORY_VALIDATION'
        : 'NATIVE_SOURCE_UNAVAILABLE',
      message: this.subscriptionDiscovery
        ? '选择正常Web登录账号并提交公众号文章链接；本次点击验证候选目录，通过后添加并读取最近10篇。遇限制停止，不自动切换账号或重试。'
        : '本机目录验证来源未注册；本次不会切换到其他来源。',
    };
    const paid = {
      source: 'wechat2rss' as const,
      available: false,
      requiresAccount: false,
      code: 'SUBSCRIPTION_SOURCE_UNAVAILABLE',
      message:
        'Wechat2RSS 未启用，暂不能通过此来源新增；输入链接已保留，本次不会切换到其他来源。',
    };
    if (process.env.WECHAT2RSS_ENABLED === '1') {
      try {
        // Constructor validates only private configuration, with no HTTP call.
        new Wechat2RssProvider(
          process.env.WECHAT2RSS_BASE_URL || '',
          process.env.WECHAT2RSS_TOKEN || '',
        );
        paid.available = true;
        paid.code = 'SOURCE_CONFIGURED';
        paid.message =
          '新增将提交到已显式配置的 Wechat2RSS；任务受理不代表文章已取得，已有订阅的来源不会自动切换。';
      } catch {
        paid.code = 'SOURCE_CONFIG_INVALID';
        paid.message = 'Wechat2RSS 私有配置无效；本次未请求来源或切换配置。';
      }
    }
    const selected = source || (native.available ? 'native' : 'wechat2rss');
    return {
      ...(selected === 'native' ? native : paid),
      // Repair remains a separate native operation, independent of add selection.
      existingRepairAvailable: !!this.subscriptionDiscovery?.repairExisting,
      sources: [native, paid],
    };
  }

  private readonly activeSubscriptionAdds = new Set<string>();

  async repairExistingSubscription(
    feedId: string,
    accountId: string,
    isLocal = false,
  ) {
    if (!isLocal)
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: '订阅来源修复只能在服务器本机操作。',
      });
    if (!this.subscriptionDiscovery?.repairExisting)
      return subscriptionDiscoveryUnavailable('SOURCE_UNAVAILABLE');
    const account = await this.prismaService.account.findUnique({
      where: { id: accountId },
      select: { id: true, status: true },
    });
    if (!account || account.status !== 1)
      return subscriptionDiscoveryUnavailable('ACCOUNT_UNAVAILABLE');
    if (this.activeSubscriptionAdds.has(accountId))
      throw new TRPCError({
        code: 'CONFLICT',
        message: '所选账号已有订阅验证进行中，本次未发送目录请求。',
      });
    this.activeSubscriptionAdds.add(accountId);
    try {
      return await repairNativeSubscription(
        this.prismaService,
        this.subscriptionDiscovery,
        { feedId, accountId, trigger: 'local-manual-repair' },
        () => createVerifiedSqliteBackup({ allowMysqlSkip: true }),
      );
    } finally {
      this.activeSubscriptionAdds.delete(accountId);
    }
  }

  async addSubscriptionFromArticle(
    articleUrl: string,
    accountId?: string,
    isLocal = false,
    source?: SubscriptionAddSource,
  ) {
    const capability = this.subscriptionAddCapability(source);
    if (!capability.available)
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: capability.message,
      });
    let url: string;
    try {
      url = subscriptionArticleUrl(articleUrl);
    } catch {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: '请输入有效的公开 HTTPS 微信公众号文章链接，不包含认证参数。',
      });
    }
    if (capability.source === 'native' && this.subscriptionDiscovery) {
      if (!isLocal)
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: '公众号目录验证只能在服务器本机操作。',
        });
      if (!accountId || !/^\d{1,20}$/.test(accountId))
        return subscriptionDiscoveryUnavailable('ACCOUNT_UNAVAILABLE');
      const account = await this.prismaService.account.findUnique({
        where: { id: accountId },
        select: { id: true, status: true },
      });
      if (!account || account.status !== 1)
        return subscriptionDiscoveryUnavailable('ACCOUNT_UNAVAILABLE');
      if (this.activeSubscriptionAdds.has(accountId))
        throw new TRPCError({
          code: 'CONFLICT',
          message: '所选账号已有公众号添加进行中，本次未发送目录请求。',
        });
      this.activeSubscriptionAdds.add(accountId);
      try {
        return await addNativeSubscription(
          this.prismaService,
          this.subscriptionDiscovery,
          { articleUrl: url, accountId, trigger: 'local-manual-add' },
          () => createVerifiedSqliteBackup({ allowMysqlSkip: true }),
        );
      } finally {
        this.activeSubscriptionAdds.delete(accountId);
      }
    }
    // 上游受理前未知公众号 ID；不同文章链接也可能竞争同一 Feed。
    // 复用进程内锁串行付费添加，在备份及可能收费的请求前拒绝并发。
    const addKey = 'wechat2rss:add';
    if (this.activeSubscriptionAdds.has(addKey))
      throw new TRPCError({
        code: 'CONFLICT',
        message: '已有 Wechat2RSS 公众号添加进行中，本次未发送上游请求。',
      });
    this.activeSubscriptionAdds.add(addKey);
    let upstreamSubmitted = false;
    try {
      const provider = wechat2RssProvider();
      let knownId: string | undefined;
      try {
        knownId = canonicalArticleUrl(url).id;
      } catch {
        /* Short links need upstream resolution. */
      }
      const known = await this.prismaService.article.findFirst({
        where: {
          OR: [
            { sourceUrl: url },
            { verifiedSourceUrl: url },
            ...(knownId ? [{ id: knownId }] : []),
          ],
        },
        select: { mpId: true },
      });
      if (known) {
        const feed = await this.prismaService.feed.findUniqueOrThrow({
          where: { id: known.mpId },
        });
        return this.finishWechat2RssSubscription(feed, false, false);
      }
      const account = await provider.checkAccountStatus();
      if (!account.available)
        return {
          requestedSource: 'wechat2rss' as const,
          sourceBindingChanged: false,
          status: 'blocked' as const,
          accepted: false,
          pending: true,
          created: false,
          feed: null,
          upstreamSubmitted: false,
          sync: null,
          code: account.challenged
            ? 'ACCOUNT_CHALLENGED'
            : 'ACCOUNT_UNAVAILABLE',
          message: account.challenged
            ? '私有实例账号受限，本次未新增；请本人在实例处理，链接已保留。'
            : '私有实例没有正常登录账号，本次未新增，链接已保留。',
        };
      const backup = await createVerifiedSqliteBackup();
      if (!('source' in backup) || typeof backup.source !== 'string')
        throw new Error('SQLite 一致性备份没有确认源库，本次未新增。');
      const journal = await wechat2RssAddReceipt(
        backup.source,
        url,
        backup.backup,
      );
      let feedPath = journal.receipt?.feedPath;
      if (journal.receipt && !feedPath)
        return {
          requestedSource: 'wechat2rss' as const,
          sourceBindingChanged: false,
          status: 'pending' as const,
          accepted: false,
          pending: true,
          created: false,
          feed: null,
          upstreamSubmitted: false,
          sync: null,
          code: 'ADD_RESULT_UNCONFIRMED',
          message:
            '此前新增请求结果尚未确认，本次未重发；请在私有实例核对是否已添加，原链接已保留。',
        };
      if (!feedPath) {
        await journal.claim();
        upstreamSubmitted = true;
        feedPath = await provider.acceptSubscription(url);
        await journal.accepted(feedPath);
      }
      const accepted = await provider.resolveAcceptedSubscription(feedPath);
      if (!accepted)
        return {
          requestedSource: 'wechat2rss' as const,
          sourceBindingChanged: false,
          status: 'pending' as const,
          accepted: true,
          pending: true,
          created: false,
          feed: null,
          upstreamSubmitted,
          sync: null,
          code: 'SUBSCRIPTION_ID_PENDING',
          message:
            '上游已返回订阅地址，但本次列表核对未获得完整公众号身份（含名称），本地订阅尚未建立；稍后提交同一链接仅核对状态，不重复新增。',
        };
      const old = await this.prismaService.feed.findUnique({
        where: { id: accepted.feedId },
      });
      if (old && old.mpName !== accepted.name)
        throw new Error('私有实例与现有订阅名称不一致，请先核对身份。');
      const feed =
        old ||
        (await this.prismaService.feed.create({
          data: {
            id: accepted.feedId,
            mpName: accepted.name,
            mpCover: '',
            mpIntro: '',
            updateTime: 0,
            syncTime: 0,
            hasHistory: -1,
            collectionChannel: 'wechat2rss',
          },
        }));
      return await this.finishWechat2RssSubscription(
        feed,
        !old,
        upstreamSubmitted,
      );
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      return {
        requestedSource: 'wechat2rss' as const,
        sourceBindingChanged: false,
        status: 'failed' as const,
        accepted: false,
        pending: true,
        created: false,
        feed: null,
        upstreamSubmitted,
        sync: null,
        code: 'ADD_FAILED',
        message:
          '新增未完成，请核对私有实例状态；链接已保留，不自动切换来源或重发上游请求。',
      };
    } finally {
      this.activeSubscriptionAdds.delete(addKey);
    }
  }

  private async finishWechat2RssSubscription(
    feed: Feed,
    created: boolean,
    upstreamSubmitted: boolean,
  ) {
    const base = {
      requestedSource: 'wechat2rss' as const,
      sourceBindingChanged: created,
      accepted: true,
      created,
      feed,
      upstreamSubmitted,
    };
    if (feed.collectionChannel !== 'wechat2rss')
      return {
        ...base,
        status: 'source-preserved' as const,
        pending: false,
        sync: null,
        code: 'EXISTING_SOURCE_PRESERVED',
        message:
          '此公众号已在项目中，原来源及内容保持；本次没有切换来源或读取原来源。',
      };
    if (feed.status !== 1)
      return {
        ...base,
        status: 'blocked' as const,
        pending: true,
        sync: null,
        code: 'SUBSCRIPTION_PAUSED',
        message: '此公众号已存在但处于停用状态，本次没有启用或读取缓存。',
      };
    try {
      const sync = await this.refreshMpArticlesAndUpdateFeed(
        feed.id,
        1,
        'local-manual',
      );
      const complete =
        sync.status === 'partial' &&
        'bodyMissing' in sync &&
        sync.bodyMissing === 0 &&
        'imageBlocked' in sync &&
        sync.imageBlocked === 0;
      return {
        ...base,
        feed: await this.prismaService.feed.findUniqueOrThrow({
          where: { id: feed.id },
        }),
        status: complete
          ? ('updated' as const)
          : sync.status === 'blocked'
            ? ('blocked' as const)
            : ('pending' as const),
        pending: !complete,
        sync,
        code: complete ? 'CACHE_IMPORTED' : 'CACHE_PENDING',
        message: complete
          ? `公众号已${created ? '添加并' : '订阅并'}读取缓存。${sync.message}`
          : `公众号已保留，缓存尚未完整就绪。${sync.message}稍后使用原更新按钮只读缓存，无需重新新增。`,
      };
    } catch {
      return {
        ...base,
        status: 'pending' as const,
        pending: true,
        sync: null,
        code: 'CACHE_READ_FAILED',
        message:
          '公众号已保留，首次缓存读取未完成；稍后使用原更新按钮只读缓存，不重新提交新增。',
      };
    }
  }

  async createLoginUrl(): Promise<
    Awaited<ReturnType<WereadService['createLoginUrl']>>
  > {
    return this.wereadService.createLoginUrl();
  }

  private savedLogins = new Map<
    string,
    Promise<{
      message: string;
      terminal: boolean;
      vid: number;
      username: string;
      saved: boolean;
      searchSessionUpdated: boolean;
    }>
  >();

  async getLoginResult(id: string): Promise<{
    message: string;
    terminal: boolean;
    saved: boolean;
    searchSessionUpdated: boolean;
    vid?: number;
    username?: string;
  }> {
    if (this.savedLogins.has(id)) return this.savedLogins.get(id)!;
    const result = await this.wereadService.getLoginResult(id);
    if (!result.vid || !result.token)
      return {
        message: result.message,
        terminal: result.terminal,
        saved: false,
        searchSessionUpdated: false,
      };
    if (this.savedLogins.has(id)) return this.savedLogins.get(id)!;
    const save = (async () => {
      await createVerifiedSqliteBackup({ allowMysqlSkip: true });
      const accountId = String(result.vid);
      const old = await this.prismaService.account.findUnique({
        where: { id: accountId },
      });
      let prior: any = {};
      try {
        prior = JSON.parse(old?.token || '{}');
      } catch {
        /* Backups retain legacy raw token. */
      }
      const freshWebToken = JSON.parse(result.token!);
      const mergedToken = { ...prior, ...freshWebToken };
      // A new Web login must not inherit a stale refresh token from a prior
      // session when the new login response did not issue one.
      if (!Object.prototype.hasOwnProperty.call(freshWebToken, 'wr_rt'))
        delete mergedToken.wr_rt;
      const token = JSON.stringify(mergedToken);
      const username = old?.name || result.username || `WeRead_${result.vid}`;
      await this.prismaService.account.upsert({
        where: { id: accountId },
        create: { id: accountId, name: username, token, status: 1 },
        update: { token, status: 1 },
      });
      let searchSessionUpdated = false;
      // Only the explicitly bound owner can replace this account's search
      // session. Old sessions, states and all original-access stops remain.
      const configFile = process.env.OWNER_SEARCH_CONFIG_FILE;
      if (configFile && result.webSession) {
        ownerSessionCookie(result.webSession, accountId);
        const lockFile = configFile + '.native-login.lock';
        const lock = await fs.open(lockFile, 'wx', 0o600);
        try {
          const raw = await fs.readFile(configFile, 'utf8');
          const config = JSON.parse(raw);
          const bindings = Object.values(config.feeds || {}).filter(
            (v: any) => v.ownerVid === accountId,
          ) as any[];
          // Keep the native login server-side for an explicit account-page
          // binding, including a selected owner not yet bound to this feed.
          const sessionFile = await saveNativeAccountSession(
            configFile,
            result.webSession,
          );
          if (result.profile) {
            // Failure to cache optional profile metadata must not discard a
            // confirmed login; UI then explicitly reports nickname unavailable.
            await saveNativeAccountProfile(
              configFile,
              result.profile,
              result.webSession,
            ).catch(() => undefined);
          }
          if (bindings.length) {
            const key = createHash('sha256')
              .update(JSON.stringify(result.webSession))
              .digest('hex')
              .slice(0, 24);
            for (const binding of bindings) binding.sessionFile = sessionFile;
            const history = configFile + `.before-native-${key}`;
            try {
              await fs.writeFile(history, raw, { flag: 'wx', mode: 0o600 });
            } catch (e: any) {
              if (e.code !== 'EEXIST') throw e;
            }
            const pending = configFile + '.native-login.pending';
            await fs.writeFile(pending, JSON.stringify(config), {
              flag: 'wx',
              mode: 0o600,
            });
            await fs.rename(pending, configFile);
            searchSessionUpdated = true;
          }
        } finally {
          await lock.close();
          await fs.unlink(lockFile);
        }
      }
      return {
        message: '',
        terminal: true,
        vid: result.vid!,
        username,
        saved: true,
        searchSessionUpdated,
      };
    })();
    this.savedLogins.set(id, save);
    try {
      return await save;
    } catch {
      this.savedLogins.delete(id);
      throw new Error(
        '读书登录已确认，但账号或搜索会话保存未完成；未发取文请求，请检查本地保存错误。',
      );
    }
  }
}
