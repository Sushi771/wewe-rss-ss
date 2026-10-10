import {
  archiveProviderImages,
  supplementSavedBodyImages,
} from './archive-provider-images';
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

  it('supplements exact saved image URLs without replacing saved text or styles', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(png, {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }),
    );
    const archived = (await archiveProviderImages(page())).articles[0];
    const saved =
      '<div class="rich_media_content" style="color:red"><p>saved annotation</p><img alt="original" data-src="https://mmbiz.qpic.cn/a.jpg" src="https://mmbiz.qpic.cn/a.jpg"></div>';
    const supplemented = supplementSavedBodyImages(saved, archived)!;
    expect(supplemented).toContain('saved annotation');
    expect(supplemented).toContain('color:red');
    expect(supplemented).toContain('alt="original"');
    expect(supplemented).toContain('data:image/png;base64,');
    expect(supplemented).not.toContain('data-src');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(supplementSavedBodyImages(supplemented, archived)).toBeUndefined();
  });

  it('rejects an unmatched saved URL and does not use adapter-provided provenance', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(png, {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }),
    );
    const archived = (await archiveProviderImages(page())).articles[0];
    const saved =
      '<div class="rich_media_content"><p>saved</p><img src="https://mmbiz.qpic.cn/different.jpg"></div>';
    expect(() => supplementSavedBodyImages(saved, archived)).toThrow(
      'SAVED_BODY_IMAGE_SOURCE_CONFLICT',
    );
    expect(supplementSavedBodyImages(saved, { ...archived })).toBeUndefined();
  });

  it('supplements legacy js_content-only bodies while preserving annotations', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(png, {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }),
    );
    const archived = (await archiveProviderImages(page())).articles[0];
    const old =
      '<div id="js_content" style="color:red"><p>personal annotation</p><img alt="old" src="https://mmbiz.qpic.cn/a.jpg"></div>';
    const supplied = supplementSavedBodyImages(old, archived)!;
    expect(supplied).toContain('personal annotation');
    expect(supplied).toContain('color:red');
    expect(supplied).toContain('alt="old"');
    expect(supplied).toContain('data:image/png;base64,');
    expect(supplied).not.toContain('src="https:');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(supplementSavedBodyImages(supplied, archived)).toBeUndefined();
  });

  it('leaves existing inline images and text-only bodies byte-for-byte unchanged', async () => {
    const input = page();
    input.articles[0].contentHtml =
      '<div class="rich_media_content"><p>fresh</p></div>';
    const archived = (await archiveProviderImages(input)).articles[0];
    const cached = `<div class="rich_media_content"><img src="data:image/png;base64,${png.toString('base64')}"></div>`;
    expect(supplementSavedBodyImages(cached, archived)).toBeUndefined();
    expect(
      supplementSavedBodyImages(
        '<div class="rich_media_content">saved</div>',
        archived,
      ),
    ).toBeUndefined();
  });

  it('embeds image bytes so the saved body needs no network after restart', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(png, {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }),
    );
    const result = await archiveProviderImages(page());
    expect(result.articles[0].contentHtml).toContain('data:image/png;base64,');
    expect(result.articles[0].contentHtml).not.toContain('src="https:');
    expect(result.bodyMissing).toBe(0);
  });

  it('archives repeated references once and keeps the stable article identity', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(png, {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }),
    );
    const input = page();
    const article = input.articles[0];
    article.contentHtml =
      '<div class="rich_media_content"><p>正文</p><img src="https://mmbiz.qpic.cn/a.jpg"><img src="https://mmbiz.qpic.cn/a.jpg"></div>';
    const result = await archiveProviderImages(input);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.articles).toHaveLength(1);
    expect(result.articles[0]).toMatchObject({
      id: article.id,
      mpId: article.mpId,
      url: article.url,
      publishTime: article.publishTime,
    });
    expect(
      result.articles[0].contentHtml?.match(/data:image\/png;base64,/g),
    ).toHaveLength(2);
    expect(result.articles[0].contentHtml).not.toContain('qpic.cn');
    expect(result.bodyMissing).toBe(0);
    expect(result.imageBlocked).toBe(0);
  });

  it('rejects a successful image response with zero bytes', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(Buffer.alloc(0), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }),
    );
    const result = await archiveProviderImages(page());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.articles[0].contentHtml).toBeNull();
    expect(result.bodyMissing).toBe(1);
    expect(result.imageBlocked).toBe(1);
  });
  it('keeps incomplete remote images out of the cached body for later retry', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));
    const result = await archiveProviderImages(page());
    expect(result.articles[0].contentHtml).toBeNull();
    expect(result.bodyMissing).toBe(1);
    expect(result.imageBlocked).toBe(1);
  });
  it('preserves verified text separately when the opt-in cache image archive fails', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('offline'));
    const result = await archiveProviderImages(page(), {
      preserveTextOnImageFailure: true,
    });
    expect(result.articles[0].contentHtml).toContain('正文');
    expect(result.articles[0].contentHtml).toContain(
      'data-wewe-image-pending="1"',
    );
    expect(result.articles[0].contentHtml).not.toContain(' src="https:');
    expect(result.articles[0].contentHtml).toContain(
      'data-src="https://mmbiz.qpic.cn/a.jpg"',
    );
    expect(result.bodyMissing).toBe(0);
    expect(result.imageBlocked).toBe(1);
    fetchMock.mockResolvedValue(
      new Response(png, { headers: { 'Content-Type': 'image/png' } }),
    );
    const complete = (await archiveProviderImages(page())).articles[0];
    const supplemented = supplementSavedBodyImages(
      result.articles[0].contentHtml!,
      complete,
    )!;
    expect(supplemented).toContain('正文');
    expect(supplemented).toContain('data:image/png;base64,');
    expect(supplemented).not.toContain('data-wewe-image-pending');
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
