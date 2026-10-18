import { Wechat2RssProvider } from './wechat2rss';

describe('upstream paused and final automatic submission gate (offline)', () => {
  afterEach(() => jest.restoreAllMocks());
  it('retains the upstream paused field and rejects updates without any /add call', async () => {
    const provider = new Wechat2RssProvider(
      'http://127.0.0.1:18080/',
      'synthetic-token',
    );
    const get = jest.spyOn(provider as any, 'get').mockResolvedValue({
      err: '',
      data: [
        {
          id: '1234567890',
          name: 'synthetic',
          link: 'http://127.0.0.1:18080/feed/1234567890.json',
          paused: true,
        },
      ],
      meta: { total: 1 },
    });
    expect(await provider.listSubscriptions()).toEqual([
      {
        feedId: 'MP_WXS_1234567890',
        name: 'synthetic',
        feedUrl: '/feed/1234567890.json',
        paused: true,
        checkTime: null,
        nextUpdateTime: null,
      },
    ]);
    get.mockClear();
    await expect(
      provider.refreshSubscription('MP_WXS_1234567890'),
    ).rejects.toThrow('WECHAT2RSS_SUBSCRIPTION_PAUSED');
    expect(get.mock.calls).toEqual([
      ['/list', { page: '1', size: '50' }, undefined],
    ]);
  });
  it('a list lookup crossing midnight cannot send an automatic /add afterwards', async () => {
    const provider = new Wechat2RssProvider(
      'http://127.0.0.1:18080/',
      'synthetic-token',
    );
    jest.spyOn(provider, 'listSubscriptions').mockResolvedValue([
      {
        feedId: 'MP_WXS_1234567890',
        name: 'synthetic',
        feedUrl: '/feed/1234567890.json',
        checkTime: null,
        nextUpdateTime: null,
        paused: null,
      },
    ]);
    jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse('2026-10-13T00:00:00+08:00'));
    const get = jest
      .spyOn(provider as any, 'get')
      .mockRejectedValue(Error('NETWORK_FORBIDDEN'));
    await expect(
      provider.refreshSubscription('MP_WXS_1234567890', true),
    ).rejects.toThrow('WECHAT2RSS_AUTOMATIC_WINDOW_CLOSED');
    expect(get).not.toHaveBeenCalled();
  });
});
