'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const { fixture } = require('./updater/fixed-maintenance-fixture.cjs'),
  { runFixedProfile } = require('./updater/fixed-maintenance-driver.cjs'),
  mode = require('./managed-runtime-mode.cjs');
const read = (f) => JSON.parse(fs.readFileSync(f));
function state(f, channel) {
  return path.join(
    path.dirname(f.database),
    '.collection-channel-control',
    channel,
    'state.json',
  );
}
test(
  'reviewed manual XHS mode installs without tasks, persists in bound transaction and survives normal startup configuration',
  { timeout: 240000 },
  () =>
    fixture(
      async (f) => {
        const before = fs.readFileSync(f.retainedQueue),
          r = await runFixedProfile(f.profilePin);
        assert.equal(r.status, 'completed');
        assert.equal(
          read(f.profile.journalFile).runtimeMode.kind,
          'manual-xhs-v1',
        );
        const env = mode.committed({
          journalFile: f.profile.journalFile,
          releaseId: f.roles.candidate.id,
          manifestSha256: f.roles.candidate.sha256,
          database: f.database,
        });
        assert.equal(env.WECHAT2RSS_RECOVERY_HOLD, '0');
        assert.equal(env.XHS_SUBSCRIPTION_LIVE_ENABLED, '1');
        assert.equal(env.ENABLE_SCHEDULED_UPDATES, '0');
        assert.equal(env.WECHAT2RSS_CACHE_MEDIA_ENABLED, '0');
        assert.equal(env.XHS_COMMENT_COLLECTION_ENABLED, '0');
        assert.equal(read(state(f, 'wechat')).paused, true);
        assert.equal(read(state(f, 'xiaohongshu')).paused, true);
        const registry = read(f.profile.journalFile + '.native-processes'),
          identity = registry.processes[0].identity;
        const response = await fetch(
          'http://127.0.0.1:' + f.profile.port + '/_local/update-health',
        );
        const proof = await response.json();
        assert.equal(proof.managedRuntime.mode, 'manual-xhs-v1');
        assert.equal(proof.managedRuntime.automaticDisabled, true);
        assert.equal(proof.managedRuntime.recoveryHeld, false);
        assert.deepEqual(fs.readFileSync(f.database), f.before);
        assert.deepEqual(fs.readFileSync(f.retainedQueue), before);
        const committed = read(f.profile.journalFile);
        const wrongMode = { ...committed };
        delete wrongMode.runtimeMode;
        fs.writeFileSync(f.profile.journalFile, JSON.stringify(wrongMode));
        await assert.rejects(
          runFixedProfile(f.profilePin),
          /FIXED_CURRENT_MODE_REQUIRES_REVIEW/,
        );
        fs.writeFileSync(f.profile.journalFile, JSON.stringify(committed));
        // A later legitimate XHS resume changes revision, not the reviewed archive.
        const x = read(state(f, 'xiaohongshu'));
        x.paused = false;
        x.revision++;
        fs.writeFileSync(state(f, 'xiaohongshu'), JSON.stringify(x));
        assert.equal(
          mode.committed({
            journalFile: f.profile.journalFile,
            releaseId: f.roles.candidate.id,
            manifestSha256: f.roles.candidate.sha256,
            database: f.database,
          }).DISABLE_SCHEDULED_UPDATES,
          '1',
        );
        const w = read(state(f, 'wechat'));
        w.paused = false;
        fs.writeFileSync(state(f, 'wechat'), JSON.stringify(w));
        assert.throws(
          () =>
            mode.committed({
              journalFile: f.profile.journalFile,
              releaseId: f.roles.candidate.id,
              manifestSha256: f.roles.candidate.sha256,
              database: f.database,
            }),
          /MANAGED_CHANNEL_MUST_BE_PAUSED/,
        );
      },
      { coldStart: true, manualMode: true },
    ),
);
test(
  'changed/missing history and an unpaused channel reject before updater writes or service launch',
  { timeout: 240000 },
  () =>
    fixture(
      async (f) => {
        const file = state(f, 'wechat'),
          w = read(file);
        w.paused = false;
        fs.writeFileSync(file, JSON.stringify(w));
        await assert.rejects(
          runFixedProfile(f.profilePin),
          /MANAGED_CHANNEL_MUST_BE_PAUSED/,
        );
        assert.equal(fs.existsSync(f.profile.journalFile), false);
        w.paused = true;
        w.archived = [];
        fs.writeFileSync(file, JSON.stringify(w));
        await assert.rejects(
          runFixedProfile(f.profilePin),
          /MANAGED_ARCHIVE_REQUIRED/,
        );
        assert.deepEqual(fs.readFileSync(f.database), f.before);
      },
      { coldStart: true, manualMode: true },
    ),
);
test(
  'manual mode native health failure recovers the held old role without publishing manual mode',
  { timeout: 240000 },
  () =>
    fixture(
      async (f) => {
        const driver = f.pin(
          path.join(__dirname, 'updater/fixed-maintenance-driver.cjs'),
        );
        const dispatch =
          require('./updater/fixed-driver-profile.cjs').prepareFixedDispatch({
            profile: f.profilePin,
            driver,
            expected: {
              ...f.roles,
              runtimeMode: f.profile.runtimeMode,
              profileSha256: f.profilePin.sha256,
              driverSha256: driver.sha256,
            },
          });
        const r = await require('./updater/fixed-maintenance-driver.cjs').run(
          dispatch,
        );
        assert.equal(r.status, 'failed-recovered');
        assert.equal(r.journal.runtimeMode, undefined);
        assert.equal(
          read(path.join(f.profile.releasesRoot, 'active.json')).id,
          f.roles.current.id,
        );
        const proof = await (
          await fetch(
            'http://127.0.0.1:' + f.profile.port + '/_local/update-health',
          )
        ).json();
        assert.equal(proof.managedRuntime.mode, 'held');
        assert.equal(proof.managedRuntime.recoveryHeld, true);
        assert.equal(proof.managedRuntime.xhsLive, false);
        assert.deepEqual(fs.readFileSync(f.database), f.before);
      },
      { coldStart: true, manualMode: true, candidateHealthBad: true },
    ),
);
test(
  'manual mode requires explicit owner mode approval and a matching commit permit',
  { timeout: 240000 },
  () =>
    fixture(
      async (f) => {
        const api = require('./updater/fixed-driver-profile.cjs');
        const driver = f.pin(
          path.join(__dirname, 'updater/fixed-maintenance-driver.cjs'),
        );
        assert.throws(
          () =>
            api.prepareFixedDispatch({
              profile: f.profilePin,
              driver,
              expected: {
                ...f.roles,
                profileSha256: f.profilePin.sha256,
                driverSha256: driver.sha256,
              },
            }),
          /INDEPENDENT_RUNTIME_MODE_REQUIRED/,
        );
        fs.writeFileSync(
          f.profile.journalFile,
          JSON.stringify({
            stage: 'completed',
            transactionId: 'synthetic',
            runtimeMode: f.profile.runtimeMode,
            package: f.roles.candidate,
          }),
        );
        fs.writeFileSync(
          f.profile.journalFile + '.permit',
          JSON.stringify({
            stage: 'completed',
            transactionId: 'foreign',
            id: f.roles.candidate.id,
            sha256: f.roles.candidate.sha256,
          }),
        );
        assert.throws(
          () =>
            mode.committed({
              journalFile: f.profile.journalFile,
              releaseId: f.roles.candidate.id,
              manifestSha256: f.roles.candidate.sha256,
              database: f.database,
            }),
          /MANAGED_COMMIT_REQUIRED/,
        );
      },
      { coldStart: true, manualMode: true },
    ),
);

test(
  'a reviewed completed live installation hands off through the original updater without deleting prior evidence',
  { timeout: 240000 },
  () =>
    fixture(
      async (f) => {
        const prior = read(f.profile.previousCompletion.journal.path);
        const result = await runFixedProfile(f.profilePin);
        assert.equal(result.status, 'completed');
        assert.notEqual(result.journal.transactionId, prior.transactionId);
        const control = read(f.profile.journalFile + '.control');
        const saved = read(control.previousCompletionArchive.path);
        for (const key of ['journal', 'control', 'registry', 'permit'])
          assert.equal(
            saved.records[key].sha256,
            f.profile.previousCompletion[key].sha256,
          );
        assert.equal(saved.transactionId, prior.transactionId);
        assert.equal(
          (await runFixedProfile(f.profilePin)).status,
          'already-current',
        );
        assert.equal(
          read(f.profile.journalFile).runtimeMode.kind,
          'manual-xhs-v1',
        );
        assert.deepEqual(fs.readFileSync(f.database), f.before);
        assert.equal(read(state(f, 'wechat')).paused, true);
      },
      { manualMode: true, previousCompletion: true },
    ),
);

test(
  'pending or unknown prior installation is rejected without changing tasks, data or controls',
  { timeout: 240000 },
  () =>
    fixture(
      async (f) => {
        const before = fs.readFileSync(f.profile.journalFile);
        await assert.rejects(
          runFixedProfile(f.profilePin),
          /FIXED_PREVIOUS_COMPLETION_UNPROVEN/,
        );
        assert.deepEqual(fs.readFileSync(f.profile.journalFile), before);
        assert.equal(
          fs.existsSync(f.profile.journalFile + '.startup-lock'),
          false,
        );
        assert.deepEqual(fs.readFileSync(f.database), f.before);
        assert.equal(read(f.modules.tasks.path + '.state').enabled, true);
        assert.equal(
          f.toolkit.processIdentity(
            'OwnedSnapshot',
            f.oldProcess.pid,
            f.profile.port,
            f.oldProcess,
          ).pid,
          f.oldProcess.pid,
        );
      },
      {
        manualMode: true,
        previousCompletion: true,
        previousCompletionStage: 'recovery-failed',
      },
    ),
);

test(
  'scheduled dual mode hands off a completed live installation with both channels paused',
  { timeout: 240000 },
  () =>
    fixture(
      async (f) => {
        assert.equal((await runFixedProfile(f.profilePin)).status, 'completed');
        const j = read(f.profile.journalFile);
        assert.equal(j.runtimeMode.kind, 'scheduled-dual-v1');
        const proof = await (
          await fetch(
            'http://127.0.0.1:' + f.profile.port + '/_local/update-health',
          )
        ).json();
        assert.equal(proof.managedRuntime.scheduledUpdatesEnabled, true);
        assert.equal(proof.managedRuntime.automaticDisabled, false);
        for (const channel of ['wechat', 'xiaohongshu'])
          assert(read(state(f, channel)).paused);
        assert.deepEqual(fs.readFileSync(f.database), f.before);
      },
      { scheduledDualMode: true, previousCompletion: true },
    ),
);
