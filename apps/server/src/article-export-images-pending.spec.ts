import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildArticleMarkdown } from './article-export';
import { LocalArticleStore } from './article-local-save';
import { prepareVerifiedProviderDownload } from './article-verified-download';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
  'base64',
);
const url =
  'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA%3D%3D&mid=2247000001&idx=1&sn=abcdef';
const body = `<div id="js_content" data-wewe-image-pending="1"><p>可靠正文</p><img data-wewe-image-unconfirmed="true"><img src="data:image/png;base64,${png.toString('base64')}"></div>`;
const article = {
  id: 'WX_1234567890_2247000001_1',
  title: '合成文章',
  sourceUrl: url,
  metrics: null,
  publishTime: 1700000000,
  contentHtml: body,
  lastBodyStatus: 'images-pending',
};

describe('unconfirmed media preserves usable text and valid image export', () => {
  let folder: string;
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'wewe-media-unconfirmed-'));
  });
  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('saves reliable text and actual image bytes, reports the limit and preserves edited duplicate notes', async () => {
    const store = new LocalArticleStore(
      join(folder, 'preferences.json'),
      join(folder, 'notes'),
    );
    const fetcher = jest.fn();
    const prepare = async (directory: string) => {
      const result = await buildArticleMarkdown(
        article,
        '',
        directory,
        fetcher,
        'image',
      );
      await writeFile(join(directory, 'index.md'), result.markdown);
      return {
        articleId: article.id,
        title: article.title,
        imageCount: 1,
        mediaComplete: result.mediaComplete,
      };
    };
    const saved = await store.save(prepare);
    expect(saved).toMatchObject({ imageCount: 1, mediaComplete: false });
    const markdown = await readFile(saved.markdownPath, 'utf8');
    expect(markdown).toContain('可靠正文');
    expect(markdown).toContain('媒体完整性未确认');
    const images = await readdir(join(saved.directory, 'image'));
    expect(images).toHaveLength(1);
    expect(await readFile(join(saved.directory, 'image', images[0]))).toEqual(
      png,
    );
    expect(
      JSON.parse(
        await readFile(join(saved.directory, '.wewe-article.json'), 'utf8'),
      ),
    ).toMatchObject({ complete: true, mediaComplete: false });
    await writeFile(saved.markdownPath, '用户编辑');
    expect(await store.save(prepare)).toMatchObject({
      alreadySaved: true,
      mediaComplete: false,
    });
    expect(await readFile(saved.markdownPath, 'utf8')).toBe('用户编辑');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps the unconfirmed flag through verified sanitization without counting a source-less tag as a saved image', async () => {
    const providerArticle = {
      id: article.id,
      mpId: 'MP_WXS_1234567890',
      picUrl: '',
      title: article.title,
      url,
      publishTime: article.publishTime,
      contentHtml: body,
    };
    const prepare = prepareVerifiedProviderDownload(url, providerArticle, true);
    expect(await prepare(folder)).toMatchObject({
      imageCount: 1,
      mediaComplete: false,
    });
    expect(await readFile(join(folder, 'index.md'), 'utf8')).toContain(
      '媒体完整性未确认',
    );
    expect(() =>
      prepareVerifiedProviderDownload(url, providerArticle),
    ).toThrow();
  });

  it('keeps usable text when a known pending image still fails, while retaining valid images', async () => {
    const fetcher = jest.fn();
    fetcher.mockRejectedValue(new Error('OFFLINE'));
    const exported = await buildArticleMarkdown(
      {
        ...article,
        contentHtml: body.replace(
          '</div>',
          '<img data-src="https://mmbiz.qpic.cn/fixture.png"></div>',
        ),
      },
      '',
      folder,
      fetcher,
      'image',
    );
    expect(exported.mediaComplete).toBe(false);
    expect(exported.markdown).toContain('可靠正文');
    expect(exported.markdown).toContain('媒体完整性未确认');
    expect(exported.markdown).not.toContain('qpic.cn');
    expect(await readdir(join(folder, 'image'))).toHaveLength(1);
  });
});
