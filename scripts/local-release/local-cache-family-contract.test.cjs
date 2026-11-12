// Pure synthetic identity records, NOT native host/reference evidence.
// The real source Nest/bootstrap fixture is deliberately separate.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const family = require('./preserving-process-family.cjs');
const hash = (value) =>
  crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fixture() {
  const launchers = [
    'runtime.cjs',
    'watch-wechat2rss-cache.py',
    'sqlite-snapshot-guard.py',
  ].map((entry, i) => ({
    packageId: 'synthetic',
    entry,
    ...(i ? { parentEntry: 'runtime.cjs' } : {}),
    argv: [entry, '--database', 'synthetic.sqlite'],
  }));
  const policy = {
    windowsReferences: { launchers },
    preservingUpdate: { processFamily: { format: 1 } },
  };
  const rows = launchers.map((l, i) => ({
    kind: 'processes',
    packageId: 'synthetic',
    pid: 100 + i,
    parentPid: i ? 100 : 1,
    startUtc: '2026-01-01T00:00:00.0000000Z',
    invocationSha256: hash(l),
    parentInvocationSha256: i ? hash(launchers[0]) : null,
  }));
  return { policy, rows };
}
test('local-only stable runtime/watch/snapshot family completes unchanged; no per-feed reader declaration', () => {
  const { policy, rows } = fixture();
  assert.equal(family.family(rows, 100, 'synthetic', policy, true).length, 3);
  assert.equal(
    family.remaining(
      rows,
      rows,
      new Set(),
      rows.map(({ pid, parentPid }) => ({ pid, parentPid })),
    ),
    3,
  );
});
for (const mutation of [
  'short-reader',
  'changed-argv',
  'unknown-console',
  'missing-snapshot',
  'unknown-descendant',
]) {
  test('local-only does not relax strict family for ' + mutation, () => {
    const { policy, rows } = fixture();
    if (mutation === 'short-reader')
      rows.push({
        ...rows[1],
        pid: 103,
        invocationSha256: hash({
          entry: 'read-wechat2rss-cache.py',
          argv: ['--feed', 'synthetic'],
        }),
      });
    if (mutation === 'changed-argv')
      rows[1].invocationSha256 = hash({
        ...policy.windowsReferences.launchers[1],
        argv: ['watch-wechat2rss-cache.py', '--database', 'different.sqlite'],
      });
    if (mutation === 'unknown-console')
      rows.push({
        ...rows[1],
        pid: 103,
        consoleHost: true,
        invocationSha256: hash({ entry: 'unknown-conhost.exe' }),
      });
    if (mutation === 'missing-snapshot') rows.pop();
    if (mutation === 'unknown-descendant') {
      assert.throws(
        () =>
          family.remaining(rows, rows, new Set(), [
            ...rows.map(({ pid, parentPid }) => ({ pid, parentPid })),
            { pid: 103, parentPid: 101 },
          ]),
        /FAMILY_CHANGED/,
      );
      return;
    }
    assert.throws(
      () => family.family(rows, 100, 'synthetic', policy, true),
      /FAMILY_CHANGED/,
    );
  });
}
