import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildArticleMarkdown, cachedMediaUnconfirmed } from './article-export';
import { LocalArticleStore } from './article-local-save';
import { prepareCachedArticleLocalExport } from './cached-article-local-export';
import * as images from './collection/image-fetch';

jest.mock('./collection/image-fetch', () => ({
  ...jest.requireActual('./collection/image-fetch'),
  fetchAllowedImage: jest.fn(),
}));
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
  'base64',
);
const remote = 'https://mmbiz.qpic.cn/fixture.png';
const article = {
  id: 'WX_1234567890_2247000001_1',
  title: 'Offline fixture',
  sourceUrl: 'https://mp.weixin.qq.com/s/test',
  metrics: null,
  publishTime: 1791210060,
  lastBodyStatus: 'available',
  contentHtml: `<div id="js_content"><p>Retained body</p><img src="${remote}"><img src="${remote}"></div>`,
};

describe('body media status with synthetic bytes and mocked requests only', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wewe-export-status-'));
    jest.mocked(images.fetchAllowedImage).mockReset();
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  it('marks rejected browser sources unknown, retaining text without a fetch', async () => {
    const invalid = {
      ...article,
      contentHtml:
        '<div id="js_content"><p>Retained body</p><img src="javascript:alert(1)"></div>',
    };
    const result = await buildArticleMarkdown(invalid, 'http://localhost');
    expect(result).toMatchObject({
      mediaComplete: false,
      mediaStatus: 'unconfirmed',
      missingImageCount: 0,
    });
    expect(result.markdown).toContain('Retained body');
    expect(result.contentHtml).not.toContain('<img');
    expect(cachedMediaUnconfirmed(invalid)).toBe(true);
    expect(
      prepareCachedArticleLocalExport(invalid).identity?.mediaComplete,
    ).toBe(false);
    expect(images.fetchAllowedImage).not.toHaveBeenCalled();
  });

  it('keeps valid cached body despite retry failure and ignores decorative images outside the body', async () => {
    const result = await buildArticleMarkdown(
      {
        ...article,
        lastBodyStatus: 'unavailable',
        contentHtml:
          '<img src="javascript:outside"><div id="js_content"><p>Retained body</p></div><img>',
      },
      '',
      root,
    );
    expect(result).toMatchObject({
      mediaComplete: true,
      mediaStatus: 'complete',
      missingImageCount: 0,
    });
    expect(images.fetchAllowedImage).not.toHaveBeenCalled();
  });

  it('downloads repeated references once and charges the physical bytes once', async () => {
    jest
      .mocked(images.fetchAllowedImage)
      .mockResolvedValue({ bytes: png, type: 'image/png' });
    const result = await buildArticleMarkdown(
      article,
      '',
      root,
      images.fetchAllowedImage,
      'image',
      { maxImages: 2, maxBytes: png.length },
    );
    expect(result.mediaComplete).toBe(true);
    expect(images.fetchAllowedImage).toHaveBeenCalledTimes(1);
    expect(await readdir(join(root, 'image'))).toHaveLength(1);
  });
  it('ignores outside decoration while reusing legacy inline images during repair', async () => {
    const source = {
      feedId: 'MP_WXS_1234567890',
      feedName: 'Fixture',
      groupId: 'g',
      groupName: 'Group',
    };
    const store = new LocalArticleStore(join(root, 'settings.json'), root);
    const cached = {
      ...article,
      lastBodyStatus: 'images-pending',
      contentHtml: `<div id="js_content"><p>Body</p><img src="data:image/png;base64,${png.toString('base64')}"></div>`,
    };
    const first = await store.save(
      prepareCachedArticleLocalExport(cached, source),
    );
    const receipts = join(first.directory, '.wewe-articles');
    const receiptFile = join(
      receipts,
      (await readdir(receipts)).find((name) => name.endsWith('.json'))!,
    );
    const receipt = JSON.parse(await readFile(receiptFile, 'utf8'));
    delete receipt.imageMap;
    await writeFile(receiptFile, JSON.stringify(receipt));
    const current = {
      ...cached,
      lastBodyStatus: 'available',
      contentHtml:
        '<img src="https://mmbiz.qpic.cn/avatar.png">' +
        cached.contentHtml +
        '<img src="data:image/png;base64,YQ==">',
    };
    expect(
      await store.save(prepareCachedArticleLocalExport(current, source)),
    ).toMatchObject({ status: 'repaired', mediaComplete: true, imageCount: 1 });
    expect(images.fetchAllowedImage).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent downloads without a byte limit too', async () => {
    jest.mocked(images.fetchAllowedImage).mockImplementation(async () => {
      await Promise.resolve();
      return { bytes: png, type: 'image/png' };
    });
    await buildArticleMarkdown(article, '', root);
    expect(images.fetchAllowedImage).toHaveBeenCalledTimes(1);
  });

  it('retains text and successful bytes when a known source fails; explicit retry fetches only the missing source', async () => {
    const good = `data:image/png;base64,${png.toString('base64')}`;
    const cached = {
      ...article,
      contentHtml: article.contentHtml.replace(
        '</div>',
        `<img src="${good}"></div>`,
      ),
    };
    const source = {
      feedId: 'MP_WXS_1234567890',
      feedName: 'Fixture',
      groupId: 'g',
      groupName: 'Group',
    };
    const store = new LocalArticleStore(join(root, 'settings.json'), root);
    jest
      .mocked(images.fetchAllowedImage)
      .mockRejectedValue(new Error('OFFLINE'));
    const first = await store.save(
      prepareCachedArticleLocalExport(cached, source),
    );
    expect(first).toMatchObject({
      mediaComplete: false,
      mediaStatus: 'missing',
      missingImageCount: 1,
      status: 'failed',
      imageCount: 1,
    });
    expect(await readFile(first.markdownPath, 'utf8')).toContain(
      'Retained body',
    );
    expect(images.fetchAllowedImage).toHaveBeenCalledTimes(1);
    await writeFile(first.markdownPath, 'User notes');
    jest
      .mocked(images.fetchAllowedImage)
      .mockReset()
      .mockResolvedValue({ bytes: png, type: 'image/png' });
    const repaired = await store.save(
      prepareCachedArticleLocalExport(cached, source),
    );
    expect(repaired).toMatchObject({
      mediaComplete: true,
      mediaStatus: 'complete',
      missingImageCount: 0,
      status: 'repaired',
    });
    expect(images.fetchAllowedImage).toHaveBeenCalledTimes(1);
    expect(await readFile(first.markdownPath, 'utf8')).toBe('User notes');
    expect(
      (await store.save(prepareCachedArticleLocalExport(cached, source)))
        .status,
    ).toBe('skipped');
    expect(images.fetchAllowedImage).toHaveBeenCalledTimes(1);
  });
  it('extends a previously complete receipt when the cache gains another source, without redownloading existing media', async () => {
    const source = {
      feedId: 'MP_WXS_1234567890',
      feedName: 'Fixture',
      groupId: 'g',
      groupName: 'Group',
    };
    const store = new LocalArticleStore(join(root, 'settings.json'), root);
    jest
      .mocked(images.fetchAllowedImage)
      .mockResolvedValue({ bytes: png, type: 'image/png' });
    const first = await store.save(
      prepareCachedArticleLocalExport(article, source),
    );
    expect(first.mediaComplete).not.toBe(false);
    await writeFile(first.markdownPath, 'User notes');
    const updated = {
      ...article,
      contentHtml: article.contentHtml.replace(
        '</div>',
        '<img src="https://mmbiz.qpic.cn/new.png"></div>',
      ),
    };
    jest
      .mocked(images.fetchAllowedImage)
      .mockRejectedValueOnce(new Error('OFFLINE'));
    const failed = await store.save(
      prepareCachedArticleLocalExport(updated, source),
    );
    expect(failed).toMatchObject({
      status: 'failed',
      mediaComplete: false,
      mediaStatus: 'missing',
      missingImageCount: 1,
    });
    expect(await readFile(first.markdownPath, 'utf8')).toBe('User notes');
    jest.mocked(images.fetchAllowedImage).mockClear();
    const repaired = await store.save(
      prepareCachedArticleLocalExport(updated, source),
    );
    expect(repaired).toMatchObject({
      status: 'repaired',
      mediaStatus: 'complete',
      // Both synthetic sources return identical bytes, so the publisher keeps
      // one physical content-hashed file while recording both source mappings.
      imageCount: 1,
    });
    expect(images.fetchAllowedImage).toHaveBeenCalledTimes(1);
    expect(jest.mocked(images.fetchAllowedImage).mock.calls[0][0]).toContain(
      '/new.png',
    );
    expect(await readFile(first.markdownPath, 'utf8')).toBe('User notes');
    expect(
      (await store.save(prepareCachedArticleLocalExport(updated, source)))
        .status,
    ).toBe('skipped');
    expect(images.fetchAllowedImage).toHaveBeenCalledTimes(1);
  });
});
