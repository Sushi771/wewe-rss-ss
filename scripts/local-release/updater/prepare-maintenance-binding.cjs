'use strict';

// Data-only bridge to the existing maintenance-driver-v1 entry. This prepares
// an owner-review proposal; it does not approve a plan, publish installed
// bindings, inspect processes, load a driver, open SQLite or acquire authority.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifyRelease } = require('./installed-host.cjs');
const fail = code => { throw Error(code); };
const inside = (root, file) => {
  const rel = path.relative(root, file);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
};
const stamp = value => [value.dev, value.ino, value.birthtimeNs, value.size, value.mtimeNs, value.ctimeNs].map(String).join(':');

function pin(input) {
  if (!path.isAbsolute(input?.path || '') || !/^[a-f0-9]{64}$/.test(input?.sha256 || '')) fail('REVIEWED_INPUT_PIN_REQUIRED');
  const file = path.resolve(input.path);
  for (let at = file;; at = path.dirname(at)) {
    const value = fs.lstatSync(at);
    if (value.isSymbolicLink()) fail('REVIEWED_INPUT_REDIRECTED');
    if (path.dirname(at) === at) break;
  }
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n) fail('REVIEWED_INPUT_NOT_PLAIN');
  const fd = fs.openSync(file, 'r');
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    if (stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(before)) fail('REVIEWED_INPUT_CHANGED');
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
    }
    if (stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(before)) fail('REVIEWED_INPUT_CHANGED');
  } finally { fs.closeSync(fd); }
  if (stamp(fs.lstatSync(file, { bigint: true })) !== stamp(before) || hash.digest('hex') !== input.sha256) fail('REVIEWED_INPUT_CHANGED');
  return { path: file, sha256: input.sha256 };
}

function prepareMaintenanceBinding({ plan: planPin, driver, expected } = {}) {
  // Expected identities must be supplied separately by the review owner. Never
  // fill them from a candidate manifest, old config or the plan being checked.
  if (!expected?.current || !expected?.candidate || !/^[a-f0-9]{40}$/.test(expected.candidate.sourceCommit || '') ||
      expected.planSha256 !== planPin?.sha256 || expected.driverSha256 !== driver?.sha256) fail('INDEPENDENT_REVIEW_EXPECTATIONS_REQUIRED');
  const planFile = pin(planPin);
  if (fs.statSync(planFile.path).size > 1024 * 1024) fail('REVIEWED_PLAN_TOO_LARGE');
  const plan = JSON.parse(fs.readFileSync(planFile.path, 'utf8').replace(/^\uFEFF/, ''));
  if (plan.executionMode !== 'final-install') fail('FINAL_OWNER_PLAN_REQUIRED');
  for (const name of ['projectRoot', 'releasesRoot', 'database', 'backupDataRoot', 'journalFile'])
    if (!path.isAbsolute(plan[name] || '')) fail('EXACT_HOST_BINDINGS_REQUIRED');
  if (plan.releasesRoot !== path.join(plan.projectRoot, '.local-releases') ||
      plan.database !== path.join(plan.projectRoot, 'apps/server/data/wewe-rss.db') ||
      plan.journalFile !== path.join(path.dirname(plan.database), '.wewe-update.json')) fail('EXACT_HOST_BINDINGS_REQUIRED');
  if (inside(plan.projectRoot, planFile.path) || inside(plan.backupDataRoot, planFile.path)) fail('INDEPENDENT_CONTROL_PLAN_REQUIRED');
  const identities = {};
  for (const role of ['current', 'candidate']) {
    const actual = plan[role], reviewed = expected[role];
    if (!actual || !path.isAbsolute(reviewed.path || '') || actual.path !== reviewed.path || actual.sha256 !== reviewed.sha256 ||
        path.dirname(actual.path) !== plan.releasesRoot) fail('REVIEWED_RELEASE_BINDING_CHANGED');
    const verified = verifyRelease(actual.path, reviewed.sha256, { role });
    if (verified.id !== reviewed.id || (role === 'candidate' &&
        (verified.manifest.sourceCommit !== reviewed.sourceCommit || actual.sourceCommit !== reviewed.sourceCommit))) fail('REVIEWED_RELEASE_BINDING_CHANGED');
    identities[role] = verified;
  }
  if (identities.current.id === identities.candidate.id || identities.current.sha256 === identities.candidate.sha256) fail('DISTINCT_REVIEWED_TARGET_REQUIRED');
  const entry = pin(driver);
  if (inside(identities.candidate.path, entry.path) || inside(identities.current.path, entry.path)) fail('INDEPENDENT_CONTROL_DRIVER_REQUIRED');
  if (!Array.isArray(driver.closure) || !driver.closure.length || !Array.isArray(plan.dependencyPins) || !plan.dependencyPins.length) fail('REVIEWED_CONTROL_CLOSURE_REQUIRED');
  const closure = new Map();
  for (const input of driver.closure) {
    const value = pin(input);
    if (closure.has(value.path) || inside(identities.candidate.path, value.path)) fail('REVIEWED_CONTROL_CLOSURE_INVALID');
    closure.set(value.path, value.sha256);
  }
  const requireMember = input => {
    const value = pin(input);
    if (closure.get(value.path) !== value.sha256) fail('REFERENCED_CONTROL_PIN_MISSING');
  };
  requireMember(entry);
  for (const input of plan.dependencyPins) requireMember(input);
  if (plan.kind === 'fixed-profile-maintenance-dispatch-v1') {
    const fixed = require('./fixed-driver-profile.cjs');
    const compiled = fixed.prepareFixedDispatch({ profile: plan.profile, driver: entry,
      expected: { ...expected, profileSha256: expected.profileSha256 } });
    if (JSON.stringify(compiled) !== JSON.stringify(plan)) fail('FIXED_DISPATCH_PLAN_CHANGED');
    const data = fixed.fixedProfile(fixed.verifyFixedProfile(plan.profile.path, expected.profileSha256));
    if (data.profile.closure.length !== closure.size || data.profile.closure.some(p => closure.get(p.path) !== p.sha256))
      fail('FIXED_DISPATCH_CLOSURE_CHANGED');
    return {
      classification: 'data-only-fixed-maintenance-binding-owner-review', executed: false, runtimeAdmissionPerformed: false,
      closureClaim: 'independently-reviewed-fixed-profile; runtime-source-and-owner-checks-required',
      bindings: { format: 1, mode: 'maintenance-driver-v1', releasesRoot: plan.releasesRoot,
        current: { id: identities.current.id, sha256: identities.current.sha256 }, plan: planFile,
        driver: { ...entry, closure: [...closure].map(([file, sha256]) => ({ path: file, sha256 })) } },
      request: { path: identities.candidate.path, sha256: identities.candidate.sha256 },
    };
  }
  for (const name of ['scope', 'toolkit', 'writerGate', 'lockSession', 'pointer', 'tasks', 'capacity', 'restart', 'stopRetire']) {
    if (!plan.modules?.[name]) fail('PINNED_EXISTING_MODULE_REQUIRED');
    requireMember(plan.modules[name]);
  }
  for (const name of ['nativeTool', 'maintenanceHelper', 'singleProtectedVerifier']) requireMember(plan[name]);
  requireMember({ path: plan.python, sha256: plan.pythonSha256 });
  for (const part of [plan.migrationRuntime?.cli, plan.migrationRuntime?.schemaEngine]) {
    requireMember(part);
    requireMember({ path: part?.packageJson, sha256: part?.packageJsonSha256 });
  }
  // Runtime evidence is checked for byte identity only. The real driver's fresh
  // native, backup, task and ownership checks remain mandatory at execution.
  for (const name of ['oldProcess', 'scopePolicy', 'backupApproval']) pin(plan[name]);
  pin(planFile); pin(entry);
  return {
    classification: 'data-only-maintenance-binding-owner-review',
    executed: false,
    runtimeAdmissionPerformed: false,
    closureClaim: 'declared-pins-verified; transitive-source-review-required',
    bindings: { format: 1, mode: 'maintenance-driver-v1', releasesRoot: plan.releasesRoot,
      current: { id: identities.current.id, sha256: identities.current.sha256 }, plan: planFile,
      driver: { ...entry, closure: [...closure].sort(([a], [b]) => a.localeCompare(b)).map(([file, sha256]) => ({ path: file, sha256 })) } },
    request: { path: identities.candidate.path, sha256: identities.candidate.sha256 },
  };
}

module.exports = { prepareMaintenanceBinding, verifyPinnedInput: pin };
