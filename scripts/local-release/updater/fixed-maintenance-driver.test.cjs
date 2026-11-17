'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { fixture } = require('./fixed-maintenance-fixture.cjs');
const { verifyFixedProfile, fixedProfile, prepareFixedDispatch, freezeControlSources } = require('./fixed-driver-profile.cjs');
const { prepareMaintenanceBinding } = require('./prepare-maintenance-binding.cjs');
const { createMaintenanceEntry } = require('./maintenance-entry.cjs');
const contract = require('./install-binding/role-aware/switch-contract.cjs');
const prewrite = require('./install-binding/role-aware/switch-prewrite.cjs');
test('original native owner + real temporary schema35 SQLite + exact protected reuse + formal dispatch', { timeout: 240000 }, () => fixture(async f => {
  const before = f.pin(f.database).sha256;
  const token = verifyFixedProfile(f.profilePin.path, f.profilePin.sha256), data = fixedProfile(token);
  assert.equal(contract.validateRoles(data.roles), data.roles);
  assert.throws(() => contract.validateRoles(structuredClone(data.roles)), /CURRENT|BASELINE|UNAPPROVED|REQUIRED/);
  const inspected = prewrite.inspectSwitchDatabase({ database: f.database, roles: data.roles, operationId: 'fixture-readonly-inspection' });
  assert.equal(inspected.profile, 'canonical35');
  assert.equal(require('../switch-contract.cjs').validateRoles(data.roles), data.roles);
  assert.equal(require('../switch-prewrite.cjs').inspectSwitchDatabase({ database: f.database, roles: data.roles, operationId: 'fixture-root-readonly-inspection' }).profile, 'canonical35');
  const driver = f.pin(path.join(__dirname, 'fixed-maintenance-driver.cjs'));
  const expected = { ...f.roles, profileSha256: f.profilePin.sha256, driverSha256: driver.sha256 };
  assert.throws(() => prepareFixedDispatch({ profile: f.profilePin, driver, expected: { ...expected, candidate: { ...f.roles.candidate, sourceCommit: 'f'.repeat(40) } } }), /INDEPENDENT_FIXED_ROLE_CHANGED/);
  const plan = prepareFixedDispatch({ profile: f.profilePin, driver, expected });
  const planPin = f.write(path.join(f.control, 'dispatch-plan.json'), JSON.stringify(plan));
  const binding = prepareMaintenanceBinding({ plan: planPin, driver: { ...driver, closure: f.profile.closure }, expected: { ...expected, planSha256: planPin.sha256 } });
  assert.equal(binding.executed, false);
  const bindings = f.write(path.join(f.control, 'bindings.json'), JSON.stringify(binding.bindings));
  const result = await createMaintenanceEntry({ bindingsFile: bindings.path }).runMaintenance({ request: binding.request });
  assert.equal(result.status, 'completed');
  const journal = JSON.parse(fs.readFileSync(f.profile.journalFile));
  assert.equal(journal.backup.reused, true); assert.equal(journal.backup.path, f.profile.backup.path);
  assert.equal(journal.backup.reuseProof, 'all-schema-and-typed-rows-pinned-snapshot-v1');
  assert.equal(f.pin(f.database).sha256, before); assert.deepEqual(fs.readFileSync(f.database), f.before);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.profile.releasesRoot, 'active.json'))).id, f.roles.candidate.id);
  assert.equal(fs.existsSync(f.profile.journalFile + '.startup-lock'), false);
  const savedHold = process.env.WECHAT2RSS_RECOVERY_HOLD;
  try {
    process.env.WECHAT2RSS_RECOVERY_HOLD = '1';
    const ready = await require('../held-management-readiness.cjs').waitHeldManagementReady(f.profile.port, null,
      { id: f.roles.candidate.id, sha256: f.roles.candidate.sha256, database: f.database }, { timeoutMs: 10000, retryMs: 50 });
    assert.equal(ready.mode, 'held-local-management');
  } finally { if (savedHold === undefined) delete process.env.WECHAT2RSS_RECOVERY_HOLD; else process.env.WECHAT2RSS_RECOVERY_HOLD = savedHold; }
  const events = JSON.parse(fs.readFileSync(f.profile.journalFile + '.control')).events;
  assert(events.some(e => e.stage === 'exact-existing-protected-backup-admitted'));
  assert(events.some(e => e.stage === 'reuse-helper-registered'));
  assert(events.some(e => e.stage === 'reuse-helper-exited'));
  const repeated = await require('./fixed-maintenance-driver.cjs').runFixedProfile(f.profilePin);
  assert.equal(repeated.status, 'already-current');
}));
test('actual native health failure recovers the unchanged DB with an opaque reuse-owner restore binding', { timeout: 240000 }, () => fixture(async f => {
  const result = await require('./fixed-maintenance-driver.cjs').runFixedProfile(f.profilePin);
  assert.equal(result.status, 'failed-recovered');
  assert.equal(result.error, 'UPDATE_HEALTH_BINDING_CHANGED');
  const j = JSON.parse(fs.readFileSync(f.profile.journalFile));
  assert.equal(j.stage, 'recovered'); assert.equal(j.backup.reused, true); assert.equal(j.databaseRestored, true);
  assert.deepEqual(fs.readFileSync(f.database), f.before);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.profile.releasesRoot, 'active.json'))).id, f.roles.current.id);
  const events = JSON.parse(fs.readFileSync(f.profile.journalFile + '.control')).events;
  assert(events.some(e => e.stage === 'restore-verified-already-equal-and-opaque-rebound'));
  assert.equal(fs.existsSync(f.profile.journalFile + '.startup-lock'), false);
}, { candidateHealthBad: true }));

test('unexpected DB changes remain held and are never labelled restored or silently copied over', { timeout: 240000 }, () => fixture(async f => {
  let changed = false;
  await assert.rejects(require('./fixed-maintenance-driver.cjs').runFixedProfile(f.profilePin, progress => {
    if (progress.stage === 'checking' && !changed) {
      changed = true;
      const { DatabaseSync } = require('node:sqlite'), db = new DatabaseSync(f.database);
      db.exec("UPDATE _prisma_migrations SET logs='synthetic-unexpected-write' WHERE rowid=1"); db.close();
    }
  }), error => error.message === 'UPDATE_RECOVERY_FAILED' && error.cause?.message === 'UNEXPECTED_DATABASE_CHANGE_RESTORE_HELD');
  assert(changed);
  const j = JSON.parse(fs.readFileSync(f.profile.journalFile));
  assert.equal(j.stage, 'recovery-failed'); assert.equal(j.recoveryError, 'UNEXPECTED_DATABASE_CHANGE_RESTORE_HELD');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.profile.releasesRoot, 'active.json'))).id, f.roles.current.id);
  assert(fs.existsSync(f.profile.journalFile + '.startup-lock'));
  assert.notDeepEqual(fs.readFileSync(f.database), f.before);
}));
