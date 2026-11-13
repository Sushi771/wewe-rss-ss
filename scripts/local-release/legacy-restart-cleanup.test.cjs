const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  crypto = require('node:crypto');
const gate = require('./project-writer-gate.cjs');
const hash = (v) => crypto.createHash('sha256').update(v).digest('hex');
test.before(require('./writer-self.fixture.test.cjs').prepareWriterSelf);
const source = fs.readFileSync(path.join(__dirname, 'restart.cjs'), 'utf8');
function extractRestartCatch(value) {
  const text = value.replace(/\r\n/g, '\n');
  const baseline = text.indexOf('const baseline =');
  const catching =
    /\}\s*catch\s*\(\s*error\s*\)\s*\{(?=\s*lifecycleError\s*=\s*error\s*;\s*try\s*\{\s*if\s*\(\s*newChild\s*\))/.exec(
      text.slice(baseline),
    );
  const caught = catching ? baseline + catching.index : -1;
  const from = catching ? caught + catching[0].length : -1;
  const ending =
    /\}\s*finally\s*\{\s*try\s*\{\s*releasePriorBootLocks\s*\(\s*\)\s*;\s*if\s*\(\s*options\.rehearsal\s*\)/.exec(
      text.slice(from),
    );
  const to = ending ? from + ending.index : -1;
  assert(baseline > 0 && caught > baseline && from > caught && to > from);
  const body = text.slice(from, to);
  assert.match(
    body,
    /^\s*lifecycleError\s*=\s*error\s*;\s*try\s*\{\s*if\s*\(\s*newChild\s*\)/,
  );
  assert.match(
    body,
    /\}\s*catch\s*\(\s*cleanupError\s*\)\s*\{\s*lifecycleError\s*=\s*failureChain\s*\(\s*error\s*,\s*cleanupError\s*\)\s*;\s*throw\s+lifecycleError\s*;\s*\}\s*$/,
  );
  return body;
}
// Execute the current pure helper too, not a reimplementation or historical catch.
const helper = /^function failureChain\([^]*?^\}/m.exec(
  source.replace(/\r\n/g, '\n'),
);
assert(helper);
const failureChain = new Function('return (' + helper[0] + ')')();
const runCatch = new Function(
  'ctx',
  'return(async()=>{with(ctx){' + extractRestartCatch(source) + '}})()',
);
test('restart catch extraction tolerates formatting but requires exact orchestration anchors', () => {
  const expected = extractRestartCatch(source).replace(/\s/g, '');
  for (const value of [
    source.replace(/\r?\n/g, '\r\n'),
    source.replace(/if\s*\(newChild\)\s*\{/, 'if(newChild){'),
  ])
    assert.equal(extractRestartCatch(value).replace(/\s/g, ''), expected);
  assert.throws(() =>
    extractRestartCatch(
      source.replace('const baseline =', 'const changedBaseline ='),
    ),
  );
  for (const [before, after] of [
    ['lifecycleError = error;', 'lifecycleError = undefined;'],
    ['failureChain(error, cleanupError)', 'failureChain(cleanupError, error)'],
  ])
    assert.throws(() => extractRestartCatch(source.replace(before, after)));
  assert.throws(() =>
    extractRestartCatch(
      source.replaceAll('options.rehearsal', 'options.changedRehearsal'),
    ),
  );
  assert.throws(() =>
    extractRestartCatch(
      source.replaceAll('releasePriorBootLocks()', 'changedReleaseLocks()'),
    ),
  );
});
for (const kind of [
  'after-stop-backup-failure',
  'bound-candidate-health-failure',
  'unbound-candidate-bind-failure',
  'wrong-stop-receipt',
  'late-writer-race',
  'crash-without-observed-identity',
])
  test('exact restart catch: ' + kind, async () => {
    const root = fs.mkdtempSync(
        path.join(fs.realpathSync.native(os.tmpdir()), 'legacy-catch-'),
      ),
      database = path.join(root, 'synthetic.db');
    fs.writeFileSync(database, 'synthetic');
    const old = {
        pid: 11111,
        startUtc: '2026-01-01T00:00:00.0000000Z',
        executable: process.execPath,
        commandLine: 'synthetic old',
      },
      candidate = { ...old, pid: 22222, commandLine: 'synthetic candidate' };
    const owner = kind === 'after-stop-backup-failure' ? old : candidate,
      b = gate.binding(database),
      nonce = crypto.randomUUID();
    const record = {
      version: 1,
      mode: 'writer',
      databaseIdentity: b.databaseIdentity,
      pid: owner.pid,
      startUtc: owner.startUtc,
      executableHash: hash(fs.readFileSync(owner.executable)),
      commandHash: hash(owner.commandLine),
      nonce,
    };
    fs.writeFileSync(b.file, JSON.stringify(record), { flag: 'wx' });
    let starts = 0,
      checks = 0,
      fallbackLease;
    const confirms = [];
    const claim = {
      check() {
        if (kind === 'late-writer-race' && ++checks === 2)
          fs.writeFileSync(
            b.file,
            JSON.stringify({
              ...record,
              pid: 33333,
              nonce: crypto.randomUUID(),
            }),
          );
      },
      assertWritable(k) {
        assert.deepEqual(k, ['restart']);
      },
      confirmPreservingProcessExit(...a) {
        confirms.push(a);
      },
    };
    const newChild =
      kind === 'after-stop-backup-failure'
        ? undefined
        : { pid: candidate.pid, exitCode: null, signalCode: null };
    const ownedIdentities = new Map(
      kind === 'crash-without-observed-identity' || !newChild
        ? []
        : [
            [
              candidate.pid,
              {
                identity: candidate,
                packageId: 'candidate',
                commandLine: candidate.commandLine,
              },
            ],
          ],
    );
    const ctx = {
      failureChain,
      lifecycleError: undefined,
      confirmFamilyExit: require('./restart.cjs').confirmFamilyExit,
      sealFamily: require('./restart.cjs').sealFamily,
      newChild,
      ownedIdentities,
      oldStopCheckpoint: {
        identity: old,
        stopReceipt: { ...old, stopped: true },
        scopeLease: claim,
      },
      error: Error(kind),
      stopped: true,
      // This fixture exercises the original live-stop branch. The new typed
      // branch is covered by prior-boot-restart.test.cjs, not enabled here.
      priorBoot: false,
      priorBootArchived: false,
      priorBootReleaseFailed: false,
      verifyNewWriter() {
        assert.equal(ctx.priorBoot, false);
      },
      releasePriorBootLocks() {
        assert.equal(ctx.priorBoot, false);
      },
      preserving: true,
      stopOwned: async (child) => {
        if (child) child.exitCode = 1;
        return kind === 'wrong-stop-receipt'
          ? { ...candidate, startUtc: 'changed', stopped: true }
          : { ...candidate, stopped: true };
      },
      require: (id) =>
        id === './release-scope.cjs'
          ? { session: () => claim }
          : id === './project-writer-gate.cjs'
            ? gate
            : require(id),
      database,
      fs,
      path,
      audit: root,
      previous: 'synthetic old package',
      previousManifest: {},
      options: { production: false },
      schemaProof: undefined,
      finalBackup: undefined,
      fallbackChild: undefined,
      start() {
        starts++;
        fallbackLease = gate.acquireWriter(database);
        // The real start() records the owned command before returning its child.
        ownedIdentities.set(33333, { commandLine: 'synthetic fallback' });
        return { pid: 33333 };
      },
      waitReady: async () => {},
      port: 45678,
      processIdentity: () => ({}),
      writeActiveReleaseAsync: async () => {},
      writeJson() {},
    };
    try {
      if (
        [
          'wrong-stop-receipt',
          'late-writer-race',
          'crash-without-observed-identity',
        ].includes(kind)
      ) {
        await assert.rejects(runCatch(ctx));
        assert.equal(starts, 0);
        assert(fs.existsSync(b.file));
      } else {
        assert.equal((await runCatch(ctx)).rollbackUsed, true);
        assert.equal(starts, 1);
        if (newChild)
          assert.equal(confirms[0][2].identity.startUtc, candidate.startUtc);
      }
    } finally {
      if (fallbackLease) fallbackLease.close();
      assert.equal(path.dirname(root), fs.realpathSync.native(os.tmpdir()));
      assert(path.basename(root).startsWith('legacy-catch-'));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
