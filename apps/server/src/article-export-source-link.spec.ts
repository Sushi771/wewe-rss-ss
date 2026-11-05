import { ConfigService } from '@nestjs/config';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildArticleMarkdown } from './article-export';
import { TrpcService } from './trpc/trpc.service';
import { TrpcRouter } from './trpc/trpc.router';

const sourceUrl = 'https://mp.weixin.qq.com/s/synthetic-source';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
  'base64',
);
const feed = {
  id: 'MP_WXS_1234567890',
  mpName: 'Synthetic publisher',
  group: { id: 'group', name: 'Synthetic group' },
};
const article = (id: string, url: string | null = sourceUrl) => ({
  id,
  title: `Article ${id}`,
  sourceUrl: url,
  publishTime: 1791210060,
  metrics: JSON.stringify({
    like: { value: 0, display: '0', fileTime: '2026-10-01T00:00:00Z' },
  }),
  lastBodyStatus: 'available',
  contentHtml: `<div id="js_content"><p>Saved body</p><h2>Author section</h2><p><a href="${sourceUrl}">Author self-reference</a> and <a href="https://example.org/reference">Author reference</a></p><blockquote><h1>Quoted heading</h1><p>Original quotation</p></blockquote><img alt="Body image" src="data:image/png;base64,${png.toString('base64')}"></div>`,
  feed,
});
const sourceLines = (markdown: string) =>
  markdown.match(/^原文(?:链接)?：.*$/gm) || [];

describe('one generated source link and one displayed article title per future export', () => {
  let root: string;
  let router: TrpcRouter;
  let rows: Map<string, ReturnType<typeof article>>;
  let api: TrpcRouter['appRouter'] extends {
    createCaller: (...args: any[]) => infer T;
  }
    ? T
    : never;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wewe-export-source-link-'));
    jest.spyOn(global, 'fetch').mockRejectedValue(Error('NO_NETWORK'));
    rows = new Map(['one', 'two', 'three'].map((id) => [id, article(id)]));
    const prisma = {
      feed: { findUnique: jest.fn().mockResolvedValue(feed) },
      article: {
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
          rows.get(where.id),
        ),
        findMany: jest.fn().mockResolvedValue([...rows.values()]),
      },
    };
    const config = new ConfigService({
      auth: { code: 'fixture' },
      platform: { url: '' },
      feed: { obsidianPath: root, updateDelayTime: 0 },
    });
    router = new TrpcRouter(
      new TrpcService(prisma as any, config, {} as any, {} as any),
      prisma as any,
      config,
      {} as any,
      {} as any,
    );
    api = router.appRouter.createCaller({ errorMsg: null, isLocal: true });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  function expectContent(markdown: string) {
    expect(sourceLines(markdown)).toEqual([`原文链接：${sourceUrl}`]);
    expect(markdown).toContain('公众号：Synthetic publisher');
    expect(markdown).toContain('原文发布日期（上海时间）：2026-10-05');
    expect(markdown).toContain(`[Author self-reference](${sourceUrl})`);
    expect(markdown).toContain(
      '[Author reference](https://example.org/reference)',
    );
    expect(markdown).toContain('> Original quotation');
    expect(markdown).toMatch(/Author section\n-+/);
    expect(markdown).toContain('> Quoted heading');
    expect(markdown).toContain('| 点赞 | 0 | 2026-10-01T00:00:00Z |');
  }

  it('browser Markdown has one metadata link and retains author references and inline image bytes', async () => {
    const result = await api.article.exportMarkdown('one');
    expectContent(result.markdown);
    expect(result.markdown.match(/^# Article one$/gm)).toHaveLength(1);
    expect(result.markdown).toContain('![Body image](data:image/png;base64,');
    expect(result.markdown).toContain(png.toString('base64'));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('single and parallel saves have one metadata link without changing old notes, receipts or attachments', async () => {
    const saved = await Promise.all(
      ['one', 'two', 'three'].map((id) => api.article.saveToObsidian(id)),
    );
    for (const result of saved) {
      expect(result.success).toBe(true);
      const markdown = await readFile(result.path, 'utf8');
      expectContent(markdown);
      expect(markdown).not.toMatch(/^# Article /m);
      expect(markdown).toMatch(
        /!\[Body image\]\(image\/image_[a-f0-9_]+\.png\)/,
      );
    }
    const folder = dirname(saved[0].path);
    const imageFiles = await readdir(join(folder, 'image'));
    expect(imageFiles).toHaveLength(3);
    for (const file of imageFiles)
      expect(await readFile(join(folder, 'image', file))).toEqual(png);
    const oldNote = `# Article one\n\n${await readFile(saved[0].path, 'utf8')}\n原文：${sourceUrl}\nUser edit retained\n`;
    await writeFile(saved[0].path, oldNote);
    const receipts = join(folder, '.wewe-articles');
    const before = await Promise.all(
      (await readdir(receipts)).map(async (file) => [
        file,
        await readFile(join(receipts, file), 'utf8'),
      ]),
    );
    await api.article.saveToObsidian('one');
    expect(await readFile(saved[0].path, 'utf8')).toBe(oldNote);
    expect(
      await Promise.all(
        (await readdir(receipts)).map(async (file) => [
          file,
          await readFile(join(receipts, file), 'utf8'),
        ]),
      ),
    ).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('whole-feed offline export uses the same single source link policy', async () => {
    const result = await router.buildOfflineFeedDirectory(feed.id, root);
    expect(result).toMatchObject({ articles: 3, complete: 3 });
    const folder = join(root, '2026-10-05_Synthetic group', feed.mpName);
    const notes = (await readdir(folder)).filter((name) =>
      name.endsWith('.md'),
    );
    expect(notes).toHaveLength(3);
    for (const file of notes) {
      const markdown = await readFile(join(folder, file), 'utf8');
      expectContent(markdown);
      expect(markdown).not.toMatch(/^# Article /m);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('direct body-renderer callers keep their original standalone source link', async () => {
    const snapshot = article('direct');
    const result = await buildArticleMarkdown(snapshot, 'http://localhost');
    expect(sourceLines(result.markdown)).toEqual([`原文：${sourceUrl}`]);
    expect(result.markdown.match(/^# Article direct$/gm)).toHaveLength(1);
    expect(result.markdown).toContain(`[Author self-reference](${sourceUrl})`);
    expect(snapshot.contentHtml).toContain(png.toString('base64'));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('missing source URLs and missing-body placeholders do not reintroduce an Obsidian title', async () => {
    rows.get('one')!.sourceUrl = null;
    rows.get('two')!.contentHtml = '';
    const result = await router.buildOfflineFeedDirectory(feed.id, root);
    expect(result).toMatchObject({ articles: 3, complete: 2 });
    const folder = join(root, '2026-10-05_Synthetic group', feed.mpName);
    const withoutSource = await readFile(
      join(folder, 'Article one.md'),
      'utf8',
    );
    expect(sourceLines(withoutSource)).toEqual(['原文链接：未记录']);
    expect(withoutSource).not.toMatch(/^# Article /m);
    const missingBody = await readFile(join(folder, 'Article two.md'), 'utf8');
    expect(sourceLines(missingBody)).toEqual([`原文链接：${sourceUrl}`]);
    expect(missingBody).not.toMatch(/^# Article /m);
    expect(missingBody).toContain('正文或图片尚未完整归档');
    expect(fetch).not.toHaveBeenCalled();
  });
});
