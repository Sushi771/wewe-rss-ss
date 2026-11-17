'use strict';
// All identities, evidence and executables here are freshly created synthetic
// fixture bytes. They are not historical receipts or production authorization.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  prepareMaintenanceBinding,
} = require('./prepare-maintenance-binding.cjs');
const { createMaintenanceEntry } = require('./maintenance-entry.cjs');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
  return { path: file, sha256: hash(fs.readFileSync(file)) };
};

async function fixture(run) {
  const temp = fs.realpathSync.native(os.tmpdir());
  const root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(temp, 'maintenance-binding-fixture-')),
  );
  const projectRoot = path.join(root, 'project'),
    controlRoot = path.join(root, 'review-control');
  const releasesRoot = path.join(projectRoot, '.local-releases');
  const database = path.join(projectRoot, 'apps/server/data/wewe-rss.db');
  const backupDataRoot = path.join(root, 'backups');
  fs.mkdirSync(controlRoot);
  fs.mkdirSync(backupDataRoot);
  write(database, 'synthetic database never opened');
  const roles = {};
  for (const [role, id, commit] of [
    ['current', 'fixture-old', 'a'],
    ['candidate', 'fixture-new', 'b'],
  ]) {
    const folder = path.join(releasesRoot, id),
      files = {};
    for (const [name, content] of Object.entries({
      'runtime/node.exe': 'never executed',
      'runtime.cjs': 'never required',
      'server/prisma/schema.prisma': 'synthetic schema',
      'engine.node': 'never loaded',
    }))
      files[name] = write(path.join(folder, name), content).sha256;
    const manifest = {
      format: 1,
      id,
      platform: process.platform,
      arch: process.arch,
      sourceCommit: commit.repeat(40),
      sourceHash: commit.repeat(64),
      schemaCompatibility: 'current',
      desktopHelperIncluded: false,
      files,
      links: {},
      prisma: {
        clientVersion: '5.22.0',
        cliVersion: '5.22.0',
        engineSha256: files['engine.node'],
      },
    };
    const pin = write(
      path.join(folder, 'release.json'),
      JSON.stringify(manifest),
    );
    roles[role] = {
      id,
      path: folder,
      sha256: pin.sha256,
      sourceCommit: manifest.sourceCommit,
    };
  }
  write(
    path.join(releasesRoot, 'active.json'),
    JSON.stringify({ format: 1, id: roles.current.id }),
  );
  const marker =
    '__maintenanceBindingFixture_' + crypto.randomUUID().replaceAll('-', '');
  globalThis[marker] = { calls: 0, reject: false };
  const driverPin = write(
    path.join(controlRoot, 'synthetic-driver.cjs'),
    `module.exports.run=async function(plan){ const state=globalThis[${JSON.stringify(marker)}]; state.calls++; if(state.reject)throw Error('SYNTHETIC_NATIVE_ADMISSION_REFUSED'); return {status:'synthetic-control-only',commit:plan.candidate.sourceCommit}; };\n`,
  );
  const code = write(
    path.join(controlRoot, 'synthetic-helper.cjs'),
    "throw Error('this helper must never be loaded during preparation');\n",
  );
  const packageJson = write(
    path.join(controlRoot, 'synthetic-package.json'),
    '{"version":"5.22.0"}',
  );
  const evidence = write(
    path.join(controlRoot, 'synthetic-evidence.json'),
    '{"classification":"synthetic only"}',
  );
  const plan = {
    executionMode: 'final-install',
    projectRoot,
    releasesRoot,
    database,
    backupDataRoot,
    journalFile: path.join(path.dirname(database), '.wewe-update.json'),
    current: roles.current,
    candidate: roles.candidate,
    dependencyPins: [driverPin, code, packageJson],
    modules: Object.fromEntries(
      [
        'scope',
        'toolkit',
        'writerGate',
        'lockSession',
        'pointer',
        'tasks',
        'capacity',
        'restart',
        'stopRetire',
      ].map((name) => [name, code]),
    ),
    nativeTool: code,
    maintenanceHelper: code,
    singleProtectedVerifier: code,
    python: code.path,
    pythonSha256: code.sha256,
    migrationRuntime: Object.fromEntries(
      ['cli', 'schemaEngine'].map((name) => [
        name,
        {
          ...code,
          packageJson: packageJson.path,
          packageJsonSha256: packageJson.sha256,
        },
      ]),
    ),
    oldProcess: evidence,
    scopePolicy: evidence,
    backupApproval: evidence,
  };
  const planFile = write(
    path.join(controlRoot, 'synthetic-final-plan.json'),
    JSON.stringify(plan),
  );
  const input = {
    plan: planFile,
    driver: { ...driverPin, closure: [driverPin, code, packageJson] },
    expected: {
      ...structuredClone(roles),
      planSha256: planFile.sha256,
      driverSha256: driverPin.sha256,
    },
  };
  const tree = () => {
    const result = {};
    function visit(folder) {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) visit(file);
        else result[path.relative(root, file)] = hash(fs.readFileSync(file));
      }
    }
    visit(root);
    return result;
  };
  const replan = () => {
    input.plan = write(planFile.path, JSON.stringify(plan));
    input.expected.planSha256 = input.plan.sha256;
  };
  try {
    await run({
      root,
      controlRoot,
      input,
      plan,
      roles,
      code,
      marker,
      tree,
      replan,
    });
  } finally {
    delete globalThis[marker];
    assert.equal(path.dirname(root), temp);
    assert(path.basename(root).startsWith('maintenance-binding-fixture-'));
    fs.rmSync(root, { recursive: true });
  }
}

test('binding preparation is deterministic data-only and writes no host or control files', () =>
  fixture(async (f) => {
    const before = f.tree(),
      result = prepareMaintenanceBinding(f.input);
    assert.deepEqual(f.tree(), before);
    assert.equal(globalThis[f.marker].calls, 0);
    assert.equal(result.executed, false);
    assert.equal(result.runtimeAdmissionPerformed, false);
    assert.match(result.closureClaim, /transitive-source-review-required/);
    assert.deepEqual(result, prepareMaintenanceBinding(f.input));
    assert.equal(result.bindings.mode, 'maintenance-driver-v1');
    assert.equal(result.request.sha256, f.roles.candidate.sha256);
  }));

test('proposal wires the existing formal entry only when the fixture owner explicitly materializes it', () =>
  fixture(async (f) => {
    const proposal = prepareMaintenanceBinding(f.input),
      bindings = path.join(f.controlRoot, 'synthetic-bindings.json');
    write(bindings, JSON.stringify(proposal.bindings));
    const result = await createMaintenanceEntry({
      bindingsFile: bindings,
    }).runMaintenance({ request: proposal.request });
    assert.equal(result.status, 'synthetic-control-only');
    assert.equal(globalThis[f.marker].calls, 1);
  }));

test('real driver admission refusal is propagated without switching to another executor', () =>
  fixture(async (f) => {
    const proposal = prepareMaintenanceBinding(f.input),
      bindings = path.join(f.controlRoot, 'synthetic-bindings.json');
    write(bindings, JSON.stringify(proposal.bindings));
    globalThis[f.marker].reject = true;
    await assert.rejects(
      createMaintenanceEntry({ bindingsFile: bindings }).runMaintenance({
        request: proposal.request,
      }),
      /SYNTHETIC_NATIVE_ADMISSION_REFUSED/,
    );
    assert.equal(globalThis[f.marker].calls, 1);
  }));

test('candidate self-reported identity cannot fill independent review expectations', () =>
  fixture(async (f) => {
    delete f.input.expected;
    assert.throws(
      () => prepareMaintenanceBinding(f.input),
      /INDEPENDENT_REVIEW_EXPECTATIONS_REQUIRED/,
    );
  }));

test('unreviewed candidate digest is refused even when its plan agrees with it', () =>
  fixture(async (f) => {
    f.plan.candidate.sha256 = 'f'.repeat(64);
    f.replan();
    assert.throws(
      () => prepareMaintenanceBinding(f.input),
      /REVIEWED_RELEASE_BINDING_CHANGED/,
    );
  }));

test('draft plan cannot be converted to final execution by the binding compiler', () =>
  fixture(async (f) => {
    f.plan.executionMode = 'review-only';
    f.replan();
    assert.throws(
      () => prepareMaintenanceBinding(f.input),
      /FINAL_OWNER_PLAN_REQUIRED/,
    );
  }));

test('missing referenced native helper in the declared closure is rejected', () =>
  fixture(async (f) => {
    f.input.driver.closure = f.input.driver.closure.filter(
      (value) => value.path !== f.code.path,
    );
    assert.throws(
      () => prepareMaintenanceBinding(f.input),
      /REFERENCED_CONTROL_PIN_MISSING/,
    );
  }));

test('changed pinned helper is rejected before any driver import', () =>
  fixture(async (f) => {
    fs.appendFileSync(f.code.path, 'changed');
    assert.throws(
      () => prepareMaintenanceBinding(f.input),
      /REVIEWED_INPUT_CHANGED/,
    );
    assert.equal(globalThis[f.marker].calls, 0);
  }));

test('changed runtime evidence remains refused rather than regenerated', () =>
  fixture(async (f) => {
    fs.appendFileSync(f.plan.oldProcess.path, 'changed');
    assert.throws(
      () => prepareMaintenanceBinding(f.input),
      /REVIEWED_INPUT_CHANGED/,
    );
  }));

test('duplicate closure members cannot conceal a conflicting declared identity', () =>
  fixture(async (f) => {
    f.input.driver.closure.push(f.code);
    assert.throws(
      () => prepareMaintenanceBinding(f.input),
      /REVIEWED_CONTROL_CLOSURE_INVALID/,
    );
  }));

test('a plan in the project tree is rejected rather than treated as independent control', () =>
  fixture(async (f) => {
    f.input.plan = write(
      path.join(f.plan.projectRoot, 'synthetic-plan.json'),
      JSON.stringify(f.plan),
    );
    f.input.expected.planSha256 = f.input.plan.sha256;
    assert.throws(
      () => prepareMaintenanceBinding(f.input),
      /INDEPENDENT_CONTROL_PLAN_REQUIRED/,
    );
  }));

test('missing input never guesses a default host or plan', () => {
  assert.throws(
    () => prepareMaintenanceBinding(),
    /INDEPENDENT_REVIEW_EXPECTATIONS_REQUIRED/,
  );
});

test('changed final plan is rejected without regenerating its expected hash', () =>
  fixture(async (f) => {
    fs.appendFileSync(f.input.plan.path, '\n');
    assert.throws(
      () => prepareMaintenanceBinding(f.input),
      /REVIEWED_INPUT_CHANGED/,
    );
  }));

test('candidate application code cannot become the independent control driver', () =>
  fixture(async (f) => {
    const file = path.join(f.roles.candidate.path, 'runtime.cjs');
    f.input.driver.path = file;
    f.input.driver.sha256 = hash(fs.readFileSync(file));
    f.input.expected.driverSha256 = f.input.driver.sha256;
    assert.throws(
      () => prepareMaintenanceBinding(f.input),
      /INDEPENDENT_CONTROL_DRIVER_REQUIRED/,
    );
  }));

test('hard-linked control files are rejected rather than hashed as trusted plain inputs', () =>
  fixture(async (f) => {
    const alias = path.join(f.controlRoot, 'synthetic-hardlink.cjs');
    fs.linkSync(f.code.path, alias);
    assert.throws(
      () => prepareMaintenanceBinding(f.input),
      /REVIEWED_INPUT_NOT_PLAIN/,
    );
  }));
