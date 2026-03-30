import { INestApplication, Injectable, Logger } from '@nestjs/common';
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
import TurndownService from 'turndown';
import got from 'got';
import { load } from 'cheerio';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import pMap from '@cjs-exporter/p-map';

@Injectable()
export class TrpcRouter {
  constructor(
    private readonly trpcService: TrpcService,
    private readonly prismaService: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  private readonly logger = new Logger(this.constructor.name);

  accountRouter = this.trpcService.router({
    list: this.trpcService.protectedProcedure
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
    byId: this.trpcService.protectedProcedure
      .input(z.string())
      .query(async ({ input: id }) => {
        const account = await this.prismaService.account.findUnique({
          where: { id },
        });
        if (!account) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `No account with id '${id}'`,
          });
        }
        return account;
      }),
    add: this.trpcService.protectedProcedure
      .input(AccountSchemas.add)
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        const account = await this.prismaService.account.upsert({
          where: {
            id,
          },
          update: data,
          create: input,
        });
        this.trpcService.removeBlockedAccount(id);

        return account;
      }),
    edit: this.trpcService.protectedProcedure
      .input(AccountSchemas.edit)
      .mutation(async ({ input }) => {
        const { id, data } = input;
        const account = await this.prismaService.account.update({
          where: { id },
          data,
        });
        this.trpcService.removeBlockedAccount(id);
        return account;
      }),
    delete: this.trpcService.protectedProcedure
      .input(z.string())
      .mutation(async ({ input: id }) => {
        await this.prismaService.account.delete({ where: { id } });
        this.trpcService.removeBlockedAccount(id);

        return id;
      }),
  });

  feedRouter = this.trpcService.router({
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
          items: items,
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
        return feed;
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
      .mutation(async ({ input: { mpId } }) => {
        if (mpId) {
          await this.trpcService.refreshMpArticlesAndUpdateFeed(mpId);
        } else {
          await this.trpcService.refreshAllMpArticlesAndUpdateFeed();
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
        this.trpcService.getHistoryMpArticles(mpId);
      }),
    getInProgressHistoryMp: this.trpcService.protectedProcedure.query(
      async () => {
        return this.trpcService.inProgressHistoryMp;
      },
    ),
  });

  articleRouter = this.trpcService.router({
    list: this.trpcService.protectedProcedure
      .input(ArticleSchemas.list)
      .query(async ({ input }) => {
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

        const items = await this.prismaService.article.findMany({
          orderBy: [
            {
              publishTime: 'desc',
            },
          ],
          take: limit + 1,
          where,
          cursor: cursor
            ? {
                id: cursor,
              }
            : undefined,
          include: {
            feed: true,
          },
        });
        let nextCursor: typeof cursor | undefined = undefined;
        if (items.length > limit) {
          // Remove the last item and use it as next cursor

          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          const nextItem = items.pop()!;
          nextCursor = nextItem.id;
        }

        return {
          items,
          nextCursor,
        };
      }),
    byId: this.trpcService.protectedProcedure
      .input(z.string())
      .query(async ({ input: id }) => {
        const article = await this.prismaService.article.findUnique({
          where: { id },
        });
        if (!article) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `No article with id '${id}'`,
          });
        }
        return article;
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
          const { obsidianPath } =
            this.configService.get<ConfigurationType['feed']>('feed')!;

          // Attempt to save to Obsidian if configured
          try {
            if (obsidianPath) {
              if (!fs.existsSync(obsidianPath)) {
                await fs.promises.mkdir(obsidianPath, { recursive: true });
              }
              const safeTitle = title.replace(/[\\/:*?"<>|]/g, '-');
              const filePath = path.join(obsidianPath, `${safeTitle}.md`);
              await fs.promises.writeFile(filePath, markdown);
              this.logger.log(
                `Auto-saved to Obsidian during export: ${filePath}`,
              );
            }
          } catch (err: any) {
            this.logger.error(
              `Auto-save to Obsidian failed during export: ${err.message}`,
            );
          }

          return { markdown, title };
        } catch (err: any) {
          this.logger.error(`Export Markdown error for ${id}: ${err.message}`);
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
          const { markdown, title } = await this.getArticleMarkdown(
            id,
            obsidianPath,
          );

          if (!fs.existsSync(obsidianPath)) {
            await fs.promises.mkdir(obsidianPath, { recursive: true });
          }

          const safeTitle = title.replace(/[\\/:*?"<>|]/g, '-');
          const filePath = path.join(obsidianPath, `${safeTitle}.md`);

          await fs.promises.writeFile(filePath, markdown);

          return { success: true, path: filePath };
        } catch (err: any) {
          this.logger.error(`Save to Obsidian error for ${id}: ${err.message}`);
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: `保存到 Obsidian 失败: ${err.message}`,
            cause: err.stack,
          });
        }
      }),
  });

  private async downloadImage(url: string, destPath: string) {
    const response = await got(url, {
      responseType: 'buffer',
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.4951.64 Safari/537.36',
        referer: 'https://mp.weixin.qq.com/',
      },
    });
    await fs.promises.writeFile(destPath, response.body);
  }

  private async getArticleMarkdown(id: string, downloadPath?: string) {
    const article = await this.prismaService.article.findUnique({
      where: { id },
    });
    if (!article) {
      throw new Error(`No article with id '${id}'`);
    }

    const url = `https://mp.weixin.qq.com/s/${id}`;

    const request = got.extend({
      retry: { limit: 3, methods: ['GET'] },
      timeout: 8 * 1e3,
      headers: {
        accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
        'accept-encoding': 'gzip, deflate, br',
        'accept-language': 'en-US,en;q=0.9',
        'cache-control': 'max-age=0',
        'sec-ch-ua':
          '" Not A;Brand";v="99", "Chromium";v="101", "Google Chrome";v="101"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
        'sec-fetch-user': '?1',
        'upgrade-insecure-requests': '1',
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.4951.64 Safari/537.36',
      },
    });

    const html = await request(url, { responseType: 'text' }).text();
    const $ = load(html, { decodeEntities: false });
    const { originUrl } = this.configService.get('feed');
    const serverHost = originUrl || 'http://localhost:4000';

    if (downloadPath) {
      const attachmentsDir = path.join(downloadPath, 'attachments');
      if (!fs.existsSync(attachmentsDir)) {
        await fs.promises.mkdir(attachmentsDir, { recursive: true });
      }

      const imgs = $('.rich_media_content img').get();
      await pMap(
        imgs,
        async (img) => {
          const $img = $(img);
          const dataSrc = $img.attr('data-src');
          if (dataSrc) {
            const ext = dataSrc.includes('wx_fmt=')
              ? dataSrc.split('wx_fmt=')[1].split('&')[0]
              : 'jpg';
            const hash = crypto.createHash('md5').update(dataSrc).digest('hex');
            const fileName = `image_${hash}.${ext}`;
            const localPath = path.join(attachmentsDir, fileName);

            try {
              if (!fs.existsSync(localPath)) {
                await this.downloadImage(dataSrc, localPath);
              }
              $img.attr('src', `attachments/${fileName}`);
            } catch (err: any) {
              this.logger.error(
                `Failed to download image ${dataSrc}: ${err.message}`,
              );
              // Fallback to proxy if local download fails or just keep data-src
              const proxyUrl = `${serverHost}/proxy/image?url=${encodeURIComponent(
                dataSrc,
              )}`;
              $img.attr('src', proxyUrl);
            }
          }
        },
        { concurrency: 5 },
      );
    } else {
      // For browser export, we use proxy URLs
      $('.rich_media_content img').each((_, img) => {
        const $img = $(img);
        const dataSrc = $img.attr('data-src');
        if (dataSrc) {
          const proxyUrl = `${serverHost}/proxy/image?url=${encodeURIComponent(
            dataSrc,
          )}`;
          $img.attr('src', proxyUrl);
        }
      });
    }

    const contentHtml = $.html($('.rich_media_content'));

    const turndownService = new TurndownService();
    const markdown = turndownService.turndown(contentHtml);

    return {
      title: article.title,
      markdown: markdown || '获取全文内容失败，可能该文章类型不支持。',
    };
  }

  platformRouter = this.trpcService.router({
    getMpArticles: this.trpcService.protectedProcedure
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
    getMpInfo: this.trpcService.protectedProcedure
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

    createLoginUrl: this.trpcService.protectedProcedure.mutation(async () => {
      return this.trpcService.createLoginUrl();
    }),
    getLoginResult: this.trpcService.protectedProcedure
      .input(PlatformSchemas.getLoginResult)
      .query(async ({ input }) => {
        return this.trpcService.getLoginResult(input.id);
      }),
  });

  appRouter = this.trpcService.router({
    feed: this.feedRouter,
    account: this.accountRouter,
    article: this.articleRouter,
    platform: this.platformRouter,
  });

  async applyMiddleware(app: INestApplication) {
    app.use(
      `/trpc`,
      trpcExpress.createExpressMiddleware({
        router: this.appRouter,
        createContext: ({ req }) => {
          const authCode =
            this.configService.get<ConfigurationType['auth']>('auth')!.code;

          if (authCode && req.headers.authorization !== authCode) {
            return {
              errorMsg: 'authCode不正确！',
            };
          }
          return {
            errorMsg: null,
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
