import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { Wechat2RssProvider } from '../collection/providers/wechat2rss';

const script = fs.readFileSync(
  path.resolve(__dirname, '../../../../scripts/acceptance-wechat2rss.cjs'),
  'utf8',
);
const env = {
  WECHAT2RSS_BASE_URL: 'http://127.0.0.1:18080/',
  WECHAT2RSS_TOKEN: 'synthetic-private-token',
  WECHAT2RSS_ENABLED: '0',
};
async function preflight(
  overrides: Record<string, string> = {},
  args: string[] = [],
  buildMissing = false,
  readFetch: typeof fetch = global.fetch,
) {
  const logs: string[] = [];
  const errors: string[] = [];
  const processState = {
    env: { ...env, ...overrides },
    argv: ['node', 'synthetic-preflight', ...args],
    exitCode: undefined as number | undefined,
  };
  await vm.runInNewContext(
    script,
    {
      __dirname: path.resolve(__dirname, '../../../../scripts'),
      process: processState,
      console: {
        log: (value: string) => logs.push(value),
        error: (value: string) => errors.push(value),
      },
      URL,
      Error,
      Buffer,
      AbortSignal,
      fetch: readFetch,
      require: (name: string) => {
        if (name === 'node:fs') return { existsSync: () => false };
        if (name.endsWith('wechat2rss.js')) {
          if (buildMissing) throw new Error('synthetic-build-missing');
          return { Wechat2RssProvider };
        }
        return require(name);
      },
    },
    { timeout: 1000 },
  );
  return { logs: logs.map((value) => JSON.parse(value)), errors, processState };
}

describe('actual Wechat2RSS preflight CLI (synthetic offline)', () => {
  let network: jest.SpyInstance;
  beforeEach(() => {
    network = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
  });
  afterEach(() => {
    try {
      expect(network).not.toHaveBeenCalled();
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('checks private config format without HTTP, target or enabling collection', async () => {
    const result = await preflight();
    expect(result.logs[0]).toMatchObject({
      mode: 'preflight-only',
      appEnabled: false,
      configured: { baseUrl: true, token: true, target: false },
      configCheck: { valid: true, code: 'PRIVATE_CONFIG_VALID' },
    });
    expect(JSON.stringify(result.logs)).not.toMatch(
      /127\.0\.0\.1|synthetic-private-token/,
    );
    expect(result.processState.env.WECHAT2RSS_ENABLED).toBe('0');
  });

  it.each<Record<string, string>>([
    { WECHAT2RSS_BASE_URL: 'https://example.com/' },
    { WECHAT2RSS_BASE_URL: 'http://user:synthetic-secret@127.0.0.1/' },
    { WECHAT2RSS_BASE_URL: 'not-a-url' },
    { WECHAT2RSS_TOKEN: 'x'.repeat(513) },
  ])(
    'reports invalid format without printing private input %j',
    async (bad) => {
      const result = await preflight(bad);
      expect(result.logs[0].configCheck).toEqual({
        valid: false,
        code: 'WECHAT2RSS_PRIVATE_CONFIG_INVALID',
      });
      expect(JSON.stringify([...result.logs, ...result.errors])).not.toContain(
        'synthetic-secret',
      );
      expect(JSON.stringify(result.logs)).not.toContain('example.com');
      expect(JSON.stringify(result.logs)).not.toContain(
        'synthetic-private-token',
      );
    },
  );

  it('distinguishes missing configuration and missing build from a valid instance', async () => {
    const incomplete = await preflight({ WECHAT2RSS_TOKEN: '' });
    expect(incomplete.logs[0].configCheck).toEqual({
      valid: false,
      code: 'PRIVATE_INSTANCE_CONFIG_INCOMPLETE',
    });
    const missing = await preflight({}, [], true);
    expect(missing.logs[0].configCheck).toEqual({
      valid: false,
      code: 'SERVER_BUILD_REQUIRED',
    });
  });

  it.each([false, true])(
    'stops after unavailable account status (challenged=%s) without reading more endpoints',
    async (challenged) => {
      const account = jest
        .spyOn(Wechat2RssProvider.prototype, 'checkAccountStatus')
        .mockResolvedValue({
          available: false,
          challenged,
          retryAfter: undefined,
        });
      const list = jest
        .spyOn(Wechat2RssProvider.prototype, 'listSubscriptions')
        .mockResolvedValue([]);
      const articles = jest.spyOn(
        Wechat2RssProvider.prototype,
        'fetchArticles',
      );
      const result = await preflight({}, ['--execute', 'MP_WXS_1234567890']);
      expect(result.errors).toEqual([
        challenged ? 'ACCOUNT_CHALLENGED' : 'ACCOUNT_UNAVAILABLE',
      ]);
      expect(result.processState.exitCode).toBe(1);
      expect(account).toHaveBeenCalledTimes(1);
      expect(list).not.toHaveBeenCalled();
      expect(articles).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['WECHAT2RSS_UPSTREAM_REJECTED', 'WECHAT2RSS_UPSTREAM_REJECTED'],
    ['WECHAT2RSS_REQUEST_FAILED', 'WECHAT2RSS_REQUEST_FAILED'],
    ['SYNTHETIC_PRIVATE_SECRET', 'PRIVATE_INSTANCE_PREFLIGHT_FAILED'],
  ])('preserves only known safe error codes: %s', async (message, code) => {
    jest
      .spyOn(Wechat2RssProvider.prototype, 'checkAccountStatus')
      .mockRejectedValue(new Error(message));
    const result = await preflight({}, ['--execute', 'MP_WXS_1234567890']);
    expect(result.errors).toEqual([code]);
    expect(result.processState.exitCode).toBe(1);
  });

  it.each(['WECHAT2RSS_UPSTREAM_REJECTED', 'WECHAT2RSS_REQUEST_FAILED'])(
    'does not read query/RSS after a rejected JSON Feed read: %s',
    async (code) => {
      jest
        .spyOn(Wechat2RssProvider.prototype, 'checkAccountStatus')
        .mockResolvedValue({
          available: true,
          challenged: false,
          retryAfter: undefined,
        });
      jest
        .spyOn(Wechat2RssProvider.prototype, 'listSubscriptions')
        .mockResolvedValue([
          {
            feedId: 'MP_WXS_1234567890',
            name: '合成公众号',
            feedUrl: '/feed/1234567890.xml',
          },
        ]);
      jest
        .spyOn(Wechat2RssProvider.prototype, 'fetchArticles')
        .mockRejectedValue(new Error(code));
      const result = await preflight({}, ['--execute', 'MP_WXS_1234567890']);
      expect(result.errors).toEqual([code]);
      expect(result.processState.exitCode).toBe(1);
    },
  );

  it('retains the existing cache-only read flow with synthetic responses and no writes', async () => {
    jest
      .spyOn(Wechat2RssProvider.prototype, 'checkAccountStatus')
      .mockResolvedValue({
        available: true,
        challenged: false,
        retryAfter: undefined,
      });
    const list = jest
      .spyOn(Wechat2RssProvider.prototype, 'listSubscriptions')
      .mockResolvedValue([
        {
          feedId: 'MP_WXS_1234567890',
          name: '合成公众号',
          feedUrl: '/feed/1234567890.xml',
        },
      ]);
    jest
      .spyOn(Wechat2RssProvider.prototype, 'fetchArticles')
      .mockResolvedValue({
        articles: [],
        coverage: 'recent-window',
        upstreamCount: 0,
        bodyMissing: 0,
        imageBlocked: 0,
      });
    const add = jest.spyOn(Wechat2RssProvider.prototype, 'addSubscription');
    const refresh = jest.spyOn(
      Wechat2RssProvider.prototype,
      'refreshSubscription',
    );
    const read = jest.fn().mockImplementation(async (url) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === '/api/query')
        return new Response(JSON.stringify({ err: '', data: [] }));
      if (pathname === '/feed/1234567890.xml')
        return new Response('<rss><channel></channel></rss>');
      throw new Error('UNEXPECTED_SYNTHETIC_ENDPOINT');
    });
    const result = await preflight(
      {},
      ['--execute', 'MP_WXS_1234567890'],
      false,
      read,
    );
    expect(result.errors).toEqual([]);
    expect(result.logs[0]).toMatchObject({
      mode: 'read-only',
      account: { available: true },
      jsonFeed: { count: 0 },
      query: { count: 0 },
      rss: { items: 0, entries: 0 },
    });
    expect(list).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(add).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(JSON.stringify(result.logs)).not.toContain(
      'synthetic-private-token',
    );
    expect(result.processState.env.WECHAT2RSS_ENABLED).toBe('0');
  });

  it.each([200, 429])(
    'stops after a rejected query without reading RSS or guessing a billing code (HTTP %s)',
    async (status) => {
      jest
        .spyOn(Wechat2RssProvider.prototype, 'checkAccountStatus')
        .mockResolvedValue({
          available: true,
          challenged: false,
          retryAfter: undefined,
        });
      jest
        .spyOn(Wechat2RssProvider.prototype, 'listSubscriptions')
        .mockResolvedValue([
          {
            feedId: 'MP_WXS_1234567890',
            name: '合成公众号',
            feedUrl: '/feed/1234567890.xml',
          },
        ]);
      jest
        .spyOn(Wechat2RssProvider.prototype, 'fetchArticles')
        .mockResolvedValue({
          articles: [],
          coverage: 'recent-window',
          upstreamCount: 0,
          bodyMissing: 0,
          imageBlocked: 0,
        });
      const read = jest
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ err: 'SYNTHETIC_PRIVATE_SECRET', data: [] }),
            { status },
          ),
        );
      const result = await preflight(
        {},
        ['--execute', 'MP_WXS_1234567890'],
        false,
        read,
      );
      expect(result.errors).toEqual([
        status === 200 ? 'QUERY_INVALID' : 'UPSTREAM_READ_FAILED',
      ]);
      expect(read).toHaveBeenCalledTimes(1);
      expect(result.processState.exitCode).toBe(1);
    },
  );
});
