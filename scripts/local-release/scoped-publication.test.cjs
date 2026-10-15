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

test('observation reads and sync/async verification never create or repair a global receipt', async () => {
  for (const corrupt of [false, true])
    await fixture(async (f) => {
      const lib = require('./lib.cjs'),
        cache = path.join(f.releases, '.verification-cache');
      const read = async () => {
        assert.equal(
          f.active.readActiveRelease({ reuseVerified: true }).manifest.id,
          'current',
        );
        assert.equal(
          lib.verifyRelease(f.current, { reuseVerified: true }).id,
          'current',
        );
        assert.equal(
          (await lib.verifyReleaseAsync(f.current, { reuseVerified: true })).id,
          'current',
        );
      };
      if (!corrupt) {
        await scope.within(
          { kind: 'reference-inspection', root: f.releases, reserveBytes: 0 },
          read,
          f.options,
        );
        assert(!fs.existsSync(cache));
        return;
      }
      fs.mkdirSync(cache);
      const broken = path.join(cache, 'broken.json');
      fs.writeFileSync(broken, 'broken-receipt-retained');
      const policy = JSON.parse(fs.readFileSync(f.options.configPath));
      Object.assign(policy, scope.inspect(policy.roots.map((r) => r.path)));
      fs.writeFileSync(f.options.configPath, JSON.stringify(policy));
      f.options.configSha256 = fileHash(f.options.configPath);
      const before = scope.inspect([f.releases]);
      await scope.within(
        { kind: 'reference-inspection', root: f.releases, reserveBytes: 0 },
        read,
        f.options,
      );
      assert.deepEqual(fs.readdirSync(cache), ['broken.json']);
      assert.equal(fs.readFileSync(broken, 'utf8'), 'broken-receipt-retained');
      assert.equal(
        scope.inspect([f.releases]).baseline.metadataDigest,
        before.baseline.metadataDigest,
      );
    });
});

test('compact running-release observation performs a full audit without a hidden receipt write', () =>
  fixture((f) => {
    const manifestFile = path.join(f.current, 'release.json'),
      manifest = JSON.parse(fs.readFileSync(manifestFile));
    manifest.executionLayout = 'compact-cjs-v1';
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    const policy = JSON.parse(fs.readFileSync(f.options.configPath));
    policy.packageProofs.current = fileHash(manifestFile);
    Object.assign(policy, scope.inspect(policy.roots.map((r) => r.path)));
    fs.writeFileSync(f.options.configPath, JSON.stringify(policy));
    f.options.configSha256 = fileHash(f.options.configPath);
    scope.within(
      { kind: 'reference-inspection', root: f.releases, reserveBytes: 0 },
      () => {
        assert.equal(
          require('./lib.cjs').verifyRunningRelease(f.current).id,
          'current',
        );
        assert.equal(
          f.active.readActiveRelease({ runningOnly: true }).manifest.id,
          'current',
        );
      },
      f.options,
    );
    assert(!fs.existsSync(path.join(f.releases, '.verification-cache')));
  }));

test('desktop installation refuses a release scope before even a stubbed native writer is reached', () =>
  fixture((f) => {
    const lib = require('./lib.cjs'),
      saved = lib.run;
    const modulePath = require.resolve('./install-desktop.cjs'),
      cached = require.cache[modulePath];
    let calls = 0;
    lib.run = () => {
      calls++;
      return '{"verified":true}';
    };
    delete require.cache[modulePath];
    try {
      const { installDesktop } = require('./install-desktop.cjs');
      scope.within(
        { kind: 'reference-inspection', root: f.releases, reserveBytes: 0 },
        () => {
          assert.throws(
            () =>
              installDesktop({
                root: path.dirname(f.releases),
                testDesktop: f.audits,
              }),
            /UNREGISTERED_HOST_EFFECT/,
          );
        },
        f.options,
      );
      assert.equal(calls, 0);
    } finally {
      lib.run = saved;
      if (cached) require.cache[modulePath] = cached;
      else delete require.cache[modulePath];
    }
  }));

test('one common file/process gateway rejects implicit output across sync, callback, promise and handle APIs', () =>
  fixture(async (f) => {
    const effects = require('./lib.cjs').hostEffects,
      target = path.join(f.audits, 'forbidden');
    await scope.within(
      { kind: 'reference-inspection', root: f.releases, reserveBytes: 0 },
      async () => {
        for (const name of [
          'mkdirSync',
          'mkdtempSync',
          'writeFileSync',
          'appendFileSync',
          'renameSync',
          'copyFileSync',
          'cpSync',
          'linkSync',
          'symlinkSync',
          'unlinkSync',
          'rmSync',
          'truncateSync',
          'chmodSync',
          'utimesSync',
          'createWriteStream',
          'writeSync',
          'writevSync',
          'mkdir',
          'writeFile',
          'appendFile',
          'rename',
          'copyFile',
          'cp',
          'unlink',
        ]) {
          assert.throws(
            () => effects.fs[name](target),
            /WRITE_OPERATION_NOT_AUTHORIZED/,
            name,
          );
        }
        for (const flags of [
          'w',
          'a',
          'r+',
          fs.constants.O_RDWR,
          fs.constants.O_CREAT | fs.constants.O_WRONLY,
        ]) {
          assert.throws(
            () => effects.fs.openSync(target, flags),
            /WRITE_OPERATION_NOT_AUTHORIZED/,
          );
          assert.throws(
            () => effects.fs.promises.open(target, flags),
            /WRITE_OPERATION_NOT_AUTHORIZED/,
          );
        }
        for (const name of [
          'mkdir',
          'mkdtemp',
          'writeFile',
          'appendFile',
          'rename',
          'copyFile',
          'cp',
          'link',
          'symlink',
          'unlink',
          'rm',
          'truncate',
          'chmod',
          'utimes',
        ])
          assert.throws(
            () => effects.fs.promises[name](target),
            /WRITE_OPERATION_NOT_AUTHORIZED/,
            name,
          );
        const handle = await effects.fs.promises.open(
          path.join(f.current, 'runtime.cjs'),
          'r',
        );
        try {
          const bytes = Buffer.alloc(5);
          await handle.read(bytes);
          assert.equal(bytes.toString(), 'inert');
          for (const name of [
            'write',
            'writev',
            'writeFile',
            'appendFile',
            'truncate',
            'chmod',
            'utimes',
            'sync',
            'datasync',
            'createWriteStream',
          ])
            assert.throws(
              () => handle[name](),
              /WRITE_OPERATION_NOT_AUTHORIZED/,
              name,
            );
        } finally {
          await handle.close();
        }
        for (const name of [
          'exec',
          'execFile',
          'execFileSync',
          'execSync',
          'fork',
          'spawn',
          'spawnSync',
        ])
          assert.throws(
            () => effects.processes[name]('never-executed'),
            /WRITE_OPERATION_NOT_AUTHORIZED/,
            name,
          );
        assert.throws(
          () =>
            require('node:util').promisify(effects.processes.execFile)(
              'never-executed',
            ),
          /WRITE_OPERATION_NOT_AUTHORIZED/,
        );
        assert.throws(
          () => require('./lib.cjs').writeJson(target, {}),
          /WRITE_OPERATION_NOT_AUTHORIZED/,
        );
      },
      f.options,
    );
    assert.deepEqual(fs.readdirSync(f.audits), []);
  }));

test('the process gateway preserves custom promisify results and dynamically respects existing preload hooks', () =>
  fixture(async (f) => {
    const native = require('node:child_process'),
      effects = require('./lib.cjs').hostEffects;
    const oldSync = native.execFileSync,
      oldAsync = native.execFile;
    const { promisify } = require('node:util');
    let calls = 0;
    try {
      native.execFileSync = () => {
        calls++;
        return 'hooked';
      };
      const stub = () => assert.fail('custom promisify required');
      stub[promisify.custom] = async () => {
        calls++;
        return { stdout: 'out', stderr: 'err' };
      };
      native.execFile = stub;
      assert.equal(require('./lib.cjs').run('stubbed', []), 'hooked');
      assert.deepEqual(await promisify(effects.processes.execFile)('stubbed'), {
        stdout: 'out',
        stderr: 'err',
      });
      await scope.within(
        { kind: 'reference-inspection', root: f.releases, reserveBytes: 0 },
        async () => {
          assert.throws(
            () => require('./lib.cjs').run('stubbed', []),
            /WRITE_OPERATION_NOT_AUTHORIZED/,
          );
          assert.throws(
            () => promisify(effects.processes.execFile)('stubbed'),
            /WRITE_OPERATION_NOT_AUTHORIZED/,
          );
        },
        f.options,
      );
      assert.equal(calls, 2);
    } finally {
      native.execFileSync = oldSync;
      native.execFile = oldAsync;
    }
  }));

test('indirect builders, dependency actions, workers, recovery and browser entries reject observation first', () =>
  fixture(async (f) => {
    await scope.within(
      { kind: 'reference-inspection', root: f.releases, reserveBytes: 0 },
      async () => {
        for (const call of [
          () => require('./build.cjs').copyPackages(),
          () => require('./compact.cjs').bundleServer(),
          () => require('./desktop-progress.cjs').writeProgress(),
          () => require('./desktop-start.cjs').openBrowser(),
          () =>
            require('./startup-audit.cjs').createStartupAudit(
              {},
              class {
                constructor() {
                  assert.fail('worker reached');
                }
              },
            ),
          () => require('./test-artifacts.cjs').begin({}),
          () => require('./test-artifacts.cjs').recover({}),
          () => require('./space-budget.cjs').lease(),
          () => require('./space-budget.cjs').replaceJson(),
          () => require('./switch.cjs').loadProductionEnvironment(),
        ])
          assert.throws(call, /WRITE_OPERATION_NOT_AUTHORIZED/);
        for (const call of [
          () => require('./build-legacy-web.cjs').buildLegacyWeb(),
          () =>
            require('./desktop-dependencies.cjs').ensureDependencies({
              engineReady() {
                assert.fail('adapter reached');
              },
            }),
          () => require('./desktop-dependencies.cjs').withLaunchLock(),
          () => require('./desktop-progress.cjs').showProgress(),
          () => require('./benchmark-launch.cjs').benchmark({}),
          () => require('./rehearse.cjs').rehearse(),
          () => require('./resume-legacy.cjs').main(),
          () => require('./runtime.cjs').runtime(),
          () => require('./startup-sqlite.cjs').prepareStart(),
          () =>
            require('./switch.cjs').stopOwned({
              exitCode: null,
              kill() {
                assert.fail('kill reached');
              },
            }),
        ])
          await assert.rejects(call(), /WRITE_OPERATION_NOT_AUTHORIZED/);
      },
      f.options,
    );
    assert.deepEqual(fs.readdirSync(f.audits), []);
  }));

test('copied library and controller modules retain the same observation capability', () =>
  fixture(async (f) => {
    for (const name of [
      'lib.cjs',
      'release-scope.cjs',
      'scope-inventory.cjs',
    ]) {
      const file = path.join(f.scripts, name);
      fs.copyFileSync(path.join(__dirname, name), file);
      delete require.cache[file];
    }
    const copyLib = require(path.join(f.scripts, 'lib.cjs'));
    const copyScope = require(path.join(f.scripts, 'release-scope.cjs'));
    await scope.within(
      { kind: 'reference-inspection', root: f.releases, reserveBytes: 0 },
      async () => {
        assert.equal(copyScope.session(), scope.session());
        assert.throws(
          () =>
            copyLib.hostEffects.fs.writeFileSync(
              path.join(f.audits, 'forbidden'),
              'no',
            ),
          /WRITE_OPERATION_NOT_AUTHORIZED/,
        );
        assert.throws(
          () =>
            copyScope.open(
              { kind: 'activate', root: f.releases, reserveBytes: 4096 },
              f.options,
            ),
          /NESTED_OPEN_FORBIDDEN/,
        );
        assert.throws(
          () =>
            copyScope.within(
              { kind: 'activate', root: f.releases, reserveBytes: 4096 },
              () => assert.fail('copied controller callback reached'),
              f.options,
            ),
          /NESTED_OPERATION_EXCEEDS_CLAIM/,
        );
        assert.equal(
          copyLib.verifyRelease(f.current, { reuseVerified: true }).id,
          'current',
        );
        assert.equal(
          (await copyLib.verifyReleaseAsync(f.current, { reuseVerified: true }))
            .id,
          'current',
        );
      },
      f.options,
    );
    assert(!fs.existsSync(path.join(f.releases, '.verification-cache')));
    assert.deepEqual(fs.readdirSync(f.audits), []);
  }));

test('a direct observation or zero-allocation lease cannot escape a context-bound callback', () =>
  fixture((f) => {
    for (const request of [
      { kind: 'reference-inspection', reserveBytes: 0 },
      { kind: 'unknown-inspection', reserveBytes: 4096 },
      { kind: 'activate', reserveBytes: 0 },
    ])
      assert.throws(
        () => scope.open({ ...request, root: f.releases }, f.options),
        /OBSERVATION_REQUIRES_WITHIN/,
      );
    assert(
      !fs
        .readdirSync(f.base)
        .some((name) => /\.(lock|state\.json|adopted)$/.test(name)),
    );
  }));

test('read APIs reject writable string/numeric flags before creating or truncating files', () =>
  fixture((f) => {
    const io = require('./lib.cjs').hostEffects.fs;
    const existing = path.join(f.current, 'runtime.cjs'),
      before = fs.readFileSync(existing);
    let callbackCalled = false;
    scope.within(
      { kind: 'reference-inspection', root: f.releases, reserveBytes: 0 },
      () => {
        for (const flag of [
          'w',
          'w+',
          'a',
          'r+',
          fs.constants.O_CREAT,
          fs.constants.O_TRUNC,
          fs.constants.O_RDWR,
          -1,
          0x40000000,
        ]) {
          for (const target of [
            path.join(f.audits, 'must-not-exist'),
            existing,
          ]) {
            for (const call of [
              () => io.readFileSync(target, { flag }),
              () => new io.readFileSync(target, { flag }),
              () =>
                io.readFile(target, { flag }, () => {
                  callbackCalled = true;
                }),
              () => io.promises.readFile(target, { flag }),
              () => io.createReadStream(target, { flags: flag }),
              () => new io.ReadStream(target, { flags: flag }),
            ])
              assert.throws(call, /WRITE_OPERATION_NOT_AUTHORIZED/);
            assert.deepEqual(fs.readFileSync(existing), before);
            assert(!fs.existsSync(path.join(f.audits, 'must-not-exist')));
          }
        }
      },
      f.options,
    );
    assert.equal(callbackCalled, false);
  }));

test('observation preserves ordinary string, default, descriptor and numeric read paths', () =>
  fixture(async (f) => {
    const io = require('./lib.cjs').hostEffects.fs,
      file = path.join(f.current, 'runtime.cjs');
    await scope.within(
      { kind: 'reference-inspection', root: f.releases, reserveBytes: 0 },
      async () => {
        assert.equal(io.readFileSync(file, 'utf8'), 'inert');
        assert.equal(io.promises.createReadStream, undefined);
        for (const flag of [
          undefined,
          'r',
          'rs',
          'sr',
          fs.constants.O_RDONLY,
        ]) {
          assert.equal(
            io.readFileSync(file, { encoding: 'utf8', flag }),
            'inert',
          );
          assert.equal(
            await io.promises.readFile(file, { encoding: 'utf8', flag }),
            'inert',
          );
          const callbackRead = await new Promise((resolve, reject) =>
            io.readFile(file, { encoding: 'utf8', flag }, (error, value) =>
              error ? reject(error) : resolve(value),
            ),
          );
          assert.equal(callbackRead, 'inert');
          for (const stream of [
            io.createReadStream(file, { flags: flag }),
            new io.ReadStream(file, { flags: flag }),
          ]) {
            let value = '';
            for await (const chunk of stream) value += chunk;
            assert.equal(value, 'inert');
          }
        }
        const fd = io.openSync(file, fs.constants.O_RDONLY);
        try {
          assert.equal(io.readFileSync(fd, 'utf8'), 'inert');
        } finally {
          io.closeSync(fd);
        }
      },
      f.options,
    );
    assert.deepEqual(fs.readdirSync(f.audits), []);
  }));
