const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { waitReady } = require('./switch.cjs');

const code = 'test-only-private-code-24-characters';
const cookie = `wewe_private_session=1999999999.${'a'.repeat(32)}.${'b'.repeat(64)}`;

// A free OS-assigned port may still be forbidden by Node's Fetch port policy.
// Probe only this synthetic server; rebind only on that exact policy rejection.
async function listenForFetch(server, probe = fetch) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;
    const port = server.address().port;
    try {
      const response = await probe(`http://127.0.0.1:${port}/dash/login`, {
        redirect: 'manual',
        // This test-only probe includes the first Fetch initialization on cold
        // Windows runners. Production readiness deadlines stay unchanged.
        signal: AbortSignal.timeout(10000),
      });
      await response.arrayBuffer();
      return port;
    } catch (error) {
      await new Promise((resolve) => server.close(resolve));
      if (error.cause?.message !== 'bad port') throw error;
    }
  }
  throw new Error('No Fetch-compatible synthetic readiness port after 8 binds');
}

test('synthetic readiness rebinds an OS-assigned Fetch-forbidden port', async () => {
  let probes = 0;
  let closes = 0;
  const server = http.createServer((_req, res) => res.end('synthetic shell'));
  server.on('close', () => closes++);
  try {
    const port = await listenForFetch(server, (url, options) => {
      probes++;
      if (probes === 1)
        throw new TypeError('fetch failed', { cause: new Error('bad port') });
      return fetch(url, options);
    });
    assert.equal(server.address().address, '127.0.0.1');
    assert.equal(server.address().port, port);
    assert.ok(probes >= 2);
    assert.equal(closes, probes - 1);
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
});

for (const [name, denied] of [
  [
    'permission',
    Object.assign(new Error('synthetic permission failure'), {
      code: 'EACCES',
    }),
  ],
  ['timeout', new DOMException('synthetic timeout', 'TimeoutError')],
])
  test(`synthetic readiness preserves ${name} failures without retrying`, async () => {
    let probes = 0;
    const server = http.createServer((_req, res) => res.end('synthetic shell'));
    await assert.rejects(
      listenForFetch(server, () => {
        probes++;
        throw denied;
      }),
      (error) => error === denied,
    );
    assert.equal(probes, 1);
    assert.equal(server.listening, false);
  });

test('synthetic readiness limits forbidden-port rebinds and closes each listener', async () => {
  let probes = 0;
  let closes = 0;
  const server = http.createServer((_req, res) => res.end('synthetic shell'));
  server.on('close', () => closes++);
  await assert.rejects(
    listenForFetch(server, () => {
      probes++;
      throw new TypeError('fetch failed', { cause: new Error('bad port') });
    }),
    /after 8 binds/,
  );
  assert.equal(probes, 8);
  assert.equal(closes, 8);
  assert.equal(server.listening, false);
});

async function fixture(options, verify) {
  const count = options.rssItems || 20;
  const responseRss = `<rss><channel>${'<item></item>'.repeat(count)}</channel></rss>`;
  const previous = {
    PRIVATE_ONLINE_MODE: process.env.PRIVATE_ONLINE_MODE,
    AUTH_CODE: process.env.AUTH_CODE,
  };
  process.env.PRIVATE_ONLINE_MODE = options.privateMode ? '1' : '0';
  if (options.missingCode) delete process.env.AUTH_CODE;
  else process.env.AUTH_CODE = code;
  const calls = { login: 0, anonymous: 0, authenticated: 0 };
  const server = http.createServer(async (req, res) => {
    if (req.url === '/dash') {
      if (options.privateMode) {
        res.writeHead(302, { Location: '/dash/login' });
        return res.end();
      }
      return res.end('dashboard');
    }
    if (req.url === '/dash/login') return res.end('login shell');
    if (req.url === '/auth/login') {
      calls.login++;
      let body = '';
      for await (const part of req) body += part;
      assert.equal(req.method, 'POST');
      assert.equal(JSON.parse(body).code, code);
      assert.equal(req.headers['content-type'], 'application/json');
      if (options.rejectLogin) {
        res.writeHead(401);
        return res.end(code + cookie);
      }
      if (options.loginRedirect) {
        res.writeHead(302, { Location: '/capture' });
        return res.end();
      }
      res.writeHead(
        204,
        options.missingCookie
          ? {}
          : {
              'Set-Cookie':
                cookie + '; Path=/; HttpOnly; Secure; SameSite=Strict',
            },
      );
      return res.end();
    }
    assert.equal(
      req.url,
      `/feeds/MP_WXS_3895431412.rss?limit=${count}&mode=summary`,
    );
    if (req.headers.cookie) {
      calls.authenticated++;
      assert.equal(req.headers.cookie, cookie);
      if (options.rejectSession) {
        res.writeHead(401);
        return res.end(cookie);
      }
      return res.end(
        options.fewerItems
          ? responseRss.replace('<item></item>', '')
          : responseRss,
      );
    }
    calls.anonymous++;
    if (options.privateMode && !options.publicLeak) {
      res.writeHead(401);
      return res.end('Login required');
    }
    return res.end(responseRss);
  });
  try {
    const port = await listenForFetch(server);
    await verify(port, calls);
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
}

test('private readiness requires anonymous denial, authenticates in memory and verifies 20 RSS items', async () => {
  await fixture({ privateMode: true }, async (port, calls) => {
    await waitReady(port, { exitCode: null }, 3);
    assert.deepEqual(calls, { login: 1, anonymous: 1, authenticated: 1 });
  });
});

test('ordinary readiness keeps the original unauthenticated RSS check', async () => {
  await fixture({ privateMode: false }, async (port, calls) => {
    await waitReady(port, { exitCode: null }, 3);
    assert.deepEqual(calls, { login: 0, anonymous: 1, authenticated: 0 });
  });
});

test('accepted-package cold readiness still requires private denial, login and one real RSS item', async () => {
  await fixture({ privateMode: true, rssItems: 1 }, async (port, calls) => {
    await waitReady(port, { exitCode: null }, 3, 50, 1);
    assert.deepEqual(calls, { login: 1, anonymous: 1, authenticated: 1 });
  });
});

test('one-item cold readiness cannot weaken private denial', async () => {
  await fixture(
    { privateMode: true, rssItems: 1, publicLeak: true },
    async (port) => {
      await assert.rejects(waitReady(port, { exitCode: null }, 3, 50, 1));
    },
  );
});

test('one-item cold readiness rejects missing data', async () => {
  await fixture(
    { privateMode: true, rssItems: 1, fewerItems: true },
    async (port) => {
      await assert.rejects(waitReady(port, { exitCode: null }, 0.2, 50, 1));
    },
  );
});

for (const [option, message] of [
  ['rejectLogin', '登录失败'],
  ['missingCookie', '有效会话'],
  ['publicLeak', '匿名 RSS'],
  ['rejectSession', '未获授权'],
  ['missingCode', 'AUTH_CODE'],
  ['loginRedirect', '登录失败'],
])
  test(`private readiness fails safely on ${option}`, async () => {
    await fixture(
      { privateMode: true, [option]: true },
      async (port, calls) => {
        await assert.rejects(
          waitReady(port, { exitCode: null }, 3),
          (error) => {
            assert.match(error.message, new RegExp(message));
            assert.ok(!error.stack.includes(code));
            assert.ok(!error.stack.includes(cookie));
            return true;
          },
        );
        if (option === 'publicLeak' || option === 'missingCode')
          assert.equal(calls.login, 0);
      },
    );
  });

test('authenticated readiness still requires exactly 20 RSS items', async () => {
  await fixture(
    { privateMode: true, fewerItems: true },
    async (port, calls) => {
      await assert.rejects(
        waitReady(port, { exitCode: null }, 0.2),
        /RSS 冒烟超时/,
      );
      assert.equal(calls.login, 1);
      assert.ok(calls.authenticated >= 1);
    },
  );
});
