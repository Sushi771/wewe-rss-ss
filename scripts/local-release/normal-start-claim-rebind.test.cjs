const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  validatePriorBootEmpty: validate,
  referenceDigest,
} = require('./normal-start-claim-rebind.cjs');
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
const hash = (v) => sha(JSON.stringify(v));
const H = (c) => c.repeat(64);
function fixture() {
  const root = { packageId: 'app', entry: 'runtime.cjs' };
  const child = {
    packageId: 'app',
    entry: 'worker.cjs',
    parentEntry: root.entry,
  };
  const policy = {
    windowsReferences: { launchers: [root, child] },
    preservingUpdate: {
      processFamily: {},
      active: {
        currentId: 'app',
        currentManifestSha256: H('a'),
        pointerSha256: H('b'),
        oldProcess: {
          pid: 10,
          startUtc: '2026-01-01T00:00:00.0000001Z',
          executableSha256: H('c'),
        },
      },
    },
  };
  function records(pid, startUtc) {
    return [
      {
        kind: 'pointers',
        identity: 'pointer',
        packageId: 'app',
        packagePath: 'synthetic/app',
        pointerPath: 'synthetic/active.json',
      },
      {
        kind: 'processes',
        identity: 'root-' + pid,
        packageId: 'app',
        packagePath: 'synthetic/app',
        pid,
        startUtc,
        executableSha256: H('c'),
        parentPid: 2,
        invocationSha256: hash(root),
        parentInvocationSha256: null,
      },
      {
        kind: 'processes',
        identity: 'child-' + pid,
        packageId: 'app',
        packagePath: 'synthetic/app',
        pid: pid + 1,
        startUtc,
        executableSha256: H('c'),
        parentPid: pid,
        invocationSha256: hash(child),
        parentInvocationSha256: hash(root),
      },
      {
        kind: 'tasks',
        identity: 'task',
        definitionSha256: H('d'),
        packageId: 'app',
        packagePath: 'synthetic/app',
      },
    ];
  }
  const facts = (rows) => ({
    complete: false,
    observationComplete: true,
    processObservation: 'preserving-project-only',
    categories: { processes: 'observed', tasks: 'observed' },
    records: rows,
    errors: [],
    uncertainChildren: [],
    processTopology: [],
    compatibility: {
      verified: true,
      businessDatabaseRestored: false,
      proofSha256: H('e'),
    },
  });
  const oldFacts = facts(
    records(10, policy.preservingUpdate.active.oldProcess.startUtc),
  );
  const claim = {
    id: 'synthetic',
    kind: 'install',
    outputs: [],
    refs: referenceDigest(oldFacts),
  };
  const lease = {
    version: 1,
    mode: 'writer',
    databaseIdentity: H('f'),
    pid: 10,
    startUtc: policy.preservingUpdate.active.oldProcess.startUtc,
    executableHash: H('c'),
    commandHash: sha('synthetic-command'),
    acquiredAt: Date.parse('2026-01-01T00:00:01Z'),
  };
  const bootUtc = '2026-01-02T00:00:00Z';
  return {
    oldPolicy: policy,
    oldFacts,
    claim,
    binding: { bootUtc },
    evidence: {
      leaseRaw: JSON.stringify(lease),
      intentRaw: JSON.stringify({
        observations: [1, 2].map((n) => ({
          bootUtc,
          atUtc: `2026-01-02T00:00:0${n}Z`,
          complete: true,
          remaining: [],
          portOwners: [],
          owner: null,
        })),
      }),
    },
    nowUtc: '2026-01-02T00:00:07Z',
  };
}
function cold() {
  const v = fixture();
  v.oldPolicy.preservingUpdate.operation = 'install';
  v.oldPolicy.preservingUpdate.processFamily.format = 1;
  v.oldPolicy.preservingUpdate.effectScope = { format: 1 };
  const launcher = { pointerPath: 'synthetic/active.json', files: [] };
  v.oldPolicy.windowsReferences.launchers.push(launcher);
  const spec = {
    kind: 'prior-boot-empty-install-v1',
    helperSha256: H('1'),
    oldReferences: v.claim.refs,
    oldFacts: {
      path: 'synthetic/old.json',
      sha256: H('2'),
      origin: 'reconstructed',
    },
    database: { path: 'synthetic/db', identity: H('f') },
    writer: {
      path: 'synthetic/lease',
      sha256: H('3'),
      identity: ['1', '2', '3'],
    },
    observer: { path: 'synthetic/observer', sha256: H('4') },
    bootUtc: v.binding.bootUtc,
    commandHash: sha('synthetic-command'),
    launcherTransition: {
      pointer: launcher.pointerPath,
      oldSha256: hash([]),
      newSha256: hash([]),
    },
    lockSha256: H('5'),
    identityObserverSha256: H('9'),
    tcpListenersSha256: H('a'),
    recoverySha256: H('6'),
    restartBinding: {
      path: 'synthetic/restart',
      oldSha256: H('7'),
      newSha256: H('8'),
    },
  };
  const lease = JSON.parse(v.evidence.leaseRaw);
  lease.nonce = '00000000-0000-0000-0000-000000000000';
  const facts = structuredClone(v.oldFacts);
  facts.records = facts.records.filter((r) => r.kind !== 'processes');
  return {
    policy: v.oldPolicy,
    oldFacts: v.oldFacts,
    facts,
    spec,
    lease,
    observations: JSON.parse(v.evidence.intentRaw).observations,
    nowUtc: v.nowUtc,
  };
}
test('exact reconstructed preimage admits only the prior-boot family becoming empty', () => {
  const v = cold(),
    before = structuredClone(v);
  const out = validate(v);
  assert.equal(out.oldReferences, v.spec.oldReferences);
  assert.equal(out.oldFactsOrigin, 'reconstructed');
  assert.deepEqual(v, before);
});
for (const [name, mutate] of Object.entries({
  'old facts missing': (v) => {
    v.oldFacts = {};
  },
  'old digest mismatch': (v) => {
    v.oldFacts.records[0].identity = 'other';
  },
  'unrelated task changed': (v) => {
    v.facts.records[1].identity = 'other';
  },
  'new live writer': (v) => {
    v.facts.records.push(v.oldFacts.records[1]);
  },
  'unknown proof field': (v) => {
    v.spec.allowMissing = true;
  },
  'build operation': (v) => {
    v.policy.preservingUpdate.operation = 'build';
  },
  'same boot': (v) => {
    v.spec.bootUtc = '2025-12-31T00:00:00Z';
  },
  'boot drift': (v) => {
    v.observations[1].bootUtc = '2026-01-02T00:00:01Z';
  },
  'old owner still alive': (v) => {
    v.observations[1].owner = { pid: 10, startUtc: v.lease.startUtc };
  },
  'remaining family': (v) => {
    v.observations[1].remaining = [11];
  },
  'another listener': (v) => {
    v.observations[1].portOwners = [77];
  },
  'incomplete observation': (v) => {
    v.observations[1].complete = false;
  },
  'stale observation': (v) => {
    v.nowUtc = '2026-01-02T00:01:00Z';
  },
  'future observation': (v) => {
    v.nowUtc = '2026-01-02T00:00:01Z';
  },
  'DB identity drift': (v) => {
    v.lease.databaseIdentity = H('0');
  },
  'wrong command': (v) => {
    v.lease.commandHash = H('0');
  },
  'wrong nonce': (v) => {
    v.lease.nonce = 'unknown';
  },
  'old family incomplete': (v) => {
    v.oldFacts.records.splice(2, 1);
    v.spec.oldReferences = referenceDigest(v.oldFacts);
  },
  'different active identity': (v) => {
    v.policy.preservingUpdate.active.oldProcess.startUtc =
      '2026-01-01T00:00:00.0000002Z';
  },
}))
  test('rejects ' + name, () => {
    const v = cold();
    mutate(v);
    assert.throws(() => validate(v));
  });
test('numeric PID reuse is not claimed stopped; independent complete refs must remain empty', () => {
  const v = cold();
  v.observations[1].owner = {
    pid: 10,
    startUtc: '2026-01-02T00:00:00.0000001Z',
  };
  validate(v);
  v.facts.records.push({
    ...v.oldFacts.records[1],
    startUtc: v.observations[1].owner.startUtc,
  });
  assert.throws(() => validate(v));
});
test('diagnostic topology is not permission to omit digest-participating process records', () => {
  const v = cold(),
    original = referenceDigest(v.oldFacts);
  v.oldFacts.processTopology = [{ pid: 99 }];
  assert.equal(referenceDigest(v.oldFacts), original);
  v.oldFacts.records[1].pid++;
  assert.notEqual(referenceDigest(v.oldFacts), original);
});
test('read-only loader uses the two pinned native scripts without identity-cache preparation', () => {
  const fs = require('node:fs'),
    path = require('node:path'),
    os = require('node:os');
  const cp = require('node:child_process'),
    helper = require('./normal-start-claim-rebind.cjs');
  const root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-priorboot-read-')),
  );
  const previousExec = cp.execFileSync,
    previousSystemRoot = process.env.SystemRoot;
  try {
    const v = cold(),
      pin = (file, value) => {
        fs.writeFileSync(file, value);
        return {
          path: fs.realpathSync.native(file),
          sha256: sha(fs.readFileSync(file)),
        };
      };
    const release = path.join(root, '.local-releases', 'app');
    fs.mkdirSync(release, { recursive: true });
    const database = path.join(root, 'synthetic.db');
    pin(database, 'inert');
    const writer = pin(path.join(root, 'writer.json'), JSON.stringify(v.lease));
    const stat = fs.lstatSync(writer.path, { bigint: true });
    v.spec.writer = {
      ...writer,
      identity: [stat.dev, stat.ino, stat.birthtimeNs].map(String),
    };
    v.spec.database.path = database;
    const gate = pin(
      path.join(release, 'project-writer-gate.cjs'),
      'module.exports={binding:()=>(' +
        JSON.stringify({
          file: writer.path,
          databaseIdentity: v.spec.database.identity,
        }) +
        ')};',
    );
    const manifest = pin(
      path.join(release, 'release.json'),
      JSON.stringify({ files: { 'project-writer-gate.cjs': gate.sha256 } }),
    );
    const pointer = pin(
      path.join(root, '.local-releases', 'active.json'),
      JSON.stringify({ id: 'app' }),
    );
    Object.assign(v.policy.preservingUpdate.active, {
      pointer: pointer.path,
      pointerSha256: pointer.sha256,
      currentManifestSha256: manifest.sha256,
    });
    v.spec.oldFacts = {
      ...pin(path.join(root, 'old-facts.json'), JSON.stringify(v.oldFacts)),
      origin: 'reconstructed',
    };
    v.spec.observer = pin(
      path.join(root, 'observe-writer-exit.ps1'),
      '# inert test observer',
    );
    v.spec.helperSha256 = sha(
      fs.readFileSync(require.resolve('./normal-start-claim-rebind.cjs')),
    );
    v.spec.identityObserverSha256 = sha(
      fs.readFileSync(path.join(__dirname, 'process-identity.ps1')),
    );
    v.spec.tcpListenersSha256 = sha(
      fs.readFileSync(path.join(__dirname, 'tcp-listeners.ps1')),
    );
    v.policy.preservingUpdate.priorBootExit = v.spec;
    process.env.SystemRoot = root;
    const calls = [];
    cp.execFileSync = (exe, args, options) => {
      calls.push(args);
      assert.equal(
        exe,
        path.join(root, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      );
      assert.equal(options.windowsHide, true);
      assert(
        Object.keys(options.env).every((k) =>
          [
            'SystemRoot',
            'WINDIR',
            'PATH',
            'PATHEXT',
            'TEMP',
            'TMP',
            'COMSPEC',
          ].includes(k),
        ),
      );
      return JSON.stringify(
        args.includes('-OwnerPid') ? v.observations[0] : [],
      );
    };
    const evidence = helper.readPriorBootEvidence(v.policy);
    helper.validatePriorBootLeaseEligibility({
      policy: v.policy,
      ...evidence,
      nowUtc: v.nowUtc,
    });
    assert.equal(calls.length, 4);
    assert.equal(calls.filter((args) => args.includes('Port')).length, 2);
    assert(!fs.existsSync(path.join(root, '.local-releases/.identity-tools')));
    const expected = fs.readFileSync(writer.path, 'utf8');
    cp.execFileSync = (_exe, args) => {
      fs.writeFileSync(pointer.path, '{"id":"different"}');
      return JSON.stringify(
        args.includes('-OwnerPid') ? v.observations[0] : [],
      );
    };
    assert.throws(() => helper.readPriorBootEvidence(v.policy));
    assert.equal(fs.readFileSync(writer.path, 'utf8'), expected);
  } finally {
    cp.execFileSync = previousExec;
    if (previousSystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = previousSystemRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
