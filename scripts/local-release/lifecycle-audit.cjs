// Read-only implementation review: creates and removes only its own tiny fixtures.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { fork, execFileSync } = require('node:child_process');
const repository =
  process.env.LIFECYCLE_REPOSITORY || path.resolve(__dirname, '../..');
const scripts = path.join(repository, 'scripts/local-release');
const artifacts = require(path.join(scripts, 'test-artifacts.cjs'));
const budget = require(path.join(scripts, 'space-budget.cjs'));
const migrations = path.join(repository, 'apps/server/prisma/migrations');
if (process.argv[2] === '--owner') {
  const run = artifacts.begin({ outputRoot: process.argv[3], migrations });
  process.send({ audit: run.audit, database: run.database });
  setInterval(() => {}, 1000);
} else
  (async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'wewe-lifecycle-audit-'),
    );
    const managed = path.join(root, 'managed');
    const previousManaged = process.env.WEWE_TEST_OUTPUT_ROOT;
    process.env.WEWE_TEST_OUTPUT_ROOT = managed;
    const findings = {};
    let child;
    try {
      const normal = artifacts.begin({
        outputRoot: path.join(managed, 'normal'),
        migrations,
      });
      const normalSize = fs.statSync(normal.database).size;
      normal.finish(new Error('injected ordinary exception'));
      findings.ordinaryFailure = {
        databaseBytes: normalSize,
        remaining: budget.usage(normal.audit),
        report: fs.existsSync(path.join(normal.audit, 'space-summary.json')),
      };
      assert.equal(findings.ordinaryFailure.remaining.databases, 0);

      const source = path.join(root, 'source.db');
      execFileSync(
        process.env.SQLITE_BACKUP_PYTHON || 'python',
        [
          path.join(scripts, 'synthetic-sqlite.py'),
          '--database',
          source,
          '--migrations',
          migrations,
        ],
        {
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
          windowsHide: true,
        },
      );
      const sourceBytes = fs.readFileSync(source);
      const real = artifacts.begin({
        outputRoot: path.join(managed, 'real'),
        source,
        realCopy: true,
        migrations,
      });
      fs.copyFileSync(source, path.join(real.audit, 'rehearsal.db'));
      real.finish(new Error('injected real-copy exception'));
      assert.deepEqual(fs.readFileSync(source), sourceBytes);
      findings.optInCopyFailure = {
        keepRequested: false,
        sourcePreserved: true,
        remaining: budget.usage(real.audit),
      };

      const upper = artifacts.begin({
        outputRoot: path.join(managed, 'uppercase'),
        migrations,
      });
      fs.copyFileSync(upper.database, path.join(upper.audit, 'copy.SQLITE'));
      upper.finish();
      findings.uppercaseCleanup = budget.usage(upper.audit);

      const first = artifacts.begin({
        outputRoot: path.join(managed, 'window-a'),
        migrations,
      });
      let second;
      try {
        try {
          second = artifacts.begin({
            outputRoot: path.join(managed, 'window-b'),
            migrations,
          });
          findings.separateOutputRoots = {
            simultaneousRuns: 2,
            sharedReservation: false,
          };
        } catch (error) {
          findings.separateOutputRoots = {
            simultaneousRuns: 1,
            sharedReservation: /locked/.test(error.message),
          };
        }
      } finally {
        second?.finish();
        first.finish();
      }

      const killedRoot = path.join(managed, 'killed');
      child = fork(__filename, ['--owner', killedRoot], {
        env: { ...process.env, LIFECYCLE_REPOSITORY: repository },
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      const ready = await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('owner ready timeout')),
          15000,
        );
        child.once('message', (value) => {
          clearTimeout(timer);
          resolve(value);
        });
        child.once('error', reject);
        child.once('exit', () => {
          clearTimeout(timer);
          reject(new Error('owner exited before ready'));
        });
      });
      await new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill('SIGKILL');
      });
      findings.forcedTermination = {
        remaining: budget.usage(ready.audit),
        lockRemains: fs.existsSync(path.join(managed, '.test-run.lock')),
        report: fs.existsSync(path.join(ready.audit, 'space-summary.json')),
      };
      try {
        artifacts.begin({ outputRoot: killedRoot, migrations });
      } catch (error) {
        findings.forcedTermination.retryError = error.message.split(':')[0];
      }
      const build = fs.readFileSync(path.join(scripts, 'build.cjs'), 'utf8');
      const resume = fs.readFileSync(
        path.join(scripts, 'resume-legacy.cjs'),
        'utf8',
      );
      findings.sourceInspection = {
        buildImportsGuard:
          /require\(['"]\.\/(?:space-budget|test-artifacts)\.cjs/.test(build),
        resumeImportsGuard:
          /require\(['"]\.\/(?:space-budget|test-artifacts)\.cjs/.test(resume),
      };
      assert(budget.usage(root).bytes < 16 * 1024 ** 2);
      console.log(
        JSON.stringify(
          {
            findings,
            auditFixtureBytesBeforeCleanup: budget.usage(root).bytes,
          },
          null,
          2,
        ),
      );
    } finally {
      if (previousManaged === undefined)
        delete process.env.WEWE_TEST_OUTPUT_ROOT;
      else process.env.WEWE_TEST_OUTPUT_ROOT = previousManaged;
      if (child && child.exitCode === null && child.signalCode === null)
        await new Promise((resolve) => {
          child.once('exit', resolve);
          child.kill('SIGKILL');
        });
      assert.equal(path.dirname(root), fs.realpathSync.native(os.tmpdir()));
      assert(path.basename(root).startsWith('wewe-lifecycle-audit-'));
      fs.rmSync(root, { recursive: true, force: true });
      console.log(
        JSON.stringify({ ownTemporaryRootRemoved: !fs.existsSync(root) }),
      );
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
