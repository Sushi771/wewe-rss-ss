// Test-only CDP navigation: one action, then bounded read-only new-document probes.
const { performance } = require('node:perf_hooks');

function cdpFailure(method, phase, error, kind = 'protocol') {
  const safeMethod =
    /^(Page|Runtime|Network|Input|Emulation|Browser)\.[A-Za-z]+$/.test(method)
      ? method
      : 'UNKNOWN';
  const safePhase = [
    'scenario',
    'initial-navigation',
    'switch-reload',
    'recovery-reload',
  ].includes(phase)
    ? phase
    : 'unknown';
  const text = String(error?.message || '');
  const code =
    kind === 'closed'
      ? 'CDP_TARGET_CLOSED'
      : kind === 'timeout'
        ? 'CDP_TIMEOUT'
        : /^(Execution context was destroyed(?:\.|,.*)?|Cannot find context with specified id\.?)$/.test(
              text,
            )
          ? 'CDP_CONTEXT_DESTROYED'
          : text === 'Inspected target navigated or closed'
            ? 'CDP_TARGET_NAVIGATED_OR_CLOSED'
            : 'CDP_PROTOCOL_ERROR';
  const failure = Error(`${code} method=${safeMethod} phase=${safePhase}`);
  failure.code = code;
  return failure;
}

function createNavigationBarrier({
  send,
  now = () => performance.now(),
  pause = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  let root,
    closed = false,
    serial = 0;
  const contexts = new Map();
  function onEvent(message) {
    serial++;
    const p = message.params || {};
    if (message.method === 'Page.frameNavigated' && !p.frame.parentId)
      root = p.frame;
    if (message.method === 'Runtime.executionContextsCleared') contexts.clear();
    if (message.method === 'Runtime.executionContextDestroyed')
      contexts.delete(p.executionContextId);
    if (message.method === 'Runtime.executionContextCreated') {
      const context = p.context;
      if (context.auxData?.isDefault)
        contexts.set(context.id, { frameId: context.auxData.frameId, serial });
    }
  }
  async function navigate(method, params, phase, timeoutMs = 10000) {
    if (
      !['Page.navigate', 'Page.reload'].includes(method) ||
      !['initial-navigation', 'switch-reload', 'recovery-reload'].includes(
        phase,
      ) ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 10000
    )
      throw Error('CDP_INVALID_NAVIGATION_BARRIER');
    const deadline = now() + timeoutMs;
    const remaining = () => Math.max(1, Math.ceil(deadline - now()));
    const checkOpen = () => {
      if (closed) throw cdpFailure(method, phase, null, 'closed');
      if (now() >= deadline) throw cdpFailure(method, phase, null, 'timeout');
    };
    checkOpen();
    const before = (await send('Page.getFrameTree', {}, phase, remaining()))
      .frameTree.frame;
    root = before;
    const started = serial;
    checkOpen();
    // Never replay this command, including after a timeout or lost acknowledgement.
    const result = await send(method, params, phase, remaining());
    if (result.errorText) throw cdpFailure(method, phase, null);
    const frameId = result.frameId || before.id;
    for (;;) {
      checkOpen();
      const loader = root?.loaderId;
      if (
        root?.id === frameId &&
        loader &&
        loader !== before.loaderId &&
        (!result.loaderId || loader === result.loaderId)
      ) {
        const candidate = [...contexts].find(
          ([, c]) => c.frameId === frameId && c.serial > started,
        );
        if (candidate) {
          const [contextId] = candidate;
          try {
            const probe = await send(
              'Runtime.evaluate',
              {
                expression: 'document.readyState',
                contextId,
                returnByValue: true,
              },
              phase,
              remaining(),
            );
            checkOpen();
            if (probe.exceptionDetails)
              throw cdpFailure('Runtime.evaluate', phase, null);
            if (
              contexts.has(contextId) &&
              root?.loaderId === loader &&
              ['interactive', 'complete'].includes(probe.result?.value)
            )
              return;
          } catch (error) {
            // Only a protocol-confirmed stale context may be probed again.
            // A close, timeout, unknown error, or unchanged context still fails.
            const stale = !contexts.has(contextId) || root?.loaderId !== loader;
            if (
              closed ||
              !stale ||
              ![
                'CDP_CONTEXT_DESTROYED',
                'CDP_TARGET_NAVIGATED_OR_CLOSED',
              ].includes(error.code)
            )
              throw error;
          }
        }
      }
      checkOpen();
      await pause(Math.min(50, remaining()));
    }
  }
  return {
    onEvent,
    navigate,
    close() {
      closed = true;
    },
  };
}

module.exports = { cdpFailure, createNavigationBarrier };
