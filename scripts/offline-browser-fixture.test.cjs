'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const childProcess = require('node:child_process');
const originalSpawn = childProcess.spawn;
let ownedChild;
// Observe only the actual child created by this fixture; no process discovery.
childProcess.spawn = (...args) => {
  ownedChild = originalSpawn(...args);
  return ownedChild;
};
const { browser, withFixture } = require('./offline-browser-fixture.cjs');
childProcess.spawn = originalSpawn;

test(
  'each real fixture confirms its own browser exit before the next one starts',
  { skip: !browser, timeout: 60000 },
  async () => {
    for (let round = 0; round < 2; round++) {
      await withFixture(
        'window.fixture = { ready: true };',
        async ({ evaluate }) => {
          assert.equal(await evaluate('window.fixture.ready'), true);
        },
      );
      assert(
        ownedChild.exitCode !== null || ownedChild.signalCode !== null,
        'fixture returned before its browser exit was confirmed',
      );
    }
    const failure = Error('synthetic business assertion');
    await assert.rejects(
      withFixture('window.fixture = { ready: true };', async () => {
        throw failure;
      }),
      (error) => error === failure,
    );
    assert(
      ownedChild.exitCode !== null || ownedChild.signalCode !== null,
      'failed fixture returned before its browser exit was confirmed',
    );
  },
);
