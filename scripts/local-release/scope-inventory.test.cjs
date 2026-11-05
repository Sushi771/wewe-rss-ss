const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { createVerifier, MEMORY, FORMAT } = require('./scope-inventory.cjs');
test('time spent between passes remains charged to the same verification operation', () => {
  let clock = 0;
  const v = virtual(1, 1),
    verifier = createVerifier(
      { durationMs: 10 },
      { io: v.io, now: () => clock },
    );
  verifier.scan(v.roots);
  clock = 11;
  assert.throws(() => verifier.assertBudget(), /SCAN_TIME_BUDGET/);
});
test('a directory changed after an emitted segment cannot produce a complete receipt', () => {
  const v = virtual(3, 1024),
    original = v.io.lstatSync;
  let changed = false,
    segments = 0;
  v.io.lstatSync = (at) => {
    const s = original(at);
    if (at === v.root && changed) s.mtimeNs = 2n;
    return s;
  };
  const verifier = createVerifier(undefined, {
    io: v.io,
    onSegment() {
      segments++;
      changed = true;
    },
  });
  assert.throws(() => verifier.scan(v.roots), /DIRECTORY_CHANGED_DURING_SCAN/);
  assert(segments > 0);
  assert.equal(v.handles(), 0);
});
test('read-only inspector CLI returns a complete private receipt without adopting or writing into its roots', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-stream-inspect-')),
    root = path.join(base, 'registered');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'data'), 'inert');
  try {
    const request = path.join(base, 'request.json');
    fs.writeFileSync(
      request,
      JSON.stringify({
        roots: [root],
        scanBudget: {
          profile: 'legacy-stream-v1',
          checkpointMode: 'identity-times-v1',
        },
      }),
    );
    const receipt = JSON.parse(
      require('node:child_process').execFileSync(
        process.execPath,
        [require.resolve('./scope-inventory.cjs'), '--inspect', request],
        {
          encoding: 'utf8',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ),
    );
    assert.equal(receipt.baseline.format, FORMAT);
    assert.equal(receipt.baseline.bytes, 5);
    assert.equal(receipt.metrics.readBytes, 5);
    assert.equal(receipt.scanBudget.operationEntries, 16000000);
    assert.deepEqual(fs.readdirSync(root), ['data']);
    assert.deepEqual(fs.readdirSync(base).sort(), [
      'registered',
      'request.json',
    ]);
  } finally {
    assert(path.basename(base).startsWith('wewe-stream-inspect-'));
    fs.rmSync(base, { recursive: true });
  }
});
function virtual(directories = 1024, files = 1024, { reverse = false } = {}) {
  const root = path.resolve(os.tmpdir(), 'virtual-inventory-never-created');
  let handles = 0,
    readCalls = 0;
  const parts = (at) => path.relative(root, at).split(path.sep).filter(Boolean);
  const io = {
    realpathSync: { native: (p) => p },
    lstatSync(at) {
      const p = parts(at),
        dir = p.length < 2,
        ino =
          p.length === 0
            ? 1
            : p.length === 1
              ? 2 + Number(p[0].slice(1))
              : 10000 + Number(p[0].slice(1)) * files + Number(p[1].slice(1));
      return {
        dev: 1n,
        ino: BigInt(ino),
        birthtimeNs: 1n,
        mtimeNs: 1n,
        ctimeNs: 1n,
        size: 0n,
        nlink: 1n,
        isDirectory: () => dir,
        isFile: () => !dir,
        isSymbolicLink: () => false,
      };
    },
    opendirSync(at) {
      handles++;
      const count = parts(at).length ? files : directories,
        prefix = parts(at).length ? 'f' : 'd';
      let index = 0,
        closed = false;
      return {
        readSync() {
          if (index === count) return null;
          const i = reverse ? count - 1 - index : index;
          index++;
          return { name: prefix + String(i).padStart(4, '0') };
        },
        closeSync() {
          assert(!closed);
          closed = true;
          handles--;
        },
      };
    },
    openSync() {
      throw new Error('zero-size virtual files must require no content IO');
    },
    readSync() {
      readCalls++;
      throw new Error('no real read');
    },
    closeSync() {
      throw new Error('no file descriptors');
    },
  };
  return {
    root,
    roots: [{ path: root, identity: ['1', '1', '1'] }],
    io,
    handles: () => handles,
    reads: () => readCalls,
  };
}
test('streaming legacy profile verifies over one million virtual entries with bounded working storage and zero artifacts', () => {
  const v = virtual(),
    events = [],
    verifier = createVerifier(
      { profile: 'legacy-stream-v1' },
      {
        io: v.io,
        onSegment: (e) => {
          if (events.length < 3) events.push(e);
        },
      },
    ),
    result = verifier.scan(v.roots),
    metrics = verifier.metrics();
  assert.equal(result.entries, 1049601);
  assert.equal(result.format, FORMAT);
  assert(result.segments > 500);
  assert.equal(result.readBytes, 0);
  assert.equal(v.reads(), 0);
  assert.equal(v.handles(), 0);
  assert(metrics.maxPendingNames <= 2048);
  assert(metrics.maxPendingNameBytes < 256 * 1024);
  assert.equal(metrics.bufferBytes, 65536);
  assert.equal(metrics.maxDepth, 2);
  assert.equal(events.length, 3);
});
test('default profile remains small and refuses the same virtual tree without raising its ceiling', () => {
  const v = virtual(),
    verifier = createVerifier(undefined, { io: v.io });
  assert.throws(() => verifier.scan(v.roots), /SCAN_ENTRY_BUDGET/);
  assert.equal(verifier.metrics().visitedEntries, 100001);
  assert.equal(v.handles(), 0);
});
test('directory enumeration order cannot change complete content or metadata receipts', () => {
  const a = virtual(8, 8),
    b = virtual(8, 8, { reverse: true });
  const x = createVerifier(undefined, { io: a.io }).scan(a.roots),
    y = createVerifier(undefined, { io: b.io }).scan(b.roots);
  assert.equal(x.digest, y.digest);
  assert.equal(x.metadataDigest, y.metadataDigest);
  assert.equal(x.segmentRoot, y.segmentRoot);
});
test('per-directory memory cap refuses a pathological flat directory and closes the iterator', () => {
  const v = virtual(MEMORY.directoryEntries + 1, 1),
    verifier = createVerifier({ profile: 'legacy-stream-v1' }, { io: v.io });
  assert.throws(() => verifier.scan(v.roots), /SCAN_NAME_MEMORY_BUDGET/);
  assert.equal(v.handles(), 0);
  assert(verifier.metrics().maxPendingNames <= MEMORY.directoryEntries);
});
test('cumulative visit, duration and byte budgets remain finite across repeated passes', () => {
  const v = virtual(1, 1),
    verifier = createVerifier({ operationEntries: 5 }, { io: v.io });
  verifier.scan(v.roots);
  assert.throws(
    () => verifier.scan(v.roots, [], { metadataOnly: true }),
    /SCAN_ENTRY_BUDGET/,
  );
  let clock = 0;
  const w = virtual(1, 1),
    timed = createVerifier({ durationMs: 3 }, { io: w.io, now: () => clock++ });
  assert.throws(() => timed.scan(w.roots), /SCAN_TIME_BUDGET/);
  assert.equal(w.handles(), 0);
  assert.throws(
    () =>
      createVerifier({
        profile: 'legacy-stream-v1',
        operationEntries: 16000001,
      }),
    /SCAN_BUDGET_INVALID/,
  );
  assert.throws(
    () => createVerifier({ profile: 'unlimited' }),
    /SCAN_BUDGET_INVALID/,
  );
  for (const profile of ['constructor', 'toString', '__proto__'])
    assert.throws(() => createVerifier({ profile }), /SCAN_BUDGET_INVALID/);
  assert.throws(
    () => createVerifier({ checkpointMode: 'skip-history' }),
    /SCAN_BUDGET_INVALID/,
  );
});
test('content IO is pre-budgeted and metadata-only checkpoints never reread content', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-stream-budget-'));
  try {
    const file = path.join(base, 'data'),
      fileSize = MEMORY.bufferBytes * 2 + 17;
    fs.writeFileSync(file, Buffer.alloc(fileSize, 7));
    const s = fs.lstatSync(base, { bigint: true }),
      roots = [
        {
          path: fs.realpathSync.native(base),
          identity: [s.dev, s.ino, s.birthtimeNs].map(String),
        },
      ];
    const tooSmall = createVerifier({ scanReadBytes: 2048 });
    assert.throws(() => tooSmall.scan(roots), /SCAN_READ_BUDGET/);
    assert.equal(tooSmall.metrics().readBytes, 0);
    const verifier = createVerifier(),
      full = verifier.scan(roots),
      metadata = verifier.scan(roots, [], { metadataOnly: true });
    assert.equal(full.readBytes, fileSize);
    assert.equal(metadata.readBytes, 0);
    assert.equal(metadata.metadataDigest, full.metadataDigest);
    assert.equal(verifier.metrics().readBytes, fileSize);
    const cumulative = createVerifier({
      scanReadBytes: fileSize,
      operationReadBytes: fileSize,
    });
    cumulative.scan(roots);
    assert.throws(() => cumulative.scan(roots), /SCAN_READ_BUDGET/);
    assert.equal(cumulative.metrics().readBytes, fileSize);
    fs.writeFileSync(file, Buffer.alloc(fileSize, 8));
    const changed = verifier.scan(roots, [], { metadataOnly: true });
    assert.notEqual(changed.metadataDigest, full.metadataDigest);
  } finally {
    assert(path.basename(base).startsWith('wewe-stream-budget-'));
    fs.rmSync(base, { recursive: true });
  }
});
