const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const ts = require(
  require.resolve('typescript', { paths: [path.resolve('apps/web')] }),
);
function fixture() {
  const slots = [],
    calls = [];
  let index = 0,
    refreshes = 0;
  const react = {
    useState(value) {
      const i = index++;
      if (!(i in slots))
        slots[i] = typeof value === 'function' ? value() : value;
      return [
        slots[i],
        (v) => {
          slots[i] = typeof v === 'function' ? v(slots[i]) : v;
        },
      ];
    },
    useRef(value) {
      return { current: value };
    },
  };
  const mutation = (name) => ({
    useMutation: () => ({
      isLoading: false,
      mutateAsync: async (input) => {
        calls.push([name, input]);
        return name === 'prepare'
          ? {
              digest: 'a'.repeat(64),
              taskId: 'synthetic-task',
              creatorId: 'synthetic-creator',
              noteKey: 'synthetic-note',
            }
          : { state: 'confirmed' };
      },
    }),
  });
  const trpc = {
    xiaohongshu: {
      prepareLegacyPendingOwnerReview: mutation('prepare'),
      confirmLegacyPendingOwnerReview: mutation('confirm'),
    },
  };
  const jsx = (type, props) => ({ type, props: props || {} }),
    mod = { exports: {} };
  const source = fs.readFileSync(
    'apps/web/src/components/XhsWholeCreator.tsx',
    'utf8',
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2021,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  new Function('require', 'exports', 'module', output)(
    (name) => {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name === '@web/utils/trpc') return { trpc };
      throw Error('unexpected dependency ' + name);
    },
    mod.exports,
    mod,
  );
  const render = () => {
    index = 0;
    return mod.exports.XhsLegacyPendingOwnerReview({
      refresh: async () => {
        refreshes++;
      },
    });
  };
  const all = (node) =>
    node == null
      ? []
      : Array.isArray(node)
        ? node.flatMap(all)
        : typeof node === 'object'
          ? [node, ...all(node.props?.children)]
          : [node];
  const elements = () => all(render());
  const button = (label) =>
    elements().find(
      (x) => x && x.type === 'button' && all(x.props.children).includes(label),
    );
  return { calls, elements, button, refreshes: () => refreshes };
}
test('requires explicit acknowledgement and warns the owner target is unproved', async () => {
  const f = fixture();
  const text = f
    .elements()
    .filter((x) => typeof x === 'string')
    .join(' ');
  assert.match(text, /任何账号、列表、正文或媒体页面/);
  assert.match(text, /不能证明/);
  assert.equal(f.button('确认并恢复'), undefined);
  await f.button('核查当前状态').props.onClick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.button('确认并恢复').props.disabled, true);
  const check = f
    .elements()
    .find((x) => x && x.type === 'input' && x.props.type === 'checkbox');
  check.props.onChange({ target: { checked: true } });
  assert.equal(f.button('确认并恢复').props.disabled, false);
  await f.button('确认并恢复').props.onClick();
  assert.deepEqual(f.calls[1], [
    'confirm',
    { digest: 'a'.repeat(64), acknowledgedUnknownScope: true },
  ]);
  assert.equal(f.refreshes(), 1);
});
