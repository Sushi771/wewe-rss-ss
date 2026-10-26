const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require(
  require.resolve('typescript', { paths: [path.resolve('apps/web')] }),
);
function load(file, imports = {}) {
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2021,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  new Function('require', 'exports', 'module', output)(
    (name) => {
      assert.ok(name in imports, `unexpected dependency ${name}`);
      return imports[name];
    },
    mod.exports,
    mod,
  );
  return mod.exports;
}
const helpers = load('apps/web/src/utils/xiaohongshu-subscription.ts');
const jsx = (type, props) =>
  typeof type === 'function' ? type(props || {}) : { type, props: props || {} };
const primitives = load('apps/web/src/components/SubscriptionPrimitives.tsx', {
  'react/jsx-runtime': { jsx, jsxs: jsx },
  '@web/components/AppOverlays': {
    Modal: 'Modal',
    Popover: 'Popover',
    Tooltip: 'Tooltip',
  },
  '@nextui-org/react': Object.fromEntries(
    ['Button', 'Checkbox', 'PopoverContent', 'PopoverTrigger', 'Progress'].map(
      (name) => [name, name],
    ),
  ),
});
const Recovery = load('apps/web/src/components/XhsTaskRecovery.tsx', {
  'react/jsx-runtime': { jsx, jsxs: jsx },
  '@nextui-org/react': { Button: 'Button' },
  './SubscriptionPrimitives': primitives,
  '@web/utils/xiaohongshu-subscription': helpers,
}).default;
const all = (node) =>
  node == null
    ? []
    : Array.isArray(node)
      ? node.flatMap(all)
      : typeof node === 'object'
        ? [node, ...all(node.props?.children)]
        : [node];
const record = (taskId, state, extra = {}) => ({
  taskId,
  creatorId: 'synthetic-author',
  kind: 'download',
  state,
  total: 8,
  completed: 3,
  skipped: 1,
  failed: 0,
  remaining: 4,
  message: '合成任务',
  ...extra,
});
test('reload discovery chooses active before resumable history and never treats completed work as resumable', () => {
  const completed = record('done', 'completed', { remaining: 0 }),
    cancelled = record('cancelled', 'cancelled', { resumable: true }),
    running = record('active', 'running');
  assert.equal(
    helpers.preferredRecoveredTask([completed, cancelled, running]),
    running,
  );
  assert.equal(
    helpers.preferredRecoveredTask([completed, cancelled]),
    cancelled,
  );
  assert.equal(helpers.preferredRecoveredTask([completed]), undefined);
});
test('a late discovery response cannot replace a newly started operation or a deliberate recovery selection', () => {
  const base = {
    requestedGeneration: 1,
    currentGeneration: 1,
    busy: false,
    alreadyRecovered: false,
  };
  assert.equal(helpers.canAdoptRecoveredTask(base), true);
  assert.equal(
    helpers.canAdoptRecoveredTask({ ...base, currentGeneration: 2 }),
    false,
  );
  assert.equal(helpers.canAdoptRecoveredTask({ ...base, busy: true }), false);
  assert.equal(
    helpers.canAdoptRecoveredTask({ ...base, alreadyRecovered: true }),
    false,
  );
});
test('task history exposes remaining work and read/retry actions only; continuation is not invoked on render', () => {
  const selected = [],
    retry = [];
  const nodes = all(
    Recovery({
      tasks: [record('old', 'cancelled', { resumable: true })],
      loading: false,
      error: false,
      disabled: false,
      selectedTaskId: '',
      open: true,
      onOpenChange() {},
      onRetry: () => retry.push('read'),
      onSelect: (task) => selected.push(task.taskId),
      authorName: () => '合成作者',
    }),
  );
  assert.deepEqual(selected, []);
  assert.deepEqual(retry, []);
  assert.ok(nodes.some((n) => typeof n === 'string' && n.includes('剩余 4')));
  nodes
    .find((n) => n.type === 'Button' && n.props.children === '查看未完成任务')
    .props.onPress();
  assert.deepEqual(selected, ['old']);
  nodes
    .find((n) => n.type === 'Button' && n.props.children === '重新读取任务')
    .props.onPress();
  assert.deepEqual(retry, ['read']);
});
test('failed task has a comprehensible connection/directory next step without inventing platform success', () => {
  assert.match(
    helpers.taskNextStep(
      record('blocked', 'blocked', {
        code: 'XHS_SOURCE_AUTHENTICATION_BLOCKED',
        resumable: true,
      }),
    ),
    /本机安全工具/,
  );
  assert.match(
    helpers.taskNextStep(
      record('failed', 'failed', {
        code: 'XHS_RESUME_DIRECTORY_CHANGED',
        resumable: true,
      }),
    ),
    /原来的保存目录/,
  );
  assert.match(
    helpers.taskNextStep(record('settling', 'cancelled', { resumable: false })),
    /正在结束当前保存/,
  );
});
test('shared progress Escape collapses and returns focus to its summary without changing task or selection', () => {
  let closed,
    focused = 0,
    prevented = 0,
    stopped = 0;
  const tree = primitives.SubscriptionProgress({
    ariaLabel: '合成任务',
    value: 1,
    total: 2,
    label: '合成任务',
    progressLabel: '进度',
    open: true,
    onOpenChange: (value) => (closed = value),
    summary: '收起进度',
    children: 'remaining',
  });
  tree.props.onKeyDown({
    key: 'Escape',
    preventDefault: () => prevented++,
    stopPropagation: () => stopped++,
    currentTarget: { querySelector: () => ({ focus: () => focused++ }) },
  });
  assert.equal(closed, false);
  assert.equal(focused, 1);
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);
});
