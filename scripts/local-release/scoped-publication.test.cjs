const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  crypto = require('node:crypto');
const scope = require('./release-scope.cjs'),
  { fingerprint, fileHash } = require('./lib.cjs');
function fixture(
  run,
  { candidateId = 'candidate', pointerNewline = false } = {},
) {
  const base = fs.mkdtempSync(
      path.join(os.tmpdir(), 'wewe-scoped-publication-'),
    ),
    project = path.join(base, 'project'),
    scripts = path.join(project, 'scripts/local-release'),
    releases = path.join(project, '.local-releases'),
    audits = path.join(base, 'audits');
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(releases);
  fs.mkdirSync(audits);
  for (const name of [
    'active-release.cjs',
    'startup-acceptance.cjs',
    'restart.cjs',
    'switch.cjs',
  ])
    fs.copyFileSync(path.join(__dirname, name), path.join(scripts, name));
  for (const name of ['lib.cjs', 'release-scope.cjs'])
    fs.writeFileSync(
      path.join(scripts, name),
      'module.exports=require(' +
        JSON.stringify(require.resolve('./' + name)) +
        ');',
    );
  const proofs = {};
  for (const id of ['current', candidateId]) {
    const dir = path.join(releases, id);
    for (const name of [
      'runtime/node.exe',
      'runtime.cjs',
      'lib.cjs',
      'server/dist/main.js',
      'server/client/index.hbs',
    ]) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), 'inert');
    }
    fs.writeFileSync(
      path.join(dir, 'release.json'),
      JSON.stringify({
        format: 1,
        id,
        platform: process.platform,
        arch: process.arch,
        sourceCommit: 'a'.repeat(40),
        schemaCompatibility: 'current',
        desktopHelperIncluded: false,
        ...fingerprint(dir),
      }),
    );
    proofs[id] = fileHash(path.join(dir, 'release.json'));
  }
  fs.writeFileSync(
    path.join(releases, 'active.json'),
    JSON.stringify({ format: 1, id: 'current' }),
  );
  if (pointerNewline)
    fs.appendFileSync(path.join(releases, 'active.json'), '\n');
  const policy = {
      format: 1,
      scopeId: crypto.randomUUID(),
      registryDirectory: fs.realpathSync.native(base),
      registryIdentity: scope.inspect([base]).roots[0].identity,
      ...scope.inspect([releases, audits]),
      maxBytes: scope.DEFAULT_BYTES,
      maxGrowthBytes: 1024 * 1024,
      maxNewRuntimeCopies: 2,
      protectedIds: ['current', candidateId],
      packageProofs: proofs,
      compatibilityProofSha256: 'd'.repeat(64),
    },
    config = path.join(base, 'policy.json');
  fs.writeFileSync(config, JSON.stringify(policy));
  const options = {
    configPath: config,
    configSha256: fileHash(config),
    query: () => ({
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
  };
  const f = {
    base,
    scripts,
    releases,
    audits,
    current: path.join(releases, 'current'),
    candidate: path.join(releases, candidateId),
    active: require(path.join(scripts, 'active-release.cjs')),
    acceptance: require(path.join(scripts, 'startup-acceptance.cjs')),
    options,
  };
  try {
    const result = run(f);
    if (result?.then) return result.finally(() => clean(base));
    clean(base);
    return result;
  } catch (error) {
    clean(base);
    throw error;
  }
}
function clean(base) {
  assert(path.basename(base).startsWith('wewe-scoped-publication-'));
  fs.rmSync(base, { recursive: true });
}
test('scoped pointer publication fully verifies without growing a frozen verification-cache directory', () =>
  fixture(async (f) => {
    await scope.within(
      {
        kind: 'activate',
        root: f.releases,
        reserveBytes: 1024 * 1024,
        transition: true,
      },
      async () => {
        await f.active.writeActiveReleaseAsync(f.candidate);
      },
      f.options,
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(f.releases, 'active.json'))).id,
      'candidate',
    );
    assert(!fs.existsSync(path.join(f.releases, '.verification-cache')));
  }));
test('full RSS acceptance can be recorded only inside the reserved owned audit during publication', () =>
  fixture((f) => {
    scope.within(
      {
        kind: 'restart',
        root: f.releases,
        reserveBytes: 1024 * 1024,
        transition: true,
      },
      (lease) => {
        const audit = path.join(f.audits, 'owned');
        lease.registerOutput(audit);
        fs.mkdirSync(audit);
        lease.createdOutput(audit);
        f.acceptance.recordAcceptance(f.candidate, { receiptRoot: audit });
        assert(f.acceptance.accepted(f.candidate, { receiptRoot: audit }));
        assert(!fs.existsSync(path.join(f.releases, '.startup-acceptance')));
      },
      f.options,
    );
  }));
test('synchronous planned pointer publication honors the same transition contract as async publication', () =>
  fixture((f) => {
    const prior = f.options.query;
    f.options.query = () => {
      const facts = prior(),
        pointer = path.join(f.releases, 'active.json'),
        id = JSON.parse(fs.readFileSync(pointer)).id;
      facts.records = [
        {
          kind: 'pointers',
          packageId: id,
          packagePath: path.join(f.releases, id),
          pointerPath: pointer,
          identity: fileHash(pointer),
        },
      ];
      return facts;
    };
    scope.within(
      {
        kind: 'activate',
        root: f.releases,
        reserveBytes: 1024 * 1024,
        transition: true,
      },
      () => f.active.writeActiveRelease(f.candidate),
      f.options,
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(f.releases, 'active.json'))).id,
      'candidate',
    );
  }));
test('scoped acceptance refuses a global cache or an alias outside the owned audit', () =>
  fixture((f) => {
    scope.within(
      { kind: 'restart', root: f.releases, reserveBytes: 1024 * 1024 },
      (lease) => {
        assert.throws(
          () => f.acceptance.recordAcceptance(f.candidate),
          /ACCEPTANCE_AUDIT_REQUIRED/,
        );
        const audit = path.join(f.audits, 'owned'),
          outside = path.join(f.base, 'outside');
        lease.registerOutput(audit);
        fs.mkdirSync(audit);
        lease.createdOutput(audit);
        fs.mkdirSync(outside);
        const link = path.join(audit, '.startup-acceptance');
        fs.symlinkSync(
          outside,
          link,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
        assert.throws(
          () =>
            f.acceptance.recordAcceptance(f.candidate, { receiptRoot: audit }),
          /OWNED_AUDIT_REQUIRED/,
        );
        assert.deepEqual(fs.readdirSync(outside), []);
        fs.unlinkSync(link);
      },
      f.options,
    );
  }));
test('a missing native helper uses the existing read-only fallback without compiling into frozen history', () =>
  fixture((f) => {
    for (const name of ['identity-tool.cjs', 'process-identity.cs'])
      fs.copyFileSync(path.join(__dirname, name), path.join(f.scripts, name));
    const identity = require(path.join(f.scripts, 'identity-tool.cjs')),
      cacheRoot = path.join(f.releases, '.identity-tools');
    scope.within(
      { kind: 'restart', root: f.releases, reserveBytes: 1024 * 1024 },
      () => {
        assert.equal(identity.identityTool({ cacheRoot }), undefined);
        assert(!fs.existsSync(cacheRoot));
      },
      f.options,
    );
  }));
function recoveryProof(f) {
  const policy = JSON.parse(fs.readFileSync(f.options.configPath)),
    file = path.join(f.base, 'compatibility.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      format: 1,
      kind: 'additive-schema-unknown-claim-rollback',
      businessDatabaseRestored: false,
      candidate: {
        id: 'candidate',
        sourceCommit: 'a'.repeat(40),
        manifestSha256: policy.packageProofs.candidate,
      },
      rollback: {
        id: 'current',
        sourceCommit: 'a'.repeat(40),
        manifestSha256: policy.packageProofs.current,
      },
      checks: {
        additiveSchema: true,
        unknownClaimsPreserved: true,
        businessRowsPreserved: true,
        rollbackStarted: true,
      },
    }),
  );
  const sha = fileHash(file);
  policy.compatibilityProofSha256 = sha;
  policy.windowsReferences = {
    compatibilityProof: { path: file, sha256: sha },
  };
  fs.writeFileSync(f.options.configPath, JSON.stringify(policy));
  f.options.configSha256 = fileHash(f.options.configPath);
  const prior = f.options.query;
  f.options.query = () => {
    const facts = prior();
    facts.compatibility.proofSha256 = sha;
    return facts;
  };
  return file;
}
test('a zero-allocation observation context cannot authorize a recovery publication', () =>
  fixture((f) => {
    recoveryProof(f);
    scope.within(
      { kind: 'reference-inspection', root: f.releases, reserveBytes: 0 },
      (lease) => {
        assert.throws(
          () => lease.authorizeRecoveryPackage(f.current),
          /RECOVERY_OPERATION_REQUIRED/,
        );
      },
      f.options,
    );
  }));
test('an exhausted allocation fence still permits only the pinned compatible rollback pointer and releases no new capacity', () =>
  fixture((f) => {
    recoveryProof(f);
    assert.throws(
      () =>
        scope.within(
          {
            kind: 'restart',
            root: f.releases,
            reserveBytes: 4096,
            transition: true,
          },
          (lease) => {
            const audit = path.join(f.audits, 'owned');
            lease.registerOutput(audit);
            fs.mkdirSync(audit);
            lease.createdOutput(audit);
            f.active.writeActiveRelease(f.candidate);
            fs.writeFileSync(path.join(audit, 'overflow'), Buffer.alloc(8192));
            assert.throws(() => lease.check(true), /RESERVATION_EXCEEDED/);
            assert.throws(
              () => lease.registerOutput(path.join(f.audits, 'extra')),
              /RESERVATION_EXCEEDED/,
            );
            assert.throws(
              () =>
                f.active.writeActiveRelease(f.candidate, { recovery: true }),
              /RECOVERY_TARGET_UNPROVEN/,
            );
            f.active.writeActiveRelease(f.current, { recovery: true });
            assert.equal(
              JSON.parse(fs.readFileSync(path.join(f.releases, 'active.json')))
                .id,
              'current',
            );
            assert(!fs.existsSync(path.join(f.audits, 'extra')));
            throw new Error('original allocation failure');
          },
          f.options,
        ),
      /RESERVATION_EXCEEDED/,
    );
    assert(!fs.existsSync(path.join(f.releases, '.verification-cache')));
  }));
test('a changed rollback proof cannot authorize recovery even if a query fixture claims compatibility', () =>
  fixture((f) => {
    const file = recoveryProof(f);
    scope.within(
      { kind: 'restart', root: f.releases, reserveBytes: 4096 },
      (lease) => {
        fs.appendFileSync(file, ' ');
        assert.throws(
          () => lease.authorizeRecoveryPackage(f.current),
          /RECOVERY_PROOF_CHANGED/,
        );
      },
      f.options,
    );
  }));

test('P1: observation refuses sync and async ordinary publication before any pointer or cache write', () =>
  fixture(async (f) => {
    const pointer = path.join(f.releases, 'active.json'),
      before = fs.readFileSync(pointer),
      members = fs.readdirSync(f.releases);
    await scope.within(
      { kind: 'reference-inspection', root: f.releases, reserveBytes: 0 },
      async () => {
        assert.throws(
          () => f.active.writeActiveRelease(f.candidate),
          /WRITE_OPERATION_NOT_AUTHORIZED/,
        );
        await assert.rejects(
          f.active.writeActiveReleaseAsync(f.candidate),
          /WRITE_OPERATION_NOT_AUTHORIZED/,
        );
        assert.deepEqual(fs.readFileSync(pointer), before);
        assert.deepEqual(fs.readdirSync(f.releases), members);
      },
      f.options,
    );
    assert.deepEqual(fs.readFileSync(pointer), before);
    assert.deepEqual(fs.readdirSync(f.releases), members);
  }));

test('P1: nested activation cannot elevate observation kind, root, reservations, policy or transition', () =>
  fixture((f) => {
    const pointer = path.join(f.releases, 'active.json'),
      before = fs.readFileSync(pointer);
    scope.within(
      { kind: 'reference-inspection', root: f.releases, reserveBytes: 0 },
      () => {
        const observation = {
          kind: 'reference-inspection',
          root: f.releases,
          reserveBytes: 0,
        };
        for (const change of [
          { kind: 'activate', reserveBytes: 4096, transition: true },
          { reserveBytes: 1 },
          { runtimeCopies: 1 },
          { root: f.audits },
          { transition: true },
        ]) {
          let called = false;
          assert.throws(
            () =>
              scope.within(
                { ...observation, ...change },
                () => {
                  called = true;
                  f.active.writeActiveRelease(f.candidate);
                },
                f.options,
              ),
            /NESTED_OPERATION_EXCEEDS_CLAIM/,
          );
          assert.equal(called, false);
        }
        assert.throws(
          () =>
            scope.within(
              observation,
              () => assert.fail('wrong policy executed'),
              { ...f.options, configSha256: 'f'.repeat(64) },
            ),
          /NESTED_OPERATION_EXCEEDS_CLAIM/,
        );
        assert.throws(
          () =>
            scope.open(
              { kind: 'activate', root: f.releases, reserveBytes: 4096 },
              f.options,
            ),
          /NESTED_OPEN_FORBIDDEN/,
        );
        assert.equal(
          scope.within(observation, () => 'read-only'),
          'read-only',
        );
        assert.deepEqual(fs.readFileSync(pointer), before);
      },
      f.options,
    );
    assert.deepEqual(fs.readFileSync(pointer), before);
  }));

test('P1: equal-length current and nextone pointer substitution is refused despite zero net byte growth', () =>
  fixture(
    (f) => {
      const pointer = path.join(f.releases, 'active.json'),
        before = fs.readFileSync(pointer),
        replacement = Buffer.from(
          JSON.stringify({ format: 1, id: 'nextone' }) + '\n',
        );
      assert.equal(before.length, replacement.length);
      scope.within(
        {
          kind: 'reference-inspection',
          root: f.releases,
          reserveBytes: 0,
          transition: true,
        },
        () =>
          assert.throws(
            () => f.active.writeActiveRelease(f.candidate),
            /WRITE_OPERATION_NOT_AUTHORIZED/,
          ),
        f.options,
      );
      assert.deepEqual(fs.readFileSync(pointer), before);
      assert(
        !fs
          .readdirSync(f.releases)
          .some((name) => /^active-.*\.tmp$/.test(name)),
      );
    },
    { candidateId: 'nextone', pointerNewline: true },
  ));

test('observation cannot enter other host write or controller APIs before they touch files or processes', () =>
  fixture(async (f) => {
    const before = scope.inspect([f.releases, f.audits]);
    await scope.within(
      { kind: 'reference-inspection', root: f.releases, reserveBytes: 0 },
      async (lease) => {
        for (const call of [
          () => lease.registerOutput(path.join(f.audits, 'new')),
          () => lease.createdOutput(f.audits),
          () => lease.allowCleanup([]),
          () => lease.assertOwnedDirectory(f.audits),
          () =>
            f.acceptance.recordAcceptance(f.current, { receiptRoot: f.audits }),
          () => require('./build.cjs').build(),
          () => require('./build-budget.cjs').begin(f.releases, 4096),
          () => require('./install-lifecycle.cjs').installPair(f.releases, {}),
        ])
          assert.throws(call, /WRITE_OPERATION_NOT_AUTHORIZED/);
        await assert.rejects(
          require('./restart.cjs').controlledRestart({ startupReuse: true }),
          /WRITE_OPERATION_NOT_AUTHORIZED/,
        );
        await assert.rejects(
          require('./switch.cjs').controlledSwitch({ production: false }),
          /WRITE_OPERATION_NOT_AUTHORIZED/,
        );
        await assert.rejects(
          require('./logon-start.cjs').startAtLogon(),
          /WRITE_OPERATION_NOT_AUTHORIZED/,
        );
        assert.throws(
          () => require('./logon-start.cjs').activateRunning(f.candidate),
          /NESTED_OPERATION_EXCEEDS_CLAIM/,
        );
      },
      f.options,
    );
    const after = scope.inspect([f.releases, f.audits]);
    assert.equal(after.baseline.digest, before.baseline.digest);
    assert.equal(after.baseline.metadataDigest, before.baseline.metadataDigest);
  }));

test('ordinary publication requires a publisher claim and at least the atomic pointer reservation', () =>
  fixture((f) => {
    const pointer = path.join(f.releases, 'active.json'),
      before = fs.readFileSync(pointer);
    for (const request of [
      { kind: 'build', reserveBytes: 4096 },
      { kind: 'install', reserveBytes: 4096 },
      { kind: 'activate', reserveBytes: 0 },
      { kind: 'activate', reserveBytes: 4095 },
    ]) {
      scope.within(
        { ...request, root: f.releases },
        () => {
          assert.throws(
            () => f.active.writeActiveRelease(f.candidate),
            /WRITE_OPERATION_NOT_AUTHORIZED/,
          );
        },
        f.options,
      );
      assert.deepEqual(fs.readFileSync(pointer), before);
    }
  }));
