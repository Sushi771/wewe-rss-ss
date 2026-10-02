'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLogin, boundedFetch, page } = require('./owner-sdk-login-once.cjs');
const REQUEST = { redirect: 'error' };
const URLs = [
  'https://i.weread.qq.com/wxticket?nonceStr=weread',
  'https://open.weixin.qq.com/connect/sdk/qrconnect?appid=test',
  'https://long.open.weixin.qq.com/connect/l/qrconnect?uuid=mock',
  'https://i.weread.qq.com/login',
];
const identity = {
  vid: '12345',
  deviceId: 'existing_device',
  accessToken: 'new_mock_access',
  refreshToken: 'new_mock_refresh',
};
const response = () => new Response('{}');
const fakeSdk = (changed = {}) => ({
  async requestQr(fetch) {
    await fetch(URLs[0], REQUEST);
    await fetch(URLs[1], REQUEST);
    return {
      uuid: 'mock',
      confirmUrl: 'https://open.weixin.qq.com/connect/confirm?uuid=mock',
    };
  },
  async pollForCode(uuid, fetch, options) {
    assert.equal(uuid, 'mock');
    await fetch(URLs[2], REQUEST);
    options.onStatus?.('confirmed');
    return 'mock_code';
  },
  async exchange(code, deviceId, fetch) {
    assert.equal(code, 'mock_code');
    assert.equal(deviceId, identity.deviceId);
    await fetch(URLs[3], {
      ...REQUEST,
      method: 'POST',
      body: JSON.stringify({ deviceId, isAutoLogout: 0, code }),
    });
    return { ...identity, ...changed };
  },
});
async function fixture(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-sdk-offline-'));
  try {
    await callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
function options(root, changed = {}) {
  return {
    root,
    sdk: fakeSdk(),
    fetchImpl: async () => response(),
    expectedVid: identity.vid,
    deviceId: identity.deviceId,
    accountId: 'mock-account',
    takeSnapshot: () => ({ articles: 1448 }),
    onQr: () => {},
    onStatus: () => {},
    signal: new AbortController().signal,
    ...changed,
  };
}

test('normal SDK handoff saves an immutable private session, preserving production fields', async () =>
  fixture(async (root) => {
    let requests = 0;
    const result = await runLogin(
      options(root, {
        fetchImpl: async () => {
          requests++;
          return response();
        },
      }),
    );
    assert.equal(result.state, 'completed');
    assert.equal(requests, 4);
    const stored = JSON.parse(
      fs.readFileSync(path.join(root, 'mobile-session.json')),
    );
    assert.equal(stored.mobile.deviceId, identity.deviceId);
    assert.equal(stored.source, 'owner-confirmed-eink-sdk-login');
    assert.equal(stored.accountId, 'mock-account');
    await assert.rejects(runLogin(options(root)), /EEXIST/);
    const resultText = fs.readFileSync(path.join(root, 'result.json'), 'utf8');
    for (const secret of [
      identity.accessToken,
      identity.refreshToken,
      'mock_code',
    ])
      assert(!resultText.includes(secret));
  }));
test('a different scanned account is not published', async () =>
  fixture(async (root) => {
    assert.equal(
      (await runLogin(options(root, { sdk: fakeSdk({ vid: '99999' }) }))).state,
      'stopped',
    );
    assert(!fs.existsSync(path.join(root, 'mobile-session.json')));
  }));
test('QR expiry or decline does not regenerate or exchange', async () =>
  fixture(async (root) => {
    let requests = 0;
    const sdk = fakeSdk();
    sdk.pollForCode = async () => {
      throw Error('mock_expired');
    };
    assert.equal(
      (
        await runLogin(
          options(root, {
            sdk,
            fetchImpl: async () => {
              requests++;
              return response();
            },
          }),
        )
      ).state,
      'stopped',
    );
    assert.equal(requests, 2);
    assert(!fs.existsSync(path.join(root, 'mobile-session.json')));
  }));
test('a changed production snapshot blocks publication without rolling back any data', async () =>
  fixture(async (root) => {
    let checks = 0;
    assert.equal(
      (
        await runLogin(
          options(root, {
            takeSnapshot: () => ({ articles: 1448 + checks++ }),
          }),
        )
      ).state,
      'stopped',
    );
    assert(!fs.existsSync(path.join(root, 'mobile-session.json')));
  }));
test('authentication rejection performs one request and exposes no raw SDK error', async () =>
  fixture(async (root) => {
    let requests = 0;
    const result = await runLogin(
      options(root, {
        fetchImpl: async () => {
          requests++;
          return new Response('private credentials', { status: 401 });
        },
      }),
    );
    assert.deepEqual(result, { state: 'stopped', stage: 'ticket' });
    assert.equal(requests, 1);
    assert(!JSON.stringify(result).includes('private credentials'));
  }));
test('network guard forbids refresh, repeated tickets, unrelated paths and oversized/challenge responses', async () => {
  const audit = [];
  const guarded = boundedFetch(
    async () => response(),
    identity.deviceId,
    audit,
  );
  await guarded(URLs[0], REQUEST);
  await assert.rejects(guarded(URLs[0], REQUEST), /request_budget_gate/);
  await assert.rejects(
    guarded('https://i.weread.qq.com/mp/chapters', REQUEST),
    /endpoint_gate/,
  );
  await assert.rejects(
    (async () => {
      const normal = boundedFetch(
        async () => response(),
        identity.deviceId,
        [],
      );
      for (const url of URLs.slice(0, 3)) await normal(url, REQUEST);
      return normal(URLs[3], {
        ...REQUEST,
        method: 'POST',
        body: JSON.stringify({
          deviceId: identity.deviceId,
          isAutoLogout: 0,
          refreshToken: 'old_token',
        }),
      });
    })(),
    /exchange_gate/,
  );
  for (const body of [
    'x'.repeat(65537),
    '{"errCode":-2012}',
    '{"errMsg":"验证码"}',
  ]) {
    const bounded = boundedFetch(
      async () => new Response(body),
      identity.deviceId,
      [],
    );
    await assert.rejects(bounded(URLs[0], REQUEST));
  }
  assert.equal(audit.length, 1);
});
test('the local status page starts only on an explicit click and contains no credential API', () => {
  const html = page('mocknonce');
  assert(html.includes('b.onclick='));
  assert(!html.includes('accessToken'));
  assert(!html.includes('refreshToken'));
});

test('a QR business rejection retains private bytes without regeneration or public secrets', async () =>
  fixture(async (root) => {
    let requests = 0;
    const raw = JSON.stringify({
      errcode: -99,
      errmsg: 'mock private signature, not a public diagnostic',
    });
    const result = await runLogin(
      options(root, {
        fetchImpl: async () => {
          requests++;
          return new Response(requests === 2 ? raw : '{}');
        },
      }),
    );
    assert.deepEqual(result, { state: 'stopped', stage: 'qr' });
    assert.equal(requests, 2);
    assert.equal(
      fs.readFileSync(path.join(root, 'response-qr-1.bin'), 'utf8'),
      raw,
    );
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'result.json')));
    assert.equal(saved.audit[1].outcome, 'business_rejected');
    assert.deepEqual(saved.audit[1].businessCodes, { errcode: -99 });
    assert(saved.productionUnchanged);
    assert(!JSON.stringify(saved).includes('mock private signature'));
    assert(!fs.existsSync(path.join(root, 'mobile-session.json')));
  }));

test('non-JSON evidence is saved once and a failed evidence write prevents SDK progression', async () =>
  fixture(async (root) => {
    let requests = 0;
    const raw = '<html>mock private challenge</html>';
    const result = await runLogin(
      options(root, {
        fetchImpl: async () => {
          requests++;
          return new Response(raw);
        },
      }),
    );
    assert.equal(result.state, 'stopped');
    assert.equal(requests, 1);
    assert.equal(
      fs.readFileSync(path.join(root, 'response-ticket-1.bin'), 'utf8'),
      raw,
    );
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'result.json')));
    assert.equal(saved.audit[0].outcome, 'parsing_json');
    assert(!JSON.stringify(saved).includes('mock private challenge'));
    const guarded = boundedFetch(
      async () => response(),
      identity.deviceId,
      [],
      () => {
        throw Error('mock disk full containing private context');
      },
    );
    await assert.rejects(guarded(URLs[0], REQUEST));
    await assert.rejects(guarded(URLs[0], REQUEST), /request_budget_gate/);
  }));

test('QR response budget allows bounded payload >64KiB up to 16MiB, stops above 16MiB, while other phases remain capped at 64KiB', async () => {
  // 1. QR payload >64KiB accepted
  {
    const audit = [];
    const largeQrJson = JSON.stringify({
      errcode: 0,
      uuid: 'mock_uuid',
      extra: 'x'.repeat(70000), // > 64 KiB
    });
    const guarded = boundedFetch(
      async (url) => {
        if (url.includes('wxticket')) return response();
        return new Response(largeQrJson);
      },
      identity.deviceId,
      audit,
    );
    await guarded(URLs[0], REQUEST);
    const qrRes = await guarded(URLs[1], REQUEST);
    assert.equal(qrRes.status, 200);
    assert.equal(audit[1].outcome, 'accepted_by_guard');
    assert(audit[1].bytes > 65536);
  }

  // 2. QR payload above 16 MiB stopped
  {
    const audit = [];
    const oversizedChunk = new Uint8Array(16 * 1024 * 1024 + 1);
    const guarded = boundedFetch(
      async (url) => {
        if (url.includes('wxticket')) return response();
        return new Response(oversizedChunk);
      },
      identity.deviceId,
      audit,
    );
    await guarded(URLs[0], REQUEST);
    await assert.rejects(guarded(URLs[1], REQUEST), /response_size_gate/);
    assert.equal(audit[1].outcome, 'body_too_large');
  }

  // 3. Other phases remain capped at 64 KiB
  // 3a. Ticket phase capped at 65536
  {
    const audit = [];
    const guarded = boundedFetch(
      async () => new Response('x'.repeat(65537)),
      identity.deviceId,
      audit,
    );
    await assert.rejects(guarded(URLs[0], REQUEST), /response_size_gate/);
    assert.equal(audit[0].outcome, 'body_too_large');
  }

  // 3b. Poll phase capped at 65536
  {
    const audit = [];
    let call = 0;
    const guarded = boundedFetch(
      async () => {
        call++;
        if (call === 1) return response();
        if (call === 2) return response();
        return new Response('x'.repeat(65537));
      },
      identity.deviceId,
      audit,
    );
    await guarded(URLs[0], REQUEST);
    await guarded(URLs[1], REQUEST);
    await assert.rejects(guarded(URLs[2], REQUEST), /response_size_gate/);
    assert.equal(audit[2].outcome, 'body_too_large');
  }

  // 3c. Exchange phase capped at 65536
  {
    const audit = [];
    let call = 0;
    const guarded = boundedFetch(
      async () => {
        call++;
        if (call <= 3) return response();
        return new Response('x'.repeat(65537));
      },
      identity.deviceId,
      audit,
    );
    await guarded(URLs[0], REQUEST);
    await guarded(URLs[1], REQUEST);
    await guarded(URLs[2], REQUEST);
    await assert.rejects(
      guarded(URLs[3], {
        ...REQUEST,
        method: 'POST',
        body: JSON.stringify({
          deviceId: identity.deviceId,
          isAutoLogout: 0,
          code: 'mock_code',
        }),
      }),
      /response_size_gate/,
    );
    assert.equal(audit[3].outcome, 'body_too_large');
  }
});

test('runLogin accepts QR response >64KiB and preserves private evidence', async () =>
  fixture(async (root) => {
    let requests = 0;
    const largeQr = JSON.stringify({
      errcode: 0,
      uuid: 'mock_uuid',
      padding: 'y'.repeat(70000),
    });
    const result = await runLogin(
      options(root, {
        fetchImpl: async (input) => {
          requests++;
          if (input.includes('qrconnect?appid=')) return new Response(largeQr);
          return response();
        },
      }),
    );
    assert.equal(result.state, 'completed');
    assert.equal(requests, 4);
    assert.equal(
      fs.readFileSync(path.join(root, 'response-qr-1.bin'), 'utf8'),
      largeQr,
    );
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'result.json')));
    assert.equal(saved.audit[1].outcome, 'accepted_by_guard');
    assert(saved.audit[1].bytes > 65536);
  }));

test(
  'hash-pinned real SDK accepts QR payload >64KiB under the 16MiB ceiling',
  { skip: !process.env.OWNER_SDK_CACHE },
  async () =>
    fixture(async (root) => {
      const { verifyCache } = require('./prepare-owner-sdk-cache.cjs');
      const cache = verifyCache(process.env.OWNER_SDK_CACHE);
      const sdk = require(path.join(cache, 'src/auth/qrlogin.js'));
      let requests = 0;
      const largeQr = JSON.stringify({
        errcode: 0,
        uuid: 'mock_uuid',
        payload: 'z'.repeat(70000),
      });
      const fetchImpl = async (input, init) => {
        requests++;
        const url = new URL(input);
        let data;
        if (url.pathname === '/wxticket')
          data = { signature: 'mock_signature', timeStamp: 1700000000 };
        else if (url.pathname === '/connect/sdk/qrconnect')
          return new Response(largeQr);
        else if (url.pathname === '/connect/l/qrconnect')
          data = { wx_errcode: 405, wx_code: 'mock_wx_code' };
        else if (url.pathname === '/login') data = identity;
        else throw Error('unexpected mock route');
        return new Response(JSON.stringify(data));
      };
      const result = await runLogin(options(root, { sdk, fetchImpl }));
      assert.equal(result.state, 'completed');
      assert.equal(requests, 4);
      assert.equal(
        fs.readFileSync(path.join(root, 'response-qr-1.bin'), 'utf8'),
        largeQr,
      );
      const stored = JSON.parse(
        fs.readFileSync(path.join(root, 'mobile-session.json')),
      );
      assert.deepEqual(stored.mobile, identity);
    }),
);

test(
  'hash-pinned real SDK primitives obey the wrapper with all transport mocked',
  { skip: !process.env.OWNER_SDK_CACHE },
  async () =>
    fixture(async (root) => {
      const { verifyCache } = require('./prepare-owner-sdk-cache.cjs');
      const cache = verifyCache(process.env.OWNER_SDK_CACHE);
      const sdk = require(path.join(cache, 'src/auth/qrlogin.js'));
      let requests = 0;
      const fetchImpl = async (input, init) => {
        requests++;
        const url = new URL(input);
        let data;
        if (url.pathname === '/wxticket')
          data = { signature: 'mock_signature', timeStamp: 1700000000 };
        else if (url.pathname === '/connect/sdk/qrconnect')
          data = { errcode: 0, uuid: 'mock_uuid' };
        else if (url.pathname === '/connect/l/qrconnect')
          data = { wx_errcode: 405, wx_code: 'mock_wx_code' };
        else if (url.pathname === '/login') {
          const body = JSON.parse(init.body);
          assert.equal(body.deviceId, identity.deviceId);
          assert.equal(body.isAutoLogout, 0);
          assert(!('refreshToken' in body));
          assert(!('accessToken' in body));
          assert.equal(body.code, 'mock_wx_code');
          data = identity;
        } else throw Error('unexpected mock route');
        return new Response(JSON.stringify(data));
      };
      const result = await runLogin(options(root, { sdk, fetchImpl }));
      assert.equal(result.state, 'completed');
      assert.equal(requests, 4);
      const stored = JSON.parse(
        fs.readFileSync(path.join(root, 'mobile-session.json')),
      );
      assert.deepEqual(stored.mobile, identity);
    }),
);

test(
  'real SDK cancellation emits no transport request or credentials',
  { skip: !process.env.OWNER_SDK_CACHE },
  async () =>
    fixture(async (root) => {
      const { verifyCache } = require('./prepare-owner-sdk-cache.cjs');
      const sdk = require(
        path.join(
          verifyCache(process.env.OWNER_SDK_CACHE),
          'src/auth/qrlogin.js',
        ),
      );
      const controller = new AbortController();
      controller.abort();
      let requests = 0;
      const result = await runLogin(
        options(root, {
          sdk,
          signal: controller.signal,
          fetchImpl: async () => {
            requests++;
            throw Error('must not send');
          },
        }),
      );
      assert.equal(result.state, 'stopped');
      assert.equal(requests, 0);
      assert(!fs.existsSync(path.join(root, 'mobile-session.json')));
    }),
);
