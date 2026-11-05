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
          if (round === 1)
            ownedChild.emit(
              'error',
              Error('synthetic child operation failure'),
            );
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

test(
  'reload waits for the new document and its delayed script before evaluation',
  { skip: !browser, timeout: 60000 },
  async () => {
    let documents = 0;
    await withFixture(
      'window.fixture = {};',
      async ({ evaluate, send }) => {
        assert.equal(await evaluate('window.fixture.generation'), '1');
        await send('Page.reload');
        assert.equal(await evaluate('window.fixture?.generation'), '2');
        assert.equal(await evaluate('document.readyState'), 'complete');
      },
      {},
      {
        handleRequest(req, res) {
          if (req.url === '/') {
            res.setHeader('Content-Type', 'text/html');
            res.end(
              `<!doctype html><html data-generation="${++documents}"><body><script src="/fixture.js"></script></body></html>`,
            );
            return true;
          }
          if (req.url !== '/fixture.js') return false;
          setTimeout(() => {
            res.setHeader('Content-Type', 'text/javascript');
            res.end(
              'window.fixture = {generation: document.documentElement.dataset.generation};',
            );
          }, 500);
          return true;
        },
      },
    );
  },
);
