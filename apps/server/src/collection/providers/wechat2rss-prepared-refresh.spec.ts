import { Wechat2RssProvider } from './wechat2rss';

describe('prepared update interface (offline)', () => {
  afterEach(() => jest.restoreAllMocks());
  it('prepares subscribed identities without updates, then sends one GET per closure', async () => {
    const provider = new Wechat2RssProvider(
      'http://127.0.0.1:18080/',
      'fixture-token',
    );
    jest
      .spyOn(provider, 'listSubscriptions')
      .mockResolvedValue([
        { feedId: 'MP_WXS_1234567890', paused: false } as any,
      ]);
    const fetcher = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async (input) => {
        expect(new URL(String(input)).pathname).toBe('/add/1234567890');
        return new Response(
          JSON.stringify({ err: '', data: '/feed/1234567890.xml' }),
        );
      });
    const submit =
      await provider.prepareRefreshSubscription('MP_WXS_1234567890');
    expect(fetcher).not.toHaveBeenCalled();
    expect(await submit()).toEqual({ accepted: true, pending: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('preserves 429 classification without exposing URLs or response contents', async () => {
    const provider = new Wechat2RssProvider(
      'http://127.0.0.1:18080/',
      'fixture-token',
    );
    jest
      .spyOn(provider, 'listSubscriptions')
      .mockResolvedValue([
        { feedId: 'MP_WXS_1234567890', paused: false } as any,
      ]);
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('private fixture body', { status: 429 }));
    const submit =
      await provider.prepareRefreshSubscription('MP_WXS_1234567890');
    await expect(submit()).rejects.toThrow('WECHAT2RSS_RATE_LIMITED');
  });
});
