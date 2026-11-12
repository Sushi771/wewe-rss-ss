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
test('terminal unknown is not settling after its worker exits; active writer remains fenced', () => {
  const task = {
    state: 'blocked',
    resumable: false,
    code: 'XHS_DETAIL_OUTCOME_UNKNOWN',
  };
  assert.equal(helpers.taskSettling({ ...task, settling: false }), false);
  assert.equal(helpers.taskSettling({ ...task, settling: true }), true);
  assert.equal(helpers.mayResumeTask({ ...task, settling: false }), false);
  assert.equal(helpers.taskSettling(task), true); // Old servers remain conservative.
  for (const state of [
    { state: 'completed' },
    { state: 'blocked', code: 'XHS_TASK_RECEIPT_UNCERTAIN' },
  ]) {
    assert.equal(
      helpers.taskSettling({ ...task, ...state, settling: true }),
      true,
    );
    assert.equal(
      helpers.taskSettling({ ...task, ...state, settling: false }),
      false,
    );
  }
});
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

test('legacy history exclusion message renders its count without changing evidence', () => {
  const { historyReviewMessage } = load(
    'apps/server/src/collection/xhs-task-message.ts',
  );
  const React = require(
    require.resolve('react', { paths: [path.resolve('apps/web')] }),
  );
  const { renderToStaticMarkup } = require(
    require.resolve('react-dom/server', { paths: [path.resolve('apps/web')] }),
  );
  const runtime = require(
    require.resolve('react/jsx-runtime', { paths: [path.resolve('apps/web')] }),
  );
  const C = load('apps/web/src/components/XhsTaskRecovery.tsx', {
    'react/jsx-runtime': runtime,
    '@nextui-org/react': {
      Button: ({ children }) => React.createElement('button', null, children),
    },
    './SubscriptionPrimitives': {
      SubscriptionProgress: ({ children }) =>
        React.createElement('section', null, children),
    },
    '@web/utils/xiaohongshu-subscription': helpers,
  }).default;
  const literal =
    '历史待核对：${t.historyExcludedIds!.length} 篇，其余基础采集已完成。';
  for (const count of [1, 3]) {
    const stored = record('history', 'partial', {
      kind: 'list',
      total: 131,
      completed: 131,
      skipped: 0,
      remaining: 0,
      code: 'XHS_SCHEDULE_HISTORY_REVIEW_REQUIRED',
      message: literal,
      historyExcludedIds: Array.from(
        { length: count },
        (_, i) => `excluded-${i}`,
      ),
    });
    const before = JSON.stringify(stored);
    const html = renderToStaticMarkup(
      React.createElement(C, {
        tasks: [{ ...stored, message: historyReviewMessage(stored) }],
        loading: false,
        error: false,
        disabled: false,
        selectedTaskId: '',
        open: true,
        onOpenChange() {},
        onRetry() {},
        onSelect() {},
        authorName: () => 'Synthetic author',
      }),
    );
    assert.ok(html.includes(`历史待核对：${count} 篇`));
    assert.doesNotMatch(html, /\$\{|historyExcludedIds/);
    assert.equal(JSON.stringify(stored), before);
  }
  for (const patch of [
    { state: 'blocked' },
    { code: 'XHS_MEDIA_REVIEW_REQUIRED' },
    { historyExcludedIds: [] },
    { historyExcludedIds: [null] },
    { message: 'A different diagnostic' },
    { message: '历史待核对：2 篇，其余基础采集已完成。' },
  ]) {
    const t = {
      state: 'partial',
      code: 'XHS_SCHEDULE_HISTORY_REVIEW_REQUIRED',
      message: literal,
      historyExcludedIds: ['old'],
      ...patch,
    };
    assert.equal(historyReviewMessage(t), t.message);
  }
});

test('new history-review task message evaluates its actual generation branch', () => {
  const src = fs.readFileSync(
    'apps/server/src/collection/xhs-subscription.service.ts',
    'utf8',
  );
  const ast = ts.createSourceFile('service.ts', src, 99, true);
  const matches = [];
  const walk = (n) => {
    if (
      ts.isIfStatement(n) &&
      n.expression.getText(ast) ===
        "t.code === 'XHS_SCHEDULE_HISTORY_REVIEW_REQUIRED'"
    )
      matches.push(n);
    ts.forEachChild(n, walk);
  };
  walk(ast);
  assert.equal(matches.length, 1);
  const js = ts.transpileModule(matches[0].getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2021 },
  }).outputText;
  const generate = new Function('t', js);
  for (const count of [1, 4]) {
    const t = {
      code: 'XHS_SCHEDULE_HISTORY_REVIEW_REQUIRED',
      historyExcludedIds: Array(count).fill('synthetic'),
      message: 'before',
    };
    generate(t);
    assert.equal(t.message, `历史待核对：${count} 篇，其余基础采集已完成。`);
  }
  const other = { code: 'XHS_MEDIA_REVIEW_REQUIRED', message: 'keep' };
  generate(other);
  assert.equal(other.message, 'keep');
});
