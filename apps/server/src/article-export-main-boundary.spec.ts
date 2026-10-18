import { ConfigService } from '@nestjs/config';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { metricsMarkdown } from './article-export-metrics';
import { TrpcService } from './trpc/trpc.service';
import { TrpcRouter } from './trpc/trpc.router';

describe('main export extraction boundaries with synthetic cached articles', () => {
  it('omits unavailable metrics while retaining provided zero values', () => {
    const base = { id: 'fixture', title: 'Fixture', sourceUrl: null };
    expect(metricsMarkdown(base)).not.toContain('| 指标 |');
    const markdown = metricsMarkdown({
      ...base,
      metrics: JSON.stringify({
        like: { value: 0, display: '0', fileTime: '2026-10-01T00:00:00Z' },
      }),
    });
    expect(markdown).toContain('| 点赞 | 0 | 2026-10-01T00:00:00Z |');
    expect(markdown).not.toContain('| 阅读 |');
    expect(markdown).not.toContain('未获取');
  });

  it('keeps the existing two-argument offline export cached-only and reports absent bodies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wewe-main-offline-'));
    const network = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(Error('NO_NETWORK'));
    try {
      const feed = { id: 'MP_WXS_1234567890', mpName: 'Fixture', group: null };
      const base = {
        title: 'Article',
        sourceUrl: 'https://mp.weixin.qq.com/s/fixture',
        lastBodyStatus: 'available',
        metrics: null,
        publishTime: 1791210060,
      };
      const rows = [
        {
          ...base,
          id: 'cached',
          contentHtml:
            '<div id="js_content"><p>Cached body</p><p>跳转微信打开</p></div>',
        },
        { ...base, id: 'missing', contentHtml: null },
      ];
      const prisma = {
        feed: { findUnique: jest.fn().mockResolvedValue(feed) },
        article: { findMany: jest.fn().mockResolvedValue(rows) },
      };
      const config = new ConfigService({
        auth: { code: 'fixture' },
        platform: { url: '' },
        feed: { updateDelayTime: 0 },
      });
      const router = new TrpcRouter(
        new TrpcService(prisma as any, config, {} as any, {} as any),
        prisma as any,
        config,
        {} as any,
        {} as any,
      );
      const result = await router.buildOfflineFeedDirectory(feed.id, root);
      expect(result).toMatchObject({
        name: 'Fixture',
        articles: 2,
        complete: 1,
      });
      expect(result!.incompleteDetails).toEqual([
        expect.objectContaining({ reason: 'body-not-cached' }),
      ]);
      const group = (await readdir(root)).find((name) =>
        name.startsWith('2026-10-05_'),
      )!;
      const folder = join(root, group, feed.mpName);
      const notes = await Promise.all(
        (await readdir(folder))
          .filter((name) => name.endsWith('.md'))
          .map((name) => readFile(join(folder, name), 'utf8')),
      );
      expect(notes).toHaveLength(2);
      expect(notes.join('\n')).toContain('Cached body');
      expect(notes.join('\n')).not.toContain('跳转微信打开');
      expect(network).not.toHaveBeenCalled();
      expect(prisma.article.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ mpId: feed.id }),
        }),
      );
      const api = router.appRouter._def.procedures;
      expect(api['article.exportIds']).toBeUndefined();
      expect(api['article.supplementSavedMedia']).toBeDefined();
    } finally {
      network.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not introduce downloader or verification adapters into the export helpers', async () => {
    for (const file of [
      'article-export.ts',
      'article-export-source.ts',
      'article-export-metrics.ts',
      'article-local-save.ts',
      'article-local-save-error.ts',
      'cached-article-local-export.ts',
    ]) {
      const source = await readFile(join(__dirname, file), 'utf8');
      expect(source).not.toMatch(
        /from ['"][^'"]*(?:article-download|article-verified-download|xiaohongshu)[^'"]*['"]/,
      );
    }
  });
});
