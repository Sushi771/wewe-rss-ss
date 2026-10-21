'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { finishBuild, buildFailureDiagnostic } = require('./build.cjs');

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
