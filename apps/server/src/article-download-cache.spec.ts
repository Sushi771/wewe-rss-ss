import { Article, PrismaClient } from '@prisma/client';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCachedArticleDownload,
  findCachedDownloadArticle,
} from './article-download-cache';

const url =
  'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA%3D%3D&mid=2247000001&idx=1&sn=abcdef';
const short = 'https://mp.weixin.qq.com/s/abcdefghijklmnopqrstuv';
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=';
const row = (): Article => ({
  id: 'WX_1234567890_2247000001_1',
  mpId: 'MP_WXS_1234567890',
  title: '已保存的正文',
  picUrl: '',
  publishTime: 1720000000,
  sourceUrl: url,
  verifiedSourceUrl: url,
  contentHtml: `<div id="js_content"><p>真实字段回归</p><img src="data:image/png;base64,${png}"></div>`,
  lastBodyStatus: 'available',
  lastBodyRetry: null,
  metrics: null,
  readCount: null,
  likeCount: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});
const db = (rows: Article[]) =>
  ({
    article: { findMany: jest.fn().mockResolvedValue(rows) },
  }) as unknown as Pick<PrismaClient, 'article'>;

describe('verified saved article download, no HTTP or database writes', () => {
  it('returns only a unique identity-backed complete cache and builds real local image files', async () => {
    const article = row(),
      prisma = db([article]);
    expect(await findCachedDownloadArticle(prisma, url)).toBe(article);
    expect(prisma.article.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 2 }),
    );
    const folder = await mkdtemp(join(tmpdir(), 'wewe-cached-download-'));
    const network = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('NO_HTTP'));
    try {
      expect(await buildCachedArticleDownload(article, folder)).toMatchObject({
        articleId: article.id,
        imageCount: 1,
      });
      const md = await readFile(join(folder, 'index.md'), 'utf8');
      expect(md).toContain('真实字段回归');
      expect(md).toContain('image/image_');
      const images = await readdir(join(folder, 'image'));
      expect(images).toHaveLength(1);
      expect(await readFile(join(folder, 'image', images[0]))).toEqual(
        Buffer.from(png, 'base64'),
      );
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('accepts an exact stored short link only with separately verified canonical identity, including a legacy ID', async () => {
    const article = { ...row(), id: 'legacy-id', sourceUrl: short };
    expect(await findCachedDownloadArticle(db([article]), short)).toBe(article);
    await expect(
      findCachedDownloadArticle(
        db([{ ...article, verifiedSourceUrl: null }]),
        short,
      ),
    ).rejects.toMatchObject({
      diagnostic: { code: 'CACHED_ARTICLE_UNAVAILABLE' },
    });
  });

  it.each([
    ['different publisher', { mpId: 'MP_WXS_9999999999' }],
    ['different canonical ID', { id: 'WX_1234567890_2247000002_1' }],
    [
      'conflicting verified URL',
      { verifiedSourceUrl: url.replace('2247000001', '2247000002') },
    ],
    ['missing body', { contentHtml: null }],
    ['unavailable body', { lastBodyStatus: 'unavailable' }],
    [
      'remote image',
      {
        contentHtml:
          '<div id="js_content"><p>old</p><img src="https://mmbiz.qpic.cn/a.jpg"></div>',
      },
    ],
    [
      'invalid bytes',
      {
        contentHtml:
          '<div id="js_content"><img src="data:image/png;base64,YQ=="></div>',
      },
    ],
    ['untrusted time', { publishTime: 0 }],
  ])('blocks %s without falling back to acquisition', async (_name, patch) => {
    await expect(
      findCachedDownloadArticle(db([{ ...row(), ...patch }]), url),
    ).rejects.toMatchObject({
      diagnostic: { code: 'CACHED_ARTICLE_UNAVAILABLE' },
    });
  });

  it('does not invent short-link mappings, rejects ambiguity, and allows a real text-only body', async () => {
    expect(await findCachedDownloadArticle(db([]), short)).toBeNull();
    await expect(
      findCachedDownloadArticle(db([row(), row()]), url),
    ).rejects.toMatchObject({
      diagnostic: { code: 'CACHED_ARTICLE_UNAVAILABLE' },
    });
    const article = {
      ...row(),
      contentHtml: '<div id="js_content"><p>文字全文</p></div>',
    };
    expect(await findCachedDownloadArticle(db([article]), url)).toBe(article);
  });

  it('strips executable body content with the existing tool policy before Markdown conversion', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'wewe-cached-inert-'));
    try {
      await buildCachedArticleDownload(
        {
          ...row(),
          contentHtml:
            '<div id="js_content" onclick="bad()"><script>bad()</script><p onclick="bad()">正文</p><iframe src="http://evil.invalid"></iframe><a href="http://evil.invalid">链接文字</a></div>',
        },
        folder,
      );
      const md = await readFile(join(folder, 'index.md'), 'utf8');
      expect(md).toContain('正文');
      expect(md).not.toMatch(/bad\(\)|iframe|evil\.invalid|onclick/);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});
