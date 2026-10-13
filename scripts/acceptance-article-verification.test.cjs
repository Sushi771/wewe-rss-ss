'use strict';
// Offline API parsing + React SSR only; no browser, platform, navigation or secrets.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const webRequire = createRequire(path.join(root, 'apps/web/package.json'));
const ts = webRequire('typescript');
const React = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');
let policy;
function compile(relative) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  const output = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    (name) => (name === '@wewe-rss/shared' ? policy : webRequire(name)),
    output,
    output.exports,
  );
  return output.exports;
}
policy = compile('packages/shared/src/article-verification.ts');
const { verificationFromDownloadError: parse } = compile(
  'apps/web/src/utils/article-download-error.ts',
);
const Notice = compile(
  'apps/web/src/pages/tools/article-verification-notice.tsx',
).default;
const article = 'https://mp.weixin.qq.com/s/abcdefghijklmnopqrstuv';
const official =
  'https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha?action=verify&url=' +
  encodeURIComponent(article);
const payload = (verification) => ({
  code: 'VERIFICATION_REDIRECT',
  stage: 'article',
  verification,
});
const available = () => ({
  status: 'available',
  articleUrl: article,
  url: official,
  expiresAt: new Date(Date.now() + 120000).toISOString(),
});
const render = (context) =>
  renderToStaticMarkup(React.createElement(Notice, { verification: context }));
const originalFetch = global.fetch;
let requests = 0;
global.fetch = async () => {
  requests++;
  throw new Error('NO_NETWORK');
};
after(() => {
  global.fetch = originalFetch;
  assert.equal(requests, 0);
});

test('renders the response-provided official link for this article with native new-tab/referrer protections', () => {
  const context = parse(payload(available()), article);
  assert.equal(context.status, 'available');
  const html = render(context);
  assert.match(html, /打开本次官方验证/);
  assert.match(html, /本次待验证文章/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /referrerPolicy="no-referrer"/i);
  assert.match(html, /wappoc_appmsgcaptcha/);
  assert.match(html, /浏览器验证成功不代表后台下载已恢复/);
});

test('old/missing Location renders missing-address text and no homepage or verification link', () => {
  const context = parse(
    payload(undefined),
    article + '?pass_ticket=fixture-private',
  );
  const html = render(context);
  assert.match(html, /未取得本次官方验证地址/);
  assert.doesNotMatch(html, /href=|fixture-private|weread\.qq\.com/);
});

test('sensitive, unsafe and unrelated destinations never become an anchor', () => {
  for (const url of [
    'javascript:alert(1)',
    'https://evil.invalid/mp/verify',
    'https://mp.weixin.qq.com/mp/verify?ticket=fixture-private',
  ]) {
    const context = parse(payload({ ...available(), url }), article);
    const html = render(context);
    assert.doesNotMatch(
      html,
      /href=|fixture-private|evil\.invalid|javascript:/,
    );
  }
  assert.equal(
    parse(
      payload({
        ...available(),
        articleUrl: article.replace('abcdef', 'zzzzzz'),
      }),
      article,
    ),
    null,
  );
  assert.equal(
    parse({ ...payload(available()), code: 'LOGIN_REDIRECT' }, article),
    null,
  );
  assert.equal(
    parse(payload({ ...available(), status: 'invented' }), article),
    null,
  );
});

test('expired, missing and excessive expiries cannot render a usable address', () => {
  for (const expiresAt of [
    undefined,
    'invalid',
    new Date(Date.now() - 1).toISOString(),
    new Date(Date.now() + 3600000).toISOString(),
  ]) {
    const context = parse(payload({ ...available(), expiresAt }), article);
    assert.equal(context.reason, 'expired');
    assert.doesNotMatch(render(context), /href=|wappoc_appmsgcaptcha/);
  }
  assert.doesNotMatch(
    render({ ...available(), url: 'javascript:alert(1)' }),
    /href=/,
  );
});

test('an anchor rendered before suspension still prevents navigation after its expiry', () => {
  const context = available();
  const tree = Notice({ verification: context });
  function findAnchor(node) {
    if (!React.isValidElement(node)) return null;
    if (node.type === 'a') return node;
    for (const child of React.Children.toArray(node.props.children)) {
      const found = findAnchor(child);
      if (found) return found;
    }
    return null;
  }
  const anchor = findAnchor(tree);
  assert(anchor);
  let prevented = false;
  const originalNow = Date.now;
  try {
    Date.now = () => Date.parse(context.expiresAt) + 1;
    anchor.props.onClick({
      preventDefault() {
        prevented = true;
      },
    });
  } finally {
    Date.now = originalNow;
  }
  assert.equal(prevented, true);
});
