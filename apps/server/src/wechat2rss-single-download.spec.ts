import axios from 'axios';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Wechat2RssProvider } from './collection/providers/wechat2rss';
import * as registry from './collection/provider-registry';
import * as images from './collection/image-fetch';
import { prepareWechat2RssSingleDownload } from './wechat2rss-single-download';

const number = '1234567890';
const url =
  'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA%3D%3D&mid=2247000001&idx=1&sn=abcdef';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
  'base64',
);
const item = (patch = {}) => ({
  id: url,
  url,
  title: '缓存单篇',
  date_published: '2026-09-28T12:34:56+08:00',
  content_html: '<p>缓存全文</p><img src="https://mmbiz.qpic.cn/fixture.png">',
  ...patch,
});
const response = (raw: unknown, status = 200) =>
  new Response(JSON.stringify(raw), { status });

describe('Wechat2RSS-only single download; synthetic private cache and media', () => {
  let folder: string;
  let listed: unknown;
  let feed: unknown;
  let calls: string[];
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'wewe-single-w2r-'));
    calls = [];
    listed = {
      err: '',
      data: [
        {
          id: number,
          name: '合成号',
          link: `http://127.0.0.1:18080/feed/${number}.xml`,
        },
      ],
      meta: { total: 1 },
    };
    feed = { items: [item()] };
    jest
      .spyOn(axios, 'get')
      .mockRejectedValue(new Error('NO_PLATFORM_REQUESTS'));
    jest
      .spyOn(images, 'fetchAllowedImage')
      .mockResolvedValue({ bytes: png, type: 'image/png' });
    jest
      .spyOn(registry, 'wechat2RssProvider')
      .mockImplementation(
        () =>
          new Wechat2RssProvider('http://127.0.0.1:18080/', 'synthetic-token'),
      );
    jest.spyOn(global, 'fetch').mockImplementation(async (raw, options) => {
      const target = new URL(String(raw));
      expect(target.origin).toBe('http://127.0.0.1:18080');
      expect(options?.redirect).toBe('manual');
      calls.push(target.pathname);
      if (target.pathname === '/list') return response(listed);
      if (target.pathname === `/feed/${number}.json`) return response(feed);
      throw new Error('UNEXPECTED_ENDPOINT');
    });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(folder, { recursive: true, force: true });
  });

  it('reads only subscribed cache and saves actual selected Markdown and image bytes', async () => {
    feed = {
      items: [
        item({
          id: url.replace('2247000001', '2247000002'),
          url: url.replace('2247000001', '2247000002'),
          title: '同名',
          content_html: '<p>其他文章</p>',
        }),
        item(),
      ],
    };
    const prepare = await prepareWechat2RssSingleDownload(
      url + '&pass_ticket=discard',
    );
    expect(await prepare(folder)).toMatchObject({
      articleId: 'WX_1234567890_2247000001_1',
      imageCount: 1,
    });
    const markdown = await readFile(join(folder, 'index.md'), 'utf8');
    expect(markdown).toContain('缓存全文');
    expect(markdown).not.toContain('其他文章');
    const saved = await readdir(join(folder, 'image'));
    expect(saved).toHaveLength(1);
    expect(await readFile(join(folder, 'image', saved[0]))).toEqual(png);
    expect(calls).toEqual(['/list', `/feed/${number}.json`]);
    expect(axios.get).not.toHaveBeenCalled();
    expect(images.fetchAllowedImage).toHaveBeenCalledWith(
      'https://mmbiz.qpic.cn/fixture.png',
    );
  });

  it('requires a verified long-link identity without resolving short links or scanning publishers', async () => {
    await expect(
      prepareWechat2RssSingleDownload(
        'https://mp.weixin.qq.com/s/abcdefghijklmnopqrstuv',
      ),
    ).rejects.toMatchObject({
      diagnostic: { code: 'WECHAT2RSS_SINGLE_LONG_URL_REQUIRED' },
    });
    expect(calls).toEqual([]);
    expect(registry.wechat2RssProvider).not.toHaveBeenCalled();
    expect(images.fetchAllowedImage).not.toHaveBeenCalled();
  });

  it('never adds a missing subscription or falls back to original-page requests', async () => {
    listed = { err: '', data: [], meta: { total: 0 } };
    await expect(prepareWechat2RssSingleDownload(url)).rejects.toMatchObject({
      diagnostic: { code: 'WECHAT2RSS_SINGLE_NOT_SUBSCRIBED' },
    });
    expect(calls).toEqual(['/list']);
    expect(axios.get).not.toHaveBeenCalled();
    expect(images.fetchAllowedImage).not.toHaveBeenCalled();
  });

  it.each([
    ['missing article', { items: [] }, 'WECHAT2RSS_SINGLE_CACHE_MISS'],
    [
      'missing body',
      { items: [item({ content_html: '' })] },
      'WECHAT2RSS_SINGLE_BODY_MISSING',
    ],
    [
      'duplicate identity',
      { items: [item(), item()] },
      'WECHAT2RSS_SINGLE_CACHE_READ_FAILED',
    ],
    [
      'conflicting original',
      {
        items: [
          item({ external_url: url.replace('2247000001', '2247000002') }),
        ],
      },
      'WECHAT2RSS_SINGLE_CACHE_READ_FAILED',
    ],
    [
      'different signature',
      {
        items: [
          item({
            id: url.replace('abcdef', 'fedcba'),
            url: url.replace('abcdef', 'fedcba'),
          }),
        ],
      },
      'WECHAT2RSS_SINGLE_IDENTITY_MISMATCH',
    ],
    [
      'blocked image',
      {
        items: [
          item({
            content_html:
              '<p>正文</p><img src="https://example.invalid/a.png">',
          }),
        ],
      },
      'WECHAT2RSS_SINGLE_IMAGES_UNAVAILABLE',
    ],
    [
      'embedded video',
      {
        items: [
          item({
            content_html:
              '<p>正文</p><iframe class="video_iframe" src="https://video.qq.com/player"></iframe>',
          }),
        ],
      },
      'ARTICLE_MEDIA_UNAVAILABLE',
    ],
    [
      'article page disguised as an image',
      { items: [item({ content_html: `<p>正文</p><img src="${url}">` })] },
      'WECHAT2RSS_SINGLE_IMAGES_UNAVAILABLE',
    ],
  ])(
    'reports %s before saving or fetching any media',
    async (_name, raw, code) => {
      feed = raw;
      await expect(prepareWechat2RssSingleDownload(url)).rejects.toMatchObject({
        diagnostic: { code },
      });
      expect(images.fetchAllowedImage).not.toHaveBeenCalled();
      expect(axios.get).not.toHaveBeenCalled();
      expect(await readdir(folder)).toEqual([]);
      expect(calls).toEqual(['/list', `/feed/${number}.json`]);
    },
  );

  it('stops on failed cache reads without leaking raw errors or trying another channel', async () => {
    jest
      .mocked(global.fetch)
      .mockRejectedValue(new Error('private-url?secret=synthetic-token'));
    const error = await prepareWechat2RssSingleDownload(url).catch(
      (error) => error,
    );
    expect(error.diagnostic.code).toBe('WECHAT2RSS_SINGLE_CACHE_READ_FAILED');
    expect(error.message).not.toMatch(/secret|synthetic-token|private-url/);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('reports disabled/config-invalid sources before a request', async () => {
    jest.mocked(registry.wechat2RssProvider).mockImplementation(() => {
      throw new Error('WECHAT2RSS_DISABLED');
    });
    await expect(prepareWechat2RssSingleDownload(url)).rejects.toMatchObject({
      diagnostic: { code: 'WECHAT2RSS_SINGLE_UNCONFIGURED' },
    });
    expect(calls).toEqual([]);
  });

  it('reports media failure separately from the Wechat2RSS article source and publishes nothing', async () => {
    jest
      .mocked(images.fetchAllowedImage)
      .mockRejectedValue(new Error('unsafe upstream detail'));
    await expect(prepareWechat2RssSingleDownload(url)).rejects.toMatchObject({
      diagnostic: { code: 'WECHAT2RSS_SINGLE_IMAGES_UNAVAILABLE' },
    });
    expect(await readdir(folder)).toEqual([]);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('does not invent absent engagement metrics from arbitrary feed fields', async () => {
    feed = { items: [item({ readCount: 999, likeCount: 888, favorite: 777 })] };
    const selected = await registry
      .wechat2RssProvider()
      .fetchSingleCachedArticle(url);
    expect(selected).not.toHaveProperty('readCount');
    expect(selected).not.toHaveProperty('likeCount');
    expect(selected).not.toHaveProperty('metrics');
  });
});
