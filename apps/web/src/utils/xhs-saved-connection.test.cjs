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
