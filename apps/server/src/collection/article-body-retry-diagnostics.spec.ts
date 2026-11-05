import { readBodyRetryResult } from './article-body-retry';

describe('persisted retry diagnostics are historical and allowlisted', () => {
  const failed = {
    status: 'failed',
    code: 'request_failed',
    attemptedAt: 1791941978,
    cached: true,
    filled: false,
    message: 'Cookie=SECRET',
    requestFailure: {
      reason: 'http_status',
      httpStatus: 302,
      url: 'https://evil.invalid/SECRET',
    },
    rawError: 'SECRET',
  };
  it('retains failure, time and safe HTTP reason while removing raw details', () => {
    const result = readBodyRetryResult(JSON.stringify(failed));
    expect(result).toMatchObject({
      status: 'failed',
      attemptedAt: failed.attemptedAt,
      requestFailure: { reason: 'http_status', httpStatus: 302 },
    });
    expect(JSON.stringify(result)).not.toMatch(/SECRET|Cookie|evil|rawError/);
  });
  it('does not echo malformed or unknown diagnostics', () => {
    expect(
      readBodyRetryResult(
        JSON.stringify({
          ...failed,
          requestFailure: { reason: 'SECRET', httpStatus: 302 },
        }),
      ),
    ).not.toHaveProperty('requestFailure');
    expect(
      readBodyRetryResult(
        JSON.stringify({
          ...failed,
          requestFailure: { reason: 'http_status', httpStatus: 'SECRET' },
        }),
      ),
    ).toMatchObject({ requestFailure: { reason: 'http_status' } });
    expect(readBodyRetryResult('{')).toBeNull();
  });
});
