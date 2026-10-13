'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require(require.resolve('typescript', { paths: ['apps/web'] }));
const source = ts.transpileModule(
  fs.readFileSync('apps/web/src/utils/cache-revision-watch.ts', 'utf8'),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;
const flush = async () => {
  for (let n = 0; n < 12; n++) await Promise.resolve();
};
function fixture() {
  let now = 0,
    id = 0,
    version = 'epoch:0',
    readError = false,
    refreshError = false;
  let deferRead, deferRefresh;
  const timers = new Map(),
    reads = [],
    refreshes = [],
    errors = [];
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    AbortController,
    Date: { now: () => now },
    setTimeout: (fn, ms) => {
      timers.set(++id, { fn, at: now + ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  const watch = module.exports.createCacheRevisionWatch({
    read: async (signal) => {
      reads.push({ signal, at: now });
      if (deferRead) await deferRead;
      if (signal.aborted) throw Error('aborted');
      if (readError) throw Error('disconnected');
      return { revision: version };
    },
    refresh: async () => {
      refreshes.push(version);
      if (deferRefresh) await deferRefresh;
      if (refreshError) throw Error('view failure');
    },
    onError: (phase) => errors.push(phase),
  });
  return {
    watch,
    reads,
    refreshes,
    errors,
    timers,
    set version(value) {
      version = value;
    },
    set readError(value) {
      readError = value;
    },
    set refreshError(value) {
      refreshError = value;
    },
    set deferRead(value) {
      deferRead = value;
    },
    set deferRefresh(value) {
      deferRefresh = value;
    },
    async tick(ms) {
      const end = now + ms;
      await flush();
      for (;;) {
        const next = [...timers]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}
test('baseline and unchanged reads never refresh; changed and restarted versions do', async () => {
  const f = fixture();
  f.watch.setActive(true);
  await f.tick(3000);
  assert.equal(f.reads.length, 4);
  assert.equal(f.refreshes.length, 0);
  f.version = 'epoch:1';
  await f.tick(1000);
  assert.deepEqual(f.refreshes, ['epoch:1']);
  await f.tick(2000);
  assert.equal(f.refreshes.length, 1);
  f.version = 'restart:0';
  await f.tick(1000);
  assert.equal(f.refreshes.length, 2);
  f.watch.dispose();
  assert.equal(f.timers.size, 0);
});
test('many versions during slow refresh merge into one follow-up', async () => {
  const f = fixture();
  f.watch.setActive(true);
  await f.tick(0);
  let finish;
  f.deferRefresh = new Promise((resolve) => (finish = resolve));
  f.version = 'epoch:1';
  await f.tick(1000);
  f.version = 'epoch:2';
  await f.tick(1000);
  f.version = 'epoch:3';
  await f.tick(1000);
  assert.equal(f.refreshes.length, 1);
  f.deferRefresh = undefined;
  finish();
  await flush();
  assert.deepEqual(f.refreshes, ['epoch:1', 'epoch:3']);
  await f.tick(2000);
  assert.equal(f.refreshes.length, 2);
  f.watch.dispose();
});
test('inactive/offline pages stop reads and abort in flight; resume checks missed version', async () => {
  const f = fixture();
  f.watch.setActive(true);
  await f.tick(0);
  f.watch.setActive(false);
  f.version = 'epoch:4';
  await f.tick(10000);
  assert.equal(f.reads.length, 1);
  assert.equal(f.refreshes.length, 0);
  f.watch.setActive(true);
  await f.tick(0);
  assert.deepEqual(f.refreshes, ['epoch:4']);
  let finish;
  f.deferRead = new Promise((resolve) => (finish = resolve));
  await f.tick(1000);
  f.watch.setActive(false);
  assert.equal(f.reads.at(-1).signal.aborted, true);
  finish();
  await flush();
  assert.equal(f.timers.size, 0);
  f.watch.dispose();
});
test('disconnect backs off without acknowledging unseen data; reconnect reads immediately', async () => {
  const f = fixture();
  f.watch.setActive(true);
  await f.tick(0);
  f.readError = true;
  await f.tick(1000);
  await f.tick(1999);
  assert.equal(f.reads.length, 2);
  await f.tick(1);
  assert.equal(f.reads.length, 3);
  await f.tick(3999);
  assert.equal(f.reads.length, 3);
  f.watch.setActive(false);
  f.readError = false;
  f.version = 'epoch:9';
  f.watch.setActive(true);
  await f.tick(0);
  assert.deepEqual(f.refreshes, ['epoch:9']);
  f.watch.dispose();
});
test('failed list read retries same revision and never signals success', async () => {
  const f = fixture();
  f.watch.setActive(true);
  await f.tick(0);
  f.refreshError = true;
  f.version = 'epoch:2';
  await f.tick(1000);
  assert.deepEqual(f.errors, ['view']);
  f.refreshError = false;
  await f.tick(2000);
  assert.equal(f.refreshes.length, 2);
  await f.tick(1000);
  assert.equal(f.refreshes.length, 2);
  f.watch.dispose();
});
