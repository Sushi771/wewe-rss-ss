const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { execFileSync } = require('node:child_process');
const api = require('./windows-release-references.cjs');
function fixture(run) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-owned-chain-'));
  const names = ['probe.exe', 'powershell.exe', 'conhost.exe', 'foreign.exe'];
  for (const n of names) fs.writeFileSync(path.join(base, n), 'inert');
  const row = (pid, parentPid, name, argv, startUtc) => ({
    pid,
    parentPid,
    name,
    executable: path.join(base, name),
    commandLine: argv.map((x) => '"' + x + '"').join(' '),
    startUtc,
  });
  const exe = (n) => path.join(base, n),
    start = '2026-01-01T00:00:00.000Z';
  const self = {
    pid: 2,
    executable: exe('probe.exe'),
    argv: [exe('probe.exe'), 'probe.cjs'],
    collectorExecutable: exe('powershell.exe'),
    collectorArgv: [exe('powershell.exe'), 'collector.ps1'],
    consoleExecutable: exe('conhost.exe'),
    consoleArgv: [exe('conhost.exe'), '0x4'],
  };
  const before = [
    row(2, 1, 'probe.exe', self.argv, start),
    row(3, 2, 'conhost.exe', self.consoleArgv, '2026-01-01T00:00:00.001Z'),
    row(4, 2, 'powershell.exe', self.collectorArgv, '2026-01-01T00:00:00.002Z'),
    row(5, 4, 'conhost.exe', self.consoleArgv, '2026-01-01T00:00:00.003Z'),
  ];
  const f = {
    base,
    self,
    before,
    after: structuredClone(before),
    run() {
      return api.collectorChain(
        new Map(this.before.map((r) => [r.pid, r])),
        new Map(this.after.map((r) => [r.pid, r])),
        1,
        self,
      );
    },
  };
  try {
    return run(f);
  } finally {
    assert(path.resolve(base).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert(path.basename(base).startsWith('wewe-owned-chain-'));
    fs.rmSync(base, { recursive: true });
  }
}
test('collector chain binds both console owners including probe console created before PowerShell', () =>
  fixture((f) => {
    assert.deepEqual(
      f.run().map((r) => r.pid),
      [2, 4, 3, 5],
    );
    for (const id of [3, 5]) {
      f.before = f.before.filter((r) => r.pid !== id);
      f.after = f.after.filter((r) => r.pid !== id);
      f.run();
    }
  }));
for (const owner of ['probe', 'collector'])
  for (const fault of [
    'wrong-exe',
    'wrong-argv',
    'opaque',
    'reused-start',
    'before-owner',
    'after-only',
    'missing-after',
    'wrong-parent',
    'extra-sibling',
    'descendant',
    'extra-after',
  ])
    test('collector chain refuses ' + owner + ' console ' + fault, () =>
      fixture((f) => {
        const id = owner === 'probe' ? 3 : 5,
          parent = owner === 'probe' ? 2 : 4;
        const change = (fn) => {
          for (const list of [f.before, f.after])
            fn(list.find((r) => r.pid === id));
        };
        if (fault === 'wrong-exe')
          change((r) => (r.executable = path.join(f.base, 'foreign.exe')));
        if (fault === 'wrong-argv')
          change((r) => (r.commandLine += ' --foreign'));
        if (fault === 'opaque') change((r) => (r.commandLine = ''));
        if (fault === 'reused-start')
          f.after.find((r) => r.pid === id).startUtc =
            '2026-01-02T00:00:00.000Z';
        if (fault === 'before-owner')
          change((r) => (r.startUtc = '2025-12-31T23:59:59.999Z'));
        if (fault === 'after-only')
          f.before = f.before.filter((r) => r.pid !== id);
        if (fault === 'missing-after')
          f.after = f.after.filter((r) => r.pid !== id);
        if (fault === 'wrong-parent')
          f.after.find((r) => r.pid === id).parentPid = 99;
        if (['extra-sibling', 'descendant', 'extra-after'].includes(fault)) {
          const r = {
            ...f.before.find((r) => r.pid === id),
            pid: 6,
            parentPid: fault === 'descendant' ? id : parent,
          };
          if (fault !== 'extra-after') f.before.push(r);
          f.after.push({ ...r });
        }
        let error;
        try {
          f.run();
        } catch (e) {
          error = e;
        }
        assert(error);
        assert(error.referenceDiagnostic.chainBranch);
        assert(error.privateReferenceDiagnostic);
        assert.equal(error.privateReferenceDiagnostic.truncated, false);
        assert.deepEqual(error.privateReferenceDiagnostic.before, f.before);
        assert.deepEqual(error.privateReferenceDiagnostic.after, f.after);
        assert(
          !JSON.stringify(
            api.referenceDiagnostic(error.referenceDiagnostic),
          ).includes(f.base),
        );
      }),
    );
test('collector chain rejects duplicate exact PowerShell and keeps distinct refusal branch', () =>
  fixture((f) => {
    const r = { ...f.before.find((r) => r.pid === 4), pid: 6 };
    f.before.push(r);
    f.after.push({ ...r });
    assert.throws(
      () => f.run(),
      (e) => e.referenceDiagnostic.chainBranch === 'collector-candidate-count',
    );
  }));
test('private chain diagnostics bound raw rows and bytes with explicit truncation', () => {
  const row = {
    pid: 1,
    parentPid: 0,
    name: 'node.exe',
    executable: 'x'.repeat(12000),
    commandLine: 'SECRET'.repeat(10000),
    startUtc: '2026-01-01T00:00:00Z',
  };
  const d = api.privateReferenceDiagnostic({
    format: 1,
    branch: 'unexpected-descendant',
    before: Array(40).fill(row),
    after: Array(40).fill(row),
  });
  assert(d.truncated);
  assert(d.before.length <= 16);
  assert(d.after.length <= 16);
  assert(Buffer.byteLength(JSON.stringify(d)) <= 64 * 1024);
  assert.equal(d.beforeCount, 40);
  assert.equal(d.afterCount, 40);
  assert.equal(
    api.privateReferenceDiagnostic({ format: 1, branch: 'C:/SECRET' }),
    undefined,
  );
});
test(
  'real owned double execFileSync chain matches the parser without admission or query substitution',
  { skip: process.platform !== 'win32' },
  () => {
    const raw = execFileSync(
      process.execPath,
      [path.join(__dirname, 'windows-collector-chain.fixture.cjs'), 'driver'],
      {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 40000,
        maxBuffer: 1024 ** 2,
      },
    );
    const r = JSON.parse(raw),
      ps = r.accepted.find((x) => x.name.toLowerCase() === 'powershell.exe');
    assert(ps);
    assert.equal(r.accepted[0].pid, r.self.pid);
    for (const list of [r.native.before, r.native.after])
      for (const row of list)
        if ([r.self.pid, ps.pid].includes(row.parentPid))
          assert(r.accepted.some((x) => x.pid === row.pid));
    console.log(
      JSON.stringify({
        fixture: 'real-owned-double-sync-chain',
        probeConsoles: r.accepted.filter(
          (x) =>
            x.name.toLowerCase() === 'conhost.exe' &&
            x.parentPid === r.self.pid,
        ).length,
        collectorConsoles: r.accepted.filter(
          (x) =>
            x.name.toLowerCase() === 'conhost.exe' && x.parentPid === ps.pid,
        ).length,
      }),
    );
  },
);
