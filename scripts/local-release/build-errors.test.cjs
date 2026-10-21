'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  finishBuild,
  buildFailureDiagnostic,
  compilerFailure,
  compilerEnvironment,
  reservationBytes,
} = require('./build.cjs');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

test('explicit compact build reservation remains finite and can only lower the conservative estimate', () => {
  const mode = { buildOnly: true, compact: true };
  assert.equal(reservationBytes({}, 593710908), 593710908);
  assert.equal(
    reservationBytes({ ...mode, reserveBytes: 167772160 }, 593710908),
    167772160,
  );
  for (const reserveBytes of [0, -1, NaN, Infinity, 593710909])
    assert.throws(
      () => reservationBytes({ ...mode, reserveBytes }, 593710908),
      /positive byte limit/,
    );
  assert.throws(
    () => reservationBytes({ compact: true, reserveBytes: 1 }, 100),
    /compact build-only/,
  );
  assert.throws(
    () => reservationBytes({ buildOnly: true, reserveBytes: 1 }, 100),
    /compact build-only/,
  );
});

test(
  'fixed compiler environment disables native cache even when explicitly re-enabled by the tool',
  { skip: typeof require('node:module').enableCompileCache !== 'function' },
  (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-native-cache-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const code = `const m=require('node:module');const r=m.enableCompileCache(process.argv[1]);m.flushCompileCache();process.stdout.write(JSON.stringify({status:r.status,disabled:m.constants.compileCacheStatus.DISABLED}));`;
    const disabled = path.join(root, 'disabled');
    const result = spawnSync(process.execPath, ['-e', code, disabled], {
      env: compilerEnvironment({
        ...process.env,
        NODE_DISABLE_COMPILE_CACHE: '0',
        NODE_COMPILE_CACHE: disabled,
      }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(result.stdout);
    assert.equal(status.status, status.disabled);
    assert.equal(fs.existsSync(disabled), false);
    const enabled = path.join(root, 'enabled');
    const enabledEnv = { ...process.env, NODE_COMPILE_CACHE: enabled };
    delete enabledEnv.NODE_DISABLE_COMPILE_CACHE;
    const control = spawnSync(process.execPath, ['-e', code, enabled], {
      env: enabledEnv,
      encoding: 'utf8',
    });
    assert.equal(control.status, 0, control.stderr);
    assert.equal(fs.existsSync(enabled), true);
  },
);

test('actual compiler stdout, stderr and exit survive both finalization errors verbatim', () => {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `process.stdout.write('tsc stdout\\n类型错误');process.stderr.write('compiler stderr\\n');process.exitCode=2;`,
    ],
    { encoding: 'utf8' },
  );
  const primary = compilerFailure(result, process.execPath, ['synthetic-tsc']);
  let failure;
  try {
    finishBuild(
      primary,
      {
        finish() {
          throw Error('held');
        },
      },
      {
        close() {
          throw Error('unrequested');
        },
      },
    );
  } catch (error) {
    failure = error;
  }
  const report = buildFailureDiagnostic(failure);
  assert.equal(report.primaryError.compiler.status, 2);
  assert.equal(report.primaryError.compiler.stdout, 'tsc stdout\n类型错误');
  assert.equal(report.primaryError.compiler.stderr, 'compiler stderr\n');
  assert.equal(report.closeErrors.length, 2);
});

test('spawn errors retain identity, streams and signal without inventing a successful exit', () => {
  const error = Object.assign(Error('spawn refused'), { code: 'ENOENT' });
  assert.equal(
    compilerFailure(
      { error, status: null, signal: 'SIGTERM', stdout: 'partial', stderr: '' },
      'exact-node',
      ['exact-tsc'],
    ),
    error,
  );
  assert.deepEqual(buildFailureDiagnostic(error).primaryError.compiler, {
    executable: 'exact-node',
    args: ['exact-tsc'],
    status: null,
    signal: 'SIGTERM',
    stdout: 'partial',
    stderr: '',
  });
});

test('compiler primary error survives both reservation and scope finalization errors', () => {
  const primary = Object.assign(Error('spawn synthetic-generator ENOENT'), {
    code: 'ENOENT',
  });
  const reservationError = Error('RELEASE_SCOPE_BUILD_ONLY_FAILED_OUTPUT_HELD');
  const scopeError = Error('RELEASE_SCOPE_FAILED_OUTPUT_HELD_REQUIRES_REVIEW');
  const calls = [];
  let failure;
  try {
    finishBuild(
      primary,
      {
        finish(error) {
          calls.push(['finish', error]);
          throw reservationError;
        },
      },
      {
        close(error) {
          calls.push(['close', error]);
          throw scopeError;
        },
      },
    );
  } catch (error) {
    failure = error;
  }
  assert(failure instanceof AggregateError);
  assert.equal(failure.cause, primary);
  assert.equal(failure.primaryError, primary);
  assert.deepEqual(failure.errors, [primary, reservationError, scopeError]);
  assert.deepEqual(calls, [
    ['finish', primary],
    ['close', primary],
  ]);
  const report = buildFailureDiagnostic(failure);
  assert.equal(report.primaryError.message, primary.message);
  assert.equal(report.primaryError.code, 'ENOENT');
  assert.deepEqual(
    report.closeErrors.map((row) => row.stage),
    ['reservation.finish', 'scope.close'],
  );
  assert.deepEqual(
    report.closeErrors.map((row) => row.error.message),
    [reservationError.message, scopeError.message],
  );
});

test('reservation finish failure closes a deferred pair lease as failure rather than success', () => {
  const error = Error('synthetic reservation finish failure');
  let closedWith;
  assert.throws(
    () =>
      finishBuild(
        undefined,
        {
          finish() {
            throw error;
          },
        },
        {
          close(value) {
            closedWith = value;
          },
        },
        false,
      ),
    (failure) => {
      assert.equal(failure.primaryError, null);
      assert.equal(failure.cause, error);
      assert.equal(failure.closeErrors[0].stage, 'reservation.finish');
      return true;
    },
  );
  assert.equal(closedWith, error);
});

test('successful first pair finalization defers close and ordinary finalization closes once', () => {
  let finishes = 0,
    closes = 0;
  const reservation = {
      finish() {
        finishes++;
      },
    },
    lease = {
      close() {
        closes++;
      },
    };
  finishBuild(undefined, reservation, lease, false);
  assert.equal(finishes, 1);
  assert.equal(closes, 0);
  finishBuild(undefined, undefined, lease);
  assert.equal(closes, 1);
});

test('diagnostic messages are bounded while original exception objects stay intact', () => {
  const primary = Error('x'.repeat(20000));
  const report = buildFailureDiagnostic(primary);
  assert.equal(report.primaryError.message.length, 8192);
  assert(report.primaryError.stack.length <= 8192);
  assert.equal(primary.message.length, 20000);
});
