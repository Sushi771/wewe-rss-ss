'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const root = process.env.DATE_SHORTCUTS_REPO || path.resolve(__dirname, '..');
const sourceRoot = process.env.DATE_SHORTCUTS_SOURCE || root;
const ts = require(
  require.resolve('typescript', { paths: [path.join(root, 'apps/web')] }),
);
const loaded = { exports: {} };
vm.runInNewContext(
  ts.transpileModule(
    fs.readFileSync(
      path.join(sourceRoot, 'apps/web/src/utils/article-date-selection.ts'),
      'utf8',
    ),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText,
  { module: loaded, exports: loaded.exports, Date, Intl },
);
const dates = loaded.exports;
const plain = (x) => JSON.parse(JSON.stringify(x));
test('Shanghai click-time dates across midnight, year, leap day and month boundaries', () => {
  for (const [instant, today, weekStart, monthStart] of [
    ['2026-10-10T15:59:59Z', '2026-10-10', '2026-10-04', '2026-10-01'],
    ['2026-10-10T16:00:00Z', '2026-10-11', '2026-10-05', '2026-10-01'],
    ['2025-12-31T16:00:00Z', '2026-01-01', '2025-12-26', '2026-01-01'],
    ['2024-02-29T16:00:00Z', '2024-03-01', '2024-02-24', '2024-03-01'],
    ['2025-02-28T16:00:00Z', '2025-03-01', '2025-02-23', '2025-03-01'],
    ['2024-02-28T16:00:00Z', '2024-02-29', '2024-02-23', '2024-02-01'],
  ]) {
    assert.deepEqual(
      plain(dates.articleDateShortcut('today', new Date(instant))),
      { mode: 'day', start: today, end: '' },
    );
    assert.deepEqual(
      plain(dates.articleDateShortcut('last7', new Date(instant))),
      { mode: 'range', start: weekStart, end: today },
    );
    assert.deepEqual(
      plain(dates.articleDateShortcut('month', new Date(instant))),
      { mode: 'range', start: monthStart, end: today },
    );
  }
});
test('existing query keys and empty filter clearing; no second filter system', () => {
  for (const key of ['today', 'last7', 'month']) {
    const selection = dates.articleDateShortcut(
      key,
      new Date('2026-10-10T16:00:00Z'),
    );
    const filter = dates.dateSelectionFilter(selection);
    assert.equal(filter.dateStart, selection.start);
    assert.equal(
      filter.dateEnd,
      selection.mode === 'day' ? selection.start : selection.end,
    );
    assert.deepEqual(Object.keys(filter), ['dateStart', 'dateEnd']);
    assert.equal(dates.isArticleDateShortcut(key), true);
  }
  for (const key of ['day', 'range', '', 'bogus'])
    assert.equal(dates.isArticleDateShortcut(key), false);
  assert.deepEqual(
    plain(dates.dateSelectionFilter({ mode: 'range', start: '', end: '' })),
    {},
  );
});
test('actual page date handler clears selected IDs and retains combined scope', () => {
  const filename = path.join(root, 'apps/web/src/pages/feeds/index.tsx');
  const source = ts.createSourceFile(
    filename,
    fs.readFileSync(filename, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let expression;
  function visit(n) {
    if (
      ts.isJsxSelfClosingElement(n) &&
      n.tagName.getText(source) === 'ArticleDateFilter'
    ) {
      const a = n.attributes.properties.find(
        (p) => ts.isJsxAttribute(p) && p.name.getText(source) === 'onChange',
      );
      expression = a.initializer.expression.getText(source);
    }
    ts.forEachChild(n, visit);
  }
  visit(source);
  assert(expression);
  let actual,
    selected = new Set(['old']);
  const other = { mpId: 'a', group: 'g', search: 'keyword', direction: 'asc' };
  const handler = vm.runInNewContext('(' + expression + ')', {
    setArticleDates: (x) => (actual = x),
    setArticleSelectedIds: (x) => (selected = x),
    Set,
  });
  const next = dates.articleDateShortcut(
    'last7',
    new Date('2026-10-10T16:00:00Z'),
  );
  handler(next);
  assert.equal(actual, next);
  assert.equal(selected.size, 0);
  assert.deepEqual(
    { ...other, ...plain(dates.dateSelectionFilter(actual)) },
    { ...other, dateStart: '2026-10-05', dateEnd: '2026-10-11' },
  );
});
