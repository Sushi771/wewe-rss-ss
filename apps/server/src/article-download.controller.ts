import {
  Body,
  Controller,
  HttpCode,
  Post,
  Request,
  Response,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request as Req, Response as Res } from 'express';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ArticleDownloadError,
  buildArticleDownload,
  downloadArticleUrl,
} from './article-download';
import { archiveDirectory } from './offline-archive';
import { hasPrivateSession, privateOnlineMode } from './private-access';

@Controller('download')
export class ArticleDownloadController {
  constructor(private readonly config: ConfigService) {}

  private running = false;

  @Post('article')
  @HttpCode(200)
  async article(
    @Body() body: { url?: unknown },
    @Request() req: Req,
    @Response() res: Res,
  ) {
    const authCode = this.config.get<string>('auth.code');
    if (
      privateOnlineMode()
        ? !hasPrivateSession(req)
        : authCode && req.headers.authorization !== authCode
    )
      return res.status(401).json({ message: '请先登录，或检查访问密码。' });
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(
      req.socket.remoteAddress || '',
    );
    if (!privateOnlineMode() && !authCode && !local)
      return res.status(403).json({ message: '请先配置访问密码。' });
    const origin = req.headers.origin;
    const configured = this.config
      .get<string>('feed.originUrl')
      ?.replace(/\/$/, '');
    if (
      origin &&
      !(
        origin === (configured || `${req.protocol}://${req.get('host')}`) ||
        (local &&
          !privateOnlineMode() &&
          /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(origin))
      )
    )
      return res.status(403).json({ message: '请求来源不受支持。' });
    if (process.env.WEWE_ACCEPTANCE_MODE === '1')
      return res
        .status(409)
        .json({ message: '离线验收模式未启用原文网络下载。' });
    if (this.running)
      return res
        .status(409)
        .json({ message: '已有文章正在下载，请等待完成后再试。' });
    let temporary: string | undefined;
    try {
      const url = downloadArticleUrl(body?.url);
      this.running = true;
      temporary = await mkdtemp(join(tmpdir(), 'wewe-article-'));
      const folder = join(temporary, 'contents');
      await mkdir(folder);
      const result = await buildArticleDownload(url, folder);
      const archivePath = join(temporary, 'article.zip');
      await archiveDirectory(folder, archivePath);
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      await new Promise<void>((resolve, reject) => {
        res.download(archivePath, result.filename, (error) =>
          error ? reject(error) : resolve(),
        );
      });
    } catch (error) {
      if (!res.headersSent)
        res
          .status(error instanceof ArticleDownloadError ? error.status : 500)
          .json({
            message:
              error instanceof ArticleDownloadError
                ? error.message
                : '下载文件生成失败，请稍后重试。',
          });
      else res.destroy();
    } finally {
      // An invalid request must not unlock a different in-flight request.
      if (temporary) {
        try {
          await rm(temporary, { recursive: true, force: true });
        } finally {
          this.running = false;
        }
      } else if (this.running) {
        this.running = false;
      }
    }
  }
}
