const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  crypto = require('node:crypto');
const scope = require('./release-scope.cjs');
const { fileHash } = require('./lib.cjs');
function fixture(run) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-release-scope-')),
    installed = path.join(base, 'installed'),
    build = path.join(base, 'build'),
    current = path.join(installed, 'current');
  fs.mkdirSync(current, { recursive: true });
  fs.mkdirSync(build);
  fs.writeFileSync(path.join(current, 'node.exe'), 'inert synthetic runtime');
  let facts = {
    complete: true,
    categories: Object.fromEntries(
      [
        'processes',
        'tasks',
        'shortcuts',
        'pointers',
        'rollback',
        'inflight',
      ].map((kind) => [kind, true]),
    ),
    records: [
      {
        kind: 'processes',
        packageId: 'current',
        packagePath: current,
        identity: 'synthetic-pid-identity',
        pid: process.pid,
        startUtc: '2026-01-01T00:00:00Z',
        executableSha256: 'c'.repeat(64),
      },
    ],
    errors: [],
    uncertainChildren: [],
    compatibility: {
      verified: true,
      businessDatabaseRestored: false,
      proofSha256: 'd'.repeat(64),
    },
  };
  const inspection = scope.inspect([installed, build]);
  const policy = {
    format: 1,
    scopeId: crypto.randomUUID(),
    registryDirectory: fs.realpathSync.native(base),
    registryIdentity: scope.inspect([base]).roots[0].identity,
    ...inspection,
    maxBytes: scope.DEFAULT_BYTES,
    maxGrowthBytes: 1024 * 1024,
    maxNewRuntimeCopies: 2,
    protectedIds: ['current', 'rollback', 'candidate'],
    compatibilityProofSha256: 'd'.repeat(64),
  };
  const config = path.join(base, 'reviewed-policy.json');
  fs.writeFileSync(config, JSON.stringify(policy));
  const f = {
    base,
    installed,
    build,
    current,
    policy,
    config,
    get facts() {
      return facts;
    },
    set facts(value) {
      facts = value;
    },
    save() {
      fs.writeFileSync(config, JSON.stringify(policy));
    },
    options() {
      return {
        configPath: config,
        configSha256: fileHash(config),
        query: () => structuredClone(facts),
      };
    },
    open(reserve = 4096, root = build, kind = 'build') {
      return scope.open({ kind, root, reserveBytes: reserve }, this.options());
    },
  };
  function clean() {
    assert(path.basename(base).startsWith('wewe-release-scope-'));
    fs.rmSync(base, { recursive: true });
  }
  try {
    const result = run(f);
    if (result?.then) return result.finally(clean);
    clean();
    return result;
  } catch (error) {
    clean();
    throw error;
  }
}
function output(f, lease, name = 'candidate', bytes = 128) {
  const at = path.join(f.build, name);
  lease.registerOutput(at);
  fs.mkdirSync(at);
  lease.createdOutput(at);
  fs.writeFileSync(path.join(at, 'runtime'), Buffer.alloc(bytes));
  return at;
}
function patch(object, key, value, run) {
  const old = object[key];
  object[key] = value;
  try {
    return run();
  } finally {
    object[key] = old;
  }
}

test('L1: source and destination bytes share one scope; exact completed output is held on reuse', () =>
  fixture((f) => {
    const lease = f.open();
    const at = output(f, lease);
    lease.close();
    const next = f.open(0);
    const measured = next.check();
    assert.equal(measured.bytes, f.policy.baseline.bytes + 128);
    next.close();
    assert.equal(fs.readFileSync(path.join(at, 'runtime')).length, 128);
  }));
test('L2: a completed old output consumes total capacity until separately reviewed retirement', () =>
  fixture((f) => {
    f.policy.maxBytes = f.policy.baseline.bytes + 150;
    f.policy.maxGrowthBytes = 150;
    f.save();
    const lease = f.open(128);
    output(f, lease);
    lease.close();
    assert.throws(() => f.open(128), /COPY_PEAK/);
    assert(fs.existsSync(path.join(f.build, 'candidate/runtime')));
  }));
test('L3: intent before mkdir and a failed partial output remain a held claim on retry', () =>
  fixture((f) => {
    const lease = f.open();
    output(f, lease);
    assert.throws(
      () => lease.close(new Error('copy failed')),
      /FAILED_OUTPUT_HELD/,
    );
    assert.throws(() => f.open(), /INTERRUPTED_CLAIM/);
    assert(fs.existsSync(path.join(f.build, 'candidate/runtime')));
  }));
test('L3: confirmed inactive owned cleanup can finish without deleting any historical file', () =>
  fixture((f) => {
    const lease = f.open(),
      at = output(f, lease);
    lease.allowCleanup([at]);
    assert.equal(path.dirname(path.resolve(at)), f.build);
    fs.rmSync(at, { recursive: true });
    lease.close(new Error('confirmed synchronous failure'));
    const next = f.open();
    next.close();
    assert(fs.existsSync(path.join(f.current, 'node.exe')));
  }));
test('L4: build and install roots contend on the same persisted scope lock', () =>
  fixture((f) => {
    const build = f.open();
    assert.throws(() => f.open(128, f.installed, 'install'), /EEXIST/);
    const copied = path.join(f.base, 'copied-policy.json');
    fs.copyFileSync(f.config, copied);
    assert.throws(
      () =>
        scope.open(
          { kind: 'install', root: f.installed, reserveBytes: 128 },
          { ...f.options(), configPath: copied },
        ),
      /EEXIST/,
    );
    assert(!fs.existsSync(path.join(f.installed, 'candidate')));
    build.close();
  }));
test('L5: a junction/canonical path alias cannot obtain another reservation', () =>
  fixture((f) => {
    const alias = path.join(f.base, 'build-alias');
    fs.symlinkSync(
      f.build,
      alias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const lease = f.open();
    assert.throws(() => f.open(128, alias), /EEXIST/);
    lease.close();
  }));

test('L3/L11: killing only the owned inert fixture child leaves a durable hold', () =>
  fixture(async (f) => {
    const { spawn } = require('node:child_process'),
      { once } = require('node:events');
    const facts = path.join(f.base, 'facts.json'),
      probe = path.join(f.base, 'probe.cjs'),
      program = path.join(f.base, 'owned-child.cjs');
    fs.writeFileSync(facts, JSON.stringify(f.facts));
    fs.writeFileSync(
      probe,
      'process.stdout.write(require("node:fs").readFileSync(require("node:path").join(__dirname,"facts.json")));',
    );
    f.policy.probe = { path: probe, sha256: fileHash(probe) };
    f.save();
    fs.writeFileSync(
      program,
      `const fs=require('node:fs'),path=require('node:path'),scope=require(${JSON.stringify(require.resolve('./release-scope.cjs'))});const lease=scope.open({kind:'build',root:${JSON.stringify(f.build)},reserveBytes:4096});const at=path.join(${JSON.stringify(f.build)},'partial');lease.registerOutput(at);fs.mkdirSync(at);lease.createdOutput(at);fs.writeFileSync(path.join(at,'runtime'),'inert');process.send('persisted');setInterval(()=>{},1000);`,
    );
    const child = spawn(process.execPath, [program], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: {
        ...process.env,
        WEWE_RELEASE_SCOPE_FILE: f.config,
        WEWE_RELEASE_SCOPE_SHA256: fileHash(f.config),
      },
    });
    try {
      const message = await Promise.race([
        once(child, 'message'),
        once(child, 'exit').then(([code]) => {
          throw new Error('fixture exited ' + code);
        }),
      ]);
      assert.equal(message[0], 'persisted');
      const exited = once(child, 'exit');
      child.kill();
      await exited;
      assert.throws(() => f.open(), /EEXIST/);
      assert(fs.existsSync(path.join(f.build, 'partial/runtime')));
      assert(!fs.existsSync(path.join(f.build, 'candidate')));
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
    }
  }));
test('L5: link escape, overlapping aliases and hardlinked storage fail closed', () =>
  fixture((f) => {
    assert.throws(() => scope.inspect([f.installed, f.current]), /OVERLAPPING/);
    const alias = path.join(f.build, 'escape');
    fs.symlinkSync(
      f.base,
      alias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    assert.throws(() => f.open(), /LINK_ESCAPE/);
    fs.unlinkSync(alias);
    fs.linkSync(
      path.join(f.current, 'node.exe'),
      path.join(f.build, 'hardlink'),
    );
    assert.throws(() => f.open(), /HARDLINK/);
  }));
test('L6: choosing an unregistered root or moving history never earns capacity credit', () =>
  fixture((f) => {
    const outside = path.join(f.base, 'outside');
    fs.mkdirSync(outside);
    assert.throws(() => f.open(1, outside), /UNREGISTERED/);
    fs.renameSync(
      path.join(f.current, 'node.exe'),
      path.join(f.build, 'moved-runtime'),
    );
    assert.throws(() => f.open(), /BASELINE_MISMATCH/);
  }));
test('L7: new unclassified files, grown history and grown caches refuse before allocation', () => {
  for (const mode of ['new', 'grown', 'cache'])
    fixture((f) => {
      const lease = f.open();
      lease.close();
      if (mode === 'new')
        fs.writeFileSync(path.join(f.installed, 'unclassified'), 'unexpected');
      if (mode === 'grown')
        fs.appendFileSync(path.join(f.current, 'node.exe'), 'unexpected');
      if (mode === 'cache') {
        fs.mkdirSync(path.join(f.installed, '.verification-cache'));
        fs.writeFileSync(
          path.join(f.installed, '.verification-cache', 'new'),
          'unexpected',
        );
      }
      assert.throws(() => f.open(), /FROZEN_HISTORY_CHANGED/);
      assert(!fs.existsSync(path.join(f.build, 'candidate')));
    });
});
test('L7: same-size replacement is detected by identity and content, not byte totals alone', () =>
  fixture((f) => {
    const lease = f.open();
    lease.close();
    const file = path.join(f.current, 'node.exe'),
      size = fs.statSync(file).size;
    fs.unlinkSync(file);
    fs.writeFileSync(file, Buffer.alloc(size));
    assert.throws(() => f.open(), /FROZEN_HISTORY_CHANGED/);
  }));
test('L8: changed pointer, task, shortcut, rollback or in-flight reference blocks publication', () => {
  for (const kind of ['pointers', 'tasks', 'shortcuts', 'rollback', 'inflight'])
    fixture((f) => {
      const lease = f.open();
      f.facts.records.push({
        kind,
        packageId: 'current',
        packagePath: f.current,
        identity: 'changed-' + kind,
      });
      assert.throws(() => lease.check(), /REFERENCES_CHANGED/);
      assert.throws(() => lease.close(), /REFERENCES_CHANGED/);
    });
});
test('L9: reused PID, incomplete task/shortcut query and uncertain child exit all hold output', () => {
  for (const mode of ['pid', 'tasks', 'shortcuts', 'child'])
    fixture((f) => {
      const lease = f.open();
      const at = output(f, lease);
      if (mode === 'pid') f.facts.records[0].startUtc = 'different-start';
      if (mode === 'tasks' || mode === 'shortcuts')
        f.facts.categories[mode] = false;
      if (mode === 'child')
        f.facts.uncertainChildren.push('synthetic child exit unknown');
      assert.throws(() => lease.allowCleanup([at]));
      assert.throws(() => lease.close(new Error('failed')));
      assert(fs.existsSync(path.join(at, 'runtime')));
    });
});
test('L9: stable launcher references must resolve to a protected physical package', () =>
  fixture((f) => {
    f.facts.records.push({
      kind: 'shortcuts',
      packageId: 'fourth',
      packagePath: f.current,
      identity: 'stable-launcher-points-to-unregistered-fourth',
    });
    assert.throws(() => f.open(), /UNRESOLVED_REFERENCE/);
  }));
test('L10: combined copy peak, per-claim growth and actual physical reserve are separate checks', () => {
  fixture((f) => {
    f.policy.maxBytes = f.policy.baseline.bytes + 128;
    f.policy.maxGrowthBytes = 128;
    f.save();
    assert.throws(() => f.open(129), /COPY_PEAK/);
  });
  fixture((f) => {
    const lease = f.open(64);
    output(f, lease, 'candidate', 128);
    assert.throws(() => lease.check(), /RESERVATION_EXCEEDED/);
    assert.throws(() => lease.close(new Error('overflow')));
  });
  fixture((f) => {
    const original = fs.statfsSync;
    patch(
      fs,
      'statfsSync',
      (...args) => ({ ...original(...args), bavail: 0n }),
      () => assert.throws(() => f.open(), /PHYSICAL_RESERVE/),
    );
  });
});
test('L10: an over-default legacy ceiling requires an explicit pinned finite exception', () =>
  fixture((f) => {
    f.policy.maxBytes = scope.DEFAULT_BYTES + 1;
    f.save();
    assert.throws(() => f.open(), /EXCEPTION_NOT_APPROVED/);
    f.policy.exception = {
      approvalId: 'synthetic-review-only',
      baselineDigest: f.policy.baseline.digest,
      baselineBytes: f.policy.baseline.bytes,
      maxBytes: f.policy.maxBytes,
      maxGrowthBytes: f.policy.maxGrowthBytes,
    };
    f.save();
    const lease = f.open();
    lease.close();
  }));
test('L11: missing or corrupt adopted ledger never regenerates a clean baseline', () => {
  for (const mode of ['missing', 'corrupt'])
    fixture((f) => {
      const lease = f.open();
      lease.close();
      const ledger = path.join(f.base, f.policy.scopeId + '.state.json');
      if (mode === 'missing') fs.unlinkSync(ledger);
      else fs.writeFileSync(ledger, '{}');
      assert.throws(
        () => f.open(),
        mode === 'missing' ? /LEDGER_MISSING/ : /STATE_CORRUPT/,
      );
    });
});
test('L11: ledger replacement and changed owner preserve unknown claims and locks', () => {
  fixture((f) => {
    const lease = f.open(),
      ledger = path.join(f.base, f.policy.scopeId + '.state.json');
    fs.writeFileSync(ledger, '{}');
    assert.throws(() => lease.close(), /STATE_CORRUPT/);
  });
  fixture((f) => {
    const lease = f.open(),
      lock = path.join(f.base, f.policy.scopeId + '.lock');
    fs.writeFileSync(lock, 'foreign');
    assert.throws(() => lease.close(), /OWNER_CHANGED/);
    assert.equal(fs.readFileSync(lock, 'utf8'), 'foreign');
  });
});
test('L12: removing or replacing a held package does not itself authorize retirement or old DB restoration', () =>
  fixture((f) => {
    const lease = f.open(),
      at = output(f, lease);
    lease.close();
    fs.rmSync(at, { recursive: true });
    assert.throws(() => f.open(), /MANAGED_OUTPUT_CHANGED/);
    f.facts.compatibility.businessDatabaseRestored = true;
    assert.throws(() => f.open(), /COMPATIBILITY_UNPROVEN/);
  }));
test('a reviewed external reference probe is required by the actual production API', () =>
  fixture((f) => {
    assert.throws(
      () =>
        scope.open(
          { kind: 'install', root: f.installed, reserveBytes: 1 },
          { configPath: f.config, configSha256: fileHash(f.config) },
        ),
      /PROBE_UNAVAILABLE/,
    );
    assert.throws(
      () => scope.open({ kind: 'install', root: f.installed, reserveBytes: 1 }),
      /REVIEWED_POLICY_REQUIRED/,
    );
  }));
test('actual production controller and activation APIs stop before any action without a reviewed scope', () =>
  fixture(async (f) => {
    const oldFile = process.env.WEWE_RELEASE_SCOPE_FILE,
      oldSha = process.env.WEWE_RELEASE_SCOPE_SHA256;
    delete process.env.WEWE_RELEASE_SCOPE_FILE;
    delete process.env.WEWE_RELEASE_SCOPE_SHA256;
    try {
      await assert.rejects(
        require('./restart.cjs').controlledRestart({
          production: true,
          release: f.current,
        }),
        /REVIEWED_POLICY_REQUIRED/,
      );
      await assert.rejects(
        require('./switch.cjs').controlledSwitch({
          production: true,
          release: f.current,
        }),
        /REVIEWED_POLICY_REQUIRED/,
      );
      assert.throws(
        () => require('./logon-start.cjs').activateRunning(f.current),
        /REVIEWED_POLICY_REQUIRED/,
      );
      assert.equal(fs.readdirSync(f.build).length, 0);
    } finally {
      if (oldFile !== undefined) process.env.WEWE_RELEASE_SCOPE_FILE = oldFile;
      if (oldSha !== undefined) process.env.WEWE_RELEASE_SCOPE_SHA256 = oldSha;
    }
  }));
test('global runtime-copy allowance includes transient duplicates across roots', () =>
  fixture((f) => {
    f.policy.maxNewRuntimeCopies = 1;
    f.save();
    assert.throws(
      () =>
        scope.open(
          {
            kind: 'install',
            root: f.installed,
            reserveBytes: 4096,
            runtimeCopies: 2,
          },
          f.options(),
        ),
      /RUNTIME_COPY_PEAK/,
    );
    const lease = scope.open(
        { kind: 'build', root: f.build, reserveBytes: 4096, runtimeCopies: 1 },
        f.options(),
      ),
      at = output(f, lease);
    fs.writeFileSync(path.join(at, 'node.exe'), 'inert duplicate');
    lease.close();
    assert.throws(
      () =>
        scope.open(
          {
            kind: 'install',
            root: f.installed,
            reserveBytes: 4096,
            runtimeCopies: 1,
          },
          f.options(),
        ),
      /RUNTIME_COPY_PEAK/,
    );
  }));
test('even a planned switch cannot silently change a shortcut or rollback reference', () =>
  fixture((f) => {
    const lease = f.open();
    f.facts.records.push({
      kind: 'shortcuts',
      packageId: 'current',
      packagePath: f.current,
      identity: 'different-stable-launcher',
    });
    assert.throws(() => lease.check(true), /REFERENCES_CHANGED/);
    assert.throws(
      () => lease.close(undefined, { transition: true }),
      /REFERENCES_CHANGED/,
    );
  }));
test('the async scope remains exclusive across a controller await boundary', () =>
  fixture(async (f) => {
    await scope.within(
      { kind: 'switch', root: f.installed, reserveBytes: 0 },
      async () => {
        assert(scope.requireSession());
        await Promise.resolve();
        assert.throws(() => f.open(1), /EEXIST/);
        scope.requireSession().check();
      },
      f.options(),
    );
    assert.equal(scope.session(), undefined);
    const lease = f.open();
    lease.close();
  }));
