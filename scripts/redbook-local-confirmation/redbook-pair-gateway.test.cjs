'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  { randomBytes } = require('node:crypto'),
  fs = require('node:fs');
const {
  PairAuthority,
  ACCESS_MS,
  PAIR_MS,
  directLocal,
  gateway,
} = require('./redbook-pair-gateway.cjs');
const proof = () => randomBytes(32).toString('base64url');
test('desktop approval is required; no anonymous token; exact browser proof and one redeem', async () => {
  const a = new PairAuthority();
  const p = proof(),
    s = a.start(p);
  assert.deepEqual(a.redeem(s.pairId, p), { waiting: true });
  assert.equal(a.approve('not-code'), false);
  assert.throws(() => a.redeem(s.pairId, proof()));
  assert.equal(a.approve(s.comparison), true);
  assert.equal(a.approve(s.comparison), false);
  const access = a.redeem(s.pairId, p);
  assert.equal(Buffer.from(access.token, 'base64url').length, 32);
  assert.equal(a.authorize(access.token, p).expiresAt, access.expiresAt);
  assert.throws(() => a.authorize(access.token, proof()));
  assert.throws(() => a.redeem(s.pairId, p));
  assert.throws(() => a.start(proof()));
  await a.revoke();
  assert.throws(() => a.authorize(access.token, p));
});
test('24 hour absolute expiry does not slide; monotonic deadline prevents clock rollback extension', async () => {
  let wall = 100000,
    mono = 0,
    cancelled = 0;
  const a = new PairAuthority({
    clock: () => wall,
    monotonic: () => mono,
    onRevoke: async () => {
      cancelled++;
    },
  });
  const p = proof(),
    pair = a.start(p);
  a.approve(pair.comparison);
  const access = a.redeem(pair.pairId, p);
  assert.equal(access.expiresAt, wall + ACCESS_MS);
  wall += ACCESS_MS - 1;
  mono += ACCESS_MS - 1;
  assert.equal(a.authorize(access.token, p).expiresAt, access.expiresAt);
  wall = 0;
  mono++;
  assert.throws(() => a.authorize(access.token, p));
  await a.revoke();
  assert.equal(cancelled, 1);
  const other = new PairAuthority();
  assert.throws(() => other.authorize(access.token, p));
  await other.revoke();
});
test('pending comparison expires and cannot be approved or redeemed later', async () => {
  let now = 1;
  const a = new PairAuthority({ clock: () => now, monotonic: () => now });
  const p = proof(),
    pair = a.start(p);
  now += PAIR_MS;
  assert.equal(a.approve(pair.comparison), false);
  assert.throws(() => a.redeem(pair.pairId, p));
  await a.revoke();
});
test('comparison is limited to three wrong owner attempts and remains useless over HTTP', async () => {
  const a = new PairAuthority();
  const p = proof(),
    pair = a.start(p);
  const wrong = pair.comparison === '000000' ? '111111' : '000000';
  for (let i = 0; i < 3; i++) assert.equal(a.approve(wrong), false);
  assert.equal(a.approve(pair.comparison), false);
  assert.throws(() => a.redeem(pair.pairId, p));
  await a.revoke();
});
test('socket / raw Host / Origin / any forwarding header fail closed', () => {
  const req = (headers = {}, address = '127.0.0.1') => ({
    socket: { remoteAddress: address },
    headers: {
      host: '127.0.0.1:49163',
      origin: 'http://127.0.0.1:49163',
      ...headers,
    },
  });
  assert.equal(directLocal(req(), 49163), true);
  for (const header of [
    'forwarded',
    'via',
    'x-forwarded-for',
    'x-forwarded-port',
    'x-forwarded-path',
    'x-forwarded-prefix',
    'X-Forwarded-Unknown',
  ])
    assert.equal(directLocal(req({ [header]: 'x' }), 49163), false);
  for (const host of [
    'evil@localhost:49163',
    '127.0.0.1:49163/path',
    '127.0.0.1:49163?x',
    '127.0.0.1:49163#x',
    '127.0.0.1:4000',
  ])
    assert.equal(directLocal(req({ host }), 49163), false);
  assert.equal(directLocal(req({}, '203.0.113.1'), 49163), false);
  assert.equal(directLocal(req({ origin: 'http://evil.test' }), 49163), false);
  assert.equal(directLocal(req({ origin: undefined }), 49163), false);
});
async function fixture(t, { clock, backend: provided } = {}) {
  const calls = [];
  let frontendLeaks = [];
  const backend =
    provided ||
    (async (action, body, signal) => {
      calls.push({ action, body, signal });
      if (action === 'creator') return { creator: { id: 'synthetic-creator' } };
      return {
        configured: action === 'session',
        notes: [{ noteId: 'synthetic-note' }],
        archiveAllowed: false,
      };
    });
  const s = gateway({
    port: 0,
    clock,
    backend,
    html: '<p>pair only</p>',
    script: '/* no secret */',
  });
  await new Promise((resolve) => s.server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + s.server.address().port;
  t.after(async () => {
    await s.close();
  });
  const post = async (path, body = {}, headers = {}) => {
    const r = await fetch(origin + path, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const value = await r.json();
    frontendLeaks.push(value);
    return { status: r.status, value, headers: r.headers };
  };
  const confirm = async () => {
    const browser = proof(),
      pair = (await post('/pair/start', { proof: browser })).value;
    s.authority.approve(pair.comparison);
    const access = (
      await post('/pair/redeem', { pairId: pair.pairId, proof: browser })
    ).value;
    return {
      headers: {
        authorization: 'Bearer ' + access.token,
        'x-redbook-browser-proof': browser,
      },
      access,
      browser,
    };
  };
  return { ...s, post, confirm, calls, origin, frontendLeaks };
}
test('anonymous shell contains no grant; forged HTTP approval and all formal routes denied', async (t) => {
  const f = await fixture(t);
  const shell = await fetch(f.origin + '/pair');
  assert.equal(shell.status, 200);
  assert.equal(shell.headers.get('cache-control'), 'no-store');
  assert.match(
    shell.headers.get('content-security-policy'),
    /frame-ancestors 'none'/,
  );
  assert.equal((await f.post('/diagnostic/status')).status, 403);
  assert.equal(
    (await f.post('/pair/approve', { comparison: '000000' })).status,
    404,
  );
  const p = proof(),
    pair = (await f.post('/pair/start', { proof: p })).value;
  const waiting = await f.post('/pair/redeem', {
    pairId: pair.pairId,
    proof: p,
  });
  assert.equal(waiting.status, 202);
  assert.equal(waiting.value.token, undefined);
  await f.authority.revoke();
  const g = await f.confirm();
  for (const route of [
    '/diagnostic/review',
    '/local/redbook/session',
    '/local/redbook/resume-operator',
    '/trpc/xiaohongshu.refresh',
    '/auth/login',
    '/feeds',
    '/diagnostic/status?token=forbidden',
  ])
    assert.equal((await f.post(route, {}, g.headers)).status, 404);
  assert.equal(
    (
      await f.post(
        '/diagnostic/status',
        {},
        { ...g.headers, origin: 'http://evil.test' },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.post(
        '/diagnostic/status',
        {},
        { ...g.headers, 'x-forwarded-unknown': '1' },
      )
    ).status,
    403,
  );
  assert.equal(f.calls.length, 0);
});
test('only provisional creator / authorized 24 hour bounded XHS session / one list and detail / explicit <=2 images', async (t) => {
  const f = await fixture(t);
  const g = await f.confirm();
  assert.equal(
    (
      await f.post(
        '/diagnostic/creator',
        {
          displayName: 'Synthetic',
          profileUrl:
            'https://www.xiaohongshu.com/user/profile/synthetic-author',
        },
        g.headers,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.post(
        '/diagnostic/creator',
        {
          displayName: 'Other',
          profileUrl: 'https://www.xiaohongshu.com/user/profile/other',
        },
        g.headers,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await f.post(
        '/diagnostic/session',
        {
          cookies: { a1: 'synthetic', web_session: 'synthetic' },
          expiresAt: Date.now() + ACCESS_MS + 10000,
          confirmLocalSession: true,
        },
        g.headers,
      )
    ).status,
    422,
  );
  assert.equal(
    (
      await f.post(
        '/diagnostic/session',
        {
          creatorId: 'other',
          cookies: {},
          expiresAt: Date.now() + 10000,
          confirmLocalSession: true,
        },
        g.headers,
      )
    ).status,
    422,
  );
  assert.equal(
    (
      await f.post(
        '/diagnostic/session',
        {
          cookies: { a1: 'synthetic', web_session: 'synthetic' },
          expiresAt: Date.now() + 60000,
          confirmLocalSession: true,
        },
        g.headers,
      )
    ).status,
    200,
  );
  assert.equal(f.calls.at(-1).body.creatorId, 'synthetic-creator');
  assert.equal((await f.post('/diagnostic/list', {}, g.headers)).status, 422);
  assert.equal(
    (await f.post('/diagnostic/list', { confirmRequest: true }, g.headers))
      .status,
    200,
  );
  assert.equal(
    (await f.post('/diagnostic/list', { confirmRequest: true }, g.headers))
      .status,
    409,
  );
  assert.equal(
    (
      await f.post(
        '/diagnostic/detail',
        { confirmRequest: true, noteId: 'synthetic-note' },
        g.headers,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.post(
        '/diagnostic/detail',
        { confirmRequest: true, noteId: 'synthetic-note' },
        g.headers,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await f.post(
        '/diagnostic/images',
        { confirmImages: true, maxImages: 3, maxBytes: 1024 },
        g.headers,
      )
    ).status,
    422,
  );
  assert.equal(
    (
      await f.post(
        '/diagnostic/images',
        { confirmImages: true, maxImages: 1, maxBytes: 1000001 },
        g.headers,
      )
    ).status,
    422,
  );
  assert.equal(
    (
      await f.post(
        '/diagnostic/images',
        { confirmImages: true, maxImages: 2, maxBytes: 1000000 },
        g.headers,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.post(
        '/diagnostic/images',
        { confirmImages: true, maxImages: 2, maxBytes: 1000000 },
        g.headers,
      )
    ).status,
    409,
  );
  // A replacement Cookie session cannot silently reset the browser grant's request budget.
  assert.equal(
    (
      await f.post(
        '/diagnostic/session',
        {
          cookies: { a1: 'new-synthetic', web_session: 'new-synthetic' },
          expiresAt: Date.now() + 60000,
          confirmLocalSession: true,
        },
        g.headers,
      )
    ).status,
    200,
  );
  assert.equal(
    (await f.post('/diagnostic/list', { confirmRequest: true }, g.headers))
      .status,
    409,
  );
  assert.equal(f.calls.filter((c) => c.action === 'list').length, 1);
  assert.equal(f.calls.filter((c) => c.action === 'detail').length, 1);
});
test('first backend restriction spends budget with no fallback; errors never echo secret messages', async (t) => {
  const f = await fixture(t, {
    backend: async (action) => {
      if (action === 'discard') return {};
      throw Error('SECRET_ACCOUNT_TOKEN');
    },
  });
  const g = await f.confirm();
  const first = await f.post(
    '/diagnostic/list',
    { confirmRequest: true },
    g.headers,
  );
  assert.equal(first.status, 422);
  assert.doesNotMatch(JSON.stringify(first.value), /SECRET_ACCOUNT_TOKEN/);
  assert.equal(
    (await f.post('/diagnostic/list', { confirmRequest: true }, g.headers))
      .status,
    409,
  );
});
test('failed discard immediately revokes access, blocks new pairing, and only explicit cleanup retry clears latch', async (t) => {
  let rejectCleanup = true,
    cleanups = 0;
  const f = await fixture(t, {
    backend: async (action) => {
      if (action === 'discard') {
        cleanups++;
        if (rejectCleanup) throw Error('PRIVATE_CLEANUP_ERROR');
      }
      return {};
    },
  });
  const g = await f.confirm(),
    old = f.authority.grant;
  const result = await f.post('/diagnostic/discard', {}, g.headers);
  assert.equal(result.status, 409);
  assert.equal(result.value.code, 'CLEANUP_FAILED');
  assert.doesNotMatch(JSON.stringify(result.value), /PRIVATE_CLEANUP_ERROR/);
  assert.equal(old.abort.signal.aborted, true);
  assert.equal(f.authority.grant, null);
  assert.equal(f.authority.cleanupFailed, true);
  assert.equal((await f.post('/diagnostic/status', {}, g.headers)).status, 403);
  assert.equal((await f.post('/pair/start', { proof: proof() })).status, 409);
  assert.equal(cleanups, 1);
  rejectCleanup = false;
  await f.authority.revoke();
  assert.equal(cleanups, 2);
  assert.equal(f.authority.cleanupFailed, false);
  assert.equal((await f.post('/pair/start', { proof: proof() })).status, 200);
});
test('expiry cleanup failure remains latched and does not cause an unhandled rejection', async () => {
  let wall = 1,
    mono = 1;
  const a = new PairAuthority({
    clock: () => wall,
    monotonic: () => mono,
    onRevoke: async () => {
      throw Error('cleanup');
    },
  });
  const p = proof(),
    pair = a.start(p);
  a.approve(pair.comparison);
  const access = a.redeem(pair.pairId, p);
  wall += ACCESS_MS;
  mono += ACCESS_MS;
  assert.throws(() => a.authorize(access.token, p));
  await assert.rejects(a.revoke(), /CLEANUP_FAILED/);
  assert.throws(() => a.start(proof()), /CLEANUP_FAILED/);
});
test('only de-credentialed pending sample stays in grant memory after the original Cookie session expires', async (t) => {
  let cookieAlive = true;
  const f = await fixture(t, {
    backend: async (action) => {
      if (action === 'discard') return {};
      if (action === 'sample') {
        if (!cookieAlive) throw Error('EXPIRED');
        return {
          list: { xsec_token: '[redacted]' },
          detail: { desc: 'Sanitized pending caption' },
          images: [],
          cookies: { a1: 'NEVER_CACHE_CREDENTIAL' },
          expiresAt: 123,
        };
      }
      return { phase: 'sample-ready' };
    },
  });
  const g = await f.confirm();
  await f.post('/diagnostic/list', { confirmRequest: true }, g.headers);
  cookieAlive = false;
  const sample = await f.post('/diagnostic/sample', {}, g.headers);
  assert.equal(sample.status, 200);
  assert.equal(sample.value.data.detail.desc, 'Sanitized pending caption');
  assert.equal(sample.value.data.reviewed, false);
  assert.equal(sample.value.data.archiveAllowed, false);
  assert.equal(sample.value.data.sampleCached, true);
  assert.doesNotMatch(
    JSON.stringify(sample.value),
    /NEVER_CACHE_CREDENTIAL|cookies/,
  );
  const grant = f.authority.grant;
  await f.authority.revoke();
  assert.equal(grant.sampleCache, null);
});
test('expiry or owner revoke aborts in-flight request and prevents the late response', async (t) => {
  let observed, release;
  const started = new Promise((resolve) => {
    observed = resolve;
  });
  const f = await fixture(t, {
    backend: async (action, body, signal) => {
      if (action === 'discard') return {};
      observed(signal);
      return new Promise((resolve) => {
        release = () => resolve({ privateSample: 'not returned' });
      });
    },
  });
  const g = await f.confirm();
  const request = f.post('/diagnostic/status', {}, g.headers);
  const signal = await started;
  await f.authority.revoke();
  assert.equal(signal.aborted, true);
  release();
  assert.equal((await request).status, 403);
  assert.equal((await f.post('/diagnostic/status', {}, g.headers)).status, 403);
});
test('diagnostic login deadline may reach the approved 24 hour deadline but cannot exceed it', async (t) => {
  const f = await fixture(t),
    g = await f.confirm();
  await f.post(
    '/diagnostic/creator',
    {
      displayName: 'Synthetic',
      profileUrl: 'https://www.xiaohongshu.com/user/profile/synthetic-author',
    },
    g.headers,
  );
  assert.equal(
    (
      await f.post(
        '/diagnostic/session',
        {
          cookies: { a1: 'synthetic', web_session: 'synthetic' },
          expiresAt: g.access.expiresAt,
          confirmLocalSession: true,
        },
        g.headers,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.post(
        '/diagnostic/session',
        {
          cookies: { a1: 'synthetic', web_session: 'synthetic' },
          expiresAt: g.access.expiresAt + 1,
          confirmLocalSession: true,
        },
        g.headers,
      )
    ).status,
    422,
  );
});
test('client keeps credentials out of URL/storage/clipboard/console and cannot auto request platform', () => {
  const s = fs.readFileSync('redbook-pair.js', 'utf8');
  assert.doesNotMatch(
    s,
    /localStorage|sessionStorage|indexedDB|document\.cookie|navigator\.clipboard|console\.|location\.(search|hash)|innerHTML|eval\(/,
  );
  assert.match(s, /crypto\.getRandomValues/);
  assert.match(s, /credentials:\s*'omit'/);
  assert.match(s, /redirect:\s*'error'/);
  assert.doesNotMatch(
    s,
    /diagnostic\/(review|resume|refresh)|allowFutureArchive|allImagesChecked/,
  );
  assert.match(s, /expiresAt:\s*expiresAt|expiresAt,/);
  assert.match(s, /get\('allowImages'\)\.checked/);
});
test('launcher exception path cannot wait for user input before finally stopping its owned process', () => {
  const s = fs.readFileSync('start-paired-redbook.ps1', 'utf8');
  const exception = s.slice(
    s.indexOf('} catch {\n    Write-Host'),
    s.indexOf('} finally {'),
  );
  assert.doesNotMatch(exception, /Read-Host/);
  assert.match(s, /cleanup_failed/);
  assert.match(s, /WaitForExit\(5000\)/);
});
