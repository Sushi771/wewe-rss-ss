'use strict';
// Fixed build inputs, not adoption of any old installation's authority.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { verifyPinnedInput: pin } = require('./prepare-maintenance-binding.cjs');
const { verifyRelease } = require('./installed-host.cjs');
const bindings = new WeakMap();
const rolesBindings = new WeakMap();
const controls = ['preserving-contract.cjs', 'reference-diagnostics.cjs', 'release-scope.cjs', 'restart.cjs'];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const normalized = bytes => Buffer.from(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n/g, '\n'));
const fail = code => { throw Error(code); };
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function migrationIdentity(manifest) {
  return { schema: manifest.files['server/prisma/schema.prisma'], migrations: Object.fromEntries(Object.entries(manifest.files).filter(([n]) => /^server\/prisma\/migrations\/[^/]+\/migration\.sql$/.test(n)).sort()) };
}

function freezeControlSources({ repository, commit, files }) {
  if (!path.isAbsolute(repository || '') || !/^[a-f0-9]{40}$/.test(commit || '') || !Array.isArray(files) || files.length !== controls.length) fail('FIXED_TRUSTED_SOURCE_REQUIRED');
  const result = [];
  for (const name of controls) {
    const relative = 'scripts/local-release/' + name;
    const input = files.find(p => p.relative === relative);
    if (!input) fail('COMPLETE_TRUSTED_CONTROLS_REQUIRED');
    const actual = pin(input);
    const trusted = cp.execFileSync('git', ['-C', repository, 'show', commit + ':' + relative], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    const bytes = fs.readFileSync(actual.path);
    if (!normalized(bytes).equals(normalized(trusted))) fail('CONTROL_SOURCE_DIFFERS_FROM_TRUSTED_COMMIT');
    result.push({ ...actual, relative, normalizedSha256: sha(normalized(trusted)), gitBlob: cp.execFileSync('git', ['-C', repository, 'rev-parse', commit + ':' + relative], { windowsHide: true, encoding: 'utf8' }).trim() });
  }
  return freeze({ kind: 'git-object-bound-control-sources-v1', commit, files: result });
}

function verifyFixedProfile(profileFile, expectedSha256) {
  const fixed = pin({ path: profileFile, sha256: expectedSha256 });
  const profile = JSON.parse(fs.readFileSync(fixed.path, 'utf8'));
  if (profile.kind !== 'fixed-held-same-schema-maintenance-v1' || profile.executionMode !== 'final-install' ||
      profile.backup?.mode !== 'exact-protected-reuse-v1' || !Array.isArray(profile.closure) || !profile.closure.length) fail('FIXED_DRIVER_PROFILE_REQUIRED');
  if (!Number.isSafeInteger(profile.port) || profile.port < 1024 || profile.port > 65535 ||
      !/^[a-f0-9]{64}$/.test(profile.taskDefinitionSha256 || '') || !/^[a-f0-9]{64}$/.test(profile.activePointerSha256 || '') ||
      !Number.isSafeInteger(profile.reserveBytes) || profile.reserveBytes < 1 || profile.closure.length > 2048) fail('FIXED_HOST_POLICY_REQUIRED');
  const source = profile.trustedControlSource;
  if (source?.kind !== 'git-object-bound-control-sources-v1' || !/^[a-f0-9]{40}$/.test(source.commit || '') || source.files?.length !== 4) fail('TRUSTED_CONTROL_SOURCE_BINDING_REQUIRED');
  const closure = new Map();
  for (const item of profile.closure) {
    const checked = pin(item);
    if (item.path !== checked.path) fail('FIXED_PROFILE_NONCANONICAL_CODE_PATH');
    if (closure.has(checked.path)) fail('DUPLICATE_PROFILE_CODE_PIN');
    closure.set(checked.path, checked.sha256);
  }
  for (const name of controls) {
    const input = source.files.find(p => p.relative === 'scripts/local-release/' + name);
    if (!input || !/^[a-f0-9]{40}$/.test(input.gitBlob || '') || closure.get(input.path) !== input.sha256 || sha(normalized(fs.readFileSync(input.path))) !== input.normalizedSha256) fail('TRUSTED_CONTROL_SOURCE_CHANGED');
  }
  for (const name of ['projectRoot', 'releasesRoot', 'database', 'backupDataRoot', 'journalFile', 'python'])
    if (!path.isAbsolute(profile[name] || '')) fail('FIXED_HOST_PATH_REQUIRED');
  if (profile.releasesRoot !== path.join(profile.projectRoot, '.local-releases') || profile.database !== path.join(profile.projectRoot, 'apps/server/data/wewe-rss.db') ||
      profile.journalFile !== path.join(path.dirname(profile.database), '.wewe-update.json')) fail('FIXED_HOST_PATH_CHANGED');
  const requirePin = input => { const checked = pin(input); if (closure.get(checked.path) !== checked.sha256) fail('FIXED_PROFILE_CODE_CLOSURE_INCOMPLETE'); return checked; };
  for (const name of ['scope', 'stopRetire', 'toolkit', 'writerGate', 'lockSession', 'tasks', 'restart']) requirePin(profile.modules?.[name]);
  requirePin(profile.nativeTool);
  requirePin({ path: profile.python, sha256: profile.pythonSha256 });
  for (const file of ['fixed-maintenance-driver.cjs', 'fixed-driver-profile.cjs', 'fixed-code-loader.cjs', 'fixed-reuse-owner.cjs', 'reuse-owner-backend.py', 'installed-host.cjs', 'installed-native-primitives.cjs', 'installer/update-engine.cjs']) {
    const absolute = path.join(__dirname, file);
    if (!closure.has(absolute)) fail('FIXED_PROFILE_LOCAL_CODE_NOT_PINNED');
  }
  requirePin(profile.backup.helper);
  if (profile.startMode === 'cold-empty') {
    if (profile.oldProcess !== undefined) fail('COLD_HAS_NO_OLD_PROCESS');
    requirePin(profile.coldObservation);
    if (profile.coldObservation.path !== path.join(__dirname, 'cold-project-observation.ps1') || !closure.has(path.join(__dirname, 'fixed-cold-start.cjs')))
      fail('FIXED_COLD_OBSERVATION_REQUIRED');
  } else {
    if (profile.startMode !== undefined && profile.startMode !== 'existing-process') fail('FIXED_START_MODE_INVALID');
    pin(profile.oldProcess);
  }
  pin(profile.scopePolicy);
  if (!path.isAbsolute(profile.backup.path || '') || !/^[a-f0-9]{64}$/.test(profile.backup.sha256 || '') ||
      !Array.isArray(profile.backup.inventory) || !Array.isArray(profile.backup.sourceIdentity) || profile.backup.sourceIdentity.length !== 2)
    fail('FIXED_REUSE_BINDING_REQUIRED');
  const found = {};
  for (const role of ['current', 'candidate']) {
    const value = profile[role];
    if (!value || path.dirname(value.path || '') !== profile.releasesRoot) fail('FIXED_RELEASE_ROOT_CHANGED');
    const checked = verifyRelease(value.path, value.sha256, { role });
    if (checked.id !== value.id || checked.manifest.sourceCommit !== value.sourceCommit) fail('FIXED_RELEASE_IDENTITY_CHANGED');
    if (checked.manifest.installedLifecycle?.protocol !== 'wewe-installed-lifecycle-v1' ||
        checked.manifest.installedLifecycle?.journalBasename !== '.wewe-update.json' ||
        checked.manifest.installedLifecycle?.writeHoldProtocol !== 'project-writer-prisma-query-only-v1' ||
        !checked.manifest.files['installed-startup-gate.cjs']) fail('FIXED_INSTALLED_LIFECYCLE_REQUIRED');
    found[role] = checked;
  }
  if (found.current.id === found.candidate.id || JSON.stringify(migrationIdentity(found.current.manifest)) !== JSON.stringify(migrationIdentity(found.candidate.manifest)) ||
      Object.keys(migrationIdentity(found.current.manifest).migrations).length !== 35 || found.current.manifest.prisma.engineCommit !== found.candidate.manifest.prisma.engineCommit) fail('FIXED_EXACT_SAME_SCHEMA_35_REQUIRED');
  const roles = freeze(Object.fromEntries(['current', 'candidate', 'rollback'].map(role => { const item = found[role === 'rollback' ? 'current' : role]; return [role, { folder: item.path, manifest: item.manifest, manifestSha256: item.sha256 }]; })));
  const token = Object.freeze({});
  const data = freeze({ fixed, profile, roles, current: found.current, candidate: found.candidate });
  bindings.set(token, data); rolesBindings.set(roles, data);
  return token;
}
function fixedProfile(token) { const value = bindings.get(token); if (!value) fail('OPAQUE_FIXED_PROFILE_REQUIRED'); return value; }
function fixedRoleBinding(roles) { return rolesBindings.get(roles); }
/** Pure new-build freezer. The caller supplies separately reviewed role and
 * control-source identities; observed candidate bytes never fill expectations.
 * The returned proposal must be materialized and reviewed by the owner before
 * prepareFixedDispatch. It does not acquire maintenance or publish bindings. */
function freezeFixedProfile({ profile, controlSource, expected }) {
  if (!profile || profile.trustedControlSource || expected?.controlCommit !== controlSource?.commit ||
      !/^[a-f0-9]{40}$/.test(expected?.controlCommit || '') || !expected.current || !expected.candidate)
    fail('INDEPENDENT_FIXED_SOURCE_REVIEW_REQUIRED');
  for (const role of ['current', 'candidate']) {
    for (const key of ['path', 'id', 'sha256', 'sourceCommit'])
      if (profile[role]?.[key] !== expected[role][key]) fail('INDEPENDENT_FIXED_ROLE_CHANGED');
    const actual = verifyRelease(profile[role].path, expected[role].sha256, { role });
    if (actual.id !== expected[role].id || actual.manifest.sourceCommit !== expected[role].sourceCommit)
      fail('INDEPENDENT_FIXED_ROLE_CHANGED');
  }
  if (!Array.isArray(profile.closure) || !profile.closure.length) fail('FIXED_PROFILE_CODE_CLOSURE_INCOMPLETE');
  const closure = profile.closure.map(pin);
  if (new Set(closure.map(item => item.path)).size !== closure.length) fail('DUPLICATE_PROFILE_CODE_PIN');
  const trustedControlSource = freezeControlSources(controlSource);
  if (trustedControlSource.files.some(item => !closure.some(p => p.path === item.path && p.sha256 === item.sha256)))
    fail('COMPLETE_TRUSTED_CONTROLS_REQUIRED');
  const frozen = freeze({ ...structuredClone(profile), closure, trustedControlSource });
  const text = JSON.stringify(frozen);
  return freeze({ classification: 'new-build-fixed-profile-owner-review', executed: false,
    runtimeAdmissionPerformed: false, profile: frozen, text, sha256: sha(Buffer.from(text)) });
}
/** Compile only the narrow existing maintenance-driver dispatch. No host effect,
 * no adoption of current disk bytes as trust, and no implicit profile creation. */
function prepareFixedDispatch({ profile: profilePin, driver, expected }) {
  if (!expected || expected.profileSha256 !== profilePin?.sha256 || expected.driverSha256 !== driver?.sha256 ||
      !expected.current || !expected.candidate || !/^[a-f0-9]{40}$/.test(expected.candidate.sourceCommit || ''))
    fail('INDEPENDENT_FIXED_REVIEW_REQUIRED');
  const token = verifyFixedProfile(profilePin.path, profilePin.sha256), data = fixedProfile(token), p = data.profile;
  for (const role of ['current', 'candidate']) {
    for (const key of ['path', 'id', 'sha256', 'sourceCommit'])
      if (p[role][key] !== expected[role][key]) fail('INDEPENDENT_FIXED_ROLE_CHANGED');
  }
  const entry = pin(driver);
  if (entry.path !== path.join(__dirname, 'fixed-maintenance-driver.cjs') ||
      !p.closure.some(item => item.path === entry.path && item.sha256 === entry.sha256)) fail('FIXED_DISPATCH_ENTRY_CHANGED');
  return freeze({ kind: 'fixed-profile-maintenance-dispatch-v1', executionMode: 'final-install',
    projectRoot: p.projectRoot, releasesRoot: p.releasesRoot, database: p.database, backupDataRoot: p.backupDataRoot,
    journalFile: p.journalFile, current: p.current, candidate: p.candidate, profile: data.fixed,
    dependencyPins: p.closure });
}
module.exports = { freezeControlSources, freezeFixedProfile, verifyFixedProfile, fixedProfile, fixedRoleBinding, prepareFixedDispatch };
