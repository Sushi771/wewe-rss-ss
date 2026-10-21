'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  crypto = require('node:crypto');
const scope = require('./release-scope.cjs'),
  { fileHash, hostEffects } = require('./lib.cjs');
const hash = (value) =>
  crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const candidate = '3a36428210f22ea1986f0a96a6066e7fdc9baf46',
  rollback = 'f618e48f48ff0e3df1c646cb8a666a2461815732';
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-held-6643-')),
    output = path.join(base, 'output'),
    registry = path.join(base, 'registry');
  fs.mkdirSync(output);
  fs.mkdirSync(registry);
  t.after(() => {
    assert(path.basename(base).startsWith('wewe-held-6643-'));
    fs.rmSync(base, { recursive: true, force: true });
  });
  const id = () => crypto.randomUUID(),
    oldId = id(),
    claimId = id();
  const write = (file, value) => {
    fs.writeFileSync(file, JSON.stringify(value));
    return { path: file, sha256: fileHash(file) };
  };
  const root = scope.inspect([output]).roots[0],
    reg = scope.inspect([registry]).roots[0];
  const oldPolicy = {
    format: 1,
    phase: 'build-only',
    scopeId: oldId,
    registryDirectory: registry,
    registryIdentity: reg.identity,
    roots: [root],
    maxBytes: 65536,
    maxGrowthBytes: 65536,
    maxNewRuntimeCopies: 2,
    buildOnly: { outputRoot: output },
  };
  const oldPolicyRef = write(path.join(registry, 'old-policy.json'), oldPolicy);
  const source = path.join(output, 'old-partial'),
    held = path.join(output, '.held-' + claimId);
  fs.mkdirSync(path.join(source, 'build/tmp'), { recursive: true });
  fs.mkdirSync(path.join(source, 'server'));
  for (const [relative, size] of [
    ['package.json', 79],
    ['build/package.json', 77],
    ['build/schema.prisma', 6487],
  ])
    fs.writeFileSync(path.join(source, relative), Buffer.alloc(size, 65));
  const dirs = ['', 'build', 'build/tmp', 'server'].map((relative) => ({
    relative,
    identity: scope.inspect([path.join(source, relative)]).roots[0].identity,
  }));
  const files = [
    'build/package.json',
    'build/schema.prisma',
    'package.json',
  ].map((relative) => ({
    path: relative,
    bytes: fs.statSync(path.join(source, relative)).size,
    sha256: fileHash(path.join(source, relative)),
  }));
  const claim = {
    id: claimId,
    kind: 'build',
    root: output,
    reserveBytes: 8192,
    runtimeCopies: 1,
  };
  const payload = {
    format: 1,
    configSha: oldPolicyRef.sha256,
    claim,
    outputs: [
      {
        path: source,
        complete: false,
        claim: claimId,
        identity: dirs[0].identity,
      },
    ],
  };
  const ledger = write(path.join(registry, oldId + '.state.json'), {
    payload,
    digest: hash(payload),
  });
  fs.writeFileSync(ledger.path + '.adopted', oldPolicyRef.sha256);
  const sentinel = {
    path: ledger.path + '.adopted',
    sha256: fileHash(ledger.path + '.adopted'),
  };
  const stat = fs.lstatSync(ledger.path, { bigint: true }),
    ledgerIdentity = ['dev', 'ino', 'birthtimeNs'].map((k) => String(stat[k]));
  const failure = write(path.join(base, 'failure.json'), {
    controllerSession: 123,
    exitCode: 1,
    claim,
    policy: oldPolicyRef,
  });
  const intentPath = path.join(registry, 'move.intent.json'),
    movedPath = path.join(registry, 'move.moved.json');
  const plan = {
    kind: 'one-off-retain-failed-6643-bytes',
    originalFailure: {
      scopeId: oldId,
      claimId,
      policy: oldPolicyRef,
      receiptPath: failure.path,
      receiptSha256: failure.sha256,
      ledgerPath: ledger.path,
      ledgerSha256: ledger.sha256,
      ledgerFileIdentity: ledgerIdentity,
      adoptionSentinel: sentinel,
      claim,
    },
    roots: {
      outputRoot: output,
      outputIdentity: root.identity,
      registry,
      registryIdentity: reg.identity,
    },
    move: {
      source,
      destination: held,
      retainedBytes: 6643,
      directories: dirs,
      files,
    },
    controllerExit: { originalExecSession: 123 },
    appendOnlyMapping: { intentPath, movedPath },
  };
  const planRef = write(path.join(base, 'plan.json'), plan);
  const common = {
    planSha256: planRef.sha256,
    original: {
      claimId,
      policySha256: oldPolicyRef.sha256,
      ledgerSha256: ledger.sha256,
    },
    source,
    destination: held,
    retainedBytes: 6643,
    capacityFreedBytes: 0,
    oldOutputSuccessful: false,
    files,
    directories: dirs,
    controller: { check: { querySucceeded: true, matchingCount: 0 } },
  };
  const intent = write(intentPath, { ...common, status: 'move-intent' });
  fs.renameSync(source, held);
  const moved = write(movedPath, {
    ...common,
    status: 'failed-retained-relocated',
    intentSha256: intent.sha256,
    sourceAbsent: true,
    destinationVerified: true,
    oldLedgerUnchanged: true,
    oldSentinelUnchanged: true,
  });
  const policy = {
    format: 1,
    phase: 'build-only',
    scopeId: id(),
    registryDirectory: registry,
    registryIdentity: reg.identity,
    ...scope.inspect([output]),
    maxBytes: 65536,
    maxGrowthBytes: 65536 - 6643,
    maxNewRuntimeCopies: 2,
    protectedIds: [],
    buildOnly: {
      outputRoot: output,
      runtimeSha256: fileHash(process.execPath),
      commands: [],
      sources: [
        { sourceCommit: candidate, sourceHash: 'b'.repeat(64) },
        { sourceCommit: rollback, sourceHash: 'c'.repeat(64) },
      ],
      recoveryOf: { format: 'held-6643-v1', plan: planRef, intent, moved },
    },
  };
  const config = path.join(registry, 'new-policy.json');
  const save = () => fs.writeFileSync(config, JSON.stringify(policy));
  save();
  const request = {
    kind: 'build',
    root: output,
    reserveBytes: 8192,
    runtimeCopies: 1,
    buildOnly: true,
    sourceCommit: candidate,
    sourceHash: 'b'.repeat(64),
    pairSession: true,
  };
  const options = () => ({
    configPath: config,
    configSha256: fileHash(config),
  });
  return {
    base,
    output,
    registry,
    held,
    policy,
    config,
    save,
    options,
    request,
    ledger,
    sentinel,
    oldPolicyRef,
    planRef,
    intent,
    moved,
    plan,
    write,
    claimId,
    oldId,
    association: path.join(
      registry,
      'recovery-' + claimId + '.fresh-session.private.json',
    ),
  };
}

test('one approved held mapping starts a fresh in-memory pair, retains old controls and charges all held bytes', (t) => {
  const f = fixture(t),
    preview = scope.inspectHeldRecovery(f.policy);
  assert.equal(preview.retainedBytes, 6643);
  assert(!fs.existsSync(f.association));
  assert(!fs.existsSync(path.join(f.registry, f.oldId + '.lock')));
  const lease = scope.open(f.request, f.options());
  assert(fs.existsSync(path.join(f.registry, f.oldId + '.lock')));
  const state = JSON.parse(
    fs.readFileSync(path.join(f.registry, f.policy.scopeId + '.state.json')),
  ).payload;
  assert.equal(state.recovery.retainedBytes, 6643);
  assert.equal(state.recovery.oldLedgerSha256, f.ledger.sha256);
  assert.equal(state.outputs.length, 0);
  assert(fs.existsSync(f.association));
  const at = path.join(f.output, 'new-candidate');
  lease.registerOutput(at);
  fs.mkdirSync(at);
  lease.createdOutput(at);
  hostEffects.context.run(lease, () =>
    hostEffects.fs.writeFileSync(
      path.join(at, 'artifact'),
      'fresh compiler bytes',
    ),
  );
  lease.nextBuild({
    ...f.request,
    sourceCommit: rollback,
    sourceHash: 'c'.repeat(64),
  });
  lease.check();
  lease.close();
  assert.equal(fileHash(f.ledger.path), f.ledger.sha256);
  assert.equal(fileHash(f.sentinel.path), f.sentinel.sha256);
  assert(!fs.existsSync(path.join(f.registry, f.oldId + '.lock')));
  assert.throws(() => scope.open(f.request, f.options()), /NEW_SESSION/);
});

test('a second new scope cannot reset the one-off association or its retained occupancy', (t) => {
  const f = fixture(t),
    lease = scope.open(f.request, f.options());
  lease.close();
  f.policy.scopeId = crypto.randomUUID();
  f.save();
  assert.throws(
    () => scope.open(f.request, f.options()),
    /ASSOCIATION_ALREADY_SPENT/,
  );
  assert.equal(fileHash(f.ledger.path), f.ledger.sha256);
  assert(!fs.existsSync(path.join(f.registry, f.oldId + '.lock')));
});

for (const mode of [
  'receipt',
  'file',
  'extra',
  'baseline-credit',
  'runtime-credit',
  'wrong-first',
  'standalone',
  'no-binding',
  'old-owner',
  'reuse-old-scope',
  'control-budget',
  'raised-cap',
  'raised-runtime-limit',
])
  test(
    'held recovery refuses ' + mode + ' without changing old evidence',
    (t) => {
      const f = fixture(t);
      let expected = /RECOVERY|BUILD_ROOT/;
      if (mode === 'receipt') fs.appendFileSync(f.moved.path, ' ');
      if (mode === 'file')
        fs.writeFileSync(
          path.join(f.held, 'package.json'),
          Buffer.alloc(79, 66),
        );
      if (mode === 'extra')
        fs.writeFileSync(path.join(f.held, 'external'), 'preserve');
      if (mode === 'baseline-credit') f.policy.baseline.bytes = 0;
      if (mode === 'runtime-credit') f.policy.baseline.runtimeCopies = 1;
      if (mode === 'wrong-first')
        Object.assign(f.request, {
          sourceCommit: rollback,
          sourceHash: 'c'.repeat(64),
        });
      if (mode === 'standalone') f.request.pairSession = false;
      if (mode === 'no-binding') delete f.policy.buildOnly.recoveryOf;
      if (mode === 'old-owner') {
        fs.writeFileSync(
          path.join(f.registry, f.oldId + '.lock'),
          'foreign-owner',
        );
        expected = /EEXIST/;
      }
      if (mode === 'reuse-old-scope') f.policy.scopeId = f.oldId;
      if (mode === 'control-budget')
        fs.writeFileSync(
          path.join(f.registry, 'synthetic-padding'),
          Buffer.alloc(60000),
        );
      if (mode === 'raised-cap') f.policy.maxBytes++;
      if (mode === 'raised-runtime-limit') f.policy.maxNewRuntimeCopies = 3;
      f.save();
      assert.throws(() => scope.open(f.request, f.options()), expected);
      assert.equal(fileHash(f.ledger.path), f.ledger.sha256);
      assert.equal(fileHash(f.sentinel.path), f.sentinel.sha256);
      assert(!fs.existsSync(f.association));
      if (mode === 'old-owner')
        assert.equal(
          fs.readFileSync(path.join(f.registry, f.oldId + '.lock'), 'utf8'),
          'foreign-owner',
        );
    },
  );

test('changing old ledger and its self-hash cannot rebind an active fresh session', (t) => {
  const f = fixture(t),
    lease = scope.open(f.request, f.options()),
    doc = JSON.parse(fs.readFileSync(f.ledger.path));
  doc.payload.claim.reserveBytes++;
  doc.digest = hash(doc.payload);
  fs.writeFileSync(f.ledger.path, JSON.stringify(doc));
  assert.throws(() => lease.check(), /RECOVERY_BINDING/);
  assert.throws(
    () => lease.close(Error('old evidence changed')),
    /RECOVERY_BINDING/,
  );
  const state = JSON.parse(
    fs.readFileSync(path.join(f.registry, f.policy.scopeId + '.state.json')),
  ).payload;
  assert(state.claim);
  assert(fs.existsSync(f.association));
  assert.equal(fileHash(f.sentinel.path), f.sentinel.sha256);
});

test('a changed association is held rather than recreated or silently released', (t) => {
  const f = fixture(t),
    lease = scope.open(f.request, f.options());
  fs.appendFileSync(f.association, ' ');
  assert.throws(() => lease.check(), /ASSOCIATION_CHANGED/);
  assert.throws(
    () => lease.close(Error('association changed')),
    /ASSOCIATION_CHANGED/,
  );
  assert(fs.existsSync(path.join(f.registry, f.oldId + '.lock')));
  assert(fs.existsSync(path.join(f.registry, f.policy.scopeId + '.lock')));
  assert.equal(fileHash(f.ledger.path), f.ledger.sha256);
});

test('held bytes cannot be subtracted from the next copy peak and a failed advance cannot retry', (t) => {
  const f = fixture(t);
  f.policy.maxBytes = 16000;
  f.policy.maxGrowthBytes = 16000 - 6643;
  f.save();
  const lease = scope.open(f.request, f.options()),
    at = path.join(f.output, 'candidate');
  lease.registerOutput(at);
  fs.mkdirSync(at);
  lease.createdOutput(at);
  hostEffects.context.run(lease, () =>
    hostEffects.fs.writeFileSync(path.join(at, 'artifact'), Buffer.alloc(4096)),
  );
  assert.throws(
    () =>
      lease.nextBuild({
        ...f.request,
        sourceCommit: rollback,
        sourceHash: 'c'.repeat(64),
      }),
    /COPY_PEAK/,
  );
  assert.throws(
    () =>
      lease.nextBuild({
        ...f.request,
        sourceCommit: rollback,
        sourceHash: 'c'.repeat(64),
        reserveBytes: 1,
      }),
    /PAIR_SESSION/,
  );
  assert.throws(
    () => lease.close(Error('capacity exceeded')),
    /FAILED_OUTPUT_HELD/,
  );
  assert.equal(fileHash(f.ledger.path), f.ledger.sha256);
  assert(fs.existsSync(f.association));
});
