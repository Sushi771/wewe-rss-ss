'use strict';
const { randomUUID } = require('node:crypto');
const { createInterface } = require('node:readline');

/** Private existing owner pipe, not a public HTTP/JSON receipt endpoint. */
function exchange(child, operation, payload = {}) {
  if (!child?.stdin?.writable)
    return Promise.reject(Error('History owner unavailable'));
  const id = `history-${randomUUID()}`;
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    const close = () => finish(Error('History owner closed'));
    const timer = setTimeout(
      () => finish(Error('History owner review timed out')),
      350000,
    );
    const finish = (error, result) => {
      clearTimeout(timer);
      lines.close();
      child.off('close', close);
      error ? reject(error) : resolve(result);
    };
    child.once('close', close);
    lines.on('line', (line) => {
      if (Buffer.byteLength(line) > 256 * 1024) {
        finish(Error('History response too large'));
        return;
      }
      try {
        const value = JSON.parse(line);
        if (value.id !== id) return;
        if (
          !value.result ||
          typeof value.result !== 'object' ||
          value.result.reason
        ) {
          const code = /^[A-Z_]{1,80}$/.test(value.result?.reason || '')
            ? value.result.reason
            : 'UNPROVED';
          finish(Error('History owner review blocked: ' + code));
          return;
        }
        finish(null, value.result);
      } catch {
        finish(Error('History owner protocol failed'));
      }
    });
    child.stdin.write(JSON.stringify({ id, operation, ...payload }) + '\n');
  });
}

/** The application's REAL admission coordinator fences all writes/backups while
 * capturing process-local backup-reuse references and issuing the review. Other
 * candidate-file jobs must pin BEFORE enqueue; live DB exports are protected by
 * owner.database. This cannot authorize or perform permanent deletion. */
async function withRuntimeReferences(
  { coordinator, activeBackupReferences, request },
  operation,
  payload,
) {
  return coordinator.snapshot(async () => {
    const paths = activeBackupReferences();
    const synced = await request('history-sync', {
      runtime: {
        format: 'wewe-history-runtime-v1',
        scope: 'sqlite-coordinator-held',
        paths,
      },
    });
    if (!synced.runtimeReferencesSynced)
      throw Error('History runtime references unproved');
    return request(operation, payload);
  });
}
module.exports = { exchange, withRuntimeReferences };
