// Exercise real execute() and Node child lifetime using only owned inert files.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const sourceFile = path.resolve(__dirname, '../once-pair-publication.test.cjs');
const text = fs.readFileSync(sourceFile, 'utf8');
const end = text.indexOf("for (const mode of ['upgrade',");
assert(end > 0);
// Reuse the existing finite fixture definitions without registering its tests.
const fixture = new Function(
  'require',
  '__dirname',
  text.slice(0, end) + '\nreturn maintenanceFixture;',
)(require('node:module').createRequire(sourceFile), path.dirname(sourceFile));
const stem = process.argv[2];
assert(
  stem &&
    fs.realpathSync.native(path.dirname(stem)).includes('wewe-hold-exit-'),
);
fixture(async (f) => {
  f.failAt = 'candidate-health';
  const start = f.operations.start,
    facts = f.facts;
  let child;
  f.operations.start = (release, options) => {
    const fake = start(release, options);
    if (path.basename(release) !== 'rollback') return fake;
    child = cp.spawn(
      process.execPath,
      [
        '-e',
        "const fs=require('node:fs'),p=process.argv[1];fs.writeFileSync(p+'.started','alive');setTimeout(()=>fs.writeFileSync(p+'.done','natural-exit'),10000);",
        stem,
      ],
      { stdio: 'ignore', detached: true, windowsHide: true, shell: false },
    );
    f.service().pid = child.pid;
    const unref = child.unref;
    child.unref = () => {
      assert.equal(f.maintenanceRecord().status, 'hold');
      return unref.call(child);
    };
    return child;
  };
  f.facts = () =>
    f.maintenanceRecord().service && f.maintenanceRecord().recoverySpent
      ? { ...facts(), complete: false, errors: ['REFERENCE_QUERY_FAILED'] }
      : facts();
  await assert.rejects(f.maintenance(), /REFERENCE_QUERY_INCOMPLETE/);
  const record = f.maintenanceRecord();
  assert.equal(record.status, 'hold');
  assert.equal(record.recoverySpent, true);
  assert.equal(record.publicationSpent, false);
  assert.equal(record.service.pid, child.pid);
  console.log(
    JSON.stringify({
      status: record.status,
      childPid: child.pid,
      recoverySpent: record.recoverySpent,
      publicationSpent: record.publicationSpent,
    }),
  );
  // Match the actual CLI rejection boundary: exitCode, no process.exit/kill.
  process.exitCode = 1;
}).catch((e) => {
  console.error(e);
  process.exitCode = 2;
});
