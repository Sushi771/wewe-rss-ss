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
