'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
// The production coordinator now imports the incremental-write graph. Use the
// project's installed TS compiler for its extensionless CommonJS imports, as
// the application build does, instead of Node's standalone type stripping.
require('ts-node').register({
  transpileOnly: true,
  project: path.join(__dirname, '../tsconfig.json'),
  compilerOptions: { module: 'CommonJS', incremental: false },
});
const {
  SqliteWriteCoordinator,
} = require('../src/collection/sqlite-write-coordinator.ts');
const {
  reuseVerifiedSqliteBackup,
  activeVerifiedBackupReferences,
} = require('../src/collection/sqlite-backup-reuse.ts');
const {
  exchange,
  withRuntimeReferences,
  safeDiagnostic,
} = require('./article-history-runtime.cjs');
const python =
  process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

for (let round = 1; round <= 3; round++)
  test(
    `real Node coordinator -> existing owner pipe -> archive/browser -> exact review/approval, consecutive run ${round}`,
    { timeout: 240000 },
    async () => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), 'history-node-e2e-'),
      );
      let child;
      try {
        const setup = spawnSync(
          python,
          [
            '-c',
            `import sys,json,pathlib;sys.path.insert(0,sys.argv[1]);from test_article_history import database;p=pathlib.Path(sys.argv[2]);(p/'old').mkdir();(p/'recoveries').mkdir();[database(f) for f in [p/'live.db',p/'old'/'old.db',p/'recoveries'/'previous.db']];(p/'active.json').write_text(json.dumps({'format':'article-history-references-v1','paths':[str(p/'live.db')]}))`,
            __dirname,
            root,
          ],
          { encoding: 'utf8', windowsHide: true },
        );
        assert.equal(setup.status, 0, setup.stderr);
        const config = {
          sourceRoots: [path.join(root, 'old')],
          recoveryRoots: [path.join(root, 'recoveries')],
          archiveRoot: path.join(root, 'archives'),
          previous: path.join(root, 'recoveries/previous.db'),
          referenceFiles: [path.join(root, 'active.json')],
        };
        child = spawn(
          python,
          [
            path.join(__dirname, 'sqlite-snapshot-guard.py'),
            '--database',
            path.join(root, 'live.db'),
            '--backup-root',
            path.join(root, 'recoveries'),
          ],
          {
            windowsHide: true,
            env: {
              ...process.env,
              SQLITE_ARTICLE_HISTORY_REVIEW_ENABLED: '1',
              SQLITE_ARTICLE_HISTORY_MAINTENANCE_WINDOW: '1',
              SQLITE_ARTICLE_HISTORY_HOST_CONFIG: JSON.stringify(config),
            },
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        );
        let errors = '';
        child.stderr.on('data', (data) => {
          if (errors.length < 2000) errors += data;
        });
        const coordinator = new SqliteWriteCoordinator(300000);
        const dependencies = {
          coordinator,
          activeBackupReferences: activeVerifiedBackupReferences,
          request: (operation, payload) => exchange(child, operation, payload),
        };
        const old = path.join(root, 'old/old.db');
        const result = await withRuntimeReferences(
          dependencies,
          'history-review',
          { sources: [old] },
        );
        const plan = result.review;
        assert.ok(plan, errors);
        assert.equal(plan.executable, false);
        assert.equal(plan.coverage.browser.remoteRequests, 0);
        assert.equal(
          plan.eligible.length,
          process.platform === 'win32' ? 1 : 0,
        );
        if (process.platform === 'win32') {
          const approved = await withRuntimeReferences(
            dependencies,
            'history-validate-approval',
            {
              plan,
              approval: {
                action: 'permanent-delete-exact-files',
                batchSha256: plan.batchSha256,
                paths: [plan.eligible[0].identity.main.path],
                approvedAtEpoch: Math.floor(Date.now() / 1000),
              },
            },
          );
          assert.equal(approved.approvedForReview, true);
          assert.equal(approved.permanentDeletionPerformed, false);
        }
        assert.ok((await fs.stat(old)).size < 100000);
      } finally {
        if (child) {
          const stopped = once(child, 'close');
          child.stdin.end();
          const timer = setTimeout(() => child.kill(), 5000);
          await stopped;
          clearTimeout(timer);
        }
        // This test's own mkdtemp path only; no production or arbitrary directory.
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

test('private owner failures preserve only allowlisted diagnostics without retry', async () => {
  const { PassThrough, Writable } = require('node:stream');
  const { EventEmitter } = require('node:events');
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  let calls = 0;
  child.stdin = new Writable({
    write(data, encoding, done) {
      calls++;
      const request = JSON.parse(data);
      process.nextTick(() =>
        child.stdout.write(
          JSON.stringify({
            id: request.id,
            result: {
              reason: 'HISTORY_REVIEW_FAILED',
              diagnostic: {
                format: 'article-history-diagnostic-v1',
                stage: 'coverage',
                errorType: 'BrowserCheckError',
                code: 'UNCLASSIFIED',
                message: 'private path/SQL/token',
                browser: {
                  phase: 'startup',
                  errorType: 'Error',
                  code: 'STARTUP_EXHAUSTED',
                  resourceCode: 'EBUSY',
                  attempts: 120,
                  path: 'private',
                },
              },
            },
          }) + '\n',
        ),
      );
      done();
    },
  });
  await assert.rejects(exchange(child, 'history-review'), (error) => {
    assert.match(
      error.message,
      /coverage\/BrowserCheckError\/UNCLASSIFIED\/startup\/STARTUP_EXHAUSTED/,
    );
    assert.equal(error.diagnostic.browser.resourceCode, 'EBUSY');
    assert.equal(error.diagnostic.browser.attempts, 120);
    assert.doesNotMatch(JSON.stringify(error.diagnostic), /private|SQL|token/);
    return true;
  });
  assert.equal(calls, 1);
  child.stdout.destroy();
});

test('unrecognized diagnostic classifications remain sanitized and unknown', () => {
  const result = safeDiagnostic({
    format: 'article-history-diagnostic-v1',
    stage: 'private/path',
    errorType: 'private token',
    code: 'private SQL',
    browser: {
      phase: 'secret',
      code: 'secret',
      errorType: 'secret',
      extra: 'secret',
    },
  });
  assert.equal(result.stage, 'owner-request');
  assert.equal(result.errorType, 'UnknownError');
  assert.equal(result.browser.code, 'UNCLASSIFIED');
  assert.doesNotMatch(JSON.stringify(result), /private|secret/);
});

test('actual write coordinator holds queued writes during runtime capture and owner review', async () => {
  const coordinator = new SqliteWriteCoordinator(1000);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let reviewing;
  const started = new Promise((resolve) => {
    reviewing = resolve;
  });
  const run = withRuntimeReferences(
    {
      coordinator,
      activeBackupReferences: () => ['synthetic.db'],
      request: async (op, payload) => {
        if (op === 'history-sync') {
          assert.deepEqual(payload.runtime.paths, ['synthetic.db']);
          return { runtimeReferencesSynced: true };
        }
        reviewing();
        await gate;
        return { review: true };
      },
    },
    'history-review',
    { sources: [] },
  );
  await started;
  let wrote = false;
  const write = coordinator.write(async () => {
    wrote = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(wrote, false);
  release();
  await run;
  await write;
  assert.equal(wrote, true);
});

test('real backup reuse cache is included in active file references', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'history-cache-test-'));
  try {
    const source = path.join(root, 'source.db'),
      saved = path.join(root, 'saved.db');
    const setup = spawnSync(
      python,
      [
        '-c',
        'import sqlite3,sys;d=sqlite3.connect(sys.argv[1]);d.execute("CREATE TABLE t(id INT)");d.commit();d.close()',
        source,
      ],
      { windowsHide: true },
    );
    assert.equal(setup.status, 0);
    const coordinator = new SqliteWriteCoordinator();
    await coordinator.snapshot(() =>
      reuseVerifiedSqliteBackup(source, async () => {
        await fs.copyFile(source, saved);
        return { backup: saved, sha256: 'a'.repeat(64) };
      }),
    );
    assert.ok(activeVerifiedBackupReferences().includes(saved));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
