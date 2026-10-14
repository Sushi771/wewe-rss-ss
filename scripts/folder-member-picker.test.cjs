'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require(require.resolve('typescript', { paths: ['apps/web'] }));
function fixture({ count = 2000, fail = false } = {}) {
  let index = 0,
    nodes;
  const state = [],
    calls = [];
  const props = {
    folder: { id: 'target', name: 'Synthetic folder' },
    disabled: false,
    members: Array.from({ length: count }, (_, i) => ({
      id: 's' + i,
      name: 'Subscription ' + i,
      groupId: i === 0 ? 'target' : 'other',
    })),
    onClose: () => calls.push(['close']),
    onAdd: async (ids) => {
      calls.push(['add', ids]);
      return !fail;
    },
  };
  props.members.push(props.members[1]); // duplicate response rows must not duplicate options/IDs
  const mod = { exports: {} };
  const jsx = (type, props) => ({ type, props });
  vm.runInNewContext(
    ts.transpileModule(
      fs.readFileSync('apps/web/src/components/FolderMemberPicker.tsx', 'utf8'),
      { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: 1, target: 9 } },
    ).outputText,
    {
      exports: mod.exports,
      module: mod,
      Set,
      Map,
      require: (name) =>
        name === 'react'
          ? {
              useState(initial) {
                const i = index++;
                if (!(i in state)) state[i] = initial;
                return [
                  state[i],
                  (next) => {
                    state[i] =
                      typeof next === 'function' ? next(state[i]) : next;
                  },
                ];
              },
              useMemo: (fn) => fn(),
            }
          : name === 'react/jsx-runtime'
            ? { jsx, jsxs: jsx }
            : new Proxy({}, { get: (_, key) => key }),
    },
  );
  const render = () => {
    index = 0;
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
  render();
  return {
    props,
    calls,
    render,
    find,
    options: () => nodes.filter((n) => n.type === 'input'),
  };
}
test('large list renders fifty options, excludes existing members, caps a single atomic batch at 100, and retains selection across pages/search', async () => {
  const f = fixture();
  assert.equal(f.options().length, 50);
  assert.equal(f.options()[0].props.disabled, true);
  f.find('Button', (p) => p.children === '选择本页').props.onPress();
  f.render();
  f.find('Button', (p) => p.children === '下一页').props.onPress();
  f.render();
  f.find('Button', (p) => p.children === '选择本页').props.onPress();
  f.render();
  f.find('Button', (p) => p.children === '下一页').props.onPress();
  f.render();
  f.find('Button', (p) => p.children === '选择本页').props.onPress();
  f.render();
  f.find('Input').props.onValueChange('Subscription 1999');
  f.render();
  assert.equal(f.options().length, 1);
  assert.equal(f.options()[0].props.disabled, true);
  await f.find('Button', (p) => p.color === 'primary').props.onPress();
  const ids = f.calls.find((c) => c[0] === 'add')[1];
  assert.equal(ids.length, 100);
  assert.equal(new Set(ids).size, 100);
  assert(!ids.includes('s0'));
  assert(f.calls.some((c) => c[0] === 'close'));
});
test('rapid checkbox events enforce the 100-member limit before a rerender', async () => {
  const f = fixture();
  for (let page = 0; page < 3; page++) {
    f.options()
      .filter((n) => !n.props.disabled)
      .forEach((n) => n.props.onChange());
    f.find('Button', (p) => p.children === '下一页').props.onPress();
    f.render();
  }
  await f.find('Button', (p) => p.color === 'primary').props.onPress();
  assert.equal(f.calls.find((c) => c[0] === 'add')[1].length, 100);
});
test('failed batch retains checked rows and modal; pending save disables mutation and dismissal while search stays responsive', async () => {
  const f = fixture({ fail: true });
  f.options()[1].props.onChange();
  f.render();
  await f.find('Button', (p) => p.color === 'primary').props.onPress();
  f.render();
  assert.equal(f.options()[1].props.checked, true);
  assert(!f.calls.some((c) => c[0] === 'close'));
  f.props.disabled = true;
  f.props.error = 'Synthetic save failed';
  f.render();
  assert(f.options().every((n) => n.props.disabled));
  assert.equal(f.find('Modal').props.isDismissable, false);
  assert.equal(
    f.find('p', (p) => p.role === 'alert').props.children,
    'Synthetic save failed',
  );
  f.find('Modal').props.onClose();
  assert(!f.calls.some((c) => c[0] === 'close'));
});
