const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  crypto = require('node:crypto');
const admission = require('./once-pair-admission.cjs');
const { fingerprint, fileHash, hostEffects } = require('./lib.cjs');
const processes = require('node:child_process');
function identity(at) {
  const s = fs.lstatSync(at, { bigint: true });
  return [s.dev, s.ino, s.birthtimeNs].map(String);
}
function pkg(root, id) {
  const at = path.join(root, id);
  fs.mkdirSync(path.join(at, 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(at, 'internal'));
  fs.writeFileSync(
    path.join(at, 'runtime/node.exe'),
    'inert-runtime-not-executable',
  );
  fs.writeFileSync(path.join(at, 'internal/data'), 'inert ' + id);
  fs.symlinkSync(
    path.join(at, 'internal'),
    path.join(at, 'link'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  fs.writeFileSync(
    path.join(at, 'release.json'),
    JSON.stringify({
      format: 1,
      id,
      platform: process.platform,
      arch: process.arch,
      sourceCommit: 'a'.repeat(40),
      sourceHash: 'b'.repeat(64),
      schemaCompatibility: 'current',
      ...fingerprint(at),
    }),
  );
  return {
    id,
    path: fs.realpathSync.native(at),
    identity: identity(at),
    sourceCommit: 'a'.repeat(40),
    manifestSha256: fileHash(path.join(at, 'release.json')),
  };
}
function fixture(run) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-once-pair-'));
  for (const name of ['installed', 'sources', 'registry'])
    fs.mkdirSync(path.join(base, name));
  const root = fs.realpathSync.native(path.join(base, 'installed')),
    sources = fs.realpathSync.native(path.join(base, 'sources')),
    registry = fs.realpathSync.native(path.join(base, 'registry'));
  const specs = [
    pkg(root, 'current'),
    pkg(root, 'held'),
    pkg(sources, 'candidate'),
    pkg(sources, 'rollback'),
  ];
  fs.writeFileSync(
    path.join(root, 'active.json'),
    JSON.stringify({ format: 1, id: 'current' }),
  );
  fs.writeFileSync(path.join(root, 'business.db'), 'synthetic-business');
  fs.writeFileSync(path.join(root, 'backup.keep'), 'synthetic-recovery');
  const proof = path.join(base, 'compatibility.json');
  fs.writeFileSync(
    proof,
    JSON.stringify({
      format: 1,
      kind: 'additive-schema-unknown-claim-rollback',
      businessDatabaseRestored: false,
      checks: {
        additiveSchema: true,
        unknownClaimsPreserved: true,
        businessRowsPreserved: true,
        rollbackStarted: true,
      },
      ...Object.fromEntries(
        ['candidate', 'rollback'].map((role) => {
          const s = specs.find((row) => row.id === role);
          return [
            role,
            {
              id: s.id,
              sourceCommit: s.sourceCommit,
              manifestSha256: s.manifestSha256,
            },
          ];
        }),
      ),
    }),
  );
  const policy = {
    format: 1,
    mode: admission.MODE,
    scopeId: crypto.randomUUID(),
    approval: { confirmed: true, id: 'synthetic-test-approval' },
    limits: admission.LIMITS,
    codePins: admission.codePins(),
    roots: [root, sources].map((at) => ({ path: at, identity: identity(at) })),
    registryDirectory: registry,
    registryIdentity: identity(registry),
    installRoot: root,
    currentId: 'current',
    heldId: 'held',
    pointerSha256: fileHash(path.join(root, 'active.json')),
    legacyIds: ['held'],
    protectedPackages: specs,
    protectedIds: specs.map((s) => s.id),
    packageProofs: Object.fromEntries(
      specs.map((s) => [s.id, s.manifestSha256]),
    ),
    pair: ['candidate', 'rollback'].map((role) => ({
      role,
      id: role,
      source: specs.find((s) => s.id === role).path,
      target: path.join(root, role),
    })),
    compatibilityProofSha256: fileHash(proof),
    windowsReferences: {
      compatibilityProof: { path: proof, sha256: fileHash(proof) },
    },
    probe: {
      path: path.join(__dirname, 'windows-release-references.cjs'),
      sha256: fileHash(path.join(__dirname, 'windows-release-references.cjs')),
    },
  };
  const file = path.join(base, 'policy.json');
  const f = {
    base,
    root,
    registry,
    sources,
    specs,
    policy,
    file,
    pin() {
      fs.writeFileSync(file, JSON.stringify(policy));
      return fileHash(file);
    },
    facts() {
      return {
        complete: true,
        categories: Object.fromEntries(
          [
            'processes',
            'tasks',
            'shortcuts',
            'pointers',
            'rollback',
            'inflight',
          ].map((k) => [k, true]),
        ),
        records: [],
        errors: [],
        uncertainChildren: [],
        compatibility: {
          verified: true,
          businessDatabaseRestored: false,
          proofSha256: policy.compatibilityProofSha256,
        },
      };
    },
    apply(useEnvironment = false) {
      const original = processes.execFileSync;
      const previous = process.env.WEWE_ONCE_PAIR_SHA256;
      processes.execFileSync = (exe, argv, opts) => {
        assert.equal(exe, process.execPath);
        assert.deepEqual(argv, [policy.probe.path, file]);
        assert.equal(opts.timeout, 30000);
        return JSON.stringify(f.query ? f.query() : f.facts());
      };
      try {
        if (useEnvironment) {
          process.env.WEWE_ONCE_PAIR_SHA256 = f.pin();
          return admission.main(['--apply', file]);
        }
        return admission.main(['--apply', file, f.pin()]);
      } finally {
        processes.execFileSync = original;
        if (previous === undefined) delete process.env.WEWE_ONCE_PAIR_SHA256;
        else process.env.WEWE_ONCE_PAIR_SHA256 = previous;
      }
    },
    ledger() {
      return JSON.parse(
        fs.readFileSync(path.join(registry, policy.scopeId + '.state.json')),
      ).payload;
    },
  };
  f.pin();
  try {
    return run(f);
  } finally {
    assert(path.basename(base).startsWith('wewe-once-pair-'));
    fs.rmSync(base, { recursive: true });
  }
}
function patch(object, key, replacement, run) {
  const saved = object[key];
  object[key] = replacement(saved);
  try {
    return run();
  } finally {
    object[key] = saved;
  }
}
function prepareContinuation(f) {
  f.query = () => ({
    ...f.facts(),
    complete: false,
    errors: ['REFERENCE_BACKGROUND_GAP_UNBOUND'],
  });
  assert.throws(() => f.apply(), /REFERENCE_QUERY_INCOMPLETE/);
  delete f.query;
  const ledger = path.join(f.registry, f.policy.scopeId + '.state.json'),
    sentinel = ledger + '.adopted',
    previous = path.join(f.base, 'previous-policy.json'),
    outcome = path.join(f.base, 'failed-before-copy.json');
  fs.copyFileSync(f.file, previous);
  const spec = (at) => ({
    path: at,
    sha256: fileHash(at),
    identity: identity(at),
  });
  const oldSha = fileHash(previous),
    ledgerText = fs.readFileSync(ledger, 'utf8'),
    sentinelText = fs.readFileSync(sentinel, 'utf8');
  fs.writeFileSync(
    outcome,
    JSON.stringify({
      outcome: 'HELD_BEFORE_PACKAGE_COPY',
      executionPolicySha256: oldSha,
    }),
  );
  const c = {
    format: 1,
    kind: 'verified-pre-copy-continuation-v1',
    id: crypto.randomUUID(),
    previousLedger: spec(ledger),
    previousOutcome: spec(outcome),
    previousPolicy: spec(previous),
    previousSentinel: spec(sentinel),
  };
  f.policy.preCopyContinuation = c;
  f.policy.approval.id += '-continuation';
  f.policy.approval.continuation = {
    id: c.id,
    fromConfigSha: oldSha,
    fromLedgerSha: c.previousLedger.sha256,
    fromSentinelSha: c.previousSentinel.sha256,
  };
  return {
    ledger,
    sentinel,
    previous,
    outcome,
    c,
    ledgerText,
    sentinelText,
    receipt: admission.continuationPath(f.policy),
    spec,
    changeState(change) {
      const envelope = JSON.parse(fs.readFileSync(ledger, 'utf8'));
      change(envelope.payload);
      envelope.digest = crypto
        .createHash('sha256')
        .update(JSON.stringify(envelope.payload))
        .digest('hex');
      fs.writeFileSync(ledger, JSON.stringify(envelope));
      c.previousLedger = spec(ledger);
      f.policy.approval.continuation.fromLedgerSha = c.previousLedger.sha256;
    },
  };
}
test('pre-copy continuation archives exact old bytes, retains sentinel/credits and completes only one installation', () =>
  fixture((f) => {
    const b = prepareContinuation(f),
      result = f.apply();
    assert.equal(result.installedIds.length, 2);
    const state = f.ledger(),
      receipt = JSON.parse(fs.readFileSync(b.receipt, 'utf8'));
    assert.equal(receipt.previousLedgerText, b.ledgerText);
    assert.equal(fs.readFileSync(b.sentinel, 'utf8'), b.sentinelText);
    assert.equal(receipt.priorFailedAttempts, 1);
    assert.equal(state.continuationAttempt.status, 'installed');
    assert.equal(state.continuationAttempt.priorFailedAttempts, 1);
    assert.equal(state.configSha, fileHash(f.file));
    assert.equal(
      admission.validateContinuation(f.policy, state, fileHash(f.file))
        .sentinelConfigSha,
      b.sentinelText,
    );
    const receiptSha = fileHash(b.receipt);
    assert.equal(f.apply().admission.newRuntimeCopies, 0);
    assert.equal(fileHash(b.receipt), receiptSha);
  }));
test('pre-copy continuation refuses oversized pinned input before reading or hashing its contents', () =>
  fixture((f) => {
    const b = prepareContinuation(f);
    fs.writeFileSync(b.outcome, Buffer.alloc(admission.LIMITS.metadata + 1));
    b.c.previousOutcome = {
      path: b.outcome,
      identity: identity(b.outcome),
      sha256: 'f'.repeat(64),
    };
    let descriptor,
      reads = 0,
      wholeReads = 0;
    const open = fs.openSync,
      close = fs.closeSync,
      read = fs.readSync,
      wholeRead = fs.readFileSync;
    fs.openSync = (at, ...args) => {
      const fd = open(at, ...args);
      if (at === b.outcome) descriptor = fd;
      return fd;
    };
    fs.closeSync = (fd) => {
      if (fd === descriptor) descriptor = undefined;
      return close(fd);
    };
    fs.readSync = (fd, ...args) => {
      if (fd === descriptor) {
        reads++;
        throw new Error('OVERSIZED_INPUT_READ');
      }
      return read(fd, ...args);
    };
    fs.readFileSync = (at, ...args) => {
      if (at === b.outcome || (descriptor !== undefined && at === descriptor)) {
        wholeReads++;
        throw new Error('OVERSIZED_INPUT_WHOLE_READ');
      }
      return wholeRead(at, ...args);
    };
    try {
      assert.throws(() => f.apply(), /ONCE_PAIR_DOCUMENT_LIMIT/);
      assert.equal(reads, 0);
      assert.equal(wholeReads, 0);
      assert(!fs.existsSync(b.receipt));
      assert(!fs.existsSync(path.join(f.root, 'candidate')));
      assert(!fs.existsSync(path.join(f.root, 'rollback')));
    } finally {
      fs.openSync = open;
      fs.closeSync = close;
      fs.readSync = read;
      fs.readFileSync = wholeRead;
    }
  }));
for (const fault of [
  'started',
  'complete',
  'copied',
  'identity',
  'outputs',
  'claim',
  'publication',
  'credit',
  'unknown-state',
  'unknown-slot',
  'existing-target',
  'target-link',
  'legacy-tmp',
  'ledger-hash',
  'ledger-identity',
  'sentinel-hash',
  'sentinel-identity',
  'policy-hash',
  'policy-identity',
  'outcome-hash',
  'nonallowed-policy',
  'scope-changed',
  'approval-binding',
  'existing-receipt',
  'concurrent-lock',
  'metadata-limit',
  'unsupported-old-protocol',
])
  test('pre-copy continuation refuses ' + fault, () =>
    fixture((f) => {
      const b = prepareContinuation(f);
      if (['started', 'complete', 'copied'].includes(fault))
        b.changeState((s) => (s.slots[0][fault] = true));
      if (fault === 'identity')
        b.changeState((s) => (s.slots[0].identity = ['1', '2', '3']));
      if (fault === 'outputs')
        b.changeState((s) =>
          s.outputs.push({ path: path.join(f.root, 'candidate') }),
        );
      if (fault === 'claim')
        b.changeState((s) => (s.claim = { id: 'unknown' }));
      if (fault === 'publication')
        b.changeState((s) => (s.publication = { backupAttempts: 0 }));
      if (fault === 'credit') b.changeState((s) => (s.backupAttempts = 1));
      if (fault === 'unknown-state')
        b.changeState((s) => (s.unreviewed = false));
      if (fault === 'unknown-slot')
        b.changeState((s) => (s.slots[0].unreviewed = false));
      if (fault === 'existing-target')
        fs.mkdirSync(path.join(f.root, 'candidate'));
      if (fault === 'target-link')
        fs.symlinkSync(
          path.join(f.root, 'current'),
          path.join(f.root, 'candidate'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      if (fault === 'legacy-tmp')
        fs.writeFileSync(b.ledger + '.foreign.tmp', 'foreign');
      if (fault === 'ledger-hash') fs.appendFileSync(b.ledger, ' ');
      if (fault === 'ledger-identity') {
        fs.renameSync(b.ledger, b.ledger + '.prior');
        fs.writeFileSync(b.ledger, b.ledgerText);
      }
      if (fault === 'sentinel-hash')
        fs.writeFileSync(b.sentinel, 'f'.repeat(64));
      if (fault === 'sentinel-identity') {
        fs.renameSync(b.sentinel, b.sentinel + '.prior');
        fs.writeFileSync(b.sentinel, b.sentinelText);
      }
      if (fault === 'policy-hash') fs.appendFileSync(b.previous, ' ');
      if (fault === 'policy-identity') {
        const text = fs.readFileSync(b.previous);
        fs.renameSync(b.previous, b.previous + '.prior');
        fs.writeFileSync(b.previous, text);
      }
      if (fault === 'outcome-hash') fs.appendFileSync(b.outcome, ' ');
      if (fault === 'nonallowed-policy') f.policy.unreviewed = 'changed';
      if (fault === 'scope-changed') f.policy.scopeId = crypto.randomUUID();
      if (fault === 'approval-binding')
        f.policy.approval.continuation.fromLedgerSha = 'f'.repeat(64);
      if (fault === 'existing-receipt')
        fs.writeFileSync(b.receipt, 'partial or foreign receipt');
      if (fault === 'concurrent-lock')
        fs.writeFileSync(
          path.join(f.registry, f.policy.scopeId + '.lock'),
          'foreign lock',
        );
      if (fault === 'metadata-limit')
        fs.writeFileSync(
          path.join(f.root, '.release-lifecycle.json'),
          Buffer.alloc(admission.LIMITS.metadata),
        );
      if (fault === 'unsupported-old-protocol') {
        const old = JSON.parse(fs.readFileSync(b.previous, 'utf8'));
        old.codePins['lib.cjs'] = 'f'.repeat(64);
        fs.writeFileSync(b.previous, JSON.stringify(old));
        b.c.previousPolicy = b.spec(b.previous);
        f.policy.approval.continuation.fromConfigSha =
          b.c.previousPolicy.sha256;
      }
      assert.throws(() => f.apply());
      // No rejected transfer may allocate the other package.
      assert(!fs.existsSync(path.join(f.root, 'rollback')));
      if (!['existing-target', 'target-link'].includes(fault))
        assert(!fs.existsSync(path.join(f.root, 'candidate')));
      if (fault === 'existing-receipt')
        assert.equal(
          fs.readFileSync(b.receipt, 'utf8'),
          'partial or foreign receipt',
        );
    }),
  );
for (const fault of [
  'receipt-replaced',
  'receipt-in-place',
  'receipt-hardlinked',
  'legacy-tmp-after-install',
  'second-transfer-approval',
])
  test('completed continuation rejects authority change ' + fault, () =>
    fixture((f) => {
      const b = prepareContinuation(f);
      f.apply();
      const bytes = fs.readFileSync(b.receipt);
      if (fault === 'receipt-replaced') {
        fs.renameSync(b.receipt, b.receipt + '.prior');
        fs.writeFileSync(b.receipt, bytes);
      }
      if (fault === 'receipt-in-place') fs.appendFileSync(b.receipt, ' ');
      if (fault === 'receipt-hardlinked')
        fs.linkSync(b.receipt, path.join(f.base, 'receipt-alias'));
      if (fault === 'legacy-tmp-after-install')
        fs.writeFileSync(b.ledger + '.foreign.tmp', 'foreign');
      if (fault === 'second-transfer-approval') {
        f.policy.preCopyContinuation.id = crypto.randomUUID();
        f.policy.approval.id += '-again';
        f.policy.approval.continuation.id = f.policy.preCopyContinuation.id;
      }
      assert.throws(() => f.apply());
      assert(fs.existsSync(path.join(f.root, 'candidate')));
    }),
  );
test('pre-copy continuation spent before failed query cannot replay or receive another approval', () =>
  fixture((f) => {
    const b = prepareContinuation(f);
    f.query = () => ({
      ...f.facts(),
      complete: false,
      errors: ['REFERENCE_BACKGROUND_GAP_UNBOUND'],
    });
    assert.throws(() => f.apply(), /REFERENCE_QUERY_INCOMPLETE/);
    const bytes = fs.readFileSync(b.receipt),
      state = f.ledger();
    assert.equal(state.continuationAttempt.status, 'held');
    assert(state.slots.every((s) => !s.started));
    delete f.query;
    assert.throws(() => f.apply(), /CONTINUATION_ALREADY_CONSUMED/);
    assert.deepEqual(fs.readFileSync(b.receipt), bytes);
  }));
for (const fault of [
  'receipt-create',
  'receipt-partial',
  'receipt-checksum',
  'before-ledger-commit',
  'after-ledger-commit',
  'during-install',
])
  test('pre-copy continuation conservatively holds interrupted ' + fault, () =>
    fixture((f) => {
      const b = prepareContinuation(f),
        write = fs.writeFileSync,
        open = fs.openSync,
        read = fs.readFileSync,
        rename = fs.renameSync;
      let receiptFd,
        created = false;
      fs.openSync = function (at, ...args) {
        if (at === b.receipt) {
          if (fault === 'receipt-create')
            throw Error('SIMULATED_CREATE_FAILURE');
          receiptFd = open.call(this, at, ...args);
          return receiptFd;
        }
        return open.call(this, at, ...args);
      };
      fs.writeFileSync = function (at, value, ...args) {
        if (at === receiptFd) {
          created = true;
          if (fault === 'receipt-checksum')
            return write.call(this, at, 'checksum mismatch', ...args);
          if (fault === 'receipt-partial') {
            write.call(this, at, 'partial receipt');
            throw Error('SIMULATED_PARTIAL_WRITE');
          }
        }
        return write.call(this, at, value, ...args);
      };
      fs.readFileSync = function (at, ...args) {
        return read.call(this, at, ...args);
      };
      fs.renameSync = function (from, to) {
        if (fault === 'before-ledger-commit' && to === b.ledger && created)
          throw Error('SIMULATED_COMMIT_FAILURE');
        return rename.call(this, from, to);
      };
      if (fault === 'after-ledger-commit')
        f.query = () => {
          throw Error('SIMULATED_AFTER_COMMIT');
        };
      if (fault === 'during-install') {
        const mkdir = fs.mkdirSync;
        fs.mkdirSync = function (at, ...args) {
          if (at === path.join(f.root, 'candidate'))
            throw Error('SIMULATED_INSTALL_FAILURE');
          return mkdir.call(this, at, ...args);
        };
        try {
          assert.throws(() => f.apply());
        } finally {
          fs.mkdirSync = mkdir;
        }
      } else {
        try {
          assert.throws(() => f.apply());
        } finally {
          fs.openSync = open;
          fs.writeFileSync = write;
          fs.readFileSync = read;
          fs.renameSync = rename;
        }
      }
      fs.openSync = open;
      fs.writeFileSync = write;
      fs.readFileSync = read;
      fs.renameSync = rename;
      delete f.query;
      const receiptBytes = fs.existsSync(b.receipt)
        ? fs.readFileSync(b.receipt)
        : null;
      assert.throws(() => f.apply());
      if (receiptBytes)
        assert.deepEqual(fs.readFileSync(b.receipt), receiptBytes);
      assert.equal(fs.readFileSync(b.sentinel, 'utf8'), b.sentinelText);
    }),
  );
test('review performs no adoption and does not require approval', () =>
  fixture((f) => {
    f.policy.approval.confirmed = false;
    const result = admission.main(['--review', f.file, f.pin()]);
    assert.equal(result.registryWritten, false);
    assert.equal(result.referencesQueried, false);
    assert.deepEqual(fs.readdirSync(f.registry), []);
    assert.throws(
      () => admission.main(['--apply', f.file, f.pin()]),
      /EXPLICIT_APPROVAL_REQUIRED/,
    );
  }));
test('admission failure before allocation retains inner query diagnostic for CLI without granting effects', () =>
  fixture((f) => {
    f.query = () => ({
      complete: false,
      operationSufficient: false,
      globalReferenceComplete: false,
      categories: { processes: false },
      records: [],
      errors: ['REFERENCE_BACKGROUND_GAP_UNBOUND'],
      uncertainChildren: [],
      referenceDiagnostic: {
        stage: 'processes',
        codes: ['REFERENCE_BACKGROUND_GAP_UNBOUND'],
        stderr: 'SECRET',
        commandLine: 'SECRET',
      },
    });
    let error;
    try {
      f.apply();
    } catch (e) {
      error = e;
    }
    assert.equal(error.message, 'RELEASE_SCOPE_REFERENCE_QUERY_INCOMPLETE');
    const output = admission.formatCliError(error);
    assert(output.includes('REFERENCE_BACKGROUND_GAP_UNBOUND'));
    assert(output.includes('processes'));
    assert(!output.includes('SECRET'));
    assert(!fs.existsSync(path.join(f.root, 'candidate')));
    assert(!fs.existsSync(path.join(f.root, 'rollback')));
    assert(f.ledger().slots.every((s) => !s.started && !s.complete));
    assert.equal(
      fs.readFileSync(path.join(f.root, 'business.db'), 'utf8'),
      'synthetic-business',
    );
  }));
test('private chain diagnostic persists raw related rows in the sole ledger without CLI leakage', () =>
  fixture((f) => {
    const row = {
      pid: 200,
      parentPid: process.pid,
      name: 'node.exe',
      executable: 'C:/PRIVATE/node.exe',
      commandLine: 'SECRET_ARGV',
      startUtc: '2026-01-01T00:00:00Z',
    };
    f.query = () => ({
      ...f.facts(),
      complete: false,
      errors: ['REFERENCE_PROBE_CHILD_UNCERTAIN'],
      referenceDiagnostic: {
        stage: 'collector-chain',
        chainBranch: 'unexpected-descendant',
        codes: ['REFERENCE_PROBE_CHILD_UNCERTAIN'],
      },
      privateReferenceDiagnostic: {
        format: 1,
        branch: 'unexpected-descendant',
        before: [row],
        after: [row],
      },
    });
    let error;
    try {
      f.apply();
    } catch (e) {
      error = e;
    }
    assert.equal(error.message, 'RELEASE_SCOPE_REFERENCE_QUERY_INCOMPLETE');
    assert.equal(error.referenceDiagnostic.diagnosticStored, true);
    assert.deepEqual(f.ledger().referenceFailures[0].privateDiagnostic.before, [
      row,
    ]);
    assert(admission.formatCliError(error).includes('unexpected-descendant'));
    assert(!/SECRET|PRIVATE/.test(admission.formatCliError(error)));
    assert(!fs.existsSync(f.policy.pair[0].target));
    assert(f.ledger().slots.every((s) => !s.started));
  }));
test('private diagnostic persistence failure preserves original refusal and holds the owned lock', () =>
  fixture((f) => {
    f.query = () => ({
      ...f.facts(),
      complete: false,
      errors: ['REFERENCE_PROBE_CHILD_UNCERTAIN'],
      referenceDiagnostic: {
        stage: 'collector-chain',
        chainBranch: 'unexpected-descendant',
      },
      privateReferenceDiagnostic: {
        format: 1,
        branch: 'unexpected-descendant',
        before: [],
        after: [],
      },
    });
    const original = fs.writeFileSync;
    fs.writeFileSync = (at, data, ...rest) => {
      if (String(data).includes('referenceFailures'))
        throw Error('SYNTHETIC_DIAGNOSTIC_WRITE_FAILURE');
      return original(at, data, ...rest);
    };
    let error;
    try {
      f.apply();
    } catch (e) {
      error = e;
    } finally {
      fs.writeFileSync = original;
    }
    assert.equal(error.message, 'RELEASE_SCOPE_REFERENCE_QUERY_INCOMPLETE');
    assert.equal(error.referenceDiagnostic.diagnosticStored, false);
    assert(fs.existsSync(path.join(f.registry, f.policy.scopeId + '.lock')));
    assert(!fs.existsSync(f.policy.pair[0].target));
  }));
test('real CLI dispatch installs only frozen pair, keeps four protected IDs and three managed roles', () =>
  fixture((f) => {
    const immutable = f.specs.slice(0, 2).map((s) => fingerprint(s.path));
    const pointer = fileHash(path.join(f.root, 'active.json'));
    const result = f.apply();
    assert.deepEqual(result.installedIds.sort(), ['candidate', 'rollback']);
    assert.equal(result.admission.maxAdditionalBytes, 245837824);
    assert.equal(result.admission.publicationAuthorized, false);
    assert.equal(result.admission.newRuntimeCopies, 2);
    assert.equal(fileHash(path.join(f.root, 'active.json')), pointer);
    assert.deepEqual(
      f.specs.slice(0, 2).map((s) => fingerprint(s.path)),
      immutable,
    );
    assert.equal(
      fs.readFileSync(path.join(f.root, 'business.db'), 'utf8'),
      'synthetic-business',
    );
    assert.equal(
      fs.readFileSync(path.join(f.root, 'backup.keep'), 'utf8'),
      'synthetic-recovery',
    );
    const state = JSON.parse(
      fs.readFileSync(path.join(f.root, '.release-lifecycle.json')),
    ).payload;
    assert.deepEqual(state.managedIds.sort(), [
      'candidate',
      'current',
      'rollback',
    ]);
    assert.deepEqual(state.legacyIds, ['held']);
    assert.equal(f.ledger().slots.length, 2);
    assert(f.ledger().complete);
    assert(!fs.existsSync(path.join(f.root, '.build-budget.lock')));
  }));
test('ordinary database and backup changes do not freeze capacity census history', () =>
  fixture((f) => {
    let n = 0;
    f.query = () => {
      fs.appendFileSync(path.join(f.root, 'business.db'), 'writer' + n++);
      fs.appendFileSync(path.join(f.root, 'backup.keep'), 'new');
      return f.facts();
    };
    assert.equal(f.apply().installedIds.length, 2);
    assert(n > 2);
  }));
test('below exact physical reserve fails before either target allocation', () =>
  fixture((f) => {
    patch(
      fs,
      'statfsSync',
      (original) =>
        (...args) => {
          const s = original(...args);
          return {
            ...s,
            bsize: 1n,
            bavail: BigInt(admission.LIMITS.free + admission.LIMITS.bytes - 1),
          };
        },
      () => assert.throws(() => f.apply(), /PHYSICAL_RESERVE/),
    );
    for (const item of f.policy.pair) assert(!fs.existsSync(item.target));
    assert.deepEqual(fs.readdirSync(f.registry), []);
  }));
test('exact physical admission boundary permits the pair with fixed ceilings', () =>
  fixture((f) => {
    patch(
      fs,
      'statfsSync',
      (original) =>
        (...args) => {
          const s = original(...args);
          return {
            ...s,
            bsize: 1n,
            bavail: BigInt(admission.LIMITS.free + admission.LIMITS.bytes),
          };
        },
      () => assert.equal(f.apply().installedIds.length, 2),
    );
  }));
test('missing reference category and unknown fifth reference both fail closed', () => {
  fixture((f) => {
    f.query = () => ({ ...f.facts(), categories: {} });
    assert.throws(() => f.apply(), /QUERY_INCOMPLETE/);
    assert(!fs.existsSync(f.policy.pair[0].target));
  });
  fixture((f) => {
    f.query = () => ({
      ...f.facts(),
      records: [
        {
          kind: 'rollback',
          packageId: 'fifth',
          packagePath: f.root,
          identity: 'x',
        },
      ],
    });
    assert.throws(() => f.apply(), /UNRESOLVED_REFERENCE/);
    assert(!fs.existsSync(f.policy.pair[0].target));
  });
});
test('changed protected bytes and raised budget cannot be admitted', () => {
  fixture((f) => {
    fs.appendFileSync(path.join(f.specs[1].path, 'internal/data'), 'changed');
    assert.throws(() => f.apply());
  });
  fixture((f) => {
    f.policy.limits = {
      ...admission.LIMITS,
      bytes: admission.LIMITS.bytes + 1,
    };
    assert.throws(() => f.apply(), /FINITE_LIMITS/);
  });
});
test('interrupted copy is retained and repeat refuses fresh runtime credit', () =>
  fixture((f) => {
    let wrote = false;
    patch(
      fs,
      'writeSync',
      (original) =>
        (...args) => {
          if (!wrote && Buffer.isBuffer(args[1]) && args[1].length === 65536) {
            wrote = true;
            original(...args);
            throw new Error('synthetic disk interruption');
          }
          return original(...args);
        },
      () => assert.throws(() => f.apply(), /HELD/),
    );
    assert(f.ledger().claim);
    assert(f.ledger().slots.some((s) => s.started));
    const before = fs.readdirSync(f.root).sort();
    assert.throws(() => f.apply(), /INTERRUPTED_OR_FOREIGN_LEDGER/);
    assert.deepEqual(fs.readdirSync(f.root).sort(), before);
  }));
test('unexpected pre-existing target cannot be adopted as a fresh output', () =>
  fixture((f) => {
    fs.mkdirSync(f.policy.pair[0].target);
    assert.throws(() => f.apply(), /ADOPTION_REQUIRES_REVIEW/);
    assert(!fs.existsSync(f.policy.pair[1].target));
  }));
test('successful replay reuses exactly two installed slots without another copy', () =>
  fixture((f) => {
    f.apply();
    const identities = f.policy.pair.map((item) => identity(item.target));
    const result = f.apply();
    assert.deepEqual(result.installedIds, []);
    assert.equal(result.admission.newRuntimeCopies, 0);
    assert.deepEqual(
      f.policy.pair.map((item) => identity(item.target)),
      identities,
    );
    assert.equal(f.ledger().slots.length, 2);
  }));
test('narrow lease rejects generic writers, third target, process and writable read flags before effects', () =>
  fixture((f) => {
    let saved;
    const pin = f.pin();
    assert.throws(
      () =>
        admission.withAdmission(
          f.file,
          pin,
          (lease) => {
            saved = lease;
            assert.throws(
              () =>
                hostEffects.fs.writeFileSync(path.join(f.root, 'third'), 'x'),
              /OUTPUT_CAPABILITY/,
            );
            assert.throws(
              () => hostEffects.processes.execFileSync('never-run'),
              /PROCESS_DENIED/,
            );
            assert.throws(
              () =>
                hostEffects.fs.readFileSync(path.join(f.root, 'business.db'), {
                  flag: 'w',
                }),
              /OUTPUT_CAPABILITY/,
            );
            assert.throws(() => hostEffects.assertWritable(), /INSTALL_ONLY/);
            throw new Error('synthetic no install');
          },
          { query: () => f.facts() },
        ),
      /synthetic no install/,
    );
    assert(!fs.existsSync(path.join(f.root, 'third')));
    assert.throws(
      () => saved.registerOutput(f.policy.pair[0].target),
      /CLOSED|ENOENT/,
    );
    assert.equal(
      fs.readFileSync(path.join(f.root, 'business.db'), 'utf8'),
      'synthetic-business',
    );
  }));
test('exact launcher argv form uses process-local digest without persistent configuration', () =>
  fixture((f) => {
    const previous = process.env.WEWE_ONCE_PAIR_SHA256;
    assert.equal(f.apply(true).installedIds.length, 2);
    assert.equal(process.env.WEWE_ONCE_PAIR_SHA256, previous);
  }));
test('narrow mode holds exact 129 historical names without inspecting their mutable contents', () =>
  fixture((f) => {
    for (let i = 0; i < 128; i++) {
      const name = 'historical-' + i;
      fs.mkdirSync(path.join(f.root, name));
      fs.writeFileSync(
        path.join(f.root, name, 'release.json'),
        'opaque-old-metadata-not-a-new-package',
      );
      f.policy.legacyIds.push(name);
    }
    f.policy.legacyIds.sort();
    assert.equal(f.apply().legacyHeldIds.length, 129);
    assert.equal(f.apply().installedIds.length, 0);
    f.policy.legacyIds.push('extra-history');
    assert.throws(() => f.apply(), /LEGACY_INVENTORY/);
  }));
for (const kind of [
  'ledger-replaced',
  'ledger-in-place',
  'lock-replaced',
  'same-token-lock',
  'policy-replaced',
  'registry-replaced',
  'sentinel-replaced',
])
  test('foreign authority is preserved on refusal: ' + kind, () =>
    fixture((f) => {
      const ledger = path.join(f.registry, f.policy.scopeId + '.state.json'),
        lock = path.join(f.registry, f.policy.scopeId + '.lock'),
        sentinel = ledger + '.adopted';
      let changed = false,
        preserved,
        expected;
      f.query = () => {
        if (!changed) {
          changed = true;
          if (kind === 'ledger-replaced') {
            fs.renameSync(ledger, ledger + '.prior');
            fs.writeFileSync(ledger, 'FOREIGN_LEDGER_MUST_BE_PRESERVED');
            preserved = ledger;
          }
          if (kind === 'ledger-in-place') {
            fs.writeFileSync(ledger, 'FOREIGN_IN_PLACE');
            preserved = ledger;
          }
          if (kind === 'lock-replaced' || kind === 'same-token-lock') {
            const token = fs.readFileSync(lock);
            fs.renameSync(lock, lock + '.prior');
            fs.writeFileSync(
              lock,
              kind === 'same-token-lock' ? token : 'FOREIGN_LOCK',
            );
            preserved = lock;
          }
          if (kind === 'policy-replaced') {
            fs.renameSync(f.file, f.file + '.prior');
            fs.copyFileSync(f.file + '.prior', f.file);
            preserved = ledger;
          }
          if (kind === 'registry-replaced') {
            fs.renameSync(f.registry, f.registry + '.prior');
            fs.mkdirSync(f.registry);
            fs.writeFileSync(ledger, 'FOREIGN_REGISTRY');
            preserved = ledger;
          }
          if (kind === 'sentinel-replaced') {
            const value = fs.readFileSync(sentinel);
            fs.renameSync(sentinel, sentinel + '.prior');
            fs.writeFileSync(sentinel, value);
            preserved = ledger;
          }
          expected = fs.readFileSync(preserved);
        }
        return f.facts();
      };
      assert.throws(() => f.apply());
      assert(changed);
      assert.deepEqual(fs.readFileSync(preserved), expected);
      assert(f.policy.pair.every((row) => !fs.existsSync(row.target)));
      if (kind !== 'registry-replaced')
        assert(
          fs.existsSync(lock),
          'uncertain owner lock must remain for review',
        );
    }),
  );
