import { Wechat2RssAccounts } from './wechat2rss-account';

// Synthetic PNG header only: these tests never create a real upstream session.
const png = Buffer.alloc(24);
Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
png.write('IHDR', 12);
png.writeUInt32BE(256, 16);
png.writeUInt32BE(256, 20);
const qrcode = `data:image/png;base64,${png.toString('base64')}`;
// Locally encoded 8x8 colour gradients, unrelated to login or authorization.
// Full JPEG files exercise real marker/scan structure instead of PNG-only mocks.
const jpeg =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDk9F8Ifd/d/pRRRRTm7FZXmWI+rrU//9k=';
const progressiveJpeg =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wgARCAAIAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAVAQEBAAAAAAAAAAAAAAAAAAAAAf/aAAwDAQACEAMQAAABkhf/xAAWEAADAAAAAAAAAAAAAAAAAAAAAwT/2gAIAQEAAQUCTIf/xAAXEQADAQAAAAAAAAAAAAAAAAAAAwQT/9oACAEDAQE/AZaWZn//xAAWEQADAAAAAAAAAAAAAAAAAAAAAQL/2gAIAQIBAT8Bln//xAAVEAEBAAAAAAAAAAAAAAAAAAAAMf/aAAgBAQAGPwKP/8QAFRABAQAAAAAAAAAAAAAAAAAAADH/2gAIAQEAAT8hmf/aAAwDAQACAAMAAAAQA//EABYRAAMAAAAAAAAAAAAAAAAAAAARIf/aAAgBAwEBPxBBT//EABYRAAMAAAAAAAAAAAAAAAAAAAABEf/aAAgBAgEBPxBsP//EABUQAQEAAAAAAAAAAAAAAAAAAADx/9oACAEBAAE/EIj/2Q==';
const config = {
  enabled: true,
  baseUrl: 'http://127.0.0.1:18080/',
  token: 'synthetic-secret',
};
const reply = (data: unknown, cookie = 'login=synthetic-cookie; HttpOnly') =>
  new Response(JSON.stringify({ err: '', data }), {
    headers: cookie ? { 'set-cookie': cookie } : {},
  });
function fixture() {
  let now = 0;
  const queue: (Response | Error | Promise<Response>)[] = [];
  const requests: { url: string; options: RequestInit }[] = [];
  const fetcher = jest.fn(async (input: URL, options: RequestInit) => {
    requests.push({ url: String(input), options });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    if (!next) throw Error('UNEXPECTED_REAL_REQUEST');
    return next;
  });
  const manager = new Wechat2RssAccounts(
    () => config,
    fetcher as unknown as typeof fetch,
    () => now,
  );
  return {
    manager,
    queue,
    requests,
    advance: (ms = 3000) => {
      now += ms;
    },
  };
}

describe('Wechat2RSS official cookie login proxy (offline)', () => {
  let log: jest.SpyInstance;
  beforeEach(() => {
    log = jest.spyOn(console, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => log.mockRestore());

  it.each([
    ['jpeg', jpeg],
    ['jpg', jpeg],
    ['jpeg', progressiveJpeg],
    ['jpg', progressiveJpeg],
    ['jpeg', jpeg.replace(/=+$/, '')],
  ])(
    'accepts the observed JPEG response contract (%s) without requesting its image',
    async (mime, encoded) => {
      const f = fixture();
      const image = `data:image/${mime};base64,${encoded}`;
      f.queue.push(
        new Response(
          JSON.stringify({ err: '', data: { isLogin: false, qrcode: image } }),
          {
            headers: {
              'content-type': 'application/json',
              'set-cookie': 'login=synthetic-cookie; HttpOnly',
            },
          },
        ),
      );
      const result = await f.manager.start();
      expect(result.state).toBe('waiting');
      expect(result.qrcode).toBe(
        `data:image/jpeg;base64,${Buffer.from(encoded, 'base64').toString('base64')}`,
      );
      expect(f.requests).toHaveLength(1);
      expect(log.mock.calls.flat().join(' ')).not.toContain(encoded);
      f.advance();
      f.queue.push(reply({ isLogin: false, qrcode: '' }));
      expect((await f.manager.poll(result.sessionId!)).qrcode).toBe(
        result.qrcode,
      );
      f.manager.close(result.sessionId!);
      expect((await f.manager.poll(result.sessionId!)).state).toBe('expired');
      expect(f.requests).toHaveLength(2);
    },
  );

  it.each([
    'https://example.com/qr.jpg',
    '/qr.jpg',
    'data:image/svg+xml;base64,PHN2Zy8+',
    `data:image/jpeg;base64,${png.toString('base64')}`,
    'data:image/jpeg;base64,/9j/AAAA/9k=',
    `data:image/jpeg;base64,${jpeg.slice(0, -8)}`,
    `data:image/jpeg;base64,${jpeg}\n`,
  ])(
    'rejects unsupported or malformed QR images without leaking them',
    async (image) => {
      const f = fixture();
      f.queue.push(reply({ qrcode: image }));
      const result = await f.manager.start();
      expect(result.state).toBe('failed');
      expect(result.code).toMatch(/^QR_/);
      expect(result.qrcode).toBeUndefined();
      expect(log.mock.calls.flat().join(' ')).not.toContain(image);
      expect(f.requests).toHaveLength(1);
    },
  );

  it.each([0, 2049])(
    'rejects JPEG dimension %s even when the file has valid magic',
    async (size) => {
      const bytes = Buffer.from(jpeg, 'base64');
      const frame = bytes.indexOf(Buffer.from([0xff, 0xc0]));
      expect(frame).toBeGreaterThan(0);
      bytes.writeUInt16BE(size, frame + 7);
      const f = fixture();
      f.queue.push(
        reply({ qrcode: `data:image/jpeg;base64,${bytes.toString('base64')}` }),
      );
      const result = await f.manager.start();
      expect(result.state).toBe('failed');
      expect(result.code).toBe('QR_JPEG_INVALID');
    },
  );

  it('rejects malformed JPEG segment length before decoding', async () => {
    const bytes = Buffer.from(jpeg, 'base64');
    bytes.writeUInt16BE(65535, 4);
    const f = fixture();
    f.queue.push(
      reply({ qrcode: `data:image/jpeg;base64,${bytes.toString('base64')}` }),
    );
    expect((await f.manager.start()).code).toBe('QR_JPEG_INVALID');
  });

  it('rejects a second frame or trailing bytes after otherwise valid JPEG content', async () => {
    const bytes = Buffer.from(jpeg, 'base64');
    const frame = bytes.indexOf(Buffer.from([0xff, 0xc0]));
    const frameLength = bytes.readUInt16BE(frame + 2) + 2;
    for (const malformed of [
      Buffer.concat([
        bytes.subarray(0, -2),
        bytes.subarray(frame, frame + frameLength),
        bytes.subarray(-2),
      ]),
      Buffer.concat([bytes, Buffer.from([0])]),
    ]) {
      const f = fixture();
      f.queue.push(
        reply({
          qrcode: `data:image/jpeg;base64,${malformed.toString('base64')}`,
        }),
      );
      expect((await f.manager.start()).code).toBe('QR_JPEG_INVALID');
    }
  });

  it.each([undefined, null, ''])(
    'accepts optional success err %s and QR-only initial data',
    async (err) => {
      const f = fixture();
      f.queue.push(
        new Response(JSON.stringify({ err, data: { qrcode } }), {
          headers: {
            'set-cookie': 'login=synthetic-cookie',
            'content-type': 'application/json',
          },
        }),
      );
      const first = await f.manager.start();
      expect(first.state).toBe('waiting');
      expect(first.qrcode).toBe(qrcode);
      expect(first.message).toContain('等待微信扫码或确认');
      for (const data of [{}, { qrcode: '' }, { isLogin: false }]) {
        f.advance();
        f.queue.push(new Response(JSON.stringify({ data })));
        expect((await f.manager.poll(first.sessionId!)).qrcode).toBe(qrcode);
        expect(f.requests.at(-1)!.options.headers).toEqual({
          Cookie: 'login=synthetic-cookie',
        });
      }
      f.advance();
      f.queue.push(new Response(JSON.stringify({ data: { isLogin: true } })));
      expect((await f.manager.poll(first.sessionId!)).state).toBe('succeeded');
      expect(f.requests).toHaveLength(5);
    },
  );
  it('keeps the same cookie while an optional data response waits for a QR', async () => {
    const f = fixture();
    f.queue.push(
      new Response('{}', {
        headers: { 'set-cookie': 'login=synthetic-cookie' },
      }),
    );
    const first = await f.manager.start();
    expect(first.state).toBe('waiting');
    expect(first.qrcode).toBeUndefined();
    f.advance();
    f.queue.push(new Response(JSON.stringify({ data: { qrcode } })));
    expect((await f.manager.poll(first.sessionId!)).qrcode).toBe(qrcode);
    expect(f.requests[1].options.headers).toEqual({
      Cookie: 'login=synthetic-cookie',
    });
  });
  it('keeps null waiting fields within the same bounded cookie session', async () => {
    const f = fixture();
    f.queue.push(reply({ isLogin: null, qrcode: null }));
    const first = await f.manager.start();
    expect(first.state).toBe('waiting');
    expect(first.qrcode).toBeUndefined();
    f.advance();
    f.queue.push(reply({ qrcode }));
    expect((await f.manager.poll(first.sessionId!)).qrcode).toBe(qrcode);
    expect(f.requests[1].options.headers).toEqual({
      Cookie: 'login=synthetic-cookie',
    });
  });
  it.each([
    [
      new Response('<html>private-url-token</html>', {
        headers: { 'content-type': 'text/html' },
      }),
      'INVALID_JSON',
    ],
    [new Response('private-url-token', { status: 503 }), 'HTTP_FAILED'],
    [
      new Response(JSON.stringify({ err: 'private-url-token', data: {} })),
      'UPSTREAM_REJECTED',
    ],
    [reply({ isLogin: 'true', qrcode }), 'LOGIN_REPLY_INVALID'],
  ])(
    'reports the initial response stage and only fixed safe metadata',
    async (response, code) => {
      const f = fixture();
      f.queue.push(response);
      const result = await f.manager.start();
      expect(result).toMatchObject({ state: 'failed', phase: 'create', code });
      expect(result.message).toContain('二维码获取停止');
      const logs = JSON.stringify(log.mock.calls);
      expect(logs).toContain('create');
      expect(logs).not.toMatch(
        /private-url-token|synthetic-secret|synthetic-cookie|127\.0\.0\.1/,
      );
      expect(logs).not.toContain(qrcode);
      expect(result.message).not.toContain('风控');
      expect(f.requests).toHaveLength(1);
    },
  );
  it('distinguishes polling failure from QR creation and stops further polling', async () => {
    const f = fixture();
    f.queue.push(reply({ qrcode }));
    const first = await f.manager.start();
    f.advance();
    f.queue.push(new Response(JSON.stringify({ err: 'private-cookie-error' })));
    const failed = await f.manager.poll(first.sessionId!);
    expect(failed).toMatchObject({
      state: 'failed',
      phase: 'poll',
      code: 'UPSTREAM_REJECTED',
    });
    expect(failed.message).toContain('登录状态查询停止');
    expect(failed.qrcode).toBeUndefined();
    f.advance();
    await f.manager.poll(first.sessionId!);
    expect(f.requests).toHaveLength(2);
    const logs = JSON.stringify(log.mock.calls);
    expect(logs).not.toContain(first.sessionId!);
    expect(logs).not.toMatch(
      /private-cookie-error|synthetic-cookie|synthetic-secret/,
    );
    expect(logs).not.toContain(qrcode);
  });
  it.each([
    'login=; HttpOnly',
    'login=expired; Max-Age=0',
    'login=expired; Max-Age=-1',
    'login=expired; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ])(
    'stops a waiting login after an upstream cookie is cleared: %s',
    async (cookie) => {
      const f = fixture();
      f.queue.push(reply({ isLogin: false, qrcode }, cookie));
      const initial = await f.manager.start();
      expect(initial.state).toBe('failed');
      f.advance();
      await f.manager.poll(initial.sessionId || 'already-closed');
      expect(f.requests).toHaveLength(1);
    },
  );
  it('accepts confirmed success when upstream clears its login cookie', async () => {
    const f = fixture();
    f.queue.push(reply({ isLogin: true, qrcode: '' }, 'login=; Max-Age=0'));
    expect((await f.manager.start()).state).toBe('succeeded');
    expect(f.requests).toHaveLength(1);
  });
  it('does no request on construction; invalid public configuration fails closed', async () => {
    const f = fixture();
    expect(f.requests).toHaveLength(0);
    for (const baseUrl of [
      'https://example.com/',
      'http://127.0.0.1/path',
      'http://127.0.0.1/?k=secret',
    ]) {
      const request = jest.fn();
      const manager = new Wechat2RssAccounts(
        () => ({ ...config, baseUrl }),
        request,
      );
      expect((await manager.start()).state).toBe('unavailable');
      expect(request).not.toHaveBeenCalled();
    }
  });
  it('polls exactly /login/new with the server cookie and never leaks token/cookies', async () => {
    const f = fixture();
    f.queue.push(reply({ isLogin: false, qrcode }));
    const initial = await f.manager.start();
    expect(initial.state).toBe('waiting');
    expect(JSON.stringify(initial)).not.toMatch(
      /synthetic-secret|synthetic-cookie/,
    );
    expect((await f.manager.start()).state).toBe('busy');
    await f.manager.poll(initial.sessionId!);
    expect(f.requests).toHaveLength(1);
    f.advance();
    f.queue.push(
      reply({ isLogin: false, qrcode: '' }, 'login=rotated; HttpOnly'),
    );
    expect((await f.manager.poll(initial.sessionId!)).qrcode).toBe(qrcode);
    expect(f.requests[1].options.headers).toEqual({
      Cookie: 'login=synthetic-cookie',
    });
    expect(
      f.requests.every((r) => new URL(r.url).pathname === '/login/new'),
    ).toBe(true);
    expect(f.requests.every((r) => r.options.redirect === 'manual')).toBe(true);
    f.advance();
    f.queue.push(reply({ isLogin: true }, ''));
    const success = await f.manager.poll(initial.sessionId!);
    expect(success).toEqual({
      state: 'succeeded',
      message: 'Wechat2RSS 登录成功。',
    });
    expect(f.requests[2].options.headers).toEqual({ Cookie: 'login=rotated' });
    await f.manager.poll(initial.sessionId!);
    expect(f.requests).toHaveLength(3);
  });
  it('waits for a QR using the received cookie instead of creating another login', async () => {
    const f = fixture();
    f.queue.push(reply({ isLogin: false, qrcode: '' }));
    const initial = await f.manager.start();
    expect(initial.state).toBe('waiting');
    expect(initial.qrcode).toBeUndefined();
    f.advance();
    f.queue.push(reply({ isLogin: false, qrcode }));
    expect((await f.manager.poll(initial.sessionId!)).qrcode).toBe(qrcode);
    expect(f.requests[1].options.headers).toEqual({
      Cookie: 'login=synthetic-cookie',
    });
  });
  it.each([
    [{ isLogin: false, qrcode }, ''],
    [{ isLogin: false, qrcode: 'https://example.com/qr.svg' }, 'login=x'],
    [{ isLogin: false, qrcode: 'data:image/png;base64,YmFk' }, 'login=x'],
    [{ isLogin: 1, qrcode }, 'login=x'],
    [{ isLogin: false, qrcode }, 'login=bad,value'],
  ])(
    'rejects invalid QR/envelope/cookie without inventing polling endpoints',
    async (data, cookie) => {
      const f = fixture();
      f.queue.push(reply(data, cookie));
      expect((await f.manager.start()).state).toBe('failed');
      expect(f.requests).toHaveLength(1);
    },
  );
  it('expiry and close terminate polling without any upstream refresh/delete action', async () => {
    const f = fixture();
    f.queue.push(reply({ isLogin: false, qrcode }));
    const first = await f.manager.start();
    f.advance(180_000);
    expect((await f.manager.poll(first.sessionId!)).state).toBe('expired');
    f.queue.push(reply({ isLogin: false, qrcode }));
    const second = await f.manager.start();
    f.manager.close(second.sessionId!);
    f.advance();
    expect((await f.manager.poll(second.sessionId!)).state).toBe('expired');
    expect(f.requests).toHaveLength(2);
  });
  it('close during an in-flight poll cannot resurrect the login or retained QR', async () => {
    const f = fixture();
    f.queue.push(reply({ isLogin: false, qrcode }));
    const initial = await f.manager.start();
    f.advance();
    let resolve!: (response: Response) => void;
    f.queue.push(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const polling = f.manager.poll(initial.sessionId!);
    await Promise.resolve();
    f.manager.close(initial.sessionId!);
    resolve(reply({ isLogin: false, qrcode }, 'login=new-secret'));
    expect(await polling).toEqual({
      state: 'closed',
      message: '已停止本次登录。',
    });
    expect((await f.manager.poll(initial.sessionId!)).state).toBe('expired');
  });
  it('safe errors do not forward private URLs, raw err or token', async () => {
    const f = fixture();
    f.queue.push(new Error('http://127.0.0.1/?k=synthetic-secret'));
    expect(JSON.stringify(await f.manager.start())).not.toMatch(
      /synthetic-secret|127.0.0.1/,
    );
    f.queue.push(
      new Response(JSON.stringify({ err: 'synthetic-secret', data: {} })),
    );
    expect((await f.manager.start()).state).toBe('failed');
  });
  it('account list returns only sanitized names/status; needCheck never means available', async () => {
    const f = fixture();
    f.queue.push(
      reply(
        [
          {
            id: 123456,
            name: '测试账号',
            available: true,
            needCheck: true,
            waitTime: '2026-10-10 12:00:00',
            token: 'do-not-return',
          },
          {
            name: config.token,
            available: true,
            needCheck: false,
            waitTime: 'secret-invalid',
          },
        ],
        '',
      ),
    );
    const result = await f.manager.list();
    expect(result.accounts[0]).toEqual({
      name: '测试账号',
      available: false,
      needCheck: true,
      waitTime: '2026-10-10 12:00:00',
    });
    expect(result.accounts[1].name).toBe('微信账号');
    expect(JSON.stringify(result)).not.toMatch(
      /123456|synthetic-secret|do-not-return/,
    );
    expect(new URL(f.requests[0].url).pathname).toBe('/login/list');
  });
  it('list transport failure exposes no stale accounts', async () => {
    const f = fixture();
    f.queue.push(new Error('private error'));
    const result = await f.manager.list();
    expect(result.code).toBe('STATUS_CHECK_FAILED');
    expect(result.accounts).toEqual([]);
  });
});
