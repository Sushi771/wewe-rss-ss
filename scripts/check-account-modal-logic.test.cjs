// Pure code/stylesheet regression: no browser, GUI input, network or app startup.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const web = path.join(root, 'apps/web');
const ts = require(require.resolve('typescript', { paths: [web] }));
const postcss = require(require.resolve('postcss', { paths: [web] }));
const source = fs.readFileSync(
  path.join(web, 'src/pages/accounts/index.tsx'),
  'utf8',
);
const parsed = ts.createSourceFile(
  'accounts.tsx',
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const presses = [];
const modalBodies = [];
function visit(node) {
  if (
    ts.isJsxOpeningElement(node) &&
    node.tagName.getText(parsed) === 'ModalBody'
  )
    modalBodies.push(node);
  if (
    ts.isJsxAttribute(node) &&
    node.name.getText(parsed) === 'onPress' &&
    node.initializer?.expression
  ) {
    presses.push(node.initializer.expression.getText(parsed));
  }
  ts.forEachChild(node, visit);
}
visit(parsed);
test('a modal body remains an explicit named keyboard target when all candidate buttons are disabled', () => {
  const body = modalBodies.find((node) =>
    node.attributes.properties.some(
      (attr) => attr.name?.getText(parsed) === 'tabIndex',
    ),
  );
  assert.ok(body);
  const attrs = Object.fromEntries(
    body.attributes.properties.map((attr) => [
      attr.name?.getText(parsed),
      attr.initializer,
    ]),
  );
  assert.equal(attrs.tabIndex.expression.getText(parsed), '0');
  assert.equal(attrs.role.text, 'region');
  assert.ok(attrs['aria-label'].text.length > 0);
});
const confirmHandler = presses.filter((code) =>
  code.includes('window.confirm'),
);
assert.equal(
  confirmHandler.length,
  1,
  'identify the actual connection confirmation handler',
);
const returnHandler = presses.filter((code) =>
  code.includes('setConnectionAccountId(null)'),
);
assert.equal(returnHandler.length, 1, 'identify the footer return handler');
function loadHandler(code, context) {
  const js = ts.transpileModule(`exports.handler = ${code};`, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  const sandbox = { exports: {}, ...context };
  vm.runInNewContext(js, sandbox, { timeout: 1000 });
  return sandbox.exports.handler;
}
function exercise({ ready = true, isLoading = false, confirmed = true } = {}) {
  const events = [];
  const option = {
    ready,
    mpId: 'MP_WXS_1234567890',
    name: '离线候选',
    revision: 'a'.repeat(64),
  };
  const handler = loadHandler(confirmHandler[0], {
    option,
    connectionAccountId: '2468',
    connection: { data: { accountLabel: '离线昵称' } },
    connectManualRefresh: {
      isLoading,
      mutate: (payload) =>
        events.push(['mutation', JSON.parse(JSON.stringify(payload))]),
    },
    window: {
      confirm: () => {
        events.push(['confirmation']);
        return confirmed;
      },
    },
  });
  handler();
  return events;
}
test('unavailable session/source never opens confirmation or sends a binding mutation', () => {
  assert.deepEqual(exercise({ ready: false }), []);
});
test('an in-progress submission cannot open another confirmation or mutation', () => {
  assert.deepEqual(exercise({ isLoading: true }), []);
});
test('canceling explicit confirmation sends no mutation', () => {
  assert.deepEqual(exercise({ confirmed: false }), [['confirmation']]);
});
test('an eligible confirmed fixture submits exactly the server-issued preview identity and revision', () => {
  assert.deepEqual(exercise(), [
    ['confirmation'],
    [
      'mutation',
      {
        accountId: '2468',
        mpId: 'MP_WXS_1234567890',
        revision: 'a'.repeat(64),
        confirm: true,
      },
    ],
  ]);
});
test('return-to-account-management only closes the modal', () => {
  const updates = [];
  loadHandler(returnHandler[0], {
    setConnectionAccountId: (value) => updates.push(value),
  })();
  assert.deepEqual(updates, [null]);
});

const stylesheet = postcss.parse(
  fs.readFileSync(path.join(web, 'src/index.css'), 'utf8'),
);
function declarations(selector) {
  const result = {};
  stylesheet.walkRules((rule) => {
    if (!rule.selectors.includes(selector)) return;
    rule.walkDecls((decl) => {
      result[decl.prop] = decl.value;
    });
  });
  return result;
}
test('both modal layers outrank the toolbar, while the dialog layer outranks its backdrop', () => {
  const toolbar = Number(declarations('.mac-toolbar')['z-index']);
  const backdrop = Number(
    declarations('.account-connection-backdrop')['z-index'],
  );
  const overlay = Number(
    declarations('.account-connection-overlay')['z-index'],
  );
  assert.ok(backdrop > toolbar && overlay > backdrop);
});
test('the height bound follows the dynamic viewport and leaves room for overlay padding at zoomed/low heights', () => {
  const overlay = declarations('.account-connection-overlay');
  const dialog = declarations('.account-connection-dialog');
  assert.equal(overlay.height, '100dvh');
  const match = /^calc\(100dvh - ([\d.]+)px\)$/.exec(dialog['max-height']);
  assert.ok(
    match,
    'dynamic CSS viewport height is the final fallback override',
  );
  const gap = Number(match[1]);
  assert.ok(gap >= 2 * parseFloat(overlay.padding));
  assert.equal(dialog.margin, '0');
  for (const [height, zoom] of [
    [956, 1],
    [956, 1.25],
    [956, 1.5],
    [956, 2],
    [480, 2],
    [568, 2],
  ]) {
    const cssHeight = height / zoom;
    const bound = cssHeight - gap;
    assert.ok(
      bound > 0 && bound + 2 * parseFloat(overlay.padding) <= cssHeight,
    );
  }
});
test('only the body scrolls; fixed controls do not shrink and the body can shrink below content height', () => {
  assert.equal(declarations('.account-connection-overlay').overflow, 'hidden');
  assert.equal(declarations('.account-connection-dialog').overflow, 'hidden');
  assert.equal(declarations('.account-connection-header')['flex-shrink'], '0');
  assert.equal(declarations('.account-connection-footer')['flex-shrink'], '0');
  const body = declarations('.account-connection-body');
  assert.equal(body['min-height'], '0');
  assert.equal(body['overflow-y'], 'auto');
  assert.equal(body['overscroll-behavior'], 'contain');
});
