const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { probe, argv } = require('./windows-release-references.cjs');
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
const hash = (v) => sha(JSON.stringify(v));
const quote = (v) => '"' + v + '"';
const directoryIdentity = (at) => {
  const s = fs.lstatSync(at, { bigint: true });
  return [s.dev, s.ino, s.birthtimeNs].map(String);
};
function fixture(run) {
  const base = fs.mkdtempSync(
    path.join(os.tmpdir(), 'wewe-reference-adapter-'),
  );
  const installed = path.join(base, 'installed'),
    registry = path.join(base, 'registry'),
    project = path.join(base, 'project');
  for (const folder of [installed, registry, project]) fs.mkdirSync(folder);
  const write = (at, value) =>
    fs.writeFileSync(
      at,
      typeof value === 'string' ? value : JSON.stringify(value),
    );
  const pin = (at) => ({ path: at, sha256: sha(fs.readFileSync(at)) });
  const packages = ['current', 'candidate', 'rollback'].map((id, i) => {
    const at = path.join(installed, id);
    fs.mkdirSync(at);
    write(path.join(at, 'release.json'), {
      format: 1,
      id,
      sourceCommit: String(i + 1).repeat(40),
    });
    write(path.join(at, 'runtime.exe'), 'inert synthetic executable ' + id);
    write(path.join(at, 'entry.cjs'), '// inert synthetic script');
    return { id, path: at };
  });
  const pointer = path.join(installed, 'active.json');
  write(pointer, { format: 1, id: 'current' });
  const controller = path.join(base, 'controller.exe');
  write(controller, 'inert controller');
  const worker = path.join(base, 'worker.exe');
  write(worker, 'inert child');
  const launcher = path.join(project, 'logon-start.cjs');
  write(launcher, '// reviewed synthetic launcher');
  const links = path.join(base, 'links');
  fs.mkdirSync(links);
  const shortcut = path.join(links, 'synthetic.lnk');
  write(shortcut, 'inert shortcut bytes, not an executable link');
  const rollbackFile = path.join(registry, 'rollback-plan.json');
  write(rollbackFile, { format: 1, packages: [packages[2]] });
  const compatibility = path.join(registry, 'compatibility.json');
  const proof = {
    format: 1,
    kind: 'additive-schema-unknown-claim-rollback',
    businessDatabaseRestored: false,
    checks: {
      additiveSchema: true,
      unknownClaimsPreserved: true,
      businessRowsPreserved: true,
      rollbackStarted: true,
    },
    candidate: {
      id: 'candidate',
      sourceCommit: '2'.repeat(40),
      manifestSha256: pin(path.join(packages[1].path, 'release.json')).sha256,
    },
    rollback: {
      id: 'rollback',
      sourceCommit: '3'.repeat(40),
      manifestSha256: pin(path.join(packages[2].path, 'release.json')).sha256,
    },
  };
  write(compatibility, proof);
  const policy = {
    format: 1,
    roots: [{ path: installed }],
    registryDirectory: registry,
    scopeId: crypto.randomUUID(),
    protectedIds: packages.map((p) => p.id),
    packageProofs: Object.fromEntries(
      packages.map((p) => [
        p.id,
        pin(path.join(p.path, 'release.json')).sha256,
      ]),
    ),
    compatibilityProofSha256: pin(compatibility).sha256,
    windowsReferences: {
      format: 1,
      packages: [...packages],
      rollbackFiles: [pin(rollbackFile)],
      compatibilityProof: pin(compatibility),
      launchers: [
        {
          entry: launcher,
          argv: [controller, launcher, 'start'],
          workingDirectory: project,
          cwdIndependent: true,
          executable: pin(controller),
          files: [pin(launcher)],
          pointerPath: pointer,
        },
      ],
    },
  };
  const policySha = 'a'.repeat(64),
    lock = path.join(registry, policy.scopeId + '.lock'),
    ledger = path.join(registry, policy.scopeId + '.state.json');
  write(lock, { pid: 99, nonce: 'owned-nonce', configSha: policySha });
  const state = { format: 1, configSha: policySha, outputs: [], claim: null };
  const saveState = () =>
    write(ledger, { payload: state, digest: hash(state) });
  saveState();
  const process = (pid, parentPid, executable, commandLine) => ({
    pid,
    parentPid,
    executable,
    commandLine,
    startUtc: '2026-01-01T00:00:00.000Z',
    name: 'inert.exe',
  });
  const processes = [
    process(
      10,
      1,
      path.join(packages[0].path, 'runtime.exe'),
      `${quote(path.join(packages[0].path, 'runtime.exe'))} ${quote(path.join(packages[0].path, 'entry.cjs'))}`,
    ),
    process(11, 10, worker, quote(worker)),
    process(99, 1, controller, quote(controller)),
  ];
  const native = {
    format: 1,
    complete: true,
    categories: { processes: true, tasks: true, shortcuts: true },
    errors: [],
    policySha256: policySha,
    processesBefore: structuredClone(processes),
    processesAfter: structuredClone(processes),
    tasks: [
      {
        identity: '\\SyntheticLogon',
        actions: [
          {
            execute: controller,
            arguments: `${quote(launcher)} start`,
            workingDirectory: project,
          },
        ],
      },
    ],
    shortcuts: [
      {
        path: shortcut,
        sha256: pin(shortcut).sha256,
        target: path.join(packages[0].path, 'runtime.exe'),
        arguments: '',
        workingDirectory: packages[0].path,
      },
    ],
    shortcutDirectories: [
      {
        path: links,
        identity: directoryIdentity(links),
        entries: [{ name: 'synthetic.lnk', kind: 'file' }],
      },
    ],
    shortcutCoverage: [
      'Desktop',
      'CommonDesktop',
      'StartMenu',
      'CommonStartMenu',
      'Startup',
      'CommonStartup',
    ].map((kind) => ({
      kind,
      path: links,
      identity: directoryIdentity(links),
      status: 'enumerated',
    })),
  };
  native.tasksAfter = structuredClone(native.tasks);
  const f = {
    base,
    installed,
    registry,
    project,
    packages,
    policy,
    native,
    pointer,
    controller,
    worker,
    launcher,
    shortcut,
    rollbackFile,
    compatibility,
    proof,
    lock,
    ledger,
    state,
    saveState,
    write,
    pin,
    process,
    run: () => probe(policy, native, { callerPid: 99 }),
    repinProof() {
      write(compatibility, proof);
      policy.compatibilityProofSha256 = pin(compatibility).sha256;
      policy.windowsReferences.compatibilityProof = pin(compatibility);
    },
  };
  try {
    run(f);
  } finally {
    assert(
      path.dirname(base) === os.tmpdir() &&
        path.basename(base).startsWith('wewe-reference-adapter-'),
    );
    fs.rmSync(base, { recursive: true, force: true });
  }
}
function reject(f, expected) {
  const r = f.run();
  assert.equal(r.complete, false);
  assert(r.errors.includes(expected), JSON.stringify(r));
}
test('failed native validation preserves bounded inner codes/stage through scope and admission CLI formatting', () =>
  fixture((f) => {
    f.native.complete = false;
    f.native.errors = [
      'REFERENCE_NATIVE_DEADLINE',
      'SECRET C:\\private\\secret --token=hidden',
    ];
    f.native.failureContext = {
      stage: 'operation-port-after',
      errorId: 'UnauthorizedAccessException',
      category: 'PermissionDenied',
      message: 'SECRET_TOKEN',
      path: 'C:\\private\\secret',
    };
    const r = f.run();
    assert.deepEqual(r.errors, ['REFERENCE_NATIVE_QUERY_INCOMPLETE']);
    assert(r.referenceDiagnostic.codes.includes('REFERENCE_NATIVE_DEADLINE'));
    assert.equal(r.referenceDiagnostic.nativeStage, 'operation-port-after');
    let held;
    try {
      require('./release-scope.cjs').validateReferences(r, f.policy, 'install');
    } catch (e) {
      held = e;
    }
    assert.equal(held.message, 'RELEASE_SCOPE_REFERENCE_QUERY_INCOMPLETE');
    const output = require('./once-pair-admission.cjs').formatCliError(held);
    assert(output.includes('REFERENCE_NATIVE_DEADLINE'));
    assert(output.includes('native-validation'));
    assert(!/SECRET|private|hidden|token|message/.test(output));
  }));
test('probe CLI catch preserves safe pre-parser errors and transport details without stderr/command/stack', () => {
  const api = require('./windows-release-references.cjs');
  const pinned = api.cliResult(() => {
    throw new Error('REFERENCE_COLLECTOR_PIN_CHANGED');
  });
  assert.deepEqual(pinned.errors, ['REFERENCE_COLLECTOR_PIN_CHANGED']);
  const error = Object.assign(
    new Error('SECRET C:\\private\\secret --token=hidden'),
    {
      code: 'ETIMEDOUT',
      status: 1,
      stderr: 'PRIVATE_STDERR',
      stdout: 'PRIVATE_STDOUT',
      cmd: 'PRIVATE_CMD',
    },
  );
  const failed = api.cliResult(() => {
    throw error;
  });
  assert.equal(failed.referenceDiagnostic.transportCode, 'ETIMEDOUT');
  assert.equal(failed.referenceDiagnostic.status, 1);
  assert(!/SECRET|PRIVATE|private|token|stack/.test(JSON.stringify(failed)));
  const summary = api.referenceDiagnostic({
    stage: 'C:\\private',
    codes: Array(100)
      .fill('REFERENCE_BACKGROUND_GAP_UNBOUND')
      .concat(['PRIVATE PAYLOAD']),
    categories: { processes: false, secret: 'TOKEN' },
    stderr: 'SECRET',
  });
  assert.equal(summary.stage, 'unknown');
  assert.deepEqual(summary.codes, ['REFERENCE_BACKGROUND_GAP_UNBOUND']);
  assert.equal(Object.keys(summary.categories).length, 6);
  assert(!JSON.stringify(summary).includes('TOKEN'));
});

test('probe bounded diagnostics retain maintenance codes and exception type without raw exception text', () => {
  const api = require('./windows-release-references.cjs');
  const safe = api.cliResult(() => {
    throw Error('FIXED_MAINTENANCE_RECORD_OWNER');
  });
  assert(
    safe.referenceDiagnostic.codes.includes('FIXED_MAINTENANCE_RECORD_OWNER'),
  );
  const typed = api.cliResult(() => {
    throw new TypeError('C:/private SECRET_ARGV argv is not a function');
  });
  assert.equal(typed.referenceDiagnostic.exceptionType, 'TypeError');
  assert(!/private|SECRET|argv|stack/.test(JSON.stringify(typed)));
  assert.equal(
    api.referenceDiagnostic({ exceptionType: 'C:/SECRET' }).exceptionType,
    undefined,
  );
  fixture((f) => {
    Object.defineProperty(f.native, 'processesBefore', {
      get() {
        throw new TypeError('C:/private SECRET_ARGV');
      },
    });
    const out = f.run();
    assert.equal(out.referenceDiagnostic.exceptionType, 'TypeError');
    assert(!/private|SECRET|stack/.test(JSON.stringify(out)));
    let wrapped;
    try {
      require('./release-scope.cjs').validateReferences(
        out,
        f.policy,
        'install',
      );
    } catch (e) {
      wrapped = e;
    }
    assert.equal(wrapped.referenceDiagnostic.exceptionType, 'TypeError');
  });
});

function operationFixture(f) {
  const source = path.join(f.base, 'sources');
  fs.mkdirSync(source);
  for (const p of f.packages.slice(1)) {
    const at = path.join(source, p.id);
    fs.renameSync(p.path, at);
    p.path = at;
  }
  const held = { id: 'held', path: path.join(f.installed, 'held') };
  fs.mkdirSync(held.path);
  f.write(path.join(held.path, 'release.json'), {
    format: 1,
    id: held.id,
    sourceCommit: '4'.repeat(40),
  });
  f.packages.push(held);
  const p = f.policy;
  p.roots.push({ path: source });
  p.mode = 'once-frozen-pair-v1';
  p.installRoot = f.installed;
  p.currentId = 'current';
  p.heldId = 'held';
  p.legacyIds = ['held'];
  p.protectedIds = f.packages.map((r) => r.id);
  p.protectedPackages = f.packages.map((r) => ({
    ...r,
    sourceCommit: JSON.parse(fs.readFileSync(path.join(r.path, 'release.json')))
      .sourceCommit,
  }));
  p.packageProofs.held = f.pin(path.join(held.path, 'release.json')).sha256;
  p.pair = ['candidate', 'rollback'].map((role) => ({
    role,
    id: role,
    source: f.packages.find((r) => r.id === role).path,
    target: path.join(f.installed, role),
  }));
  p.approval = {
    operations: ['install', 'publish', 'rollback'],
    candidateCommit: '2'.repeat(40),
    rollbackCommit: '3'.repeat(40),
  };
  p.publication = {
    database: path.join(
      path.dirname(f.installed),
      'apps/server/data/wewe-rss.db',
    ),
    limits: { maxBackups: 1, maxPublications: 1, maxRollbacks: 1 },
  };
  p.windowsReferences.packages = [...f.packages];
  f.write(f.rollbackFile, { format: 1, packages: [f.packages[2]] });
  p.windowsReferences.rollbackFiles = [f.pin(f.rollbackFile)];
  const profiles = [500, 1007].map((id) => ({
    sid: 'S-1-5-21-1-2-3-' + id,
    path: path.join(f.base, 'unread-profile-' + id),
    special: false,
    loaded: false,
    status: 0,
    staticShortcutsInspected: false,
  }));
  p.windowsReferences.operationCoverage = {
    format: 1,
    kind: 'non-retiring-once-pair-v1',
    staticScopeMode: 'startup-and-pinned-launchers-v1',
    preserveLegacy: true,
    globalReferenceComplete: false,
    uninspectedProfiles: profiles,
  };
  Object.assign(f.native, {
    complete: false,
    operationSufficient: true,
    globalReferenceComplete: false,
    operationCoverage: {
      kind: 'non-retiring-once-pair-v1',
      staticScopeMode: 'startup-and-pinned-launchers-v1',
      profilesBefore: structuredClone(profiles),
      profilesAfter: structuredClone(profiles),
      staticJunctions: [],
    },
  });
  f.native.categories.shortcuts = false;
  for (const c of f.native.shortcutCoverage.filter((c) =>
    ['Startup', 'CommonStartup'].includes(c.kind),
  )) {
    const at = path.join(f.base, c.kind);
    fs.mkdirSync(at);
    Object.assign(c, { path: at, identity: directoryIdentity(at) });
    f.native.shortcutDirectories.push({
      path: at,
      identity: c.identity,
      entries: [],
    });
  }
  f.native.shortcutCoverage = f.native.shortcutCoverage.map((c) =>
    ['Startup', 'CommonStartup'].includes(c.kind)
      ? c
      : {
          kind: c.kind,
          status: 'not-inspected-operation-scope',
          inspected: false,
          reason: 'outside-non-retiring-operation',
        },
  );
  f.native.shortcutDirectories = f.native.shortcutDirectories.filter(
    (d) => d.path !== path.dirname(f.shortcut),
  );
  f.native.shortcuts = [];
  f.addStaticJunction = (startup = false) => {
    const parent = startup
      ? f.native.shortcutCoverage.find((r) => r.kind === 'Startup').path
      : path.dirname(f.shortcut);
    const target = path.join(f.base, 'retained-static-target');
    fs.mkdirSync(target);
    const at = path.join(parent, 'unrelated-link');
    fs.symlinkSync(
      target,
      at,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    if (startup)
      f.native.shortcutDirectories
        .find((r) => r.path === parent)
        .entries.push({ name: 'unrelated-link', kind: 'junction' });
    return at;
  };
}

function taskFixture(f) {
  processFixture(f);
  const actions = [
    {
      execute: '',
      arguments: '',
      workingDirectory: '',
      actionType: 'com-handler',
      cimClass: 'MSFT_TaskComHandlerAction',
      id: '',
      classId: '{12345678-1234-1234-1234-123456789abc}',
      data: 'opaque component input',
    },
    {
      execute: f.worker,
      arguments: '--external',
      workingDirectory: f.base,
      actionType: 'exec',
      cimClass: 'MSFT_TaskExecAction',
      id: '',
      classId: '',
      data: '',
    },
  ];
  for (const a of actions) a.identitySha256 = hash(a);
  f.native.tasks.push({
    identity: '\\Background',
    actions,
    actionsSha256: hash(actions),
  });
  f.native.tasksAfter = structuredClone(f.native.tasks);
  const api = require('./windows-release-references.cjs');
  f.policy.windowsReferences.operationCoverage.taskCoverage = {
    format: 1,
    kind: 'once-background-task-actions-v1',
    globalTaskInvocationCoverageComplete: false,
    coverageClaim: 'bound-background-actions-only;indirect-db-access-unproven',
    backgroundActions: actions.map((_, i) =>
      api.taskActionTuple(f.native.tasks[1], i),
    ),
  };
}
test('operation task contract retains exact COM/exec gaps through final scope validation without global claims', () =>
  fixture((f) => {
    taskFixture(f);
    const r = f.run();
    assert.deepEqual(r.errors, []);
    assert(r.operationSufficient);
    assert.equal(r.categories.tasks, false);
    const scope = require('./release-scope.cjs');
    for (const operation of ['install', 'publish', 'rollback'])
      scope.validateReferences(r, f.policy, operation);
    assert.throws(() => scope.validateReferences(r, f.policy, 'retire'));
    const forged = structuredClone(r);
    forged.operationCoverage.taskCoverage.backgroundDbAccessExcluded = true;
    assert.throws(
      () => scope.validateReferences(forged, f.policy, 'publish'),
      /TASK_COVERAGE_INVALID/,
    );
  }));
for (const fault of [
  'new-action',
  'changed-clsid',
  'changed-data',
  'changed-type',
  'changed-definition',
  'missing-post',
  'unknown-empty-execute',
  'missing-metadata',
  'associated-db',
  'associated-package',
  'associated-launcher',
])
  test('operation task contract refuses ' + fault, () =>
    fixture((f) => {
      taskFixture(f);
      const t = f.native.tasks[1],
        c = f.policy.windowsReferences.operationCoverage.taskCoverage;
      if (fault === 'new-action') t.actions.push({ ...t.actions[1] });
      if (fault === 'changed-clsid')
        t.actions[0].classId = '{aaaaaaaa-1234-1234-1234-123456789abc}';
      if (fault === 'changed-data') t.actions[0].data = 'changed';
      if (fault === 'changed-type') t.actions[0].actionType = 'exec';
      if (fault === 'changed-definition') t.actionsSha256 = 'f'.repeat(64);
      if (fault === 'missing-metadata') delete t.actions[0].cimClass;
      if (fault === 'unknown-empty-execute') {
        delete f.policy.windowsReferences.operationCoverage.taskCoverage;
        t.actions[0] = { execute: '', arguments: '', workingDirectory: '' };
      }
      if (fault.startsWith('associated-')) {
        t.actions[0].data =
          fault === 'associated-db'
            ? f.policy.publication.database
            : fault === 'associated-package'
              ? f.packages[0].path
              : f.launcher;
        c.backgroundActions[0] =
          require('./windows-release-references.cjs').taskActionTuple(t, 0);
      }
      f.native.tasksAfter =
        fault === 'missing-post' ? [] : structuredClone(f.native.tasks);
      assert.equal(f.run().operationSufficient, false, JSON.stringify(f.run()));
    }),
  );
test('final probe recognizes the same continuation anchor only for the currently locked incomplete attempt', () =>
  fixture((f) => {
    processFixture(f);
    const admission = require('./once-pair-admission.cjs');
    f.policy.codePins = admission.codePins();
    f.policy.probe = f.pin(
      path.join(__dirname, 'windows-release-references.cjs'),
    );
    Object.assign(f.policy.approval, { confirmed: true, id: 'old-execution' });
    const previous = path.join(f.base, 'previous-policy.json'),
      outcome = path.join(f.base, 'old-outcome.json'),
      sentinel = f.ledger + '.adopted';
    f.write(previous, f.policy);
    const oldSha = f.pin(previous).sha256;
    const oldState = {
      format: 1,
      once: 'once-frozen-pair-v1',
      configSha: oldSha,
      outputs: [],
      claim: null,
      slots: f.policy.pair.map((x) => ({
        id: x.id,
        path: x.target,
        started: false,
        complete: false,
        identity: null,
      })),
    };
    const oldText = JSON.stringify({
      payload: oldState,
      digest: hash(oldState),
    });
    f.write(f.ledger, oldText);
    f.write(sentinel, oldSha);
    f.write(outcome, {
      outcome: 'HELD_BEFORE_PACKAGE_COPY',
      executionPolicySha256: oldSha,
    });
    const spec = (at) => ({ ...f.pin(at), identity: directoryIdentity(at) }),
      c = {
        format: 1,
        kind: 'verified-pre-copy-continuation-v1',
        id: crypto.randomUUID(),
        previousPolicy: spec(previous),
        previousLedger: spec(f.ledger),
        previousSentinel: spec(sentinel),
        previousOutcome: spec(outcome),
      };
    f.policy.preCopyContinuation = c;
    f.policy.approval.id = 'new-execution';
    f.policy.approval.continuation = {
      id: c.id,
      fromConfigSha: oldSha,
      fromLedgerSha: c.previousLedger.sha256,
      fromSentinelSha: c.previousSentinel.sha256,
    };
    const nextSha = hash(f.policy),
      receipt = admission.continuationPath(f.policy);
    f.write(receipt, {
      format: 1,
      kind: c.kind,
      id: c.id,
      fromConfigSha: oldSha,
      toConfigSha: nextSha,
      approvalId: f.policy.approval.id,
      previousPolicy: c.previousPolicy,
      previousLedger: c.previousLedger,
      previousSentinel: c.previousSentinel,
      previousOutcome: c.previousOutcome,
      previousLedgerText: oldText,
      previousSentinelText: oldSha,
    });
    const state = {
      ...oldState,
      configSha: nextSha,
      continuation: {
        id: c.id,
        receiptSha256: f.pin(receipt).sha256,
        receiptIdentity: directoryIdentity(receipt),
      },
      continuationAttempt: { nonce: 'owned-nonce', status: 'running' },
      claim: {
        id: 'continued',
        kind: 'install',
        root: f.installed,
        outputs: [],
      },
    };
    const save = () =>
      f.write(f.ledger, { payload: state, digest: hash(state) });
    save();
    f.write(f.lock, { pid: 99, nonce: 'owned-nonce', configSha: nextSha });
    f.native.policySha256 = nextSha;
    assert(f.run().operationSufficient, JSON.stringify(f.run()));
    state.continuationAttempt.nonce = 'other-owner';
    save();
    assert(f.run().errors.includes('REFERENCE_CONTINUATION_OWNER_UNCERTAIN'));
  }));
function processFixture(f) {
  operationFixture(f);
  f.policy.publication.expected = {
    ...f.native.processesBefore[0],
    port: 4000,
  };
  f.policy.publication.expectedChildren = [{ ...f.native.processesBefore[1] }];
  const gaps = Array.from({ length: 215 }, (_, i) => ({
    pid: 2000 + i,
    parentPid: 1,
    name:
      i < 8
        ? [
            'Secure System',
            'Registry',
            'smss.exe',
            'csrss.exe',
            'wininit.exe',
            'csrss.exe',
            'winlogon.exe',
            'services.exe',
          ][i]
        : 'ThirdPartyService.exe',
    executable: '',
    commandLine: '',
    startUtc: '2026-01-01T00:00:00.000Z',
  }));
  f.policy.windowsReferences.operationCoverage.processCoverage = {
    format: 1,
    kind: 'once-related-processes-v1',
    globalDbWriterExclusion: false,
    coverageClaim:
      'related-processes-only;uninspected-background-db-access-unproven',
    backgroundGaps: structuredClone(gaps),
  };
  f.native.processesBefore.push(...structuredClone(gaps));
  f.native.processesAfter.push(...structuredClone(gaps));
  f.native.processCoverage = {
    format: 1,
    port: 4000,
    listenersBefore: [{ port: 4000, pid: 10, address: '127.0.0.1' }],
    listenersAfter: [{ port: 4000, pid: 10, address: '127.0.0.1' }],
  };
  f.changeBackground = (change) => {
    for (const rows of [
      f.native.processesBefore,
      f.native.processesAfter,
      f.policy.windowsReferences.operationCoverage.processCoverage
        .backgroundGaps,
    ])
      change(rows.find((r) => r.pid === 2000));
  };
}
for (const fault of ['none', 'one-microsecond', 'other-pid', 'different-db'])
  test('exact current runtime data argument ' + fault, () =>
    fixture((f) => {
      processFixture(f);
      const db = f.policy.publication.database;
      fs.mkdirSync(path.dirname(db), { recursive: true });
      f.write(db, 'inert data file, never opened as SQLite');
      f.policy.roots.push({ path: path.dirname(db) });
      for (const list of [f.native.processesBefore, f.native.processesAfter]) {
        const r = list.find((x) => x.pid === 10);
        r.commandLine += ' --database ' + quote(db);
        r.startUtc = '2026-01-01T00:00:00.1234560Z';
      }
      f.policy.publication.expected = {
        ...f.native.processesBefore[0],
        port: 4000,
        startUtc: '2026-01-01T00:00:00.1234567Z',
      };
      if (fault === 'one-microsecond')
        f.policy.publication.expected.startUtc = '2026-01-01T00:00:00.1234577Z';
      if (fault === 'other-pid') f.policy.publication.expected.pid = 123;
      if (fault === 'different-db')
        f.policy.publication.expected.commandLine += ' --foreign';
      const r = f.run();
      if (fault === 'none') assert(r.operationSufficient, JSON.stringify(r));
      else assert.equal(r.operationSufficient, false, JSON.stringify(r));
    }),
  );
for (const fault of [
  'none',
  'changed-args',
  'changed-path',
  'changed-bytes',
  'missing-disclosure',
  'default-strict',
  'script',
])
  test('exact empty-cwd Startup binding ' + fault, () =>
    fixture((f) => {
      processFixture(f);
      const startup = f.native.shortcutCoverage.find(
        (x) => x.kind === 'Startup',
      ).path;
      const file = path.join(startup, 'owned-background.lnk');
      f.write(file, 'inert shortcut');
      f.native.shortcutDirectories
        .find((x) => x.path === startup)
        .entries.push({ name: path.basename(file), kind: 'file' });
      const s = {
        path: file,
        sha256: f.pin(file).sha256,
        target: f.worker,
        arguments: '--background',
        workingDirectory: '',
      };
      f.native.shortcuts[0] = s;
      f.policy.windowsReferences.harmlessActions = [
        {
          kind: 'shortcuts',
          argv: [s.target, ...argv(s.arguments)],
          workingDirectory: '',
          shortcut: { ...s },
          uninspectedWorkingDirectory: true,
          backgroundDbAccessExcluded: false,
          executable: f.pin(f.worker),
        },
      ];
      if (fault === 'changed-args') s.arguments += ' --new';
      if (fault === 'changed-path') s.path = f.launcher;
      if (fault === 'changed-bytes') f.write(s.path, 'changed shortcut');
      if (fault === 'missing-disclosure')
        delete f.policy.windowsReferences.harmlessActions[0]
          .uninspectedWorkingDirectory;
      if (fault === 'default-strict')
        delete f.policy.windowsReferences.operationCoverage;
      if (fault === 'script') {
        s.arguments = 'external.js';
        const a = f.policy.windowsReferences.harmlessActions[0];
        a.argv = [s.target, s.arguments];
        a.shortcut = { ...s };
      }
      const r = f.run();
      if (fault === 'none') {
        assert(r.operationSufficient, JSON.stringify(r));
        assert.equal(r.operationCoverage.uninspectedStartupActions.length, 1);
        const scope = require('./release-scope.cjs');
        for (const op of ['install', 'publish', 'rollback'])
          scope.validateReferences(r, f.policy, op);
        const forged = structuredClone(r);
        forged.operationCoverage.uninspectedStartupActions = [];
        assert.throws(
          () => scope.validateReferences(forged, f.policy, 'publish'),
          /STARTUP_ACTION_COVERAGE_INVALID/,
        );
      } else assert.equal(r.operationSufficient, false, JSON.stringify(r));
    }),
  );

test('operation process contract retains 215 exact background gaps without global writer claims', () =>
  fixture((f) => {
    processFixture(f);
    const r = f.run();
    assert.deepEqual(r.errors, []);
    assert.equal(r.operationSufficient, true);
    assert.equal(r.categories.processes, false);
    assert.equal(r.globalReferenceComplete, false);
    const q = r.operationCoverage.processCoverage;
    assert.equal(q.backgroundGaps.length, 215);
    assert.equal(q.globalProcessVisibilityComplete, false);
    assert.equal(q.globalDbWriterExclusion, false);
    assert.equal(q.globalInvocationCoverageComplete, false);
    assert(
      q.backgroundGaps.some(
        (p) => p.name === 'ThirdPartyService.exe' && !p.executable,
      ),
    );
    assert.deepEqual(
      r.records
        .filter((x) => x.kind === 'processes')
        .map((x) => x.pid)
        .sort((a, b) => a - b),
      [10, 11],
    );
    const validate = require('./release-scope.cjs').validateReferences;
    for (const action of ['install', 'publish', 'rollback'])
      assert.equal(typeof validate(r, f.policy, action), 'string');
    assert.throws(() => validate(r, f.policy, 'retire'));
    const forged = structuredClone(r);
    forged.operationCoverage.processCoverage.globalDbWriterExclusion = true;
    assert.throws(() => validate(forged, f.policy, 'install'));
    delete f.policy.windowsReferences.operationCoverage.processCoverage;
    assert(f.run().errors.includes('REFERENCE_PROCESS_VISIBILITY_INCOMPLETE'));
  }));

for (const signal of ['database', 'package', 'port', 'descendant'])
  test(
    'operation process contract never exempts a bound system name with ' +
      signal +
      ' association',
    () =>
      fixture((f) => {
        processFixture(f);
        if (signal === 'database')
          f.changeBackground(
            (p) =>
              (p.commandLine =
                'tool --database ' + quote(f.policy.publication.database)),
          );
        if (signal === 'package')
          f.changeBackground(
            (p) =>
              (p.executable = path.join(f.packages[0].path, 'runtime.exe')),
          );
        if (signal === 'descendant')
          f.changeBackground((p) => (p.parentPid = 11));
        if (signal === 'port')
          for (const k of ['listenersBefore', 'listenersAfter'])
            f.native.processCoverage[k][0].pid = 2000;
        const r = f.run();
        assert.equal(r.operationSufficient, false);
        assert(
          r.errors.includes('REFERENCE_BACKGROUND_BECAME_ASSOCIATED'),
          JSON.stringify(r),
        );
      }),
  );

for (const host of ['mshta.exe', 'rundll32.exe', 'regsvr32.exe'])
  test(
    'operation process contract rejects bound opaque execution host ' + host,
    () =>
      fixture((f) => {
        processFixture(f);
        f.changeBackground((p) => (p.name = host));
        assert(
          f.run().errors.includes('REFERENCE_OPAQUE_INTERPRETER_UNRESOLVED'),
        );
        f.changeBackground((p) => {
          p.name = 'System background';
          p.executable = path.join(f.base, host);
        });
        assert(
          f.run().errors.includes('REFERENCE_OPAQUE_INTERPRETER_UNRESOLVED'),
        );
      }),
  );

for (const fault of [
  'new-unknown',
  'changed-gap',
  'missing-post',
  'missing-port',
  'changed-port',
  'opaque-interpreter',
  'global-switch',
])
  test('operation process contract refuses ' + fault, () =>
    fixture((f) => {
      processFixture(f);
      if (fault === 'new-unknown')
        for (const k of ['processesBefore', 'processesAfter'])
          f.native[k].push({
            ...f.native.processesBefore.find((p) => p.pid === 2000),
            pid: 9000,
          });
      if (fault === 'changed-gap')
        f.native.processesAfter.find((p) => p.pid === 2000).startUtc =
          '2026-01-02T00:00:00.000Z';
      if (fault === 'missing-post') delete f.native.processesAfter;
      if (fault === 'missing-port')
        delete f.native.processCoverage.listenersAfter;
      if (fault === 'changed-port')
        f.native.processCoverage.listenersAfter = [];
      if (fault === 'opaque-interpreter')
        f.changeBackground((p) => (p.name = 'python.exe'));
      if (fault === 'global-switch')
        f.policy.windowsReferences.operationCoverage.processCoverage.allowUnknownProcesses = true;
      const r = f.run();
      assert.equal(r.operationSufficient, false);
      assert(r.errors.length, fault);
    }),
  );

test('operation process contract requires an exact stable binding before skipping an unrelated shell invocation', () =>
  fixture((f) => {
    processFixture(f);
    const row = {
      pid: 9001,
      parentPid: 1,
      name: 'powershell.exe',
      executable: f.controller,
      commandLine:
        quote(f.controller) + ' -Command "uninspected background script.ps1"',
      startUtc: '2026-01-01T00:00:00.000Z',
    };
    f.native.processesBefore.push(structuredClone(row));
    f.native.processesAfter.push(structuredClone(row));
    assert.equal(f.run().operationSufficient, false);
    f.policy.windowsReferences.operationCoverage.processCoverage.backgroundGaps.push(
      row,
    );
    const r = f.run();
    assert.deepEqual(r.errors, []);
    assert.equal(
      r.operationCoverage.processCoverage.backgroundGaps.length,
      216,
    );
    for (const rows of [f.native.processesBefore, f.native.processesAfter])
      rows.find((p) => p.pid === 9001).commandLine +=
        ' ' + quote(f.policy.publication.database);
    assert.equal(f.run().operationSufficient, false);
  }));

test('operation process contract parses only exact approved auxiliaries without weakening descendant visibility', () =>
  fixture((f) => {
    processFixture(f);
    for (const rows of [f.native.processesBefore, f.native.processesAfter])
      rows.find((p) => p.pid === 11).commandLine =
        quote(f.worker) + ' -c "approved codec only"';
    f.policy.publication.expectedChildren[0].commandLine =
      f.native.processesBefore.find((p) => p.pid === 11).commandLine;
    assert.equal(f.run().operationSufficient, true);
    f.native.processesAfter.find((p) => p.pid === 11).executable = '';
    assert.equal(f.run().operationSufficient, false);
  }));

test(
  'native shortcut hashes without optional cmdlet and retains sharing refusal',
  { skip: process.platform !== 'win32' },
  () =>
    fixture((f) => {
      const output = execFileSync(
        path.join(
          process.env.SystemRoot,
          'System32/WindowsPowerShell/v1.0/powershell.exe',
        ),
        [
          '-NoProfile',
          '-NonInteractive',
          '-File',
          path.join(__dirname, 'windows-shortcut-native.fixture.ps1'),
          '-Source',
          path.join(__dirname, 'windows-release-reference-collector.ps1'),
          '-OwnedDirectory',
          f.project,
        ],
        {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 15000,
          maxBuffer: 128 * 1024,
        },
      );
      const r = JSON.parse(output),
        file = path.join(f.project, '\u6D4B-owned.lnk'),
        ascii = path.join(f.project, 'ascii-owned.lnk');
      assert.equal(r.hashCmdletCalls, 0);
      assert.equal(r.normal.sha256, f.pin(ascii).sha256);
      assert.equal(r.normal.path, ascii);
      assert.equal(r.unicodeHash, f.pin(file).sha256);
      assert.equal(
        path.resolve(r.normal.target).toLowerCase(),
        path.join(f.project, 'inert-target.exe').toLowerCase(),
      );
      assert.equal(
        path.resolve(r.normal.workingDirectory).toLowerCase(),
        f.project.toLowerCase(),
      );
      if (r.unicodeRecord?.target) {
        assert.equal(
          path.resolve(r.unicodeRecord.target).toLowerCase(),
          path.join(f.project, 'inert-target.exe').toLowerCase(),
        );
      } else if (r.unicodeRecord) {
        // Legacy WSH may not decode names outside the host ANSI codepage.
        // This is an incomplete required reference, never a harmless shortcut.
        f.native.shortcuts.push(r.unicodeRecord);
        assert(f.run().errors.includes('REFERENCE_SHORTCUT_INVALID'));
      } else {
        assert(r.unicodeFailure?.exceptions.length);
        assert(r.unicodeFailure.stage.startsWith('shortcut-'));
      }
      assert.equal(r.sharingRefused, true);
      assert.equal(r.failureContext.stage, 'shortcut-hash-before');
      assert.equal(r.failureContext.folderKind, 'Startup');
      assert(
        r.failureContext.exceptions.some((e) => e.hresult === '0x80070020'),
      );
      assert(!JSON.stringify(r.failureContext).includes(f.project));
    }),
);

test('operation coverage admits only its explicit call sites and preserves truthful static gaps', () =>
  fixture((f) => {
    operationFixture(f);
    const link = f.addStaticJunction();
    const r = f.run();
    assert.deepEqual(r.errors, []);
    assert.equal(r.complete, false);
    assert.equal(r.globalReferenceComplete, false);
    assert.equal(r.operationSufficient, true);
    assert.equal(r.categories.shortcuts, false);
    assert.equal(r.operationCoverage.uninspectedProfiles.length, 2);
    assert.equal(r.operationCoverage.uninspectedStaticJunctions.length, 0);
    assert.equal(r.operationCoverage.uninspectedStaticScopes.length, 4);
    assert(!JSON.stringify(r).includes(link));
    assert(
      !fs.existsSync(
        f.policy.windowsReferences.operationCoverage.uninspectedProfiles[0]
          .path,
      ),
    );
    const validate = require('./release-scope.cjs').validateReferences;
    for (const action of ['install', 'publish', 'rollback'])
      assert.equal(typeof validate(r, f.policy, action), 'string');
    assert.throws(() => validate(r, f.policy), /OPERATION_COVERAGE/);
    assert.throws(() => validate(r, f.policy, 'retire'), /OPERATION_COVERAGE/);
    assert.throws(
      () =>
        validate(
          { ...r, complete: true, globalReferenceComplete: true },
          f.policy,
          'install',
        ),
      /OPERATION_COVERAGE/,
    );
  }));

for (const fault of ['retire', 'extra-target', 'backup-credit', 'preservation'])
  test('operation coverage refuses broader capability: ' + fault, () =>
    fixture((f) => {
      operationFixture(f);
      if (fault === 'retire') f.policy.approval.operations.push('retire');
      if (fault === 'extra-target') f.policy.pair[0].target += '-other';
      if (fault === 'backup-credit') f.policy.publication.limits.maxBackups = 2;
      if (fault === 'preservation')
        f.policy.windowsReferences.operationCoverage.preserveLegacy = false;
      reject(f, 'REFERENCE_OPERATION_CONTRACT_INVALID');
    }),
  );

for (const processScoped of [false, true])
  test(
    'actual collector excludes a 1403-directory static forest and reaches both dynamic snapshots' +
      (processScoped ? ' with operation process port coverage' : ''),
    { skip: process.platform !== 'win32' },
    () =>
      fixture((f) => {
        operationFixture(f);
        const folders = {},
          staticRoots = [],
          specs = [
            ['Desktop', 1336, 26],
            ['CommonDesktopDirectory', 1, 19],
            ['StartMenu', 34, 45],
            ['CommonStartMenu', 32, 85],
          ];
        for (const [name, dirs, links] of specs) {
          const root = (folders[name] = path.join(f.base, 'static-' + name));
          fs.mkdirSync(root);
          staticRoots.push(root);
          for (let i = 1; i < dirs; i++)
            fs.mkdirSync(path.join(root, 'unrelated-' + i));
          for (let i = 0; i < links; i++)
            f.write(path.join(root, 'unrelated-' + i + '.lnk'), 'never parsed');
        }
        const links = {};
        const explicitEntry = path.join(f.project, 'explicit-start.lnk');
        f.write(explicitEntry, 'inert synthetic shortcut');
        f.policy.windowsReferences.launchers[0].files.push(
          f.pin(explicitEntry),
        );
        links[explicitEntry] = {
          target: f.controller,
          arguments: quote(f.launcher) + ' start',
          workingDirectory: f.project,
        };
        for (const kind of ['Startup', 'CommonStartup']) {
          const at = (folders[kind] = path.join(f.base, kind));
          const file = path.join(at, 'owned-start.lnk');
          links[file] = {
            target: f.controller,
            arguments: quote(f.launcher) + ' start',
            workingDirectory: f.project,
          };
        }
        const processes = structuredClone(f.native.processesBefore);
        while (processes.length < 587)
          processes.push(
            f.process(
              1000 + processes.length,
              1,
              f.controller,
              quote(f.controller),
            ),
          );
        const tasks = Array.from({ length: 226 }, (_, i) => ({
          ...structuredClone(f.native.tasks[0]),
          identity: 'OwnedTask' + i,
        }));
        const policyFile = path.join(f.base, 'collector-policy.json'),
          defaultPolicy = path.join(f.base, 'default-policy.json');
        if (processScoped) {
          f.policy.publication.expected = {
            ...f.native.processesBefore[0],
            port: 4000,
          };
          f.policy.publication.expectedChildren = [
            { ...f.native.processesBefore[1] },
          ];
          f.policy.windowsReferences.operationCoverage.processCoverage = {
            format: 1,
            kind: 'once-related-processes-v1',
            globalDbWriterExclusion: false,
            coverageClaim:
              'related-processes-only;uninspected-background-db-access-unproven',
            backgroundGaps: [],
          };
          f.policy.codePins = {
            'tcp-listeners.ps1': f.pin(
              path.join(__dirname, 'tcp-listeners.ps1'),
            ).sha256,
          };
        }
        f.write(policyFile, f.policy);
        const strict = structuredClone(f.policy);
        delete strict.windowsReferences.operationCoverage;
        f.write(defaultPolicy, strict);
        const fixtureFile = path.join(f.base, 'collector-fixture.json');
        f.write(fixtureFile, {
          root: f.base,
          helperRoot: __dirname,
          folders,
          staticRoots,
          links,
          explicitEntry,
          processes,
          tasks,
          profiles:
            f.policy.windowsReferences.operationCoverage.uninspectedProfiles,
          policy: policyFile,
          defaultPolicy,
          processScoped,
        });
        const output = execFileSync(
          path.join(
            process.env.SystemRoot,
            'System32/WindowsPowerShell/v1.0/powershell.exe',
          ),
          [
            '-NoProfile',
            '-NonInteractive',
            '-File',
            path.join(__dirname, 'windows-operation-collector.fixture.ps1'),
            '-Source',
            path.join(__dirname, 'windows-release-reference-collector.ps1'),
            '-FixtureFile',
            fixtureFile,
          ],
          {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 60000,
            maxBuffer: 8 * 1024 ** 2,
          },
        );
        const report = JSON.parse(output),
          good = report.results.find((r) => r.name === 'success');
        assert.equal(report.results.length, processScoped ? 14 : 13);
        assert.equal(good.operationSufficient, true, JSON.stringify(good));
        assert.equal(good.counts.portQueries, processScoped ? 2 : 0);
        if (processScoped) {
          const denied = report.results.find(
            (r) => r.name === 'denied-operation-port',
          );
          assert.equal(denied.operationSufficient, false);
          assert.equal(denied.failureContext.stage, 'operation-port-before');
          assert(
            denied.failureContext.exceptions.some(
              (e) => e.nativeErrorCode === 5,
            ),
          );
        }
        assert.equal(good.operationSufficient, true, JSON.stringify(good));
        assert.equal(good.complete, false);
        assert.equal(good.globalReferenceComplete, false);
        assert.deepEqual(good.errors, []);
        assert.equal(good.processesAfter, 587);
        assert.equal(good.tasksAfter, 226);
        assert.equal(good.profilesAfter, 2);
        assert.equal(good.counts.processes, 2);
        assert.equal(good.counts.tasks, 2);
        assert.equal(good.counts.profiles, 2);
        assert.equal(good.directoryCount, 2);
        assert.equal(good.shortcutCount, 3);
        assert.deepEqual(good.counts.resolved, ['Startup', 'CommonStartup']);
        assert.deepEqual(good.counts.enumerated, [
          folders.Startup,
          folders.CommonStartup,
        ]);
        assert.equal(good.counts.com, 3);
        assert.equal(good.counts.hashes, 6);
        for (const key of [
          'staticMetadata',
          'staticEnumerations',
          'staticHashes',
          'staticCom',
        ])
          assert.equal(good.counts[key], 0, key);
        const unavailable = report.results.find(
          (r) => r.name === 'get-filehash-unavailable',
        );
        assert.equal(unavailable.operationSufficient, true);
        for (const row of report.results)
          assert.equal(row.counts.hashCmdletCalls, 0);
        assert.equal(good.failureContext, null);
        assert(!JSON.stringify(report).includes('SECRET_FIXTURE'));
        const hashFailure = report.results.find(
          (r) => r.name === 'denied-shortcut-hash',
        );
        assert.equal(hashFailure.failureContext.stage, 'shortcut-hash-before');
        assert.equal(hashFailure.failureContext.folderKind, 'Startup');
        assert(
          hashFailure.failureContext.exceptions.some(
            (e) => e.type === 'System.UnauthorizedAccessException',
          ),
        );
        const comFailure = report.results.find(
          (r) => r.name === 'com-create-failure',
        );
        assert.equal(comFailure.failureContext.stage, 'shortcut-com-create');
        assert(
          comFailure.failureContext.exceptions.some(
            (e) => e.hresult === '0x80070005',
          ),
        );
        const oversize = report.results.find(
          (r) => r.name === 'oversize-shortcut-hash',
        );
        assert(oversize.errors.includes('REFERENCE_NATIVE_SHORTCUT_LIMIT'));
        for (const bad of report.results.filter(
          (r) => !['success', 'get-filehash-unavailable'].includes(r.name),
        )) {
          assert.equal(bad.operationSufficient, false, bad.name);
          assert.equal(bad.complete, false, bad.name);
          assert(bad.errors.length, bad.name);
        }
        const baseline = report.results.find(
          (r) => r.name === 'default-strict',
        );
        assert.equal(baseline.counts.staticEnumerations, 1);
        assert(
          baseline.errors.includes(
            'REFERENCE_NATIVE_UNRELATED_STATIC_TRAVERSAL',
          ),
        );
        const deadline = report.results.find((r) => r.name === 'deadline');
        assert(deadline.errors.includes('REFERENCE_NATIVE_DEADLINE'));
        assert.equal(deadline.processesAfter, 0);
        // Feed actual collector output into the unchanged process/task/launcher/pointer checks.
        f.native = report.native;
        const configSha = f.pin(policyFile).sha256;
        f.write(f.lock, { pid: 99, nonce: 'owned-nonce', configSha });
        f.state.configSha = configSha;
        f.saveState();
        const checked = probe(f.policy, report.native, { callerPid: 99 });
        assert.deepEqual(checked.errors, []);
        assert.equal(checked.operationSufficient, true);
        assert.equal(
          checked.operationCoverage.uninspectedStaticScopes.length,
          4,
        );
        const validate = require('./release-scope.cjs').validateReferences;
        assert.equal(typeof validate(checked, f.policy, 'install'), 'string');
        for (const omitted of ['processesAfter', 'tasksAfter']) {
          const missing = { ...report.native, [omitted]: [] };
          const rejected = probe(f.policy, missing, { callerPid: 99 });
          assert(rejected.errors.length, omitted);
        }
        const missingPinned = {
          ...report.native,
          shortcuts: report.native.shortcuts.filter(
            (s) => s.path !== explicitEntry,
          ),
        };
        assert(
          probe(f.policy, missingPinned, { callerPid: 99 }).errors.includes(
            'REFERENCE_PINNED_SHORTCUT_QUERY_INCOMPLETE',
          ),
        );
        fs.unlinkSync(explicitEntry);
        assert(probe(f.policy, report.native, { callerPid: 99 }).errors.length);
        console.log(
          JSON.stringify({
            fixture: 'actual-collector-static-forest',
            processScoped,
            staticDirectories: 1403,
            staticShortcuts: 175,
            processes: 587,
            tasks: 226,
            staticCalls: 0,
            startupDirectories: good.directoryCount,
            postSnapshots: {
              processes: good.processesAfter,
              tasks: good.tasksAfter,
              profiles: good.profilesAfter,
            },
            cases: report.results.map((r) => ({
              name: r.name,
              operationSufficient: r.operationSufficient,
              errors: r.errors,
            })),
          }),
        );
      }),
  );

for (const fault of [
  'profile-change',
  'denied-process',
  'changed-task',
  'missing-startup',
  'startup-junction',
  'unreported-junction',
  'static-directory-leak',
  'static-shortcut-leak',
  'missing-post-process',
  'missing-post-profile',
  'deadline-exit-zero',
  'changed-launcher',
])
  test('operation coverage keeps necessary failures closed: ' + fault, () =>
    fixture((f) => {
      operationFixture(f);
      if (fault === 'profile-change')
        f.native.operationCoverage.profilesAfter[0].loaded = true;
      if (fault === 'denied-process')
        f.native.errors.push('REFERENCE_NATIVE_QUERY_FAILED');
      if (fault === 'changed-task') f.native.tasksAfter = [];
      if (fault === 'missing-startup') f.native.shortcutCoverage.pop();
      if (fault === 'startup-junction') f.addStaticJunction(true);
      if (fault === 'unreported-junction') {
        f.addStaticJunction(true);
      }
      if (fault === 'static-directory-leak')
        f.native.shortcutDirectories.push({
          path: path.dirname(f.shortcut),
          identity: directoryIdentity(path.dirname(f.shortcut)),
          entries: [],
        });
      if (fault === 'static-shortcut-leak')
        f.native.shortcuts.push({ path: f.shortcut });
      if (fault === 'missing-post-process') f.native.processesAfter = [];
      if (fault === 'missing-post-profile')
        f.native.operationCoverage.profilesAfter = [];
      if (fault === 'deadline-exit-zero')
        f.native.errors = ['REFERENCE_NATIVE_DEADLINE'];
      if (fault === 'changed-launcher')
        f.write(f.launcher, 'changed pinned launcher');
      const r = f.run();
      assert.equal(r.operationSufficient, false);
      assert.equal(r.complete, false);
      assert(r.errors.length, fault);
    }),
  );

test(
  'operation profile classifier uses only supplied metadata and retains default refusal',
  { skip: process.platform !== 'win32' },
  () =>
    fixture((f) => {
      operationFixture(f);
      const input = path.join(f.base, 'profiles.json'),
        script = path.join(f.base, 'classify.ps1');
      f.write(input, f.policy.windowsReferences.operationCoverage);
      f.write(
        script,
        `param($Source,$InputFile)
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'syntax'}
$node=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Profile-Scope'},$true)
. ([scriptblock]::Create($node.Extent.Text))
$scope=Get-Content -LiteralPath $InputFile -Raw | ConvertFrom-Json
$profiles=@($scope.uninspectedProfiles | ForEach-Object { [PSCustomObject]@{SID=$_.sid;LocalPath=$_.path;Special=$false;Loaded=$false;Status=0} })
$rows=@(Profile-Scope $profiles 'current-profile' $scope)
if($rows.Count -ne 2){throw 'missing truthful rows'}
$rejections=0
try {Profile-Scope $profiles 'current-profile' $null;throw 'accepted-default'} catch {if($_.Exception.Message -ne 'REFERENCE_NATIVE_OTHER_PROFILE_REQUIRES_REVIEW'){throw};$rejections++}
$profiles[0].Loaded=$true
try {Profile-Scope $profiles 'current-profile' $scope;throw 'accepted-change'} catch {if($_.Exception.Message -ne 'REFERENCE_NATIVE_PROFILE_SCOPE_CHANGED'){throw};$rejections++}
@{rows=$rows.Count;rejections=$rejections}|ConvertTo-Json -Compress
`,
      );
      const output = execFileSync(
        path.join(
          process.env.SystemRoot,
          'System32/WindowsPowerShell/v1.0/powershell.exe',
        ),
        [
          '-NoProfile',
          '-File',
          script,
          '-Source',
          path.join(__dirname, 'windows-release-reference-collector.ps1'),
          '-InputFile',
          input,
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 15000 },
      );
      assert.deepEqual(JSON.parse(output), { rows: 2, rejections: 2 });
    }),
);
test('real contract emits all six complete categories from pinned synthetic sources', () =>
  fixture((f) => {
    const r = f.run();
    assert.deepEqual(r.errors, []);
    assert(r.complete);
    assert(Object.values(r.categories).every(Boolean));
    assert.deepEqual([...new Set(r.records.map((r) => r.kind))].sort(), [
      'pointers',
      'processes',
      'rollback',
      'shortcuts',
      'tasks',
    ]);
    assert(
      r.records.some(
        (r) =>
          r.pid === 11 &&
          r.packageId === 'current' &&
          /^[a-f0-9]{64}$/.test(r.executableSha256),
      ),
    );
    assert.deepEqual(
      r,
      f.run(),
      'fresh unchanged facts keep a stable reference digest',
    );
  }));
test('Windows quote/backslash parser preserves paths and rejects ambiguous quoting', () => {
  assert.deepEqual(argv('"C:\\A B\\node.exe" "C:\\A B\\run.cjs" start'), [
    'C:\\A B\\node.exe',
    'C:\\A B\\run.cjs',
    'start',
  ]);
  assert.deepEqual(argv('node "" "a\\\"b"'), ['node', '', 'a"b']);
  assert.throws(() => argv('node "unclosed'), /UNBALANCED/);
});
for (const category of ['processes', 'tasks', 'shortcuts'])
  test(`failed ${category} query is never an empty successful category`, () =>
    fixture((f) => {
      f.native.categories[category] = false;
      reject(f, 'REFERENCE_NATIVE_QUERY_INCOMPLETE');
    }));
test('collector errors and missing known-folder coverage refuse admission', () =>
  fixture((f) => {
    f.native.errors.push('access denied');
    reject(f, 'REFERENCE_NATIVE_QUERY_INCOMPLETE');
    f.native.errors = [];
    f.native.shortcutCoverage.pop();
    reject(f, 'REFERENCE_HOST_COVERAGE_INCOMPLETE');
  }));
test('inaccessible unrelated process cannot be assumed harmless', () =>
  fixture((f) => {
    f.native.processesBefore.push({
      pid: 70,
      parentPid: 1,
      executable: null,
      commandLine: null,
    });
    reject(f, 'REFERENCE_PROCESS_VISIBILITY_INCOMPLETE');
  }));
test('PID reuse, stopped child and newly appearing descendants are held', () =>
  fixture((f) => {
    f.native.processesAfter[1].startUtc = '2026-01-02T00:00:00Z';
    reject(f, 'REFERENCE_PROCESS_CHANGED');
    f.native.processesAfter = structuredClone(f.native.processesBefore).filter(
      (p) => p.pid !== 11,
    );
    reject(f, 'REFERENCE_PROCESS_CHANGED');
    f.native.processesAfter = structuredClone(f.native.processesBefore);
    f.native.processesAfter.push(f.process(12, 11, f.worker, quote(f.worker)));
    reject(f, 'REFERENCE_PROCESS_APPEARED');
  }));
test('duplicate PID snapshots and unstable command lines are refused', () =>
  fixture((f) => {
    f.native.processesBefore.push(f.native.processesBefore[0]);
    reject(f, 'REFERENCE_PROCESS_QUERY_INVALID');
    f.native.processesBefore.pop();
    f.native.processesAfter[0].commandLine += ' changed';
    reject(f, 'REFERENCE_PROCESS_CHANGED');
  }));
test('task launcher hash and exact arguments are required', () =>
  fixture((f) => {
    f.native.tasks[0].actions[0].arguments += ' --unexpected';
    f.native.tasksAfter = structuredClone(f.native.tasks);
    reject(f, 'REFERENCE_COMMAND_PATH_UNRESOLVED');
    f.native.tasks[0].actions[0].arguments = quote(f.launcher) + ' start';
    f.native.tasksAfter = structuredClone(f.native.tasks);
    f.write(f.launcher, '// changed');
    reject(f, 'REFERENCE_PIN_CHANGED');
  }));
test('unknown COM handler action cannot be treated as no task reference', () =>
  fixture((f) => {
    f.native.tasks.push({
      identity: '\\Unknown',
      actions: [{ execute: '', arguments: '' }],
    });
    f.native.tasksAfter = structuredClone(f.native.tasks);
    reject(f, 'REFERENCE_TASK_ACTION_UNRESOLVED');
  }));
test('stable process launcher without a queryable cwd needs explicit reviewed cwd independence', () =>
  fixture((f) => {
    const p = f.process(
      12,
      1,
      f.controller,
      `${quote(f.controller)} ${quote(f.launcher)} start`,
    );
    f.native.processesBefore.push(p);
    f.native.processesAfter.push(structuredClone(p));
    assert(f.run().complete);
    f.policy.windowsReferences.launchers[0].cwdIndependent = false;
    reject(f, 'REFERENCE_COMMAND_PATH_UNRESOLVED');
  }));
test('shortcut bytes are independently verified after COM resolution', () =>
  fixture((f) => {
    f.write(f.shortcut, 'replaced shortcut');
    reject(f, 'REFERENCE_SHORTCUT_CHANGED');
  }));
test('unrelated browser shortcut does not claim a release reference', () =>
  fixture((f) => {
    f.native.shortcuts[0].target = f.controller;
    f.native.shortcuts[0].arguments = 'http://127.0.0.1:18080/#/';
    f.native.shortcuts[0].workingDirectory = f.base;
    reject(f, 'REFERENCE_APPLICATION_ACTION_UNREVIEWED');
    f.policy.windowsReferences.harmlessActions = [
      {
        kind: 'shortcuts',
        argv: [f.controller, f.native.shortcuts[0].arguments],
        workingDirectory: f.base,
        executable: f.pin(f.controller),
      },
    ];
    const r = f.run();
    assert(r.complete);
    assert(!r.records.some((r) => r.kind === 'shortcuts'));
  }));
test('fourth rollback package or replaced manifest holds admission', () =>
  fixture((f) => {
    const extra = path.join(f.installed, 'fourth');
    fs.mkdirSync(extra);
    f.write(path.join(extra, 'release.json'), { format: 1, id: 'fourth' });
    f.write(f.rollbackFile, {
      format: 1,
      packages: [{ id: 'fourth', path: extra }],
    });
    f.policy.windowsReferences.rollbackFiles = [f.pin(f.rollbackFile)];
    reject(f, 'REFERENCE_PACKAGE_UNAPPROVED');
  }));
test('missing package coverage and changed active pointers hold admission', () =>
  fixture((f) => {
    f.policy.windowsReferences.packages.pop();
    reject(f, 'REFERENCE_PACKAGE_COVERAGE_INCOMPLETE');
    f.policy.windowsReferences.packages.push(f.packages[2]);
    f.write(f.pointer, { format: 1, id: '../escape' });
    reject(f, 'REFERENCE_POINTER_INVALID');
  }));
test('generic compatibility labels and unbound proof commits are insufficient', () =>
  fixture((f) => {
    f.proof.kind = 'current';
    f.repinProof();
    reject(f, 'REFERENCE_COMPATIBILITY_UNPROVEN');
    f.proof.kind = 'additive-schema-unknown-claim-rollback';
    f.proof.rollback.sourceCommit = 'f'.repeat(40);
    f.repinProof();
    reject(f, 'REFERENCE_COMPATIBILITY_BINDING_INVALID');
  }));
test('business database restoration is never inferred as a compatible rollback', () =>
  fixture((f) => {
    f.proof.businessDatabaseRestored = true;
    f.repinProof();
    reject(f, 'REFERENCE_COMPATIBILITY_UNPROVEN');
  }));
test('foreign controller or build owner blocks', () =>
  fixture((f) => {
    f.write(f.lock, {
      pid: 44,
      nonce: 'foreign',
      configSha: f.native.policySha256,
    });
    reject(f, 'REFERENCE_CONTROLLER_OWNER_UNCERTAIN');
    f.write(f.lock, {
      pid: 99,
      nonce: 'owned',
      configSha: f.native.policySha256,
    });
    f.write(path.join(f.installed, '.build-budget.lock'), {
      pid: 44,
      token: 'foreign',
    });
    reject(f, 'REFERENCE_FOREIGN_BUILD_OWNER');
  }));
test('own durable intent is verified without becoming an external self-reference', () =>
  fixture((f) => {
    const before = f.run();
    f.state.claim = {
      id: 'own',
      root: f.installed,
      outputs: [path.join(f.installed, 'candidate-output')],
    };
    f.state.outputs = [
      { path: f.state.claim.outputs[0], claim: 'own', complete: false },
    ];
    f.saveState();
    const after = f.run();
    assert(after.complete);
    assert.deepEqual(before, after);
    f.state.outputs[0].claim = 'foreign';
    f.saveState();
    reject(f, 'REFERENCE_INFLIGHT_STATE_INVALID');
  }));
test('tampered claim envelopes and unreviewed installed rollback roles hold', () =>
  fixture((f) => {
    f.write(f.ledger, { payload: f.state, digest: '0'.repeat(64) });
    reject(f, 'REFERENCE_INFLIGHT_STATE_CORRUPT');
    f.saveState();
    const payload = { managedIds: ['current', 'fourth'] };
    f.write(path.join(f.installed, '.release-lifecycle.json'), {
      payload,
      digest: hash(payload),
    });
    reject(f, 'REFERENCE_UNREVIEWED_ROLLBACK_ROLE');
  }));
test('source changes during collection are refused', () =>
  fixture((f) => {
    const shortcuts = f.native.shortcuts;
    Object.defineProperty(f.native, 'shortcuts', {
      get() {
        f.write(f.pointer, { format: 1, id: 'candidate' });
        return shortcuts;
      },
    });
    reject(f, 'REFERENCE_SOURCE_CHANGED_DURING_QUERY');
  }));
test('CLI never accepts fixture JSON as authoritative native evidence', () => {
  fixture((f) => {
    const file = path.join(f.base, 'policy.json');
    f.write(file, f.policy);
    const output = execFileSync(
      process.execPath,
      [
        path.join(__dirname, 'windows-release-references.cjs'),
        file,
        '--fixture',
        file,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(JSON.parse(output).complete, false);
  });
});
test('canonical executable and argument aliases still protect their physical package', () =>
  fixture((f) => {
    const alias = path.join(f.base, 'alias');
    fs.symlinkSync(f.packages[0].path, alias, 'junction');
    const p = f.process(
      14,
      1,
      path.join(alias, 'runtime.exe'),
      quote(path.join(alias, 'runtime.exe')),
    );
    f.native.processesBefore.push(p);
    f.native.processesAfter.push(structuredClone(p));
    assert(
      f.run().records.some((r) => r.pid === 14 && r.packageId === 'current'),
    );
  }));
test('a task edit or newly added shortcut cannot disappear into a completed query', () =>
  fixture((f) => {
    f.native.tasksAfter = [];
    reject(f, 'REFERENCE_HOST_COVERAGE_INCOMPLETE');
    f.native.tasksAfter = structuredClone(f.native.tasks);
    f.write(path.join(path.dirname(f.shortcut), 'new.lnk'), 'new inert link');
    reject(f, 'REFERENCE_SHORTCUT_DIRECTORY_CHANGED');
  }));
for (const fault of [
  'none',
  'wrong-parent',
  'wrong-exe',
  'wrong-args',
  'opaque',
  'reused-start',
  'new-after',
  'missing-after',
  'extra-child',
  'grandchild',
  'outside-chain',
])
  test('read-only collector console chain ' + fault, () =>
    fixture((f) => {
      processFixture(f);
      const consoleExe = path.join(f.base, 'conhost.exe');
      f.write(consoleExe, 'owned inert console');
      const self = {
        pid: 200,
        executable: f.controller,
        argv: [f.controller, 'probe.cjs'],
        collectorExecutable: f.worker,
        collectorArgv: [f.worker, 'collector.ps1'],
        consoleExecutable: consoleExe,
        consoleArgv: [consoleExe, '0x4'],
      };
      const own = [
        f.process(200, 99, f.controller, `${quote(f.controller)} probe.cjs`),
        f.process(201, 200, f.worker, `${quote(f.worker)} collector.ps1`),
        {
          ...f.process(202, 201, consoleExe, `${quote(consoleExe)} 0x4`),
          name: 'conhost.exe',
        },
      ];
      if (fault === 'wrong-exe') own[2].executable = f.worker;
      if (fault === 'wrong-args') own[2].commandLine += ' --foreign';
      if (fault === 'opaque') own[2].commandLine = '';
      f.native.processesBefore.push(...own);
      f.native.processesAfter.push(...structuredClone(own));
      if (fault === 'wrong-parent')
        f.native.processesAfter.at(-1).parentPid = 200;
      if (fault === 'reused-start')
        f.native.processesAfter.at(-1).startUtc = '2026-01-02T00:00:00.000Z';
      if (fault === 'new-after') f.native.processesBefore.pop();
      if (fault === 'missing-after') f.native.processesAfter.pop();
      if (fault === 'outside-chain') {
        for (const list of [f.native.processesBefore, f.native.processesAfter])
          list.at(-1).parentPid = 10;
      }
      if (fault === 'extra-child' || fault === 'grandchild') {
        const p = f.process(
          203,
          fault === 'grandchild' ? 202 : 201,
          f.worker,
          quote(f.worker),
        );
        f.native.processesBefore.push(p);
        f.native.processesAfter.push({ ...p });
      }
      const r = probe(f.policy, f.native, { callerPid: 99, self });
      if (fault === 'none') {
        assert(r.operationSufficient, JSON.stringify(r));
        assert.deepEqual(
          r.collectorChain.map((x) => x.pid),
          [200, 201, 202],
        );
        assert(!r.records.some((x) => x.pid === 202));
      } else if (fault === 'outside-chain') {
        assert(r.operationSufficient, JSON.stringify(r));
        assert(r.records.some((x) => x.pid === 202));
        assert(!r.collectorChain.some((x) => x.pid === 202));
      } else assert.equal(r.operationSufficient, false, JSON.stringify(r));
    }),
  );
test('collector chain refusal retains bounded private rows and a safe exact branch through the full parser', () =>
  fixture((f) => {
    processFixture(f);
    const self = {
      pid: 200,
      executable: f.controller,
      argv: [f.controller, 'probe.cjs'],
      collectorExecutable: f.worker,
      collectorArgv: [f.worker, 'collector.ps1'],
    };
    const own = [
      f.process(200, 99, f.controller, `${quote(f.controller)} probe.cjs`),
      f.process(201, 200, f.worker, `${quote(f.worker)} wrong.ps1`),
    ];
    f.native.processesBefore.push(...own);
    f.native.processesAfter.push(...structuredClone(own));
    const result = probe(f.policy, f.native, { callerPid: 99, self });
    assert.equal(result.referenceDiagnostic.stage, 'collector-chain');
    assert.equal(
      result.referenceDiagnostic.chainBranch,
      'collector-candidate-count',
    );
    assert.deepEqual(result.privateReferenceDiagnostic.before, own);
    let error;
    try {
      require('./release-scope.cjs').validateReferences(
        result,
        f.policy,
        'install',
      );
    } catch (e) {
      error = e;
    }
    assert.deepEqual(
      error.privateReferenceDiagnostic,
      result.privateReferenceDiagnostic,
    );
    const output = require('./once-pair-admission.cjs').formatCliError(error);
    assert(output.includes('collector-candidate-count'));
    assert(!output.includes(f.base));
  }));
test('only the exact transient probe and its pinned collector are excluded from controller children', () =>
  fixture((f) => {
    const self = {
      pid: 200,
      executable: f.controller,
      argv: [f.controller, 'probe.cjs'],
      collectorExecutable: f.worker,
      collectorArgv: [f.worker, 'collector.ps1'],
    };
    const own = [
      f.process(200, 99, f.controller, `${quote(f.controller)} probe.cjs`),
      f.process(201, 200, f.worker, `${quote(f.worker)} collector.ps1`),
    ];
    f.native.processesBefore.push(...own);
    f.native.processesAfter.push(...structuredClone(own));
    const first = probe(f.policy, f.native, { callerPid: 99, self });
    assert(first.complete);
    assert(!first.records.some((r) => [200, 201].includes(r.pid)));
    const foreign = f.process(202, 201, f.worker, quote(f.worker));
    f.native.processesBefore.push(foreign);
    f.native.processesAfter.push(structuredClone(foreign));
    const held = probe(f.policy, f.native, { callerPid: 99, self });
    assert(
      held.errors.some((e) =>
        [
          'REFERENCE_PROBE_CHILD_UNCERTAIN',
          'REFERENCE_PROBE_CONSOLE_UNCERTAIN',
        ].includes(e),
      ),
    );
  }));
test('adapter facts are accepted by the actual scope guard across own intent changes', () =>
  fixture((f) => {
    const scope = require('./release-scope.cjs');
    fs.unlinkSync(f.lock);
    fs.unlinkSync(f.ledger);
    Object.assign(f.policy, scope.inspect([f.installed]), {
      registryIdentity: scope.inspect([f.registry]).roots[0].identity,
      maxBytes: scope.DEFAULT_BYTES,
      maxGrowthBytes: 1024,
      maxNewRuntimeCopies: 0,
    });
    const policyFile = path.join(f.registry, 'policy.json');
    f.write(policyFile, f.policy);
    const configSha = f.pin(policyFile).sha256;
    f.native.policySha256 = configSha;
    for (const list of [f.native.processesBefore, f.native.processesAfter])
      list.find((p) => p.pid === 99).pid = process.pid;
    const lease = scope.open(
      { kind: 'switch', root: f.installed, reserveBytes: 128 },
      {
        configPath: policyFile,
        configSha256: configSha,
        query: () => probe(f.policy, f.native, { callerPid: process.pid }),
      },
    );
    lease.check();
    f.write(f.pointer, { format: 1, id: 'candidate' });
    lease.check(true);
    lease.close(undefined, { transition: true });
    assert(!fs.existsSync(f.lock));
  }));
test('encoded shell actions are unresolved even if they hide the root text', () =>
  fixture((f) => {
    const action = {
      execute: 'powershell.exe',
      arguments: '-EncodedCommand aQBuAGUAcgB0AA==',
      workingDirectory: f.base,
    };
    f.native.tasks.push({ identity: 'encoded', actions: [action] });
    f.native.tasksAfter = structuredClone(f.native.tasks);
    reject(f, 'REFERENCE_SHELL_COMMAND_UNRESOLVED');
  }));
function hiddenFourth(f, extension) {
  const fourth = path.join(f.installed, 'fourth');
  fs.mkdirSync(fourth);
  f.write(path.join(fourth, 'release.json'), {
    format: 1,
    id: 'fourth',
    sourceCommit: '4'.repeat(40),
  });
  const target = path.join(fourth, 'runtime.exe');
  f.write(target, 'inert fourth runtime');
  const outside = path.join(f.base, 'unreviewed');
  fs.mkdirSync(outside);
  const script = path.join(outside, 'launch.' + extension);
  f.write(
    script,
    extension === 'ps1'
      ? `& '${target}'`
      : `CreateObject("WScript.Shell").Run "${target}"`,
  );
  return { script, target };
}
for (const kind of ['tasks', 'shortcuts', 'processes']) {
  for (const [host, extension, prefix] of [
    ['powershell.exe', 'ps1', '-NoProfile -File '],
    ['wscript.exe', 'vbs', ''],
    ['cscript.exe', 'vbs', ''],
    ['renamed-host.exe', 'cmd', ''],
  ]) {
    test(`R1: ${kind} cannot hide a fourth package through ${host}`, () =>
      fixture((f) => {
        const { script } = hiddenFourth(f, extension),
          exe = path.join(f.base, host);
        f.write(exe, 'inert unreviewed host');
        const args = prefix + quote(script);
        if (kind === 'tasks') {
          f.native.tasks.push({
            identity: 'HiddenFourth',
            actions: [
              { execute: exe, arguments: args, workingDirectory: f.base },
            ],
          });
          f.native.tasksAfter = structuredClone(f.native.tasks);
        }
        if (kind === 'shortcuts')
          Object.assign(f.native.shortcuts[0], {
            target: exe,
            arguments: args,
            workingDirectory: f.base,
          });
        if (kind === 'processes') {
          const p = f.process(50, 1, exe, quote(exe) + ' ' + args);
          f.native.processesBefore.push(p);
          f.native.processesAfter.push(structuredClone(p));
        }
        reject(f, 'REFERENCE_INDIRECT_LAUNCHER_UNREVIEWED');
      }));
  }
}
test('R1 control: a direct fourth-package task is still refused', () =>
  fixture((f) => {
    const { target } = hiddenFourth(f, 'ps1');
    f.native.tasks.push({
      identity: 'DirectFourth',
      actions: [
        {
          execute: target,
          arguments: '',
          workingDirectory: path.dirname(target),
        },
      ],
    });
    f.native.tasksAfter = structuredClone(f.native.tasks);
    reject(f, 'REFERENCE_PACKAGE_UNAPPROVED');
  }));
test('R1 control: an exact pinned reviewed PowerShell launcher may trace the active pointer', () =>
  fixture((f) => {
    const exe = path.join(f.base, 'powershell.exe');
    f.write(exe, 'inert host');
    const folder = path.join(f.project, 'reviewed');
    fs.mkdirSync(folder);
    const script = path.join(folder, 'launch.ps1');
    f.write(script, '# reviewed inert entry');
    f.policy.windowsReferences.launchers.push({
      entry: script,
      argv: [exe, '-NoProfile', '-File', script],
      workingDirectory: f.base,
      executable: f.pin(exe),
      files: [f.pin(script)],
      pointerPath: f.pointer,
    });
    f.native.tasks.push({
      identity: 'Reviewed',
      actions: [
        {
          execute: exe,
          arguments: '-NoProfile -File ' + quote(script),
          workingDirectory: f.base,
        },
      ],
    });
    f.native.tasksAfter = structuredClone(f.native.tasks);
    assert(f.run().complete);
  }));
function absentStartup(f) {
  const ancestor = path.join(f.base, 'absent-parent');
  fs.mkdirSync(ancestor);
  const missing = path.join(ancestor, 'Startup');
  Object.assign(
    f.native.shortcutCoverage.find((c) => c.kind === 'CommonStartup'),
    {
      status: 'absent',
      path: missing,
      identity: undefined,
      ancestor: { path: ancestor, identity: directoryIdentity(ancestor) },
    },
  );
  return { ancestor, missing };
}
test('R2 control: a proven absent known folder remains a valid covered absence', () =>
  fixture((f) => {
    absentStartup(f);
    assert(f.run().complete);
  }));
test('R2: absent CommonStartup that appeared before resolution is refused', () =>
  fixture((f) => {
    const { missing } = absentStartup(f);
    fs.mkdirSync(missing);
    f.write(path.join(missing, 'new.lnk'), 'inert link');
    reject(f, 'REFERENCE_SHORTCUT_ABSENT_DIRECTORY_APPEARED');
  }));
test('R2: missing folder appearance after its initial check is revalidated before publication', () =>
  fixture((f) => {
    const { missing } = absentStartup(f),
      dir = f.native.shortcutDirectories[0],
      entries = dir.entries;
    let changed = false;
    Object.defineProperty(dir, 'entries', {
      get() {
        if (!changed) {
          changed = true;
          fs.mkdirSync(missing);
          f.write(path.join(missing, 'new.lnk'), 'inert link');
        }
        return entries;
      },
    });
    reject(f, 'REFERENCE_SHORTCUT_ABSENT_DIRECTORY_APPEARED');
  }));
test('R2: coverage path and identity must bind an actual enumerated directory', () =>
  fixture((f) => {
    f.native.shortcutCoverage[0].path = f.base;
    reject(f, 'REFERENCE_HOST_COVERAGE_INCOMPLETE');
  }));
function replaceOwnedDirectory(f, at) {
  const saved = at + '-previous';
  assert(insideFixture(f, at) && insideFixture(f, saved));
  fs.renameSync(at, saved);
  fs.mkdirSync(at);
  for (const entry of fs.readdirSync(saved)) {
    const source = path.join(saved, entry);
    assert(fs.lstatSync(source).isFile());
    fs.copyFileSync(source, path.join(at, entry));
  }
}
function insideFixture(f, at) {
  return path.resolve(at).startsWith(path.resolve(f.base) + path.sep);
}
test('R2: directory replacement with identical names and shortcut bytes is refused', () =>
  fixture((f) => {
    replaceOwnedDirectory(f, path.dirname(f.shortcut));
    reject(f, 'REFERENCE_SHORTCUT_DIRECTORY_IDENTITY_CHANGED');
  }));
test('R2: late directory replacement after inventory check is refused', () =>
  fixture((f) => {
    const s = f.native.shortcuts[0],
      target = s.target;
    let changed = false;
    Object.defineProperty(s, 'target', {
      get() {
        if (!changed) {
          changed = true;
          replaceOwnedDirectory(f, path.dirname(f.shortcut));
        }
        return target;
      },
    });
    reject(f, 'REFERENCE_SHORTCUT_DIRECTORY_IDENTITY_CHANGED');
  }));
test('R2: replaced absence ancestor cannot certify the still-missing child', () =>
  fixture((f) => {
    const { ancestor } = absentStartup(f),
      dir = f.native.shortcutDirectories[0],
      entries = dir.entries;
    let changed = false;
    Object.defineProperty(dir, 'entries', {
      get() {
        if (!changed) {
          changed = true;
          replaceOwnedDirectory(f, ancestor);
        }
        return entries;
      },
    });
    reject(f, 'REFERENCE_SHORTCUT_DIRECTORY_IDENTITY_CHANGED');
  }));
for (const mode of ['bytes', 'same-bytes-replaced-identity'])
  test(`R3: late launcher executable change (${mode}) is refused`, () =>
    fixture((f) => {
      const dirs = f.native.shortcutDirectories;
      let changed = false;
      Object.defineProperty(f.native, 'shortcutDirectories', {
        get() {
          if (!changed) {
            changed = true;
            if (mode === 'bytes')
              f.write(f.controller, 'changed late executable');
            else {
              const replacement = path.join(f.base, 'replacement.exe');
              fs.copyFileSync(f.controller, replacement);
              assert(
                insideFixture(f, replacement) && insideFixture(f, f.controller),
              );
              fs.renameSync(replacement, f.controller);
            }
          }
          return dirs;
        },
      });
      reject(f, 'REFERENCE_SOURCE_CHANGED_DURING_QUERY');
    }));
test('R3: executable watch retains its larger read bound at final verification', () =>
  fixture((f) => {
    fs.writeFileSync(f.controller, Buffer.alloc(8 * 1024 ** 2 + 1));
    f.policy.windowsReferences.launchers[0].executable = f.pin(f.controller);
    assert(f.run().complete);
  }));
if (process.platform === 'win32')
  test('actual task collector retains explicit COM metadata and stable bounded identity digests', () => {
    const r = JSON.parse(
      execFileSync(
        path.join(
          process.env.SystemRoot,
          'System32/WindowsPowerShell/v1.0/powershell.exe',
        ),
        [
          '-NoProfile',
          '-NonInteractive',
          '-File',
          path.join(__dirname, 'windows-task-metadata.fixture.ps1'),
          '-Source',
          path.join(__dirname, 'windows-release-reference-collector.ps1'),
        ],
        {
          windowsHide: true,
          encoding: 'utf8',
          timeout: 20000,
          maxBuffer: 128 * 1024,
        },
      ),
    );
    const first = r.first[0],
      com = first.actions[0];
    assert.equal(com.actionType, 'com-handler');
    assert.equal(com.cimClass, 'MSFT_TaskComHandlerAction');
    assert.equal(com.execute, '');
    assert(com.classId);
    assert.equal(com.id, 'owned-com');
    assert.equal(com.data, 'original input');
    assert.match(com.identitySha256, /^[a-f0-9]{64}$/);
    assert.equal(first.actions[1].actionType, 'exec');
    assert.notEqual(com.identitySha256, r.data[0].actions[0].identitySha256);
    assert.notEqual(first.actionsSha256, r.data[0].actionsSha256);
    assert.notEqual(r.data[0].actionsSha256, r.class[0].actionsSha256);
    assert(r.oversizeRefused);
    assert.equal(r.nativeQueries, 0);
  });
if (process.platform === 'win32')
  test('R2 native helper identity matches Node on an owned fixture and proves absence', () =>
    fixture((f) => {
      const helper = path.join(
        __dirname,
        'windows-reference-directory-identity.cs',
      );
      const literal = (s) => "'" + s.replaceAll("'", "''") + "'";
      const code = `Add-Type -LiteralPath ${literal(helper)}; $proof=[WeWeReferenceDirectoryIdentity]::Read(${literal(path.dirname(f.shortcut))}); if ($null -ne [WeWeReferenceDirectoryIdentity]::Read(${literal(path.join(f.base, 'missing'))})) {throw 'absence failed'}; $proof | ConvertTo-Json -Compress`;
      const output = execFileSync(
        path.join(
          process.env.SystemRoot,
          'System32/WindowsPowerShell/v1.0/powershell.exe',
        ),
        ['-NoProfile', '-NonInteractive', '-Command', code],
        {
          windowsHide: true,
          encoding: 'utf8',
          timeout: 15000,
          maxBuffer: 128 * 1024,
        },
      );
      const proof = JSON.parse(output);
      assert.deepEqual(
        [proof.dev, proof.ino, proof.birthtimeNs],
        directoryIdentity(path.dirname(f.shortcut)),
      );
    }));
