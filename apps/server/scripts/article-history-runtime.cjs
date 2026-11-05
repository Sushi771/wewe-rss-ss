'use strict';
const { randomUUID } = require('node:crypto');
const { createInterface } = require('node:readline');

function safeDiagnostic(value) {
  const pick = (value, allowed, fallback) =>
    allowed.includes(value) ? value : fallback;
  if (value?.format !== 'article-history-diagnostic-v1') return undefined;
  const result = {
    format: value.format,
    stage: pick(
      value.stage,
      [
        'owner-request',
        'owner-proof',
        'references',
        'recovery-owner',
        'recovery-previous',
        'source-state',
        'archive-prepare',
        'coverage',
        'resource-query',
        'final-check',
        'approval-coverage',
        'approval-source',
        'approval-recovery',
        'approval-resource',
      ],
      'owner-request',
    ),
    errorType: pick(
      value.errorType,
      [
        'HostError',
        'CoverageError',
        'BrowserCheckError',
        'OperationalError',
        'DatabaseError',
        'IntegrityError',
        'ProgrammingError',
        'OSError',
        'PermissionError',
        'FileNotFoundError',
        'TimeoutExpired',
        'ValueError',
        'TypeError',
        'JSONDecodeError',
      ],
      'UnknownError',
    ),
    code: pick(
      value.code,
      [
        'EBUSY',
        'EPERM',
        'ENOENT',
        'EACCES',
        'EIO',
        'ENOSPC',
        'EMFILE',
        'SQLITE_BUSY',
        'SQLITE_LOCKED',
        'SQLITE_CORRUPT',
        'SQLITE_NOTADB',
        'SQLITE_ERROR',
        'SQLITE_CONSTRAINT',
        'SQLITE_INTERRUPT',
        'PROCESS_TIMEOUT',
      ],
      'UNCLASSIFIED',
    ),
  };
  if (value.browser && typeof value.browser === 'object') {
    result.browser = {
      phase: pick(
        value.browser.phase,
        [
          'input',
          'startup',
          'connect',
          'cdp',
          'decode',
          'remote-check',
          'process',
        ],
        'process',
      ),
      errorType: pick(
        value.browser.errorType,
        ['Error', 'TypeError', 'SyntaxError', 'RangeError', 'TimeoutExpired'],
        'UnknownError',
      ),
      code: pick(
        value.browser.code,
        [
          'ENOENT',
          'EBUSY',
          'EPERM',
          'EACCES',
          'ECONNREFUSED',
          'ECONNRESET',
          'BROWSER_EXITED',
          'STARTUP_EXHAUSTED',
          'INVALID_PORT_FILE',
          'CDP_TIMEOUT',
          'CDP_ERROR',
          'DECODE_FAILED',
          'REMOTE_RESOURCE_BLOCKED',
          'BROWSER_DEADLINE',
          'PROCESS_TIMEOUT',
          'INVALID_BROWSER_RESULT',
        ],
        'UNCLASSIFIED',
      ),
    };
    if (['ENOENT', 'EBUSY', 'EPERM'].includes(value.browser.resourceCode))
      result.browser.resourceCode = value.browser.resourceCode;
    if (
      Number.isInteger(value.browser.attempts) &&
      value.browser.attempts >= 0 &&
      value.browser.attempts <= 120
    )
      result.browser.attempts = value.browser.attempts;
  }
  return result;
}

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
          const diagnostic = safeDiagnostic(value.result?.diagnostic);
          const suffix = diagnostic
            ? ` [${diagnostic.stage}/${diagnostic.errorType}/${diagnostic.code}${diagnostic.browser ? '/' + diagnostic.browser.phase + '/' + diagnostic.browser.code : ''}]`
            : '';
          finish(
            Object.assign(
              Error('History owner review blocked: ' + code + suffix),
              { diagnostic },
            ),
          );
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
module.exports = { exchange, withRuntimeReferences, safeDiagnostic };
