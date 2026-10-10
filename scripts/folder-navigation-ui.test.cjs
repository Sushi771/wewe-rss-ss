'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require(
  require.resolve('typescript', { paths: [path.resolve('apps/web')] }),
);

function fixture({
  disabled = false,
  selectedIds = [],
  failMove = false,
} = {}) {
  const state = [],
    refs = [],
    calls = [];
  let index = 0,
    refIndex = 0;
  const react = {
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
  };
  const element = (type, props) => ({ type, props: props || {} });
  const mod = { exports: {} };
  const code = ts.transpileModule(
    fs.readFileSync('apps/web/src/components/ManagementFolders.tsx', 'utf8'),
    {
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
    },
  ).outputText;
  vm.runInNewContext(code, {
    Error,
    exports: mod.exports,
    module: mod,
    window: { confirm: () => true },
    require: (name) =>
      name === 'react'
        ? react
        : name === 'react/jsx-runtime'
          ? { jsx: element, jsxs: element }
          : new Proxy({}, { get: (_, key) => key }),
  });
  const props = {
    folders: [{ id: 'g1', name: 'A very long folder name' }],
    filter: 'all',
    selectedIds,
    dragType: 'application/x-wewe-wechat',
    disabled,
    onFilter: (id) => calls.push(['filter', id]),
    onSave: async (value) => calls.push(['save', value]),
    onRemove: async (id) => calls.push(['remove', id]),
    onMove: async (...args) => {
      calls.push(['move', ...args]);
      if (failMove) throw new Error('Synthetic move failure');
    },
    onBusyChange: (busy) => calls.push(['busy', busy]),
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
    return nodes;
  };
  const find = (type, predicate = () => true) =>
    nodes.find((n) => n.type === type && predicate(n.props));
  render();
  return { calls, render, find };
}
const settle = () => new Promise((done) => setImmediate(done));

test('help and per-folder actions are in accessible popover/menu; rename still saves', async () => {
  const f = fixture();
  assert(f.find('PopoverContent'));
  assert(f.find('Button', (p) => p['aria-label'] === '分组帮助'));
  assert(f.find('Button', (p) => /更多操作/.test(p['aria-label'])));
  f.find('DropdownMenu').props.onAction('rename');
  f.render();
  assert.equal(f.find('Input').props.value, 'A very long folder name');
  f.find('Input').props.onValueChange('Renamed');
  f.render();
  f.find('Button', (p) => p.children === '保存').props.onPress();
  await settle();
  assert(
    f.calls.some(
      (c) => c[0] === 'save' && c[1].id === 'g1' && c[1].name === 'Renamed',
    ),
  );
});
test('menu deletion and lightweight new-folder entry retain their operations', async () => {
  const f = fixture();
  f.find('DropdownMenu').props.onAction('delete');
  await settle();
  assert(f.calls.some((c) => c[0] === 'remove' && c[1] === 'g1'));
  f.find('Button', (p) => p['aria-label'] === '新建文件夹').props.onPress();
  f.render();
  assert.equal(f.find('Modal').props.isOpen, true);
  assert.equal(f.find('Input').props.value, '');
});
test('folder drop preserves multi-selection, ignores foreign drags and exposes errors', async () => {
  const f = fixture({ selectedIds: ['f1', 'f2'], failMove: true });
  const rows = f
    .render()
    .filter((n) => n.props?.className === 'folder-navigation-row');
  const event = (id) => ({
    preventDefault() {},
    dataTransfer: {
      getData: (type) => (type === 'application/x-wewe-wechat' ? id : ''),
    },
  });
  rows[2].props.onDrop(event(''));
  await settle();
  assert.equal(f.calls.length, 0);
  rows[2].props.onDrop(event('f1'));
  await settle();
  f.render();
  assert.deepEqual(
    JSON.parse(JSON.stringify(f.calls.find((c) => c[0] === 'move'))),
    ['move', ['f1', 'f2'], 'g1'],
  );
  assert.equal(
    f.find('p', (p) => p.role === 'alert').props.children,
    'Synthetic move failure',
  );
});
test('disabled menus and drops make no mutation; touch batch move remains available', async () => {
  const f = fixture({ disabled: true });
  f.find('DropdownMenu').props.onAction('delete');
  f.find('div', (p) => p.className === 'folder-navigation-row').props.onDrop({
    preventDefault() {},
    dataTransfer: { getData: () => 'f1' },
  });
  await settle();
  assert.equal(f.calls.length, 0);
  const mobile = fixture({ selectedIds: ['f1'] });
  mobile.find('select').props.onChange({ target: { value: 'g1' } });
  mobile.render();
  mobile
    .find('Button', (p) => String(p.onPress).includes('onMove'))
    .props.onPress();
  await settle();
  assert.deepEqual(
    JSON.parse(JSON.stringify(mobile.calls.find((c) => c[0] === 'move'))),
    ['move', ['f1'], 'g1'],
  );
});
