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
async function run(mode) {
  let now = 0,
    frame = 0;
  const events = [];
  const body = { children: [] },
    popover = {
      isConnected: true,
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
      return { x: 100, y: 100, width: 100 * scale, height: 40 * scale };
    },
  };
  const browser = {
    window: null,
    document: {
      body,
      querySelector: (s) =>
        s === '.app-shell' ? { scrollHeight: 900 } : target,
      elementFromPoint() {
        frame++;
        if (
          mode === 'persistent' ||
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
    Date: { now: () => now },
    pause: async (ms) => {
      now += ms;
    },
    ev: async (expression) => vm.runInContext(expression, browser),
    send: async (method, params) => {
      events.push({ method, ...params });
    },
  };
  vm.createContext(context);
  vm.runInContext(
    helper.getText(ast) + '\nglobalThis.click=' + click.getText(ast) + ';',
    context,
  );
  const action = context.click("document.querySelector('#target')", true);
  if (mode === 'transient') {
    await action;
    assert.equal(events.length, 2);
    assert.deepEqual(
      events.map((e) => e.type),
      ['mousePressed', 'mouseReleased'],
    );
    assert.equal(events[0].clickCount, 1);
    assert.equal(events[1].clickCount, 1);
    assert.ok(frame >= 7);
    assert.equal(browser.__overlayClickPin, undefined);
  } else {
    await assert.rejects(action);
    assert.equal(
      events.length,
      0,
      'failed hit/stability may not send a mouse event',
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
test('persistent popover obstruction fails within the bound without a mouse event', async () => {
  await run('persistent');
});
test('the final hit assertion rejects a new obstruction after stability', async () => {
  await run('late-block');
});
