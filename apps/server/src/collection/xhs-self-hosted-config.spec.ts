import {
  parseXhsSelfHostedConfig,
  summarizeXhsSelfHostedConfig,
} from './xhs-self-hosted-config';

// All fixtures are synthetic. Valid parameters prove only local syntax.
const syntheticKey = 'synthetic-candidate-key';
const candidate = (baseUrl: unknown, apiKey: unknown = syntheticKey) =>
  parseXhsSelfHostedConfig({
    XHS_SELF_HOSTED_BASE_URL: baseUrl,
    XHS_SELF_HOSTED_API_KEY: apiKey,
  });

describe('self-hosted XHS configuration candidate', () => {
  it('has no defaults and stays blocked with missing or blank parameters', () => {
    for (const env of [
      {},
      { XHS_SELF_HOSTED_BASE_URL: '  ', XHS_SELF_HOSTED_API_KEY: '' },
    ]) {
      expect(parseXhsSelfHostedConfig(env)).toEqual({
        baseUrl: null,
        apiKeyConfigured: false,
        configured: false,
        sourceReviewed: false,
        verifiedBodySource: false,
        canRefresh: false,
        issues: [
          'XHS_SELF_HOSTED_BASE_URL_MISSING',
          'XHS_SELF_HOSTED_API_KEY_MISSING',
        ],
      });
    }
  });

  it.each([
    ['http://localhost', 'http://localhost/'],
    ['https://LOCALHOST/private-base/', 'https://localhost/private-base/'],
    ['http://127.0.0.1:49152', 'http://127.0.0.1:49152/'],
    ['http://127.12.34.56/base', 'http://127.12.34.56/base'],
    ['https://[::1]', 'https://[::1]/'],
    ['http://[0:0:0:0:0:0:0:1]:49153/base', 'http://[::1]:49153/base'],
    ['  http://localhost/  ', 'http://localhost/'],
  ])(
    'accepts an explicit loopback base %s without promoting refresh',
    (input, expected) => {
      expect(candidate(input)).toEqual({
        baseUrl: expected,
        apiKeyConfigured: true,
        configured: true,
        sourceReviewed: false,
        verifiedBodySource: false,
        canRefresh: false,
        issues: [],
      });
    },
  );

  it.each([
    'https://example.invalid',
    'http://192.168.1.1',
    'http://0.0.0.0',
    'http://[::]',
    'http://[::ffff:127.0.0.1]',
    'http://localhost.example.invalid',
    'http://localhost.',
    'ftp://localhost',
    '//localhost',
    'http:localhost',
    'http://127.1',
    'http://2130706433',
    'http://0x7f000001',
    'http://%6cocalhost',
    'http://localhost:65536',
    'http://localhost?secret=synthetic-candidate-key',
    'http://localhost?',
    'http://localhost#synthetic-candidate-key',
    'http://localhost#',
    'http://synthetic-candidate-key@localhost',
    'http://user:synthetic-candidate-key@localhost',
    'http://@localhost',
    'http://localhost\\private',
    'http://local\nhost',
    'http://localhost/\tprivate',
    'invalid-synthetic-candidate-key',
    123,
    null,
  ])('rejects invalid or non-loopback input without echoing it', (input) => {
    const result = candidate(input);
    expect(result.baseUrl).toBeNull();
    expect(result.configured).toBe(false);
    expect(result.canRefresh).toBe(false);
    expect(result.issues).toEqual(['XHS_SELF_HOSTED_BASE_URL_INVALID']);
    expect(JSON.stringify(result)).not.toContain(syntheticKey);
  });

  it.each(['', ' \t ', undefined])('reports a missing key safely', (key) => {
    const result = parseXhsSelfHostedConfig({
      XHS_SELF_HOSTED_BASE_URL: 'http://localhost',
      XHS_SELF_HOSTED_API_KEY: key,
    });
    expect(result.apiKeyConfigured).toBe(false);
    expect(result.configured).toBe(false);
    expect(result.canRefresh).toBe(false);
    expect(result.issues).toEqual(['XHS_SELF_HOSTED_API_KEY_MISSING']);
  });

  it.each([
    123,
    null,
    {},
    'synthetic\nkey',
    'synthetic\rkey',
    'synthetic\0key',
    'synthetic\x7fkey',
  ])('rejects malformed keys with fixed errors', (key) => {
    const result = candidate('http://localhost', key);
    expect(result.apiKeyConfigured).toBe(false);
    expect(result.configured).toBe(false);
    expect(result.issues).toEqual(['XHS_SELF_HOSTED_API_KEY_INVALID']);
    expect(JSON.stringify(result)).not.toContain('synthetic');
  });

  it('never exposes the key and leaves sensitive base paths out of summary', () => {
    const parsed = candidate(
      `http://localhost/${syntheticKey}`,
      `  ${syntheticKey}  `,
    );
    const summary = summarizeXhsSelfHostedConfig(parsed);
    expect(summary).toEqual({
      baseUrlConfigured: true,
      apiKeyConfigured: true,
      configured: true,
      sourceReviewed: false,
      verifiedBodySource: false,
      canRefresh: false,
      issues: [],
    });
    expect(parsed).not.toHaveProperty('apiKey');
    expect(JSON.stringify(summary)).not.toContain(syntheticKey);
    expect(JSON.stringify(summary)).not.toContain('http');
  });

  it('performs no network or implicit environment lookup', () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('NETWORK_FORBIDDEN');
    });
    try {
      const env = new Proxy(
        {},
        {
          get: (_target, name) => {
            if (name === 'XHS_SELF_HOSTED_BASE_URL') return 'http://localhost';
            if (name === 'XHS_SELF_HOSTED_API_KEY') return syntheticKey;
            throw new Error('UNEXPECTED_CONFIG_LOOKUP');
          },
        },
      );
      expect(candidate('http://localhost').canRefresh).toBe(false);
      expect(parseXhsSelfHostedConfig(env).canRefresh).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
});
