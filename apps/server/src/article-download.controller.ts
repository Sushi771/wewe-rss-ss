import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Logger,
  Optional,
  OnModuleDestroy,
  Param,
  Post,
  Request,
  Response,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request as Req, Response as Res } from 'express';
import { dirname, isAbsolute, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ArticleDownloadError, downloadArticleUrl } from './article-download';
import { LocalArticleStore } from './article-local-save';
import { PreparedArticle } from './article-local-save';
import { exportSourceFromFeed } from './article-export-source';
import { pickArticleDirectory } from './article-folder-picker';
import { privateOnlineMode } from './private-access';
import { PrismaService } from './prisma/prisma.service';
import { ProviderArticle } from './collection/subscription-provider';
import { prepareWechat2RssSingleDownload } from './wechat2rss-single-download';
import { TrpcService } from './trpc/trpc.service';
import {
  singleCachePending,
  Wechat2RssSingleTasks,
} from './wechat2rss-single-tasks';
import { BrowserTaskBroker, BrowserTaskError } from './browser-task';
import { BrowserArticleTasks } from './browser-article-tasks';
import { XiaohongshuService } from './collection/xiaohongshu.service';
import {
  XHS_SINGLE_SOURCE,
  XhsSingleSource,
  xhsSingleNoteUrl,
  prepareXhsSingleDownload,
} from './xhs-single-download';
import {
  ARTICLE_VERIFICATION_TTL_MS,
  articleVerificationLocation,
} from '../../../packages/shared/src/article-verification';

@Controller('download')
export class ArticleDownloadController implements OnModuleDestroy {
  private readonly browserTasks: BrowserArticleTasks;
  private readonly singleTasks?: Wechat2RssSingleTasks;
  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly prisma?: PrismaService,
    @Optional() browserBroker?: BrowserTaskBroker,
    @Optional() private readonly xiaohongshu?: XiaohongshuService,
    @Optional()
    @Inject(XHS_SINGLE_SOURCE)
    private readonly xhsSingleSource?: XhsSingleSource,
    @Optional() private readonly subscriptionQueue?: TrpcService,
  ) {
    // Default AppModule supplies no broker. An explicitly approved short-lived
    // opt-in root supplies the same configured broker to both controllers.
    this.browserTasks = new BrowserArticleTasks(
      browserBroker || new BrowserTaskBroker(),
    );
    if (subscriptionQueue) {
      this.singleTasks = new Wechat2RssSingleTasks(
        () => {
          const raw = process.env.DATABASE_URL || '';
          const database = raw.startsWith('file:') ? raw.slice(5) : '';
          if (!isAbsolute(database))
            throw new ArticleDownloadError('需要本机 SQLite 部署。', 409);
          return database;
        },
        () =>
          `${process.env.WECHAT2RSS_BASE_URL}\0${process.env.WECHAT2RSS_TOKEN}`,
        subscriptionQueue,
        async (prepare, directory, startedAt) => {
          if (this.running || this.pickerRunning)
            throw new ArticleDownloadError('正在处理其他本机操作。', 409);
          this.running = true;
          try {
            return await this.localStore().save(
              this.withExportSource(prepare),
              new Date(startedAt),
              directory,
            );
          } finally {
            this.running = false;
          }
        },
        () =>
          !this.running &&
          !this.pickerRunning &&
          !privateOnlineMode() &&
          process.env.WEWE_ACCEPTANCE_MODE !== '1',
      );
      subscriptionQueue.registerSubscriptionConsumer(this.singleTasks);
    }
  }
  onModuleDestroy() {
    this.browserTasks.close();
    this.singleTasks?.close();
  }
  private running = false;
  private pickerRunning = false;
  private store?: LocalArticleStore;
  private pickerGrant?: string;
  private readonly logger = new Logger(ArticleDownloadController.name);

  private authorized(req: Req, res: Res, mutation: boolean) {
    if (
      privateOnlineMode() ||
      !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(
        req.socket.remoteAddress || '',
      )
    ) {
      res.status(403).json({ message: '保存到 Obsidian 仅支持本机桌面访问。' });
      return false;
    }
    const authCode = this.config.get<string>('auth.code');
    if (authCode && req.headers.authorization !== authCode) {
      res.status(401).json({ message: '请先登录，或检查访问密码。' });
      return false;
    }
    try {
      const host = new URL(`${req.protocol}://${req.get('host')}`);
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname))
        throw new Error();
      const origin = req.headers.origin;
      if (
        (mutation && !origin) ||
        (origin && new URL(origin).origin !== host.origin)
      )
        throw new Error();
    } catch {
      res.status(403).json({ message: '请在本机工具页面操作。' });
      return false;
    }
    return true;
  }

  private localStore() {
    if (!this.store) {
      const raw = process.env.DATABASE_URL || '';
      const database = raw.startsWith('file:') ? raw.slice(5) : '';
      if (!isAbsolute(database))
        throw new ArticleDownloadError('此功能需要本机 SQLite 桌面部署。', 409);
      this.store = new LocalArticleStore(
        join(dirname(database), '.article-download-settings.json'),
      );
    }
    return this.store;
  }

  private withExportSource(
    prepare: (directory: string) => Promise<PreparedArticle>,
  ) {
    return async (directory: string) => {
      const article = await prepare(directory);
      const identity = /^WX_(\d{5,15})_\d+_\d+$/.exec(article.articleId);
      const feed =
        identity && this.prisma
          ? await this.prisma.feed.findUnique({
              where: { id: `MP_WXS_${identity[1]}` },
              include: { group: true },
            })
          : null;
      if (!feed)
        throw new ArticleDownloadError(
          '公众号来源记录缺失，未保存；请核对已受理订阅。',
          422,
          { code: 'EXPORT_SOURCE_MISSING' },
        );
      return { ...article, exportSource: exportSourceFromFeed(feed) };
    };
  }

  private failure(error: unknown, res: Res, articleUrl?: unknown) {
    const diagnostic =
      error instanceof ArticleDownloadError
        ? error.diagnostic
        : { code: 'LOCAL_SAVE_FAILED' };
    this.logger.warn(
      JSON.stringify({ event: 'article-download-failed', ...diagnostic }),
    );
    let verification;
    if (
      error instanceof ArticleDownloadError &&
      diagnostic.code === 'VERIFICATION_REDIRECT' &&
      diagnostic.stage === 'article'
    ) {
      try {
        const requested = downloadArticleUrl(articleUrl);
        const observed = error.officialVerification;
        const checked = articleVerificationLocation(
          observed?.status === 'available' && observed.articleUrl === requested
            ? observed.url
            : undefined,
          requested,
        );
        verification =
          observed?.status === 'unavailable' &&
          observed.articleUrl === requested
            ? {
                status: observed.status,
                articleUrl: requested,
                reason: observed.reason,
              }
            : checked.status === 'available'
              ? {
                  ...checked,
                  expiresAt: new Date(
                    Date.now() + ARTICLE_VERIFICATION_TTL_MS,
                  ).toISOString(),
                }
              : checked;
      } catch {
        // Never attach an unrelated verification URL to an invalid request.
      }
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return res
      .status(error instanceof ArticleDownloadError ? error.status : 500)
      .json({
        ...diagnostic,
        ...(verification ? { verification } : {}),
        message:
          error instanceof ArticleDownloadError
            ? error.message
            : '本机保存失败，请检查目录权限。',
      });
  }

  @Get('article/settings')
  async settings(@Request() req: Req, @Response() res: Res) {
    if (!this.authorized(req, res, false)) return;
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      return res.json(await this.localStore().read());
    } catch (error) {
      return this.failure(error, res);
    }
  }

  @Post('article/settings')
  @HttpCode(200)
  async updateSettings(
    @Body() body: { askEveryTime?: unknown },
    @Request() req: Req,
    @Response() res: Res,
  ) {
    if (!this.authorized(req, res, true)) return;
    if (this.running || this.pickerRunning)
      return res.status(409).json({ message: '请等待当前操作完成。' });
    // Preference persistence shares the same lock as picking and saving. Otherwise
    // a second tab can pick a directory or start a save before this policy commits.
    this.running = true;
    try {
      if (
        Object.keys(body || {}).some((key) => key !== 'askEveryTime') ||
        typeof body?.askEveryTime !== 'boolean'
      )
        throw new ArticleDownloadError('路径询问设置无效。', 400);
      return res.json(
        await this.localStore().setAskEveryTime(body.askEveryTime),
      );
    } catch (error) {
      return this.failure(error, res);
    } finally {
      this.running = false;
    }
  }

  @Post('article/directory')
  @HttpCode(200)
  async selectDirectory(@Request() req: Req, @Response() res: Res) {
    if (!this.authorized(req, res, true)) return;
    if (this.running || this.pickerRunning)
      return res.status(409).json({ message: '请等待当前操作完成。' });
    this.pickerRunning = true;
    this.pickerGrant = undefined;
    try {
      const store = this.localStore();
      const selected = await pickArticleDirectory(
        (await store.read()).directory,
      );
      if (selected === null) return res.json({ cancelled: true });
      const settings = await store.rememberPickedDirectory(selected);
      this.pickerGrant = randomUUID();
      return res.json({
        ...settings,
        pickToken: this.pickerGrant,
        cancelled: false,
      });
    } catch (error) {
      return this.failure(error, res);
    } finally {
      this.pickerRunning = false;
    }
  }

  @Post('article')
  @HttpCode(200)
  async article(
    @Body() body: { url?: unknown; pickToken?: unknown },
    @Request() req: Req,
    @Response() res: Res,
  ) {
    return this.saveArticle(body, req, res);
  }

  @Get('article/single-tasks')
  async singleTaskList(@Request() req: Req, @Response() res: Res) {
    if (!this.authorized(req, res, false)) return;
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      return res.json({
        tasks: this.singleTasks
          ? await this.singleTasks.list(this.taskOwner(req))
          : [],
      });
    } catch (error) {
      return this.failure(error, res);
    }
  }
  @Get('article/single-task/:taskId')
  async singleTask(
    @Param('taskId') taskId: string,
    @Request() req: Req,
    @Response() res: Res,
  ) {
    if (!this.authorized(req, res, false)) return;
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      if (!this.singleTasks)
        throw new ArticleDownloadError('下载任务未接入。', 409);
      return res.json(await this.singleTasks.get(taskId, this.taskOwner(req)));
    } catch (error) {
      return this.failure(error, res);
    }
  }
  @Get('article/single-task/:taskId/candidates')
  async singleCandidates(
    @Param('taskId') taskId: string,
    @Request() req: Req,
    @Response() res: Res,
  ) {
    if (!this.authorized(req, res, false)) return;
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      if (!this.singleTasks || process.env.WEWE_ACCEPTANCE_MODE === '1')
        throw new ArticleDownloadError('当前模式不能选择缓存文章。', 409);
      return res.json(
        await this.singleTasks.candidates(taskId, this.taskOwner(req)),
      );
    } catch (error) {
      return this.failure(error, res);
    }
  }
  @Post('article/single-task/:taskId/select')
  async singleSelect(
    @Param('taskId') taskId: string,
    @Body() body: unknown,
    @Request() req: Req,
    @Response() res: Res,
  ) {
    if (!this.authorized(req, res, true)) return;
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      if (
        !this.singleTasks ||
        process.env.WEWE_ACCEPTANCE_MODE === '1' ||
        this.running ||
        this.pickerRunning
      )
        throw new ArticleDownloadError(
          '当前不能选择文章，请等待本机操作完成。',
          409,
        );
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        Object.keys(body)[0] !== 'articleId'
      )
        throw new ArticleDownloadError(
          '选择请求仅接受缓存文章身份，不接受公众号、链接或路径。',
          400,
        );
      const task = await this.singleTasks.select(
        taskId,
        this.taskOwner(req),
        body['articleId'],
      );
      this.subscriptionQueue?.wakeSubscriptionConsumer();
      return res.status(task.state === 'saved' ? 200 : 202).json(task);
    } catch (error) {
      return this.failure(error, res);
    }
  }
  @Post('article/single-task/:taskId/:action')
  @HttpCode(200)
  async singleTaskAction(
    @Param('taskId') taskId: string,
    @Param('action') action: string,
    @Body() body: unknown,
    @Request() req: Req,
    @Response() res: Res,
  ) {
    if (!this.authorized(req, res, true)) return;
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      if (
        !this.singleTasks ||
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).length ||
        !['cancel', 'resume'].includes(action)
      )
        throw new ArticleDownloadError('下载任务操作无效。', 400);
      const result =
        action === 'cancel'
          ? await this.singleTasks.cancel(taskId, this.taskOwner(req))
          : await this.singleTasks.resume(taskId, this.taskOwner(req));
      this.subscriptionQueue?.wakeSubscriptionConsumer();
      return res.json(result);
    } catch (error) {
      return this.failure(error, res);
    }
  }

  private taskOwner(req: Req) {
    return createHash('sha256')
      .update(String(req.headers.authorization || ''))
      .digest('hex');
  }
  private taskFailure(error: unknown, res: Res) {
    const code =
      error instanceof BrowserTaskError
        ? error.code
        : error instanceof ArticleDownloadError
          ? 'TARGET_INVALID'
          : 'BROWSER_TASK_FAILED';
    return res
      .status(
        error instanceof BrowserTaskError ||
          error instanceof ArticleDownloadError
          ? error.status
          : 500,
      )
      .json({
        code,
        message:
          code === 'SAVE_DIRECTORY_CHANGED'
            ? '保存目录已改变，本次任务不能写入新目录。请取消任务，重新确认目录并取得新的接收许可后创建任务。'
            : code === 'DIRECTORY_PICK_REQUIRED'
              ? '请先选择本次保存目录，再创建官方文章接收任务。'
              : '官方文章接收任务未完成；未请求原文，也未改变订阅停止状态。',
      });
  }
  @Get('article/browser-task')
  browserTaskCapability(@Request() req: Req, @Response() res: Res) {
    if (!this.authorized(req, res, false)) return;
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json({
      ...this.browserTasks.capability(),
      available: false,
      code: 'WECHAT2RSS_ONLY',
    });
  }
  @Post('article/browser-task')
  async browserTaskIssue(
    @Body() body: { url?: unknown; pickToken?: unknown },
    @Request() req: Req,
    @Response() res: Res,
  ) {
    if (!this.authorized(req, res, true)) return;
    return this.wechat2RssOnly(res);
  }
  @Get('article/browser-task/:taskId')
  browserTaskStatus(
    @Param('taskId') taskId: string,
    @Request() req: Req,
    @Response() res: Res,
  ) {
    if (!this.authorized(req, res, false)) return;
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      return res.json(this.browserTasks.status(taskId, this.taskOwner(req)));
    } catch (error) {
      return this.taskFailure(error, res);
    }
  }
  @Post('article/browser-task/:taskId/cancel')
  browserTaskCancel(
    @Param('taskId') taskId: string,
    @Body() body: unknown,
    @Request() req: Req,
    @Response() res: Res,
  ) {
    if (!this.authorized(req, res, true)) return;
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).length
      )
        throw new BrowserTaskError('INPUT_SCHEMA', 400);
      return res
        .status(200)
        .json(this.browserTasks.cancel(taskId, this.taskOwner(req)));
    } catch (error) {
      return this.taskFailure(error, res);
    }
  }
  @Post('article/browser-task/:taskId/save')
  async browserTaskSave(
    @Param('taskId') taskId: string,
    @Body() body: { pickToken?: unknown },
    @Request() req: Req,
    @Response() res: Res,
  ) {
    if (!this.authorized(req, res, true)) return;
    return this.wechat2RssOnly(res);
  }

  /** Retained internal hook explicitly rejects alternate-source completions. */
  async saveVerifiedArticle(
    article: ProviderArticle,
    body: { url?: unknown; pickToken?: unknown },
    req: Req,
    res: Res,
    directoryPickConfirmed = false,
  ) {
    void directoryPickConfirmed;
    if (!this.authorized(req, res, true)) return;
    return this.wechat2RssOnly(res);
  }

  private wechat2RssOnly(res: Res) {
    return res.status(409).json({
      code: 'WECHAT2RSS_ONLY',
      message:
        '公众号单篇下载仅使用 Wechat2RSS 缓存；不接收其他渠道正文，未保存。',
    });
  }

  @Post('article/xiaohongshu/:noteId/save')
  @HttpCode(200)
  async saveXhsNote(
    @Param('noteId') noteId: string,
    @Body() body: { creatorId?: unknown; pickToken?: unknown },
    @Request() req: Req,
    @Response() res: Res,
  ) {
    if (!this.authorized(req, res, true)) return;
    if (process.env.WEWE_ACCEPTANCE_MODE === '1')
      return res.status(409).json({ message: '此验收模式未启用本机保存。' });
    if (!this.xiaohongshu)
      return res.status(409).json({ message: '小红书缓存保存服务尚未接线。' });
    try {
      if (
        !body ||
        Array.isArray(body) ||
        Object.keys(body).some(
          (key) => !['creatorId', 'pickToken'].includes(key),
        ) ||
        typeof body.creatorId !== 'string' ||
        !body.creatorId ||
        body.creatorId.length > 128 ||
        !noteId ||
        noteId.length > 300 ||
        (body.pickToken !== undefined && typeof body.pickToken !== 'string')
      )
        throw new ArticleDownloadError(
          '保存参数无效；仅支持已有笔记身份，不接受路径或正文。',
          400,
        );
      const prepare = await this.xiaohongshu.prepareLocalDownload(
        body.creatorId,
        noteId,
      );
      return this.saveArticle(
        { pickToken: body.pickToken },
        req,
        res,
        undefined,
        prepare,
      );
    } catch (error) {
      return this.failure(error, res);
    }
  }

  @Post('article/xiaohongshu/save')
  @HttpCode(200)
  async saveXhsNotes(
    @Body()
    body: { creatorId?: unknown; noteIds?: unknown; pickToken?: unknown },
    @Request() req: Req,
    @Response() res: Res,
  ) {
    if (!this.authorized(req, res, true)) return;
    if (process.env.WEWE_ACCEPTANCE_MODE === '1')
      return res.status(409).json({ message: '验收模式未启用本地保存。' });
    if (!this.xiaohongshu)
      return res.status(409).json({ message: '小红书缓存保存服务尚未接线。' });
    if (this.running || this.pickerRunning)
      return res.status(409).json({ message: '请等待当前本机操作完成。' });
    let savedCount = 0;
    let alreadySavedCount = 0;
    let videoCount = 0;
    this.running = true;
    try {
      if (
        !body ||
        Array.isArray(body) ||
        Object.keys(body).some(
          (key) => !['creatorId', 'noteIds', 'pickToken'].includes(key),
        ) ||
        typeof body.creatorId !== 'string' ||
        !body.creatorId ||
        body.creatorId.length > 128 ||
        !Array.isArray(body.noteIds) ||
        body.noteIds.length < 1 ||
        body.noteIds.length > 100 ||
        Array.from(body.noteIds).some(
          (id) => typeof id !== 'string' || !id || id.length > 300,
        ) ||
        (body.pickToken !== undefined && typeof body.pickToken !== 'string')
      )
        throw new ArticleDownloadError('请选择1至100篇完整缓存笔记。', 400);
      const store = this.localStore();
      if (
        (await store.read()).askEveryTime &&
        (!this.pickerGrant || body.pickToken !== this.pickerGrant)
      )
        throw new ArticleDownloadError('请先选择本次保存路径。', 409);
      // Validate every selected identity and cached body before creating files.
      // A caller cannot submit a path, body, media URL or another creator's note.
      const prepared: Awaited<
        ReturnType<XiaohongshuService['prepareLocalDownload']>
      >[] = [];
      for (const noteId of new Set(body.noteIds as string[]))
        prepared.push(
          await this.xiaohongshu.prepareLocalDownload(body.creatorId, noteId),
        );
      // One native selection grants this bounded batch in the remembered folder.
      // The same global lock also excludes picker and preference changes.
      this.pickerGrant = undefined;
      for (const prepare of prepared) {
        const result = await store.save(prepare);
        if (result.alreadySaved) alreadySavedCount++;
        else savedCount++;
        videoCount += result.videoCount || 0;
      }
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).json({
        saved: true,
        savedCount,
        alreadySavedCount,
        videoCount,
        ...(videoCount
          ? { videoDecoded: false, videoVerification: 'container-and-bytes' }
          : {}),
        contentSource: 'saved-xiaohongshu',
      });
    } catch (error) {
      if (savedCount || alreadySavedCount) {
        res.setHeader('Cache-Control', 'private, no-store');
        return res.status(422).json({
          saved: false,
          code: 'XHS_BATCH_SAVE_INCOMPLETE',
          savedCount,
          alreadySavedCount,
          videoCount,
          message: `本次保存未全部完成；已保存${savedCount}篇，已存在${alreadySavedCount}篇。已完成文件保留，请检查目录权限或磁盘空间后再选择未完成笔记。`,
        });
      }
      return this.failure(error, res);
    } finally {
      this.running = false;
    }
  }

  @Get('article/xiaohongshu/single')
  xhsSingleCapability(@Request() req: Req, @Response() res: Res) {
    if (!this.authorized(req, res, false)) return;
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json({
      platform: 'xiaohongshu',
      available:
        !!this.xhsSingleSource && process.env.WEWE_ACCEPTANCE_MODE !== '1',
      videoAvailable:
        this.xhsSingleSource?.videoEvidenceSupported === true &&
        process.env.WEWE_ACCEPTANCE_MODE !== '1',
      message: this.xhsSingleSource
        ? this.xhsSingleSource.videoEvidenceSupported === true
          ? '可保存已核完整缓存；视频另核字节与容器结构，不代表解码验收。'
          : '可核验单篇图文并保存；真实视频来源尚未接入。'
        : '单篇取文能力未接入，尚不能保存真实笔记。',
    });
  }

  @Post('article/xiaohongshu/single')
  @HttpCode(200)
  async saveXhsSingle(
    @Body() body: { url?: unknown; pickToken?: unknown },
    @Request() req: Req,
    @Response() res: Res,
  ) {
    if (!this.authorized(req, res, true)) return;
    res.setHeader('Cache-Control', 'private, no-store');
    if (process.env.WEWE_ACCEPTANCE_MODE === '1')
      return res.status(409).json({ message: '验收模式未启用本地保存。' });
    if (this.running || this.pickerRunning)
      return res.status(409).json({ message: '请等待当前本地操作完成。' });
    this.running = true;
    try {
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => !['url', 'pickToken'].includes(key)) ||
        (body.pickToken !== undefined && typeof body.pickToken !== 'string')
      )
        throw new ArticleDownloadError(
          '请求仅支持笔记链接与目录选择凭证。',
          400,
        );
      const url = xhsSingleNoteUrl(body.url);
      if (!this.xhsSingleSource)
        throw new ArticleDownloadError(
          '单篇取文能力未接入，未发起平台请求。',
          409,
          {
            code: 'XHS_SINGLE_SOURCE_UNCONFIGURED',
          },
        );
      const store = this.localStore();
      if (
        (await store.read()).askEveryTime &&
        (!this.pickerGrant || body.pickToken !== this.pickerGrant)
      )
        throw new ArticleDownloadError('请先选择本次保存路径。', 409);
      this.pickerGrant = undefined;
      const prepare = prepareXhsSingleDownload(
        url,
        await this.xhsSingleSource.read(url),
      );
      const result = await store.save(prepare);
      return res.status(200).json({
        saved: true,
        ...result,
        contentSource: 'verified-xiaohongshu-single',
        videoArchived: (result.videoCount || 0) > 0,
        ...((result.videoCount || 0) > 0
          ? { videoDecoded: false, videoVerification: 'container-and-bytes' }
          : {}),
      });
    } catch (error) {
      return this.failure(error, res);
    } finally {
      this.running = false;
    }
  }

  private async saveArticle(
    body: { url?: unknown; pickToken?: unknown },
    req: Req,
    res: Res,
    verified?: { article: ProviderArticle; directoryPickConfirmed?: boolean },
    cachedPrepare?: (directory: string) => Promise<{
      articleId: string;
      title: string;
      imageCount: number;
      videoCount?: number;
    }>,
  ) {
    if (!this.authorized(req, res, true)) return;
    if (process.env.WEWE_ACCEPTANCE_MODE === '1')
      return res.status(409).json({ message: '此验收模式未启用本机保存。' });
    if (this.running || this.pickerRunning)
      return res
        .status(409)
        .json({ message: '已有操作正在进行，请等待完成。' });
    let locked = false;
    try {
      if (
        Object.keys(body || {}).some(
          (key) => !['url', 'pickToken'].includes(key),
        )
      )
        throw new ArticleDownloadError('保存参数无效，请使用本机工具页。', 400);
      const url = cachedPrepare ? undefined : downloadArticleUrl(body?.url);
      this.running = true;
      locked = true;
      if (verified) return this.wechat2RssOnly(res);
      const store = this.localStore();
      if (
        (await store.read()).askEveryTime &&
        (!this.pickerGrant || body.pickToken !== this.pickerGrant)
      )
        return res.status(409).json({ message: '请先选择本次保存路径。' });
      this.pickerGrant = undefined;
      let prepare = cachedPrepare;
      if (!prepare) {
        try {
          prepare = await prepareWechat2RssSingleDownload(url!);
        } catch (error) {
          if (!singleCachePending(error) || !this.singleTasks) throw error;
          const task = await this.singleTasks.enqueue(
            url,
            this.taskOwner(req),
            (await store.read()).directory,
          );
          this.subscriptionQueue?.wakeSubscriptionConsumer();
          res.setHeader('Cache-Control', 'private, no-store');
          return res.status(202).json({ pending: true, task });
        }
      }
      const result = await store.save(
        cachedPrepare ? prepare : this.withExportSource(prepare),
      );
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).json({
        saved: true,
        ...result,
        ...(result.videoCount
          ? {
              videoArchived: true,
              videoDecoded: false,
              videoVerification: 'container-and-bytes',
            }
          : {}),
        contentSource: cachedPrepare ? 'saved-xiaohongshu' : 'wechat2rss-cache',
      });
    } catch (error) {
      return this.failure(error, res, body?.url);
    } finally {
      if (locked) this.running = false;
    }
  }
}
