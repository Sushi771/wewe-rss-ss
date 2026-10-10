import { Wechat2RssAccounts } from './wechat2rss-account';

// Synthetic PNG header only: these tests never create a real upstream session.
const png = Buffer.alloc(24);
Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
png.write('IHDR', 12);
png.writeUInt32BE(256, 16);
png.writeUInt32BE(256, 20);
const qrcode = `data:image/png;base64,${png.toString('base64')}`;
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
    [{ qrcode }, 'login=x'],
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
