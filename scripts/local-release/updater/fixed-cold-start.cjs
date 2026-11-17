'use strict';
// Narrow no-old-process branch. Reuses original plan budgets, sessions and native
// stop/retire; it never fabricates an old PID, exit receipt or legacy authority.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto');
const { fixedProfile } = require('./fixed-driver-profile.cjs');
const { verifyPinnedInput: pin } = require('./prepare-maintenance-binding.cjs');
const proofs = new WeakMap();
const fail = code => { throw Error(code); };
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function validateColdMaintenance(proof, { database, scopeLease }, all = false) {
  const value = proofs.get(proof);
  if (!value || value.database !== database || value.scopeLease !== scopeLease) fail('OPAQUE_COLD_MAINTENANCE_REQUIRED');
  value.check(); if (all) value.quiescent(); return true;
}
function createColdScope({ profileToken, prepared, sessions, assertTaskSuspended }) {
  const data = fixedProfile(profileToken), p = data.profile, { api, old, next } = prepared;
  if (p.startMode !== 'cold-empty' || p.oldProcess !== undefined || typeof assertTaskSuspended !== 'function') fail('FIXED_COLD_PROFILE_REQUIRED');
  pin(p.coldObservation);
  api.scope.inspectPlan(p, prepared);
  const identity = folder => { const s = fs.lstatSync(folder, { bigint: true }); if (!s.isDirectory() || s.isSymbolicLink() || fs.realpathSync.native(folder) !== folder) fail('COLD_DIRECTORY_CHANGED'); return [s.dev, s.ino, s.birthtimeNs].map(String).join(':'); };
  const directories = [p.projectRoot, p.releasesRoot, old.path, next.path].map(folder => [folder, identity(folder)]);
  const expectedLocks = [path.join(p.releasesRoot, '.build-budget.lock'), path.join(p.projectRoot, '.active-release.lock')];
  const policy = JSON.parse(fs.readFileSync(p.scopePolicy.path)), pointer = path.join(p.releasesRoot, 'active.json');
  const allowedPointers = new Set([p.activePointerSha256, ...[old.id, next.id].map(id => crypto.createHash('sha256').update(JSON.stringify({ format: 1, id }) + '\n').digest('hex'))]);
  const tracked = new Map(), stopped = new Map();
  function own() {
    for (const file of expectedLocks) { const session = sessions.find(s => s.path === file); if (!session) fail('REAL_INSTALLER_SESSION_REQUIRED'); session.assertOwned(); }
    for (const [folder, before] of directories) if (identity(folder) !== before) fail('COLD_DIRECTORY_CHANGED');
    pin(p.scopePolicy);
    if (hash(path.join(old.path, 'release.json')) !== old.sha256 || hash(path.join(next.path, 'release.json')) !== next.sha256 || !allowedPointers.has(hash(pointer))) fail('COLD_INSTALLATION_CHANGED');
    api.scope.inspectPlan(p, prepared);
    const disk = fs.statfsSync(p.releasesRoot, { bigint: true });
    if (disk.bavail * disk.bsize < BigInt(policy.budget.minFreeBytes)) fail('INSTALLER_DISK_RESERVE_UNAVAILABLE');
  }
  function observe() {
    own(); pin(p.coldObservation);
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const result = JSON.parse(cp.execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-File', p.coldObservation.path,
      '-ProjectRoot', p.projectRoot, '-Database', p.database, '-OwnerPid', String(process.pid), '-TrackedRoots', [...tracked.keys()].join(',')],
      { windowsHide: true, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
    if (result.complete !== true || result.kind !== 'cold-project-census-v1' || result.ownerPid !== process.pid || !Array.isArray(result.active)) fail('COLD_OBSERVATION_INCOMPLETE');
    const active = new Map(result.active.map(row => [row.pid, row]));
    // The process census alone is insufficient: independently inspect the exact
    // configured listener, including a foreign executable outside this project.
    const listener = api.toolkit.processIdentity('Discover', 0, p.port);
    if (listener) active.set(listener.pid, listener);
    own(); return { complete: true, active: [...active.values()] };
  }
  function quiescent() { own(); assertTaskSuspended(); const fact = observe(); if (fact.active.length) fail('COLD_PROJECT_WRITERS_REMAIN'); return true; }
  const roles = [['old', old], ['candidate', next], ['fallback', old]].map(([role, release]) => ({ role, executable: path.join(release.path, 'runtime/node.exe'),
    executableSha256: release.manifest.files['runtime/node.exe'], commandLine: api.restart.commandLine(release.path, p.database, p.port, release.manifest) }));
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['SYSTEMROOT', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'COMSPEC', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS'].includes(key.toUpperCase())));
  const stopper = api.stopRetire.create({ projectRoot: p.projectRoot, database: p.database, sessions, gate: path.join(old.path, 'project-writer-gate.cjs'),
    gateSha256: old.manifest.files['project-writer-gate.cjs'], nativeTool: p.nativeTool.path, nativeSha256: p.nativeTool.sha256, roles, env: environment });
  const scopeLease = {
    kind: 'fixed-cold-owned-session-maintenance', check: own,
    assertWritable(kinds) { own(); if (!kinds.some(k => ['restart', 'switch', 'activate'].includes(k))) fail('INSTALLER_EFFECT_NOT_AUTHORIZED'); },
    observeProjectWriters: observe,
    coldMaintenanceProof() { quiescent(); const proof = Object.freeze({}); proofs.set(proof, { database: p.database, scopeLease, check: own, quiescent }); return proof; },
    coldMaintenanceBoundary(proof) { validateColdMaintenance(proof, { database: p.database, scopeLease }); return Object.freeze({
      check: () => validateColdMaintenance(proof, { database: p.database, scopeLease }),
      observe: () => validateColdMaintenance(proof, { database: p.database, scopeLease }, true),
    }); },
    legacyMaintenanceBoundary() { fail('COLD_HAS_NO_LEGACY_STOP_RECEIPT'); },
    async stopExact(value, releaseId) {
      own(); const release = [old, next].find(r => r.id === releaseId);
      if (!release || value.executable.toLowerCase() !== path.join(release.path, 'runtime/node.exe').toLowerCase()) fail('UNAPPROVED_INSTALLER_PROCESS');
      api.toolkit.sameIdentity(api.toolkit.processIdentity('OwnedSnapshot', value.pid, p.port, value), value);
      const token = stopper.capture(value.pid, releaseId === next.id ? 'candidate' : 'fallback', p.port);
      const proof = stopper.stopAndRetire(token); stopped.set(value.pid, proof); tracked.set(value.pid, value);
      for (const child of proof.stoppedTree || []) tracked.set(child.identity.pid, child.identity);
      return proof.stopReceipt;
    },
    confirmPreservingProcessExit(pid, receipt) { own(); if (JSON.stringify(stopped.get(pid)?.stopReceipt) !== JSON.stringify(receipt)) fail('ORIGINAL_OPAQUE_STOP_ENTRY_REQUIRED'); },
    bindPreservingChild(value, releaseId, commandLine) { own(); const release = [old, next].find(r => r.id === releaseId); if (!release || commandLine !== api.restart.commandLine(release.path, p.database, p.port, release.manifest)) fail('INSTALLER_CHILD_COMMAND_CHANGED');
      api.toolkit.sameIdentity(api.toolkit.processIdentity('OwnedSnapshot', value.pid, p.port, value), value); tracked.set(value.pid, value); },
    authorizePointerCommit(temporary, destination, id, recovery) { own(); if (destination !== pointer || path.dirname(temporary) !== p.releasesRoot || !/^active-[a-f0-9-]+\.tmp$/.test(path.basename(temporary)) || JSON.parse(fs.readFileSync(temporary)).id !== id || id !== (recovery ? old.id : next.id)) fail('EXACT_INSTALLER_POINTER_COMMIT_REQUIRED'); },
  };
  return scopeLease;
}
module.exports = { createColdScope, validateColdMaintenance };
