const fs = require('node:fs'),
  vm = require('node:vm'),
  assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const ts = require(
  require.resolve('typescript', { paths: [path.join(root, 'apps/server')] }),
);
const source = fs.readFileSync(
  path.join(__dirname, 'overlay-matrix-browser.test.cjs'),
  'utf8',
);
const ast = ts.createSourceFile(
  'browser.cjs',
  source,
  ts.ScriptTarget.Latest,
  true,
);
const helper = ast.statements.find(
  (n) => ts.isFunctionDeclaration(n) && n.name?.text === 'waitPopoverClickable',
);
let click;
function visit(n) {
  if (ts.isVariableDeclaration(n) && n.name.getText(ast) === 'click') {
    assert.equal(click, undefined);
    click = n.initializer;
  }
  ts.forEachChild(n, visit);
}
visit(ast);
assert.ok(helper && click);
async function run(mode, stablePopover = true) {
  let now = 0,
    frame = 0,
    pressed = false;
  const events = [];
  const listeners = new Map();
  const pointerClicks = [];
  const body = { children: [] },
    popover = {
      isConnected: true,
      outerHTML: '<div data-slot="content" data-open="true"></div>',
      parentElement: body,
      getAnimations: () => [],
    };
  const animated = { parentElement: popover, getAnimations: () => [] };
  const target = {
    isConnected: true,
    disabled: false,
    parentElement: animated,
    outerHTML: '<button id="target">repair</button>',
    getAnimations: () => [],
    getAttribute: () => null,
    closest: () => popover,
    scrollIntoView() {},
    contains: (e) => e === target,
    getBoundingClientRect() {
      const scale = mode === 'transient' && frame < 4 ? 0.8 : 1;
      return {
        x: mode === 'press-move' && pressed ? 140 : 100,
        y: 100,
        width: 100 * scale,
        height: 40 * scale,
      };
    },
  };
  const browser = {
    window: null,
    document: {
      body,
      addEventListener: (type, fn) => listeners.set(type, fn),
      removeEventListener: (type, fn) => {
        assert.equal(listeners.get(type), fn);
        listeners.delete(type);
      },
      querySelector: (s) =>
        s === '.app-shell' ? { scrollHeight: 900 } : target,
      elementFromPoint() {
        frame++;
        if (
          mode === 'persistent' ||
          (mode === 'release-block' && pressed) ||
          (mode === 'transient' && frame < 5) ||
          (mode === 'late-block' && frame >= 4)
        )
          return popover;
        return target;
      },
    },
    getComputedStyle: (n) => ({
      display: 'block',
      visibility: 'visible',
      opacity: mode === 'transient' && frame < 4 && n === animated ? '0' : '1',
      pointerEvents: 'auto',
    }),
  };
  browser.window = browser;
  vm.createContext(browser);
  const context = {
    assert,
    pointerClicks,
    Date: { now: () => now },
    pause: async (ms) => {
      now += ms;
    },
    ev: async (expression) => vm.runInContext(expression, browser),
    send: async (method, params) => {
      events.push({ method, ...params });
      pressed ||= params.type === 'mousePressed';
      const types = params.type === 'mousePressed' ? ['pointerdown'] : ['pointerup', 'click'];
      for (const type of types)
        listeners.get(type)?.({ type, target, clientX: params.x, clientY: params.y });
    },
  };
  vm.createContext(context);
  vm.runInContext(
    helper.getText(ast) + '\nglobalThis.click=' + click.getText(ast) + ';',
    context,
  );
  const action = context.click("document.querySelector('#target')", stablePopover);
  if (mode === 'transient' || mode === 'stable') {
    await action;
    assert.equal(events.length, 2);
    assert.deepEqual(
      events.map((e) => e.type),
      ['mousePressed', 'mouseReleased'],
    );
    assert.equal(events[0].clickCount, 1);
    assert.equal(events[1].clickCount, 1);
    if (mode === 'transient') assert.ok(frame >= 7);
    assert.equal(browser.__overlayClickPin, undefined);
    assert.equal(listeners.size, 0);
    if (stablePopover) assert.deepEqual(Array.from(pointerClicks[0].events, (e) => e.type), ['pointerdown', 'pointerup', 'click']);
    else assert.equal(pointerClicks.length, 0);
  } else {
    await assert.rejects(action);
    assert.equal(
      events.length,
      ['press-move', 'release-block'].includes(mode) ? 1 : 0,
      'failed stability/hit may not send an additional mouse event',
    );
    if (mode === 'persistent') assert.ok(now >= 3000 && now <= 3050);
  }
  return {
    mode,
    frames: frame,
    mouseEvents: events.length,
    elapsedVirtualMs: now,
  };
}
test('transient popover animation settles before exactly one CDP mouse press/release', async () => {
  await run('transient');
});

test('xhs export uses the visible toolbar target for one checked pointer click', async () => {
  let exportCase, exportClick;
  function findCase(n) {
    if (ts.isCallExpression(n) && n.expression.getText(ast) === 'run' &&
        n.arguments[0]?.text === 'xhs-export') exportCase = n.arguments[1];
    ts.forEachChild(n, findCase);
  }
  findCase(ast);
  assert.ok(exportCase);
  function findClick(n) {
    if (ts.isCallExpression(n) && n.expression.getText(ast) === 'click' &&
        ts.isCallExpression(n.arguments[0]) &&
        n.arguments[0].expression.getText(ast) === 'button' &&
        n.arguments[0].arguments[0]?.text === '导出笔记') exportClick = n;
    ts.forEachChild(n, findClick);
  }
  findClick(exportCase);
  assert.ok(exportClick);
  assert.equal(exportClick.arguments.length, 1, 'toolbar target does not use popover-only readiness');
  await run('stable', false);
});
test('persistent popover obstruction fails within the bound without a mouse event', async () => {
  await run('persistent');
});
test('the final hit assertion rejects a new obstruction after stability', async () => {
  await run('late-block');
});

test('a stable popover records one press/release and the actual pointer event sequence', async () => {
  await run('stable');
});

test('movement after press fails before releasing at the stale position without another click', async () => {
  await run('press-move');
});

test('obstruction after press fails before release without repeating the press', async () => {
  await run('release-block');
});

test('all three import scenarios use the pinned popover wait without adding a click retry', () => {
  const calls = [];
  function collect(n) {
    if (ts.isCallExpression(n) && n.expression.getText(ast) === 'click') {
      const button = n.arguments[0];
      if (button && ts.isCallExpression(button) &&
          button.expression.getText(ast) === 'button' &&
          button.arguments[0]?.text === '\u5bfc\u5165\u5df2\u6709\u6587\u4ef6') calls.push(n);
    }
    ts.forEachChild(n, collect);
  }
  collect(ast);
  assert.equal(calls.length, 3);
  for (const call of calls) assert.equal(call.arguments[1]?.kind, ts.SyntaxKind.TrueKeyword);
  assert.equal((click.getText(ast).match(/send\('Input.dispatchMouseEvent'/g) || []).length, 2);
  assert.match(source, /await modalMatrix\('wechat-import'\)/);
  assert.match(source, /await modalMatrix\('wechat-import-long'\)/);
  assert.match(source, /await modalMatrix\('toast-with-import'\)/);
});

test('CI retains only synthetic failure evidence and never uploads the temporary profile', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/responsive-reading-ci.yml'), 'utf8');
  assert.match(workflow, /id: overlay-matrix/);
  assert.match(workflow, /if: failure\(\) && steps\.overlay-matrix\.outputs\.evidence != ''/);
  const block = workflow.split('name: Preserve failed synthetic overlay evidence')[1].split('- name:')[0];
  assert.match(block, /\/failure\*\.json/);
  assert.match(block, /\/failure\*\.png/);
  assert.match(block, /\/result\.json/);
  assert.doesNotMatch(block, /profile|path: \$\{\{[^\n]+\}\}\s*\n/);
});
