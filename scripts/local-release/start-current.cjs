'use strict';
// Normal start of the immutable active package; no build, install, switch or old release-scope policy.
const fs = require('node:fs'),
  path = require('node:path'),
  cp = require('node:child_process'),
  assert = require('node:assert/strict'),
  crypto = require('node:crypto');
const hash = (p) =>
  crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
async function startCurrent({
  root,
  release,
  database,
  recoveryRelease = release,
  wechatRecordDir,
  rehearsal,
}) {
  const port = rehearsal ? Number(rehearsal.port) : 4000;
  if (rehearsal) {
    const base = fs.realpathSync.native(rehearsal.root);
    const inside = (p) => {
      const r = path.relative(base, fs.realpathSync.native(p));
      return (
        r !== '' &&
        r !== '..' &&
        !r.startsWith('..' + path.sep) &&
        !path.isAbsolute(r)
      );
    };
    if (
      !Number.isInteger(port) ||
      port < 1024 ||
      port > 65535 ||
      port === 4000 ||
      !inside(root) ||
      !inside(database) ||
      !inside(release) ||
      !inside(recoveryRelease) ||
      !inside(rehearsal.obsidianRoot) ||
      !inside(path.dirname(rehearsal.guardReport)) ||
      (wechatRecordDir !== undefined && !inside(wechatRecordDir))
    )
      throw Error('NORMAL_START_REHEARSAL_INVALID');
  }
  const lib = require(path.join(root, 'scripts/local-release/lib.cjs')),
    ctl = require(path.join(root, 'scripts/local-release/switch.cjs')),
    restart = require(path.join(root, 'scripts/local-release/restart.cjs'));
  const lock = require('./normal-start-lock.cjs'),
    a = lock.acquire(path.join(root, '.local-releases/.build-budget.lock'));
  let b;
  try {
    b = lock.acquire(path.join(root, '.active-release.lock'));
    const own = () => {
      a.assertOwned();
      b.assertOwned();
    };
    own();
    const manifest = lib.verifyRelease(release),
      pointer = path.join(root, '.local-releases/active.json'),
      pointerRaw = fs.readFileSync(pointer);
    assert.equal(JSON.parse(pointerRaw).id, manifest.id);
    assert.equal(
      fs.realpathSync.native(release),
      path.join(root, '.local-releases', manifest.id),
    );
    const commandFor = (bundle, info) => {
      if (!rehearsal) return restart.commandLine(bundle, database, port, info);
      const args = [
        path.join(bundle, 'runtime.cjs'),
        'start',
        '--database',
        database,
        '--port',
        String(port),
      ];
      if (info.desktopHelperIncluded)
        args.push(
          '--pause-file',
          path.join(root, 'tools/wechat-desktop-collector/.paused'),
        );
      args.push(
        '--rehearsal',
        '--obsidian-root',
        rehearsal.obsidianRoot,
        '--guard-report',
        rehearsal.guardReport,
      );
      return restart.launchCommandLine(
        path.join(bundle, 'runtime/node.exe'),
        args,
      );
    };
    const command = commandFor(release, manifest),
      executable = path.join(release, 'runtime/node.exe');
    assert.equal(hash(executable), manifest.files['runtime/node.exe']);
    const existing = ctl.processIdentity('Discover', undefined, port);
    if (existing) {
      assert.equal(existing.commandLine, command);
      assert.equal(existing.executable.toLowerCase(), executable.toLowerCase());
      if (process.env.WECHAT2RSS_RECOVERY_HOLD === '1') {
        await require('./held-management-readiness.cjs').waitHeldManagementReady(
          port,
          null,
          {
            id: manifest.id,
            sha256: hash(path.join(release, 'release.json')),
            database,
          },
        );
        const after = ctl.processIdentity('Snapshot', existing.pid, port);
        assert.equal(after.startUtc, existing.startUtc);
        assert.equal(after.commandLine, command);
        assert.equal(after.executable.toLowerCase(), executable.toLowerCase());
        own();
        assert(
          fs.readFileSync(pointer).equals(pointerRaw),
          'HELD_ACTIVE_POINTER_CHANGED',
        );
        return {
          newIdentity: after,
          normalStart: true,
          alreadyRunning: true,
          readiness: 'held-local-management',
        };
      }
      const h = await fetch(`http://127.0.0.1:${port}/startup-status`, {
        signal: AbortSignal.timeout(8000),
      });
      assert(h.ok && (await h.json()).status === 'ready');
      return { newIdentity: existing, normalStart: true, alreadyRunning: true };
    }
    if (!rehearsal) ctl.loadProductionEnvironment();
    assert(
      process.env.PRIVATE_ONLINE_MODE !== '1' &&
        process.env.WEWE_ACCEPTANCE_MODE !== '1',
      'NORMAL_START_MODE_REQUIRES_REVIEW',
    );
    const recoveryManifest =
      recoveryRelease === release
        ? manifest
        : lib.verifyRelease(recoveryRelease);
    const recoveryCommand = commandFor(recoveryRelease, recoveryManifest);
    const gateFile = path.join(release, 'project-writer-gate.cjs');
    assert.equal(hash(gateFile), manifest.files['project-writer-gate.cjs']);
    const gate = require(gateFile);
    const helperEnv = Object.fromEntries(
      ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'COMSPEC']
        .filter((k) => process.env[k])
        .map((k) => [k, process.env[k]]),
    );
    const ps = path.join(
        process.env.SystemRoot,
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      ),
      observer = path.join(__dirname, 'observe-writer-exit.ps1');
    // Deployment must pin these controller files as a unit. No external receipt is accepted.
    const observerHash = hash(observer);
    const recovery = require('./writer-exit-recovery.cjs').recover({
      root,
      database,
      gate,
      sessions: [a, b],
      expected: {
        executableHash: recoveryManifest.files['runtime/node.exe'],
        commandHash: crypto
          .createHash('sha256')
          .update(recoveryCommand)
          .digest('hex'),
      },
      probe(record) {
        own();
        assert.equal(hash(observer), observerHash);
        const v = JSON.parse(
          cp.execFileSync(
            ps,
            [
              '-NoProfile',
              '-NonInteractive',
              '-File',
              observer,
              '-OwnerPid',
              String(record.pid),
              '-OwnerStartUtc',
              record.startUtc,
            ],
            {
              env: helperEnv,
              encoding: 'utf8',
              windowsHide: true,
              timeout: 16000,
              maxBuffer: 65536,
            },
          ),
        );
        v.portOwners = ctl.processIdentity('Port', undefined, port);
        own();
        return v;
      },
    });
    own();
    assert(fs.readFileSync(pointer).equals(pointerRaw));
    assert.equal(ctl.processIdentity('Discover', undefined, port), null);
    if (wechatRecordDir !== undefined) {
      if (
        !['no-lease', 'preserved-abnormal-exit-lease'].includes(recovery.status)
      )
        throw Error('WECHAT_RECOVERY_UNPROVEN');
      const entry = path.join(release, 'server/wechat-gate-checkpoint.cjs');
      assert.equal(
        hash(entry),
        manifest.files['server/wechat-gate-checkpoint.cjs'],
      );
      const lease = gate.acquireWriter(database);
      const boundary = {
        check() {
          own();
          assert(fs.readFileSync(pointer).equals(pointerRaw));
          assert.equal(ctl.processIdentity('Discover', undefined, port), null);
        },
        observe() {
          this.check();
        },
      };
      require(entry).performWechatGate(
        database,
        wechatRecordDir,
        lease,
        boundary,
      );
    }
    // The original configuration is loaded internally and passed only to the application child.
    const args = [
      path.join(release, 'runtime.cjs'),
      'start',
      '--database',
      database,
      '--port',
      String(port),
    ];
    if (manifest.desktopHelperIncluded)
      args.push(
        '--pause-file',
        path.join(root, 'tools/wechat-desktop-collector/.paused'),
      );
    if (rehearsal)
      args.push(
        '--rehearsal',
        '--obsidian-root',
        rehearsal.obsidianRoot,
        '--guard-report',
        rehearsal.guardReport,
      );
    else args.push('--production');
    const managedEnv = require('./managed-runtime-mode.cjs').committed({
      journalFile: path.join(path.dirname(database), '.wewe-update.json'),
      releaseId: manifest.id,
      manifestSha256: hash(path.join(release, 'release.json')),
      database,
    });
    const env = lib.cleanEnvironment({
      NODE_ENV: 'production',
      XHS_SUBSCRIPTION_LIVE_ENABLED: rehearsal ? '0' : '1',
      XHS_COMMENT_COLLECTION_ENABLED: '0',
      ...managedEnv,
      PYTHONDONTWRITEBYTECODE: '1',
      LOCAL_RELEASE_CONTROLLED_START: manifest.id,
      LOCAL_RELEASE_STARTUP_AUDIT_ROOT: '',
    });
    const child = cp.spawn(executable, args, {
      cwd: path.join(release, 'server'),
      env,
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
    });
    // Failure retains a real live/unknown writer lease; never kill or manufacture an exit receipt.
    child.on('error', () => {});
    child.unref();
    if (process.env.WECHAT2RSS_RECOVERY_HOLD === '1')
      await require('./held-management-readiness.cjs').waitHeldManagementReady(
        port,
        child,
        {
          id: manifest.id,
          sha256: hash(path.join(release, 'release.json')),
          database,
        },
      );
    else await ctl.waitReady(port, child);
    own();
    const health = await fetch(`http://127.0.0.1:${port}/startup-status`, {
      signal: AbortSignal.timeout(8000),
    });
    assert(health.ok && (await health.json()).status === 'ready');
    const observed = ctl.processIdentity('Snapshot', child.pid, port);
    assert.equal(observed.commandLine, command);
    assert.equal(observed.executable.toLowerCase(), executable.toLowerCase());
    assert(fs.readFileSync(pointer).equals(pointerRaw));
    child.unref();
    return {
      newIdentity: observed,
      normalStart: true,
      recovery: recovery.status,
      exitReason: recovery.reason,
    };
  } finally {
    try {
      if (b) b.release();
    } finally {
      a.release();
    }
  }
}
module.exports = { startCurrent };
