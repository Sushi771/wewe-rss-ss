'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { sessionGate, probe } = require('./probe-owner-review-once.cjs');
const hash = (v) => createHash('sha256').update(v).digest('hex');
const mobile = {
  vid: '12345',
  deviceId: 'mock_device',
  accessToken: 'mock_secret',
};
const candidate = {
  id: 'WX_12345_22_1',
  requestUrl:
    'https://mp.weixin.qq.com/s?__biz=MTIzNDU%3D&mid=22&idx=1&sn=abc&scene=mock',
};
const profile = {
  authHeaders: (m) => ({ vid: m.vid, accessToken: m.accessToken }),
  versionHeaders: { appver: 'mock' },
};
async function fixture(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-resolver-mock-'));
  try {
    await callback(root);
  } finally {
    const resolved = fs.realpathSync(root),
      parent = fs.realpathSync(os.tmpdir());
    assert(
      path.dirname(resolved).toLowerCase() === parent.toLowerCase() &&
        path.basename(resolved).startsWith('wewe-resolver-mock-'),
    );
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
function options(root, changed = {}) {
  return {
    candidate,
    mobile,
    profile,
    marker: path.join(root, 'attempt.json'),
    output: root,
    fetchImpl: async () => new Response('{"reviewIds":[]}'),
    takeSnapshot: () => ({ db: 'mock_unchanged' }),
    protectedHashes: ['mock'],
    parse: () => ({ originalVerified: false, reviewId: 'mock_review' }),
    ...changed,
  };
}
test('requires recent matching owner-confirmed SDK session and successful unchanged login', () => {
  const now = Date.now();
  const session = {
    formatVersion: 1,
    source: 'owner-confirmed-eink-sdk-login',
    capturedAt: new Date(now - 1000).toISOString(),
    accountId: 'mock_account',
    mobile,
  };
  const login = { success: true, productionUnchanged: true };
  const attempt = {
    startedAt: new Date(now - 2000).toISOString(),
    ownerHash: hash('12345'),
    deviceHash: hash('mock_device'),
  };
  assert.equal(
    sessionGate(session, login, attempt, '12345', 'mock_device', now),
    mobile,
  );
  for (const altered of [
    { source: 'owner-confirmed-native-web-login' },
    { capturedAt: new Date(now - 31 * 60000).toISOString() },
    { mobile: { ...mobile, vid: 'other' } },
  ])
    assert.throws(() =>
      sessionGate(
        { ...session, ...altered },
        login,
        attempt,
        '12345',
        'mock_device',
        now,
      ),
    );
  assert.throws(() =>
    sessionGate(
      session,
      { ...login, success: false },
      attempt,
      '12345',
      'mock_device',
      now,
    ),
  );
});
test('one exact resolver request preserves search URL, writes marker first, never refreshes/replays', async () =>
  fixture(async (root) => {
    let calls = 0;
    const opts = options(root, {
      fetchImpl: async (url, init) => {
        calls++;
        assert(fs.existsSync(path.join(root, 'attempt.json')));
        assert.equal(url, 'https://i.weread.qq.com/mp/getreviewid');
        assert.equal(init.method, 'POST');
        assert.equal(init.redirect, 'error');
        assert.deepEqual(JSON.parse(init.body), {
          urls: [candidate.requestUrl],
        });
        assert.equal(init.headers.accessToken, mobile.accessToken);
        assert(
          !('cookie' in init.headers) && !('Authorization' in init.headers),
        );
        return new Response('{"reviewIds":[]}');
      },
    });
    assert.equal((await probe(opts)).success, true);
    await assert.rejects(probe(opts));
    assert.equal(calls, 1);
    assert(
      !fs
        .readFileSync(path.join(root, 'result.json'), 'utf8')
        .includes(mobile.accessToken),
    );
  }));
test('HTTP401, challenge, malformed JSON and parser mismatch stop after one retained response', async () => {
  for (const [status, body] of [
    [401, '{"errCode":-2012}'],
    [200, '{"message":"captcha"}'],
    [200, '<html>'],
    [200, '{}'],
  ])
    await fixture(async (root) => {
      let calls = 0;
      const result = await probe(
        options(root, {
          fetchImpl: async () => {
            calls++;
            return new Response(body, { status });
          },
          parse: () => {
            throw Error('mock mismatch with raw upstream secrets');
          },
        }),
      );
      assert(!result.success);
      assert.equal(calls, 1);
      assert(fs.existsSync(path.join(root, 'response-body.bin')));
      assert(!fs.existsSync(path.join(root, 'resolution.json')));
    });
});
test('oversize and production changes cannot publish a resolution', async () => {
  await fixture(async (root) => {
    const r = await probe(
      options(root, { fetchImpl: async () => new Response('a'.repeat(65537)) }),
    );
    assert(!r.success);
    assert(!fs.existsSync(path.join(root, 'response-body.bin')));
  });
  await fixture(async (root) => {
    let snapshots = 0;
    const r = await probe(
      options(root, { takeSnapshot: () => ({ db: ++snapshots }) }),
    );
    assert(!r.success && !r.productionUnchanged);
    assert(!fs.existsSync(path.join(root, 'resolution.json')));
  });
});
