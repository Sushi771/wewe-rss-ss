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

describe('provider image archive', () => {
  afterEach(() => jest.restoreAllMocks());

  it('embeds image bytes so the saved body needs no network after restart', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(Buffer.from([137, 80, 78, 71]), {
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
});
