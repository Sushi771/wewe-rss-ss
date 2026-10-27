const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createNavigationBarrier, cdpFailure } = require('./cdp-navigation.cjs');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(mode = 'ready') {
  let clock = 0,
    probes = 0,
    barrier;
  const calls = [];
  const frame = (loaderId) =>
    barrier.onEvent({
      method: 'Page.frameNavigated',
      params: { frame: { id: 'main', loaderId } },
    });
  const context = (id, frameId = 'main', isDefault = true) =>
    barrier.onEvent({
      method: 'Runtime.executionContextCreated',
      params: { context: { id, auxData: { frameId, isDefault } } },
    });
  const send = async (method, params, phase, timeoutMs) => {
    calls.push({ method, params, phase, timeoutMs });
    if (method === 'Page.getFrameTree')
      return { frameTree: { frame: { id: 'main', loaderId: 'old' } } };
    if (method === 'Page.navigate' || method === 'Page.reload') {
      frame(mode === 'old-loader' ? 'old' : 'new');
      if (mode === 'iframe') context(2, 'child');
      else if (mode !== 'no-context' && mode !== 'late-context') context(1);
      return method === 'Page.navigate'
        ? { frameId: 'main', loaderId: 'new' }
        : {};
    }
    assert.equal(method, 'Runtime.evaluate');
    assert.equal(params.expression, 'document.readyState');
    assert.equal(params.returnByValue, true);
    probes++;
    if (mode === 'late-success') clock += 201;
    if (mode === 'closed-success') barrier.close();
    if (mode === 'closed') {
      barrier.close();
      throw cdpFailure(method, phase, null, 'closed');
    }
    if (mode === 'destroyed' && probes === 1) {
      barrier.onEvent({
        method: 'Runtime.executionContextDestroyed',
        params: { executionContextId: 1 },
      });
      context(2);
      throw cdpFailure(method, phase, {
        message: 'Inspected target navigated or closed',
      });
    }
    if (mode === 'unproven-error')
      throw cdpFailure(method, phase, {
        message: 'Inspected target navigated or closed',
      });
    if (mode === 'timeout-error') {
      barrier.onEvent({ method: 'Runtime.executionContextsCleared' });
      throw cdpFailure(method, phase, null, 'timeout');
    }
    return { result: { value: 'complete' } };
  };
  barrier = createNavigationBarrier({
    send,
    now: () => clock,
    pause: async (ms) => {
      clock += ms;
      if (mode === 'late-context' && clock === 50) {
        context(9, 'main', false);
        context(3);
      }
    },
  });
  // An old default context must not satisfy the new-document condition.
  context(99);
  return { barrier, calls, elapsed: () => clock };
}

for (const method of ['Page.navigate', 'Page.reload']) {
  test(`${method}: one action waits for the new loader and default context`, async () => {
    const f = fixture('late-context');
    await f.barrier.navigate(
      method,
      method === 'Page.navigate'
        ? { url: 'http://127.0.0.1:1/synthetic' }
        : { ignoreCache: true },
      'initial-navigation',
      200,
    );
    assert.equal(f.calls.filter((c) => c.method === method).length, 1);
    const probes = f.calls.filter((c) => c.method === 'Runtime.evaluate');
    assert.deepEqual(
      probes.map((c) => c.params.contextId),
      [3],
    );
    assert.equal(f.elapsed(), 50);
    assert(f.calls.every((c) => c.timeoutMs > 0 && c.timeoutMs <= 200));
  });
}

test('a protocol-confirmed destroyed context permits only another read-only probe', async () => {
  const f = fixture('destroyed');
  await f.barrier.navigate(
    'Page.reload',
    { ignoreCache: true },
    'switch-reload',
    200,
  );
  assert.equal(f.calls.filter((c) => c.method === 'Page.reload').length, 1);
  assert.deepEqual(
    f.calls
      .filter((c) => c.method === 'Runtime.evaluate')
      .map((c) => c.params.contextId),
    [1, 2],
  );
});

test('a truly closed target fails immediately without replaying navigation or probing again', async () => {
  const f = fixture('closed');
  await assert.rejects(
    f.barrier.navigate('Page.reload', {}, 'switch-reload', 200),
    { code: 'CDP_TARGET_CLOSED' },
  );
  assert.equal(f.calls.filter((c) => c.method === 'Page.reload').length, 1);
  assert.equal(
    f.calls.filter((c) => c.method === 'Runtime.evaluate').length,
    1,
  );
  assert.equal(f.elapsed(), 0);
  await assert.rejects(
    f.barrier.navigate('Page.reload', {}, 'switch-reload', 200),
    { code: 'CDP_TARGET_CLOSED' },
  );
  assert.equal(f.calls.filter((c) => c.method === 'Page.reload').length, 1);
});

test('an ambiguous navigated-or-closed error without invalidation evidence is not swallowed', async () => {
  const f = fixture('unproven-error');
  await assert.rejects(
    f.barrier.navigate('Page.navigate', {}, 'initial-navigation', 200),
    { code: 'CDP_TARGET_NAVIGATED_OR_CLOSED' },
  );
  assert.equal(
    f.calls.filter((c) => c.method === 'Runtime.evaluate').length,
    1,
  );
  assert.equal(f.elapsed(), 0);
});

for (const [mode, code] of [
  ['late-success', 'CDP_TIMEOUT'],
  ['closed-success', 'CDP_TARGET_CLOSED'],
]) {
  test(`${mode}: a successful probe cannot override the deadline or target close`, async () => {
    const f = fixture(mode);
    await assert.rejects(
      f.barrier.navigate('Page.reload', {}, 'switch-reload', 200),
      { code },
    );
    assert.equal(f.calls.filter((c) => c.method === 'Page.reload').length, 1);
    assert.equal(
      f.calls.filter((c) => c.method === 'Runtime.evaluate').length,
      1,
    );
  });
}

for (const mode of ['no-context', 'iframe', 'old-loader']) {
  test(`${mode}: readiness times out and never evaluates the old or iframe context`, async () => {
    const f = fixture(mode);
    await assert.rejects(
      f.barrier.navigate('Page.reload', {}, 'switch-reload', 200),
      { code: 'CDP_TIMEOUT' },
    );
    assert.equal(f.calls.filter((c) => c.method === 'Page.reload').length, 1);
    assert.equal(
      f.calls.filter((c) => c.method === 'Runtime.evaluate').length,
      0,
    );
    assert.equal(f.elapsed(), 200);
  });
}

test('even an invalidated context cannot turn a command timeout into another probe', async () => {
  const f = fixture('timeout-error');
  await assert.rejects(
    f.barrier.navigate('Page.reload', {}, 'switch-reload', 200),
    { code: 'CDP_TIMEOUT' },
  );
  assert.equal(
    f.calls.filter((c) => c.method === 'Runtime.evaluate').length,
    1,
  );
});

test('protocol diagnostics contain only fixed method/phase/code, never raw error, URL or expression', () => {
  const failure = cdpFailure('Runtime.evaluate', 'initial-navigation', {
    message: 'private-expression https://example.invalid/?token=secret',
  });
  assert.equal(
    failure.message,
    'CDP_PROTOCOL_ERROR method=Runtime.evaluate phase=initial-navigation',
  );
  assert.equal(
    cdpFailure('private-expression', 'token=secret', null).message,
    'CDP_PROTOCOL_ERROR method=UNKNOWN phase=unknown',
  );
});

function browserAdapter() {
  const source = fs.readFileSync(
    path.join(__dirname, 'xhs-note-data-browser.test.cjs'),
    'utf8',
  );
  const start = source.indexOf('    let id = 0;');
  const end = source.indexOf('    const ev = async', start);
  assert(start > 0 && end > start);
  const listeners = new Map(),
    calls = [],
    timers = new Set();
  const ws = {
    readyState: 1,
    send: (message) => calls.push(JSON.parse(message)),
    addEventListener: (name, callback) => listeners.set(name, callback),
  };
  const adapter = vm.runInNewContext(
    source.slice(start, end) + '\n({send,pending});',
    {
      ws,
      WebSocket: { OPEN: 1 },
      cdpFailure,
      createNavigationBarrier,
      setTimeout: (callback) => {
        timers.add(callback);
        return callback;
      },
      clearTimeout: (callback) => timers.delete(callback),
    },
  );
  return { adapter, listeners, calls, timers, ws };
}

test('actual browser pending handler records method/phase but omits request expressions and redacts protocol errors', async () => {
  const f = browserAdapter();
  const result = f.adapter.send(
    'Runtime.evaluate',
    { expression: 'private-expression' },
    'initial-navigation',
  );
  const pending = [...f.adapter.pending.values()][0];
  assert.deepEqual(Object.keys(pending).sort(), [
    'method',
    'phase',
    'reject',
    'resolve',
    'timer',
  ]);
  assert.equal(pending.method, 'Runtime.evaluate');
  assert.equal(pending.phase, 'initial-navigation');
  f.listeners.get('message')({
    data: JSON.stringify({
      id: f.calls[0].id,
      error: {
        message: 'private-expression https://example.invalid/?token=secret',
      },
    }),
  });
  await assert.rejects(result, {
    message:
      'CDP_PROTOCOL_ERROR method=Runtime.evaluate phase=initial-navigation',
  });
  assert.equal(f.adapter.pending.size, 0);
  assert.equal(f.timers.size, 0);
});

test('actual socket close rejects outstanding probes once and releases their timers', async () => {
  const f = browserAdapter();
  const result = f.adapter.send(
    'Runtime.evaluate',
    { expression: 'document.readyState' },
    'switch-reload',
  );
  f.ws.readyState = 3;
  f.listeners.get('close')();
  await assert.rejects(result, {
    message: 'CDP_TARGET_CLOSED method=Runtime.evaluate phase=switch-reload',
  });
  assert.equal(f.adapter.pending.size, 0);
  assert.equal(f.timers.size, 0);
  await assert.rejects(f.adapter.send('Page.reload'), {
    code: 'CDP_TARGET_CLOSED',
  });
  assert.equal(f.calls.length, 1);
});
