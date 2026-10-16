import { promises as fs } from 'node:fs';
import { join, dirname, basename, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import axios from 'axios';
import { TrpcRouter } from './trpc.router';
import { TrpcService } from './trpc.service';
import { prepareCachedArticleLocalExport } from '../cached-article-local-export';
import { exportSourceFolders } from '../article-export-source';
import * as imageFetch from '../collection/image-fetch';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=';
const feed = {
  id: 'MP_WXS_1234567890',
  mpName: '合成号',
  group: { id: 'group-a', name: '合成组' },
};
const article = (id = 'WX_1234567890_2247000001_1') => ({
  id,
  title: '同名文章',
  sourceUrl:
    'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA%3D%3D&mid=' +
    id.split('_')[2] +
    '&idx=1&sn=abcdef',
  contentHtml:
    '<div id="js_content"><p>本地缓存正文</p><img src="data:image/png;base64,' +
    png +
    '"></div>',
  lastBodyStatus: 'available',
  metrics: JSON.stringify({
    read: { value: 17, display: '17', fileTime: 'synthetic-fixture' },
  }),
  publishTime: 1791210060,
});
describe('all cached article local/ZIP export entry points share isolated image directories; offline fixtures', () => {
  let root: string, router: TrpcRouter, items: ReturnType<typeof article>[];
  const oldEnv = { ...process.env };
  beforeEach(async () => {
    delete process.env.PRIVATE_ONLINE_MODE;
    root = await fs.mkdtemp(join(tmpdir(), 'wewe-layout-router-'));
    items = [article(), article('WX_1234567890_2247000002_1')];
    jest.spyOn(axios, 'get').mockRejectedValue(new Error('NO_NETWORK'));
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('NO_NETWORK'));
    const config = {
      get: (key: string) =>
        key === 'feed'
          ? { obsidianPath: join(root, 'vault'), updateDelayTime: 0 }
          : key === 'platform'
            ? { url: '' }
            : {},
    };
    const prisma = {
      article: {
        findUnique: jest.fn(async ({ where }) => {
          const found = items.find((a) => a.id === where.id);
          return found ? { ...found, feed } : null;
        }),
        findMany: jest.fn(async () => items),
      },
      feed: {
        findUnique: jest.fn(async () => feed),
      },
    };
    const service = new TrpcService(
      {} as any,
      config as any,
      {} as any,
      {} as any,
    );
    router = new TrpcRouter(
      service,
      prisma as any,
      config as any,
      {} as any,
      {} as any,
    );
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    process.env = { ...oldEnv };
    await fs.rm(root, { recursive: true, force: true });
  });
  it('list single and batch mutation saves original-day/group/publisher/title.md plus image; repeat and retry preserve edited notes', async () => {
    const caller = router.appRouter.createCaller({ errorMsg: null });
    const one = await caller.article.saveToObsidian(items[0].id);
    expect(basename(one.path)).toBe('同名文章.md');
    expect(await fs.readFile(one.path, 'utf8')).toContain('| 阅读 | 17 |');
    const images = await fs.readdir(join(dirname(one.path), 'image'));
    expect(images).toHaveLength(1);
    expect(
      await fs.readFile(join(dirname(one.path), 'image', images[0])),
    ).toEqual(Buffer.from(png, 'base64'));
    await fs.writeFile(one.path, '用户编辑不能覆盖');
    expect(await caller.article.saveToObsidian(items[0].id)).toMatchObject({
      path: one.path,
      alreadySaved: true,
    });
    expect(await fs.readFile(one.path, 'utf8')).toBe('用户编辑不能覆盖');
    const two = await caller.article.saveToObsidian(items[1].id);
    expect(two.path).not.toBe(one.path);
    const day = dirname(dirname(one.path));
    expect(
      (await fs.readdir(day)).every(
        (n) => n !== 'attachments' && !n.endsWith('.md'),
      ),
    ).toBe(true);
    expect(axios.get).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('publisher ZIP staging shares original-day/group/publisher/image beside title.md and marks missing cached body without page fallback', async () => {
    items[1].contentHtml = '';
    items[1].lastBodyStatus = 'unavailable';
    const folder = join(root, 'zip-stage');
    const result = await router.buildOfflineFeedDirectory(
      'MP_WXS_1234567890',
      folder,
    );
    expect(result).toMatchObject({
      articles: 2,
      complete: 1,
      incomplete: expect.any(Array),
    });
    const dir = join(
      folder,
      ...exportSourceFolders(
        {
          feedId: feed.id,
          feedName: feed.mpName,
          groupId: feed.group.id,
          groupName: feed.group.name,
        },
        items[0].publishTime,
      ),
    );
    const names = (await fs.readdir(dir)).filter((n) => n.endsWith('.md'));
    expect(names).toHaveLength(2);
    expect(await fs.readdir(dir)).toContain('image');
    expect(await fs.readdir(dir)).not.toContain('attachments');
    expect(await fs.readdir(dir)).not.toContain('index.md');
    const md = await fs.readFile(join(dir, '同名文章.md'), 'utf8');
    expect(md).toContain('](image/');
    expect(md).not.toContain('attachments/');
    expect(fetch).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
  });
  it('missing cache fails before original page or output requests', async () => {
    const prepare = prepareCachedArticleLocalExport({
      ...items[0],
      contentHtml: '',
    });
    await expect(prepare(join(root, 'unused'))).rejects.toThrow('正文尚未缓存');
    const caller = router.appRouter.createCaller({ errorMsg: null });
    items[0].lastBodyStatus = 'unavailable';
    items[0].contentHtml = '';
    await expect(
      caller.article.saveToObsidian(items[0].id),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(fetch).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
  });
  it('single list save and batch ZIP accept complete cache despite historical unavailable, preserve notes and do not request originals', async () => {
    items.forEach((item) => {
      item.lastBodyStatus = 'unavailable';
    });
    const caller = router.appRouter.createCaller({ errorMsg: null });
    const before = JSON.stringify(items);
    const one = await caller.article.saveToObsidian(items[0].id);
    expect(one).toMatchObject({ success: true, status: 'new' });
    await fs.writeFile(one.path, 'User handwritten notes');
    expect(await caller.article.saveToObsidian(items[0].id)).toMatchObject({
      success: true,
      alreadySaved: true,
    });
    expect(await fs.readFile(one.path, 'utf8')).toBe('User handwritten notes');
    expect(
      await router.buildOfflineFeedDirectory(
        feed.id,
        join(root, 'history-zip'),
      ),
    ).toMatchObject({ articles: 2, complete: 2, incomplete: [] });
    expect(JSON.stringify(items)).toBe(before);
    expect(fetch).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
  });
  it('single and batch entry points retain usable body and reject corrupt image bytes as unconfirmed media', async () => {
    const caller = router.appRouter.createCaller({ errorMsg: null });
    items[0].lastBodyStatus = 'images-pending';
    items[0].contentHtml =
      '<div id="js_content"><p>Body</p><span data-wewe-image-pending="1">Missing</span></div>';
    const partial = await caller.article.saveToObsidian(items[0].id);
    expect(partial).toMatchObject({ success: false, mediaComplete: false });
    items[1].lastBodyStatus = 'unavailable';
    items[1].contentHtml =
      '<div id="js_content"><p>Body</p><img src="data:image/png;base64,YQ=="></div>';
    expect(await caller.article.saveToObsidian(items[1].id)).toMatchObject({
      success: false,
      mediaStatus: 'unconfirmed',
      missingImageCount: 0,
    });
    const batch = await router.buildOfflineFeedDirectory(
      feed.id,
      join(root, 'bad-media-zip'),
    );
    if (!batch) throw new Error('Expected publisher batch');
    expect(batch.complete).toBe(0);
    expect(batch.incomplete).toHaveLength(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
  });
  it('reports cache absence, unknown media and actual failed sources separately in ZIP and browser output', async () => {
    items[0].contentHtml = '';
    items[1].contentHtml =
      '<div id="js_content"><p>Unknown body</p><img src="javascript:invalid"></div>';
    items.push({
      ...article('WX_1234567890_2247000003_1'),
      contentHtml:
        '<div id="js_content"><p>Known body</p><img src="https://mmbiz.qpic.cn/a.png"><img src="https://mmbiz.qpic.cn/a.png"></div>',
    });
    items.push({
      ...article('WX_1234567890_2247000004_1'),
      lastBodyStatus: 'unavailable',
      contentHtml:
        '<img><div id="js_content"><p>Cached body despite historical retry</p></div>',
    });
    const image = jest
      .spyOn(imageFetch, 'fetchAllowedImage')
      .mockRejectedValue(new Error('OFFLINE'));
    const folder = join(root, 'status-zip');
    const batch = await router.buildOfflineFeedDirectory(feed.id, folder);
    expect(batch).toMatchObject({ complete: 1, articles: 4 });
    expect(batch?.incompleteDetails.map((item) => item.reason)).toEqual([
      'body-not-cached',
      'unconfirmed',
      'missing',
    ]);
    expect(batch?.incompleteDetails[2].missingImageCount).toBe(1);
    expect(
      await fs.readFile(join(folder, batch!.incompleteDetails[2].path), 'utf8'),
    ).toContain('Known body');
    const summary = await fs.readFile(join(folder, 'README.md'), 'utf8');
    expect(summary).toContain('正文未缓存');
    expect(summary).toContain('媒体完整性未确认');
    expect(summary).toContain('已知正文图片未取得 (1)');
    const browser = await router.appRouter
      .createCaller({ errorMsg: null })
      .article.exportMarkdown(items[1].id);
    expect(browser).toMatchObject({
      mediaComplete: false,
      mediaStatus: 'unconfirmed',
      missingImageCount: 0,
    });
    expect(image).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
  });
  it('does not return success for an unmapped legacy zero-image receipt after a remote image is cached', async () => {
    items[0].contentHtml = '<div id="js_content"><p>Original text</p></div>';
    const caller = router.appRouter.createCaller({ errorMsg: null });
    const first = await caller.article.saveToObsidian(items[0].id);
    const receipts = join(dirname(first.path), '.wewe-articles');
    const file = join(
      receipts,
      (await fs.readdir(receipts)).find((name) => name.endsWith('.json'))!,
    );
    const legacy = JSON.parse(await fs.readFile(file, 'utf8'));
    delete legacy.imageMap;
    const bytes = JSON.stringify(legacy);
    await fs.writeFile(file, bytes);
    await fs.writeFile(first.path, 'User notes');
    items[0].contentHtml =
      '<div id="js_content"><p>Updated text</p><img src="https://mmbiz.qpic.cn/new.png"></div>';
    const image = jest.spyOn(imageFetch, 'fetchAllowedImage');
    expect(await caller.article.saveToObsidian(items[0].id)).toMatchObject({
      success: false,
      status: 'failed',
      mediaComplete: false,
      mediaStatus: 'unconfirmed',
      path: first.path,
    });
    expect(image).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
    expect(await fs.readFile(first.path, 'utf8')).toBe('User notes');
    expect(await fs.readFile(file, 'utf8')).toBe(bytes);
  });
  it('splits a publisher ZIP by each original date and retains unknown-date body and reason', async () => {
    items[1].publishTime = 1791432900;
    items.push({ ...article('WX_1234567890_2247000003_1'), publishTime: 0 });
    const directory = join(root, 'zip-multiday');
    const result = await router.buildOfflineFeedDirectory(feed.id, directory);
    expect(result).toMatchObject({ articles: 3, complete: 3 });
    for (const day of ['2026-10-05', '2026-10-08', '日期待核']) {
      const note = join(directory, `${day}_合成组`, '合成号', '同名文章.md');
      const markdown = await fs.readFile(note, 'utf8');
      expect(markdown).toContain('本地缓存正文');
      expect(markdown).toContain('](image/');
      expect(await fs.readdir(join(dirname(note), 'image'))).toHaveLength(1);
      if (day === '日期待核')
        expect(markdown).toContain('缺少可信原文发布日期');
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
  });
  it.each(['available', 'unavailable'])(
    'single and batch exports report source-less images as incomplete despite %s history',
    async (status) => {
      items[0].lastBodyStatus = status;
      items[0].contentHtml = '<div id="js_content"><p>正文</p><img></div>';
      const caller = router.appRouter.createCaller({ errorMsg: null });
      const one = await caller.article.saveToObsidian(items[0].id);
      expect(one).toMatchObject({ success: false, mediaComplete: false });
      expect(await fs.readFile(one.path, 'utf8')).toContain('媒体完整性未确认');
      const receipts = join(dirname(one.path), '.wewe-articles');
      const receiptPath = join(
        receipts,
        (await fs.readdir(receipts)).find((name) => name.endsWith('.json'))!,
      );
      const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
      delete receipt.imageMap;
      await fs.writeFile(
        receiptPath,
        JSON.stringify({ ...receipt, mediaComplete: true }),
      );
      const legacyReceipt = await fs.readFile(receiptPath, 'utf8');
      await fs.writeFile(one.path, 'User handwritten notes');
      expect(await caller.article.saveToObsidian(items[0].id)).toMatchObject({
        success: false,
        mediaComplete: false,
        alreadySaved: true,
        status: 'skipped',
        path: one.path,
      });
      expect(await fs.readFile(one.path, 'utf8')).toBe(
        'User handwritten notes',
      );
      expect(await fs.readFile(receiptPath, 'utf8')).toBe(legacyReceipt);
      const zip = join(root, 'no-source-zip');
      const batch = await router.buildOfflineFeedDirectory(feed.id, zip);
      expect(batch).toMatchObject({ complete: 1 });
      expect(batch?.incomplete).toHaveLength(1);
      if (!batch) throw new Error('Expected publisher batch');
      const relative = batch.incomplete[0];
      expect(basename(relative)).toBe(`${items[0].title}.md`);
      expect(isAbsolute(relative)).toBe(false);
      expect(await fs.readFile(join(zip, relative), 'utf8')).toContain(
        '媒体完整性未确认',
      );
      expect(fetch).not.toHaveBeenCalled();
      expect(axios.get).not.toHaveBeenCalled();
    },
  );
});
