import { Wechat2RssProvider } from './wechat2rss';
import { refreshSubmissionFailure } from '../refresh-response-receipt';

describe('prepared update interface (offline)', () => {
  afterEach(() => jest.restoreAllMocks());
  it('prepares subscribed identities without updates, then sends one GET per closure', async () => {
    const provider = new Wechat2RssProvider(
      'http://127.0.0.1:18080/',
      'fixture-token',
    );
    jest.spyOn(provider, 'listSubscriptions').mockResolvedValue([
      {
        feedId: 'MP_WXS_1234567890',
        feedUrl: '/feed/1234567890.xml',
        paused: false,
      } as any,
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
    jest.spyOn(provider, 'listSubscriptions').mockResolvedValue([
      {
        feedId: 'MP_WXS_1234567890',
        feedUrl: '/feed/1234567890.xml',
        paused: false,
      } as any,
    ]);
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('private fixture body', { status: 429 }));
    const submit =
      await provider.prepareRefreshSubscription('MP_WXS_1234567890');
    await expect(submit()).rejects.toThrow('WECHAT2RSS_RATE_LIMITED');
  });
  it.each([
    ['', 'WECHAT2RSS_EMPTY_BODY', 'body'],
    ['private malformed JSON', 'WECHAT2RSS_INVALID_JSON', 'json'],
    [
      JSON.stringify({
        err: 'private rejection body',
        data: '/feed/1234567890.xml',
      }),
      'WECHAT2RSS_UPSTREAM_REJECTED',
      'envelope',
    ],
    [
      JSON.stringify({ err: '', data: '/feed/2234567890.xml' }),
      'WECHAT2RSS_ADD_RESPONSE_INVALID',
      'envelope',
    ],
  ])(
    'HTTP200 with invalid receipt never emits accepted proof (%s)',
    async (body, code, phase) => {
      const provider = new Wechat2RssProvider(
        'http://127.0.0.1:18080/',
        'fixture-token',
      );
      jest.spyOn(provider, 'listSubscriptions').mockResolvedValue([
        {
          feedId: 'MP_WXS_1234567890',
          feedUrl: '/feed/1234567890.xml',
          paused: false,
        } as any,
      ]);
      const fetcher = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response(body, { status: 200 }));
      const accepted = jest.fn();
      const submit = await provider.prepareRefreshSubscription(
        'MP_WXS_1234567890',
        false,
        accepted,
      );
      const error = await submit().then(
        () => null,
        (e) => e,
      );
      expect(refreshSubmissionFailure(error)).toMatchObject({
        code,
        phase,
        httpStatus: 200,
      });
      expect(JSON.stringify(refreshSubmissionFailure(error))).not.toMatch(
        /fixture-token|private rejection|malformed|https?:/,
      );
      expect(accepted).not.toHaveBeenCalled();
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it('writes the validated response proof before the request closure resolves', async () => {
    const provider = new Wechat2RssProvider(
      'http://127.0.0.1:18080/',
      'fixture-token',
    );
    jest.spyOn(provider, 'listSubscriptions').mockResolvedValue([
      {
        feedId: 'MP_WXS_1234567890',
        feedUrl: '/feed/1234567890.xml',
        paused: false,
      } as any,
    ]);
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ err: '', data: '/feed/1234567890.xml' })),
      );
    let committed = false;
    const accepted = jest.fn(async (receipt) => {
      expect(receipt).toMatchObject({ version: 1, httpStatus: 200 });
      expect(receipt.responseDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(receipt)).not.toContain('fixture-token');
      await Promise.resolve();
      committed = true;
    });
    const submit = await provider.prepareRefreshSubscription(
      'MP_WXS_1234567890',
      false,
      accepted,
    );
    await expect(submit()).resolves.toEqual({ accepted: true, pending: true });
    expect(committed).toBe(true);
    expect(accepted).toHaveBeenCalledTimes(1);
  });
  it('matches a validated opaque list address without assuming a numeric output URL', async () => {
    const provider = new Wechat2RssProvider(
      'http://127.0.0.1:18080/',
      'fixture-token',
    );
    jest.spyOn(provider, 'listSubscriptions').mockResolvedValue([
      {
        feedId: 'MP_WXS_1234567890',
        feedUrl: '/feed/opaque-identity.xml',
        paused: false,
      } as any,
    ]);
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          err: '',
          data: 'http://private.invalid/feed/opaque-identity.json?k=private',
        }),
      ),
    );
    const accepted = jest.fn();
    await (
      await provider.prepareRefreshSubscription(
        'MP_WXS_1234567890',
        false,
        accepted,
      )
    )();
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(accepted.mock.calls)).not.toMatch(
      /private.invalid|k=private/,
    );
  });
});
