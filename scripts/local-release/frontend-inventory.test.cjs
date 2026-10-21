'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const scanner = require('./frontend-inventory.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'segmented-inventory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (let n = 0; n < 8; n++) {
    fs.mkdirSync(path.join(root, 'slot-' + n));
    fs.writeFileSync(path.join(root, 'slot-' + n, 'data'), 'abc');
  }
  return root;
}
test('bounded continuation counts all manifested and unmanifested history exactly once', async (t) => {
  const root = fixture(t),
    handle = scanner.begin(root);
  t.after(() => scanner.cancel(handle));
  let result,
    segments = 0;
  do {
    result = await scanner.inventory(root, [], {
      handle,
      singleSegment: true,
      entries: 2,
    });
    segments++;
  } while (result.pending);
  assert(segments > 1);
  assert.equal(result.slots, 8);
  assert.equal(result.bytes, 24);
  assert.equal(result.entries, 17);
  assert.deepEqual(result, await scanner.inventory(root));
});
test('changed scanned metadata invalidates continuation without refresh', async (t) => {
  const root = fixture(t),
    handle = scanner.begin(root);
  t.after(() => scanner.cancel(handle));
  await scanner.inventory(root, [], {
    handle,
    singleSegment: true,
    entries: 3,
  });
  fs.writeFileSync(path.join(root, 'slot-0', 'data'), 'changed');
  await assert.rejects(async () => {
    while (true) {
      const r = await scanner.inventory(root, [], {
        handle,
        singleSegment: true,
        entries: 2,
      });
      if (!r.pending) return;
    }
  }, /METADATA_CHANGED/);
  await assert.rejects(
    scanner.inventory(root, [], { handle }),
    /UNTRUSTED_CHECKPOINT/,
  );
});
test('root replacement is refused before continuing', async (t) => {
  const root = fixture(t),
    handle = scanner.begin(root);
  t.after(() => scanner.cancel(handle));
  await scanner.inventory(root, [], {
    handle,
    singleSegment: true,
    entries: 1,
  });
  const moved = root + '-old';
  fs.renameSync(root, moved);
  t.after(() => fs.rmSync(moved, { recursive: true, force: true }));
  fs.mkdirSync(root);
  await assert.rejects(scanner.inventory(root, [], { handle }), /ROOT_CHANGED/);
});
test('serialized/fake complete checkpoint cannot authorize a receipt', async (t) => {
  const root = fixture(t);
  await assert.rejects(
    scanner.inventory(root, [], { handle: { phase: 'complete', bytes: 0 } }),
    /UNTRUSTED_CHECKPOINT/,
  );
});
test('time failure includes elapsed, count, phase and cursor and cannot be resumed', (t) => {
  const root = fixture(t),
    handle = scanner.begin(root);
  let clock = 0;
  assert.throws(
    () =>
      scanner.segment(handle, {
        now: () => {
          clock += 100;
          return clock;
        },
        durationMs: 1,
      }),
    (error) => {
      assert.equal(error.message, 'FRONTEND_INVENTORY_TIME_BUDGET');
      assert.equal(error.inventory.entries, 0);
      assert.equal(error.inventory.phase, 'scan');
      assert.equal(error.inventory.cursor, '');
      assert(error.inventory.totalElapsedMs > 0);
      return true;
    },
  );
  assert.throws(() => scanner.segment(handle), /UNTRUSTED_CHECKPOINT/);
});
test('adding an already scanned directory child is refused rather than omitted', async (t) => {
  const root = fixture(t),
    handle = scanner.begin(root);
  t.after(() => scanner.cancel(handle));
  await scanner.inventory(root, [], {
    handle,
    singleSegment: true,
    entries: 1,
  });
  fs.writeFileSync(path.join(root, 'late'), 'data');
  await assert.rejects(
    scanner.inventory(root, [], { handle }),
    /METADATA_CHANGED/,
  );
});
test('entry/memory/segment failures have distinct codes and saved counters without increasing limits', (t) => {
  const root = fixture(t);
  for (const [limits, code] of [
    [{ entries: 1 }, 'ENTRY'],
    [{ memoryBytes: 1 }, 'MEMORY'],
    [{ segments: 1 }, 'SEGMENT'],
  ]) {
    const handle = scanner.begin(root, [], limits);
    t.after(() => scanner.cancel(handle));
    assert.throws(
      () => {
        scanner.segment(handle, { entries: 1 });
        scanner.segment(handle, { entries: 1 });
      },
      (error) => {
        assert(error.message.includes(code + '_BUDGET'));
        assert.equal(typeof error.inventory.entries, 'number');
        assert.equal(typeof error.inventory.totalElapsedMs, 'number');
        return true;
      },
    );
  }
  assert.throws(
    () => scanner.begin(root, [], { entries: scanner.LIMITS.entries + 1 }),
    /LIMIT_INVALID/,
  );
});
