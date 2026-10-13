import { parseWechat2RssFeedAvatar } from './wechat2rss-feed-avatar';
import { Wechat2RssProvider } from './providers/wechat2rss';

const rss = (image: string) =>
  `<rss><channel><title>Synthetic publisher</title><image><url>${image}</url></image><item><image>https://mmbiz.qpic.cn/article.jpg</image></item></channel></rss>`;

describe('existing Wechat2RSS RSS avatar metadata', () => {
  afterEach(() => jest.restoreAllMocks());
  it('reads only the numeric subscribed RSS cache and keeps the token off the avatar', async () => {
    const fetcher = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        expect(url.origin).toBe('http://127.0.0.1:18080');
        expect(url.pathname).toBe('/feed/1234567890.xml');
        expect(url.searchParams.get('k')).toBe('fixture-secret');
        expect(init?.redirect).toBe('manual');
        return new Response(rss('https://wx.qlogo.cn/mmhead/synthetic/0'));
      });
    const provider = new Wechat2RssProvider(
      'http://127.0.0.1:18080',
      'fixture-secret',
    );
    expect(await provider.fetchFeedAvatar('MP_WXS_1234567890')).toBe(
      'https://wx.qlogo.cn/mmhead/synthetic/0',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not request invalid identities, redirects or failures as an avatar', async () => {
    const fetcher = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('synthetic network failure'));
    const provider = new Wechat2RssProvider(
      'http://127.0.0.1:18080',
      'fixture-secret',
    );
    expect(await provider.fetchFeedAvatar('MP_WXS_bad')).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
    expect(await provider.fetchFeedAvatar('MP_WXS_1234567890')).toBeUndefined();
    fetcher.mockResolvedValue(
      new Response('', {
        status: 302,
        headers: { location: 'https://outside.invalid/' },
      }),
    );
    expect(await provider.fetchFeedAvatar('MP_WXS_1234567890')).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('maps the real channel image and decodes XML without inventing an avatar', () => {
    expect(
      parseWechat2RssFeedAvatar(rss('https://wx.qlogo.cn/mmhead/known/0')),
    ).toBe('https://wx.qlogo.cn/mmhead/known/0');
    expect(
      parseWechat2RssFeedAvatar(
        rss('https://mmbiz.qpic.cn/avatar?a=1&amp;b=2'),
      ),
    ).toBe('https://mmbiz.qpic.cn/avatar?a=1&b=2');
  });
  it('does not substitute article covers or missing/invalid metadata', () => {
    for (const value of [
      undefined,
      {},
      '',
      '<rss><channel><item><image><url>https://wx.qlogo.cn/article/0</url></image></item></channel></rss>',
      'x'.repeat(4_000_001),
    ])
      expect(parseWechat2RssFeedAvatar(value)).toBeUndefined();
  });
  it('rejects credentials, private instance logos, unsafe protocols and foreign hosts', () => {
    for (const value of [
      'http://wx.qlogo.cn/a',
      'https://wx.qlogo.cn:8443/a',
      'https://u:p@wx.qlogo.cn/a',
      'http://127.0.0.1/logo/a?k=secret',
      'https://wx.qlogo.cn/a?k=secret',
      'https://qlogo.cn.attacker.test/a',
      'javascript:alert(1)',
      '/logo/123.png',
    ])
      expect(parseWechat2RssFeedAvatar(rss(value))).toBeUndefined();
  });
});
