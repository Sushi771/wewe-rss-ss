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
import dayjs from 'dayjs';
import got from 'got';
import { load } from 'cheerio';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import pMap from '@cjs-exporter/p-map';
import { WereadService } from '@server/weread/weread.service';
import { CollectionService } from '../collection/collection.service';
import { articlePageRequest } from '../collection/article-page';
import {
  csvCell,
  metricLabels,
  Metrics,
  metricsMarkdown,
} from '../collection/collection-format';

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
          return [await this.trpcService.refreshMpArticlesAndUpdateFeed(mpId)];
        } else {
          return this.trpcService.refreshAllMpArticlesAndUpdateFeed();
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
          select: {
            id: true,
            mpId: true,
            title: true,
            picUrl: true,
            publishTime: true,
            sourceUrl: true,
            metrics: true,
            readCount: true,
            likeCount: true,
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
              const dateFolder = dayjs().format('YYYY-MM-DD');
              const finalPath = path.join(obsidianPath, dateFolder);

              if (!fs.existsSync(finalPath)) {
                await fs.promises.mkdir(finalPath, { recursive: true });
              }
              const safeTitle = title
                .replace(/[\\/:*?"<>|]/g, '-')
                .slice(0, 100);
              const filePath = path.join(finalPath, `${safeTitle}-${id}.md`);
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
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: `保存到 Obsidian 失败: ${err.message}`,
            cause: err.stack,
          });
        }
      }),
  });

  private async downloadImage(url: string, destPath: string) {
    const inline = url.match(
      /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/=]+)$/,
    );
    if (inline) {
      await fs.promises.writeFile(destPath, Buffer.from(inline[2], 'base64'));
      return;
    }
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

    const url = article.sourceUrl || `https://mp.weixin.qq.com/s/${id}`;

    let html = article.contentHtml || '';
    try {
      if (!html) html = await articlePageRequest(url).text();
    } catch (err: any) {
      this.logger.warn(
        `Direct fetch from ${url} failed: ${err.message}, trying weread...`,
      );
    }

    if (
      !html ||
      (!html.includes('rich_media_content') && !html.includes('js_content'))
    ) {
      const wereadHtml =
        !article.sourceUrl &&
        (await this.wereadService.getArticleContent(id, article.mpId));
      if (wereadHtml) {
        html = wereadHtml;
      }
    }

    if (!html) {
      throw new Error(`Failed to load article content for ${id}`);
    }

    const $ = load(html, { decodeEntities: false });
    const { originUrl } = this.configService.get('feed');
    const serverHost = originUrl || 'http://localhost:4000';

    const contentEl = $('.rich_media_content').length
      ? $('.rich_media_content')
      : $('#js_content');
    if (
      !contentEl.length ||
      (!contentEl.text().trim() && !contentEl.find('img').length)
    ) {
      throw new Error(
        '未获取到正文，请在 WeChatDownload 下载对应 HTML 后重新导入',
      );
    }

    if (downloadPath) {
      const attachmentsDir = path.join(downloadPath, 'attachments');
      if (!fs.existsSync(attachmentsDir)) {
        await fs.promises.mkdir(attachmentsDir, { recursive: true });
      }

      const imgs = contentEl.find('img').get();
      await pMap(
        imgs,
        async (img) => {
          const $img = $(img);
          const dataSrc = $img.attr('data-src') || $img.attr('src');
          if (dataSrc) {
            const ext = dataSrc.startsWith('data:image/')
              ? dataSrc.slice(11).split(';')[0]
              : dataSrc.includes('wx_fmt=')
                ? dataSrc.split('wx_fmt=')[1].split('&')[0]
                : 'jpg';
            const hash = crypto.createHash('md5').update(dataSrc).digest('hex');
            const safeExt = /^(png|jpe?g|gif|webp)$/.test(ext) ? ext : 'jpg';
            const fileName = `image_${hash}.${safeExt}`;
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
      contentEl.find('img').each((_, img) => {
        const $img = $(img);
        const dataSrc = $img.attr('data-src') || $img.attr('src');
        if (dataSrc) {
          const proxyUrl = dataSrc.startsWith('data:image/')
            ? dataSrc
            : `${serverHost}/proxy/image?url=${encodeURIComponent(dataSrc)}`;
          $img.attr('src', proxyUrl);
        }
      });
    }

    const contentHtml = $.html(contentEl);

    const turndownService = new TurndownService();
    const markdown = turndownService.turndown(contentHtml);

    return {
      title: article.title,
      markdown: (article.sourceUrl ? metricsMarkdown(article) : '') + markdown,
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
    getLoginResult: this.trpcService.protectedProcedure
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

          if (authCode && req.headers.authorization !== authCode) {
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
