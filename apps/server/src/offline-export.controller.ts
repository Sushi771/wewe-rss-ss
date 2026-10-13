import { articleFilterSchema } from '@wewe-rss/shared';
import { Controller, Get, Param, Query, Response } from '@nestjs/common';
import { Response as Res } from 'express';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { TrpcRouter } from './trpc/trpc.router';
import { archiveDirectory } from './offline-archive';

// The archive is staged outside the workspace and removed after the response.

@Controller('download')
export class OfflineExportController {
  constructor(private readonly router: TrpcRouter) {}

  @Get('feed/:id.zip')
  async feedZip(
    @Param('id') id: string,
    @Response() res: Res,
    @Query() query: Record<string, unknown> = {},
  ) {
    if (!/^MP_WXS_\d{5,15}$/.test(id))
      return res.status(400).send('无效公众号 ID');
    if (
      Object.keys(query).some(
        (key) =>
          !['scope', 'dateStart', 'dateEnd', 'search', 'group'].includes(key),
      ) ||
      (query.scope !== undefined &&
        query.scope !== 'all' &&
        query.scope !== 'filtered') ||
      (query.scope !== 'filtered' &&
        Object.keys(query).some((key) => key !== 'scope'))
    )
      return res.status(400).send('请选择整号快照或当前筛选范围');
    const filter = articleFilterSchema.safeParse(
      query.scope === 'filtered'
        ? {
            dateStart: query.dateStart,
            dateEnd: query.dateEnd,
            search: query.search,
            group: query.group,
          }
        : {},
    );
    if (!filter.success) return res.status(400).send('导出筛选无效');
    let cancelled = false;
    res.on('close', () => {
      cancelled = true;
    });
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'wewe-offline-'));
    try {
      const folder = path.join(temporary, 'contents');
      const result = await this.router.buildOfflineFeedDirectory(
        id,
        folder,
        filter.data,
        () => cancelled,
      );
      if (cancelled) return;
      if (!result) return res.status(404).send('公众号不存在');
      const archivePath = path.join(temporary, 'feed.zip');
      await archiveDirectory(folder, archivePath);
      if (cancelled) return;
      const size = (await stat(archivePath)).size;
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Length', String(size));
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${id}.zip"; filename*=UTF-8''${encodeURIComponent(result.name + (query.scope === 'filtered' ? '-当前筛选' : '-整号快照'))}.zip`,
      );
      res.setHeader('Cache-Control', 'private, no-store');
      await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(archivePath);
        stream.on('error', reject);
        const finish = () => {
          stream.destroy();
          resolve();
        };
        res.once('close', finish);
        res.once('finish', finish);
        stream.pipe(res);
      });
    } catch {
      if (cancelled) return;
      if (!res.headersSent) res.status(500).send('离线打包失败，请稍后重试');
      else res.destroy();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
