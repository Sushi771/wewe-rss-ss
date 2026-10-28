const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installPair, DEFAULTS } = require('./install-lifecycle.cjs');
const { fingerprint, fileHash } = require('./lib.cjs');
function pkg(parent, id, schema = false) {
  const folder = path.join(parent, id);
  fs.mkdirSync(path.join(folder, 'runtime'), { recursive: true });
  fs.writeFileSync(
    path.join(folder, 'runtime/node.exe'),
    'synthetic-runtime-never-executed',
  );
  fs.writeFileSync(path.join(folder, 'app.cjs'), 'synthetic ' + id);
  if (schema) {
  fs.mkdirSync(path.join(folder, 'server/prisma/migrations/001'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'server/prisma/schema.prisma'), 'synthetic schema\r\n');
  fs.writeFileSync(path.join(folder, 'server/prisma/migrations/001/migration.sql'), '-- synthetic migration\r\n');
  fs.writeFileSync(path.join(folder, 'server/prisma/migrations/migration_lock.toml'), 'provider = \"sqlite\"\r\n');
  }
  const manifest = {
    format: 1,
    platform: process.platform,
    arch: process.arch,
    id,
    sourceCommit: 'a'.repeat(40),
    sourceHash: 'b'.repeat(64),
    schemaCompatibility: 'current',
    ...fingerprint(folder),
  };
  fs.writeFileSync(path.join(folder, 'release.json'), JSON.stringify(manifest));
  return folder;
}
function proof(folder) {
  return {
    sourceCommit: JSON.parse(fs.readFileSync(path.join(folder, 'release.json')))
      .sourceCommit,
    manifestSha256: fileHash(path.join(folder, 'release.json')),
  };
}
function fixture(run, schema = false) {
  const base = fs.mkdtempSync(
      path.join(os.tmpdir(), 'wewe-install-lifecycle-'),
    ),
    root = path.join(base, 'installed'),
    sources = path.join(base, 'sources');
  fs.mkdirSync(root);
  fs.mkdirSync(sources);
  const current = pkg(root, 'current', schema),
    candidate = pkg(sources, 'candidate', schema),
    rollback = pkg(sources, 'rollback', schema);
  fs.writeFileSync(
    path.join(root, 'active.json'),
    JSON.stringify({ format: 1, id: 'current' }),
  );
  const plan = {
    current: 'current',
    candidate,
    rollback,
    proofs: {
      current: proof(current),
      candidate: proof(candidate),
      rollback: proof(rollback),
    },
  };
  // Unit seam for the local-role layer. The real CLI below uses release-scope;
  // its cross-root/inventory/reference cases are in release-scope.test.cjs.
  const options = {
    adoptLegacy: [],
    scope: {
      check() {},
      registerOutput() {},
      createdOutput() {},
      allowCleanup() {},
      close() {},
    },
  };
  const before = fingerprint(current);
  try {
    return run({
      base,
      root,
      sources,
      current,
      candidate,
      rollback,
      plan,
      options,
    });
  } finally {
    assert.deepEqual(fingerprint(current), before);
    assert(path.basename(base).startsWith('wewe-install-lifecycle-'));
    fs.rmSync(base, { recursive: true });
  }
}
function call(f, options = f.options) {
  return installPair(f.root, f.plan, options);
}
for (const eol of [false, true]) test('preserving install uses the real scope and copies new roles while keeping current and active unchanged CRLF=' + eol, () =>
  fixture((f) => {
    if (eol) for (const [name, folder] of [['candidate', f.candidate], ['rollback', f.rollback]]) {
      const file = path.join(folder, 'release.json'), manifest = JSON.parse(fs.readFileSync(file));
      for (const relative of Object.keys(manifest.files).filter((name) => name.startsWith('server/prisma/'))) {
        const target = path.join(folder, relative);
        fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n'));
        manifest.files[relative] = fileHash(target);
      }
      fs.writeFileSync(file, JSON.stringify(manifest)); f.plan.proofs[name] = proof(folder);
    }
    const scope = require('./release-scope.cjs'), crypto = require('node:crypto');
    const roots = [f.root, f.sources].map((p) => fs.realpathSync.native(p));
    const current = fs.realpathSync.native(f.current), candidate = fs.realpathSync.native(f.candidate), rollback = fs.realpathSync.native(f.rollback);
    const pointer = path.join(roots[0], 'active.json'), pointerHash = fileHash(pointer);
    const policy = { format: 1, scopeId: crypto.randomUUID(), ...scope.inspect(roots), registryDirectory: fs.realpathSync.native(f.base), registryIdentity: scope.inspect([f.base]).roots[0].identity,
      maxBytes: scope.DEFAULT_BYTES, maxGrowthBytes: 1024 * 1024, maxNewRuntimeCopies: 2, protectedIds: ['current', 'candidate', 'rollback'], compatibilityProofSha256: 'd'.repeat(64),
      packageProofs: Object.fromEntries([current, candidate, rollback].map((p) => [path.basename(p), fileHash(path.join(p, 'release.json'))])) };
    policy.preservingUpdate = { format: 1, operation: 'install', effects: ['new-output-only'], active: { pointer, pointerSha256: pointerHash, currentId: 'current', candidateId: 'candidate', currentManifestSha256: policy.packageProofs.current, candidateManifestSha256: policy.packageProofs.candidate, oldProcess: { pid: 7, startUtc: '2026-01-01T00:00:00Z', executableSha256: 'c'.repeat(64) } } };
    const config = path.join(f.base, 'policy.json'); fs.writeFileSync(config, JSON.stringify(policy));
    const facts = { complete: false, observationComplete: true, categories: { processes: true, tasks: true, shortcuts: 'not_applicable', pointers: true, rollback: true, inflight: true }, errors: [], uncertainChildren: [], compatibility: { verified: true, businessDatabaseRestored: false, proofSha256: 'd'.repeat(64) }, records: [
      { kind: 'processes', packageId: 'current', packagePath: current, identity: 'synthetic-process', ...policy.preservingUpdate.active.oldProcess },
      { kind: 'pointers', packageId: 'current', packagePath: current, identity: 'synthetic-pointer', pointerPath: pointer },
    ] };
    const lease = scope.open({ kind: 'install', root: roots[0], reserveBytes: 1024 * 1024, runtimeCopies: 2 }, { configPath: config, configSha256: fileHash(config), query: () => structuredClone(facts) });
    const result = call(f, { ...f.options, scope: lease });
    assert.deepEqual(result.installedIds.sort(), ['candidate', 'rollback']);
    for (const role of ['candidate', 'rollback']) assert.equal(result.schemaProofs[role].comparison, eol ? 'crlf-to-lf-only' : 'raw-sha256');
    assert.equal(fileHash(pointer), pointerHash);
    assert(fs.existsSync(path.join(f.root, 'candidate/release.json')));
  }, true));
function patch(object, key, value, run) {
  const saved = object[key];
  object[key] = value;
  try {
    return run(saved);
  } finally {
    object[key] = saved;
  }
}
function state(root) {
  return JSON.parse(fs.readFileSync(path.join(root, '.release-lifecycle.json')))
    .payload;
}
function candidate(f, name) {
  f.plan.candidate = pkg(f.sources, name);
  f.plan.proofs.candidate = proof(f.plan.candidate);
}

test('28 historical runtimes are held while only three verified installed roles consume managed quota', () =>
  fixture((f) => {
    const legacy = [];
    for (let i = 0; i < 27; i++) {
      const name = 'old-' + i;
      pkg(f.root, name);
      legacy.push(name);
    }
    legacy.sort();
    f.options.adoptLegacy = legacy;
    const worktree = path.join(
      f.root,
      'worktrees',
      'source',
      '.local-releases',
      'historical',
    );
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, 'not-installed'), Buffer.alloc(4096));
    const before = legacy.map((name) =>
      fileHash(path.join(f.root, name, 'runtime/node.exe')),
    );
    const result = call(f);
    assert.equal(result.managedIds.length, 3);
    assert.equal(result.installedIds.length, 2);
    assert.equal(result.legacyHeldIds.length, 27);
    assert.equal(result.historicalDeletionPerformed, false);
    let expected = 0;
    for (const id of result.managedIds)
      for (const file of ['app.cjs', 'release.json', 'runtime/node.exe'])
        expected += fs.statSync(path.join(f.root, id, file)).size;
    assert.equal(result.managedBytes, expected);
    assert(result.managedBytes < 4096);
    assert.deepEqual(
      legacy.map((name) =>
        fileHash(path.join(f.root, name, 'runtime/node.exe')),
      ),
      before,
    );
    assert(fs.existsSync(path.join(worktree, 'not-installed')));
    assert.equal(state(f.root).maxPackages, 3);
    assert.equal(state(f.root).maxBytes, DEFAULTS.bytes);
  }));
test('repeated exact installation reuses all roles without copying another runtime', () =>
  fixture((f) => {
    call(f);
    patch(
      fs,
      'cpSync',
      () => {
        throw new Error('unexpected copy');
      },
      () => {
        for (let i = 0; i < 4; i++) {
          const r = call(f);
          assert.deepEqual(r.installedIds, []);
          assert.equal(r.reusedIds.length, 3);
        }
      },
    );
    assert.equal(
      fs
        .readdirSync(f.root)
        .filter((n) => fs.existsSync(path.join(f.root, n, 'runtime/node.exe')))
        .length,
      3,
    );
  }));
test('existing packages require exact one-time adoption and old managed outputs cannot be grandfathered', () =>
  fixture((f) => {
    pkg(f.root, 'historical');
    assert.throws(() => call(f), /EXACT_INVENTORY/);
    assert(!fs.existsSync(path.join(f.root, 'candidate')));
    f.options.adoptLegacy = ['historical'];
    call(f);
    candidate(f, 'next');
    assert.throws(() => call(f), /RETIREMENT_APPROVAL_REQUIRED/);
    assert.throws(
      () => call(f, { adoptLegacy: ['historical', 'candidate'] }),
      /BASELINE_IMMUTABLE/,
    );
    assert(!fs.existsSync(path.join(f.root, 'next')));
    assert(fs.existsSync(path.join(f.root, 'candidate/runtime/node.exe')));
  }));
test('a separately approved retirement of only a synthetic obsolete package enables the next bounded round', () =>
  fixture((f) => {
    call(f);
    candidate(f, 'next');
    assert.throws(() => call(f), /RETIREMENT_APPROVAL_REQUIRED/);
    // Fixture-only simulation of an operator's separate, exact approved retirement.
    const obsolete = path.resolve(f.root, 'candidate');
    assert.equal(path.dirname(obsolete), f.root);
    fs.rmSync(obsolete, { recursive: true });
    const result = call(f);
    assert.equal(result.managedIds.length, 3);
    assert.deepEqual(result.installedIds, ['next']);
    assert.deepEqual(state(f.root).legacyIds, []);
  }));
test('a new unknown historical runtime is refused instead of expanding the frozen baseline', () =>
  fixture((f) => {
    call(f);
    pkg(f.root, 'unexpected');
    assert.throws(() => call(f), /UNKNOWN_OUTPUT/);
    assert(fs.existsSync(path.join(f.root, 'unexpected/runtime/node.exe')));
    assert.deepEqual(state(f.root).legacyIds, []);
  }));
test('legacy packages cannot be promoted implicitly into a running or recovery role', () =>
  fixture((f) => {
    const old = pkg(f.root, 'historical');
    f.options.adoptLegacy = ['historical'];
    call(f);
    f.plan.candidate = old;
    f.plan.proofs.candidate = proof(old);
    assert.throws(() => call(f), /LEGACY_PROMOTION/);
  }));
test('the three-role cumulative byte cap refuses before copying and can only be tightened', () =>
  fixture((f) => {
    patch(
      fs,
      'cpSync',
      () => {
        throw new Error('must reject before copying');
      },
      () =>
        assert.throws(
          () => call(f, { adoptLegacy: [], maxBytes: 1 }),
          /MANAGED_BYTES/,
        ),
    );
    assert.throws(
      () => call(f, { adoptLegacy: [], maxBytes: DEFAULTS.bytes + 1 }),
      /Invalid/,
    );
    assert.throws(() => call(f, { adoptLegacy: [], minFree: 1 }), /Invalid/);
    assert(!fs.existsSync(path.join(f.root, '.release-lifecycle.json')));
  }));
test('actual physical free space includes history and worktrees even though they are not managed roles', () =>
  fixture((f) => {
    const saved = fs.statfsSync;
    patch(
      fs,
      'statfsSync',
      (...args) => ({ ...saved(...args), bavail: 0n }),
      () => assert.throws(() => call(f), /PHYSICAL_RESERVE/),
    );
    assert(!fs.existsSync(path.join(f.root, 'candidate')));
  }));
test('post-copy physical-budget refusal cleans only new owned outputs and leaves intent for a safe retry', () =>
  fixture((f) => {
    const saved = fs.statfsSync;
    let n = 0;
    patch(
      fs,
      'statfsSync',
      (...args) => {
        const value = saved(...args);
        return ++n === 1 ? value : { ...value, bavail: 0n };
      },
      () => assert.throws(() => call(f), /FINAL_BUDGET/),
    );
    assert(!fs.existsSync(path.join(f.root, 'candidate')));
    assert(!fs.existsSync(path.join(f.root, 'rollback')));
    assert.equal(state(f.root).managedIds.length, 3);
    assert.equal(call(f).installedIds.length, 2);
  }));
test('a copy fault cleans the entire fresh owned batch but preserves current, history and sources', () =>
  fixture((f) => {
    const old = pkg(f.root, 'historical');
    f.options.adoptLegacy = ['historical'];
    const oldHash = fileHash(path.join(old, 'release.json')),
      saved = fs.cpSync;
    let n = 0;
    patch(
      fs,
      'cpSync',
      (...args) => {
        if (++n === 2) throw new Error('injected second copy');
        return saved(...args);
      },
      () => assert.throws(() => call(f), /injected second copy/),
    );
    assert(!fs.existsSync(path.join(f.root, 'rollback')));
    assert(!fs.existsSync(path.join(f.root, 'candidate')));
    assert.equal(fileHash(path.join(old, 'release.json')), oldHash);
    assert(fs.existsSync(f.candidate));
    assert(!fs.existsSync(path.join(f.root, '.build-budget.lock')));
    assert.equal(call(f).installedIds.length, 2);
  }));
test('any changed owned directory identity preserves the entire failed batch for review', () =>
  fixture((f) => {
    const saved = fs.cpSync;
    let n = 0;
    patch(
      fs,
      'cpSync',
      (...args) => {
        if (++n === 2) {
          const first = path.join(f.root, 'rollback');
          fs.renameSync(first, path.join(f.root, 'displaced'));
          fs.mkdirSync(first);
          throw new Error('injected replacement');
        }
        return saved(...args);
      },
      () => assert.throws(() => call(f), /FAILED_OUTPUT_CHANGED_PRESERVE/),
    );
    assert(fs.existsSync(path.join(f.root, 'rollback')));
    assert(fs.existsSync(path.join(f.root, 'candidate')));
    assert(fs.existsSync(path.join(f.root, 'displaced/runtime/node.exe')));
  }));
test('a concurrent active-pointer change preserves copied output and stops admission', () =>
  fixture((f) => {
    const saved = fs.cpSync;
    patch(
      fs,
      'cpSync',
      (...args) => {
        const result = saved(...args);
        fs.writeFileSync(
          path.join(f.root, 'active.json'),
          JSON.stringify({ format: 1, id: 'other' }),
        );
        return result;
      },
      () => assert.throws(() => call(f), /CURRENT_CHANGED_PRESERVE_OUTPUT/),
    );
    assert(fs.existsSync(path.join(f.root, 'rollback')));
    assert(fs.existsSync(path.join(f.root, 'candidate')));
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(f.root, 'active.json'))).id,
      'other',
    );
  }));
test('frozen manifest/source proofs and the expected current pointer are mandatory', () =>
  fixture((f) => {
    f.plan.proofs.candidate.sourceCommit = 'c'.repeat(40);
    assert.throws(() => call(f), /FROZEN_PLAN/);
    f.plan.proofs.candidate = proof(f.candidate);
    f.plan.current = 'other';
    assert.throws(() => call(f), /CURRENT_CHANGED/);
    assert(!fs.existsSync(path.join(f.root, 'candidate')));
  }));
test('corrupt retained target is rejected without overwriting or deleting it', () =>
  fixture((f) => {
    call(f);
    fs.writeFileSync(path.join(f.root, 'candidate', 'unexpected'), 'foreign');
    assert.throws(() => call(f), /files/);
    assert.equal(
      fs.readFileSync(path.join(f.root, 'candidate', 'unexpected'), 'utf8'),
      'foreign',
    );
  }));
test('invalid or tampered lifecycle metadata fails closed before any new output', () =>
  fixture((f) => {
    call(f);
    fs.writeFileSync(path.join(f.root, '.release-lifecycle.json'), '{}');
    assert.throws(() => call(f), /STATE_INVALID/);
    assert.throws(() => call(f, { adoptLegacy: 'history' }), /EXACT_INVENTORY/);
  }));
test('existing or replaced root locks cannot be adopted or deleted by this invocation', () =>
  fixture((f) => {
    const lock = path.join(f.root, '.build-budget.lock');
    fs.writeFileSync(lock, 'foreign');
    assert.throws(() => call(f), /EEXIST/);
    assert.equal(fs.readFileSync(lock, 'utf8'), 'foreign');
    fs.unlinkSync(lock);
    const saved = fs.cpSync;
    patch(
      fs,
      'cpSync',
      (...args) => {
        const result = saved(...args);
        fs.writeFileSync(lock, 'replacement');
        return result;
      },
      () => assert.throws(() => call(f), /OWNER_CHANGED/),
    );
    assert.equal(fs.readFileSync(lock, 'utf8'), 'replacement');
    assert(fs.existsSync(path.join(f.root, 'rollback')));
  }));
test('internal package aliases are recreated once without copying their files again', () =>
  fixture((f) => {
    fs.symlinkSync(
      path.join(f.candidate, 'runtime'),
      path.join(f.candidate, 'alias'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const mfile = path.join(f.candidate, 'release.json'),
      manifest = JSON.parse(fs.readFileSync(mfile));
    Object.assign(manifest, fingerprint(f.candidate));
    fs.writeFileSync(mfile, JSON.stringify(manifest));
    f.plan.proofs.candidate = proof(f.candidate);
    call(f);
    assert.equal(
      fs.realpathSync(path.join(f.root, 'candidate', 'alias')),
      fs.realpathSync(path.join(f.root, 'candidate', 'runtime')),
    );
  }));
test('a source alias escaping its package fails before any copy', () =>
  fixture((f) => {
    fs.symlinkSync(
      f.current,
      path.join(f.candidate, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    assert.throws(() => call(f));
    assert(!fs.existsSync(path.join(f.root, 'candidate')));
  }));
test('the reviewed-plan CLI installs and then reuses exactly the same tiny fixture roles', () =>
  fixture((f) => {
    const file = path.join(f.base, 'reviewed-plan.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ root: f.root, plan: f.plan, adoptLegacy: [] }),
    );
    const { execFileSync } = require('node:child_process');
    const scope = require('./release-scope.cjs'),
      crypto = require('node:crypto');
    const facts = path.join(f.base, 'facts.json'),
      probe = path.join(f.base, 'probe.cjs'),
      policyFile = path.join(f.base, 'scope-policy.json');
    fs.writeFileSync(
      facts,
      JSON.stringify({
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
          proofSha256: 'd'.repeat(64),
        },
      }),
    );
    fs.writeFileSync(
      probe,
      'const fs=require("node:fs"),path=require("node:path");process.stdout.write(fs.readFileSync(path.join(__dirname,"facts.json")));',
    );
    fs.writeFileSync(
      policyFile,
      JSON.stringify({
        format: 1,
        scopeId: crypto.randomUUID(),
        registryDirectory: fs.realpathSync.native(f.base),
        registryIdentity: scope.inspect([f.base]).roots[0].identity,
        ...scope.inspect([f.root, f.sources]),
        maxBytes: scope.DEFAULT_BYTES,
        maxGrowthBytes: 1024 * 1024,
        maxNewRuntimeCopies: 2,
        protectedIds: ['current', 'candidate', 'rollback'],
        compatibilityProofSha256: 'd'.repeat(64),
        probe: { path: probe, sha256: fileHash(probe) },
      }),
    );
    const run = () =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [require.resolve('./install-lifecycle.cjs'), '--plan', file],
          {
            encoding: 'utf8',
            windowsHide: true,
            env: {
              ...process.env,
              WEWE_RELEASE_SCOPE_FILE: policyFile,
              WEWE_RELEASE_SCOPE_SHA256: fileHash(policyFile),
            },
          },
        ),
      );
    assert.equal(run().installedIds.length, 2);
    assert.deepEqual(run().installedIds, []);
  }));
test('an interrupted partial managed copy cannot become legacy on retry', () =>
  fixture((f) => {
    const saved = fs.cpSync;
    let n = 0;
    patch(
      fs,
      'cpSync',
      (...args) => {
        if (++n === 2) throw new Error('injected');
        return saved(...args);
      },
      () => assert.throws(() => call(f), /injected/),
    );
    fs.mkdirSync(path.join(f.root, 'candidate'));
    fs.writeFileSync(
      path.join(f.root, 'candidate', 'partial'),
      'owned intent, incomplete copy',
    );
    assert.throws(
      () => call(f, { adoptLegacy: ['candidate'] }),
      /BASELINE_IMMUTABLE/,
    );
    assert.throws(() => call(f));
    assert(fs.existsSync(path.join(f.root, 'candidate', 'partial')));
  }));
test('new unexplained output during copying stops success and preserves that unknown output', () =>
  fixture((f) => {
    const saved = fs.cpSync;
    let n = 0;
    patch(
      fs,
      'cpSync',
      (...args) => {
        const result = saved(...args);
        if (++n === 2) pkg(f.root, 'foreign-output');
        return result;
      },
      () => assert.throws(() => call(f), /UNKNOWN_OUTPUT/),
    );
    assert(fs.existsSync(path.join(f.root, 'foreign-output/runtime/node.exe')));
    assert(!fs.existsSync(path.join(f.root, 'candidate')));
    assert(!fs.existsSync(path.join(f.root, 'rollback')));
  }));
