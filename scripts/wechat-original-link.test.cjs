'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const assert = require('node:assert/strict'),
  { test } = require('node:test');
const ts = require(
  require.resolve('typescript', { paths: [path.resolve('apps/web')] }),
);
const helper = fs.readFileSync(
  'apps/web/src/utils/wechat-original-url.ts',
  'utf8',
);
const context = { exports: {}, URL };
vm.runInNewContext(
  ts.transpileModule(helper, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText,
  context,
);
const url = context.exports.wechatOriginalUrl;
test('real backend canonical URLs without sn remain exact frontend originals', () => {
  const backendFile = path.resolve(
    'apps/server/src/collection/collection-format.ts',
  );
  const backend = {
    exports: {},
    URL,
    Buffer,
    require: require('node:module').createRequire(backendFile),
  };
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(backendFile, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    backend,
  );
  for (const suffix of ['', '&sn=synthetic-signature']) {
    const stored = backend.exports.canonicalArticleUrl(
      'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA==&mid=12&idx=1' + suffix,
    ).url;
    assert.equal(url(stored), stored);
    assert.equal(new URL(stored).searchParams.has('sn'), Boolean(suffix));
  }
});
test('stored official short and query URLs retain their exact source context', () => {
  for (const value of [
    'https://mp.weixin.qq.com/s/synthetic-public-id?scene=126#rd',
    'https://mp.weixin.qq.com/s?__biz=synthetic&mid=100&idx=1&sn=synthetic&scene=126',
  ])
    assert.equal(url(value), value);
});
test('missing, invented, executable and foreign URLs cannot become clickable originals', () => {
  for (const value of [
    null,
    undefined,
    '',
    'javascript:alert(1)',
    'data:text/html,test',
    'https://mp.weixin.qq.com.evil.test/s/id',
    'https://evil.test/s/id',
    'https://mp.weixin.qq.com@evil.test/s/id',
    'https://user:secret@mp.weixin.qq.com/s/id',
    'https://mp.weixin.qq.com:444/s/id',
    'https://mp.weixin.qq.com/s',
    'https://mp.weixin.qq.com/s?mid=12&idx=1',
    'https://mp.weixin.qq.com/s?__biz=synthetic&idx=1',
    'https://mp.weixin.qq.com/s?__biz=synthetic&mid=12',
    'https://mp.weixin.qq.com/s?__biz=synthetic&mid=12&idx=',
    'https://mp.weixin.qq.com/profile/id',
    'https://mp.weixin.qq.com/s/id\n',
    'http://mp.weixin.qq.com/s/id',
  ])
    assert.equal(url(value), undefined, String(value));
});
test('shared article title uses native safe links for all cache states without fetching body', () => {
  const source = fs.readFileSync('apps/web/src/pages/feeds/list.tsx', 'utf8');
  assert(
    !/ArticleReader|readingId|readerFindOpen|article\.byId|<Modal/.test(source),
  );
  assert.match(source, /href=\{wechatOriginalUrl\(item.sourceUrl\)\}/);
  assert.match(source, /target="_blank"/);
  assert.match(source, /rel="noopener noreferrer"/);
  assert.match(source, /原文链接未保存或不可用/);
  assert(!source.includes('https://mp.weixin.qq.com/s/${item.id}'));
  assert(!source.includes('event.preventDefault()'));
  const page = fs.readFileSync('apps/web/src/pages/feeds/index.tsx', 'utf8');
  assert.match(
    page,
    /<ArticleList[\s\S]*?articleFilter=\{\{ \.\.\.articleDateFilter, group: folderFilter \}\}[\s\S]*?search=\{search\}/,
  );
  assert.match(page, /setExportFormat\('obsidian'\)/);
  assert.match(page, /articleSelectedIds.size/);
  assert(!fs.existsSync('apps/web/src/components/ArticleReader.tsx'));
});
