import * as http from 'node:http';
import https from 'node:https';
import { AddressInfo } from 'node:net';
import {
  createRedbookHttpTransport,
  createRedbookMediaHttpTransport,
} from './redbook-http';
import { RedbookClient, RedbookRequest } from './redbook-client';

// ONLY this spec reroutes the native https socket to a synthetic loopback server.
// Production transport has no host/baseURL/injected-fetch configuration.
describe('fixed-target Redbook native HTTP transport (loopback fixtures)', () => {
  let server: http.Server;
  let bridge: jest.SpyInstance;
  let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  let calls: { url: URL; options: https.RequestOptions }[];
  beforeEach(async () => {
    calls = [];
    handler = (_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ success: true, data: { notes: [] } }));
    };
    server = http.createServer((req, res) => handler(req, res));
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    bridge = jest.spyOn(https, 'request').mockImplementation(((
      url: URL,
      options: https.RequestOptions,
      callback: (r: http.IncomingMessage) => void,
    ) => {
      calls.push({ url, options });
      const port = (server.address() as AddressInfo).port;
      return http.request(
        `http://127.0.0.1:${port}${url.pathname}${url.search}`,
        options,
        callback,
      );
    }) as typeof https.request);
  });
  afterEach(async () => {
    bridge.mockRestore();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const req = (overrides: Partial<RedbookRequest> = {}): RedbookRequest => ({
    url: 'https://edith.xiaohongshu.com/api/sns/web/v2/user_posted',
    method: 'GET',
    headers: {},
    redirect: 'error',
    timeoutMs: 1000,
    maxResponseBytes: 10000,
    ...overrides,
  });
  it('uses the fixed signed request with no proxy or pooled retry agent', async () => {
    const client = new RedbookClient({
      transport: createRedbookHttpTransport(),
      cookies: () => ({ a1: 'synthetic', web_session: 'synthetic' }),
    });
    expect(await client.getUserNotes('author')).toEqual({ notes: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0].url.hostname).toBe('edith.xiaohongshu.com');
    expect(calls[0].options.agent).toBe(false);
    expect(calls[0].options.headers).toHaveProperty('x-s');
  });
  it.each([
    'http://edith.xiaohongshu.com/api/sns/web/v2/user_posted',
    'https://evil.test/api/sns/web/v2/user_posted',
    'https://edith.xiaohongshu.com:443/api/sns/web/v2/user_posted',
    'https://edith.xiaohongshu.com/api/sns/web/v1/user_posted',
    'https://127.0.0.1/api/sns/web/v2/user_posted',
  ])('rejects unsupported target %s before socket', async (url) => {
    await expect(createRedbookHttpTransport()(req({ url }))).rejects.toThrow(
      'REDBOOK_HTTP_TARGET',
    );
    expect(calls).toHaveLength(0);
  });
  it.each([301, 406, 429, 471])(
    'returns HTTP %s once without following or retrying',
    async (status) => {
      handler = (_req, res) => {
        res.writeHead(status, {
          location: 'https://evil.test',
          'content-type': 'text/html',
        });
        res.end('secret upstream');
      };
      const client = new RedbookClient({
        transport: createRedbookHttpTransport(),
        cookies: () => ({ a1: 'synthetic', web_session: 'synthetic' }),
      });
      await expect(client.getUserNotes('author')).rejects.toThrow(
        'Redbook scan paused:',
      );
      expect(calls).toHaveLength(1);
    },
  );
  it('bounds both declared and chunked responses and rejects HTML', async () => {
    handler = (_req, res) => {
      res.setHeader('content-length', '10001');
      res.end('x');
    };
    await expect(createRedbookHttpTransport()(req())).rejects.toThrow(
      'REDBOOK_HTTP_SIZE',
    );
    handler = (_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.write('x'.repeat(10001));
      res.end();
    };
    await expect(createRedbookHttpTransport()(req())).rejects.toThrow(
      'REDBOOK_HTTP_SIZE',
    );
    handler = (_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('private');
    };
    await expect(createRedbookHttpTransport()(req())).rejects.toThrow(
      'REDBOOK_HTTP_CONTENT_TYPE',
    );
  });
  it('enforces absolute timeout and abort without a second request', async () => {
    handler = () => undefined;
    await expect(
      createRedbookHttpTransport()(req({ timeoutMs: 30 })),
    ).rejects.toThrow('REDBOOK_HTTP_TIMEOUT');
    const controller = new AbortController();
    controller.abort();
    await expect(
      createRedbookHttpTransport(controller.signal)(req()),
    ).rejects.toThrow('REDBOOK_HTTP_ABORTED');
    expect(calls).toHaveLength(1);
  });
  it('media has only accept, no account headers, and caps actual bytes', async () => {
    const transport = createRedbookMediaHttpTransport();
    const options = {
      redirect: 'manual' as const,
      credentials: 'omit' as const,
      headers: { accept: 'image/png' },
      signal: AbortSignal.timeout(2000),
    };
    handler = (_req, res) => {
      res.setHeader('content-type', 'image/png');
      res.end(Buffer.from([1, 2, 3]));
    };
    expect(
      await (
        await transport(
          new URL('https://sns-webpic-qc.xhscdn.com/synthetic'),
          options,
        )
      ).arrayBuffer(),
    ).toEqual(Uint8Array.from([1, 2, 3]).buffer);
    expect(calls[0].options.headers).toEqual({ accept: 'image/png' });
    await expect(
      transport(new URL('https://sns-webpic-qc.xhscdn.com/synthetic'), {
        ...options,
        headers: { accept: 'image/png', cookie: 'secret' },
      }),
    ).rejects.toThrow('REDBOOK_HTTP_MEDIA_HEADERS');
    expect(calls).toHaveLength(1);
    handler = (_req, res) => {
      res.write(Buffer.alloc(10_000_001));
      res.end();
    };
    await expect(
      transport(new URL('https://sns-webpic-qc.xhscdn.com/synthetic'), options),
    ).rejects.toThrow('REDBOOK_HTTP_SIZE');
  });
});
