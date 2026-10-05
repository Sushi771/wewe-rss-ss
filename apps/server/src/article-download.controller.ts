import {
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Optional,
  Post,
  Request,
  Response,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request as Req, Response as Res } from 'express';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
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

@Controller('download')
export class ArticleDownloadController {
  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly prisma?: PrismaService,
  ) {}
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

  private failure(error: unknown, res: Res) {
    const diagnostic =
      error instanceof ArticleDownloadError
        ? error.diagnostic
        : { code: 'LOCAL_SAVE_FAILED' };
    this.logger.warn(
      JSON.stringify({ event: 'article-download-failed', ...diagnostic }),
    );
    return res
      .status(error instanceof ArticleDownloadError ? error.status : 500)
      .json({
        ...diagnostic,
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
      const url = downloadArticleUrl(body?.url);
      this.running = true;
      locked = true;
      const store = this.localStore();
      if (
        (await store.read()).askEveryTime &&
        (!this.pickerGrant || body.pickToken !== this.pickerGrant)
      )
        return res.status(409).json({ message: '请先选择本次保存路径。' });
      this.pickerGrant = undefined;
      const cached = this.prisma
        ? await findCachedDownloadArticle(this.prisma, url)
        : null;
      const result = await store.save((directory) =>
        cached
          ? buildCachedArticleDownload(cached, directory)
          : buildArticleDownload(url, directory, undefined, {
              imageDirectory: 'image',
              markdownOnly: true,
            }),
      );
      res.setHeader('Cache-Control', 'private, no-store');
      return res.json({
        saved: true,
        ...result,
        contentSource: cached ? 'saved-article' : 'remote',
      });
    } catch (error) {
      return this.failure(error, res);
    } finally {
      if (locked) this.running = false;
    }
  }
}
