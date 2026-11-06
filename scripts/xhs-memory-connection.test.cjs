const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require(
  require.resolve('typescript', { paths: [path.resolve('apps/web')] }),
);
const mod = { exports: {} };
new Function(
  'exports',
  'module',
  ts.transpileModule(
    fs.readFileSync('apps/web/src/utils/xhs-memory-connection.ts', 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS } },
  ).outputText,
)(mod.exports, mod);
const { connectMemorySession } = mod.exports;
const input = () => ({ a1: 'synthetic-a1', webSession: 'synthetic-session' });
const response = (data) => ({
  ok: true,
  json: async () => ({ result: { data } }),
});
const host = (send) => ({
  origin: 'http://127.0.0.1:4000',
  privateMode: false,
  authCode: () => 'synthetic-app-auth',
  send,
});

test('manual connection sends only local memory input once and keeps source blocked', async () => {
  const fields = { ...input(), persist: true };
  let calls = 0;
  const result = await connectMemorySession(
    fields,
    host(async (url, options) => {
      calls++;
      assert.equal(
        String(url),
        'http://127.0.0.1:4000/trpc/xiaohongshu.connectSession',
      );
      assert.deepEqual(JSON.parse(options.body), {
        ...input(),
        persist: false,
      });
      assert.equal(options.credentials, 'omit');
      assert.equal(options.redirect, 'error');
      assert.equal(options.mode, 'same-origin');
      assert.equal(options.cache, 'no-store');
      assert.equal(options.headers.authorization, 'synthetic-app-auth');
      assert.equal(fields.a1, '');
      assert.equal(fields.webSession, '');
      return response({
        connected: true,
        riskCode: 'XHS_SOURCE_AUTHENTICATION_BLOCKED',
      });
    }),
  );
  assert.deepEqual(result, { status: 'connected', sourceBlocked: true });
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(result), /synthetic/);
});

test('nonlocal/private origins and malformed values never reach transport and are cleared', async () => {
  for (const overrides of [
    { origin: 'https://example.invalid' },
    { origin: 'http://127.0.0.1:4000/path' },
    { origin: 'http://user:password@127.0.0.1:4000' },
    { privateMode: true },
  ]) {
    const fields = input();
    assert.deepEqual(
      await connectMemorySession(fields, {
        ...host(() => assert.fail('unexpected request')),
        ...overrides,
      }),
      { status: 'unavailable' },
    );
    assert.deepEqual(fields, { a1: '', webSession: '' });
  }
  const fields = { a1: 'invalid value', webSession: 'synthetic-session' };
  assert.deepEqual(
    await connectMemorySession(
      fields,
      host(() => assert.fail('unexpected request')),
    ),
    { status: 'invalid' },
  );
  assert.deepEqual(fields, { a1: '', webSession: '' });
});

test('failure, rejection and malformed response never echo input or retry', async () => {
  for (const send of [
    async () => {
      throw Error('synthetic-session');
    },
    async () => ({
      ok: false,
      json: () => assert.fail('do not read rejection detail'),
    }),
    async () => ({
      ok: true,
      json: async () => {
        throw Error('synthetic-a1');
      },
    }),
  ]) {
    let calls = 0;
    const fields = input();
    const result = await connectMemorySession(
      fields,
      host(async (...args) => {
        calls++;
        return send(...args);
      }),
    );
    assert.equal(calls, 1);
    assert.deepEqual(fields, { a1: '', webSession: '' });
    assert.doesNotMatch(JSON.stringify(result), /synthetic/);
  }
  const fields = input();
  await connectMemorySession(fields, {
    ...host(() => assert.fail('unexpected request')),
    authCode: () => {
      throw Error('synthetic-local-failure');
    },
  });
  assert.deepEqual(fields, { a1: '', webSession: '' });
});
