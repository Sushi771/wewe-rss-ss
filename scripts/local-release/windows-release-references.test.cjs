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
  const base = fs.realpathSync.native(fs.mkdtempSync(
    path.join(os.tmpdir(), 'wewe-reference-adapter-'),
  ));
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
      path.dirname(base) === fs.realpathSync.native(os.tmpdir()) &&
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
test('preserving build records shortcuts as not applicable without asserting complete coverage', () =>
  fixture((f) => {
    f.policy.phase = 'build-only';
    f.policy.preservingUpdate = { format: 1, operation: 'build', effects: ['new-output-only'] };
    f.native.format = 2; f.native.complete = false; f.native.observationComplete = true;
    f.native.categories.shortcuts = 'not_applicable'; f.native.categories.tasks = 'not_applicable';
    f.native.shortcuts = []; f.native.shortcutCoverage = []; f.native.shortcutDirectories = [];
    const result = f.run();
    assert.deepEqual(result.errors, []);
    assert.equal(result.complete, false);
    assert.equal(result.observationComplete, true);
    assert.equal(result.categories.shortcuts, 'not_applicable');
    assert.equal(result.categories.processes, true);
    assert.equal(result.categories.tasks, 'not_applicable');
  }));
test('preserving observation rejects changed process and incomplete task evidence', () =>
  fixture((f) => {
    f.policy.phase = 'build-only';
    f.policy.preservingUpdate = { format: 1, operation: 'build', effects: ['new-output-only'] };
    f.native.format = 2; f.native.complete = false; f.native.observationComplete = true;
    f.native.categories.shortcuts = 'not_applicable'; f.native.categories.tasks = 'not_applicable';
    f.native.shortcuts = []; f.native.shortcutCoverage = []; f.native.shortcutDirectories = [];
    f.native.processesAfter[0].startUtc = '2026-02-01T00:00:00.000Z';
    assert.equal(f.run().observationComplete, undefined);
    f.native.processesAfter = structuredClone(f.native.processesBefore);
    f.native.categories.tasks = true;
    assert.equal(f.run().observationComplete, undefined);
  }));
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
    assert(held.errors.includes('REFERENCE_PROBE_CHILD_UNCERTAIN'));
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

test('build-only probe retains real reference coverage without claiming pair compatibility', () =>
  fixture((f) => {
    f.policy.phase = 'build-only';
    delete f.policy.compatibilityProofSha256;
    delete f.policy.windowsReferences.compatibilityProof;
    const result = f.run();
    assert.equal(result.complete, true);
    assert.deepEqual(result.compatibility, {
      stage: 'build-only',
      verified: false,
    });
    assert(result.records.some((r) => r.kind === 'processes'));
    f.native.categories.tasks = false;
    assert.equal(f.run().complete, false);
  }));

test('preserving build never reads inapplicable malformed task or launcher data', () =>
  fixture((f) => {
    f.policy.phase = 'build-only';
    f.policy.preservingUpdate = { format: 1, operation: 'build', effects: ['new-output-only'] };
    f.native.format = 2; f.native.complete = false; f.native.observationComplete = true;
    f.native.categories.tasks = f.native.categories.shortcuts = 'not_applicable';
    let taskQueries=0, launcherReads=0;
    for (const key of ['tasks','tasksAfter','shortcuts','shortcutCoverage','shortcutDirectories'])
      Object.defineProperty(f.native,key,{get(){taskQueries++;throw Error('inapplicable native query');}});
    Object.defineProperty(f.policy.windowsReferences,'launchers',{get(){launcherReads++;throw Error('inapplicable launcher read');}});
    const result=f.run(); assert.deepEqual(result.errors,[]);
    assert.equal(result.observationComplete,true); assert.equal(result.complete,false);
    assert.equal(result.categories.tasks,'not_applicable');
    assert.equal(taskQueries,0);assert.equal(launcherReads,0);
    assert(result.records.some(r=>r.kind==='processes'));
    assert(!result.records.some(r=>['tasks','shortcuts'].includes(r.kind)));
    f.state.claim={id:'foreign',root:f.installed,outputs:[f.packages[1].path]};f.saveState();
    assert.equal(f.run().observationComplete,undefined);
  }));
test('preserving invalid build effects reject before any native observation', () =>
  fixture((f) => {
    f.policy.phase='build-only';
    f.policy.preservingUpdate={format:1,operation:'build',effects:['new-output-only','approved-active-switch']};
    let reads=0;Object.defineProperty(f.native,'categories',{get(){reads++;throw Error('native should not be touched');}});
    assert.equal(f.run().observationComplete,undefined);assert.equal(reads,0);
  }));

test('preserving restart and original mode do not accept build task exemptions', () =>
  fixture((f) => {
    f.native.categories.tasks = 'not_applicable';
    assert.equal(f.run().complete, false);
    f.policy.preservingUpdate = { format: 1, operation: 'restart', effects: ['new-output-only','approved-active-switch'], active: {
      pointer: f.pointer, currentId: 'current', candidateId: 'candidate',
      pointerSha256: f.pin(f.pointer).sha256,
      currentManifestSha256: f.pin(path.join(f.packages[0].path,'release.json')).sha256,
      candidateManifestSha256: f.pin(path.join(f.packages[1].path,'release.json')).sha256,
      oldProcess: { pid: 10, startUtc: f.native.processesBefore[0].startUtc,
        executableSha256: f.pin(path.join(f.packages[0].path,'runtime.exe')).sha256 },
    } };
    f.native.format=2;f.native.complete=false;f.native.observationComplete=true;
    f.native.categories.shortcuts='not_applicable';
    assert.equal(f.run().observationComplete, undefined);
    f.native.categories.tasks=true;
    const r=f.run();assert.deepEqual(r.errors,[]);assert.equal(r.observationComplete,true);
    assert.equal(r.categories.tasks,true);assert(r.records.some(x=>x.kind==='tasks'));
  }));

function buildControlFixture(f){
 const fresh=path.join(f.base,'fresh');fs.mkdirSync(fresh);const st=fs.lstatSync(f.pointer,{bigint:true});
 f.policy.format=2;f.policy.phase='build-only';f.policy.roots=[{path:fresh}];f.policy.buildOnly={outputRoot:fresh};
 f.policy.preservingUpdate={format:1,operation:'build',effects:['new-output-only'],rootRoles:{format:1,readOnlyRoots:[{path:f.installed,identity:directoryIdentity(f.installed)}],controls:[{...f.pin(f.pointer),identity:[st.dev,st.ino,st.birthtimeNs].map(String)}]}};
 f.native.format=2;f.native.complete=false;f.native.observationComplete=true;f.native.categories.tasks=f.native.categories.shortcuts='not_applicable';
 const self={pid:200,executable:f.controller,argv:[f.controller,'probe.cjs'],collectorExecutable:f.worker,collectorArgv:[f.worker,'collector.ps1']};
 const own=[f.process(200,99,f.controller,`${quote(f.controller)} probe.cjs`),f.process(201,200,f.worker,`${quote(f.worker)} collector.ps1`)];
 f.native.processesBefore.push(...own);f.native.processesAfter.push(...structuredClone(own));
 return {fresh,self,run:()=>probe(f.policy,f.native,{callerPid:99,self})};
}
test('preserving split build observes bound controls without claiming global process coverage',()=>fixture(f=>{
 const c=buildControlFixture(f),r=c.run();assert.deepEqual(r.errors,[]);assert.equal(r.observationComplete,true);assert.equal(r.complete,false);assert.equal(r.processObservation,'build-control-only');assert.equal(r.categories.inflight,true);assert.equal(r.categories.tasks,'not_applicable');assert.equal(r.categories.shortcuts,'not_applicable');assert(!r.records.some(x=>x.kind==='processes'));
 f.write(f.pointer,{format:1,id:'rollback'});assert.equal(c.run().observationComplete,undefined);
}));
test('preserving build control accepts out-of-scope unknown rows and shells; original mode refuses',()=>fixture(f=>{
 const incomplete={pid:300,parentPid:1,name:'synthetic',executable:'',commandLine:'',startUtc:null};f.native.processesBefore.push(incomplete);f.native.processesAfter.push(structuredClone(incomplete));assert(f.run().errors.includes('REFERENCE_PROCESS_VISIBILITY_INCOMPLETE'));
 const c=buildControlFixture(f),shell=f.process(301,1,f.worker,`${quote(f.worker)} -Command synthetic`);f.native.processesBefore.push(shell);f.native.processesAfter.push(structuredClone(shell));assert.deepEqual(c.run().errors,[]);
}));
for(const kind of ['caller-missing','probe-missing','collector-missing','caller-changed','probe-changed','collector-changed','child','late-child','pid-duplicate','parent-invalid','output-before','output-after','native-error','control-pin','ledger'])test('preserving build control rejects '+kind,()=>fixture(f=>{
 const c=buildControlFixture(f),before=f.native.processesBefore,after=f.native.processesAfter,ids={caller:99,probe:200,collector:201};
 if(kind.endsWith('-missing'))before.find(p=>p.pid===ids[kind.split('-')[0]]).commandLine='';
 if(kind.endsWith('-changed'))after.find(p=>p.pid===ids[kind.split('-')[0]]).startUtc='2026-02-01T00:00:00Z';
 if(kind==='child'||kind==='late-child'){const p=f.process(202,201,f.worker,quote(f.worker));after.push(p);if(kind==='child')before.push(structuredClone(p));}
 if(kind==='pid-duplicate')before.push(structuredClone(before[0]));if(kind==='parent-invalid')before[0].parentPid='bad';
 if(kind==='output-before'||kind==='output-after')(kind==='output-before'?before:after).push(f.process(302,1,f.worker,`${quote(f.worker)} ${quote(c.fresh)}`));
 if(kind==='native-error')f.native.errors.push('REFERENCE_NATIVE_QUERY_FAILED');if(kind==='control-pin')fs.appendFileSync(f.pointer,'changed');if(kind==='ledger'){f.state.configSha='b'.repeat(64);f.saveState();}
 const result=c.run();assert.notEqual(result.observationComplete,true);assert(result.errors.length);assert.equal(result.complete,false);if(kind.startsWith('output-'))assert(result.errors.includes('REFERENCE_PROCESS_APPEARED'));
}));

if (process.platform === 'win32')
  test('preserving collector build uses synthetic processes without invoking task or shortcut queries', () =>
    fixture((f) => {
      const policyFile=path.join(f.base,'build-policy.json');
      f.write(policyFile,{phase:'build-only',preservingUpdate:{format:1,operation:'build',effects:['new-output-only']}});
      const literal=s=>"'"+s.replaceAll("'","''")+"'";
      const harness=path.join(f.base,'collector-harness.ps1');
      f.write(harness,`$ErrorActionPreference='Stop'
$script:taskCalls=0
function Get-CimInstance { [CmdletBinding()]param([string]$ClassName)
  if($ClassName -ne 'Win32_Process'){throw 'SYNTHETIC_UNEXPECTED_CLASS'}
  [pscustomobject]@{ProcessId=101;ParentProcessId=1;Name='synthetic.exe';ExecutablePath='C:\\synthetic.exe';CommandLine='synthetic';CreationDate=[datetime]'2026-01-01T00:00:00Z'}
}
function Get-ScheduledTask { [CmdletBinding()]param();$script:taskCalls++;throw 'SYNTHETIC_TASK_QUERY_FORBIDDEN' }
$raw=(& { . ${literal(path.join(__dirname,'windows-release-reference-collector.ps1'))} -PolicyFile ${literal(policyFile)} } | Out-String)
[pscustomobject]@{native=($raw | ConvertFrom-Json);taskCalls=$script:taskCalls} | ConvertTo-Json -Depth 10 -Compress
`);
      const output=execFileSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile','-NonInteractive','-File',harness],{windowsHide:true,encoding:'utf8',timeout:20000,maxBuffer:128*1024});
      const r=JSON.parse(output.replace(/^\uFEFF/,''));
      assert.equal(r.taskCalls,0);assert.equal(r.native.complete,false);
      assert.equal(r.native.observationComplete,true);assert.deepEqual(r.native.errors,[]);
      assert.equal(r.native.categories.tasks,'not_applicable');assert.equal(r.native.categories.shortcuts,'not_applicable');
      assert.equal(r.native.categories.processes,true);assert.equal(r.native.processesBefore.length,1);
    }));

function consoleFixture(f){
 const c=buildControlFixture(f),folder=path.join(f.base,'synthetic-system32');fs.mkdirSync(folder);const exe=path.join(folder,'conhost.exe');fs.writeFileSync(exe,'inert pinned system host fixture');const st=fs.lstatSync(exe,{bigint:true});
 c.self.consoleHost={...f.pin(exe),identity:[st.dev,st.ino,st.size,st.birthtimeNs,st.mtimeNs,st.ctimeNs].map(String)};
 const hosts=[f.process(202,200,exe,`\\??\\${exe} 0x1234`),f.process(203,201,exe,`\\??\\${exe} 0x5678`)];
 f.native.processesBefore.push(...hosts);f.native.processesAfter.push(...structuredClone(hosts));return {...c,exe,hosts};
}
test('console control accepts two proven system hosts without claiming global complete',()=>fixture(f=>{
 const c=consoleFixture(f),r=c.run();assert.deepEqual(r.errors,[]);assert.equal(r.observationComplete,true);assert.equal(r.complete,false);assert.equal(r.processObservation,'build-control-only');assert.equal(r.categories.inflight,true);assert(!r.records.some(r=>r.kind==='processes'));
}));
for(const mode of ['wrong-path','bad-pin','unknown-argument','extra-argument','extra-child','extra-host','changed-start','changed-parent','missing-field','output-reference','wrong-argv-path','missing-pin','changed-file','full-mode'])test('console control refuses '+mode,()=>fixture(f=>{
 const c=consoleFixture(f),p=f.native.processesBefore.find(p=>p.pid===202),q=f.native.processesAfter.find(p=>p.pid===202);
 if(mode==='wrong-path')p.executable=f.worker;
 if(mode==='bad-pin')c.self.consoleHost.sha256='0'.repeat(64);
 if(mode==='unknown-argument')p.commandLine=q.commandLine=`\\??\\${c.exe} -ForceV1`;
 if(mode==='extra-argument')p.commandLine=q.commandLine+= ' --headless';
 if(mode==='extra-child'){const child=f.process(204,202,f.worker,quote(f.worker));f.native.processesBefore.push(child);f.native.processesAfter.push(structuredClone(child));}
 if(mode==='extra-host'){const child=f.process(204,200,c.exe,p.commandLine);f.native.processesBefore.push(child);f.native.processesAfter.push(structuredClone(child));}
 if(mode==='changed-start')q.startUtc='2026-02-01T00:00:00Z';
 if(mode==='changed-parent')q.parentPid=201;
 if(mode==='missing-field')q.commandLine='';
 if(mode==='output-reference')p.workingDirectory=q.workingDirectory=c.fresh;
 if(mode==='wrong-argv-path')p.commandLine=q.commandLine=`\\??\\${f.worker} 0x1234`;
 if(mode==='missing-pin')delete c.self.consoleHost;
 if(mode==='changed-file')fs.appendFileSync(c.exe,'changed');
 if(mode==='full-mode'){delete f.policy.preservingUpdate;f.native.format=1;f.native.complete=true;f.native.categories.tasks=f.native.categories.shortcuts=true;}
 const r=c.run();assert.notEqual(r.observationComplete,true);assert(r.errors.length);assert.equal(r.complete,false);
}));
