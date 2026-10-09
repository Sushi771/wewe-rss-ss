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
  overrides: Record<string, string | undefined> = {},
  args: string[] = [],
  buildMissing = false,
  readFetch: typeof fetch = global.fetch,
  instanceEnv?: string,
  applicationEnv?: string | Error,
) {
  const logs: string[] = [];
  const errors: string[] = [];
  const instancePath = path.resolve(__dirname, '../../../../.env.wechat2rss');
  const applicationPath = path.resolve(__dirname, '../../.env.local');
  const filesRead: string[] = [];
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
        if (name === 'node:fs')
          return {
            existsSync: (file: string) =>
              (file === instancePath && instanceEnv !== undefined) ||
              (file === applicationPath && applicationEnv !== undefined),
            readFileSync: (file: string) => {
              if (file === applicationPath && applicationEnv !== undefined) {
                filesRead.push(file);
                if (applicationEnv instanceof Error) throw applicationEnv;
                return Buffer.from(applicationEnv);
              }
              if (file !== instancePath || instanceEnv === undefined)
                throw new Error('UNEXPECTED_PRIVATE_FILE_READ');
              filesRead.push(file);
              return Buffer.from(instanceEnv);
            },
          };
        if (name.endsWith('wechat2rss.js')) {
          if (buildMissing) throw new Error('synthetic-build-missing');
          return { Wechat2RssProvider };
        }
        return require(name);
      },
    },
    { timeout: 1000 },
  );
  return {
    logs: logs.map((value) => JSON.parse(value)),
    errors,
    processState,
    filesRead,
  };
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

  it.each([
    { args: [] },
    { args: ['--deployment-config'] },
    { args: ['--execute', 'MP_WXS_1234567890'] },
  ])(
    'stops safely when application config cannot be read (args=%j)',
    async ({ args }) => {
      const account = jest.spyOn(
        Wechat2RssProvider.prototype,
        'checkAccountStatus',
      );
      const failure = new Error(
        'EACCES C:/synthetic-private-path/.env.local synthetic-private-value',
      );
      const result = await preflight(
        {},
        args,
        false,
        global.fetch,
        'LIC_CODE=synthetic-instance-license',
        failure,
      );
      expect(result.errors).toEqual(['PRIVATE_CONFIG_READ_FAILED']);
      expect(result.processState.exitCode).toBe(1);
      expect(result.logs).toEqual([]);
      expect(result.filesRead).toEqual([
        path.resolve(__dirname, '../../.env.local'),
      ]);
      expect(account).not.toHaveBeenCalled();
      expect(JSON.stringify([...result.logs, ...result.errors])).not.toMatch(
        /EACCES|synthetic-private|synthetic-instance|\.env\.local/,
      );
    },
  );

  it('uses successfully loaded application config before checking existence and format', async () => {
    const application =
      'WECHAT2RSS_BASE_URL=http://127.0.0.1:18081/\nWECHAT2RSS_TOKEN=synthetic-file-token\nWECHAT2RSS_ENABLED=1';
    const result = await preflight(
      {
        WECHAT2RSS_BASE_URL: undefined,
        WECHAT2RSS_TOKEN: undefined,
        WECHAT2RSS_ENABLED: undefined,
      },
      [],
      false,
      global.fetch,
      undefined,
      application,
    );
    expect(result.logs[0]).toMatchObject({
      configured: { baseUrl: true, token: true },
      configCheck: { valid: true },
      appEnabled: true,
    });
    expect(result.processState.env.WECHAT2RSS_BASE_URL).toBe(
      'http://127.0.0.1:18081/',
    );
    expect(result.processState.env.WECHAT2RSS_TOKEN).toBe(
      'synthetic-file-token',
    );
    expect(JSON.stringify(result.logs)).not.toMatch(
      /18081|synthetic-file-token/,
    );
  });

  it('preserves existing process environment over successfully loaded application config', async () => {
    const result = await preflight(
      {},
      [],
      false,
      global.fetch,
      undefined,
      'WECHAT2RSS_BASE_URL=http://127.0.0.1:18081/\nWECHAT2RSS_TOKEN=synthetic-file-token\nWECHAT2RSS_ENABLED=1',
    );
    expect(result.processState.env).toEqual(env);
    expect(result.logs[0]).toMatchObject({
      configCheck: { valid: true },
      appEnabled: false,
    });
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

  const instance = (overrides: Record<string, string> = {}) =>
    Object.entries({
      LIC_EMAIL: 'synthetic-owner@example.test',
      LIC_CODE: 'synthetic-license-code',
      RSS_TOKEN: 'synthetic-private-token',
      RSS_HOST: '127.0.0.1:18080',
      ...overrides,
    })
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

  it('checks the two local configs without contacting or enabling the instance', async () => {
    const account = jest.spyOn(
      Wechat2RssProvider.prototype,
      'checkAccountStatus',
    );
    const result = await preflight(
      {},
      ['--deployment-config'],
      false,
      global.fetch,
      instance(),
    );
    expect(result.logs[0]).toMatchObject({
      mode: 'deployment-config-only',
      appEnabled: false,
      deploymentConfig: {
        consistent: true,
        code: 'DEPLOYMENT_CONFIG_CONSISTENT',
        filePresent: true,
        tokenMatches: true,
        addressMatches: true,
      },
    });
    expect(result.filesRead).toHaveLength(1);
    expect(account).not.toHaveBeenCalled();
    expect(result.processState.env.WECHAT2RSS_ENABLED).toBe('0');
    expect(JSON.stringify(result.logs)).not.toMatch(
      /synthetic-owner|example\.test|synthetic-license-code|synthetic-private-token|127\.0\.0\.1/,
    );
  });

  it.each([
    [{ RSS_TOKEN: 'synthetic-other-token' }, 'DEPLOYMENT_TOKEN_MISMATCH'],
    [{ RSS_HOST: '127.0.0.1:18081' }, 'DEPLOYMENT_ADDRESS_MISMATCH'],
    [{ RSS_HTTPS: '1' }, 'DEPLOYMENT_ADDRESS_MISMATCH'],
    [{ LIC_EMAIL: 'Synthetic@example.test' }, 'DEPLOYMENT_EMAIL_CASE_INVALID'],
    [{ LIC_CODE: '' }, 'DEPLOYMENT_CONFIG_INCOMPLETE'],
  ] as const)(
    'detects a local config mismatch without exposing values: %s',
    async (bad, code) => {
      const result = await preflight(
        {},
        ['--deployment-config'],
        false,
        global.fetch,
        instance(bad),
      );
      expect(result.logs[0].deploymentConfig).toMatchObject({
        consistent: false,
        code,
      });
      expect(result.processState.exitCode).toBe(1);
      expect(JSON.stringify(result.logs)).not.toMatch(
        /synthetic-other-token|Synthetic@|synthetic-license-code|synthetic-private-token|127\.0\.0\.1/,
      );
    },
  );

  it('reports an absent instance file and rejects copying a license as the service password', async () => {
    const absent = await preflight({}, ['--deployment-config']);
    expect(absent.logs[0].deploymentConfig).toMatchObject({
      consistent: false,
      code: 'DEPLOYMENT_CONFIG_INCOMPLETE',
      filePresent: false,
    });
    const reused = await preflight(
      { WECHAT2RSS_TOKEN: 'synthetic-license-code' },
      ['--deployment-config'],
      false,
      global.fetch,
      instance({ RSS_TOKEN: 'synthetic-license-code' }),
    );
    expect(reused.logs[0].deploymentConfig.code).toBe(
      'DEPLOYMENT_TOKEN_IS_LICENSE_CODE',
    );
  });

  it('requires the existing Provider format/build check for config consistency', async () => {
    const result = await preflight(
      {},
      ['--deployment-config'],
      true,
      global.fetch,
      instance(),
    );
    expect(result.logs[0].deploymentConfig).toMatchObject({
      consistent: false,
      code: 'SERVER_BUILD_REQUIRED',
    });
  });

  it('rejects execute mixed with local deployment checking before any platform call', async () => {
    const result = await preflight(
      {},
      ['--deployment-config', '--execute', 'MP_WXS_1234567890'],
      false,
      global.fetch,
      instance(),
    );
    expect(result.errors).toEqual(['CONFIG_CHECK_ONLY_ARGUMENT_CONFLICT']);
    expect(result.processState.exitCode).toBe(1);
  });

  it('retains default preflight scope without reading the instance license file', async () => {
    const result = await preflight({}, [], false, global.fetch, instance());
    expect(result.logs[0].mode).toBe('preflight-only');
    expect(result.filesRead).toEqual([]);
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

  it.each([200, 302, 429])(
    'reports the cache-only RSS read outcome without writes (HTTP %s)',
    async (rssStatus) => {
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
          return new Response('<rss><channel></channel></rss>', {
            status: rssStatus,
          });
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
        rss:
          rssStatus === 200
            ? { items: 0, entries: 0 }
            : { error: 'UPSTREAM_READ_FAILED' },
      });
      expect(result.processState.exitCode ?? 0).toBe(rssStatus === 200 ? 0 : 1);
      expect(list).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenCalledTimes(2);
      expect(add).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
      expect(JSON.stringify(result.logs)).not.toContain(
        'synthetic-private-token',
      );
      expect(result.processState.env.WECHAT2RSS_ENABLED).toBe('0');
    },
  );

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
