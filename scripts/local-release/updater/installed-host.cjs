'use strict';

// Installed by the release builder with fixed bindings. Importing this module
// performs no host inventory, process control, database access or installation.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = (code) => {
  throw new Error(code);
};
const inside = (root, file) => {
  const rel = path.relative(root, file);
  return (
    rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)
  );
};
const json = (file) =>
  JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const digest = (file) => sha(fs.readFileSync(file));
const safeId = (id) =>
  typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9T.Z-]{0,159}$/.test(id);

// Verification is data-only: never require a candidate's verifier before it has
// been trusted. Keep the existing format-1 Git identity and complete byte audit.
function verifyRelease(directory, expectedDigest, { role = 'candidate' } = {}) {
  const root = fs.realpathSync.native(directory);
  const manifestFile = path.join(root, 'release.json');
  if (
    !fs.lstatSync(manifestFile).isFile() ||
    fs.lstatSync(manifestFile).isSymbolicLink()
  )
    fail('RELEASE_MANIFEST_INVALID');
  const manifestDigest = digest(manifestFile);
  if (expectedDigest && manifestDigest !== expectedDigest)
    fail('PACKAGE_DIGEST_MISMATCH');
  const m = json(manifestFile);
  if (
    m.format !== 1 ||
    !safeId(m.id) ||
    path.basename(root) !== m.id ||
    m.platform !== process.platform ||
    m.arch !== process.arch ||
    !/^[a-f0-9]{40}$/.test(m.sourceCommit || '') ||
    !/^[a-f0-9]{64}$/.test(m.sourceHash || '') ||
    m.schemaCompatibility !== 'current' ||
    typeof m.desktopHelperIncluded !== 'boolean' ||
    !m.files ||
    !m.links
  )
    fail('RELEASE_IDENTITY_INVALID');
  const files = {},
    links = {};
  function visit(relative = '') {
    for (const entry of fs.readdirSync(path.join(root, relative), {
      withFileTypes: true,
    })) {
      const rel = path.join(relative, entry.name),
        file = path.join(root, rel);
      const key = rel.split(path.sep).join('/');
      if (rel === 'release.json') continue;
      if (entry.isSymbolicLink()) {
        const target = fs.realpathSync.native(file);
        if (!inside(root, target)) fail('RELEASE_LINK_ESCAPE');
        links[key] = path.relative(root, target).split(path.sep).join('/');
      } else if (entry.isDirectory()) visit(rel);
      else if (entry.isFile()) files[key] = digest(file);
      else fail('RELEASE_FILE_INVALID');
    }
  }
  visit();
  const ordered = (object) =>
    JSON.stringify(
      Object.entries(object).sort(([a], [b]) => a.localeCompare(b)),
    );
  if (
    ordered(files) !== ordered(m.files) ||
    ordered(links) !== ordered(m.links)
  )
    fail('RELEASE_INTEGRITY_FAILED');
  const exactLegacyBaseline =
    ['current', 'rollback'].includes(role) &&
    manifestDigest ===
      'c909a33631c9492d61b9e99e4fd68452a0358ebab3b486a1b685cc36a2460260' &&
    m.id === '8ce1497-20261103-a' &&
    m.prisma?.clientVersion === '5.10.1' &&
    m.prisma?.cliVersion === '5.22.0' &&
    m.prisma?.engineSha256 ===
      'b83fc09260071e545b1a036a13e10f291428efefd351fb4197fa5c716bc02014' &&
    m.prisma?.engineCommit === '5a9203d0590c951969e85a7d07215503f4672eb9';
  if (
    !files['runtime/node.exe'] ||
    !files['runtime.cjs'] ||
    !files['server/prisma/schema.prisma'] ||
    (!exactLegacyBaseline &&
      m.prisma?.clientVersion !== m.prisma?.cliVersion) ||
    !/^\d+\.\d+\.\d+$/.test(m.prisma?.clientVersion || '') ||
    !Object.entries(files).some(
      ([name, hash]) =>
        name.endsWith('.node') && hash === m.prisma?.engineSha256,
    )
  )
    fail('RELEASE_RUNTIME_INVALID');
  // A manifest can contain arbitrary metadata, but this adapter persists only
  // the small, non-secret fixed identity in the update journal.
  return { id: m.id, sha256: manifestDigest, path: root, manifest: m };
}

function createInstalledHost({
  releasesRoot,
  dataRoot,
  database,
  journalFile,
  trustedPackages,
  controller,
  sqliteHooks,
}) {
  for (const file of [releasesRoot, dataRoot, database, journalFile])
    if (typeof file !== 'string' || !path.isAbsolute(file))
      fail('ABSOLUTE_HOST_BINDINGS_REQUIRED');
  const releases = fs.realpathSync.native(releasesRoot);
  const data = fs.realpathSync.native(dataRoot);
  if (
    !inside(data, path.resolve(database)) ||
    path.resolve(database) === data ||
    !inside(data, path.resolve(journalFile))
  )
    fail('HOST_DATA_BINDING_INVALID');
  // This is a compile/install-time allowlist, never the downloaded package's
  // own self-reported hash. No fallback to the candidate manifest is allowed.
  const trust = new Map(Object.entries(trustedPackages || {}));
  for (const [id, hash] of trust)
    if (!safeId(id) || !/^[a-f0-9]{64}$/.test(hash))
      fail('PACKAGE_TRUST_INVALID');
  const pointer = path.join(releases, 'active.json');
  let lease;
  const required = [
    'acquire',
    'assertExclusive',
    'stop',
    'assertStopped',
    'migrate',
    'start',
    'health',
    'publish',
    'enable',
  ];
  function checkedController() {
    if (
      !controller ||
      controller.protocol !== 'wewe-installed-lifecycle-v1' ||
      controller.allWriters !== true ||
      controller.sharedNormalStartup !== true ||
      controller.precommitReadOnly !== true ||
      required.some((name) => typeof controller[name] !== 'function')
    )
      fail('INSTALLED_LIFECYCLE_NOT_INTEGRATED');
    return controller;
  }
  async function call(name, ...args) {
    const c = checkedController();
    const value = await c[name](...args);
    if (value === false) fail('HOST_CONTROL_FAILED_' + name.toUpperCase());
    return value;
  }
  async function exclusive(ctx) {
    if (!lease) fail('UPDATE_EXCLUSIVE_LEASE_REQUIRED');
    await call('assertExclusive', {
      lease,
      journalFile,
      transactionId: ctx?.transactionId,
    });
  }
  function fixed(identity, role = 'candidate') {
    if (
      !identity ||
      !safeId(identity.id) ||
      trust.get(identity.id) !== identity.sha256
    )
      fail('UNTRUSTED_INSTALLED_RELEASE');
    const root = fs.realpathSync.native(path.join(releases, identity.id));
    if (path.dirname(root).toLowerCase() !== releases.toLowerCase())
      fail('RELEASE_PATH_ESCAPE');
    const verified = verifyRelease(root, identity.sha256, { role });
    return {
      id: verified.id,
      sha256: verified.sha256,
      path: verified.path,
      database,
    };
  }
  async function stopped(ctx) {
    await exclusive(ctx);
    const receipt = await call('assertStopped', { ...ctx, lease, database });
    if (
      !receipt ||
      receipt.allWritersStopped !== true ||
      receipt.database !== database ||
      receipt.transactionId !== ctx.transactionId
    )
      fail('ALL_WRITER_STOP_UNPROVEN');
    return true;
  }
  function committed(ctx, stage) {
    const j = json(journalFile);
    if (
      j.transactionId !== ctx.transactionId ||
      j.stage !== stage ||
      j.package?.sha256 !== ctx.package.sha256 ||
      j.old?.sha256 !== ctx.old.sha256
    )
      fail('UPDATE_COMMIT_STATE_MISMATCH');
  }
  async function start(ctx, identity, role) {
    await exclusive(ctx);
    await call('start', {
      ...ctx,
      lease,
      release: fixed(identity, role === 'old' ? 'rollback' : 'candidate'),
      role,
      readOnly: true,
      journalFile,
    });
  }
  async function health(ctx, identity, role) {
    await exclusive(ctx);
    const release = fixed(identity, role === 'old' ? 'rollback' : 'candidate');
    const receipt = await call('health', {
      ...ctx,
      lease,
      release,
      role,
      readOnly: true,
    });
    if (
      !receipt ||
      receipt.id !== release.id ||
      receipt.sha256 !== release.sha256 ||
      receipt.readOnly !== true ||
      receipt.database !== database ||
      receipt.databaseReadable !== true ||
      receipt.httpReady !== true
    )
      fail('RELEASE_HEALTH_UNPROVEN');
  }
  const host = {
    journalFile,
    async createAdapter() {
      checkedController();
      if (
        !sqliteHooks ||
        typeof sqliteHooks.backup !== 'function' ||
        typeof sqliteHooks.restoreDatabase !== 'function'
      )
        fail('SQLITE_HOOKS_REQUIRED');
      return {
        assertWritersStopped: stopped,
        async acquireLock() {
          checkedController();
          const held = await call('acquire', {
            releasesRoot: releases,
            database,
            journalFile,
          });
          if (!held) return null;
          if (
            typeof held.release !== 'function' ||
            typeof held.token !== 'string'
          )
            fail('UPDATE_LOCK_RECEIPT_INVALID');
          lease = held.token;
          return async () => {
            // Old business writes may resume only after durable recovery.
            try {
              if (fs.existsSync(journalFile)) {
                const j = json(journalFile);
                if (j.stage === 'recovered')
                  await call('enable', {
                    transactionId: j.transactionId,
                    lease,
                    release: fixed(j.old, 'rollback'),
                    journalFile,
                    commitStage: 'recovered',
                  });
              }
            } finally {
              lease = undefined;
              await held.release();
            }
          };
        },
        async verifyPackage(request) {
          await exclusive();
          const root = fs.realpathSync.native(request.path);
          const id = path.basename(root);
          if (
            path.dirname(root).toLowerCase() !== releases.toLowerCase() ||
            trust.get(id) !== request.sha256
          )
            fail('PACKAGE_NOT_IN_TRUSTED_RELEASE_ROOT');
          return fixed({ id, sha256: request.sha256 });
        },
        async currentInstallation() {
          await exclusive();
          const p = json(pointer);
          if (p.format !== 1 || !safeId(p.id) || !trust.has(p.id))
            fail('ACTIVE_RELEASE_UNTRUSTED');
          return fixed({ id: p.id, sha256: trust.get(p.id) }, 'current');
        },
        async stopOld(ctx) {
          await exclusive(ctx);
          await call('stop', {
            ...ctx,
            lease,
            release: fixed(ctx.old, 'current'),
            role: 'old',
            database,
          });
          await stopped(ctx);
        },
        async stopNew(ctx) {
          await exclusive(ctx);
          await call('stop', {
            ...ctx,
            lease,
            release: fixed(ctx.package),
            role: 'new',
            database,
          });
        },
        async backup(ctx) {
          await stopped(ctx);
          return sqliteHooks.backup(ctx);
        },
        async restoreDatabase(ctx) {
          await stopped(ctx);
          return sqliteHooks.restoreDatabase(ctx);
        },
        async migrate(ctx) {
          await stopped(ctx);
          const candidate = fixed(ctx.package),
            old = fixed(ctx.old, 'current');
          const next = verifyRelease(candidate.path, candidate.sha256).manifest;
          const previous = verifyRelease(old.path, old.sha256, {
            role: 'current',
          }).manifest;
          for (const [name, hash] of Object.entries(previous.files))
            if (
              /^server\/prisma\/migrations\/[^/]+\/migration\.sql$/.test(
                name,
              ) &&
              next.files[name] !== hash
            )
              fail('HISTORICAL_MIGRATION_CHANGED');
          const migrations = (m) =>
            Object.keys(m.files).filter((name) =>
              /^server\/prisma\/migrations\/[^/]+\/migration\.sql$/.test(name),
            );
          if (
            migrations(next).length === migrations(previous).length &&
            next.files['server/prisma/schema.prisma'] !==
              previous.files['server/prisma/schema.prisma']
          )
            fail('SCHEMA_CHANGED_WITHOUT_MIGRATION');
          // Recovery hooks own the same backup/migration/restore transaction.
          // Keep fixed-role/history checks above; never bypass their prewrite gate.
          if (typeof sqliteHooks.migrate === 'function')
            return sqliteHooks.migrate(ctx);
          return call('migrate', {
            ...ctx,
            lease,
            release: candidate,
            old,
            database,
          });
        },
        startNew: (ctx) => start(ctx, ctx.package, 'new'),
        startOld: (ctx) => start(ctx, ctx.old, 'old'),
        health: (ctx) => health(ctx, ctx.package, 'new'),
        oldHealth: (ctx) => health(ctx, ctx.old, 'old'),
        async activateNew(ctx) {
          await exclusive(ctx);
          committed(ctx, 'activating');
          return call('publish', {
            ...ctx,
            lease,
            release: fixed(ctx.package),
            pointer,
            readOnly: true,
          });
        },
        async activateOld(ctx) {
          await exclusive(ctx);
          committed(ctx, 'recovering');
          return call('publish', {
            ...ctx,
            lease,
            release: fixed(ctx.old, 'rollback'),
            pointer,
            readOnly: true,
          });
        },
        async enableNew(ctx) {
          await exclusive(ctx);
          committed(ctx, 'completed');
          return call('enable', {
            ...ctx,
            lease,
            release: fixed(ctx.package),
            journalFile,
            commitStage: 'completed',
          });
        },
      };
    },
  };
  return host;
}

// The builder places reviewed bindings and controller beside this entry. A
// controller digest comes from that fixed builder output, never a CLI/env path.
let bound;
function installed() {
  if (bound) return bound;
  const bindingsFile = path.join(__dirname, 'installed-host-bindings.json');
  if (!fs.existsSync(bindingsFile)) fail('INSTALLED_HOST_BINDINGS_REQUIRED');
  const config = json(bindingsFile);
  if (
    config.format !== 1 ||
    !/^[a-f0-9]{64}$/.test(config.controllerSha256 || '')
  )
    fail('INSTALLED_HOST_BINDINGS_INVALID');
  const controllerFile = path.join(__dirname, 'installed-lifecycle.cjs');
  if (
    fs.lstatSync(controllerFile).isSymbolicLink() ||
    digest(controllerFile) !== config.controllerSha256
  )
    fail('INSTALLED_CONTROLLER_INTEGRITY_FAILED');
  const controller = require(controllerFile).createController(config);
  const { createSqliteHooks } = require('./sqlite-hooks.cjs');
  let adapter;
  const sqliteHooks = createSqliteHooks({
    dataRoot: config.dataRoot,
    python: config.python,
    assertWritersStopped: (ctx) => adapter.assertWritersStopped(ctx),
  });
  const host = createInstalledHost({ ...config, controller, sqliteHooks });
  const make = host.createAdapter;
  host.createAdapter = async () => {
    adapter = await make();
    return adapter;
  };
  bound = host;
  return bound;
}
module.exports = {
  createInstalledHost,
  verifyRelease,
  get journalFile() {
    return installed().journalFile;
  },
  createAdapter() {
    return installed().createAdapter();
  },
};
