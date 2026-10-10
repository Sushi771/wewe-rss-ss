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

describe('foreground accepted-identity checks (synthetic time and HTTP only)', () => {
  const listed = (name = '测试号') => ({
    err: '',
    data: [
      {
        id: Number(number),
        name,
        link: 'http://127.0.0.1:18080/feed/' + number + '.xml',
      },
    ],
    meta: { total: 1 },
  });
  const readyAccount = {
    err: '',
    data: [{ available: true, needCheck: false }],
  };
  const provider = () =>
    new Wechat2RssProvider('http://127.0.0.1:18080/', 'fixture-token');
  beforeEach(() => jest.useFakeTimers({ now: 1000000 }));
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('resolves a delayed blank-name record in one add without replay or further polling', async () => {
    const paths: string[] = [];
    let reads = 0;
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path === '/addurl')
        return response({
          err: '',
          data: 'http://127.0.0.1:18080/feed/' + number + '.xml',
        });
      if (path === '/login/list') return response(readyAccount);
      if (path === '/list') {
        reads++;
        return response(
          reads === 1
            ? { err: '', data: [], meta: { total: 0 } }
            : listed(reads === 2 ? ' ' : '测试号'),
        );
      }
      throw Error('unexpected endpoint');
    });
    const client = provider();
    const path = await client.acceptSubscription(articleUrl);
    const result = client.waitForAcceptedSubscription(path);
    await jest.advanceTimersByTimeAsync(30000);
    await expect(result).resolves.toEqual({
      feedId,
      name: '测试号',
      accepted: true,
    });
    expect(paths.filter((p) => p === '/addurl')).toHaveLength(1);
    expect(paths.filter((p) => p === '/list')).toHaveLength(3);
    expect(paths.filter((p) => p === '/login/list')).toHaveLength(2);
    expect(paths.some((p) => p.startsWith('/add/'))).toBe(false);
    await jest.advanceTimersByTimeAsync(60000);
    expect(paths).toHaveLength(6);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('returns immediately when metadata is ready without account rechecks or a timer', async () => {
    const fetcher = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(response(listed()));
    await expect(
      provider().waitForAcceptedSubscription('/feed/' + number + '.xml'),
    ).resolves.toMatchObject({ feedId });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('ends after three empty checks with no detached continuation', async () => {
    const fetcher = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async (input) =>
        response(
          new URL(String(input)).pathname === '/login/list'
            ? readyAccount
            : { err: '', data: [], meta: { total: 0 } },
        ),
      );
    const result = provider().waitForAcceptedSubscription(
      '/feed/' + number + '.xml',
    );
    await jest.advanceTimersByTimeAsync(30000);
    await expect(result).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(5);
    await jest.advanceTimersByTimeAsync(60000);
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('stops on a challenged account before another list read', async () => {
    const fetcher = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async (input) =>
        response(
          new URL(String(input)).pathname === '/login/list'
            ? { err: '', data: [{ available: true, needCheck: true }] }
            : { err: '', data: [], meta: { total: 0 } },
        ),
      );
    const checked = expect(
      provider().waitForAcceptedSubscription('/feed/' + number + '.xml'),
    ).rejects.toThrow('WECHAT2RSS_ACCOUNT_CHALLENGED');
    await jest.advanceTimersByTimeAsync(3000);
    await checked;
    await jest.advanceTimersByTimeAsync(60000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('stops on the first failed response without a delayed retry', async () => {
    const fetcher = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(response({}, 500));
    await expect(
      provider().waitForAcceptedSubscription('/feed/' + number + '.xml'),
    ).rejects.toThrow('WECHAT2RSS_REQUEST_FAILED');
    await jest.advanceTimersByTimeAsync(60000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('preserves a pending result at the overall deadline rather than accepting a late response', async () => {
    const fetcher = jest.spyOn(global, 'fetch').mockImplementation(async () => {
      jest.setSystemTime(Date.now() + 35000);
      return response(listed());
    });
    await expect(
      provider().waitForAcceptedSubscription('/feed/' + number + '.xml'),
    ).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps an accepted identity pending when its readonly HTTP times out', async () => {
    const expired = AbortSignal.abort(
      new DOMException('synthetic timeout', 'TimeoutError'),
    );
    jest.spyOn(AbortSignal, 'timeout').mockReturnValue(expired);
    const fetcher = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(expired.reason);
    await expect(
      provider().waitForAcceptedSubscription('/feed/' + number + '.xml'),
    ).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('bounds all pagination across checks to six list HTTP requests', async () => {
    let page = 0;
    const fetcher = jest.spyOn(global, 'fetch').mockImplementation(async () => {
      const start = 40000000 + page++ * 50;
      return response({
        err: '',
        data: Array.from({ length: 50 }, (_, i) => ({
          id: start + i,
          name: '合成号',
          link: 'http://127.0.0.1:18080/feed/' + (start + i) + '.xml',
        })),
        meta: { total: 350 },
      });
    });
    await expect(
      provider().waitForAcceptedSubscription('/feed/' + number + '.xml'),
    ).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(jest.getTimerCount()).toBe(0);
  });
});
