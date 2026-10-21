'use strict';
// A retain-only frontend update. No deletion, migration, database copy, inventory
// adoption or global-reference completeness claim. Review the plan before apply.
const lib = require('./lib.cjs');
const fs = lib.hostEffects.fs;
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = lib.hostEffects.processes;
const { parseArgs, parseEnv } = require('node:util');
const { sameIdentity, processIdentity, waitReady } = require('./switch.cjs');
const { argv: windowsArgv } = require('./windows-release-references.cjs');
const QUERY_TIMEOUT_MS = 15000;
const QUERY_MAX_BYTES = 4 * 1024 ** 2;
const QUERY_MAX_ENTRIES = 4096;
const SOURCE = 'f618e48f48ff0e3df1c646cb8a666a2461815732';
const BASE = '48fdf73f4d770001bbb6de3e2383189811e56ccb';
const GROWTH = 768 * 1024 ** 2;
const FREE = 4 * 1024 ** 3;
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const jsonHash = (value) => hash(JSON.stringify(value));
const read = (file) =>
  JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const canonical = (file) => fs.realpathSync.native(file);
const id = (file) => {
  const s = fs.lstatSync(file, { bigint: true });
  return [s.dev, s.ino, s.birthtimeNs].map(String);
};
const equal = (a, b) => assert.deepEqual(a, b, 'FRONTEND_UPDATE_STATE_CHANGED');
const pin = (file) => ({ path: canonical(file), sha256: lib.fileHash(file) });
const toolPins = () =>
  fs
    .readdirSync(__dirname)
    .sort()
    .filter(
      (name) => /\.(cjs|ps1|cs)$/.test(name) && !name.endsWith('.test.cjs'),
    )
    .map((name) => pin(path.join(__dirname, name)));
function checkPin(value) {
  equal(lib.fileHash(value.path), value.sha256);
}
function inventory(root, excluded = []) {
  const rows = [],
    deadline = Date.now() + 60000;
  let bytes = 0,
    slots = 0,
    entries = 0;
  function visit(at, relative = '') {
    if (excluded.includes(relative)) return;
    if (++entries > 1500000 || Date.now() > deadline)
      throw Error('FRONTEND_INVENTORY_BUDGET');
    const s = fs.lstatSync(at, { bigint: true });
    const identity = [s.dev, s.ino, s.birthtimeNs].map(String);
    if (s.isSymbolicLink()) {
      // Junction aliases are not followed or double-counted. Escapes are refused.
      assert(lib.inside(root, canonical(at)), 'FRONTEND_HISTORY_LINK_ESCAPE');
      rows.push([relative, 'link', identity, canonical(at)]);
    } else if (s.isDirectory()) {
      rows.push([relative, 'directory', identity]);
      for (const name of fs.readdirSync(at).sort()) {
        if (!relative && excluded.includes(name)) continue;
        if (!relative && fs.lstatSync(path.join(at, name)).isDirectory())
          slots++;
        visit(path.join(at, name), relative ? relative + '/' + name : name);
      }
    } else {
      assert(s.isFile(), 'FRONTEND_UNSUPPORTED_ENTRY');
      bytes += Number(s.size);
      rows.push([
        relative,
        'file',
        identity,
        ...[s.size, s.mtimeNs, s.ctimeNs].map(String),
      ]);
    }
  }
  visit(root);
  return { bytes, slots, entries, digest: jsonHash(rows) };
}
function lock(root, name) {
  const file = path.join(root, name),
    token = crypto.randomUUID();
  fs.writeFileSync(file, token, { flag: 'wx', mode: 0o600 });
  const identity = id(file);
  return {
    check() {
      equal(id(file), identity);
      equal(fs.readFileSync(file, 'utf8'), token);
    },
    close() {
      this.check();
      fs.unlinkSync(file);
    },
  };
}
function command(release, database) {
  const exe = path.join(release, 'runtime/node.exe');
  const args = [
    path.join(release, 'runtime.cjs'),
    'start',
    '--database',
    database,
    '--port',
    '4000',
    '--production',
  ];
  // Same existing command contract. Spaces need separate review, no shell quoting guess.
  assert(
    ![exe, ...args].some((v) => /\s/.test(v)),
    'FRONTEND_COMMAND_SPACES_UNSUPPORTED',
  );
  return { exe, args, line: [exe, ...args].join(' ') };
}
function classifyWriters(raw, installation, database, options = {}) {
  assert.equal(raw.querySucceeded, true, 'FRONTEND_WRITER_QUERY_FAILED');
  assert(Array.isArray(raw.processes));
  assert(
    raw.processes.length <= QUERY_MAX_ENTRIES,
    'FRONTEND_WRITER_ENTRY_LIMIT',
  );
  assert(Number.isInteger(raw.collectorPid));
  const result = {
    querySucceeded: true,
    applicationPids: [],
    conflicts: [],
    unknown: [],
    globalComplete: false,
  };
  const normalize = (value) => path.win32.normalize(value.replace(/\//g, '\\'));
  const requireLocalPath = (value) => {
    // Reject UNC, extended/device namespaces, relative roots and ADS before any IO.
    assert(
      typeof value === 'string' && /^[a-z]:[\\/]/i.test(value),
      'FRONTEND_LOCAL_DATABASE_PATH_REQUIRED',
    );
    assert(!value.slice(2).includes(':'), 'FRONTEND_DEVICE_PATH_REFUSED');
    const normalized = normalize(value),
      drive = normalized.slice(0, 2).toUpperCase();
    assert(
      Array.isArray(raw.logicalDisks) && raw.logicalDisks.length <= 32,
      'FRONTEND_LOCAL_DRIVE_UNPROVEN',
    );
    const matches = raw.logicalDisks.filter(
      (disk) => String(disk.DeviceID).toUpperCase() === drive,
    );
    assert(
      matches.length === 1 &&
        matches[0].DriveType === 3 &&
        Object.hasOwn(matches[0], 'ProviderName') &&
        !matches[0].ProviderName,
      'FRONTEND_LOCAL_DRIVE_UNPROVEN',
    );
    for (const part of normalized.slice(3).split('\\'))
      assert(
        part &&
          !/[. ]$/.test(part) &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
        'FRONTEND_DEVICE_PATH_REFUSED',
      );
    return normalized;
  };
  const prefix =
    normalize(installation).replace(/\\$/, '').toLowerCase() + '\\';
  const resolveIdentity =
    options.resolveIdentity ||
    ((file) => {
      // Check each local component without following links. A local junction may
      // lead to UNC; never realpath/lstat a child below an unverified reparse link.
      let at = file.slice(0, 3),
        identity;
      for (const part of file.slice(3).split('\\')) {
        at = path.win32.join(at, part);
        const stat = fs.lstatSync(at, { bigint: true });
        assert(!stat.isSymbolicLink(), 'FRONTEND_DATABASE_LINK_REFUSED');
        identity = [stat.dev, stat.ino, stat.birthtimeNs].map(String);
      }
      return identity;
    });
  const databaseIdentity = resolveIdentity(requireLocalPath(database));
  if (options.databaseIdentity)
    equal(databaseIdentity, options.databaseIdentity);
  for (const item of raw.processes) {
    if (item.ProcessId === raw.collectorPid) continue; // exact read-only collector, not a system exemption
    const exe = item.ExecutablePath || '',
      line = item.CommandLine || '';
    const appExe = normalize(exe).toLowerCase().startsWith(prefix);
    let args;
    try {
      args = windowsArgv(line);
    } catch {
      if (appExe || /--database\b|runtime\.cjs/i.test(line))
        result.conflicts.push(item.ProcessId);
      else result.unknown.push(item.ProcessId);
      continue;
    }
    const databases = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--database') databases.push(args[++i]);
      else if (args[i].startsWith('--database='))
        databases.push(args[i].slice(11));
    }
    const runtime = args.some(
      (arg, i) =>
        path.win32.basename(arg).toLowerCase() === 'runtime.cjs' &&
        args[i + 1] === 'start',
    );
    if (!appExe && !runtime && databases.length === 0) {
      if (!exe || !line) result.unknown.push(item.ProcessId);
      continue;
    }
    // A relative path has no trustworthy cwd in Win32_Process. Do not guess it.
    if (
      databases.length !== 1 ||
      !databases[0] ||
      !/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(databases[0])
    ) {
      result.conflicts.push(item.ProcessId);
      continue;
    }
    let sameDb;
    try {
      sameDb =
        jsonHash(resolveIdentity(requireLocalPath(databases[0]))) ===
        jsonHash(databaseIdentity);
    } catch {
      result.conflicts.push(item.ProcessId);
      continue;
    }
    if (appExe && runtime && sameDb)
      result.applicationPids.push(item.ProcessId);
    else if (appExe || sameDb) result.conflicts.push(item.ProcessId);
  }
  for (const key of ['applicationPids', 'conflicts', 'unknown'])
    result[key].sort((a, b) => a - b);
  return result;
}
function validateWriters(observation, expected) {
  assert.equal(
    observation.querySucceeded,
    true,
    'FRONTEND_WRITER_QUERY_FAILED',
  );
  assert.deepEqual(
    observation.conflicts,
    [],
    'FRONTEND_DATABASE_WRITER_CONFLICT',
  );
  // Unrelated unknown records are retained as unknown; never used for cleanup.
  assert(
    Array.isArray(observation.unknown),
    'FRONTEND_UNKNOWN_OBSERVATION_REQUIRED',
  );
  if (expected) equal(observation.applicationPids, [expected.pid]);
  else equal(observation.applicationPids, []);
}
function plan(options) {
  const installation = canonical(options.installation),
    root = canonical(path.join(installation, '.local-releases'));
  const publicationTool = pin(
    path.join(installation, 'scripts/local-release/active-release.cjs'),
  );
  equal(
    publicationTool.sha256,
    lib.fileHash(path.join(__dirname, 'active-release.cjs')),
  );
  const pointer = pin(path.join(root, 'active.json')),
    active = read(pointer.path);
  const previous = canonical(path.join(root, active.id));
  assert.equal(path.dirname(previous), root);
  const old = lib.verifyRelease(previous);
  assert.equal(old.sourceCommit, BASE);
  assert.equal(old.desktopHelperIncluded, false);
  assert.equal(old.schemaCompatibility, 'current');
  const database = canonical(
    path.join(installation, 'apps/server/data/wewe-rss.db'),
  );
  const config = ['.env.local', '.env']
    .map((n) => path.join(installation, 'apps/server', n))
    .filter((f) => fs.existsSync(f))
    .map(pin);
  const artifacts = read(options.artifacts);
  assert.equal(artifacts.sourceCommit, SOURCE);
  assert.equal(artifacts.baseCommit, BASE);
  assert.equal(artifacts.files.length, 4);
  const web = canonical(options.web),
    files = artifacts.files.map((f) => {
      assert(
        /^(index\.hbs|assets\/index-[A-Za-z0-9_-]+\.(js|css))$/.test(f.path),
      );
      const input = canonical(path.join(web, f.path));
      assert(lib.inside(web, input));
      equal(lib.fileHash(input), f.sha256);
      equal(fs.statSync(input).size, f.bytes);
      return { ...f, input };
    });
  assert.equal(new Set(files.map((f) => f.path)).size, 4);
  assert(files.some((f) => f.path === 'index.hbs'));
  const baseline = inventory(root),
    oldBytes = inventory(previous).bytes;
  const reserveBytes =
    oldBytes + files.reduce((n, f) => n + f.bytes, 0) + 1024 * 1024;
  assert(reserveBytes <= GROWTH, 'FRONTEND_GROWTH_EXCEEDS_RETAIN_ONLY_LIMIT');
  const free = fs.statfsSync(root);
  assert(
    Number(free.bavail) * Number(free.bsize) >= FREE + reserveBytes,
    'FRONTEND_DISK_SPACE',
  );
  const candidateId =
    'frontend-' + SOURCE.slice(0, 12) + '-' + crypto.randomUUID();
  const expected = options.expected;
  assert(
    expected &&
      Number.isInteger(expected.pid) &&
      expected.startUtc &&
      expected.commandLine &&
      expected.executable,
  );
  const cmd = command(previous, database);
  equal(expected.commandLine, cmd.line);
  equal(expected.executable.toLowerCase(), cmd.exe.toLowerCase());
  equal(expected.port, 4000);
  return {
    format: 1,
    kind: 'retain-only-frontend-v1',
    sourceCommit: SOURCE,
    baseCommit: BASE,
    installation,
    installationIdentity: id(installation),
    publicationTool,
    root,
    rootIdentity: id(root),
    pointer,
    previous,
    previousManifest: pin(path.join(previous, 'release.json')),
    database,
    databaseIdentity: id(database),
    config,
    files,
    baseline,
    reserveBytes,
    maxTotalBytes: baseline.bytes + reserveBytes,
    candidateId,
    expected,
    globalReferenceCompleteness: 'unknown; no cleanup authorized',
    tool: pin(__filename),
    tools: toolPins(),
  };
}
function checkPlan(p) {
  assert.equal(p.kind, 'retain-only-frontend-v1');
  assert.equal(p.sourceCommit, SOURCE);
  assert.equal(p.baseCommit, BASE);
  equal(id(p.root), p.rootIdentity);
  equal(id(p.installation), p.installationIdentity);
  checkPin(p.publicationTool);
  equal(
    p.publicationTool.sha256,
    lib.fileHash(path.join(__dirname, 'active-release.cjs')),
  );
  equal(canonical(path.join(p.installation, '.local-releases')), p.root);
  equal(
    canonical(path.join(p.installation, 'apps/server/data/wewe-rss.db')),
    p.database,
  );
  equal(id(p.database), p.databaseIdentity);
  assert(/^frontend-[a-f0-9]{12}-[a-f0-9-]{36}$/.test(p.candidateId));
  assert(p.reserveBytes > 0 && p.reserveBytes <= GROWTH);
  equal(p.maxTotalBytes, p.baseline.bytes + p.reserveBytes);
  assert.equal(path.dirname(p.previous), p.root);
  checkPin(p.tool);
  equal(toolPins(), p.tools);
  checkPin(p.previousManifest);
  p.config.forEach(checkPin);
}
function equivalent(old, next, files) {
  equal(next.links, old.links);
  const expected = { ...old.files };
  for (const f of files) {
    const key = 'client/' + f.path;
    if (f.path !== 'index.hbs' && expected[key] && expected[key] !== f.sha256)
      throw Error('FRONTEND_EXISTING_ASSET_COLLISION');
    expected[key] = f.sha256;
  }
  equal(Object.entries(next.files).sort(), Object.entries(expected).sort());
}
function copyPackage(previous, candidate) {
  fs.mkdirSync(candidate); // must be new; never merge into an existing directory
  function copy(from, to) {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const source = path.join(from, entry.name),
        target = path.join(to, entry.name);
      if (entry.isSymbolicLink()) {
        const resolved = canonical(source);
        assert(lib.inside(previous, resolved));
        fs.symlinkSync(
          path.join(candidate, path.relative(previous, resolved)),
          target,
          fs.statSync(source).isDirectory() ? 'junction' : 'file',
        );
      } else if (entry.isDirectory()) {
        fs.mkdirSync(target);
        copy(source, target);
      } else {
        assert(entry.isFile());
        fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      }
    }
  }
  copy(previous, candidate);
}
async function apply(p, adapter) {
  assert(!lib.hostEffects.context.getStore(), 'FRONTEND_NESTED_HOST_OPERATION');
  checkPlan(p);
  const locks = [];
  let candidate,
    stopped = false,
    newProcess,
    oldSnapshot;
  // Retain-only mode shares build and pointer locks with the existing writers.
  const names = [
    '.build-budget.lock',
    '.active-release.lock',
    '.frontend-update.lock',
  ];
  const history = () => inventory(p.root, [...names, p.candidateId]);
  const pointerCheck = () => checkPin(p.pointer);
  const before = () => {
    checkPlan(p);
    locks.forEach((l) => l.check());
    pointerCheck();
    equal(history(), p.baseline);
    checkPin(p.previousManifest);
    lib.verifyRelease(p.previous);
  };
  try {
    for (const name of names)
      locks.push(
        lock(name === '.active-release.lock' ? p.installation : p.root, name),
      );
    before();
    oldSnapshot = lib.fingerprint(p.previous);
    sameIdentity(await adapter.snapshot(p.expected.pid), p.expected);
    validateWriters(await adapter.writers(), p.expected);
    const free = fs.statfsSync(p.root);
    assert(
      Number(free.bavail) * Number(free.bsize) >= FREE + p.reserveBytes,
      'FRONTEND_DISK_SPACE',
    );
    candidate = path.join(p.root, p.candidateId);
    copyPackage(p.previous, candidate);
    for (const f of p.files) {
      equal(lib.fileHash(f.input), f.sha256);
      const target = path.join(candidate, 'client', f.path);
      assert(lib.inside(candidate, canonical(path.dirname(target))));
      if (f.path !== 'index.hbs' && fs.existsSync(target))
        equal(lib.fileHash(target), f.sha256);
      else
        fs.copyFileSync(
          f.input,
          target,
          f.path === 'index.hbs' ? 0 : fs.constants.COPYFILE_EXCL,
        );
    }
    // Expected file set is derived BEFORE copying. Never adopt an external write.
    const copied = lib.fingerprint(candidate);
    equivalent(oldSnapshot, copied, p.files);
    const old = lib.verifyRelease(p.previous),
      manifest = {
        ...old,
        id: p.candidateId,
        sourceCommit: SOURCE,
        sourceHash: jsonHash({
          backendSourceHash: old.sourceHash,
          frontend: p.files.map(({ path, sha256 }) => ({ path, sha256 })),
        }),
        ...copied,
        frontendProvenance: {
          reviewedHead: SOURCE,
          backendReusedFrom: BASE,
          oldManifestSha256: p.previousManifest.sha256,
          oldHashedAssetsRetained: true,
        },
      };
    fs.writeFileSync(
      path.join(candidate, 'release.json'),
      JSON.stringify(manifest, null, 2) + '\n',
    );
    const candidateManifest = pin(path.join(candidate, 'release.json'));
    const candidateIdentity = id(candidate),
      candidateMetadata = lib.releaseMetadata(candidate);
    const verifyCandidate = () => {
      equal(id(candidate), candidateIdentity);
      checkPin(candidateManifest);
      equal(lib.releaseMetadata(candidate), candidateMetadata);
      lib.verifyRelease(candidate);
      equivalent(oldSnapshot, lib.fingerprint(candidate), p.files);
    };
    verifyCandidate();
    before();
    assert(
      inventory(candidate).bytes <= p.reserveBytes,
      'FRONTEND_RESERVATION_EXCEEDED',
    );
    // Recheck exact identity, all app writers, pointer and frozen history before stopping.
    sameIdentity(await adapter.snapshot(p.expected.pid), p.expected);
    validateWriters(await adapter.writers(), p.expected);
    stopped = true; // Stop errors can occur after termination; rollback still requires confirmed exit.
    const result = await adapter.stop(p.expected);
    assert.equal(result.stopped, true, 'FRONTEND_OLD_INSTANCE_NOT_EXITED');
    await adapter.requireExited(p.expected);
    validateWriters(await adapter.writers(), null);
    await adapter.requireFreePort();
    before();
    verifyCandidate();
    newProcess = await adapter.start(candidate, p.candidateId);
    await adapter.ready(newProcess);
    const running = await adapter.snapshot(newProcess.pid),
      cmd = command(candidate, p.database);
    equal(running.pid, newProcess.pid);
    equal(running.executable.toLowerCase(), cmd.exe.toLowerCase());
    equal(running.commandLine, cmd.line);
    equal(running.port, 4000);
    validateWriters(await adapter.writers(), running);
    before();
    verifyCandidate();
    await adapter.verifyAssets(p.files);
    before();
    verifyCandidate();
    // Shared publication lock remains owned through the compare and rename.
    const temp = path.join(p.root, 'active-' + crypto.randomUUID() + '.tmp');
    fs.writeFileSync(
      temp,
      JSON.stringify({ format: 1, id: p.candidateId }) + '\n',
      { flag: 'wx' },
    );
    pointerCheck();
    fs.renameSync(temp, p.pointer.path);
    adapter.detach?.(newProcess);
    return {
      passed: true,
      candidate,
      sourceCommit: SOURCE,
      oldStopped: true,
      globalReferenceCompleteness: p.globalReferenceCompleteness,
      databaseRestored: false,
    };
  } catch (error) {
    if (newProcess) {
      try {
        await adapter.stopNew(newProcess);
        await adapter.requireExited(newProcess);
      } catch (stopError) {
        throw new AggregateError(
          [error, stopError],
          'FRONTEND_NEW_STOP_FAILED; no second writer started',
        );
      }
    }
    if (stopped) {
      let fallback;
      try {
        await adapter.requireExited(p.expected);
        await adapter.requireFreePort();
        validateWriters(await adapter.writers(), null);
        checkPlan(p);
        checkPin(p.pointer);
        lib.verifyRelease(p.previous);
        fallback = await adapter.start(p.previous, path.basename(p.previous));
        await adapter.ready(fallback);
        const fallbackIdentity = await adapter.snapshot(fallback.pid);
        sameIdentity(fallbackIdentity, {
          ...p.expected,
          pid: fallback.pid,
          startUtc: fallback.startUtc || fallbackIdentity.startUtc,
        });
        validateWriters(await adapter.writers(), fallbackIdentity);
        adapter.detach?.(fallback);
      } catch (fallbackError) {
        const failures = [error, fallbackError];
        if (fallback) {
          try {
            await adapter.stopNew(fallback);
            await adapter.requireExited(fallback);
          } catch (stopError) {
            failures.push(stopError);
          }
        }
        throw new AggregateError(
          failures,
          'FRONTEND_UPDATE_AND_ROLLBACK_FAILED; retained packages; database not restored',
        );
      }
    }
    throw error;
  } finally {
    // Preserve failed candidate for inspection. Never delete packages or clear another owner.
    for (const owned of locks.reverse()) owned.close();
  }
}
function productionAdapter(p) {
  assert.equal(process.platform, 'win32');
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (
      /^(NODE_OPTIONS|NODE_PATH|PRISMA_.*|DATABASE_URL|LOCAL_RELEASE_.*)$/i.test(
        key,
      )
    )
      delete env[key];
  for (const cfg of p.config)
    for (const [key, value] of Object.entries(
      parseEnv(fs.readFileSync(cfg.path, 'utf8')),
    ))
      if (env[key] === undefined) env[key] = value;
  for (const key of Object.keys(env))
    if (
      /^(NODE_OPTIONS|NODE_PATH|PRISMA_.*|DATABASE_URL|LOCAL_RELEASE_.*)$/i.test(
        key,
      )
    )
      delete env[key];
  const run = lib.run;
  const adapter = {
    snapshot: (pid) => processIdentity('Snapshot', pid, 4000),
    stop: (expected) => processIdentity('Stop', expected.pid, 4000, expected),
    writers: () =>
      classifyWriters(
        JSON.parse(
          run(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-File',
              path.join(__dirname, 'frontend-writers.ps1'),
              '-Installation',
              p.installation,
              '-Database',
              p.database,
            ],
            { timeout: QUERY_TIMEOUT_MS, maxBuffer: QUERY_MAX_BYTES },
          ),
        ),
        p.installation,
        p.database,
        { databaseIdentity: p.databaseIdentity },
      ),
    requireExited: async (expected) => {
      // A missing PID is confirmed by CIM, not by a failed inaccessible snapshot.
      const result = JSON.parse(
        run(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -OperationTimeoutSec 10 -Filter 'ProcessId=${Number(expected.pid)}'; ConvertTo-Json -Compress -InputObject ([bool]($null -eq $p))`,
          ],
          { timeout: QUERY_TIMEOUT_MS, maxBuffer: QUERY_MAX_BYTES },
        ),
      );
      assert.equal(result, true, 'FRONTEND_OLD_INSTANCE_NOT_EXITED');
    },
    requireFreePort: async () =>
      equal(processIdentity('Port', undefined, 4000), []),
    start: async (release, releaseId) => {
      const cmd = command(release, p.database);
      // No database backup/copy: this mode changes no schema/backend/runtime.
      const child = spawn(cmd.exe, cmd.args, {
        cwd: path.join(p.installation, 'apps/server'),
        env: {
          ...env,
          LOCAL_RELEASE_CONTROLLED_START: releaseId,
          LOCAL_RELEASE_REUSE_VERIFIED: '0',
        },
        windowsHide: true,
        shell: false,
        detached: true,
        stdio: 'ignore',
      });
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      return child;
    },
    ready: async (child) => {
      const keys = ['PRIVATE_ONLINE_MODE', 'AUTH_CODE'];
      const prior = keys.map((key) => process.env[key]);
      try {
        for (const key of keys) {
          if (env[key] === undefined) delete process.env[key];
          else process.env[key] = env[key];
        }
        await waitReady(4000, child);
      } finally {
        keys.forEach((key, i) => {
          if (prior[i] === undefined) delete process.env[key];
          else process.env[key] = prior[i];
        });
      }
    },
    stopNew: async (child) => {
      if (child.exitCode !== null) return;
      // Owned child handle prevents PID reuse. Wait is bounded.
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(Error('FRONTEND_CHILD_STOP_TIMEOUT')),
          15000,
        );
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill();
      });
    },
    verifyAssets: async (files) => {
      for (const f of files) {
        const url =
          'http://127.0.0.1:4000/dash' +
          (f.path === 'index.hbs' ? '' : '/' + f.path);
        const response = await fetch(url, {
          signal: AbortSignal.timeout(10000),
        });
        assert(response.ok, 'FRONTEND_RESOURCE_HTTP_FAILED');
        const bytes = Buffer.from(await response.arrayBuffer());
        if (f.path === 'index.hbs') {
          for (const asset of files.filter((a) => a.path.endsWith('.js')))
            assert(
              bytes.toString().includes(asset.path),
              'FRONTEND_STALE_TEMPLATE',
            );
        } else equal(hash(bytes), f.sha256);
      }
    },
    detach: (child) => child.unref(),
  };
  return adapter;
}
async function main() {
  const { values } = parseArgs({
    options: {
      installation: { type: 'string' },
      web: { type: 'string' },
      artifacts: { type: 'string' },
      expected: { type: 'string' },
      plan: { type: 'string' },
      'approved-sha256': { type: 'string' },
      apply: { type: 'boolean', default: false },
    },
  });
  if (values.apply) {
    assert(
      /^[a-f0-9]{64}$/.test(values['approved-sha256'] || ''),
      'FRONTEND_REVIEWED_PLAN_REQUIRED',
    );
    equal(lib.fileHash(values.plan), values['approved-sha256']);
    const p = read(values.plan);
    console.log(JSON.stringify(await apply(p, productionAdapter(p))));
  } else {
    const p = plan({ ...values, expected: read(values.expected) });
    fs.writeFileSync(values.plan, JSON.stringify(p, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        plan: values.plan,
        sha256: lib.fileHash(values.plan),
        applied: false,
        historySlots: p.baseline.slots,
        historyBytes: p.baseline.bytes,
      }),
    );
  }
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
  });
module.exports = {
  plan,
  apply,
  inventory,
  equivalent,
  validateWriters,
  classifyWriters,
  productionAdapter,
};
