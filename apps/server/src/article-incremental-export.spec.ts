import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalArticleStore, ArticlePreparation } from './article-local-save';
import { prepareCachedArticleLocalExport } from './cached-article-local-export';
import * as images from './collection/image-fetch';

jest.mock('node:fs/promises', () => ({
  __esModule: true,
  ...jest.requireActual('node:fs/promises'),
}));
jest.mock('./collection/image-fetch', () => ({
  ...jest.requireActual('./collection/image-fetch'),
  fetchAllowedImage: jest.fn(),
}));
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
  'base64',
);
const other = Buffer.concat([png, Buffer.from('second')]);
const source = {
  feedId: 'MP_WXS_1234567890',
  feedName: 'Test',
  groupId: 'g',
  groupName: 'Group',
};
const article = {
  id: 'WX_1234567890_2247000001_1',
  title: 'Fixture',
  sourceUrl: 'https://mp.weixin.qq.com/s/test',
  publishTime: 1791210060,
  metrics: null,
  lastBodyStatus: 'available',
  contentHtml:
    '<div id="js_content"><p>Body</p><img src="https://mmbiz.qpic.cn/a.png"><img src="https://mmbiz.qpic.cn/b.png"></div>',
};

describe('incremental export: synthetic files and mocked media only', () => {
  let root: string;
  let store: LocalArticleStore;
  const prepare = (patch = {}) =>
    prepareCachedArticleLocalExport({ ...article, ...patch }, source);
  const receiptAt = async (folder: string) =>
    join(
      folder,
      '.wewe-articles',
      (await fs.readdir(join(folder, '.wewe-articles'))).find((name) =>
        name.endsWith('.json'),
      )!,
    );
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'wewe-incremental-'));
    store = new LocalArticleStore(join(root, 'settings.json'), root);
    jest
      .mocked(images.fetchAllowedImage)
      .mockReset()
      .mockImplementation(async (url) => ({
        bytes: url.includes('/b.') ? other : png,
        type: 'image/png',
      }));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('skips before prepare or temporary generation, across changed dates/title and missing database body', async () => {
    const first = await store.save(prepare());
    await fs.writeFile(first.markdownPath, 'User edits and notes');
    jest.mocked(images.fetchAllowedImage).mockClear();
    const base = prepare({
      contentHtml: null,
      lastBodyStatus: 'unavailable',
      title: 'Changed',
      publishTime: 1791410060,
    });
    const callback: ArticlePreparation = Object.assign(jest.fn(base), {
      identity: base.identity,
    });
    const temporary = jest.spyOn(fs, 'mkdtemp');
    expect(await store.save(callback)).toMatchObject({
      status: 'skipped',
      markdownPath: first.markdownPath,
      legacyLayoutRetained: true,
    });
    expect(callback).not.toHaveBeenCalled();
    expect(temporary).not.toHaveBeenCalled();
    expect(images.fetchAllowedImage).not.toHaveBeenCalled();
    expect(await fs.readFile(first.markdownPath, 'utf8')).toBe(
      'User edits and notes',
    );
  });
  it('different roots save normally and simultaneous repeat clicks create only one note', async () => {
    const [first, second] = await Promise.all([
      store.save(prepare()),
      store.save(prepare()),
    ]);
    expect([first.status, second.status].sort()).toEqual(['new', 'skipped']);

    expect(images.fetchAllowedImage).toHaveBeenCalledTimes(2);
    expect(
      (await fs.readdir(first.directory)).filter((name) =>
        name.endsWith('.md'),
      ),
    ).toHaveLength(1);
    expect(
      await store.save(prepare(), new Date(), join(root, 'different')),
    ).toMatchObject({ status: 'new' });
    expect(images.fetchAllowedImage).toHaveBeenCalledTimes(4);
  });
  it('requests only one missing image, restores the exact reference and leaves the other image and edited body unchanged', async () => {
    const first = await store.save(prepare());
    const file = await receiptAt(first.directory);
    const receipt = JSON.parse(await fs.readFile(file, 'utf8'));
    const missing = Object.entries(receipt.imageMap).find(([key]) =>
      key.endsWith('.png'),
    )![1] as string;
    await fs.unlink(join(first.directory, 'image', missing));
    await fs.writeFile(first.markdownPath, 'Edited body');
    jest.mocked(images.fetchAllowedImage).mockClear();
    expect(await store.save(prepare())).toMatchObject({
      status: 'repaired',
      markdownPath: first.markdownPath,
    });
    expect(images.fetchAllowedImage).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(first.markdownPath, 'utf8')).toBe('Edited body');
    expect(await fs.readdir(join(first.directory, 'image'))).toHaveLength(2);
  });
  it('pending receipt can gain only newly available media with an independent companion note', async () => {
    const first = await store.save(
      prepare({
        lastBodyStatus: 'images-pending',
        contentHtml:
          '<div id="js_content" data-wewe-image-pending="1"><p>Body</p><img src="https://mmbiz.qpic.cn/a.png"><img data-wewe-image-unconfirmed="true"></div>',
      }),
    );
    expect(first.status).toBe('failed');
    await fs.writeFile(first.markdownPath, 'My notes');
    jest.mocked(images.fetchAllowedImage).mockClear();
    expect(await store.save(prepare())).toMatchObject({
      status: 'repaired',
      mediaComplete: true,
    });
    expect(images.fetchAllowedImage).toHaveBeenCalledTimes(1);
    expect(jest.mocked(images.fetchAllowedImage).mock.calls[0][0]).toContain(
      '/b.png',
    );
    expect(await fs.readFile(first.markdownPath, 'utf8')).toBe('My notes');
    expect(
      (await fs.readdir(first.directory)).filter((name) =>
        name.startsWith('.wewe-media-'),
      ),
    ).toHaveLength(1);
    expect((await store.save(prepare())).status).toBe('skipped');
  });
  it('failed repair retains receipt and edits, clears locks and can safely resume', async () => {
    const first = await store.save(prepare());
    const file = await receiptAt(first.directory);
    const original = await fs.readFile(file, 'utf8');
    const receipt = JSON.parse(original);
    await fs.unlink(join(first.directory, 'image', receipt.images[0]));
    await fs.writeFile(first.markdownPath, 'Edits');
    jest
      .mocked(images.fetchAllowedImage)
      .mockRejectedValueOnce(new Error('offline'));
    await expect(store.save(prepare())).rejects.toThrow();
    expect(await fs.readFile(file, 'utf8')).toBe(original);
    expect(await fs.readFile(first.markdownPath, 'utf8')).toBe('Edits');
    expect(
      (await fs.readdir(root)).some((name) => name.endsWith('.lock')),
    ).toBe(false);
    expect((await store.save(prepare())).status).toBe('repaired');
  });
  it.each(['corrupt', 'identity', 'missing-body', 'changed-image'])(
    'rejects %s before media requests without creating duplicate notes',
    async (kind) => {
      const first = await store.save(prepare());
      const file = await receiptAt(first.directory);
      const receipt = JSON.parse(await fs.readFile(file, 'utf8'));
      if (kind === 'corrupt') await fs.writeFile(file, '{broken');
      if (kind === 'identity')
        await fs.writeFile(
          file,
          JSON.stringify({ ...receipt, articleId: 'another' }),
        );
      if (kind === 'missing-body') await fs.unlink(first.markdownPath);
      if (kind === 'changed-image')
        await fs.writeFile(
          join(first.directory, 'image', receipt.images[0]),
          'User image',
        );
      jest.mocked(images.fetchAllowedImage).mockClear();
      await expect(store.save(prepare())).rejects.toMatchObject({
        diagnostic: { code: 'SAVE_RECEIPT_INVALID' },
      });
      expect(images.fetchAllowedImage).not.toHaveBeenCalled();
    },
  );
  it('recovers a fully written note whose receipt publication was interrupted, without prepare or media', async () => {
    const first = await store.save(prepare());
    const file = await receiptAt(first.directory);
    await fs.rename(file, file + '.pending');
    jest.mocked(images.fetchAllowedImage).mockClear();
    const base = prepare({ contentHtml: null });
    const callback: ArticlePreparation = Object.assign(jest.fn(base), {
      identity: base.identity,
    });
    expect(await store.save(callback)).toMatchObject({
      status: 'skipped',
      markdownPath: first.markdownPath,
    });
    expect(callback).not.toHaveBeenCalled();
    expect(images.fetchAllowedImage).not.toHaveBeenCalled();
    expect(
      (await fs.readdir(join(first.directory, '.wewe-articles'))).filter(
        (name) => name.endsWith('.pending'),
      ),
    ).toHaveLength(0);
  });
  it('rejects changed remote bytes during missing-image repair and leaves original receipt untouched', async () => {
    const first = await store.save(prepare());
    const file = await receiptAt(first.directory);
    const original = await fs.readFile(file, 'utf8');
    const receipt = JSON.parse(original);
    await fs.unlink(join(first.directory, 'image', receipt.images[0]));
    jest.mocked(images.fetchAllowedImage).mockResolvedValueOnce({
      bytes: Buffer.concat([png, Buffer.from('changed')]),
      type: 'image/png',
    });
    await expect(store.save(prepare())).rejects.toMatchObject({
      diagnostic: { code: 'SAVE_IMAGE_CONFLICT' },
    });
    expect(await fs.readFile(file, 'utf8')).toBe(original);
    expect(await fs.readdir(join(first.directory, 'image'))).toHaveLength(1);
  });
});
