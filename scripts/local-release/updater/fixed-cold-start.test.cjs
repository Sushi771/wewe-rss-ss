'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  cp = require('node:child_process');
const { fixture } = require('./fixed-maintenance-fixture.cjs');
const { runFixedProfile } = require('./fixed-maintenance-driver.cjs');
const read = (file) => JSON.parse(fs.readFileSync(file));
test(
  'cold admission starts no old instance, reuses backup and starts exactly one held candidate',
  { timeout: 240000 },
  () =>
    fixture(
      async (f) => {
        assert.equal(f.oldProcess, undefined);
        assert.equal(f.child, undefined);
        assert.equal(f.profile.oldProcess, undefined);
        const queue = fs.readFileSync(f.retainedQueue);
        const result = await runFixedProfile(f.profilePin);
        assert.equal(result.status, 'completed', result.error);
        assert.equal(result.journal.backup.reused, true);
        assert.deepEqual(fs.readFileSync(f.database), f.before);
        assert.deepEqual(fs.readFileSync(f.retainedQueue), queue);
        assert.equal(
          JSON.parse(queue).items.filter((item) => item.state === 'queued')
            .length,
          8,
        );
        const { DatabaseSync } = require('node:sqlite'),
          db = new DatabaseSync(f.database, { readOnly: true });
        assert.equal(
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM xhs_unbound_owner_requests WHERE outcome='unknown'",
            )
            .get().n,
          3,
        );
        assert.equal(
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM refresh_submission_claims WHERE state='unknown'",
            )
            .get().n,
          1,
        );
        db.close();
        const registry = read(f.profile.journalFile + '.native-processes');
        assert.equal(registry.processes.length, 1);
        assert.equal(registry.processes[0].releaseId, f.roles.candidate.id);
        assert.equal(registry.oldStopReceipt, undefined);
        assert(
          read(f.profile.journalFile + '.control').events.some(
            (e) => e.stage === 'cold-task-suspended-without-old-instance',
          ),
        );
        assert.equal(
          read(path.join(f.profile.releasesRoot, 'active.json')).id,
          f.roles.candidate.id,
        );
      },
      { coldStart: true },
    ),
);

test(
  'cold census rejects a real non-listening residual writer before pausing or launching',
  { timeout: 240000 },
  () =>
    fixture(
      async (f) => {
        const child = cp.spawn(
          process.execPath,
          ['-e', 'setInterval(()=>{},1000)', f.database],
          { windowsHide: true, stdio: 'ignore' },
        );
        let identity;
        for (let i = 0; i < 50; i++) {
          const tree = f.toolkit.processIdentity(
            'Tree',
            child.pid,
            f.profile.port,
          );
          const row = tree.active.find((x) => x.pid === child.pid);
          if (row) {
            identity = f.toolkit.processIdentity(
              'OwnedSnapshot',
              child.pid,
              f.profile.port,
              row,
            );
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert(identity);
        f.trackCleanup(identity);
        await assert.rejects(
          runFixedProfile(f.profilePin),
          /COLD_PROJECT_WRITERS_REMAIN/,
        );
        assert.equal(fs.existsSync(f.profile.journalFile), false);
        assert.equal(
          read(path.join(f.control, 'fixture-tasks.cjs.state')).enabled,
          true,
        );
        assert.deepEqual(fs.readFileSync(f.database), f.before);
      },
      { coldStart: true },
    ),
);

test(
  'cold admission rejects inability to suspend the task and never creates a service process',
  { timeout: 240000 },
  () =>
    fixture(
      async (f) => {
        await assert.rejects(
          runFixedProfile(f.profilePin),
          /SYNTHETIC_TASK_PAUSE_DENIED/,
        );
        assert.equal(
          read(f.profile.journalFile + '.native-processes').processes.length,
          0,
        );
        assert.equal(fs.existsSync(f.profile.journalFile), false);
        assert.deepEqual(fs.readFileSync(f.database), f.before);
      },
      { coldStart: true, taskPauseFails: true },
    ),
);

test(
  'cold admission rejects changed backup, retaining original data and pointer',
  { timeout: 240000 },
  () =>
    fixture(
      async (f) => {
        fs.appendFileSync(f.profile.backup.path, 'synthetic tamper');
        await assert.rejects(runFixedProfile(f.profilePin));
        assert.equal(
          read(f.profile.journalFile + '.native-processes').processes.length,
          0,
        );
        assert.equal(
          read(path.join(f.profile.releasesRoot, 'active.json')).id,
          f.roles.current.id,
        );
        assert.deepEqual(fs.readFileSync(f.database), f.before);
      },
      { coldStart: true },
    ),
);

test(
  'cold startup health failure stops candidate and recovers the held current release',
  { timeout: 240000 },
  () =>
    fixture(
      async (f) => {
        const result = await runFixedProfile(f.profilePin);
        assert.equal(result.status, 'failed-recovered');
        assert.equal(result.journal.stage, 'recovered');
        assert.equal(
          read(path.join(f.profile.releasesRoot, 'active.json')).id,
          f.roles.current.id,
        );
        assert.deepEqual(fs.readFileSync(f.database), f.before);
        assert(
          read(f.profile.journalFile + '.control').events.some(
            (e) =>
              e.stage === 'restore-verified-already-equal-and-opaque-rebound',
          ),
        );
      },
      { coldStart: true, candidateHealthBad: true },
    ),
);

test(
  'cold admission refuses stale writer evidence rather than deleting it',
  { timeout: 240000 },
  () =>
    fixture(
      async (f) => {
        const gate = require('../project-writer-gate.cjs'),
          file = gate.binding(f.database).file;
        const bytes = Buffer.from('{"synthetic":"unsettled writer evidence"}');
        fs.writeFileSync(file, bytes);
        await assert.rejects(runFixedProfile(f.profilePin));
        assert.deepEqual(fs.readFileSync(file), bytes);
        assert.deepEqual(fs.readFileSync(f.database), f.before);
        assert.equal(
          read(path.join(f.profile.releasesRoot, 'active.json')).id,
          f.roles.current.id,
        );
      },
      { coldStart: true },
    ),
);
