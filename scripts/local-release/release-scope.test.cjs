const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  crypto = require('node:crypto');
const scope = require('./release-scope.cjs');
const { fileHash } = require('./lib.cjs');
test('elapsed reference-query time cannot reset or exceed the shared operation deadline before allocation', () =>
  fixture((f) => {
    f.policy.scanBudget = { durationMs: 2000 };
    f.save();
    const options = f.options();
    let queries = 0;
    options.query = () => {
      queries++;
      const end = performance.now() + 2100;
      while (performance.now() < end) {}
      return structuredClone(f.facts);
    };
    assert.throws(
      () =>
        scope.open(
          { kind: 'install', root: f.installed, reserveBytes: 1 },
          options,
        ),
      /SCAN_TIME_BUDGET/,
    );
    assert.equal(queries, 1);
    assert(!fs.existsSync(path.join(f.installed, 'candidate')));
  }));
test('opt-in metadata checkpoints still hold a changed frozen file before another allocation', () =>
  fixture((f) => {
    f.policy.scanBudget = {
      profile: 'legacy-stream-v1',
      checkpointMode: 'identity-times-v1',
    };
    f.save();
    const lease = f.open();
    fs.appendFileSync(path.join(f.current, 'node.exe'), 'changed');
    assert.throws(
      () => lease.registerOutput(path.join(f.build, 'candidate')),
      /FROZEN_HISTORY_CHANGED/,
    );
    assert(!fs.existsSync(path.join(f.build, 'candidate')));
    assert.throws(
      () => lease.close(new Error('history changed')),
      /FROZEN_HISTORY_CHANGED/,
    );
  }));
test('default policy retains complete content hashing on every checkpoint', () =>
  fixture((f) => {
    const lease = f.open(),
      before = lease.inventoryMetrics().readBytes;
    lease.check();
    assert(lease.inventoryMetrics().readBytes > before);
    lease.close();
  }));
test('scope opens hash historical contents afresh, then checkpoint metadata without rereading historical bytes', () =>
  fixture((f) => {
    f.policy.scanBudget = {
      profile: 'legacy-stream-v1',
      checkpointMode: 'identity-times-v1',
    };
    f.save();
    const first = f.open(),
      read = first.inventoryMetrics().readBytes;
    assert(read > 0);
    first.check();
    first.check();
    assert.equal(first.inventoryMetrics().readBytes, read);
    first.close();
    const second = f.open();
    assert(second.inventoryMetrics().readBytes > 0);
    second.close();
  }));
test('old inventory format cannot be silently upgraded or adopted as a fresh baseline', () =>
  fixture((f) => {
    f.policy.baseline.format = 'old-in-memory-v1';
    f.save();
    assert.throws(() => f.open(), /INVENTORY_VERSION_REVIEW_REQUIRED/);
    assert(!fs.existsSync(path.join(f.base, f.policy.scopeId + '.state.json')));
  }));
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
    scope.within(
      { kind: 'reference-inspection', root: f.installed, reserveBytes: 0 },
      (next) => {
        const measured = next.check();
        assert.equal(measured.bytes, f.policy.baseline.bytes + 128);
      },
      f.options(),
    );
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
        assert.throws(() => f.open(1), /NESTED_OPEN_FORBIDDEN/);
        scope.requireSession().check();
      },
      f.options(),
    );
    assert.equal(scope.session(), undefined);
    const lease = f.open();
    lease.close();
  }));

function buildOnly(f) {
  f.policy.phase = 'build-only';
  Object.assign(f.policy, scope.inspect([f.build]));
  f.policy.protectedIds = [];
  delete f.policy.compatibilityProofSha256;
  f.policy.buildOnly = {
    sourceCommit: 'a'.repeat(40),
    sourceHash: 'b'.repeat(64),
    outputRoot: f.build,
    runtimeSha256: fileHash(process.execPath),
    commands: [],
  };
  f.facts.compatibility = { stage: 'build-only', verified: false };
  f.save();
  return {
    kind: 'build',
    root: f.build,
    reserveBytes: 4096,
    runtimeCopies: 1,
    buildOnly: true,
    sourceCommit: 'a'.repeat(40),
    sourceHash: 'b'.repeat(64),
  };
}
function ownedWrite(lease, file, bytes) {
  const effects = require('./lib.cjs').hostEffects;
  return effects.context.run(lease, () =>
    effects.fs.writeFileSync(file, bytes),
  );
}
test('build-only binds source and one new output root without querying global references; install remains blocked', () =>
  fixture((f) => {
    const request = buildOnly(f);
    for (const change of [
      { kind: 'install' },
      { sourceHash: 'c'.repeat(64) },
      { root: f.installed },
      { transition: true },
      { buildOnly: false },
    ])
      assert.throws(
        () => scope.open({ ...request, ...change }, f.options()),
        /BUILD_ONLY_BINDING/,
      );
    f.facts.complete = false;
    const options = f.options();
    options.query = () => {
      throw Error('must not query global processes or history');
    };
    const lease = scope.open(request, options);
    assert.throws(
      () => lease.authorizePackage(f.current),
      /BUILD_ONLY_NO_INSTALL/,
    );
    lease.close();
  }));
test('build-only creates owned artifacts but rejects database, private config, process and pointer effects', () =>
  fixture(async (f) => {
    const request = buildOnly(f),
      gateway = require('./lib.cjs').hostEffects;
    await scope.within(
      request,
      async (lease) => {
        const output = path.join(f.build, 'candidate');
        lease.registerOutput(output);
        gateway.fs.mkdirSync(output);
        lease.createdOutput(output);
        gateway.fs.writeFileSync(
          path.join(output, 'build.log'),
          'synthetic compiler output',
        );
        const fd = gateway.fs.openSync(path.join(output, 'second.log'), 'wx');
        gateway.fs.writeSync(fd, 'owned');
        gateway.fs.closeSync(fd);
        assert.throws(
          () => gateway.fs.writeSync(fd, 'late'),
          /DESCRIPTOR_FORBIDDEN/,
        );
        assert.throws(
          () =>
            gateway.fs.writeFileSync(
              path.join(f.current, 'changed'),
              'forbidden',
            ),
          /WRITE_OUTSIDE_OUTPUT/,
        );
        assert.throws(
          () => gateway.fs.readFileSync(path.join(f.base, 'production.db')),
          /PRIVATE_INPUT/,
        );
        assert.throws(
          () =>
            gateway.fs.writeFileSync(path.join(output, 'active.json'), '{}'),
          /PRIVATE_INPUT/,
        );
        assert.throws(
          () =>
            require('./startup-sqlite.cjs').inspectDatabase(
              path.join(f.base, 'production.db'),
              '',
            ),
          /RUNTIME_FORBIDDEN/,
        );
        assert.throws(
          () => require('./switch.cjs').loadProductionEnvironment(),
          /RUNTIME_FORBIDDEN/,
        );
        await assert.rejects(
          require('./runtime.cjs').runtime(),
          /RUNTIME_FORBIDDEN/,
        );
        await assert.rejects(
          require('./restart.cjs').controlledRestart({ production: true }),
          /NOT_AUTHORIZED/,
        );
        assert.throws(
          () =>
            gateway.processes.execFileSync(process.execPath, [
              '-e',
              'process.exit(0)',
            ]),
          /COMMAND_FORBIDDEN/,
        );
        await assert.rejects(
          async () =>
            require('node:util').promisify(gateway.processes.execFile)(
              process.execPath,
              ['-e', 'process.exit(0)'],
            ),
          /COMMAND_FORBIDDEN/,
        );
      },
      f.options(),
    );
    assert.equal(
      fs.readFileSync(path.join(f.build, 'candidate/build.log'), 'utf8'),
      'synthetic compiler output',
    );
    assert(!fs.existsSync(path.join(f.current, 'changed')));
  }));
test('a build-only policy cannot adopt an existing unmanaged output root', () =>
  fixture((f) => {
    const request = buildOnly(f);
    fs.writeFileSync(path.join(f.build, 'unowned'), 'preserve');
    assert.throws(
      () => scope.open(request, f.options()),
      /BUILD_ROOT_NOT_EMPTY/,
    );
    assert.equal(
      fs.readFileSync(path.join(f.build, 'unowned'), 'utf8'),
      'preserve',
    );
  }));

test('build-only refuses historical roots instead of silently excluding them', () =>
  fixture((f) => {
    const request = buildOnly(f);
    Object.assign(f.policy, scope.inspect([f.installed, f.build]));
    f.save();
    assert.throws(() => scope.open(request, f.options()), /BUILD_ONLY_BINDING/);
  }));

test('build-only retains failed outputs and refuses an interrupted claim rather than deleting or adopting them', () =>
  fixture((f) => {
    const request = buildOnly(f),
      lease = scope.open(request, f.options());
    const at = path.join(f.build, 'failed');
    lease.registerOutput(at);
    fs.mkdirSync(at);
    lease.createdOutput(at);
    ownedWrite(
      lease,
      path.join(at, 'retained'),
      'synthetic failed compiler output',
    );
    assert.throws(() => lease.allowCleanup([at]), /FAILED_OUTPUT_HELD/);
    assert.throws(
      () => lease.close(Error('synthetic compiler failure')),
      /FAILED_OUTPUT_HELD/,
    );
    assert(fs.existsSync(path.join(at, 'retained')));
    assert.throws(
      () => scope.open(request, f.options()),
      /NEW_SESSION_REQUIRES_REVIEW/,
    );
    assert(
      JSON.parse(
        fs.readFileSync(path.join(f.base, f.policy.scopeId + '.state.json')),
      ).payload.claim,
    );
  }));

test('completed build output changes are not refreshed into acceptance', () =>
  fixture((f) => {
    const request = buildOnly(f),
      lease = scope.open(request, f.options());
    const at = path.join(f.build, 'candidate');
    lease.registerOutput(at);
    fs.mkdirSync(at);
    lease.createdOutput(at);
    ownedWrite(lease, path.join(at, 'artifact'), 'sealed');
    lease.close();
    fs.writeFileSync(path.join(at, 'artifact'), 'external change');
    assert.throws(
      () => scope.open(request, f.options()),
      /NEW_SESSION_REQUIRES_REVIEW/,
    );
  }));

test('forged ledger receipts are refused while a build lease owns the original state', () =>
  fixture((f) => {
    const request = buildOnly(f),
      second = scope.open(request, f.options());
    const ledger = path.join(f.base, f.policy.scopeId + '.state.json');
    const saved = fs.readFileSync(ledger),
      doc = JSON.parse(saved);
    doc.payload.outputs.push({
      path: path.join(f.build, 'forged'),
      complete: true,
      digest: '0'.repeat(64),
    });
    doc.digest = crypto
      .createHash('sha256')
      .update(JSON.stringify(doc.payload))
      .digest('hex');
    fs.writeFileSync(ledger, JSON.stringify(doc));
    assert.throws(() => second.check(), /STATE_REPLACED/);
    fs.writeFileSync(ledger, saved);
    second.close();
  }));

test('a fixed two-source build policy accounts for retained first-package bytes at the second copy peak', () =>
  fixture((f) => {
    const request = buildOnly(f);
    const candidate = '3a36428210f22ea1986f0a96a6066e7fdc9baf46';
    const rollback = 'f618e48f48ff0e3df1c646cb8a666a2461815732';
    f.policy.buildOnly.sources = [
      { sourceCommit: candidate, sourceHash: 'b'.repeat(64) },
      { sourceCommit: rollback, sourceHash: 'c'.repeat(64) },
    ];
    delete f.policy.buildOnly.sourceCommit;
    delete f.policy.buildOnly.sourceHash;
    f.policy.maxBytes = 9000;
    f.policy.maxGrowthBytes = 9000;
    f.save();
    const firstRequest = {
      ...request,
      sourceCommit: candidate,
      reserveBytes: 8192,
    };
    const first = scope.open(firstRequest, f.options());
    const at = path.join(f.build, 'candidate');
    first.registerOutput(at);
    fs.mkdirSync(at);
    first.createdOutput(at);
    ownedWrite(first, path.join(at, 'artifact'), Buffer.alloc(4096));
    const next = {
      ...request,
      sourceCommit: rollback,
      sourceHash: 'c'.repeat(64),
      reserveBytes: 8192,
    };
    assert.throws(() => first.nextBuild(next), /COPY_PEAK_EXCEEDED/);
    assert.throws(
      () => first.nextBuild({ ...next, reserveBytes: 1024 }),
      /BUILD_PAIR_SESSION_REQUIRED/,
    );
    assert.throws(
      () => first.close(Error('copy peak exceeded')),
      /FAILED_OUTPUT_HELD/,
    );
  }));

test('an external unrequested file during an active build is never absorbed into a receipt', () =>
  fixture((f) => {
    const request = buildOnly(f),
      lease = scope.open(request, f.options()),
      at = path.join(f.build, 'candidate');
    lease.registerOutput(at);
    fs.mkdirSync(at);
    lease.createdOutput(at);
    ownedWrite(lease, path.join(at, 'expected-artifact'), 'trusted bytes');
    fs.writeFileSync(
      path.join(at, 'external-unrequested-artifact'),
      'preserve',
    );
    assert.throws(() => lease.check(), /ARTIFACT_UNREQUESTED/);
    assert.throws(() => lease.close(), /ARTIFACT_UNREQUESTED/);
    assert.throws(
      () => scope.open(request, f.options()),
      /NEW_SESSION_REQUIRES_REVIEW/,
    );
    assert.equal(
      fs.readFileSync(path.join(at, 'external-unrequested-artifact'), 'utf8'),
      'preserve',
    );
    const saved = JSON.parse(
      fs.readFileSync(path.join(f.base, f.policy.scopeId + '.state.json')),
    ).payload;
    assert(saved.claim);
    assert.equal(saved.outputs[0].complete, false);
  }));

test('independent artifact reads consume the existing cumulative scan budget', () =>
  fixture((f) => {
    const request = buildOnly(f);
    f.policy.scanBudget = { operationReadBytes: 4, scanReadBytes: 4096 };
    f.save();
    const lease = scope.open(request, f.options()),
      at = path.join(f.build, 'candidate');
    lease.registerOutput(at);
    fs.mkdirSync(at);
    lease.createdOutput(at);
    ownedWrite(lease, path.join(at, 'artifact'), 'eight');
    assert.throws(() => lease.check(), /SCAN_READ_BUDGET/);
    assert.throws(
      () => lease.close(Error('budget exceeded')),
      /SCAN_READ_BUDGET/,
    );
    assert(fs.existsSync(path.join(at, 'artifact')));
  }));

test('rewriting completed artifacts and recomputing the disk ledger self-hash cannot establish a new build session', () =>
  fixture((f) => {
    const request = buildOnly(f),
      lease = scope.open(request, f.options()),
      at = path.join(f.build, 'candidate');
    lease.registerOutput(at);
    fs.mkdirSync(at);
    lease.createdOutput(at);
    ownedWrite(lease, path.join(at, 'artifact'), 'original');
    lease.close();
    fs.writeFileSync(path.join(at, 'artifact'), 'changed');
    const baseline = scope.inspect([at]).baseline,
      ledger = path.join(f.base, f.policy.scopeId + '.state.json');
    const document = JSON.parse(fs.readFileSync(ledger));
    Object.assign(document.payload.outputs[0], {
      digest: baseline.digest,
      metadataDigest: baseline.metadataDigest,
    });
    document.digest = crypto
      .createHash('sha256')
      .update(JSON.stringify(document.payload))
      .digest('hex');
    fs.writeFileSync(ledger, JSON.stringify(document));
    assert.throws(
      () => scope.open(request, f.options()),
      /NEW_SESSION_REQUIRES_REVIEW/,
    );
    assert.equal(fs.readFileSync(path.join(at, 'artifact'), 'utf8'), 'changed');
  }));

test('the exact pair advances in one held memory session and protects the first package', () =>
  fixture((f) => {
    const request = buildOnly(f),
      candidate = '3a36428210f22ea1986f0a96a6066e7fdc9baf46',
      rollback = 'f618e48f48ff0e3df1c646cb8a666a2461815732';
    f.policy.buildOnly.sources = [
      { sourceCommit: candidate, sourceHash: request.sourceHash },
      { sourceCommit: rollback, sourceHash: 'c'.repeat(64) },
    ];
    f.save();
    const lease = scope.open(
        { ...request, sourceCommit: candidate },
        f.options(),
      ),
      at = path.join(f.build, 'candidate');
    lease.registerOutput(at);
    fs.mkdirSync(at);
    lease.createdOutput(at);
    ownedWrite(lease, path.join(at, 'artifact'), 'first');
    lease.nextBuild({
      ...request,
      sourceCommit: rollback,
      sourceHash: 'c'.repeat(64),
    });
    lease.check();
    assert.throws(
      () => scope.open(request, f.options()),
      /BUILD_ONLY_BINDING|EEXIST/,
    );
    fs.writeFileSync(path.join(at, 'artifact'), 'other');
    assert.throws(
      () => lease.check(),
      /MANAGED_OUTPUT_CHANGED|ARTIFACT_CHANGED/,
    );
    assert.throws(
      () => lease.close(Error('first package changed')),
      /MANAGED_OUTPUT_CHANGED|ARTIFACT_CHANGED/,
    );
  }));

test('build-only source path and directory identity cannot change after review', () =>
  fixture((f) => {
    const request = buildOnly(f);
    const source = scope.inspect([f.current]).roots[0];
    Object.assign(f.policy.buildOnly, {
      sourceRoot: source.path,
      sourceIdentity: source.identity,
    });
    f.save();
    assert.throws(
      () => scope.open(request, f.options()),
      /SOURCE_IDENTITY_CHANGED/,
    );
    const bound = { ...request, sourceRoot: source.path };
    const lease = scope.open(bound, f.options());
    lease.close();
    fs.renameSync(f.current, f.current + '-old');
    fs.mkdirSync(f.current);
    assert.throws(
      () => scope.open(bound, f.options()),
      /SOURCE_IDENTITY_CHANGED/,
    );
  }));

test('a build source replaced while the lease is held stops the next checkpoint', () =>
  fixture((f) => {
    const request = buildOnly(f),
      source = scope.inspect([f.current]).roots[0];
    Object.assign(f.policy.buildOnly, {
      sourceRoot: source.path,
      sourceIdentity: source.identity,
    });
    f.save();
    const lease = scope.open(
      { ...request, sourceRoot: source.path },
      f.options(),
    );
    fs.renameSync(f.current, f.current + '-replaced');
    fs.mkdirSync(f.current);
    assert.throws(() => lease.check(), /SOURCE_IDENTITY_CHANGED/);
    assert.throws(
      () => lease.close(Error('source replaced')),
      /SOURCE_IDENTITY_CHANGED/,
    );
  }));
