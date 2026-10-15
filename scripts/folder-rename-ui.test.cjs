'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require(require.resolve('typescript', { paths: ['apps/web'] }));
const settle = () => new Promise((resolve) => setImmediate(resolve));
function fixture() {
  const state = [],
    refs = [];
  let index = 0,
    refIndex = 0,
    resolve,
    reject;
  const calls = [];
  const element = (type, props) => ({ type, props: props || {} });
  const mod = { exports: {} };
  const code = ts.transpileModule(
    fs.readFileSync('apps/web/src/components/ManagementFolders.tsx', 'utf8'),
    {
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  vm.runInNewContext(code, {
    Error,
    exports: mod.exports,
    module: mod,
    require: (name) =>
      name === 'react'
        ? {
            useState(value) {
              const i = index++;
              if (!(i in state)) state[i] = value;
              return [
                state[i],
                (value) => {
                  state[i] = value;
                },
              ];
            },
            useRef(value) {
              const i = refIndex++;
              return (refs[i] ||= { current: value });
            },
          }
        : name === 'react/jsx-runtime'
          ? { jsx: element, jsxs: element }
          : new Proxy({}, { get: (_, key) => key }),
  });
  const props = {
    folders: [
      { id: 'a', name: 'Alpha' },
      { id: 'b', name: 'Beta' },
    ],
    filter: 'a',
    selectedIds: [],
    dragType: 'fixture',
    disabled: false,
    onBusyChange: (value) => calls.push(['busy', value]),
    onFilter: (id) => calls.push(['filter', id]),
    onSave: (input) => {
      calls.push(['save', input]);
      return new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      });
    },
  };
  let nodes;
  const render = () => {
    index = refIndex = 0;
    nodes = [];
    const visit = (n) => {
      if (Array.isArray(n)) return n.forEach(visit);
      if (!n || typeof n !== 'object') return;
      nodes.push(n);
      visit(n.props?.children);
    };
    visit(mod.exports.default(props));
  };
  const find = (type, predicate = () => true) =>
    nodes.find((n) => n.type === type && predicate(n.props));
  const edit = (name) => {
    find('DropdownMenu').props.onAction('rename');
    render();
    find('Input').props.onValueChange(name);
    render();
  };
  render();
  return {
    render,
    find,
    edit,
    calls,
    props,
    complete: () => resolve(),
    fail: () => reject(Error('Synthetic rejected')),
  };
}
test('rename displays proposed name and closes dialog before persistence; duplicate press is fenced', async () => {
  const f = fixture();
  f.edit('  Beta  ');
  const save = f.find('Button', (p) => p.children === '保存').props.onPress;
  save();
  save();
  f.render();
  assert.equal(f.find('Modal').props.isOpen, false);
  assert.equal(f.find('Modal').props.disableAnimation, true);
  assert(
    f.find(
      'span',
      (p) => p.className === 'folder-filter-label' && p.children === 'Beta',
    ),
  );
  assert.equal(f.calls.filter((c) => c[0] === 'save').length, 1);
  assert.match(
    f.find('p', (p) => p.role === 'status').props.children,
    /正在保存/,
  );
  f.props.folders[0].name = 'Beta';
  f.complete();
  await settle();
  f.render();
  assert.equal(
    f.find('p', (p) => p.role === 'status'),
    undefined,
  );
});
test('rejection restores confirmed name and explicitly reports unconfirmed saving', async () => {
  const f = fixture();
  f.edit('Proposed');
  f.find('Button', (p) => p.children === '保存').props.onPress();
  f.fail();
  await settle();
  f.render();
  assert(f.find('span', (p) => p.children === 'Alpha'));
  assert.equal(
    f.find('span', (p) => p.children === 'Proposed'),
    undefined,
  );
  assert.match(
    f.find('p', (p) => p.role === 'alert').props.children,
    /未确认保存/,
  );
});
test('cancel and Esc do not save; blank, control and overlong names never submit; unchanged name is a no-op', () => {
  for (const mode of ['cancel', 'escape']) {
    const f = fixture();
    f.edit('Discarded');
    if (mode === 'cancel')
      f.find('Button', (p) => p.children === '取消').props.onPress();
    else f.find('Modal').props.onClose();
    f.render();
    assert.equal(f.find('Modal').props.isOpen, false);
    assert.equal(f.calls.length, 0);
  }
  for (const name of [' ', 'a\nb', 'a'.repeat(81)]) {
    const f = fixture();
    f.edit(name);
    f.find('Button', (p) => p.children === '保存').props.onPress();
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  f.edit(' Alpha ');
  f.find('Button', (p) => p.children === '保存').props.onPress();
  f.render();
  assert.equal(f.find('Modal').props.isOpen, false);
  assert.equal(f.calls.length, 0);
});

function saveCallback(file) {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    99,
    true,
    ts.ScriptKind.TSX,
  );
  let callback;
  function visit(n) {
    if (
      ts.isJsxSelfClosingElement(n) &&
      n.tagName.getText(source) === 'ManagementFolders'
    )
      callback = n.attributes.properties
        .find((p) => p.name?.getText(source) === 'onSave')
        .initializer.expression.getText(source);
    ts.forEachChild(n, visit);
  }
  visit(source);
  return ts.transpileModule('(' + callback + ')', {
    compilerOptions: { target: 9 },
  }).outputText;
}
for (const platform of ['wechat', 'xiaohongshu'])
  test(`${platform}: committed rename patches only its cached row and cancels stale reads without refetch`, async () => {
    const file =
      platform === 'wechat'
        ? 'apps/web/src/pages/feeds/index.tsx'
        : 'apps/web/src/pages/feeds/xiaohongshu.tsx';
    const events = [];
    let cache = {
      platform,
      items: [
        { id: 'a', name: 'Alpha', order: 0 },
        { id: 'b', name: 'Beta', order: 1 },
      ],
    };
    const saved = { id: 'a', name: 'Beta', order: 0, platform };
    const groups = {
      cancel: async () => events.push('cancel'),
      setData: (_, update) => {
        cache = update(cache);
        events.push('patch');
      },
    };
    const mutation = {
      mutateAsync: async () => {
        events.push('save');
        return saved;
      },
    };
    const refetch = () => {
      throw Error('Unexpected full reread');
    };
    const scope = {
      queryUtils: { feed: { groups } },
      utils: { xiaohongshu: { groups } },
      saveFolder: mutation,
      saveGroup: mutation,
      folders: { refetch },
      invalidateFolders: refetch,
    };
    const save = vm.runInNewContext(saveCallback(file), scope);
    await save({ id: 'a', name: 'Beta' });
    assert.deepEqual(events, ['cancel', 'save', 'cancel', 'patch']);
    assert.equal(cache.items[0].name, 'Beta');
    assert.equal(cache.items[1].name, 'Beta');
    assert.equal(cache.items[1].id, 'b');
    assert.equal(cache.items.length, 2);
  });

test('a read started during saving cannot overwrite the committed name even if its old response arrives last', async () => {
  const { QueryClient } = require(
    require.resolve('@tanstack/react-query', { paths: ['apps/web'] }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const key = ['fixture', 'groups'];
  const old = { items: [{ id: 'a', name: 'Alpha', order: 0 }] };
  client.setQueryData(key, old);
  let finishSave, finishRead;
  const groups = {
    cancel: () => client.cancelQueries(key),
    setData: (_, update) => client.setQueryData(key, update),
  };
  const mutation = {
    mutateAsync: () =>
      new Promise((resolve) => {
        finishSave = resolve;
      }),
  };
  const save = vm.runInNewContext(
    saveCallback('apps/web/src/pages/feeds/index.tsx'),
    { queryUtils: { feed: { groups } }, saveFolder: mutation },
  );
  const saving = save({ id: 'a', name: 'First' });
  await settle();
  const stale = client
    .fetchQuery({
      queryKey: key,
      queryFn: () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    })
    .catch(() => {});
  await settle();
  finishSave({ id: 'a', name: 'First', order: 0 });
  await saving;
  finishRead(old);
  await stale;
  await settle();
  assert.equal(client.getQueryData(key).items[0].name, 'First');
  const next = save({ id: 'a', name: 'Latest' });
  await settle();
  finishSave({ id: 'a', name: 'Latest', order: 0 });
  await next;
  assert.equal(client.getQueryData(key).items[0].name, 'Latest');
  client.clear();
});
