'use strict';
// A read-only maintenance readiness contract. It grants no writer lease,
// backup authority, authentication exemption or installation binding.
const assert = require('node:assert/strict');
const path = require('node:path');
async function waitHeldManagementReady(
  port,
  child,
  expected,
  { timeoutMs = 900000, retryMs = 300 } = {},
) {
  assert(
    process.env.WECHAT2RSS_RECOVERY_HOLD === '1' &&
      process.env.PRIVATE_ONLINE_MODE !== '1',
    'HELD_READINESS_MODE_REQUIRED',
  );
  assert(
    expected &&
      /^[A-Za-z0-9_.-]+$/.test(expected.id || '') &&
      /^[a-f0-9]{64}$/.test(expected.sha256 || '') &&
      path.isAbsolute(expected.database || ''),
    'HELD_READINESS_BINDING_REQUIRED',
  );
  assert(
    Number.isInteger(port) &&
      port >= 1024 &&
      port <= 65535 &&
      Number.isSafeInteger(timeoutMs) &&
      timeoutMs > 0 &&
      timeoutMs <= 900000 &&
      Number.isSafeInteger(retryMs) &&
      retryMs > 0,
    'HELD_READINESS_OPTIONS_INVALID',
  );
  const base = `http://127.0.0.1:${port}`,
    deadline = Date.now() + timeoutMs;
  const read = async (route) => {
    const response = await fetch(base + route, {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    return response.json();
  };
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode))
      throw Error('HELD_READINESS_CHILD_EXITED');
    let health, startup;
    try {
      health = await read('/_local/update-health');
      if (health) startup = await read('/startup-status');
    } catch {
      /* Only transport/HTTP readiness is retryable; no source route is used. */
    }
    if (health) {
      assert(
        health.id === expected.id &&
          health.sha256 === expected.sha256 &&
          health.database === expected.database,
        'HELD_READINESS_IDENTITY_MISMATCH',
      );
      if (
        health.httpReady === true &&
        health.databaseReadable === true &&
        health.readOnly === false &&
        startup?.status === 'ready' &&
        startup.writesAllowed === true &&
        startup.databaseRecovery === 'ready'
      )
        return {
          status: 'ready',
          mode: 'held-local-management',
          id: expected.id,
        };
    }
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
  throw Error('HELD_MANAGEMENT_NOT_READY');
}
module.exports = { waitHeldManagementReady };
