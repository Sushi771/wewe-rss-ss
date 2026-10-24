// Opt-in integration drill. Only newly allocated synthetic files and loopback.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { once } = require('node:events');
const { spawn, execFileSync } = require('node:child_process');
const scope = require('./release-scope.cjs');
const { build, SERVER_HELPERS } = require('./build.cjs');
const { fileHash, verifyRelease } = require('./lib.cjs');

test(
  'one committed source rebuilds, restores one synthetic point and starts with matching data',
  {
    skip:
      process.env.WEWE_OFFLINE_REBUILD !== '1' || process.platform !== 'win32',
    timeout: 360000,
  },
  async () => {
    const source = path.resolve(__dirname, '../..');
    const audit = path.join(
      source,
      'output/release-repro',
      crypto.randomUUID(),
    );
    const output = path.join(audit, 'packages');
    fs.mkdirSync(output, { recursive: true });
    const options = { compact: true, buildOnly: true, outputRoot: output };
    const plan = build({ ...options, plan: true });
    assert(
      plan.reserveBytes <= scope.DEFAULT_BYTES,
      'Existing release space ceiling must suffice',
    );
    const policy = {
      format: 1,
      scopeId: crypto.randomUUID(),
      phase: 'build-only',
      registryDirectory: fs.realpathSync.native(audit),
      registryIdentity: scope.inspect([audit]).roots[0].identity,
      ...scope.inspect([output]),
      maxBytes: scope.DEFAULT_BYTES,
      maxGrowthBytes: scope.DEFAULT_BYTES,
      maxNewRuntimeCopies: 1,
      protectedIds: ['synthetic-only'],
      buildOnly: plan.buildOnly,
    };
    const config = path.join(audit, 'build-only-policy.json');
    fs.writeFileSync(config, JSON.stringify(policy));
    // These are new, empty test roots. This synthetic reference provider exercises
    // the regular build-only scope without inspecting any installed application.
    const facts = {
      complete: true,
      categories: Object.fromEntries(
        [
          'processes',
          'tasks',
          'shortcuts',
          'pointers',
          'rollback',
          'inflight',
        ].map((k) => [k, true]),
      ),
      records: [],
      errors: [],
      uncertainChildren: [],
      compatibility: { stage: 'build-only', verified: false },
    };
    const release = build({
      ...options,
      scopeOptions: {
        configPath: config,
        configSha256: fileHash(config),
        query: () => structuredClone(facts),
      },
    });
    const manifest = verifyRelease(release);
    assert.equal(manifest.sourceCommit, manifest.toolingCommit);
    assert.equal(manifest.provenance.composition, 'single-source');
    assert.equal(manifest.provenance.runtimeTextEncoding, 'utf8-crlf-to-lf-v1');
    for (const name of SERVER_HELPERS) {
      const key = 'server/scripts/' + name;
      assert.equal(
        fileHash(path.join(release, key)),
        manifest.provenance.runtimeSources[key].sha256,
      );
    }
    assert.equal(
      fs.readdirSync(path.join(release, 'server/scripts')).length,
      14,
    );
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA)$/i.test(
          key,
        ),
      ),
    );
    const env = {
      ...inherited,
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONUTF8: '1',
      SQLITE_BACKUP_KIND: 'test',
      SQLITE_TEST_MAX_BYTES: String(16 * 1024 ** 2),
      SQLITE_TEST_MAX_COPIES: '4',
      SQLITE_TEST_MIN_FREE_BYTES: '1',
      SQLITE_PRODUCTION_LEGACY_ROOTS: '[]',
      SQLITE_PERIODIC_SNAPSHOT_ENABLED: '0',
      XHS_SUBSCRIPTION_LIVE_ENABLED: '0',
      ENABLE_SCHEDULED_UPDATES: '0',
    };
    const python = process.env.SQLITE_BACKUP_PYTHON || 'python';
    const run = (exe, args) =>
      execFileSync(exe, args, {
        cwd: audit,
        env,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 4 * 1024 ** 2,
      });
    const database = path.join(audit, 'synthetic.db');
    run(python, [
      path.join(source, 'scripts/local-release/synthetic-sqlite.py'),
      '--database',
      database,
      '--migrations',
      path.join(release, 'server/prisma/migrations'),
    ]);
    const backup = JSON.parse(
      run(python, [
        path.join(release, 'server/scripts/backup-sqlite.py'),
        '--database',
        database,
        '--backup-root',
        path.join(audit, 'recovery'),
      ]),
    );
    assert.equal(backup.integrityCheck, 'ok');
    assert.equal(fileHash(backup.backup), backup.sha256);
    const restored = path.join(audit, 'restored.db');
    fs.copyFileSync(backup.backup, restored, fs.constants.COPYFILE_EXCL);
    assert.equal(fileHash(restored), backup.sha256);
    const summarize = (db) =>
      JSON.parse(
        run(python, [
          '-c',
          "import sqlite3,hashlib,json,sys; c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); names=[r[0] for r in c.execute(\"SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name\")]; data={n:sorted(list(c.execute('SELECT * FROM '+chr(34)+n.replace(chr(34),chr(34)*2)+chr(34))),key=lambda r:json.dumps(r,default=str)) for n in names}; print(json.dumps({'integrity':list(c.execute('PRAGMA integrity_check')),'tables':{n:{'rows':len(v),'sha256':hashlib.sha256(json.dumps(v,default=str,ensure_ascii=False).encode()).hexdigest()} for n,v in data.items()}}))",
          db,
        ]),
      );
    const before = summarize(database);
    assert.deepEqual(summarize(restored), before);
    const node = path.join(release, 'runtime/node.exe');
    const probe = run(node, [
      path.join(release, 'runtime.cjs'),
      'probe',
      '--database',
      restored,
    ]);
    assert(probe.includes('runtime-verified'));
    fs.writeFileSync(
      restored + '.rehearsal.json',
      JSON.stringify({ releaseId: manifest.id, database: restored }),
    );
    const listener = net.createServer();
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const port = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
    const guard = path.join(audit, 'external-guard.json');
    const logPath = path.join(audit, 'restored-start.log');
    const log = fs.openSync(logPath, 'wx');
    const child = spawn(
      node,
      [
        path.join(release, 'runtime.cjs'),
        'start',
        '--database',
        restored,
        '--port',
        String(port),
        '--rehearsal',
        '--obsidian-root',
        path.join(audit, 'export'),
        '--guard-report',
        guard,
      ],
      { cwd: audit, env, stdio: ['ignore', log, log], windowsHide: true },
    );
    const closed = once(child, 'close');
    let healthy = false;
    try {
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        if (child.exitCode !== null)
          throw new Error(
            'Restored app exited: ' + fs.readFileSync(logPath, 'utf8'),
          );
        try {
          healthy = (
            await fetch(`http://127.0.0.1:${port}/dash`, {
              signal: AbortSignal.timeout(1000),
            })
          ).ok;
        } catch {
          /* bounded startup wait */
        }
        if (healthy) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert(healthy, 'Restored app must become healthy');
    } finally {
      if (child.exitCode === null) child.kill();
      await closed;
      fs.closeSync(log);
    }
    assert.deepEqual(summarize(restored), before);
    const blocked = JSON.parse(fs.readFileSync(guard, 'utf8'));
    assert.deepEqual(blocked, {
      installed: true,
      blockedNetwork: 0,
      blockedChildren: 0,
    });
    verifyRelease(release); // Startup must not mutate the immutable package.
    const receipt = {
      sourceCommit: manifest.sourceCommit,
      sourceHash: manifest.sourceHash,
      releaseId: manifest.id,
      helperCount: 14,
      recoveryPointsCreated: 1,
      restoredDigestMatches: true,
      healthy,
      processStopped: true,
      externalGuard: blocked,
      node: manifest.provenance.node,
      buildTools: manifest.provenance.buildTools,
      pythonVersion: run(python, ['--version']).trim(),
      tables: before.tables,
    };
    fs.writeFileSync(
      path.join(audit, 'recovery-result.json'),
      JSON.stringify(receipt, null, 2),
    );
    console.log(
      JSON.stringify({
        audit,
        sourceCommit: manifest.sourceCommit,
        helperCount: 14,
        restoredDigestMatches: true,
        healthy,
        processStopped: true,
      }),
    );
  },
);
