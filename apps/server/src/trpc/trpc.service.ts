import { Injectable, Logger } from '@nestjs/common';
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
import { createVerifiedSqliteBackup } from '../collection/sqlite-backup';
import { BodyRetryBlockedError } from '../collection/article-body-retry';
import { Feed } from '@prisma/client';
import {
  CollectionRoute,
  parseBoundAlbumIds,
  resolveCollectionRoute,
} from '../collection/collection-channel';

dayjs.extend(utc);
dayjs.extend(timezone);

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
  trpc = initTRPC.create();
  publicProcedure = this.trpc.procedure;
  protectedProcedure = this.trpc.procedure.use(({ ctx, next }) => {
    const errorMsg = (ctx as any).errorMsg;
    if (errorMsg) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: errorMsg });
    }
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

  async getMpArticles(mpId: string, page = 1, retryCount = 3) {
    const account = await this.getAvailableAccount();

    try {
      const res = await this.wereadService.getMpArticles(mpId, page, account);
      this.logger.log(
        `getMpArticles(${mpId}) page: ${page} articles: ${res.length}`,
      );
      if (res.length > 0) {
        this.logger.debug(
          `First article from weread: ${res[0].title} (${res[0].id})`,
        );
      }
      return res;
    } catch (err: any) {
      // Token 失效时不重试（账号已被禁用，重试无意义）
      if (
        err instanceof TokenInvalidError ||
        err.name === 'TokenInvalidError'
      ) {
        if (account?.id) {
          await this.prismaService.account
            .update({
              where: { id: account.id },
              data: { status: statusMap.INVALID },
            })
            .catch(() => {});
          this.logger.error(
            `账号（${account.id}）登录失效，已禁用，请在账号页面重新登录`,
          );
        }
        throw err;
      }
      this.logger.error(`retry(${4 - retryCount}) getMpArticles failed`);
      if (retryCount > 0) {
        return this.getMpArticles(mpId, page, retryCount - 1);
      } else {
        throw err;
      }
    }
  }

  async refreshMpArticlesAndUpdateFeed(
    mpId: string,
    page = 1,
    trigger: 'local-manual' | 'scheduled' | 'public' = 'public',
  ) {
    let route: CollectionRoute;
    return this.recordCollectionResult(
      mpId,
      (feed) => this.refreshArticles(feed, page, route),
      (feed) => {
        // 同号锁内解析一次，权限检查与执行共用这次选择。
        route = resolveCollectionRoute(feed);
        if (route.channel !== 'desktop-wechat') return false;
        if (trigger === 'public')
          throw new Error(
            '电脑微信采集需要在本机页面手动操作，公开订阅请求不会操作桌面',
          );
        if (
          trigger === 'scheduled' &&
          process.env.WECHAT_DESKTOP_ALLOW_SCHEDULED !== '1'
        )
          throw new Error('电脑微信定时采集尚未启用，请先完成本机手动验证');
        return true;
      },
    );
  }

  async collectDesktopRecent20(mpId: string) {
    return this.recordCollectionResult(
      mpId,
      (feed) =>
        this.collectionService.collectDesktopRecent20({
          mpId,
          mpName: feed.mpName,
          resumeAfterUserConsent: true,
        }),
      true,
    );
  }

  async collectPublicAlbums(input: { mpId: string; albumIds: string[] }) {
    return this.recordCollectionResult(input.mpId, () =>
      this.collectionService.collectPublicAlbums(input),
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
  ) {
    const mpId = feed.id;
    if (route.channel === 'desktop-wechat') {
      if (page !== 1) return this.unavailableDesktopHistory();
      return this.collectionService.collectDesktopRecent20({
        mpId,
        mpName: feed.mpName,
      });
    }
    if (route.channel === 'public-album') {
      const albumIds = parseBoundAlbumIds(feed.publicAlbumIds);
      if (!albumIds) return this.unavailableAlbums();
      return this.collectionService.collectPublicAlbums({
        mpId,
        albumIds,
      });
    }
    if (route.channel === 'unavailable') {
      if (route.selectedBy === 'invalid')
        return this.unavailableCollection(
          '采集通道配置无效，本次未采集。请在本机重新执行所需通道的专用采集。',
        );
      return this.unavailableCollection();
    }
    if (page !== 1) return this.unavailableCollection();
    const articles = await this.getMpArticles(mpId, page);

    let saved = 0;
    let skippedUnknownDate = 0;
    const unknownDates = articles.filter((a) => a.publishTime == null).length;
    await this.prismaService.$transaction(async (tx) => {
      for (const { id, picUrl, publishTime, title, contentHtml } of articles) {
        const existing = await tx.article.findUnique({ where: { id } });
        if (existing) {
          await tx.article.update({
            where: { id },
            data: {
              title,
              contentHtml,
              ...(publishTime == null ? {} : { publishTime }),
            },
          });
          saved++;
        } else if (publishTime != null) {
          await tx.article.create({
            data: { id, mpId, picUrl, publishTime, title, contentHtml },
          });
          saved++;
        } else {
          skippedUnknownDate++;
        }
      }
    });

    // A cover is a preview, never evidence that history is exhausted.
    const hasHistory = -1;

    await this.prismaService.feed.update({
      where: { id: mpId },
      data: {
        hasHistory,
      },
    });

    return {
      hasHistory,
      source: 'cover' as const,
      status: 'partial' as const,
      complete: false as const,
      coverage: 'cover' as const,
      articles: articles.length,
      saved,
      skippedUnknownDate,
      unknownDates,
      message: `仅取得封面预览 ${articles.length} 篇，不代表完整更新。${unknownDates ? `其中 ${unknownDates} 篇未取得真实发布时间；已有记录保留原日期，${skippedUnknownDate} 篇新记录未写入。` : ''}完整公众号列表通道尚未验证，近期缺口与次条仍可能遗漏。`,
    };
  }

  private unavailableAlbums() {
    return this.unavailableCollection(
      '所选公开合集通道缺少有效的合集绑定，本次未采集。请在本机重新绑定合集。',
    );
  }

  private unavailableDesktopHistory() {
    return this.unavailableCollection(
      '电脑微信通道仅采集“文章”页最近20篇，不支持历史分页；本次未采集。',
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
    return this.recordCollectionResult(mpId, (feed) =>
      this.collectHistory(feed),
    );
  }

  private async collectHistory(feed: Feed) {
    const route = resolveCollectionRoute(feed);
    if (route.channel === 'desktop-wechat')
      return this.unavailableDesktopHistory();
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
      status: 'partial' | 'blocked' | 'failed';
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

  async getMpInfo(url: string) {
    return this.wereadService.getMpInfo(url);
  }

  async createLoginUrl() {
    return this.wereadService.createLoginUrl();
  }

  async getLoginResult(id: string) {
    return this.wereadService.getLoginResult(id);
  }
}
