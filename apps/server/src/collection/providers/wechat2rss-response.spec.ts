import { Wechat2RssProvider } from './wechat2rss';
import { WECHAT2RSS_CACHE_RESPONSE_LIMIT as LIMIT } from './wechat2rss-response';

const id = 'MP_WXS_1234567890';
const listed = {
  feedId: id,
  name: 'synthetic',
  feedUrl: '/feed/1234567890.json',
  checkTime: null,
  nextUpdateTime: null,
  paused: false,
};
const client = () =>
  new Wechat2RssProvider('http://127.0.0.1:18080/', 'synthetic-secret');
// encoding/json's default HTML-safe JSON string escaping. This proves a
// serializer-compatible boundary, not the bytes of an uncaptured production response.
const escapedJson = (value: unknown) =>
  JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  );
function largeFeed(bytes = 4_003_033) {
  const items = Array.from({ length: 24 }, (_, index) => ({
    id: `https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA==&mid=${index + 1}&idx=1`,
    title: `synthetic-${index}`,
    date_published: '2026-10-12T01:00:00Z',
    content_html: `<p>${'a'.repeat(130000)}${'&'.repeat(5000)}正文\u2028\u2029</p>`,
  }));
  const feed = { items };
  items[0].content_html += 'x'.repeat(
    bytes - Buffer.byteLength(escapedJson(feed)),
  );
  return feed;
}
function streamResponse(text: string, status = 200, chunk = 65536) {
  const bytes = Buffer.from(text);
  let offset = 0;
  return new Response(
    new ReadableStream(
      {
        pull(controller) {
          if (offset === bytes.length) return controller.close();
          const end = Math.min(bytes.length, offset + chunk);
          controller.enqueue(bytes.subarray(offset, end));
          offset = end;
        },
      },
      { highWaterMark: 0 },
    ),
    { status },
  );
}
describe('bounded cached-feed HTTP responses (synthetic streams only)', () => {
  afterEach(() => jest.restoreAllMocks());
  it('accepts every article in a 4,003,033-byte HTML-escaped JSON feed without another request', async () => {
    const feed = largeFeed(),
      wire = escapedJson(feed);
    expect(Buffer.byteLength(JSON.stringify(feed))).toBeLessThan(4_000_000);
    expect(Buffer.byteLength(wire)).toBe(4_003_033);
    const request = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(streamResponse(wire));
    const page = await client().fetchListedArticles(listed, listed.name);
    expect(page.articles).toHaveLength(24);
    expect(page.bodyMissing).toBe(0);
    expect(page.articles.map((a) => a.title)).toEqual(
      feed.items.map((a) => a.title),
    );
    expect(page.articles.every((a) => a.contentHtml?.includes('正文'))).toBe(
      true,
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(new URL(String(request.mock.calls[0][0])).pathname).toBe(
      listed.feedUrl,
    );
  });
  it('distinguishes a rejected HTTP status without exposing its URL, token or body', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(streamResponse('private upstream body', 503));
    await expect(
      client().fetchListedArticles(listed, listed.name),
    ).rejects.toMatchObject({
      message: 'WECHAT2RSS_HTTP_STATUS',
      httpStatus: 503,
    });
  });
  it('distinguishes invalid JSON from network failure', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(streamResponse('not JSON synthetic-secret'));
    await expect(
      client().fetchListedArticles(listed, listed.name),
    ).rejects.toThrow('WECHAT2RSS_INVALID_JSON');
  });
  it('keeps explicit throttling and empty-body categories', async () => {
    const request = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(streamResponse('private', 429));
    await expect(
      client().fetchListedArticles(listed, listed.name),
    ).rejects.toMatchObject({
      message: 'WECHAT2RSS_RATE_LIMITED',
      httpStatus: 429,
    });
    request.mockResolvedValue(new Response(null, { status: 200 }));
    await expect(
      client().fetchListedArticles(listed, listed.name),
    ).rejects.toThrow('WECHAT2RSS_EMPTY_BODY');
  });
  it('accepts an exactly-at-limit response rather than truncating it', async () => {
    const base = '{"items":[],"padding":""}';
    const wire = base.replace(
      '""',
      '"' + 'x'.repeat(LIMIT - Buffer.byteLength(base)) + '"',
    );
    expect(Buffer.byteLength(wire)).toBe(LIMIT);
    const request = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(streamResponse(wire));
    expect(
      (await client().fetchListedArticles(listed, listed.name)).articles,
    ).toEqual([]);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])(
    'rejects limit+1 bytes and cancels without waiting for cancellation (slow cancel=%s)',
    async (slowCancel) => {
      let emitted = 0,
        pulls = 0;
      const cancel = jest.fn(() =>
        slowCancel ? new Promise<void>(() => {}) : undefined,
      );
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls++;
            const count = Math.min(65536, LIMIT + 1 - emitted);
            controller.enqueue(new Uint8Array(count).fill(32));
            emitted += count;
          },
          cancel,
        },
        { highWaterMark: 0 },
      );
      const request = jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(body, {
          headers: { 'Content-Length': '1', 'Content-Encoding': 'gzip' },
        }),
      );
      await expect(
        client().fetchListedArticles(listed, listed.name),
      ).rejects.toMatchObject({
        message: 'WECHAT2RSS_RESPONSE_TOO_LARGE',
        responseBytes: LIMIT + 1,
        responseLimitBytes: LIMIT,
      });
      expect(pulls).toBe(Math.ceil((LIMIT + 1) / 65536));
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it('keeps the smaller control-response ceiling', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(streamResponse(' '.repeat(4_000_001)));
    await expect(client().checkAccountStatus()).rejects.toMatchObject({
      message: 'WECHAT2RSS_RESPONSE_TOO_LARGE',
      responseLimitBytes: 4_000_000,
    });
  });
  it('keeps UTF-8 codepoints intact across one-byte chunks', async () => {
    const feed = largeFeed();
    feed.items = feed.items.slice(0, 1);
    feed.items[0].content_html = '<p>正文🙂\u2028\u2029</p>';
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(streamResponse(JSON.stringify(feed), 200, 1));
    expect(
      (await client().fetchListedArticles(listed, listed.name)).articles[0]
        .contentHtml,
    ).toContain('正文🙂');
  });
  it.each(['headers', 'body'])(
    'enforces the same deadline while waiting for %s',
    async (stage) => {
      const abort = new AbortController();
      jest.spyOn(AbortSignal, 'timeout').mockReturnValue(abort.signal);
      const cancel = jest.fn();
      const request = jest
        .spyOn(global, 'fetch')
        .mockImplementation(async () => {
          if (stage === 'headers') {
            queueMicrotask(() => abort.abort());
            return new Promise<Response>(() => {});
          }
          return new Response(
            new ReadableStream(
              {
                pull() {
                  abort.abort();
                },
                cancel,
              },
              { highWaterMark: 0 },
            ),
          );
        });
      await expect(
        client().fetchListedArticles(listed, listed.name),
      ).rejects.toThrow('WECHAT2RSS_REQUEST_TIMEOUT');
      expect(AbortSignal.timeout).toHaveBeenCalledWith(10000);
      expect(request).toHaveBeenCalledTimes(1);
      if (stage === 'body') expect(cancel).toHaveBeenCalledTimes(1);
    },
  );
  it('retains bounded network and encoding categories without the raw exception', async () => {
    const request = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(Error('http://private/?k=synthetic-secret'));
    await expect(
      client().fetchListedArticles(listed, listed.name),
    ).rejects.toThrow(/^WECHAT2RSS_NETWORK_ERROR$/);
    request.mockResolvedValue(new Response(new Uint8Array([255])));
    await expect(
      client().fetchListedArticles(listed, listed.name),
    ).rejects.toThrow(/^WECHAT2RSS_INVALID_ENCODING$/);
  });
  it('checks elapsed time between chunks even before an abort timer can run', async () => {
    let now = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const cancel = jest.fn(),
      pull = jest.fn((controller) => {
        now += 11000;
        controller.enqueue(new Uint8Array([32]));
      });
    const request = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(
          new ReadableStream({ pull, cancel }, { highWaterMark: 0 }),
        ),
      );
    await expect(
      client().fetchListedArticles(listed, listed.name),
    ).rejects.toThrow('WECHAT2RSS_REQUEST_TIMEOUT');
    expect(pull).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('retains per-body and per-feed item rejection instead of dropping articles', async () => {
    const feed = largeFeed();
    feed.items = feed.items.slice(0, 1);
    feed.items[0].content_html = 'x'.repeat(2_000_001);
    const request = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(streamResponse(JSON.stringify(feed)));
    await expect(
      client().fetchListedArticles(listed, listed.name),
    ).rejects.toThrow('WECHAT2RSS_BODY_TOO_LARGE');
    // Keep the item-count fixture below the transport limit so it exercises the parser.
    request.mockResolvedValue(
      streamResponse(
        JSON.stringify({
          items: Array(1001).fill({
            ...feed.items[0],
            content_html: '<p>body</p>',
          }),
        }),
      ),
    );
    await expect(
      client().fetchListedArticles(listed, listed.name),
    ).rejects.toThrow('WECHAT2RSS_FEED_TOO_LARGE');
  });
});
