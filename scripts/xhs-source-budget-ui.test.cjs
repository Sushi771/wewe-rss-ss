const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const ts = require(
  require.resolve('typescript', { paths: [path.resolve('apps/web')] }),
);
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(api, scope = { purpose: 'resolution' }) {
  const slots = [],
    cleanups = [],
    effects = [];
  let index = 0;
  const react = {
    useState(value) {
      const i = index++;
      if (!(i in slots)) slots[i] = value;
      return [slots[i], (v) => (slots[i] = v)];
    },
    useRef(value) {
      const i = index++;
      return slots[i] ?? (slots[i] = { current: value });
    },
    useEffect(fn) {
      if (!cleanups.length) effects.push(fn);
    },
  };
  const jsx = (type, props) => ({ type, props }),
    mod = { exports: {} };
  new Function(
    'require',
    'exports',
    'module',
    ts.transpileModule(
      fs.readFileSync('apps/web/src/components/XhsSourceBudget.tsx', 'utf8'),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          jsx: ts.JsxEmit.ReactJSX,
        },
      },
    ).outputText,
  )((n) => (n === 'react' ? react : { jsx, jsxs: jsx }), mod.exports, mod);
  const all = (n) =>
    n == null
      ? []
      : Array.isArray(n)
        ? n.flatMap(all)
        : typeof n === 'object'
          ? [n, ...all(n.props?.children)]
          : [n];
  return {
    slots,
    render() {
      index = 0;
      const tree = all(mod.exports.default({ api, scope }));
      while (effects.length) cleanups.push(effects.shift()());
      return tree;
    },
    unmount() {
      cleanups.forEach((f) => f?.());
    },
  };
}
test('stable scope loads existing remaining quota; only explicit save mutates and repeated clicks are locked', async () => {
  const calls = [];
  let finish;
  const scope = { purpose: 'original-link', creatorId: 'synthetic-owner' };
  const f = fixture(
    {
      sourceRequestBudget: {
        query: async (input) => {
          calls.push(['read', input]);
          return {
            budgetId: 'b',
            limit: 10,
            used: 4,
            remaining: 6,
            nextAt: 0,
            intervalMs: 5000,
          };
        },
      },
      configureSourceRequestBudget: {
        mutate: (input) => {
          calls.push(['configure', input]);
          return new Promise((r) => (finish = r));
        },
      },
    },
    scope,
  );
  f.render();
  await tick();
  let tree = f.render();
  assert.deepEqual(calls, [['read', scope]]);
  assert(
    tree.some(
      (n) => typeof n === 'string' && n.includes('剩余 6 次 / 总计 10 次'),
    ),
  );
  tree
    .find((n) => n.props?.['aria-label'] === '来源请求总额度')
    .props.onChange({ target: { value: '20' } });
  tree = f.render();
  const submit = tree.find((n) => n.type === 'form').props.onSubmit;
  submit({ preventDefault() {} });
  submit({ preventDefault() {} });
  assert.deepEqual(calls[1], [
    'configure',
    { scope, totalLimit: 20, intervalMs: 5000 },
  ]);
  assert.equal(calls.length, 2);
  finish({
    budgetId: 'b',
    limit: 20,
    used: 4,
    remaining: 16,
    nextAt: 0,
    intervalMs: 5000,
  });
  await tick();
  assert(
    f
      .render()
      .some(
        (n) => typeof n === 'string' && n.includes('剩余 16 次 / 总计 20 次'),
      ),
  );
});
test('invalid totals cannot reduce used count, and late local reads cannot replace explicitly saved quota', async () => {
  let read, save;
  const calls = [];
  const f = fixture({
    sourceRequestBudget: { query: () => new Promise((r) => (read = r)) },
    configureSourceRequestBudget: {
      mutate: (input) => {
        calls.push(input);
        return new Promise((r) => (save = r));
      },
    },
  });
  let tree = f.render();
  tree
    .find((n) => n.props?.['aria-label'] === '来源请求总额度')
    .props.onChange({ target: { value: '20' } });
  tree = f.render();
  tree.find((n) => n.type === 'form').props.onSubmit({ preventDefault() {} });
  save({
    budgetId: 'b',
    limit: 20,
    used: 4,
    remaining: 16,
    nextAt: 0,
    intervalMs: 5000,
  });
  await tick();
  read({
    budgetId: 'b',
    limit: 10,
    used: 1,
    remaining: 9,
    nextAt: 0,
    intervalMs: 1000,
  });
  await tick();
  tree = f.render();
  assert(tree.some((n) => typeof n === 'string' && n.includes('剩余 16 次')));
  tree
    .find((n) => n.props?.['aria-label'] === '来源请求总额度')
    .props.onChange({ target: { value: '3' } });
  tree = f.render();
  tree.find((n) => n.type === 'form').props.onSubmit({ preventDefault() {} });
  await tick();
  assert.equal(calls.length, 1);
  assert(f.render().some((n) => n.props?.role === 'alert'));
});
test('a scope unmounted while saving cannot update its replacement', async () => {
  let finish;
  const f = fixture({
    sourceRequestBudget: { query: async () => null },
    configureSourceRequestBudget: {
      mutate: () => new Promise((r) => (finish = r)),
    },
  });
  f.render();
  await tick();
  let tree = f.render();
  tree
    .find((n) => n.props?.['aria-label'] === '来源请求总额度')
    .props.onChange({ target: { value: '20' } });
  tree = f.render();
  tree.find((n) => n.type === 'form').props.onSubmit({ preventDefault() {} });
  f.unmount();
  finish({
    budgetId: 'b',
    limit: 20,
    used: 0,
    remaining: 20,
    nextAt: 0,
    intervalMs: 5000,
  });
  await tick();
  assert.equal(f.slots[0], null);
});
