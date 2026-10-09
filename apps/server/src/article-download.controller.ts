import {
  Body,
  Controller,
  Get,
  HttpCode,
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
import {
  ArticleDownloadError,
  buildArticleDownload,
  downloadArticleUrl,
} from './article-download';
import { LocalArticleStore } from './article-local-save';
import { pickArticleDirectory } from './article-folder-picker';
import { privateOnlineMode } from './private-access';
import { PrismaService } from './prisma/prisma.service';
import {
  buildCachedArticleDownload,
  findCachedDownloadArticle,
} from './article-download-cache';
import { ProviderArticle } from './collection/subscription-provider';
import { prepareVerifiedProviderDownload } from './article-verified-download';
import { BrowserTaskBroker, BrowserTaskError } from './browser-task';
import { BrowserArticleTasks } from './browser-article-tasks';
import { XiaohongshuService } from './collection/xiaohongshu.service';
import {
  ARTICLE_VERIFICATION_TTL_MS,
  articleVerificationLocation,
} from '../../../packages/shared/src/article-verification';

@Controller('download')
export class ArticleDownloadController implements OnModuleDestroy {
  private readonly browserTasks: BrowserArticleTasks;
  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly prisma?: PrismaService,
    @Optional() browserBroker?: BrowserTaskBroker,
    @Optional() private readonly xiaohongshu?: XiaohongshuService,
  ) {
    // Default AppModule supplies no broker. An explicitly approved short-lived
    // opt-in root supplies the same configured broker to both controllers.
    this.browserTasks = new BrowserArticleTasks(
      browserBroker || new BrowserTaskBroker(),
    );
  }
  onModuleDestroy() {
    this.browserTasks.close();
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
    return res.json(this.browserTasks.capability());
  }
  @Post('article/browser-task')
  async browserTaskIssue(
    @Body() body: { url?: unknown; pickToken?: unknown },
    @Request() req: Req,
    @Response() res: Res,
  ) {
    if (!this.authorized(req, res, true)) return;
    res.setHeader('Cache-Control', 'private, no-store');
    if (this.running || this.pickerRunning)
      return res.status(409).json({
        code: 'LOCAL_OPERATION_BUSY',
        message: '请等待当前本机操作完成。',
      });
    try {
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).some((k) => !['url', 'pickToken'].includes(k))
      )
        throw new BrowserTaskError('INPUT_SCHEMA', 400);
      const fixed = this.browserTasks.requiresDisclosure();
      const settings = fixed ? await this.localStore().read() : undefined;
      const picked = !!settings?.askEveryTime;
      if (picked && (!this.pickerGrant || body.pickToken !== this.pickerGrant))
        throw new BrowserTaskError('DIRECTORY_PICK_REQUIRED', 409);
      const issued = this.browserTasks.issue(
        downloadArticleUrl(body.url),
        this.taskOwner(req),
        settings?.directory,
        picked,
      );
      // Native selection is consumed by this fixed task, not reusable by an
      // ordinary save. The task retains the scoped proof for same-directory retries.
      if (picked) this.pickerGrant = undefined;
      return res.status(200).json(issued);
    } catch (error) {
      return this.taskFailure(error, res);
    }
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
    res.setHeader('Cache-Control', 'private, no-store');
    const owner = this.taskOwner(req);
    let began = false;
    try {
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).some((k) => k !== 'pickToken')
      )
        throw new BrowserTaskError('INPUT_SCHEMA', 400);
      const verified = this.browserTasks.beginSave(taskId, owner);
      began = true;
      if (
        verified.destination &&
        (await this.localStore().read()).directory !== verified.destination
      )
        throw new BrowserTaskError('SAVE_DIRECTORY_CHANGED', 409);
      // Current request rechecks auth, Origin, local save lock and directory grant.
      // The app cannot submit HTML/Provider/URL or spoof the extension's completion.
      await this.saveVerifiedArticle(
        verified.article,
        { url: verified.url, pickToken: body.pickToken },
        req,
        res,
        !!verified.destination && verified.directoryPickConfirmed === true,
      );
      if (res.statusCode === 200) this.browserTasks.saved(taskId, owner);
      else this.browserTasks.saveFailed(taskId, owner);
    } catch (error) {
      if (began)
        this.browserTasks.saveFailed(
          taskId,
          owner,
          error instanceof BrowserTaskError &&
            error.code === 'SAVE_DIRECTORY_CHANGED'
            ? 'SAVE_DIRECTORY_CHANGED'
            : 'SAVE_RETRY_REQUIRED',
        );
      if (!res.headersSent) return this.taskFailure(error, res);
    }
  }

  /** Internal completion for the normal verification/collection owner.
   * Deliberately has no HTTP decorator: page JSON cannot submit provider bodies.
   * The caller supplies a verified, archived result and the original local request.
   */
  async saveVerifiedArticle(
    article: ProviderArticle,
    body: { url?: unknown; pickToken?: unknown },
    req: Req,
    res: Res,
    directoryPickConfirmed = false,
  ) {
    return this.saveArticle(body, req, res, {
      article,
      directoryPickConfirmed,
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

  private async saveArticle(
    body: { url?: unknown; pickToken?: unknown },
    req: Req,
    res: Res,
    verified?: { article: ProviderArticle; directoryPickConfirmed?: boolean },
    cachedPrepare?: (
      directory: string,
    ) => Promise<{ articleId: string; title: string; imageCount: number }>,
  ) {
    if (!this.authorized(req, res, true)) return;
    if (process.env.WEWE_ACCEPTANCE_MODE === '1')
      return res
        .status(409)
        .json({ message: '离线验收模式未启用原文网络下载。' });
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
      const prepare =
        cachedPrepare ||
        (verified
          ? prepareVerifiedProviderDownload(url!, verified.article)
          : undefined);
      const store = this.localStore();
      if (
        (await store.read()).askEveryTime &&
        !verified?.directoryPickConfirmed &&
        (!this.pickerGrant || body.pickToken !== this.pickerGrant)
      )
        return res.status(409).json({ message: '请先选择本次保存路径。' });
      this.pickerGrant = undefined;
      const cached =
        !prepare && this.prisma
          ? await findCachedDownloadArticle(this.prisma, url!)
          : null;
      const result = await store.save((directory) =>
        prepare
          ? prepare(directory)
          : cached
            ? buildCachedArticleDownload(cached, directory)
            : buildArticleDownload(url!, directory, undefined, {
                imageDirectory: 'image',
                markdownOnly: true,
              }),
      );
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).json({
        saved: true,
        ...result,
        contentSource: cachedPrepare
          ? 'saved-xiaohongshu'
          : prepare
            ? 'verified-provider'
            : cached
              ? 'saved-article'
              : 'remote',
      });
    } catch (error) {
      return this.failure(error, res, body?.url);
    } finally {
      if (locked) this.running = false;
    }
  }
}
