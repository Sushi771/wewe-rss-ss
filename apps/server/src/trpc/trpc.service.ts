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
      this.logger.error(`retry(${4 - retryCount}) getMpArticles error: `, err);
      if (retryCount > 0) {
        return this.getMpArticles(mpId, page, retryCount - 1);
      } else {
        throw err;
      }
    }
  }

  async refreshMpArticlesAndUpdateFeed(mpId: string, page = 1) {
    if (page !== 1) {
      throw new Error(
        '当前微信读书封面接口只支持检查最新一篇，无法按页获取公众号历史文章。',
      );
    }
    const articles = await this.getMpArticles(mpId, page);

    if (articles.length > 0) {
      let results;
      const { type } =
        this.configService.get<ConfigurationType['database']>('database')!;
      if (type === 'sqlite') {
        // sqlite3 不支持 createMany
        const inserts = articles.map(({ id, picUrl, publishTime, title }) =>
          this.prismaService.article.upsert({
            create: { id, mpId, picUrl, publishTime, title },
            update: {
              publishTime,
              title,
            },
            where: { id },
          }),
        );
        this.logger.log(
          `Upserting ${articles.length} articles for mpId: ${mpId}`,
        );
        results = await this.prismaService.$transaction(inserts);
      } else {
        this.logger.log(
          `Creating many (${articles.length}) articles for mpId: ${mpId}`,
        );
        results = await (this.prismaService.article as any).createMany({
          data: articles.map(({ id, picUrl, publishTime, title }) => ({
            id,
            mpId,
            picUrl,
            publishTime,
            title,
          })),
          skipDuplicates: true,
        });
      }

      this.logger.log(
        `refreshMpArticlesAndUpdateFeed results: ${JSON.stringify(results)}`,
      );
    }

    // /api/mp/cover 只返回最新一篇；条数不能证明历史已到末页。
    // -1 表示历史覆盖未知，也会纠正旧版本错误写入的 0。
    const hasHistory = -1;

    await this.prismaService.feed.update({
      where: { id: mpId },
      data: {
        syncTime: Math.floor(Date.now() / 1e3),
        hasHistory,
      },
    });

    return { hasHistory };
  }

  inProgressHistoryMp = {
    id: '',
    page: 1,
  };

  async getHistoryMpArticles(mpId: string) {
    throw new Error(
      `公众号 ${mpId} 的历史获取尚不可用：当前微信读书接口只返回最新一篇，请接入可验证的分页来源后重试。现有文章与进度已保留。`,
    );
  }

  isRefreshAllMpArticlesRunning = false;

  async refreshAllMpArticlesAndUpdateFeed() {
    if (this.isRefreshAllMpArticlesRunning) {
      this.logger.log('refreshAllMpArticlesAndUpdateFeed is running');
      return;
    }
    const mps = await this.prismaService.feed.findMany({
      orderBy: [{ order: 'asc' } as any, { createdAt: 'asc' }],
    });
    this.isRefreshAllMpArticlesRunning = true;
    try {
      for (const { id, mpName } of mps) {
        try {
          this.logger.log(
            `[Batch Update] Starting update for: ${mpName} (${id})`,
          );
          await this.refreshMpArticlesAndUpdateFeed(id);
          this.logger.log(
            `[Batch Update] Successfully updated: ${mpName} (${id})`,
          );
        } catch (err: any) {
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
