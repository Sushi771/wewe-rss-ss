import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  createRedbookHttpTransport,
  createXhsMediaTransport,
  XhsHttpsRequest,
} from './xhs-http-transport';
import {
  RedbookClient,
  RedbookPauseError,
  RedbookRequest,
} from './redbook-client';

it('constructs only the reviewed bounded comment read routes with no retry or implicit paging (mock only)', async () => {
  const transport = jest.fn(async (request) => ({
    status: 200,
    url: request.url,
    body: { success: true, code: 0, data: {} },
  }));
  const client = new RedbookClient({
    transport,
    cookies: () => ({ a1: 'synthetic-a1', web_session: 'synthetic-session' }),
  });
  await client.getComments(
    'synthetic-note',
    'synthetic-cursor',
    'synthetic-token',
  );
  await client.getSubComments(
    'synthetic-note',
    'synthetic-root',
    'synthetic-next',
  );
  expect(transport).toHaveBeenCalledTimes(2);
  const top = new URL(transport.mock.calls[0][0].url),
    replies = new URL(transport.mock.calls[1][0].url);
  expect(top.pathname).toBe('/api/sns/web/v2/comment/page');
  expect(top.searchParams.get('cursor')).toBe('synthetic-cursor');
  expect(replies.pathname).toBe('/api/sns/web/v2/comment/sub/page');
  expect(replies.searchParams.get('root_comment_id')).toBe('synthetic-root');
  expect(replies.searchParams.get('num')).toBe('30');
});

it('uses the explicitly reviewed v1 list route once without endpoint fallback', async () => {
  const transport = jest.fn(async (input: RedbookRequest) => ({
    status: 200,
    url: input.url,
    body: { success: true, code: 0, data: {} },
  }));
  await new RedbookClient({
    transport,
    cookies: () => ({
      a1: 'synthetic-device',
      web_session: 'synthetic-session',
    }),
  }).getUserNotes('synthetic-author');
  expect(transport).toHaveBeenCalledTimes(1);
  expect(new URL(transport.mock.calls[0][0].url).pathname).toBe(
    '/api/sns/web/v1/user_posted',
  );
});

function httpsFixture(
  options: {
    status?: number;
    headers?: Record<string, string>;
    parts?: Buffer[];
    hold?: boolean;
  } = {},
) {
  let response: PassThrough | undefined;
  const destroy = jest.fn();
  const raw = jest.fn(
    (url: URL, requestOptions: any, callback: (res: any) => void) => {
      const req = new EventEmitter() as any;
      req.destroy = destroy;
      req.end = jest.fn(() =>
        queueMicrotask(() => {
          response = new PassThrough();
          Object.assign(response, {
            statusCode: options.status ?? 200,
            headers: options.headers ?? { 'content-type': 'application/json' },
          });
          callback(response);
          if (!options.hold && !response.destroyed) {
            for (const part of options.parts ?? [
              Buffer.from('{"success":true,"data":{}}'),
            ])
              response.write(part);
            response.end();
          }
        }),
      );
      return req;
    },
  );
  return {
    request: raw as unknown as XhsHttpsRequest,
    raw,
    destroy,
    get response() {
      return response;
    },
  };
}
const apiInput = (overrides: Partial<RedbookRequest> = {}): RedbookRequest => ({
  url: 'https://edith.xiaohongshu.com/api/sns/web/v1/user/otherinfo?target_user_id=synthetic',
  method: 'GET',
  headers: {
    cookie: 'a1=synthetic; web_session=synthetic',
    accept: 'application/json',
  },
  redirect: 'error',
  timeoutMs: 15000,
  maxResponseBytes: 1000,
  ...overrides,
});
// The production client's allowlisted API headers do not include arbitrary Accept.
const input = (overrides: Partial<RedbookRequest> = {}) =>
  apiInput({
    headers: {
      cookie: 'a1=synthetic; web_session=synthetic',
      'content-type': 'application/json',
    },
    ...overrides,
  });
const mediaOptions = (signal = new AbortController().signal) => ({
  redirect: 'manual' as const,
  credentials: 'omit' as const,
  headers: { accept: 'image/png,image/jpeg,image/gif,image/webp' },
  signal,
});
describe('native HTTPS metadata transport (injected synthetic request only)', () => {
  it('sends only a reviewed route and parses a bounded fragmented JSON response', async () => {
    const f = httpsFixture({
      parts: [
        Buffer.from('{"success":'),
        Buffer.from('true,"data":{"synthetic":1}}'),
      ],
    });
    expect(await createRedbookHttpTransport(f.request)(input())).toMatchObject({
      status: 200,
      body: { success: true, data: { synthetic: 1 } },
    });
    expect(f.raw).toHaveBeenCalledTimes(1);
    expect(f.raw.mock.calls[0][1]).toMatchObject({
      method: 'GET',
      agent: false,
      headers: { cookie: 'a1=synthetic; web_session=synthetic' },
    });
  });
  it.each([
    'http://edith.xiaohongshu.com/api/sns/web/v1/feed',
    'https://sns-webpic.xhscdn.com/api/sns/web/v1/feed',
    'https://edith.xiaohongshu.com/api/sns/web/v1/comment/post',
    'https://edith.xiaohongshu.com:443/api/sns/web/v1/feed',
    'https://user@edith.xiaohongshu.com/api/sns/web/v1/feed',
  ])(
    'rejects unreviewed signed destination %s before dispatch',
    async (url) => {
      const f = httpsFixture();
      await expect(
        createRedbookHttpTransport(f.request)(input({ url, method: 'POST' })),
      ).rejects.toThrow('transport');
      expect(f.raw).not.toHaveBeenCalled();
    },
  );
  it('does not follow redirects or retain upstream error text', async () => {
    const f = httpsFixture({
      status: 302,
      headers: { location: 'https://evil.test/synthetic-token' },
      parts: [Buffer.from('synthetic raw diagnostic')],
    });
    expect(await createRedbookHttpTransport(f.request)(input())).toMatchObject({
      status: 302,
      body: {},
    });
    expect(f.raw).toHaveBeenCalledTimes(1);
  });
  it('rejects declared and streamed oversize bodies and never returns truncated JSON', async () => {
    const declared = httpsFixture({
      headers: { 'content-type': 'application/json', 'content-length': '1001' },
    });
    await expect(
      createRedbookHttpTransport(declared.request)(input()),
    ).rejects.toThrow('transport');
    const streamed = httpsFixture({ parts: [Buffer.alloc(1001, 65)] });
    await expect(
      createRedbookHttpTransport(streamed.request)(input()),
    ).rejects.toThrow('transport');
    expect(streamed.destroy).toHaveBeenCalled();
  });
  it('rejects non-JSON and malformed JSON with fixed errors', async () => {
    const html = httpsFixture({
      headers: { 'content-type': 'text/html' },
      parts: [Buffer.from('synthetic token echo')],
    });
    await expect(
      createRedbookHttpTransport(html.request)(input()),
    ).rejects.toThrow('transport');
    const malformed = httpsFixture({
      parts: [Buffer.from('synthetic secret not json')],
    });
    await expect(
      createRedbookHttpTransport(malformed.request)(input()),
    ).rejects.toThrow('transport');
  });
  it('honors cancellation before dispatch and during response streaming', async () => {
    const f = httpsFixture({ hold: true }),
      controller = new AbortController();
    const pending = createRedbookHttpTransport(f.request)(
      input({ signal: controller.signal }),
    );
    while (!f.response) await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toThrow('transport');
    expect(f.destroy).toHaveBeenCalled();
    const early = httpsFixture();
    await expect(
      createRedbookHttpTransport(early.request)(
        input({ signal: controller.signal }),
      ),
    ).rejects.toThrow('transport');
    expect(early.raw).not.toHaveBeenCalled();
  });
});
describe('separate bounded CDN stream (injected synthetic request only)', () => {
  it.each([403, 429, 461, 500, 503])('retains only the observed HTTP status %s and never retries', async (status) => {
    const f = httpsFixture({ status, headers: { 'content-type': 'text/html' }, parts: [Buffer.from('synthetic-secret')] });
    const error = await createXhsMediaTransport(f.request)(new URL('https://sns-webpic.xhscdn.com/synthetic?token=synthetic-secret'), mediaOptions()).catch((e) => e);
    expect(error.message).toBe(`XHS_MEDIA_HTTP_${status}`);
    expect(xhsPublicCode(error, 'fallback')).toBe(`XHS_MEDIA_HTTP_${status}`);
    expect(String(error)).not.toContain('synthetic-secret');
    expect(f.raw).toHaveBeenCalledTimes(1);
  });
  it('classifies actual type rejection without retaining header values', async () => {
    const f = httpsFixture({ headers: { 'content-type': 'text/html; synthetic-secret' } });
    const error = await createXhsMediaTransport(f.request)(new URL('https://sns-webpic.xhscdn.com/synthetic'), mediaOptions()).catch((e) => e);
    expect(xhsPublicCode(error, 'fallback')).toBe('XHS_MEDIA_TYPE_REJECTED');
    expect(String(error)).not.toContain('synthetic-secret');
  });
  it('distinguishes an observed timeout from an ordinary abort', async () => {
    const f = httpsFixture({ headers: { 'content-type': 'image/png' }, hold: true });
    const controller = new AbortController();
    const response = await createXhsMediaTransport(f.request)(new URL('https://sns-webpic.xhscdn.com/synthetic'), mediaOptions(controller.signal));
    const pending = response.arrayBuffer();
    controller.abort(new DOMException('synthetic-secret', 'TimeoutError'));
    await expect(pending).rejects.toThrow('XHS_MEDIA_TIMEOUT');
    expect(f.raw).toHaveBeenCalledTimes(1);
  });
  it('streams bytes without Cookie/Authorization and never follows redirects', async () => {
    const f = httpsFixture({
      headers: { 'content-type': 'image/png' },
      parts: [Buffer.from('synthetic-image-bytes')],
    });
    const response = await createXhsMediaTransport(f.request)(
      new URL('https://sns-webpic-qc.xhscdn.com/synthetic'),
      mediaOptions(),
    );
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe(
      'synthetic-image-bytes',
    );
    expect(f.raw.mock.calls[0][1]).toEqual({
      method: 'GET',
      headers: { accept: 'image/png,image/jpeg,image/gif,image/webp' },
      agent: false,
    });
    const redirected = httpsFixture({
      status: 302,
      headers: { location: 'https://evil.test' },
    });
    await expect(
      createXhsMediaTransport(redirected.request)(
        new URL('https://sns-webpic.xhscdn.com/synthetic'),
        mediaOptions(),
      ),
    ).rejects.toThrow('XHS_MEDIA_HTTP_302');
    expect(redirected.raw).toHaveBeenCalledTimes(1);
  });
  it('rejects credential headers, non-CDN targets and cleartext before dispatch', async () => {
    const f = httpsFixture(),
      transport = createXhsMediaTransport(f.request);
    await expect(
      transport(new URL('https://sns-webpic.xhscdn.com/synthetic'), {
        ...mediaOptions(),
        headers: { accept: 'image/png', cookie: 'synthetic' },
      }),
    ).rejects.toThrow('XHS_MEDIA_REQUEST_REJECTED');
    await expect(
      transport(new URL('https://127.0.0.1/synthetic'), mediaOptions()),
    ).rejects.toThrow('XHS_MEDIA_REQUEST_REJECTED');
    await expect(
      transport(
        new URL('http://sns-webpic.xhscdn.com/synthetic'),
        mediaOptions(),
      ),
    ).rejects.toThrow('XHS_MEDIA_REQUEST_REJECTED');
    expect(f.raw).not.toHaveBeenCalled();
  });
  it('bounds media by declared length and actual streamed bytes', async () => {
    const url = new URL('https://sns-webpic.xhscdn.com/synthetic');
    const malformed = httpsFixture({ headers: { 'content-type': 'image/png', 'content-length': 'bad' } });
    await expect(createXhsMediaTransport(malformed.request)(url, mediaOptions())).rejects.toThrow('XHS_MEDIA_RESPONSE_INVALID');
    const declared = httpsFixture({
      headers: { 'content-type': 'image/png', 'content-length': '10000001' },
    });
    await expect(
      createXhsMediaTransport(declared.request)(url, mediaOptions()),
    ).rejects.toThrow('XHS_MEDIA_SIZE_REJECTED');
    const streamed = httpsFixture({
      headers: { 'content-type': 'image/png' },
      parts: [Buffer.alloc(6000000), Buffer.alloc(5000000)],
    });
    const response = await createXhsMediaTransport(streamed.request)(
      url,
      mediaOptions(),
    );
    await expect(response.arrayBuffer()).rejects.toThrow('XHS_MEDIA_SIZE_REJECTED');
    expect(streamed.destroy).toHaveBeenCalled();
  });
  it('propagates cancellation after headers into the consumer stream', async () => {
    const f = httpsFixture({
        headers: { 'content-type': 'image/png' },
        hold: true,
      }),
      controller = new AbortController();
    const response = await createXhsMediaTransport(f.request)(
      new URL('https://sns-webpic.xhscdn.com/synthetic'),
      mediaOptions(controller.signal),
    );
    const read = response.arrayBuffer();
    controller.abort();
    await expect(read).rejects.toThrow('XHS_MEDIA_ABORTED');
    expect(f.destroy).toHaveBeenCalled();
  });
});
import {
  redbookErrorSummary,
  REDBOOK_ERROR_MAX_BYTES,
} from './redbook-error-summary';
import { xhsPublicCode } from './xhs-subscription-errors';

describe('bounded HTTP rejection classification (synthetic only)', () => {
  it.each([
    [461, {}, 'unknown_rejection'],
    [471, { message: 'access denied' }, 'unknown_rejection'],
    [461, { code: -100 }, 'authentication'],
    [471, { code: -101 }, 'authentication'],
    [401, { message: 'captcha required' }, 'authentication'],
    [461, { msg: '请完成验证码验证' }, 'verification'],
    [471, { message: 'captcha required' }, 'verification'],
    [200, { success: false, code: -104 }, 'permission'],
    [
      461,
      { msg: 'captcha required https://evil.test/?token=synthetic-secret' },
      'unknown_rejection',
    ],
    [
      471,
      {
        verification_url:
          'https://www.xiaohongshu.com/?xsec_token=synthetic-secret',
      },
      'unknown_rejection',
    ],
  ])(
    'classifies %s using only explicit allowlisted evidence',
    async (status, body, reason) => {
      const f = httpsFixture({
        status: status as number,
        parts: [Buffer.from(JSON.stringify(body))],
      });
      const client = new RedbookClient({
        transport: createRedbookHttpTransport(f.request),
        cookies: () => ({ a1: 'synthetic', web_session: 'synthetic' }),
      });
      const error = await client
        .getSubComments('synthetic-note', 'synthetic-root')
        .catch((error) => error);
      expect(error).toBeInstanceOf(RedbookPauseError);
      if (!(error instanceof RedbookPauseError))
        throw new Error('expected pause');
      expect(error.reason).toBe(reason);
      expect(xhsPublicCode(error, 'fallback')).toBe(
        `XHS_SOURCE_${String(reason).toUpperCase()}_BLOCKED`,
      );
      expect(JSON.stringify(error) + String(error)).not.toMatch(
        /synthetic-secret|evil\.test|xsec_token/,
      );
      expect(f.raw).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    [
      { 'content-type': 'text/html' },
      '<html>captcha required synthetic-secret</html>',
    ],
    [{ 'content-type': 'application/json' }, '{"msg":"captcha required"'],
    [
      { 'content-type': 'application/json' },
      JSON.stringify({
        msg: 'captcha required',
        echo: 'synthetic-secret'.repeat(1000),
      }),
    ],
    [
      {
        'content-type': 'application/json',
        'content-length': String(REDBOOK_ERROR_MAX_BYTES + 1),
      },
      '{}',
    ],
  ])(
    'keeps rejection status with no diagnostic data for invalid or excessive bodies',
    async (headers, raw) => {
      const f = httpsFixture({
        status: 461,
        headers: headers as Record<string, string>,
        parts: [Buffer.from(raw as string)],
      });
      const result = await createRedbookHttpTransport(f.request)(
        input({ maxResponseBytes: 8 * 1024 * 1024 }),
      );
      expect(result).toMatchObject({ status: 461, body: {} });
      expect(f.raw).toHaveBeenCalledTimes(1);
      expect(f.response?.destroyed).toBe(true);
    },
  );
  it('projects only recognized codes and a canonical verification marker; never a link or raw prose', async () => {
    const raw = {
      code: -100,
      msg: '需要验证码',
      message: 'synthetic-secret',
      data: { cookie: 'synthetic-secret' },
      url: 'javascript:alert(1)',
      verification_url: 'https://www.xiaohongshu.com/?token=synthetic-secret',
    };
    expect(redbookErrorSummary(raw)).toEqual({
      code: -100,
      msg: 'captcha required',
    });
    expect(
      redbookErrorSummary({ code: '-100', msg: '需要验证码'.repeat(100) }),
    ).toEqual({});
    expect(
      redbookErrorSummary({
        code: 999999,
        message: 'please captcha required now',
      }),
    ).toEqual({});
    expect(redbookErrorSummary([raw])).toEqual({});
    const f = httpsFixture({
      status: 471,
      parts: [Buffer.from(JSON.stringify(raw))],
    });
    expect((await createRedbookHttpTransport(f.request)(input())).body).toEqual(
      { code: -100, msg: 'captcha required' },
    );
    expect(f.raw).toHaveBeenCalledTimes(1);
  });
  it('keeps an unknown rejection hard stop when its diagnostic body times out', async () => {
    jest.useFakeTimers();
    try {
      const f = httpsFixture({ status: 471, hold: true });
      const pending = createRedbookHttpTransport(f.request)(
        input({ timeoutMs: 10 }),
      );
      await jest.advanceTimersByTimeAsync(10);
      await expect(pending).resolves.toMatchObject({ status: 471, body: {} });
      expect(f.raw).toHaveBeenCalledTimes(1);
      expect(f.destroy).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});

it('preserves a received 461 when the optional error stream fails', async () => {
  const f = httpsFixture({ status: 461, hold: true });
  const pending = createRedbookHttpTransport(f.request)(input());
  while (!f.response) await Promise.resolve();
  f.response!.write(
    Buffer.from('{"msg":"captcha required", "echo":"synthetic-secret'),
  );
  f.response!.emit('error', new Error('synthetic-secret'));
  await expect(pending).resolves.toMatchObject({ status: 461, body: {} });
  expect(f.response?.destroyed).toBe(true);
  expect(f.raw).toHaveBeenCalledTimes(1);
});

it('keeps thirteen successful requests separate from an unknown reply rejection', async () => {
  const transport = jest.fn(async (request: RedbookRequest) => ({
    url: request.url,
    status: transport.mock.calls.length === 14 ? 461 : 200,
    body: { success: true, code: 0, data: {} },
  }));
  const client = new RedbookClient({
    transport,
    cookies: () => ({ a1: 'synthetic', web_session: 'synthetic' }),
  });
  for (let i = 0; i < 13; i++) await client.getComments('synthetic-note');
  await expect(
    client.getSubComments('synthetic-note', 'synthetic-root'),
  ).rejects.toThrow('unknown_rejection');
  expect(transport).toHaveBeenCalledTimes(14);
  expect(new URL(transport.mock.calls[13][0].url).pathname).toBe(
    '/api/sns/web/v2/comment/sub/page',
  );
});
