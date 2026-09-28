import { Wechat2RssProvider } from './wechat2rss';

const number = '1234567890';
const feedId = `MP_WXS_${number}`;
const articleUrl = `https://mp.weixin.qq.com/s?__biz=${Buffer.from(number).toString('base64')}&mid=9&idx=1`;
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status });

describe('Wechat2RSS private HTTP client', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reads the exact subscribed feed and verifies the canonical article', async () => {
    const request = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async (input) => {
        const url = new URL(String(input));
        if (url.pathname === '/list')
          return response({
            err: '',
            data: [
              {
                id: Number(number),
                name: '测试号',
                link: `http://127.0.0.1:18080/feed/${number}.xml`,
              },
            ],
            meta: { total: 1 },
          });
        if (url.pathname === `/feed/${number}.json`)
          return response({
            items: [
              {
                id: articleUrl,
                title: '正文测试',
                date_published: '2026-09-28T12:34:56+08:00',
                content_html: '<p>正文</p>',
              },
            ],
          });
        throw new Error('unexpected path');
      });
    const provider = new Wechat2RssProvider(
      'http://127.0.0.1:18080/',
      'fixture-token',
    );
    const page = await provider.fetchArticles(feedId, '测试号');
    expect(page.articles[0].id).toBe('WX_1234567890_9_1');
    expect(request).toHaveBeenCalledTimes(2);
    expect(
      request.mock.calls.every(
        ([url, options]) =>
          new URL(String(url)).searchParams.get('k') === 'fixture-token' &&
          options?.redirect === 'manual',
      ),
    ).toBe(true);
  });

  it('never sends /add for a missing subscription and hides upstream errors', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        response({ err: '', data: [], meta: { total: 0 } }),
      );
    const provider = new Wechat2RssProvider(
      'http://127.0.0.1:18080/',
      'fixture-token',
    );
    await expect(provider.refreshSubscription(feedId)).rejects.toThrow(
      'WECHAT2RSS_SUBSCRIPTION_MISSING',
    );
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        response({ err: 'secret fixture-token', data: [] }),
      );
    await expect(provider.checkAccountStatus()).rejects.toThrow(
      'WECHAT2RSS_UPSTREAM_REJECTED',
    );
  });

  it('rejects public hosts and redirects without exposing secret request URLs', async () => {
    expect(
      () => new Wechat2RssProvider('https://example.com/', 'token'),
    ).toThrow('WECHAT2RSS_PRIVATE_CONFIG_INVALID');
    jest.spyOn(global, 'fetch').mockResolvedValue(response({}, 302));
    const provider = new Wechat2RssProvider(
      'http://127.0.0.1:18080/',
      'fixture-token',
    );
    await expect(provider.checkAccountStatus()).rejects.toThrow(
      'WECHAT2RSS_REQUEST_FAILED',
    );
  });
});
