// The only additional native writer: one reviewed publication and one rollback.
// All paths/inputs/allowances come from the same pinned installation policy.
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const cp = require('node:child_process');
const {
  hostEffects,
  fileHash,
  verifyRelease,
  cleanEnvironment,
} = require('./lib.cjs');
const hash = (value) =>
  crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code) => {
  throw Error('ONCE_PUBLICATION_' + code);
};
const MiB = 1024 ** 2,
  FREE = 4 * 1024 ** 3;
const exists = (at) => {
  try {
    return fs.lstatSync(at);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
};
const canonical = (at) => fs.realpathSync.native(at);
const inside = (root, at) => {
  const r = path.relative(root, at);
  return (
    r === '' ||
    (r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r))
  );
};
const identity = (at) => {
  const s = fs.lstatSync(at, { bigint: true });
  if (s.isSymbolicLink()) fail('ALIAS');
  return [s.dev, s.ino, s.birthtimeNs].map(String);
};
function read(at, max = MiB) {
  const s = fs.lstatSync(at);
  if (!s.isFile() || s.isSymbolicLink() || s.size > max) fail('DOCUMENT');
  return JSON.parse(fs.readFileSync(at, 'utf8'));
}
function allowance(sourceCeilingBytes) {
  if (
    !Number.isSafeInteger(sourceCeilingBytes) ||
    sourceCeilingBytes < 4096 ||
    sourceCeilingBytes > 1024 ** 3 ||
    sourceCeilingBytes % 4096
  )
    fail('SOURCE_CEILING');
  const backupBytes = 4 * sourceCeilingBytes + 2 * MiB,
    migrationBytes = sourceCeilingBytes + 64 * MiB,
    auditBytes = 16 * MiB;
  return {
    sourceCeilingBytes,
    backupBytes,
    migrationBytes,
    auditBytes,
    additionalBytes: backupBytes + migrationBytes + auditBytes,
    maxBackups: 3,
    maxPublications: 1,
    maxRollbacks: 1,
  };
}
function pin(spec, maximum = 128 * MiB) {
  if (
    !spec ||
    !/^[a-f0-9]{64}$/.test(spec.sha256 || '') ||
    canonical(spec.path) !== spec.path ||
    !fs.lstatSync(spec.path).isFile() ||
    fs.statSync(spec.path).size > maximum ||
    fileHash(spec.path) !== spec.sha256
  )
    fail('INPUT_PIN');
}
function validate(p) {
  const u = p.publication;
  if (
    !u ||
    u.format !== 1 ||
    hash(u.limits) !== hash(allowance(u.limits?.sourceCeilingBytes))
  )
    fail('FINITE_ALLOWANCE');
  if (
    !p.approval?.operations ||
    hash(p.approval.operations) !== hash(['install', 'publish', 'rollback'])
  )
    fail('EXPLICIT_OPERATIONS');
  for (const role of ['candidate', 'rollback']) {
    const item = p.pair.find((row) => row.role === role),
      spec = p.protectedPackages.find((row) => row.id === item.id);
    if (p.approval[role + 'Commit'] !== spec.sourceCommit)
      fail('APPLICATION_APPROVAL_BINDING');
  }
  if (
    canonical(p.probe.path) !==
      canonical(path.join(__dirname, 'windows-release-references.cjs')) ||
    p.probe.sha256 !== p.codePins['windows-release-references.cjs']
  )
    fail('PROBE_BINDING');
  if (
    !path.isAbsolute(u.auditRoot) ||
    (exists(u.auditRoot) && fs.lstatSync(u.auditRoot).isSymbolicLink()) ||
    canonical(path.dirname(u.auditRoot)) !== path.dirname(u.auditRoot) ||
    !p.roots.some((r) => inside(r.path, path.dirname(u.auditRoot))) ||
    p.protectedPackages.some((r) => inside(r.path, u.auditRoot)) ||
    inside(u.auditRoot, u.database)
  )
    fail('AUDIT_ROOT');
  if (
    canonical(u.database) !== u.database ||
    hash(identity(u.database)) !== hash(u.databaseIdentity) ||
    u.database !==
      path.join(path.dirname(p.installRoot), 'apps/server/data/wewe-rss.db')
  )
    fail('DATABASE_BINDING');
  if (
    !u.expected ||
    !Number.isInteger(u.expected.pid) ||
    u.expected.pid < 1 ||
    u.expected.port !== 4000 ||
    !u.expected.startUtc ||
    u.expected.executable !==
      path.join(p.installRoot, p.currentId, 'runtime/node.exe') ||
    typeof u.expected.commandLine !== 'string'
  )
    fail('EXPECTED_PROCESS');
  const expectedArgv = [
    u.expected.executable,
    path.join(p.installRoot, p.currentId, 'runtime.cjs'),
    'start',
    '--database',
    u.database,
    '--port',
    '4000',
    '--production',
  ];
  if (
    hash(
      require('./windows-release-references.cjs').argv(u.expected.commandLine),
    ) !== hash(expectedArgv)
  )
    fail('EXPECTED_COMMAND');
  for (const spec of [u.python, u.schemaEngine]) pin(spec);
  if (!/^[a-f0-9]{64}$/.test(u.powershellSha256 || '')) fail('POWERSHELL_PIN');
  if (
    !Array.isArray(u.environmentFiles) ||
    u.environmentFiles.length > 2 ||
    u.environmentFiles.some(
      (s) =>
        !['.env', '.env.local'].includes(path.basename(s.path)) ||
        path.dirname(s.path) !==
          path.join(path.dirname(p.installRoot), 'apps/server'),
    )
  )
    fail('ENVIRONMENT_BINDING');
  u.environmentFiles.forEach((spec) => pin(spec, MiB));
  if (
    !Array.isArray(u.pendingMigrations) ||
    u.pendingMigrations.length > 32 ||
    u.pendingMigrations.some((n) => !/^[A-Za-z0-9_]{1,160}$/.test(n)) ||
    !Array.isArray(u.allowedNewTables) ||
    u.allowedNewTables.length > 32 ||
    u.allowedNewTables.some((n) => !/^[A-Za-z0-9_]{1,160}$/.test(n))
  )
    fail('MIGRATION_PLAN');
  if (
    !u.health ||
    u.health.rssItems !== 20 ||
    typeof u.health.rssPath !== 'string' ||
    !/^\/feeds\/[A-Za-z0-9_.%-]+\.rss\?limit=20&mode=summary$/.test(
      u.health.rssPath,
    )
  )
    fail('HEALTH_CONTRACT');
  return u;
}
function measure(root, ceiling) {
  if (!exists(root)) return 0;
  let bytes = 0,
    count = 0;
  const start = Date.now(),
    block = Number(fs.statfsSync(root, { bigint: true }).bsize);
  const visit = (at, depth) => {
    if (depth > 32 || ++count > 20000 || Date.now() - start > 10000)
      fail('OUTPUT_SCAN_BOUND');
    const s = fs.lstatSync(at);
    if (s.isSymbolicLink()) fail('OUTPUT_ALIAS');
    if (s.isDirectory()) {
      bytes += block;
      const directory = fs.opendirSync(at);
      try {
        let entry;
        while ((entry = directory.readSync()))
          visit(path.join(at, entry.name), depth + 1);
      } finally {
        directory.closeSync();
      }
    } else if (s.isFile() && s.nlink === 1)
      bytes += Math.ceil(s.size / block) * block;
    else fail('OUTPUT_KIND');
    if (bytes > ceiling) fail('OUTPUT_OVER_BUDGET');
  };
  visit(root, 0);
  return bytes;
}
function databaseBytes(database) {
  return ['', '-wal', '-shm', '-journal'].reduce((sum, suffix) => {
    const s = exists(database + suffix);
    if (s && (s.isSymbolicLink() || !s.isFile())) fail('DATABASE_ALIAS');
    return sum + (s?.size || 0);
  }, 0);
}
function additiveMigrations(release, u) {
  let total = 0;
  for (const name of u.pendingMigrations) {
    const at = path.join(
        release,
        'server/prisma/migrations',
        name,
        'migration.sql',
      ),
      stat = fs.lstatSync(at);
    total += stat.size;
    if (!stat.isFile() || stat.isSymbolicLink() || total > MiB)
      fail('MIGRATION_SQL_BOUND');
    const sql = fs
      .readFileSync(at, 'utf8')
      .replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '');
    for (const text of sql
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)) {
      const table = /^CREATE\s+TABLE\s+["`]?([A-Za-z0-9_]+)["`]?\s*\(/i.exec(
          text,
        ),
        index =
          /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+["`]?\w+["`]?\s+ON\s+["`]?([A-Za-z0-9_]+)["`]?\s*\(/i.exec(
            text,
          );
      if (
        !u.allowedNewTables.includes((table || index)?.[1]) ||
        /\b(?:AS\s+SELECT|INSERT|DELETE|DROP|ATTACH|TRIGGER)\b/i.test(text)
      )
        fail('NON_ADDITIVE_MIGRATION');
    }
  }
}
function reserve(rows) {
  const volumes = new Map();
  for (const [at, bytes] of rows) {
    let dir = at;
    while (!exists(dir)) dir = path.dirname(dir);
    dir = canonical(dir);
    const dev = String(fs.statSync(dir, { bigint: true }).dev);
    const s = fs.statfsSync(dir, { bigint: true });
    const old = volumes.get(dev) || { free: s.bavail * s.bsize, bytes: 0 };
    old.bytes += bytes;
    volumes.set(dev, old);
  }
  for (const v of volumes.values())
    if (v.free < BigInt(FREE + v.bytes)) fail('PHYSICAL_RESERVE');
}
function nativeOperations(p, u, audit, check) {
  const packageInputs = (release) => {
    const m = verifyRelease(release);
    if (fileHash(path.join(release, 'release.json')) !== p.packageProofs[m.id])
      fail('EXECUTABLE_PACKAGE_CHANGED');
    return m;
  };
  const env = cleanEnvironment({
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONDONTWRITEBYTECODE: '1',
    NODE_ENV: 'production',
  });
  const { parseEnv } = require('node:util');
  for (const spec of [...u.environmentFiles].reverse()) {
    pin(spec, MiB);
    Object.assign(env, parseEnv(fs.readFileSync(spec.path, 'utf8')));
  }
  for (const key of Object.keys(env))
    if (/^(NODE_OPTIONS|NODE_PATH|PRISMA_.*|DATABASE_URL)$/i.test(key))
      delete env[key];
  const run = (exe, args, extra = {}) => {
    check();
    pin(
      exe === u.python.path
        ? u.python
        : exe === u.schemaEngine.path
          ? u.schemaEngine
          : { path: exe, sha256: p.publication.powershellSha256 },
    );
    return cp.execFileSync(exe, args, {
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      timeout: 180000,
      maxBuffer: 2 * MiB,
      env,
      ...extra,
    });
  };
  const python = (script, args, extra) =>
    JSON.parse(run(u.python.path, ['-X', 'utf8', script, ...args], extra));
  const state = (db, baseline) =>
    python(path.join(__dirname, 'once-pair-state.py'), [
      db,
      ...(baseline ? [baseline, JSON.stringify(u.allowedNewTables)] : []),
    ]);
  const inspect = (release, db, current = false) =>
    python(path.join(release, 'inspect-sqlite.py'), [
      '--database',
      db,
      '--migrations',
      path.join(release, 'server/prisma/migrations'),
      ...(current ? ['--require-current'] : []),
    ]);
  const processIdentity = (action, pid, expected) =>
    JSON.parse(
      run(
        path.join(
          process.env.SystemRoot || 'C:\\Windows',
          'System32/WindowsPowerShell/v1.0/powershell.exe',
        ),
        [
          '-NoProfile',
          '-NonInteractive',
          '-File',
          path.join(__dirname, 'process-identity.ps1'),
          '-Action',
          action,
          '-TargetPid',
          String(pid || 0),
          '-Port',
          '4000',
          ...(expected
            ? [
                '-ExpectedStartUtc',
                expected.startUtc,
                '-ExpectedExecutable',
                expected.executable,
                '-ExpectedCommandLine',
                expected.commandLine,
              ]
            : []),
        ],
      ),
    );
  return {
    state,
    inspect,
    identity: processIdentity,
    backup(release) {
      packageInputs(release);
      const result = python(
        path.join(release, 'server/scripts/backup-sqlite.py'),
        [
          '--database',
          u.database,
          '--backup-root',
          path.join(audit, 'backups'),
        ],
        {
          env: {
            ...env,
            SQLITE_BACKUP_KIND: 'production',
            SQLITE_PRODUCTION_LEGACY_ROOTS: '[]',
            SQLITE_PRODUCTION_MAX_BYTES: String(u.limits.backupBytes),
            SQLITE_PRODUCTION_MAX_COPIES: '3',
            SQLITE_PRODUCTION_MIN_FREE_BYTES: String(FREE),
          },
        },
      );
      if (
        result.integrityCheck !== 'ok' ||
        result.recoveryOrigin?.kind !== 'protected' ||
        !inside(path.join(audit, 'backups'), canonical(result.backup)) ||
        fileHash(result.backup) !== result.sha256
      )
        fail('BACKUP_PROOF');
      return result;
    },
    async migrate(release) {
      check();
      packageInputs(release);
      pin(u.schemaEngine);
      additiveMigrations(release, u);
      const schema = path.join(release, 'server/prisma/schema.prisma'),
        child = cp.spawn(u.schemaEngine.path, ['-d', schema], {
          cwd: path.dirname(schema),
          env: {
            ...env,
            DATABASE_URL: 'file:' + u.database.replaceAll('\\', '/'),
          },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          shell: false,
        });
      return new Promise((resolve, reject) => {
        let bytes = 0,
          pending = '',
          settled = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.kill();
          const killTimer = setTimeout(
            () => reject(Error('MIGRATION_KILL_TIMEOUT')),
            15000,
          );
          child.once('close', () => {
            clearTimeout(killTimer);
            error ? reject(error) : resolve(value);
          });
        };
        const timer = setTimeout(
          () => finish(Error('MIGRATION_TIMEOUT')),
          180000,
        );
        child.once('error', (e) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(e);
          }
        });
        child.stdin.once('error', () => finish(Error('MIGRATION_STDIN')));
        child.once('exit', () => {
          if (!settled) finish(Error('MIGRATION_EXIT'));
        });
        child.stderr.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 2 * MiB) finish(Error('MIGRATION_OUTPUT_BOUND'));
        });
        child.stdout.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 2 * MiB) return finish(Error('MIGRATION_OUTPUT_BOUND'));
          pending += chunk;
          let end;
          while ((end = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, end);
            pending = pending.slice(end + 1);
            try {
              const msg = JSON.parse(line);
              if (msg.method === 'print' && msg.id !== undefined)
                child.stdin.write(
                  JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) +
                    '\n',
                );
              else if (msg.id === 1) {
                if (msg.error) finish(Error('MIGRATION_REJECTED'));
                else finish(null, msg.result);
              }
            } catch {
              finish(Error('MIGRATION_PROTOCOL'));
            }
          }
        });
        child.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'applyMigrations',
            params: {
              migrationsDirectoryPath: path.join(
                release,
                'server/prisma/migrations',
              ),
            },
          }) + '\n',
        );
      });
    },
    start(release, { recovery = false } = {}) {
      const m = packageInputs(release);
      if (m.desktopHelperIncluded !== false)
        fail('DESKTOP_HELPER_NOT_AUTHORIZED');
      if (processIdentity('Port', 0).length) fail('PORT_BUSY');
      const child = cp.spawn(
        path.join(release, 'runtime/node.exe'),
        [
          path.join(release, 'runtime.cjs'),
          'start',
          '--database',
          u.database,
          '--port',
          '4000',
          '--production',
        ],
        {
          cwd: audit,
          env: {
            ...env,
            LOCAL_RELEASE_CONTROLLED_START: m.id,
            LOCAL_RELEASE_REUSE_VERIFIED: '0',
            LOCAL_RELEASE_STARTUP_AUDIT_ROOT: '',
            ...(recovery
              ? {
                  ENABLE_SCHEDULED_UPDATES: '0',
                  DISABLE_SCHEDULED_UPDATES: '1',
                  WECHAT2RSS_ENABLED: '0',
                  WECHAT2RSS_CACHE_SYNC: '0',
                }
              : {}),
          },
          stdio: 'ignore',
          windowsHide: true,
          shell: false,
          detached: true,
        },
      );
      child.once('error', (error) => {
        child.startError = error;
      });
      return child;
    },
    async stopChild(child) {
      if (child?.startError || !child?.pid) return;
      if (child && child.exitCode === null) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(Error('OWNED_CHILD_STOP_TIMEOUT')),
            15000,
          );
          child.once('close', () => {
            clearTimeout(timer);
            resolve();
          });
          child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.kill();
        });
      }
    },
    async ready(child) {
      const until = Date.now() + 180000;
      let cookie;
      const base = 'http://127.0.0.1:4000';
      const response = async (url) => {
        const r = await fetch(url, {
          redirect: 'manual',
          signal: AbortSignal.timeout(2500),
          ...(cookie ? { headers: { Cookie: cookie } } : {}),
        });
        const reader = r.body?.getReader(),
          parts = [];
        let bytes = 0;
        if (reader)
          try {
            for (;;) {
              const item = await reader.read();
              if (item.done) break;
              bytes += item.value.byteLength;
              if (bytes > 2 * MiB) {
                await reader.cancel();
                fail('HEALTH_RESPONSE_BOUND');
              }
              parts.push(Buffer.from(item.value));
            }
          } finally {
            reader.releaseLock();
          }
        const text = Buffer.concat(parts).toString('utf8');
        return { r, text };
      };
      while (Date.now() < until) {
        check();
        if (child.startError) fail('SERVICE_START_FAILED');
        if (child.exitCode !== null) fail('SERVICE_EXIT');
        try {
          const status = await response(base + '/startup-status');
          if (status.r.ok && JSON.parse(status.text).writesAllowed === true) {
            if (env.PRIVATE_ONLINE_MODE === '1' && !cookie) {
              const anon = await response(base + u.health.rssPath);
              if (anon.r.status !== 401) fail('PRIVATE_ANONYMOUS_RSS');
              const login = await fetch(base + '/auth/login', {
                method: 'POST',
                redirect: 'manual',
                signal: AbortSignal.timeout(2500),
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code: env.AUTH_CODE }),
              });
              if (login.status !== 204) fail('PRIVATE_LOGIN');
              cookie = (login.headers.get('set-cookie') || '').split(';')[0];
              if (
                !/^wewe_private_session=\d{10}\.[a-f0-9]{32}\.[a-f0-9]{64}$/.test(
                  cookie,
                )
              )
                fail('PRIVATE_SESSION');
            }
            const dash = await response(base + '/dash'),
              rss = await response(base + u.health.rssPath);
            if (
              dash.r.ok &&
              rss.r.status === 200 &&
              (rss.text.match(/<item>/g) || []).length === 20
            )
              return {
                writesAllowed: true,
                rssItems: 20,
                privateMode: env.PRIVATE_ONLINE_MODE === '1',
              };
          }
        } catch (e) {
          if (/^ONCE_PUBLICATION_/.test(e.message)) throw e;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      fail('HEALTH_TIMEOUT');
    },
  };
}
async function execute(policyFile, expected, options = {}) {
  if (hostEffects.currentLease()) fail('OBSERVATION_OR_NESTED');
  const once = require('./once-pair-admission.cjs');
  let plan = once.checkPlan(policyFile, expected, true, true),
    p = plan.p,
    u = validate(p);
  if (options.rollback !== true) {
    const existing = exists(
      path.join(p.registryDirectory, p.scopeId + '.state.json'),
    );
    if (
      !existing ||
      !read(path.join(p.registryDirectory, p.scopeId + '.state.json')).payload
        ?.complete
    ) {
      reserve([
        [p.installRoot, once.LIMITS.bytes],
        [u.auditRoot, u.limits.backupBytes + u.limits.auditBytes],
        [u.database, u.limits.migrationBytes],
      ]);
      once.main(['--apply', policyFile, expected]);
    }
  }
  plan = once.checkPlan(policyFile, expected, true, true);
  p = plan.p;
  u = validate(p);
  const ledger = path.join(p.registryDirectory, p.scopeId + '.state.json'),
    lock = path.join(p.registryDirectory, p.scopeId + '.lock'),
    token = JSON.stringify({
      pid: process.pid,
      nonce: crypto.randomUUID(),
      configSha: expected,
    });
  const ledgerBefore = fileHash(ledger);
  const envelope = read(ledger),
    state = envelope.payload;
  if (fileHash(ledger) !== ledgerBefore) fail('LEDGER_CHANGED');
  if (
    envelope.digest !== hash(state) ||
    state.configSha !== expected ||
    state.claim ||
    !state.complete ||
    state.slots?.length !== 2 ||
    plan.pair.some(
      (item) =>
        !state.slots.some(
          (slot) =>
            slot.id === item.id &&
            slot.path === item.target &&
            slot.complete &&
            hash(identity(slot.path)) === hash(slot.identity),
        ),
    )
  )
    fail('INSTALLATION_NOT_COMPLETE');
  const pointer = path.join(p.installRoot, 'active.json');
  // Pin each existing ancestor down to the audit parent, including intervening
  // directories below the policy root. A surviving leaf cannot own a new parent.
  const auditRoot = p.roots.find((r) =>
      inside(r.path, path.dirname(u.auditRoot)),
    ),
    auditParents = [];
  for (let at = path.dirname(u.auditRoot); ; at = path.dirname(at)) {
    if (auditParents.length >= 128 || !inside(auditRoot.path, at))
      fail('AUDIT_ANCESTRY');
    auditParents.push({ path: at, identity: identity(at) });
    if (at === auditRoot.path) break;
  }
  if (
    state.publication &&
    hash(state.publication.auditParents) !== hash(auditParents)
  )
    fail('AUDIT_ANCESTRY_CHANGED');
  if (
    (state.publication?.status === 'passed' && !options.rollback) ||
    state.publication?.status === 'rolled-back'
  ) {
    if (
      fileHash(pointer) !== state.publication.pointerSha256 ||
      hash(identity(pointer)) !== hash(state.publication.pointerIdentity)
    )
      fail('REPLAY_POINTER_CHANGED');
    for (const item of plan.pair) {
      verifyRelease(item.target);
      if (
        fileHash(path.join(item.target, 'release.json')) !==
        item.pkg.spec.manifestSha256
      )
        fail('REPLAY_PACKAGE_CHANGED');
    }
    return { ...state.publication, reused: true };
  }
  if (
    state.publication &&
    (state.publication.status !== 'passed' || !options.rollback)
  )
    fail('INTERRUPTED_PUBLICATION_HELD');
  if (options.rollback && !state.publication)
    fail('NO_PUBLICATION_TO_ROLL_BACK');
  reserve([
    [u.auditRoot, u.limits.backupBytes + u.limits.auditBytes],
    [u.database, u.limits.migrationBytes],
    [p.registryDirectory, once.LIMITS.metadata],
  ]);
  fs.writeFileSync(lock, token, { flag: 'wx', mode: 0o600 });
  if (fileHash(ledger) !== ledgerBefore) {
    fs.unlinkSync(lock);
    fail('LEDGER_CHANGED');
  }
  let ledgerSha = fileHash(ledger),
    ledgerIdentity = identity(ledger),
    lockIdentity = identity(lock),
    policyIdentity = identity(plan.file),
    sentinelIdentity = identity(ledger + '.adopted'),
    closed = false,
    auditIdentity = state.publication?.auditIdentity,
    transition = false,
    recovering = false,
    pointerSha = state.publication?.pointerSha256 || p.pointerSha256,
    pointerIdentity = state.publication?.pointerIdentity || identity(pointer);
  const initialDb =
    state.publication?.databaseBaselineBytes ?? databaseBytes(u.database);
  if (databaseBytes(u.database) > u.limits.sourceCeilingBytes) {
    fs.unlinkSync(lock);
    fail('SOURCE_CEILING');
  }
  const owner = () => {
    if (
      closed ||
      fs.readFileSync(lock, 'utf8') !== token ||
      fileHash(plan.file) !== expected ||
      hash(identity(plan.file)) !== hash(policyIdentity) ||
      hash(identity(ledger + '.adopted')) !== hash(sentinelIdentity) ||
      fs.readFileSync(ledger + '.adopted', 'utf8') !== expected ||
      hash(once.codePins()) !== hash(p.codePins) ||
      fileHash(ledger) !== ledgerSha ||
      hash(identity(ledger)) !== hash(ledgerIdentity) ||
      hash(identity(lock)) !== hash(lockIdentity) ||
      hash(identity(p.registryDirectory)) !== hash(p.registryIdentity) ||
      canonical(p.registryDirectory) !== p.registryDirectory ||
      [...p.roots, ...auditParents].some(
        (r) =>
          canonical(r.path) !== r.path ||
          !fs.lstatSync(r.path).isDirectory() ||
          hash(identity(r.path)) !== hash(r.identity),
      ) ||
      (auditIdentity &&
        (canonical(u.auditRoot) !== u.auditRoot ||
          hash(identity(u.auditRoot)) !== hash(auditIdentity))) ||
      fileHash(pointer) !== pointerSha ||
      hash(identity(pointer)) !== hash(pointerIdentity) ||
      hash(identity(u.database)) !== hash(u.databaseIdentity)
    )
      fail('OWNER_OR_INPUT_CHANGED');
  };
  const save = () => {
    owner();
    const text = JSON.stringify({ payload: state, digest: hash(state) });
    if (Buffer.byteLength(text) > 256 * 1024) fail('LEDGER_LIMIT');
    const temp = ledger + '.' + crypto.randomUUID() + '.tmp',
      fd = fs.openSync(temp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const publishedIdentity = identity(temp),
      publishedSha = crypto.createHash('sha256').update(text).digest('hex');
    owner();
    fs.renameSync(temp, ledger);
    ledgerSha = publishedSha;
    ledgerIdentity = publishedIdentity;
    owner();
  };
  const check = () => {
    owner();
    if (auditIdentity && hash(identity(u.auditRoot)) !== hash(auditIdentity))
      fail('AUDIT_IDENTITY');
    const used = auditIdentity
      ? measure(u.auditRoot, u.limits.backupBytes + u.limits.auditBytes)
      : 0;
    const backupUsed = auditIdentity
      ? measure(path.join(u.auditRoot, 'backups'), u.limits.backupBytes)
      : 0;
    if (used - backupUsed > u.limits.auditBytes) fail('AUDIT_OVER_BUDGET');
    if (databaseBytes(u.database) - initialDb > u.limits.migrationBytes)
      fail('DATABASE_GROWTH');
    reserve([
      [
        u.auditRoot,
        recovering
          ? MiB
          : Math.max(0, u.limits.backupBytes + u.limits.auditBytes - used),
      ],
      [
        u.database,
        recovering
          ? 64 * MiB
          : Math.max(
              0,
              u.limits.migrationBytes - (databaseBytes(u.database) - initialDb),
            ),
      ],
      [p.registryDirectory, once.LIMITS.metadata],
    ]);
  };
  let facts;
  const references = () => {
    check();
    const observation = {
      assertWritable() {
        fail('OBSERVATION_WRITE');
      },
    };
    const result = hostEffects.context.run(observation, () =>
      options.query
        ? options.query()
        : JSON.parse(
            cp.execFileSync(process.execPath, [p.probe.path, plan.file], {
              encoding: 'utf8',
              timeout: 30000,
              maxBuffer: MiB,
              windowsHide: true,
            }),
          ),
    );
    require('./release-scope.cjs').validateReferences(result, p);
    for (const r of result.records) {
      if (
        ![
          plan.packages.get(r.packageId)?.spec.path,
          plan.pair.find((i) => i.id === r.packageId)?.target,
        ].includes(canonical(r.packagePath))
      )
        fail('REFERENCE_PATH');
    }
    const stable = (v) =>
      v.records
        .filter((r) => !['processes', 'pointers'].includes(r.kind))
        .map((r) =>
          r.viaPointer
            ? {
                kind: r.kind,
                path: r.viaPointer.path,
                launcher: r.viaPointer.launcherSha256,
              }
            : r,
        );
    if (
      facts &&
      hash(transition ? stable(facts) : facts.records) !==
        hash(transition ? stable(result) : result.records)
    )
      fail('REFERENCES_CHANGED');
    facts = result;
  };
  const receipt = (name, value) => {
    check();
    const at = path.join(u.auditRoot, name + '.json');
    if (!/^[a-z0-9-]+$/.test(name) || exists(at)) fail('RECEIPT_EXISTS');
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > MiB) fail('RECEIPT_LIMIT');
    fs.writeFileSync(at, text, { flag: 'wx', mode: 0o600 });
    check();
  };
  const stage = (name) => {
    owner();
    state.publication.stage = name;
    save();
  };
  const lease = {
    assertWritable() {
      fail('UNREGISTERED_PUBLISHER_EFFECT');
    },
    assertOperation() {
      fail('NESTED');
    },
  };
  let ops,
    child,
    oldStopped = false,
    stopAttempted = false,
    migrationAttempted = options.rollback === true;
  try {
    if (!state.publication) {
      if (exists(u.auditRoot)) fail('AUDIT_ALREADY_EXISTS');
      state.publication = {
        status: 'running',
        stage: 'claimed',
        backups: 0,
        rollbackSpent: false,
        databaseBaselineBytes: initialDb,
        audit: u.auditRoot,
        auditParents,
      };
      state.claim = {
        id: crypto.randomUUID(),
        kind: 'switch',
        root: p.installRoot,
        reserveBytes: u.limits.additionalBytes,
        runtimeCopies: 0,
        outputs: [u.auditRoot],
      };
      state.outputs.push({
        path: u.auditRoot,
        claim: state.claim.id,
        complete: false,
      });
      save();
      fs.mkdirSync(u.auditRoot);
      auditIdentity = identity(u.auditRoot);
      state.publication.auditIdentity = auditIdentity;
      save();
    } else {
      state.publication.status = 'running';
      state.claim = {
        id: crypto.randomUUID(),
        kind: 'switch',
        root: p.installRoot,
        reserveBytes: u.limits.additionalBytes,
        runtimeCopies: 0,
        outputs: [],
      };
      save();
    }
    references();
    ops = options.operations || nativeOperations(p, u, u.auditRoot, check);
    return await hostEffects.context.run(lease, async () => {
      const candidate = plan.pair.find((i) => i.role === 'candidate').target,
        rollback = plan.pair.find((i) => i.role === 'rollback').target;
      for (const item of plan.pair) {
        verifyRelease(item.target);
        if (
          fileHash(path.join(item.target, 'release.json')) !==
          item.pkg.spec.manifestSha256
        )
          fail('INSTALLED_PACKAGE_CHANGED');
      }
      additiveMigrations(candidate, u);
      const same = (a, b) => {
        for (const key of [
          'pid',
          'startUtc',
          'executable',
          'commandLine',
          'port',
        ])
          if (a[key] !== b[key]) fail('PROCESS_IDENTITY');
      };
      const backup = (label) => {
        if (state.publication.backups >= 3) fail('BACKUP_CREDIT_SPENT');
        if (databaseBytes(u.database) > u.limits.sourceCeilingBytes)
          fail('SOURCE_CEILING');
        state.publication.backups++;
        stage(label + '-reserved');
        const b = ops.backup(candidate);
        receipt(label, b);
        return b;
      };
      const publish = (id) => {
        check();
        const temp = path.join(
            p.installRoot,
            'active-' + crypto.randomUUID() + '.tmp',
          ),
          text = JSON.stringify({ format: 1, id }) + '\n';
        fs.writeFileSync(temp, text, { flag: 'wx' });
        const publishedIdentity = identity(temp),
          publishedSha = crypto.createHash('sha256').update(text).digest('hex');
        check();
        fs.renameSync(temp, pointer);
        // Trust only the file and bytes we prepared, never a post-rename read.
        pointerSha = publishedSha;
        pointerIdentity = publishedIdentity;
        owner();
        state.publication.pointerSha256 = publishedSha;
        state.publication.pointerIdentity = publishedIdentity;
        save();
      };
      const finish = (status, identity, health) => {
        state.publication.status = status;
        state.publication.identity = identity;
        state.publication.health = health;
        state.publication.databaseRestored = false;
        state.publication.stage = 'completed';
        state.claim = null;
        const row = state.outputs.find((r) => r.path === u.auditRoot);
        row.complete = true;
        row.identity = auditIdentity;
        save();
        receipt(status, {
          ...state.publication,
          policySha256: expected,
          candidateId: path.basename(candidate),
          rollbackId: path.basename(rollback),
          protectedIds: p.protectedIds,
        });
        check();
        return { ...state.publication, reused: false };
      };
      const fallback = async (error) => {
        recovering = true;
        stage('rollback-reserved');
        if (state.publication.rollbackSpent) fail('ROLLBACK_CREDIT_SPENT');
        state.publication.rollbackSpent = true;
        save();
        await ops.stopChild(child);
        child = undefined;
        const target = migrationAttempted
          ? rollback
          : path.join(p.installRoot, p.currentId);
        references();
        verifyRelease(target);
        if (
          fileHash(path.join(target, 'release.json')) !==
          p.packageProofs[path.basename(target)]
        )
          fail('FALLBACK_PACKAGE_CHANGED');
        child = ops.start(target, { recovery: true });
        const health = await ops.ready(child),
          identity = ops.identity('Snapshot', child.pid);
        if (identity.executable !== path.join(target, 'runtime/node.exe'))
          fail('FALLBACK_IDENTITY');
        publish(path.basename(target));
        references();
        receipt('failure', {
          reason: /^[A-Z0-9_]+$/.test(error.message)
            ? error.message
            : 'publication-failed',
          migrationAttempted,
        });
        child.unref?.();
        return finish('rolled-back', identity, health);
      };
      try {
        const expectedProcess = options.rollback
          ? state.publication.identity
          : u.expected;
        same(ops.identity('Snapshot', expectedProcess.pid), expectedProcess);
        if (!options.rollback) backup('before-stop');
        else backup('before-rollback');
        same(ops.identity('Snapshot', expectedProcess.pid), expectedProcess);
        references();
        stage('stop-reserved');
        transition = true;
        stopAttempted = true;
        const stopped = ops.identity(
          'Stop',
          expectedProcess.pid,
          expectedProcess,
        );
        if (stopped.stopped !== true) fail('STOP_UNCONFIRMED');
        oldStopped = true;
        stage('old-stopped');
        if (options.rollback) return await fallback(Error('EXPLICIT_ROLLBACK'));
        const final = backup('after-stop');
        const baseline = ops.state(u.database);
        receipt('baseline', baseline);
        const baselineFile = path.join(u.auditRoot, 'baseline.json');
        ops.state(final.backup, baselineFile);
        const before = ops.inspect(candidate, u.database, false);
        if (hash(before.pending) !== hash(u.pendingMigrations))
          fail('PENDING_MIGRATIONS_CHANGED');
        stage('migration-reserved');
        migrationAttempted = true;
        const migrated = await ops.migrate(candidate);
        if (hash(migrated.appliedMigrationNames) !== hash(u.pendingMigrations))
          fail('MIGRATION_RESULT_CHANGED');
        receipt('migration', migrated);
        check();
        ops.state(u.database, baselineFile);
        ops.inspect(candidate, u.database, true);
        stage('migrated');
        references();
        verifyRelease(candidate);
        if (
          fileHash(path.join(candidate, 'release.json')) !==
          p.packageProofs[path.basename(candidate)]
        )
          fail('CANDIDATE_CHANGED');
        child = ops.start(candidate);
        const health = await ops.ready(child),
          newIdentity = ops.identity('Snapshot', child.pid);
        if (newIdentity.executable !== path.join(candidate, 'runtime/node.exe'))
          fail('NEW_IDENTITY');
        stage('healthy');
        publish(path.basename(candidate));
        references();
        child.unref?.();
        return finish('passed', newIdentity, health);
      } catch (error) {
        if (!oldStopped && stopAttempted) {
          const owners = ops.identity('Port', 0);
          if (Array.isArray(owners) && owners.length === 0) oldStopped = true;
        }
        if (!oldStopped) throw error;
        if (state.publication.rollbackSpent) throw error;
        return await fallback(error);
      }
    });
  } catch (error) {
    if (state.publication) {
      state.publication.status = 'held';
      state.publication.failure = 'publication-incomplete';
      try {
        save();
      } catch {
        /* preserve uncertain claim */
      }
    }
    throw error;
  } finally {
    if (!closed) {
      try {
        owner();
        fs.unlinkSync(lock);
      } finally {
        closed = true;
      }
    }
  }
}
module.exports = {
  allowance,
  validate,
  measure,
  databaseBytes,
  execute,
};
