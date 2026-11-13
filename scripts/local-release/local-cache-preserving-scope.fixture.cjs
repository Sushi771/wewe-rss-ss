'use strict';
// Production-contract-shaped synthetic lifecycle only. Not a production rollback proof.
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  crypto = require('node:crypto'),
  cp = require('node:child_process'),
  assert = require('node:assert/strict');
const hash = (p) =>
    crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'),
  digest = (v) =>
    crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const read = (p) => JSON.parse(fs.readFileSync(p)),
  write = (p, v) =>
    fs.writeFileSync(
      p,
      typeof v === 'string' ? v : JSON.stringify(v, null, 2) + '\n',
      { flag: 'wx' },
    ),
  pin = (p) => ({ path: fs.realpathSync.native(p), sha256: hash(p) });
const sourceFixture = path.join(
  __dirname,
  'local-cache-full-bootstrap.fixture.cjs',
);
function regular(p) {
  const s = fs.lstatSync(p);
  assert(s.isFile() && !s.isSymbolicLink() && s.nlink === 1);
  return s;
}
function dataRoot(root) {
  root = fs.realpathSync.native(root);
  assert.equal(
    path.dirname(root).toLowerCase(),
    fs.realpathSync.native(os.tmpdir()).toLowerCase(),
  );
  assert(path.basename(root).startsWith('wewe-full-bootstrap-'));
  const m = path.join(root, 'synthetic-fixture.json');
  regular(m);
  assert.deepEqual(read(m), { format: 1, fixtureSha256: hash(sourceFixture) });
  regular(path.join(root, 'application.sqlite'));
  return root;
}
function copyTree(from, to) {
  const st = fs.lstatSync(from);
  assert(!st.isSymbolicLink());
  if (st.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const n of fs.readdirSync(from))
      copyTree(path.join(from, n), path.join(to, n));
  } else {
    assert(st.isFile() && st.nlink === 1);
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  }
}
function fileMap(root) {
  const out = {};
  function visit(d) {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n),
        st = fs.lstatSync(p);
      assert(!st.isSymbolicLink());
      if (st.isDirectory()) visit(p);
      else {
        regular(p);
        out[path.relative(root, p).split(path.sep).join('/')] = hash(p);
      }
    }
  }
  visit(root);
  return out;
}
function roleCode(role) {
  return `'use strict';const{DatabaseSync}=require('node:sqlite'),c=require('node:crypto'),a=require('node:assert/strict');const d=new DatabaseSync(process.argv[2],{readOnly:true});d.exec('PRAGMA query_only=ON;BEGIN');const rows={articles:d.prepare('SELECT * FROM articles ORDER BY id').all(),claims:d.prepare('SELECT * FROM refresh_submission_claims ORDER BY id').all(),gate:d.prepare('SELECT * FROM Wechat2RssSourceGate ORDER BY id').all()},before=c.createHash('sha256').update(JSON.stringify(rows)).digest('hex');${role === 'candidate' ? "a(rows.articles.every(x=>typeof x.id==='string'));const projected=rows.articles.map(x=>({id:x.id,mp_id:x.mp_id}));a.equal(projected.length,rows.articles.length);" : 'a.equal(new Set(rows.articles.map(x=>x.id)).size,rows.articles.length);'}const schema=d.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();d.exec('ROLLBACK');d.close();console.log(JSON.stringify({role:${JSON.stringify(role)},digest:before,schemaDigest:c.createHash('sha256').update(JSON.stringify(schema)).digest('hex'),count:rows.articles.length,unknown:rows.claims.filter(x=>x.state==='unknown').length}));`;
}
function verifyBundle(b) {
  dataRoot(b.root);
  for (const p of b.pins) assert.equal(hash(p.path), p.sha256, p.path);
  for (const p of b.packages) {
    assert.equal(hash(path.join(p.path, 'release.json')), p.manifestSha256);
    const m = read(path.join(p.path, 'release.json'));
    for (const [n, h] of Object.entries(m.files))
      assert.equal(hash(path.join(p.path, n)), h, n);
  }
  assert.equal(hash(b.proofFile), b.proofSha256);
}
function prepare(ready, closed) {
  assert.equal(closed.pid, ready.pid);
  assert.equal(closed.code, 0);
  assert.equal(closed.signal, null);
  let absent = false;
  try {
    process.kill(ready.pid, 0);
  } catch (e) {
    assert.equal(e.code, 'ESRCH');
    absent = true;
  }
  assert(absent);
  const root = dataRoot(ready.root);
  assert.equal(ready.database, path.join(root, 'application.sqlite'));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-preserving-scope-')),
    audit = path.join(base, 'audit'),
    registry = path.join(base, 'registry');
  fs.mkdirSync(audit);
  fs.mkdirSync(registry);
  const current = path.join(root, 'server'),
    candidate = path.join(root, 'candidate');
  assert(
    fs.lstatSync(current).isDirectory() &&
      !fs.lstatSync(current).isSymbolicLink(),
  );
  fs.mkdirSync(candidate);
  const packages = [];
  for (const [id, p, role] of [
    ['server', current, 'rollback'],
    ['candidate', candidate, 'candidate'],
  ]) {
    const schema = path.join(p, 'server/prisma');
    fs.mkdirSync(schema, { recursive: true });
    copyTree(
      path.resolve(__dirname, '../../apps/server/prisma/schema.prisma'),
      path.join(schema, 'schema.prisma'),
    );
    copyTree(
      path.resolve(__dirname, '../../apps/server/prisma/migrations'),
      path.join(schema, 'migrations'),
    );
    write(path.join(p, 'sql-role.cjs'), roleCode(role));
    if (role === 'rollback')
      write(
        path.join(p, 'runtime.cjs'),
        "'use strict';require(" + JSON.stringify(sourceFixture) + ');\n',
      );
    const files = fileMap(p),
      m = {
        format: 1,
        id,
        sourceCommit: crypto
          .createHash('sha1')
          .update(roleCode(role))
          .digest('hex'),
        syntheticOnly: true,
        schemaCompatibility: 'current',
        files,
        links: {},
        scope:
          'Distinct same-schema synthetic SQL consumers; real current source-main lifecycle, not production version rollback',
      };
    write(path.join(p, 'release.json'), m);
    packages.push({
      id,
      path: p,
      manifestSha256: hash(path.join(p, 'release.json')),
      sourceCommit: m.sourceCommit,
    });
  }
  const runs = [];
  for (const p of [packages[0], packages[1], packages[0]]) {
    const raw = cp.execFileSync(
      process.execPath,
      [path.join(p.path, 'sql-role.cjs'), ready.database],
      { cwd: p.path, encoding: 'utf8', windowsHide: true, timeout: 10000 },
    );
    runs.push(JSON.parse(raw));
  }
  assert.deepEqual(
    runs.map((x) => x.role),
    ['rollback', 'candidate', 'rollback'],
  );
  for (const r of runs) {
    assert.equal(r.digest, runs[0].digest);
    assert.equal(r.schemaDigest, runs[0].schemaDigest);
    assert.equal(r.count, 4);
    assert.equal(r.unknown, 1);
  }
  const contract = require('./preserving-contract.cjs'),
    schemaProof = contract.validateSameSchema(
      read(path.join(current, 'release.json')),
      read(path.join(candidate, 'release.json')),
    );
  const evidence = path.join(base, 'SAME_SCHEMA_ROLE_EVIDENCE.json');
  write(evidence, {
    syntheticOnly: true,
    mainReady: ready,
    mainClosed: closed,
    runs,
    schemaProof,
  });
  const proof = {
    format: 1,
    kind: 'same-schema-unknown-claim-rollback',
    syntheticOnly: true,
    scope:
      'Only synthetic SQL consumers, never a production candidate compatibility certificate',
    businessDatabaseRestored: false,
    schemaProofSha256: digest(schemaProof),
    evidence: pin(evidence),
    checks: {
      sameSchema: runs.every((x) => x.schemaDigest === runs[0].schemaDigest),
      isolatedRuntimeStarted: runs.length === 3,
      unknownClaimsPreserved: runs.every(
        (x) => x.unknown === 1 && x.digest === runs[0].digest,
      ),
      businessRowsPreserved: runs.every(
        (x) => x.count === 4 && x.digest === runs[0].digest,
      ),
      rollbackStarted: runs[2].role === 'rollback',
    },
    rollback: {
      id: packages[0].id,
      sourceCommit: packages[0].sourceCommit,
      manifestSha256: packages[0].manifestSha256,
    },
    candidate: {
      id: packages[1].id,
      sourceCommit: packages[1].sourceCommit,
      manifestSha256: packages[1].manifestSha256,
    },
  };
  const proofFile = path.join(base, 'compatibility.json');
  write(proofFile, proof);
  const pointer = path.join(root, 'active.json');
  write(pointer, { format: 1, id: 'server' });
  const rollback = path.join(base, 'rollback.json');
  write(rollback, { format: 1, packages: [packages[0]] });
  const pins = [
    pin(__filename),
    pin(sourceFixture),
    pin(process.execPath),
    pin(evidence),
  ];
  for (const n of fs
    .readdirSync(__dirname)
    .filter((x) => /\.(cjs|ps1|cs)$/.test(x)))
    pins.push(pin(path.join(__dirname, n)));
  for (const n of [
    'apps/server/src/main.ts',
    'apps/server/src/collection/local-cache-reader.ts',
  ]) {
    const p = path.resolve(__dirname, '../..', n);
    pins.push(pin(p));
  }
  const b = {
    format: 1,
    syntheticOnly: true,
    base,
    root,
    current,
    candidate,
    audit,
    registry,
    packages,
    proofFile,
    proofSha256: hash(proofFile),
    pointer,
    pointerSha256: hash(pointer),
    rollbackFile: rollback,
    wrapperPath: path.join(current, 'runtime.cjs'),
    wrapperPin: pin(path.join(current, 'runtime.cjs')),
    fixturePin: pin(sourceFixture),
    companionPin: pin(__filename),
    nextArgv: [
      process.execPath,
      path.join(current, 'runtime.cjs'),
      '--reuse-root',
      root,
    ],
    pins,
    ready,
  };
  write(path.join(base, 'PREPARED.json'), b);
  return b;
}
function bind(bundle, preparedSha, liveReady, native) {
  const prepared = path.join(bundle.base, 'PREPARED.json');
  assert.equal(hash(prepared), preparedSha);
  const b = read(prepared);
  verifyBundle(b);
  assert.equal(liveReady.root, b.root);
  assert.equal(liveReady.database, b.ready.database);
  assert(
    liveReady.pid !== b.ready.pid &&
      liveReady.port > 0 &&
      liveReady.port !== 4000,
  );
  assert.equal(native.snapshot.pid, liveReady.pid);
  assert.equal(native.snapshot.startUtc, liveReady.startUtc);
  assert.equal(native.snapshot.commandLine, liveReady.commandLine);
  assert.equal(native.snapshot.executable, process.execPath);
  const launchers = native.launchers.map((l, i) => {
    const entry = i === 0 ? b.wrapperPath : l.entry;
    assert.equal(l.entry, entry);
    assert(entry.startsWith(b.current + path.sep));
    assert.equal(hash(l.executable.path), l.executable.sha256);
    return {
      entry,
      argv: l.argv,
      workingDirectory: b.current,
      cwdIndependent: true,
      executable: l.executable,
      files: [pin(entry), ...(i === 0 ? [pin(sourceFixture)] : [])],
      packageId: 'server',
      ...(i ? { parentEntry: b.wrapperPath } : {}),
    };
  });
  assert.equal(launchers.length, 3);
  assert.deepEqual(launchers[0].argv, b.nextArgv);
  // The unchanged strict-family contract requires one declared root for BOTH
  // roles. This candidate is the actually tested synthetic SQL consumer, not a
  // claimed running application process; no PID/observation is invented.
  const candidateEntry = path.join(b.candidate, 'sql-role.cjs');
  regular(candidateEntry);
  launchers.push({
    entry: candidateEntry,
    argv: [process.execPath, candidateEntry, b.ready.database],
    workingDirectory: b.candidate,
    cwdIndependent: true,
    executable: pin(process.execPath),
    files: [pin(candidateEntry)],
    packageId: 'candidate',
  });
  for (const id of ['server', 'candidate']) {
    assert.equal(
      launchers.filter((l) => l.packageId === id && l.parentEntry === undefined)
        .length,
      1,
    );
    const entries = launchers
      .filter((l) => l.packageId === id)
      .map((l) => l.entry);
    assert.equal(new Set(entries).size, entries.length);
  }
  assert.equal(hash(native.consoleSpec.path), native.consoleSpec.sha256);
  const spec = {
    format: 1,
    operation: 'restart',
    effects: ['new-output-only', 'approved-active-switch'],
    active: {
      pointer: b.pointer,
      pointerSha256: b.pointerSha256,
      currentId: 'server',
      candidateId: 'candidate',
      currentManifestSha256: b.packages[0].manifestSha256,
      candidateManifestSha256: b.packages[1].manifestSha256,
      oldProcess: {
        pid: liveReady.pid,
        startUtc: liveReady.startUtc,
        executableSha256: hash(liveReady.executable),
      },
    },
    effectScope: {
      format: 1,
      container: b.root,
      allocations: [{ path: b.audit, mode: 'audit-children' }],
      taskIdentities: [],
      lifecycleSha256: null,
    },
    processFamily: { format: 1, consoleHost: native.consoleSpec },
  };
  const scope = require('./release-scope.cjs'),
    inspection = scope.inspect([b.root, b.audit], {
      privateAccounting: 'private-names-v1',
      preservingUpdate: spec,
    }),
    st = fs.lstatSync(b.registry, { bigint: true });
  const policy = {
    format: 2,
    scopeId: crypto.randomUUID(),
    inventoryClassification: 'private-names-v1',
    registryDirectory: b.registry,
    registryIdentity: [st.dev, st.ino, st.birthtimeNs].map(String),
    ...inspection,
    // Exact reviewed production-contract budget, used only by this TEMP test.
    scanBudget: {
      profile: 'legacy-stream-v1',
      checkpointMode: 'full',
      scanEntries: 100000,
      operationEntries: 1000000,
      scanReadBytes: 1073741824,
      operationReadBytes: 2147483648,
      durationMs: 1800000,
    },
    maxBytes: scope.DEFAULT_BYTES,
    maxGrowthBytes: 1024 * 1024,
    maxNewRuntimeCopies: 0,
    protectedIds: ['server', 'candidate'],
    packageProofs: Object.fromEntries(
      b.packages.map((p) => [p.id, p.manifestSha256]),
    ),
    compatibilityProofSha256: b.proofSha256,
    preservingUpdate: spec,
    probe: pin(path.join(__dirname, 'windows-release-references.cjs')),
    windowsReferences: {
      format: 1,
      packages: b.packages.map((p) => ({ id: p.id, path: p.path })),
      rollbackFiles: [pin(b.rollbackFile)],
      compatibilityProof: pin(b.proofFile),
      collectorSha256: hash(
        path.join(__dirname, 'windows-release-reference-collector.ps1'),
      ),
      collectorIdentitySha256: hash(
        path.join(__dirname, 'windows-reference-directory-identity.cs'),
      ),
      launchers,
    },
  };
  const contract = require('./preserving-contract.cjs');
  contract.validateSameSchemaCompatibility(
    read(b.proofFile),
    policy,
    b.packages.map((p) => ({
      root: p.path,
      manifest: read(path.join(p.path, 'release.json')),
      manifestSha256: p.manifestSha256,
    })),
  );
  assert.deepEqual(contract.referenceApplicability(policy).categories, {
    processes: true,
    tasks: true,
    shortcuts: 'not_applicable',
    pointers: true,
    rollback: true,
    inflight: true,
  });
  const policyFile = path.join(b.base, 'policy.json');
  write(policyFile, policy);
  const bindings = {
    preparedSha256: preparedSha,
    policyFile,
    policySha256: hash(policyFile),
    liveReady,
    oldProcess: spec.active.oldProcess,
    syntheticTaskCoverage:
      'no task registered; actual production Task remains final install prerequisite',
  };
  write(path.join(b.base, 'BINDINGS.json'), bindings);
  return bindings;
}
async function execute(bundle, bindings) {
  verifyBundle(bundle);
  assert.equal(hash(bindings.policyFile), bindings.policySha256);
  const p = read(bindings.policyFile);
  const scope = require('./release-scope.cjs');
  const ledgerFile = path.join(bundle.registry, p.scopeId + '.state.json');
  const lockFile = path.join(bundle.registry, p.scopeId + '.lock');
  const stagesFile = path.join(bundle.base, 'SCOPE_STAGES.jsonl');
  write(
    stagesFile,
    JSON.stringify({
      atUtc: new Date().toISOString(),
      stage: 'calling-formal-scope-within',
    }) + '\n',
  );
  let stage = 'scope-open';
  const record = (name, detail = {}) =>
    fs.appendFileSync(
      stagesFile,
      JSON.stringify({
        atUtc: new Date().toISOString(),
        stage: name,
        ...detail,
      }) + '\n',
    );
  // The formal open creates its own real lock/ledger BEFORE its built-in query.
  // Do not call the reference probe independently or manufacture registry state.
  try {
    await scope.within(
      { kind: 'restart', root: bundle.root, reserveBytes: 1024 * 1024 },
      async (lease) => {
        const lock = read(lockFile),
          opened = read(ledgerFile);
        assert.equal(lock.pid, process.pid);
        assert.equal(lock.configSha, bindings.policySha256);
        assert.equal(opened.payload.configSha, bindings.policySha256);
        assert.equal(digest(opened.payload), opened.digest);
        assert.equal(opened.payload.claim.kind, 'restart');
        record('formal-open-returned', {
          lockSha256: hash(lockFile),
          ledgerSha256: hash(ledgerFile),
        });
        stage = 'scope-check';
        lease.check();
        record('formal-check-returned');
        stage = 'scope-close';
        record('callback-returning-for-formal-close');
      },
      { configPath: bindings.policyFile, configSha256: bindings.policySha256 },
    );
    stage = 'post-close';
    record('formal-within-returned-after-close');
  } catch (error) {
    const encode = (e) =>
      e == null
        ? null
        : {
            name: e.name,
            message: e.message,
            stack: e.stack,
            code: e.code,
            cause: e.cause ? encode(e.cause) : undefined,
            errors: Array.isArray(e.errors) ? e.errors.map(encode) : undefined,
          };
    try {
      write(path.join(bundle.base, 'SCOPE_FAILURE.json'), {
        stage,
        error: encode(error),
        lockPresent: fs.existsSync(lockFile),
        ledgerPresent: fs.existsSync(ledgerFile),
        ledgerSha256: fs.existsSync(ledgerFile) ? hash(ledgerFile) : null,
      });
    } catch (saveError) {
      throw new AggregateError(
        [error, saveError],
        'SCOPE_AND_DIAGNOSTIC_SAVE_FAILED',
      );
    }
    throw error;
  }
  const ledger = read(path.join(bundle.registry, p.scopeId + '.state.json'));
  assert.equal(ledger.payload.claim, null);
  assert(!fs.existsSync(path.join(bundle.registry, p.scopeId + '.lock')));
  assert.equal(hash(bundle.pointer), bundle.pointerSha256);
  const report = {
    ok: true,
    syntheticOnly: true,
    productionTouched: false,
    scopeClosed: true,
    mode: 'production-contract-shaped preserving/projectOnly/strict-family',
    allSixCategories: false,
    shortcuts: 'not_applicable',
    productionTaskNotExercised: true,
    productionRollbackQualified: false,
    mainPid: bindings.liveReady.pid,
    mainPort: bindings.liveReady.port,
    policySha256: bindings.policySha256,
    proofSha256: bundle.proofSha256,
  };
  write(path.join(bundle.base, 'SCOPE_REPORT.json'), report);
  return report;
}
module.exports = { prepare, bind, execute };
