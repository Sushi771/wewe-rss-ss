import { Wechat2RssProvider, Wechat2RssRestrictionError } from './wechat2rss';
jest.mock('../wechat2rss-source-gate', () => ({
  defaultWechat2RssSourceGate: () => ({
    begin: async () => 'fixture',
    finish: async () => undefined,
  }),
}));

function fixture() {
  return {
    provider: new Wechat2RssProvider('http://127.0.0.1:18080/', 'secret'),
  };
}

describe('private provider restriction classification', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([401, 403, 429] as const)(
    'classifies HTTP %s without leaking URL or response',
    async (status) => {
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(new Response('private-response', { status }));
      const { provider } = fixture();
      const error = await provider.listSubscriptions().catch((e) => e);
      expect(error).toBeInstanceOf(Wechat2RssRestrictionError);
      expect(error).toMatchObject({
        status,
        message: 'WECHAT2RSS_SOURCE_RESTRICTED',
      });
      expect(String(error)).not.toContain('secret');
      expect(String(error)).not.toContain('private-response');
    },
  );

  it('does not swallow restrictions when reading an optional avatar', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('x', { status: 403 }));
    const { provider } = fixture();
    await expect(
      provider.fetchFeedAvatar('MP_WXS_1234567890'),
    ).rejects.toBeInstanceOf(Wechat2RssRestrictionError);
  });

  it('retains a bounded HTTP classification for ordinary failures', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('x', { status: 500 }));
    const { provider } = fixture();
    const error = await provider.listSubscriptions().catch((error) => error);
    expect(error).toMatchObject({
      message: 'WECHAT2RSS_HTTP_STATUS',
      httpStatus: 500,
    });
    expect(String(error)).not.toMatch(/secret|private-response|https?:/);
  });
});
