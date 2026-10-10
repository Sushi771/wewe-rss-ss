import { promises as fs } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import axios from 'axios';
import { TrpcRouter } from './trpc.router';
import { TrpcService } from './trpc.service';
import { prepareCachedArticleLocalExport } from '../cached-article-local-export';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=';
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
  publishTime: 1800000000,
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
        findUnique: jest.fn(
          async ({ where }) => items.find((a) => a.id === where.id) || null,
        ),
        findMany: jest.fn(async () => items),
      },
      feed: {
        findUnique: jest.fn(async () => ({
          id: 'MP_WXS_1234567890',
          mpName: '合成号',
        })),
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
  it('list single and batch mutation saves each title/ID into 正文.md plus image; repeat and retry preserve edited notes', async () => {
    const caller = router.appRouter.createCaller({ errorMsg: null });
    const one = await caller.article.saveToObsidian(items[0].id);
    expect(basename(one.path)).toBe('正文.md');
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
  it('publisher ZIP staging puts each article in its own 正文.md/image folder and marks missing cached body without page fallback', async () => {
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
    const names = await fs.readdir(join(folder, 'articles'));
    expect(names).toHaveLength(2);
    for (const name of names) {
      const dir = join(folder, 'articles', name);
      expect(await fs.readdir(dir)).toEqual(
        expect.arrayContaining(['正文.md', 'image']),
      );
      expect(await fs.readdir(dir)).not.toContain('attachments');
      expect(await fs.readdir(dir)).not.toContain('index.md');
    }
    const md = await fs.readFile(
      join(folder, 'articles', names[0], '正文.md'),
      'utf8',
    );
    expect(md).toContain('](image/');
    expect(md).not.toContain('attachments/');
    expect(fetch).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
  });
  it('missing or explicitly unavailable cache fails before original page or output requests', async () => {
    expect(() =>
      prepareCachedArticleLocalExport({ ...items[0], contentHtml: '' }),
    ).toThrow('正文尚未缓存');
    const caller = router.appRouter.createCaller({ errorMsg: null });
    items[0].lastBodyStatus = 'unavailable';
    await expect(
      caller.article.saveToObsidian(items[0].id),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(fetch).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
  });
});
