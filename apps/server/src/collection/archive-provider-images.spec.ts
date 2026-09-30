import { archiveProviderImages } from './archive-provider-images';
import { ProviderPage } from './subscription-provider';

const page = (): ProviderPage => ({
  articles: [
    {
      id: 'WX_123_1_1',
      mpId: 'MP_WXS_123',
      url: 'https://mp.weixin.qq.com/s/example',
      title: '文章',
      publishTime: 1000000000,
      picUrl: '',
      contentHtml:
        '<div class="rich_media_content"><p>正文</p><img src="https://mmbiz.qpic.cn/a.jpg"></div>',
    },
  ],
  coverage: 'recent-window',
  upstreamCount: 1,
  bodyMissing: 0,
  imageBlocked: 0,
});

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
  'base64',
);

describe('provider image archive', () => {
  afterEach(() => jest.restoreAllMocks());

  it('embeds image bytes so the saved body needs no network after restart', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(png, {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }),
    );
    const result = await archiveProviderImages(page());
    expect(result.articles[0].contentHtml).toContain('data:image/png;base64,');
    expect(result.articles[0].contentHtml).not.toContain('qpic.cn');
    expect(result.bodyMissing).toBe(0);
  });

  it('keeps incomplete remote images out of the cached body for later retry', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));
    const result = await archiveProviderImages(page());
    expect(result.articles[0].contentHtml).toBeNull();
    expect(result.bodyMissing).toBe(1);
    expect(result.imageBlocked).toBe(1);
  });

  it('keeps valid cached bytes and drops stale remote lazy-load URLs', async () => {
    const input = page();
    input.articles[0].contentHtml = `<div class="rich_media_content"><p>正文</p><img data-src="https://mmbiz.qpic.cn/stale" src="data:image/png;base64,${png.toString('base64')}"></div>`;
    const fetchMock = jest.spyOn(global, 'fetch');
    const result = await archiveProviderImages(input);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.articles[0].contentHtml).toContain('data:image/png;base64,');
    expect(result.articles[0].contentHtml).not.toContain('data-src');
    expect(result.bodyMissing).toBe(0);
  });

  it('does not cache a partial image as an offline body', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(png, {
        status: 206,
        headers: { 'Content-Type': 'image/png' },
      }),
    );
    const result = await archiveProviderImages(page());
    expect(result.articles[0].contentHtml).toBeNull();
    expect(result.bodyMissing).toBe(1);
    expect(result.imageBlocked).toBe(1);
  });
  it('stops strict album image traffic immediately on a redirect or rate limit', async () => {
    for (const status of [302, 429]) {
      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response('', { status }));
      const input = page();
      input.articles[0].contentHtml =
        '<div class="rich_media_content"><img src="https://mmbiz.qpic.cn/a.jpg"><img src="https://mmbiz.qpic.cn/b.jpg"></div>';
      await expect(
        archiveProviderImages(input, { stopOnFailure: true }),
      ).rejects.toThrow('已停止后续请求');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      fetchMock.mockRestore();
    }
  });
});
