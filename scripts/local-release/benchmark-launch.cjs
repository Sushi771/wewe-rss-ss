// Offline, disposable comparison. It never stops/starts production port 4000.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const {
  fileHash,
  verifyRelease,
  verifyRunningRelease,
  cleanEnvironment,
  run,
} = require('./lib.cjs');
const { processIdentity, unusedPort } = require('./switch.cjs');
const { commandLine, controlledRestart } = require('./restart.cjs');

async function benchmark({
  release,
  database,
  resumeReport,
  baselineRef = 'HEAD',
}) {
  release = fs.realpathSync(release);
  database = fs.realpathSync(database);
  const root = path.resolve(__dirname, '../..');
  const report =
    resumeReport ||
    path.join(root, 'output/playwright/launch-benchmark', String(Date.now()));
  fs.mkdirSync(report, { recursive: true });
  const measurements = resumeReport
    ? JSON.parse(fs.readFileSync(path.join(report, 'progress.json')))
    : [];
  async function measure(label, operation) {
    const start = performance.now();
    const result = await operation();
    const row = { label, ms: Math.round(performance.now() - start) };
    measurements.push(row);
    fs.writeFileSync(
      path.join(report, 'progress.json'),
      JSON.stringify(measurements),
    );
    console.log(JSON.stringify(row));
    return result;
  }
  const { old, identity } = await (async () => {
    if (resumeReport)
      return {
        old: JSON.parse(fs.readFileSync(path.join(release, 'release.json'))),
        identity: processIdentity('Discover', undefined, 4000),
      };
    const old = await measure('baseline-full-audit', () =>
      verifyRelease(release),
    );
    const owners = await measure('baseline-port', () =>
      processIdentity('Port', undefined, 4000),
    );
    assert.equal(
      owners.length,
      1,
      'Benchmark needs one existing production listener',
    );
    const identity = await measure('baseline-snapshot', () =>
      processIdentity('Snapshot', owners[0].OwningProcess, 4000),
    );
    const expected = await measure('baseline-command-audit', () =>
      commandLine(release, database, 4000),
    );
    assert.equal(identity.commandLine, expected);
    assert.equal(
      identity.executable.toLowerCase(),
      path.join(release, 'runtime/node.exe').toLowerCase(),
    );
    await measure('optimized-warm-guard', async () => {
      const live = processIdentity('Discover', undefined, 4000);
      const manifest = verifyRunningRelease(release);
      assert.equal(
        live.commandLine,
        commandLine(release, database, 4000, manifest),
      );
      assert.equal(
        live.executable.toLowerCase(),
        path.join(release, 'runtime/node.exe').toLowerCase(),
      );
      assert.equal(live.startUtc, identity.startUtc);
      const response = await fetch(
        'http://127.0.0.1:4000/dash/tools/article-download',
        { redirect: 'manual', signal: AbortSignal.timeout(1500) },
      );
      assert.ok(response.ok || response.status === 302);
      await response.body?.cancel();
    });
    return { old, identity };
  })();
  const copy = path.join(report, 'source.db');
  if (!fs.existsSync(copy))
    run(
      process.env.SQLITE_BACKUP_PYTHON || 'python',
      [
        '-c',
        'import sqlite3,sys; from pathlib import Path; s=sqlite3.connect(Path(sys.argv[1]).as_uri()+"?mode=ro",uri=True); d=sqlite3.connect(sys.argv[2]); s.backup(d); d.close(); s.close()',
        database,
        copy,
      ],
      { env: cleanEnvironment() },
    );
  // Copy the committed baseline controller into an ignored isolated root so
  // its reports/backups never touch the main checkout. Keep its own verifier.
  const baselineRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wlb-'));
  const baseline = path.join(baselineRoot, 'scripts/local-release');
  fs.mkdirSync(baseline, { recursive: true });
  for (const file of [
    'lib.cjs',
    'restart.cjs',
    'switch.cjs',
    'active-release.cjs',
    'process-identity.ps1',
    'tcp-listeners.ps1',
  ]) {
    const content = execFileSync(
      'git',
      ['show', baselineRef + ':scripts/local-release/' + file],
      { cwd: root },
    );
    fs.writeFileSync(path.join(baseline, file), content);
  }
  fs.mkdirSync(
    path.join(baselineRoot, 'output/playwright/local-release-audit'),
    { recursive: true },
  );
  fs.mkdirSync(path.join(root, 'output/playwright/local-release-audit'), {
    recursive: true,
  });
  const before = require(path.join(baseline, 'restart.cjs'));
  const port = await unusedPort();
  const baselineResult = await measure('baseline-cold-controlled', () =>
    before.controlledRestart({
      release,
      database: copy,
      mode: 'start',
      production: false,
      rehearsal: true,
      port,
    }),
  );
  const target = path.join(root, '.local-releases', old.id + '-launch-test');
  fs.mkdirSync(target, { recursive: true });
  const links = [];
  function clone(relative = '') {
    for (const item of fs.readdirSync(path.join(release, relative), {
      withFileTypes: true,
    })) {
      const next = path.join(relative, item.name);
      if (item.isSymbolicLink()) links.push(next);
      else if (item.isDirectory()) {
        fs.mkdirSync(path.join(target, next));
        clone(next);
      } else
        fs.copyFileSync(
          path.join(release, next),
          path.join(target, next),
          fs.constants.COPYFILE_EXCL,
        );
    }
  }
  clone();
  for (const link of links) {
    const resolved = fs.realpathSync(path.join(release, link));
    const relative = path.relative(release, resolved);
    assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative));
    fs.symlinkSync(
      path.join(target, relative),
      path.join(target, link),
      'junction',
    );
  }
  for (const file of ['lib.cjs', 'runtime.cjs', 'inspect-sqlite.py']) {
    fs.copyFileSync(path.join(__dirname, file), path.join(target, file));
    old.files[file] = fileHash(path.join(target, file));
  }
  old.id = path.basename(target);
  old.startupInspection =
    old.schemaCompatibility === 'current' ? 'schema-only-v1' : 'full';
  fs.writeFileSync(
    path.join(target, 'release.json'),
    JSON.stringify(old, null, 2) + '\n',
  );
  await measure('optimized-first-full-audit', () =>
    verifyRelease(target, { reuseVerified: true }),
  );
  await measure('optimized-reused-audit', () =>
    verifyRelease(target, { reuseVerified: true }),
  );
  const optimizedResult = await measure('optimized-cold-controlled', () =>
    controlledRestart({
      release: target,
      database: copy,
      mode: 'start',
      production: false,
      rehearsal: true,
      reuseVerified: true,
      port,
    }),
  );
  for (const result of [baselineResult, optimizedResult]) {
    assert.equal(result.passed, true);
    const guard = JSON.parse(
      fs.readFileSync(path.join(result.audit, 'new-guard.json')),
    );
    assert.equal(guard.blockedNetwork, 0);
    assert.equal(guard.blockedChildren, 0);
    const before = JSON.parse(
      fs.readFileSync(path.join(result.audit, 'final-baseline.json')),
    );
    const inspect = JSON.parse(
      run('python', [
        path.join(release, 'inspect-sqlite.py'),
        '--database',
        result.database,
        '--migrations',
        path.join(release, 'server/prisma/migrations'),
        '--require-current',
        '--baseline',
        path.join(result.audit, 'final-baseline.json'),
      ]),
    );
    assert.deepEqual(inspect.tables, before.tables);
  }
  assert.equal(
    processIdentity('Discover', undefined, 4000).startUtc,
    identity.startUtc,
  );
  const summary = {
    measurements,
    productionPidUnchanged: identity.pid,
    port,
    files: Object.keys(old.files).length,
    report,
    baselineAudit: baselineResult.audit,
    optimizedAudit: optimizedResult.audit,
  };
  fs.writeFileSync(
    path.join(report, 'measurements.json'),
    JSON.stringify(summary, null, 2) + '\n',
  );
  console.log(JSON.stringify({ report }));
  return summary;
}
if (require.main === module) {
  const { values } = parseArgs({
    options: {
      release: { type: 'string' },
      database: { type: 'string' },
      'resume-report': { type: 'string' },
      'baseline-ref': { type: 'string' },
    },
  });
  if (!values.release || !values.database)
    throw new Error('Specify --release and --database absolute paths');
  benchmark({
    ...values,
    resumeReport: values['resume-report'],
    baselineRef: values['baseline-ref'],
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
module.exports = { benchmark };
