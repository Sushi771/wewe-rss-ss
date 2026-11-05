'use strict';

// No process query or database effect at import. Existing Windows identity and
// HTTP checks are reused lazily; tests supply synthetic primitives instead.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(cp.execFile);
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const read = (file) =>
  JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const fail = (code) => {
  throw Error(code);
};
function write(file, value) {
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
}
function createController(config, primitives) {
  for (const name of ['journalFile', 'database', 'releasesRoot'])
    if (!path.isAbsolute(config[name] || ''))
      fail('LIFECYCLE_BINDINGS_REQUIRED');
  const lockFile = config.journalFile + '.startup-lock';
  const registryFile = config.journalFile + '.processes';
  const permitFile = config.journalFile + '.permit';
  let held;
  function native() {
    if (primitives) return primitives;
    // The official builder must pin the complete helper closure in this
    // updater. No arbitrary external toolkit or identity executable is loaded.
    const root = path.join(__dirname, 'native-toolkit');
    if (!config.nativeToolkitFiles || !config.nativeToolkitFiles['switch.cjs'])
      fail('PINNED_NATIVE_TOOLKIT_REQUIRED');
    for (const [name, expected] of Object.entries(config.nativeToolkitFiles)) {
      if (name.split(/[\\/]/).includes('..') || path.isAbsolute(name))
        fail('NATIVE_TOOLKIT_PATH_INVALID');
      const file = path.join(root, name),
        stat = fs.lstatSync(file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        hash(fs.readFileSync(file)) !== expected
      )
        fail('NATIVE_TOOLKIT_INTEGRITY_FAILED');
    }
    const toolkit = require(path.join(root, 'switch.cjs'));
    primitives = { ...toolkit, spawn: cp.spawn, execute };
    return primitives;
  }
  function registry() {
    if (!fs.existsSync(registryFile))
      fail('LEGACY_WRITER_REGISTRATION_REQUIRED');
    const r = read(registryFile);
    if (
      r.format !== 1 ||
      r.protocol !== 'wewe-installed-lifecycle-v1' ||
      r.database !== config.database ||
      !Array.isArray(r.processes) ||
      !r.processes.length
    )
      fail('WRITER_REGISTRY_INVALID');
    return r;
  }
  function check(ctx) {
    const record = read(lockFile);
    if (
      !held ||
      ctx?.lease !== held ||
      record.token !== held ||
      record.pid !== process.pid
    )
      fail('LIFECYCLE_EXCLUSIVE_LOST');
    return record;
  }
  function protocol(release) {
    const manifest = read(path.join(release.path, 'release.json'));
    const file = path.join(release.path, 'installed-startup-gate.cjs');
    if (
      manifest.installedLifecycle?.protocol !== 'wewe-installed-lifecycle-v1' ||
      manifest.installedLifecycle?.allWriters !== true ||
      manifest.installedLifecycle?.journalBasename !==
        path.basename(config.journalFile) ||
      !fs.existsSync(file) ||
      manifest.files?.['installed-startup-gate.cjs'] !==
        hash(fs.readFileSync(file))
    )
      fail('INSTALLED_STARTUP_GATE_MISSING');
    return manifest;
  }
  async function observe(ctx) {
    check(ctx);
    const r = registry(),
      roots = [...new Set(r.processes.map((p) => p.identity?.pid))];
    const fact = await native().observeProjectWriters(
      roots,
      config.port || 4000,
    );
    if (fact?.complete !== true || !Array.isArray(fact.active))
      fail('WRITER_OBSERVATION_INCOMPLETE');
    return fact;
  }
  async function stop(ctx) {
    check(ctx);
    protocol(ctx.release);
    const r = registry();
    // Persist identity before effects so an interrupted updater can locate the
    // same process. The existing identity helper rejects PID reuse.
    for (const p of r.processes.filter((p) => p.releaseId === ctx.release.id)) {
      if (
        p.identity.executable !==
        path.join(ctx.release.path, 'runtime/node.exe')
      )
        fail('PROCESS_EXECUTABLE_MISMATCH');
      const result = await native().processIdentity(
        'OwnedStop',
        p.identity.pid,
        config.port || 4000,
        p.identity,
      );
      if (result?.stopped !== true) fail('PROCESS_STOP_UNPROVEN');
    }
  }
  async function assertStopped(ctx) {
    const fact = await observe(ctx);
    if (fact.active.length) fail('DATABASE_WRITERS_STILL_RUNNING');
    return {
      allWritersStopped: true,
      database: config.database,
      transactionId: ctx.transactionId,
    };
  }
  function stage(ctx, expected) {
    const j = read(config.journalFile);
    if (j.transactionId !== ctx.transactionId || j.stage !== expected)
      fail('LIFECYCLE_JOURNAL_MISMATCH');
    return j;
  }
  return {
    protocol: 'wewe-installed-lifecycle-v1',
    allWriters: true,
    sharedNormalStartup: true,
    precommitReadOnly: true,
    async acquire() {
      // Reject an unregistered legacy installation before creating any lock or
      // stopping anything. Disk active.json is not writer-registration proof.
      const r = registry();
      for (const p of r.processes)
        protocol({
          id: p.releaseId,
          path: path.join(config.releasesRoot, p.releaseId),
        });
      let fd;
      const token = crypto.randomUUID();
      try {
        fd = fs.openSync(lockFile, 'wx', 0o600);
      } catch (error) {
        if (error.code === 'EEXIST') return null;
        throw error;
      }
      try {
        fs.writeFileSync(
          fd,
          JSON.stringify({ format: 1, pid: process.pid, token }),
        );
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      held = token;
      return {
        token,
        async release() {
          check({ lease: token });
          const j = fs.existsSync(config.journalFile)
            ? read(config.journalFile)
            : undefined;
          // Retain the normal-start barrier after an uncertain destructive stage.
          if (j && !['completed', 'recovered'].includes(j.stage)) {
            held = undefined;
            return;
          }
          fs.unlinkSync(lockFile);
          held = undefined;
        },
      };
    },
    assertExclusive(ctx) {
      check(ctx);
      return true;
    },
    stop,
    assertStopped,
    async migrate(ctx) {
      await assertStopped(ctx);
      protocol(ctx.release);
      const m = read(path.join(ctx.release.path, 'release.json'));
      if (!m.files['server/node_modules/prisma/build/index.js'])
        fail('PINNED_MIGRATION_CLI_REQUIRED');
      const entry = path.join(
        ctx.release.path,
        'server/node_modules/prisma/build/index.js',
      );
      if (
        hash(fs.readFileSync(entry)) !==
        m.files['server/node_modules/prisma/build/index.js']
      )
        fail('MIGRATION_CLI_CHANGED');
      const env = { ...process.env };
      for (const key of Object.keys(env))
        if (/^(NODE_OPTIONS|NODE_PATH|PRISMA_.*|DATABASE_URL)$/i.test(key))
          delete env[key];
      await native().execute(
        path.join(ctx.release.path, 'runtime/node.exe'),
        [
          entry,
          'migrate',
          'deploy',
          '--schema',
          path.join(ctx.release.path, 'server/prisma/schema.prisma'),
        ],
        {
          windowsHide: true,
          timeout: 120000,
          maxBuffer: 65536,
          env: {
            ...env,
            DATABASE_URL: 'file:' + config.database.replace(/\\/g, '/'),
          },
        },
      );
    },
    async start(ctx) {
      check(ctx);
      protocol(ctx.release);
      const r = registry();
      // A persisted live transaction process is reused only after identity
      // validation. Never spawn a second copy merely because IPC was lost.
      const prior = r.processes.find(
        (p) =>
          p.transactionId === ctx.transactionId &&
          p.releaseId === ctx.release.id,
      );
      if (prior) {
        const current = await native().processIdentity(
          'OwnedSnapshot',
          prior.identity.pid,
          config.port || 4000,
          prior.identity,
        );
        if (
          !current?.stopped &&
          native().sameIdentity(current, prior.identity) !== false
        )
          return;
        if (!current?.stopped) fail('PRIOR_START_OUTCOME_UNKNOWN');
      }
      const node = path.join(ctx.release.path, 'runtime/node.exe');
      const args = [
        path.join(ctx.release.path, 'runtime.cjs'),
        'start',
        '--database',
        config.database,
        '--port',
        String(config.port || 4000),
        '--production',
      ];
      // Native creation returns a durable identity receipt (existing launcher
      // identity code must be connected by the builder). Plain spawn alone
      // cannot close a crash between CreateProcess and receipt persistence.
      if (typeof native().launchRegistered !== 'function')
        fail('DURABLE_LAUNCH_REGISTRATION_REQUIRED');
      const identity = await native().launchRegistered({
        node,
        args,
        registryFile,
        transactionId: ctx.transactionId,
        releaseId: ctx.release.id,
        env: {
          LOCAL_RELEASE_CONTROLLED_START: ctx.release.id,
          WEWE_UPDATE_JOURNAL: config.journalFile,
          WEWE_UPDATE_LEASE: held,
          WEWE_UPDATE_TRANSACTION: ctx.transactionId,
          WEWE_UPDATE_READ_ONLY: '1',
        },
      });
      if (!identity?.pid) fail('REGISTERED_LAUNCH_FAILED');
    },
    async health(ctx) {
      check(ctx);
      protocol(ctx.release);
      const r = registry(),
        p = r.processes.find(
          (p) =>
            p.transactionId === ctx.transactionId &&
            p.releaseId === ctx.release.id,
        );
      if (!p) fail('STARTED_PROCESS_RECEIPT_REQUIRED');
      const actual = await native().processIdentity(
        'OwnedSnapshot',
        p.identity.pid,
        config.port || 4000,
        p.identity,
      );
      if (native().sameIdentity(actual, p.identity) === false)
        fail('HEALTH_PROCESS_IDENTITY_CHANGED');
      // Reuse private login/RSS checks; additionally require the update gate's
      // exact read-only version/database response, not merely HTTP 200.
      // The precommit endpoint probes the actual Nest/Prisma app while DB writes are held.
      if (ctx.readOnly !== true)
        await native().waitReady(config.port || 4000, { exitCode: null }, 30);
      if (typeof native().readUpdateHealth !== 'function')
        fail('UPDATE_HEALTH_ENDPOINT_NOT_INTEGRATED');
      const result = await native().readUpdateHealth(ctx);
      if (
        result?.transactionId !== ctx.transactionId ||
        result.id !== ctx.release.id ||
        result.sha256 !== ctx.release.sha256 ||
        result.database !== config.database ||
        result.readOnly !== true ||
        result.databaseReadable !== true ||
        result.httpReady !== true
      )
        fail('UPDATE_READ_ONLY_HEALTH_UNPROVEN');
      return result;
    },
    publish(ctx) {
      check(ctx);
      protocol(ctx.release);
      const j = read(config.journalFile);
      if (
        j.transactionId !== ctx.transactionId ||
        !['activating', 'recovering'].includes(j.stage)
      )
        fail('PUBLICATION_STAGE_INVALID');
      if (typeof native().publishActive !== 'function')
        fail('EXISTING_PUBLICATION_LOCK_REQUIRED');
      return native().publishActive(ctx.release);
    },
    enable(ctx) {
      check(ctx);
      const j = stage(ctx, ctx.commitStage);
      const selected = j.stage === 'completed' ? j.package : j.old;
      if (
        selected.id !== ctx.release.id ||
        selected.sha256 !== ctx.release.sha256
      )
        fail('ENABLE_RELEASE_MISMATCH');
      write(permitFile, {
        format: 1,
        transactionId: ctx.transactionId,
        id: ctx.release.id,
        sha256: ctx.release.sha256,
        stage: ctx.commitStage,
      });
    },
  };
}
module.exports = { createController };
