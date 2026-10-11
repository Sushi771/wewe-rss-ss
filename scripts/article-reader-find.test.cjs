'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require(
  require.resolve('typescript', { paths: [path.resolve('apps/web')] }),
);
const component = fs.readFileSync(
  'apps/web/src/components/ArticleReader.tsx',
  'utf8',
);
const list = fs.readFileSync('apps/web/src/pages/feeds/list.tsx', 'utf8');
const helper = fs.readFileSync(
  'apps/web/src/utils/article-reader-find.ts',
  'utf8',
);
const ast = ts.createSourceFile(
  'reader.tsx',
  component,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const expressions = {};
const frames = [];
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.initializer)
    expressions[node.name.getText(ast)] = node.initializer.getText(ast);
  if (
    ts.isJsxSelfClosingElement(node) &&
    node.tagName.getText(ast) === 'iframe'
  )
    frames.push(node);
  ts.forEachChild(node, visit);
}
visit(ast);
function evaluate(expression, scope) {
  const context = { module: { exports: undefined }, ...scope };
  vm.runInNewContext(
    ts.transpileModule('module.exports = ' + expression, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
    }).outputText,
    context,
  );
  return context.module.exports;
}
function keyboard(findOpen, searching = false) {
  const calls = [];
  const input = { current: { focus: () => calls.push('focus') } };
  const handler = evaluate(expressions.keydown, {
    findOpen,
    searching,
    input,
    onFindOpenChange: (v) => calls.push(v),
    closeFind: () => calls.push('closeFind'),
    navigate: (v) => calls.push(v),
  });
  const event = (key, extra = {}) => ({
    key,
    target: input.current,
    preventDefault: () => calls.push('prevent'),
    stopImmediatePropagation: () => calls.push('stop'),
    ...extra,
  });
  return { calls, handler, event };
}

test('reader retains opaque no-script sandbox and list reserves Escape while find is open', () => {
  assert.equal(frames.length, 1);
  const sandbox = frames[0].attributes.properties.find(
    (p) => p.name?.getText(ast) === 'sandbox',
  );
  assert(ts.isStringLiteral(sandbox.initializer));
  assert.equal(sandbox.initializer.text, '');
  assert.doesNotMatch(
    component,
    /allow-scripts|allow-same-origin|contentDocument|contentWindow|dangerouslySetInnerHTML/,
  );
  assert.match(list, /isKeyboardDismissDisabled=\{readerFindOpen\}/);
  assert.match(list, /<ArticleReader\s+key=\{readingId\}/);
});

test('Escape closes find first, Enter and Shift Enter navigate, IME and inactive find are untouched', () => {
  const f = keyboard(true);
  f.handler(f.event('Escape'));
  assert.deepEqual(f.calls, ['prevent', 'stop', 'closeFind']);
  const next = keyboard(true);
  next.handler(next.event('Enter'));
  assert.deepEqual(next.calls, ['prevent', 1]);
  const previous = keyboard(true);
  previous.handler(previous.event('Enter', { shiftKey: true }));
  assert.deepEqual(previous.calls, ['prevent', -1]);
  const ime = keyboard(true);
  ime.handler(ime.event('Escape', { isComposing: true }));
  assert.deepEqual(ime.calls, []);
  const idle = keyboard(false);
  idle.handler(idle.event('Escape'));
  assert.deepEqual(idle.calls, []);
  const pending = keyboard(true, true);
  pending.handler(pending.event('Enter'));
  assert.deepEqual(pending.calls, ['prevent']);
});

test('Ctrl F opens current reader find and exact navigation wraps without dividing by zero', () => {
  const f = keyboard(false);
  f.handler(f.event('f', { ctrlKey: true }));
  assert.deepEqual(f.calls, ['prevent', 'stop', true, 'focus']);
  let active = 0;
  const navigate = evaluate(expressions.navigate, {
    useCallback: (fn) => fn,
    result: { ids: ['a', 'b', 'c'] },
    setActive: (update) => {
      active = update(active);
    },
  });
  navigate(-1);
  assert.equal(active, 2);
  navigate(1);
  assert.equal(active, 0);
  const empty = evaluate(expressions.navigate, {
    useCallback: (fn) => fn,
    result: { ids: [] },
    setActive: (update) => {
      active = update(active);
    },
  });
  empty(1);
  assert.equal(active, 0);
});

test('close clears search and restores trigger focus', () => {
  const calls = [];
  evaluate(expressions.closeFind, {
    useCallback: (fn) => fn,
    onFindOpenChange: (v) => calls.push(v),
    setKeyword: (v) => calls.push(v),
    trigger: { current: { focus: () => calls.push('focus') } },
  })();
  assert.deepEqual(calls, [false, '', 'focus']);
});

test('render document escapes base URL, blocks execution, and preserves cached HTML byte input', () => {
  const module = { exports: {} };
  vm.runInNewContext(
    ts.transpileModule(helper, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
    }).outputText,
    { module, exports: module.exports },
  );
  const source =
    '<a href="#saved">中文</a><img src="data:image/png;base64,AAAA">';
  const output = module.exports.readerDocument(
    source,
    'https://local.invalid/?x="&y=<x>',
  );
  assert(output.includes(source));
  assert(output.includes('x=&quot;&amp;y=&lt;x>'));
  assert(output.includes("script-src 'none'"));
  assert(output.includes("form-action 'none'"));
  assert(output.includes('mark.wewe-reader-match:target'));
  assert.doesNotMatch(output, /<script|allow-scripts/);
  assert.deepEqual(
    Array.from(module.exports.markArticleText(undefined, source, '', 'x').ids),
    [],
  );
  assert.equal(
    module.exports.markArticleText(undefined, source, '', 'x').html,
    source,
  );
});
