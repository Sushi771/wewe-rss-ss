const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const ts = require(
  require.resolve('typescript', { paths: [path.resolve('apps/web')] }),
);
const source = fs.readFileSync(
  'apps/web/src/utils/redbook-first-check.ts',
  'utf8',
);
function fixture(
  host = '127.0.0.1',
  response = { ok: true, json: async () => ({ phase: 'ready' }) },
) {
  const calls = [];
  const context = {
    exports: {},
    window: { location: { hostname: host } },
    AbortSignal,
    fetch: async (...args) => {
      calls.push(args);
      return response;
    },
  };
  vm.runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    context,
  );
  return { ...context.exports, calls };
}
test('private submission rejects public origin and missing access password before fetch', async () => {
  const publicPage = fixture('example.com');
  await assert.rejects(
    publicPage.redbookFirstCheckRequest('session', 'private'),
  );
  assert.equal(publicPage.calls.length, 0);
  const local = fixture();
  await assert.rejects(local.redbookFirstCheckRequest('session', ''));
  assert.equal(local.calls.length, 0);
});
test('each manual action sends exactly one same-origin POST without cookie persistence or redirects', async () => {
  const local = fixture();
  assert.equal(local.calls.length, 0);
  for (const action of [
    'status',
    'session',
    'list',
    'detail',
    'images',
    'sample',
    'review',
    'discard',
  ])
    await local.redbookFirstCheckRequest(action, 'manual-password', {
      confirmRequest: true,
    });
  assert.equal(local.calls.length, 8);
  for (const [url, options] of local.calls) {
    assert.match(url, /^\/local\/redbook\/diagnostic\//);
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, 'manual-password');
  }
});
test('rejection never retries or echoes the submitted secret/server body', async () => {
  const local = fixture('localhost', {
    ok: false,
    json: async () => ({ message: 'private-secret' }),
  });
  await assert.rejects(
    local.redbookFirstCheckRequest('list', 'private-secret'),
    (error) => !error.message.includes('private-secret'),
  );
  assert.equal(local.calls.length, 1);
});
test('component initial server render is inert, with no platform request or stored credential loader', () => {
  const componentSource = fs.readFileSync(
    'apps/web/src/components/RedbookFirstCheck.tsx',
    'utf8',
  );
  const react = require(
    require.resolve('react', { paths: [path.resolve('apps/web')] }),
  );
  const renderer = require(
    require.resolve('react-dom/server', { paths: [path.resolve('apps/web')] }),
  );
  const local = fixture();
  const context = {
    exports: {},
    window: { location: { hostname: 'localhost' } },
    require: (name) =>
      name === 'react'
        ? react
        : name === 'react/jsx-runtime'
          ? require(
              require.resolve(name, { paths: [path.resolve('apps/web')] }),
            )
          : local,
  };
  vm.runInNewContext(
    ts.transpileModule(componentSource, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    context,
  );
  const html = renderer.renderToStaticMarkup(
    react.createElement(context.exports.default, {
      creator: {
        id: 'synthetic',
        displayName: 'Synthetic',
        profileUrl: 'https://www.xiaohongshu.com/user/profile/synthetic',
      },
      onEnabled: async () => {},
    }),
  );
  assert.match(html, /本机首次小量检查/);
  assert.equal(local.calls.length, 0);
  assert.doesNotMatch(
    componentSource,
    /localStorage|sessionStorage|getAuthCode|serverOriginUrl|dangerouslySetInnerHTML|console\./,
  );
});
