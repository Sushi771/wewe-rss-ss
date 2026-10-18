import { ConfigService } from '@nestjs/config';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { buildArticleMarkdown } from './article-export';
import { TrpcService } from './trpc/trpc.service';
import { TrpcRouter } from './trpc/trpc.router';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
  'base64',
);
const sourceUrl =
  'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA%3D%3D&mid=2247000001&idx=1&sn=abcdef';
const launcher = '跳转微信打开';
const body = `<p>Article body</p><p><a href="https://example.org/author">Author reference</a></p><img alt="Article image" src="data:image/png;base64,${png.toString('base64')}">`;
const warning =
  '媒体完整性未确认：原缓存含无源或未核图片项。已保存正文和可取得的图片，不代表原篇全部媒体已归档。';
const article = (
  id: string,
  suffix = `<p><a href="weixin://dl/business/">${launcher}</a></p>`,
) => ({
  id,
  title: 'Article ' + id,
  sourceUrl,
  metrics: null,
  publishTime: 1791210060,
  lastBodyStatus: 'images-pending',
  contentHtml: `<div id="js_content" data-wewe-image-pending="1">${body}${suffix}</div>`,
});

describe('future Markdown contains article content without generated media notes or platform launchers', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wewe-clean-export-'));
    jest.spyOn(global, 'fetch').mockRejectedValue(Error('NO_NETWORK'));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    `<p><a href="javascript:;">${launcher}</a></p>`,
    `<p><a href="#">${launcher}</a></p>`,
    `<p>${launcher}</p>`,
    `<section><div><span>${launcher}</span></div></section>`,
    `<button>${launcher}</button>`,
    `<a href="weixin://dl/business/">${launcher}</a>`,
    `<p><a href="${sourceUrl}&scene=1">${launcher}</a></p>`,
    `<p><a href="${sourceUrl}"><span>${launcher}</span></a></p>\n<!-- footer --> <br>`,
  ])('removes only a standalone trailing launcher: %s', async (suffix) => {
    const snapshot = article('fixture', suffix);
    const before = { ...snapshot };
    const imageFetcher = jest.fn();
    const result = await buildArticleMarkdown(
      snapshot,
      '',
      root,
      imageFetcher,
      'image',
    );
    expect(result.markdown).not.toContain(launcher);
    expect(result.contentHtml).not.toContain(launcher);
    expect(result.markdown).not.toContain(warning);
    expect(result.markdown).toContain('Article body');
    expect(result.markdown).toContain(
      '[Author reference](https://example.org/author)',
    );
    expect(result.markdown).toMatch(
      /!\[Article image\]\(image\/image_[a-f0-9]+\.png\)/,
    );
    expect(result.mediaComplete).toBe(false);
    expect(result).toMatchObject({
      mediaStatus: 'unconfirmed',
      missingImageCount: 0,
    });
    expect(snapshot).toEqual(before);
    const images = await readdir(join(root, 'image'));
    expect(images).toHaveLength(1);
    expect(await readFile(join(root, 'image', images[0]))).toEqual(png);
    expect(imageFetcher).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    `<p><a href="https://example.org/author">${launcher}</a></p>`,
    `<p><a href="${sourceUrl.replace('2247000001', '2247000002')}">${launcher}</a></p>`,
    `<p>Author says <span>${launcher}</span></p>`,
    `<p>${launcher}</p><p>More article content</p>`,
    `<blockquote><p>${launcher}</p></blockquote>`,
    `<section><blockquote><p>${launcher}</p></blockquote></section>`,
    `<div><pre><code>${launcher}</code></pre></div>`,
    `<ul><li><p>${launcher}</p></li></ul>`,
    `<p><a href="weixin://dl/business/"><img alt="Author image" src="data:image/png;base64,${png.toString('base64')}">${launcher}</a></p>`,
  ])('preserves author content and images: %s', async (suffix) => {
    const result = await buildArticleMarkdown(
      article('fixture', suffix),
      'https://localhost',
    );
    expect(result.markdown).toContain(launcher);
    expect(result.markdown).toContain('Author reference');
    expect(result.markdown).toContain('data:image/png;base64,');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not remove identical words written by the author or change media state', async () => {
    const snapshot = article('fixture', `<p>${warning}</p>`);
    const result = await buildArticleMarkdown(snapshot, 'https://localhost');
    expect(result.markdown.split(warning)).toHaveLength(2);
    expect(result.mediaComplete).toBe(false);
    expect(snapshot.lastBodyStatus).toBe('images-pending');
  });

  it('single, batch, browser and same-directory incremental exports share the clean renderer while preserving edits and receipts', async () => {
    const feed = {
      id: 'MP_WXS_1234567890',
      mpName: 'Publisher',
      group: { id: 'g', name: 'Group' },
    };
    const rows = new Map(
      ['one', 'two', 'three'].map((id) => [id, { ...article(id), feed }]),
    );
    const prisma = {
      article: {
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
          rows.get(where.id),
        ),
      },
    };
    const config = new ConfigService({
      auth: { code: 'fixture' },
      platform: { url: '' },
      feed: { obsidianPath: root },
    });
    const router = new TrpcRouter(
      new TrpcService(prisma as any, config, {} as any, {} as any),
      prisma as any,
      config,
      {} as any,
      {} as any,
    );
    const api = router.appRouter.createCaller({
      errorMsg: null,
      isLocal: true,
    });
    const browser = await api.article.exportMarkdown('one');
    expect(browser.markdown).not.toContain(warning);
    expect(browser.markdown).not.toContain(launcher);
    expect(browser.markdown).toContain(
      '[Author reference](https://example.org/author)',
    );
    const single = await api.article.saveToObsidian('one');
    expect(single).toMatchObject({ success: false, mediaComplete: false });
    const batch = await Promise.all(
      ['two', 'three'].map((id) => api.article.saveToObsidian(id)),
    );
    for (const saved of [single, ...batch]) {
      const markdown = await readFile(saved.path, 'utf8');
      expect(markdown).not.toContain(warning);
      expect(markdown).not.toContain(launcher);
      expect(markdown).toContain('Article body');
      expect(markdown).toContain(
        '[Author reference](https://example.org/author)',
      );
      expect(markdown).toMatch(
        /!\[Article image\]\(image\/image_[a-f0-9_]+\.png\)/,
      );
      expect(saved.mediaComplete).toBe(false);
    }
    expect(
      new Set([single, ...batch].map((saved) => dirname(saved.path))).size,
    ).toBe(1);
    const note = await readFile(single.path, 'utf8');
    const edited =
      note + '\n\nUser edits and [a note](https://example.org/my-note)\n';
    await writeFile(single.path, edited);
    const receiptFolder = join(dirname(single.path), '.wewe-articles');
    const receiptsBefore = await Promise.all(
      (await readdir(receiptFolder)).map(async (name) => [
        name,
        await readFile(join(receiptFolder, name), 'utf8'),
      ]),
    );
    await api.article.saveToObsidian('one');
    expect(await readFile(single.path, 'utf8')).toBe(edited);
    expect(
      await Promise.all(
        (await readdir(receiptFolder)).map(async (name) => [
          name,
          await readFile(join(receiptFolder, name), 'utf8'),
        ]),
      ),
    ).toEqual(receiptsBefore);
    expect(
      [...rows.values()].every(
        (row) =>
          row.lastBodyStatus === 'images-pending' &&
          row.contentHtml.includes(launcher),
      ),
    ).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
});
