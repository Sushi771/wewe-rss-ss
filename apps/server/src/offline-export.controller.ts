import { Controller, Get, Param, Response } from '@nestjs/common';
import { Response as Res } from 'express';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { TrpcRouter } from './trpc/trpc.router';
import { ZipArchive } from 'archiver';

// The archive is staged outside the workspace and removed after the response.

@Controller('download')
export class OfflineExportController {
  constructor(private readonly router: TrpcRouter) {}

  @Get('feed/:id.zip')
  async feedZip(@Param('id') id: string, @Response() res: Res) {
    if (!/^MP_WXS_\d{5,15}$/.test(id))
      return res.status(400).send('无效公众号 ID');
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'wewe-offline-'));
    try {
      const folder = path.join(temporary, 'contents');
      const result = await this.router.buildOfflineFeedDirectory(id, folder);
      if (!result) return res.status(404).send('公众号不存在');
      const archivePath = path.join(temporary, 'feed.zip');
      await new Promise<void>((resolve, reject) => {
        const output = createWriteStream(archivePath);
        const archive = new ZipArchive({ zlib: { level: 6 } });
        output.on('close', resolve);
        output.on('error', reject);
        archive.on('error', reject);
        archive.pipe(output);
        archive.directory(folder, false);
        archive.finalize().catch(reject);
      });
      const size = (await stat(archivePath)).size;
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Length', String(size));
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${id}.zip"; filename*=UTF-8''${encodeURIComponent(result.name)}.zip`,
      );
      res.setHeader('Cache-Control', 'private, no-store');
      await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(archivePath);
        stream.on('error', reject);
        res.on('close', resolve);
        stream.pipe(res);
      });
    } catch {
      if (!res.headersSent) res.status(500).send('离线打包失败，请稍后重试');
      else res.destroy();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
