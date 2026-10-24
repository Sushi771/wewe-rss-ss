import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  createRedbookHttpTransport,
  createXhsMediaTransport,
  XhsHttpsRequest,
} from './xhs-http-transport';
import { RedbookClient, RedbookRequest } from './redbook-client';

it('uses the explicitly reviewed v1 list route once without endpoint fallback', async () => {
  const transport = jest.fn(async (input: RedbookRequest) => ({
    status: 200,
    url: input.url,
    body: { success: true, code: 0, data: {} },
  }));
  await new RedbookClient({
    transport,
    cookies: () => ({ a1: 'synthetic-device', web_session: 'synthetic-session' }),
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
    ).rejects.toThrow('transport');
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
    ).rejects.toThrow('transport');
    await expect(
      transport(new URL('https://127.0.0.1/synthetic'), mediaOptions()),
    ).rejects.toThrow('transport');
    await expect(
      transport(
        new URL('http://sns-webpic.xhscdn.com/synthetic'),
        mediaOptions(),
      ),
    ).rejects.toThrow('transport');
    expect(f.raw).not.toHaveBeenCalled();
  });
  it('bounds media by declared length and actual streamed bytes', async () => {
    const url = new URL('https://sns-webpic.xhscdn.com/synthetic');
    const declared = httpsFixture({
      headers: { 'content-type': 'image/png', 'content-length': '10000001' },
    });
    await expect(
      createXhsMediaTransport(declared.request)(url, mediaOptions()),
    ).rejects.toThrow('transport');
    const streamed = httpsFixture({
      headers: { 'content-type': 'image/png' },
      parts: [Buffer.alloc(6000000), Buffer.alloc(5000000)],
    });
    const response = await createXhsMediaTransport(streamed.request)(
      url,
      mediaOptions(),
    );
    await expect(response.arrayBuffer()).rejects.toThrow('transport');
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
    await expect(read).rejects.toThrow('transport');
    expect(f.destroy).toHaveBeenCalled();
  });
});
