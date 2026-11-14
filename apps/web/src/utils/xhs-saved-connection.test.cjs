const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('../../node_modules/typescript');
const compiled = ts.transpileModule(
  fs.readFileSync(
    require('node:path').join(__dirname, 'xhs-saved-connection.ts'),
    'utf8',
  ),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;
const moduleRef = { exports: {} };
new Function('exports', 'require', 'module', compiled)(
  moduleRef.exports,
  require,
  moduleRef,
);
const { savedSessionRequest } = moduleRef.exports;
const host = (send) => ({
  origin: 'http://127.0.0.1:4000',
  privateMode: false,
  authCode: () => null,
  send,
});
test('synthetic save preserves explicit options and clears input', async () => {
  const input = {
    a1: 'synthetic-a',
    webSession: 'synthetic-b',
    replaceSaved: true,
    autoRestore: false,
  };
  await savedSessionRequest(
    host(async (url, init) => {
      assert.equal(url.pathname, '/trpc/xiaohongshu.connectSession');
      assert.deepEqual(JSON.parse(init.body), { ...input, persist: true });
      assert.equal(init.cache, 'no-store');
      return {
        ok: true,
        json: async () => ({ result: { data: { connected: true } } }),
      };
    }),
    input,
  );
  assert.equal(input.a1, '');
  assert.equal(input.webSession, '');
});
test('saved values only returned from explicit read and response object scrubbed', async () => {
  const data = { a1: 'synthetic-a', webSession: 'synthetic-b' };
  const result = await savedSessionRequest(
    host(async (url, init) => {
      assert.equal(init.method, 'GET');
      assert.equal(init.cache, 'no-store');
      return { ok: true, json: async () => ({ result: { data } }) };
    }),
  );
  assert.equal(result.a1, 'synthetic-a');
  assert.equal(data.a1, '');
});
test('remote origin refuses transport and clears input', async () => {
  const input = {
    a1: 'synthetic-a',
    webSession: 'synthetic-b',
    replaceSaved: false,
    autoRestore: false,
  };
  await assert.rejects(
    savedSessionRequest(
      {
        ...host(() => {
          throw new Error('must not send');
        }),
        origin: 'https://example.com',
      },
      input,
    ),
  );
  assert.equal(input.a1, '');
});

test('status reads only connectionStatus and returns safe booleans', async () => {
  const { savedSessionStatus } = moduleRef.exports;
  const result = await savedSessionStatus(
    host(async (url, init) => {
      assert.equal(url.pathname, '/trpc/xiaohongshu.connectionStatus');
      assert.equal(init.method, 'GET');
      assert.equal(init.cache, 'no-store');
      return {
        ok: true,
        json: async () => ({
          result: {
            data: {
              sessionPresent: false,
              persistence: {
                autoRestore: true,
                needsReconnect: true,
                restoreFailed: true,
              },
              unrelated: 'discard',
            },
          },
        }),
      };
    }),
  );
  assert.deepEqual(result, {
    sessionPresent: false,
    autoRestore: true,
    needsReconnect: true,
    restoreFailed: true,
  });
});

test('all C0 and DEL characters reject before synthetic transport and clear inputs', async () => {
  for (const code of [
    ...Array.from({ length: 32 }, (_, index) => index),
    0x7f,
  ]) {
    let calls = 0;
    const input = {
      a1: 'synthetic' + String.fromCharCode(code) + 'value',
      webSession: 'synthetic-b',
      replaceSaved: false,
      autoRestore: false,
    };
    await assert.rejects(
      savedSessionRequest(
        host(async () => {
          calls++;
          throw new Error('must not send');
        }),
        input,
      ),
    );
    assert.equal(calls, 0);
    assert.equal(input.a1, '');
    assert.equal(input.webSession, '');
  }
});

test('save surfaces only bounded verification state, clears credentials and never retries', async () => {
  for (const state of [
    'profile-verified',
    'paused',
    'not-applicable',
    'untrusted-extra',
  ]) {
    let calls = 0;
    const seen = [];
    const input = {
      a1: 'synthetic-a',
      webSession: 'synthetic-b',
      replaceSaved: true,
      autoRestore: true,
    };
    const result = await savedSessionRequest(
      {
        ...host(async () => {
          calls++;
          return {
            ok: true,
            json: async () => ({
              result: {
                data: {
                  connected: true,
                  authenticationRecovery: { state, privateExtra: 'discard' },
                },
              },
            }),
          };
        }),
        onAuthenticationRecovery: (value) => seen.push(value),
      },
      input,
    );
    assert.equal(result, null);
    assert.equal(calls, 1);
    assert.equal(input.a1, '');
    assert.equal(input.webSession, '');
    assert.deepEqual(seen, state === 'untrusted-extra' ? [] : [state]);
  }
});

test('lost save or verification response clears input and does not resubmit credentials', async () => {
  const input = {
    a1: 'synthetic-a',
    webSession: 'synthetic-b',
    replaceSaved: true,
    autoRestore: true,
  };
  let calls = 0;
  const seen = [];
  await assert.rejects(
    savedSessionRequest(
      {
        ...host(async () => {
          calls++;
          throw new Error('synthetic-response-lost');
        }),
        onAuthenticationRecovery: (value) => seen.push(value),
      },
      input,
    ),
  );
  assert.equal(calls, 1);
  assert.equal(input.a1, '');
  assert.equal(input.webSession, '');
  assert.deepEqual(seen, []);
});

test('only allowlisted diagnostics reach the display callback', async () => {
  for (const [diagnostic, expected] of [
    [
      {
        stage: 'prepare',
        code: 'SOURCE_WORK_NOT_IDLE',
        privateExtra: 'secret',
      },
      { stage: 'prepare', code: 'SOURCE_WORK_NOT_IDLE' },
    ],
    [{ stage: 'prepare', code: 'secret' }, undefined],
    [{ stage: 'secret', code: 'UNKNOWN' }, undefined],
  ]) {
    let seen;
    await savedSessionRequest(
      {
        ...host(async () => ({
          ok: true,
          json: async () => ({
            result: {
              data: {
                connected: true,
                authenticationRecovery: { state: 'paused', diagnostic },
              },
            },
          }),
        })),
        onAuthenticationRecovery: (_state, detail) => {
          seen = detail;
        },
      },
      {
        a1: 'synthetic-a',
        webSession: 'synthetic-b',
        autoRestore: true,
        replaceSaved: true,
      },
    );
    assert.deepEqual(seen, expected);
  }
});
