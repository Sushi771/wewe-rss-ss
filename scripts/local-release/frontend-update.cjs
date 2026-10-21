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
const { recognize: recognizeCompanion } = require('./frontend-companion.cjs');
const QUERY_TIMEOUT_MS = 15000;
const QUERY_MAX_BYTES = 4 * 1024 ** 2;
const QUERY_MAX_ENTRIES = 4096;
const SOURCE = 'f618e48f48ff0e3df1c646cb8a666a2461815732';
const BASE = '48fdf73f4d770001bbb6de3e2383189811e56ccb';
// Independently reviewed installed publisher: only the mutex was added to its
// existing implementation. Do not replace it with the newer development module.
const INSTALLED_PUBLISHER_SHA256 =
  '28bc6160cf040aa11c37e9413ea44e316eeb2923a482d12ba09b0c1458500009';
const GROWTH = 768 * 1024 ** 2;
const ORIGINAL_FAILED_PLAN_SHA256 =
  '2ce1d414469244e217a474fb86c31199212ba0587dfee135f14370a741df88b1';
const OWNED_CACHE_MOVE_PLAN_SHA256 =
  '73ffd16ecc339693efe4d653a051074576524c5aae1056b27dd2794bf1874e66';
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
function requireClientLayout(release) {
  const client = path.join(release, 'server/client');
  assert(
    fs.lstatSync(client).isDirectory() &&
      !fs.lstatSync(client).isSymbolicLink(),
    'FRONTEND_INSTALLED_LAYOUT_MISMATCH',
  );
  assert(
    lib.inside(release, canonical(client)) &&
      !fs.existsSync(path.join(release, 'client')),
    'FRONTEND_INSTALLED_LAYOUT_MISMATCH',
  );
  assert(
    fs.lstatSync(path.join(client, 'index.hbs')).isFile() &&
      fs.lstatSync(path.join(client, 'assets')).isDirectory(),
    'FRONTEND_INSTALLED_LAYOUT_MISMATCH',
  );
}
function requireSpace(root, allocation = 0) {
  const value = fs.statfsSync(root),
    available = Number(value.bavail) * Number(value.bsize);
  const rounded = allocation
    ? Math.ceil(allocation / Number(value.bsize)) * Number(value.bsize)
    : 0;
  assert(available >= FREE + rounded, 'FRONTEND_DISK_SPACE');
  return available;
}
function copyBudget(previous, manifest, files, root) {
  const allocationUnit = Number(fs.statfsSync(root).bsize);
  assert(Number.isSafeInteger(allocationUnit) && allocationUnit > 0);
  const directories = Object.keys(lib.releaseMetadata(previous))
    .filter((relative) =>
      fs.lstatSync(path.join(previous, relative)).isDirectory(),
    )
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  const sizes = {};
  let copyFileBytes = 0;
  for (const relative of Object.keys(manifest.files)) {
    const stat = fs.lstatSync(path.join(previous, relative));
    assert(stat.isFile() && !stat.isSymbolicLink());
    sizes[relative] = stat.size;
    copyFileBytes += stat.size;
  }
  const sourceSizes = { ...sizes };
  for (const file of files)
    sizes['server/client/' + file.path] = Math.max(
      sizes['server/client/' + file.path] || 0,
      file.bytes,
    );
  const round = (value) => Math.ceil(value / allocationUnit) * allocationUnit;
  const manifestReserveBytes =
    Buffer.byteLength(JSON.stringify(manifest, null, 2)) +
    Buffer.byteLength(
      JSON.stringify(
        files.map(({ path, sha256 }) => ({ path, sha256 })),
        null,
        2,
      ),
    ) +
    8192;
  const reserveBytes =
    Object.values(sizes).reduce((sum, size) => sum + round(size), 0) +
    round(manifestReserveBytes) +
    (directories.length + Object.keys(manifest.links).length + 4) *
      allocationUnit;
  assert(reserveBytes <= GROWTH, 'FRONTEND_GROWTH_EXCEEDS_RETAIN_ONLY_LIMIT');
  return {
    allocationUnit,
    directories,
    sourceSizes,
    copyFileBytes,
    resourceBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    manifestReserveBytes,
    reserveBytes,
  };
}
function lock(root, name) {
  const file = path.join(root, name),
    token = crypto.randomUUID();
  requireSpace(root, Buffer.byteLength(token));
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
    readOnlyCompanions: [],
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
    else if (appExe || sameDb) {
      try {
        const parent = raw.processes.find(
          (p) => p.ProcessId === item.ParentProcessId,
        );
        result.readOnlyCompanions.push(
          recognizeCompanion(
            item,
            args,
            parent,
            options.expected,
            options.companionOptions,
          ),
        );
      } catch {
        result.conflicts.push(item.ProcessId);
      }
    }
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
  for (const companion of observation.readOnlyCompanions || []) {
    assert(expected, 'FRONTEND_COMPANION_NOT_EXITED');
    sameIdentity(companion.parent, expected);
  }
}
async function plan(options) {
  const installation = canonical(options.installation),
    root = canonical(path.join(installation, '.local-releases'));
  const publicationTool = pin(
    path.join(installation, 'scripts/local-release/active-release.cjs'),
  );
  equal(publicationTool.sha256, INSTALLED_PUBLISHER_SHA256);
  const pointer = pin(path.join(root, 'active.json')),
    active = read(pointer.path);
  const previous = canonical(path.join(root, active.id));
  assert.equal(path.dirname(previous), root);
  const old = lib.verifyRelease(previous);
  assert.equal(old.sourceCommit, BASE);
  assert.equal(old.desktopHelperIncluded, false);
  assert.equal(old.schemaCompatibility, 'current');
  requireClientLayout(previous);
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
  const budget = copyBudget(previous, old, files, root),
    reserveBytes = options.forResume
      ? 4 * budget.allocationUnit
      : budget.reserveBytes;
  const availableBytesAtPlan = requireSpace(root, reserveBytes);
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
  const writerObservation = options.writerObservation
    ? pin(options.writerObservation)
    : null;
  const observedWriters = writerObservation
    ? classifyWriters(read(writerObservation.path), installation, database, {
        expected,
        databaseIdentity: id(database),
      })
    : null;
  if (observedWriters) validateWriters(observedWriters, expected);
  const readOnlyCompanions = observedWriters?.readOnlyCompanions || [];
  return {
    format: 2,
    kind: 'retain-only-frontend-v2',
    sourceCommit: SOURCE,
    baseCommit: BASE,
    installation,
    installationIdentity: id(installation),
    publicationTool,
    root,
    rootIdentity: id(root),
    pointer,
    previous,
    previousIdentity: id(previous),
    previousManifest: pin(path.join(previous, 'release.json')),
    database,
    databaseIdentity: id(database),
    config,
    files,
    historyAudit: {
      status: 'not-audited',
      bytes: null,
      slots: null,
      coverage:
        'other historical contents are retained untouched and not enumerated',
    },
    frontendDirectory: 'server/client',
    budget,
    availableBytesAtPlan,
    reserveBytes,
    candidateId,
    expected,
    writerObservation,
    readOnlyCompanions,
    globalReferenceCompleteness: 'unknown; no cleanup authorized',
    tool: pin(__filename),
    tools: toolPins(),
  };
}
function checkPlan(p) {
  assert.equal(p.format, 2);
  assert(
    ['retain-only-frontend-v2', 'resume-owned-frontend-v1'].includes(p.kind),
    'FRONTEND_PLAN_OPERATION_INVALID',
  );
  assert.equal(p.sourceCommit, SOURCE);
  assert.equal(p.baseCommit, BASE);
  equal(id(p.root), p.rootIdentity);
  equal(id(p.installation), p.installationIdentity);
  equal(
    p.publicationTool.path,
    canonical(
      path.join(p.installation, 'scripts/local-release/active-release.cjs'),
    ),
  );
  checkPin(p.publicationTool);
  equal(p.publicationTool.sha256, INSTALLED_PUBLISHER_SHA256);
  equal(canonical(path.join(p.installation, '.local-releases')), p.root);
  equal(
    canonical(path.join(p.installation, 'apps/server/data/wewe-rss.db')),
    p.database,
  );
  equal(id(p.database), p.databaseIdentity);
  assert(/^frontend-[a-f0-9]{12}-[a-f0-9-]{36}$/.test(p.candidateId));
  assert(p.reserveBytes > 0 && p.reserveBytes <= GROWTH);
  equal(p.historyAudit.status, 'not-audited');
  equal(p.historyAudit.bytes, null);
  equal(p.historyAudit.slots, null);
  assert(
    !Object.hasOwn(p, 'baseline') && !Object.hasOwn(p, 'maxTotalBytes'),
    'FRONTEND_HISTORY_AUDIT_NOT_CLAIMED',
  );
  equal(id(p.previous), p.previousIdentity);
  equal(p.frontendDirectory, 'server/client');
  requireClientLayout(p.previous);
  assert.equal(path.dirname(p.previous), p.root);
  checkPin(p.tool);
  if (p.writerObservation) checkPin(p.writerObservation);
  equal(toolPins(), p.tools);
  checkPin(p.previousManifest);
  equal(
    copyBudget(p.previous, read(p.previousManifest.path), p.files, p.root),
    p.budget,
  );
  equal(
    p.reserveBytes,
    p.kind === 'resume-owned-frontend-v1'
      ? 4 * p.budget.allocationUnit
      : p.budget.reserveBytes,
  );
  p.config.forEach(checkPin);
  if (p.kind === 'resume-owned-frontend-v1') verifyResume(p);
}
function verifyResume(p) {
  const r = p.resume;
  assert(r, 'FRONTEND_RESUME_PROOF_REQUIRED');
  checkPin(r.originalPlan);
  equal(r.originalPlan.sha256, ORIGINAL_FAILED_PLAN_SHA256);
  checkPin(r.cacheMovePlan);
  equal(r.cacheMovePlan.sha256, OWNED_CACHE_MOVE_PLAN_SHA256);
  checkPin(r.cacheMoveResult);
  const original = read(r.originalPlan.path),
    moves = read(r.cacheMovePlan.path),
    result = read(r.cacheMoveResult.path);
  equal(original.candidateId, p.candidateId);
  equal(original.previous, p.previous);
  equal(original.previousManifest, p.previousManifest);
  equal(original.files, p.files);
  equal(original.root, p.root);
  equal(original.previousIdentity, p.previousIdentity);
  equal(moves.rootIdentity, p.rootIdentity);
  equal(moves.installationIdentity, p.installationIdentity);
  equal(id(moves.quarantine), moves.quarantineIdentity);
  equal(result.planSha256, OWNED_CACHE_MOVE_PLAN_SHA256);
  equal(result.passed, true);
  equal(result.files.length, 6);
  equal(result.directories.length, 2);
  equal(result.packagesFullyVerified, 2);
  const approved = moves.packages.find((pkg) => pkg.label === 'candidate');
  assert(approved);
  const candidate = path.join(p.root, p.candidateId);
  equal(approved.root, candidate);
  equal(approved.rootIdentity, r.directoryIdentity);
  equal(approved.manifest, r.manifest);
  equal(id(candidate), r.directoryIdentity);
  checkPin(r.manifest);
  equal(lib.releaseMetadata(candidate), r.metadata);
  const manifest = lib.verifyRelease(candidate);
  equal(manifest.id, p.candidateId);
  equal(manifest.sourceCommit, SOURCE);
  equivalent(
    lib.verifyRelease(p.previous),
    lib.fingerprint(candidate),
    p.files,
  );
  for (const pkg of moves.packages) {
    equal(id(pkg.root), pkg.rootIdentity);
    checkPin(pkg.manifest);
    equal(id(pkg.targetDirectory), pkg.targetDirectoryIdentity);
    const directory = result.directories.find(
      (entry) =>
        entry.source === pkg.sourceDirectory &&
        entry.target === pkg.emptyDirectoryTarget,
    );
    assert(directory && directory.status === 'moved-empty-no-overwrite');
    equal(id(directory.target), pkg.sourceDirectoryIdentity);
    equal(fs.readdirSync(directory.target), []);
    assert(
      !fs.existsSync(pkg.sourceDirectory),
      'FRONTEND_RECOVERY_CACHE_REAPPEARED',
    );
    for (const file of pkg.files) {
      const done = result.files.find(
        (entry) => entry.source === file.source && entry.target === file.target,
      );
      assert(done && done.status === 'moved-and-verified');
      equal(done.sha256, file.sha256);
      equal(id(file.target), file.identity);
      equal(lib.fileHash(file.target), file.sha256);
      assert(!fs.existsSync(file.source), 'FRONTEND_RECOVERY_CACHE_REAPPEARED');
    }
  }
}
async function resumePlan(options) {
  const originalPlan = pin(options.originalPlan),
    cacheMovePlan = pin(options.cacheMovePlan),
    cacheMoveResult = pin(options.cacheMoveResult);
  equal(originalPlan.sha256, ORIGINAL_FAILED_PLAN_SHA256);
  equal(cacheMovePlan.sha256, OWNED_CACHE_MOVE_PLAN_SHA256);
  const original = read(originalPlan.path),
    moves = read(cacheMovePlan.path),
    approved = moves.packages.find((pkg) => pkg.label === 'candidate');
  assert(approved);
  // Common read-only planning allocates no candidate; replace its unused UUID
  // with the sole previously created and reviewed candidate before saving.
  const p = await plan({ ...options, forResume: true });
  p.kind = 'resume-owned-frontend-v1';
  p.candidateId = original.candidateId;
  p.reserveBytes = 4 * p.budget.allocationUnit;
  p.resume = {
    originalPlan,
    cacheMovePlan,
    cacheMoveResult,
    directoryIdentity: approved.rootIdentity,
    manifest: approved.manifest,
    metadata: lib.releaseMetadata(approved.root),
    noCandidateCreation: true,
  };
  checkPlan(p);
  return p;
}
function equivalent(old, next, files) {
  equal(next.links, old.links);
  const expected = { ...old.files };
  for (const f of files) {
    const key = 'server/client/' + f.path;
    if (f.path !== 'index.hbs' && expected[key] && expected[key] !== f.sha256)
      throw Error('FRONTEND_EXISTING_ASSET_COLLISION');
    expected[key] = f.sha256;
  }
  equal(Object.entries(next.files).sort(), Object.entries(expected).sort());
}
function copyFixed(source, target, bytes, root) {
  requireSpace(root, bytes);
  const input = fs.openSync(source, 'r'),
    before = fs.fstatSync(input, { bigint: true });
  let output;
  try {
    assert(
      before.isFile() && Number(before.size) === bytes,
      'FRONTEND_SOURCE_SIZE_CHANGED',
    );
    output = fs.openSync(target, 'wx');
    const buffer = Buffer.alloc(65536);
    let remaining = bytes;
    while (remaining) {
      const count = fs.readSync(
        input,
        buffer,
        0,
        Math.min(buffer.length, remaining),
        null,
      );
      assert(count > 0, 'FRONTEND_SOURCE_TRUNCATED');
      let written = 0;
      while (written < count) {
        const amount = fs.writeSync(output, buffer, written, count - written);
        assert(amount > 0, 'FRONTEND_WRITE_MADE_NO_PROGRESS');
        written += amount;
      }
      remaining -= count;
    }
    assert.equal(
      fs.readSync(input, buffer, 0, 1, null),
      0,
      'FRONTEND_SOURCE_GREW',
    );
    const after = fs.fstatSync(input, { bigint: true });
    equal(
      [before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs].map(
        String,
      ),
      [after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs].map(
        String,
      ),
    );
    fs.fsyncSync(output);
  } finally {
    if (output !== undefined) fs.closeSync(output);
    fs.closeSync(input);
  }
  requireSpace(root);
}
function copyPackage(previous, candidate, manifest, budget, root) {
  requireSpace(root, budget.reserveBytes);
  fs.mkdirSync(candidate);
  for (const relative of budget.directories) {
    if (relative) {
      requireSpace(root, budget.allocationUnit);
      fs.mkdirSync(path.join(candidate, relative));
    }
  }
  for (const relative of Object.keys(manifest.files)) {
    if (relative === 'server/client/index.hbs') continue; // create the replacement exclusively, never follow an overwritten target
    copyFixed(
      path.join(previous, relative),
      path.join(candidate, relative),
      budget.sourceSizes[relative],
      root,
    );
  }
  for (const [relative, target] of Object.entries(manifest.links)) {
    const original = canonical(path.join(previous, relative));
    assert(lib.inside(previous, original));
    equal(lib.slash(path.relative(previous, original)), target);
    requireSpace(root, budget.allocationUnit);
    fs.symlinkSync(
      path.join(candidate, target),
      path.join(candidate, relative),
      fs.statSync(original).isDirectory() ? 'junction' : 'file',
    );
  }
  requireSpace(root);
}
async function apply(p, adapter) {
  assert.equal(p.kind, 'retain-only-frontend-v2');
  return executeUpdate(p, adapter, false);
}
async function resumeOwnedCandidate(p, adapter) {
  assert.equal(p.kind, 'resume-owned-frontend-v1');
  return executeUpdate(p, adapter, true);
}
async function executeUpdate(p, adapter, resuming) {
  assert(!lib.hostEffects.context.getStore(), 'FRONTEND_NESTED_HOST_OPERATION');
  checkPlan(p);
  assert(
    resuming || !fs.existsSync(path.join(p.root, p.candidateId)),
    'FRONTEND_CANDIDATE_EXISTS; preserve it; no automatic retry',
  );
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

  const pointerCheck = () => checkPin(p.pointer);
  const before = async () => {
    checkPlan(p);
    locks.forEach((l) => l.check());
    pointerCheck();
    requireSpace(p.root);
    checkPin(p.previousManifest);
    lib.verifyRelease(p.previous);
  };
  try {
    for (const name of names)
      locks.push(
        lock(name === '.active-release.lock' ? p.installation : p.root, name),
      );
    await before();
    oldSnapshot = lib.fingerprint(p.previous);
    sameIdentity(await adapter.snapshot(p.expected.pid), p.expected);
    const initialWriters = await adapter.writers();
    validateWriters(initialWriters, p.expected);
    const readOnlyCompanions = initialWriters.readOnlyCompanions || [];
    equal(readOnlyCompanions, p.readOnlyCompanions || []);
    const free = fs.statfsSync(p.root);
    assert(
      Number(free.bavail) * Number(free.bsize) >= FREE + p.reserveBytes,
      'FRONTEND_DISK_SPACE',
    );
    candidate = path.join(p.root, p.candidateId);
    if (!resuming) {
      copyPackage(
        p.previous,
        candidate,
        lib.verifyRelease(p.previous),
        p.budget,
        p.root,
      );
      for (const f of p.files) {
        equal(lib.fileHash(f.input), f.sha256);
        const target = path.join(candidate, 'server/client', f.path);
        assert(lib.inside(candidate, canonical(path.dirname(target))));
        if (f.path !== 'index.hbs' && fs.existsSync(target)) {
          assert(
            fs.lstatSync(target).isFile() &&
              !fs.lstatSync(target).isSymbolicLink(),
          );
          equal(lib.fileHash(target), f.sha256);
        } else copyFixed(f.input, target, f.bytes, p.root);
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
      const manifestBytes = Buffer.from(
        JSON.stringify(manifest, null, 2) + '\n',
      );
      assert(
        manifestBytes.length <= p.budget.manifestReserveBytes,
        'FRONTEND_MANIFEST_RESERVATION_EXCEEDED',
      );
      requireSpace(p.root, manifestBytes.length);
      fs.writeFileSync(path.join(candidate, 'release.json'), manifestBytes, {
        flag: 'wx',
      });
      requireSpace(p.root);
    }
    const candidateManifest = resuming
      ? p.resume.manifest
      : pin(path.join(candidate, 'release.json'));
    const candidateIdentity = resuming
        ? p.resume.directoryIdentity
        : id(candidate),
      candidateMetadata = resuming
        ? p.resume.metadata
        : lib.releaseMetadata(candidate);
    const verifyCandidate = () => {
      equal(id(candidate), candidateIdentity);
      checkPin(candidateManifest);
      equal(lib.releaseMetadata(candidate), candidateMetadata);
      lib.verifyRelease(candidate);
      equivalent(oldSnapshot, lib.fingerprint(candidate), p.files);
    };
    verifyCandidate();
    await before();
    requireSpace(p.root);
    // Recheck exact identity, all app writers, pointer and frozen history before stopping.
    sameIdentity(await adapter.snapshot(p.expected.pid), p.expected);
    validateWriters(await adapter.writers(), p.expected);
    stopped = true; // Stop errors can occur after termination; rollback still requires confirmed exit.
    const result = await adapter.stop(p.expected);
    assert.equal(result.stopped, true, 'FRONTEND_OLD_INSTANCE_NOT_EXITED');
    await adapter.requireExited(p.expected);
    for (const companion of readOnlyCompanions)
      await adapter.requireExited(companion);
    validateWriters(await adapter.writers(), null);
    await adapter.requireFreePort();
    await before();
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
    await before();
    verifyCandidate();
    await adapter.verifyAssets(p.files);
    await before();
    verifyCandidate();
    // Shared publication lock remains owned through the compare and rename.
    const temp = path.join(p.root, 'active-' + crypto.randomUUID() + '.tmp');
    requireSpace(p.root, 4096);
    fs.writeFileSync(
      temp,
      JSON.stringify({ format: 1, id: p.candidateId }) + '\n',
      { flag: 'wx' },
    );
    pointerCheck();
    requireSpace(p.root);
    fs.renameSync(temp, p.pointer.path);
    adapter.detach?.(newProcess);
    return {
      passed: true,
      candidate,
      sourceCommit: SOURCE,
      oldStopped: true,
      resumedExistingCandidate: resuming,
      globalReferenceCompleteness: p.globalReferenceCompleteness,
      databaseRestored: false,
      readOnlyCompanions: readOnlyCompanions.map((companion) => ({
        ...companion,
        oldOwnerExitConfirmed: true,
      })),
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
  // Match the existing controlled restart: Python helpers must not mutate the
  // immutable candidate or rollback package by creating __pycache__ files.
  env.PYTHONDONTWRITEBYTECODE = '1';
  let applicationIdentity = p.expected;
  const adapter = {
    snapshot: (pid) => {
      const actual = processIdentity('Snapshot', pid, 4000);
      applicationIdentity = actual;
      return actual;
    },
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
        { databaseIdentity: p.databaseIdentity, expected: applicationIdentity },
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
          // Vite chunks may be loaded by the entry module rather than by HTML.
          // Bind the served entry references to the reviewed template; every
          // artifact, including indirect chunks, still receives its HTTP hash check.
          const template = fs.readFileSync(f.input);
          equal(hash(template), f.sha256);
          const references = (html) =>
            [...html.matchAll(/(?:src|href)=["'](\/dash\/assets\/[^"']+)["']/g)]
              .map((match) => match[1])
              .sort();
          const expected = references(template.toString());
          assert(expected.length > 0, 'FRONTEND_TEMPLATE_REFERENCES_MISSING');
          for (const asset of expected)
            assert(
              files.some((file) => '/dash/' + file.path === asset),
              'FRONTEND_TEMPLATE_ASSET_UNREVIEWED',
            );
          assert.deepEqual(
            references(bytes.toString()),
            expected,
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
      'writer-observation': { type: 'string' },
      'original-plan': { type: 'string' },
      'cache-move-plan': { type: 'string' },
      'cache-move-result': { type: 'string' },
      'prepare-resume': { type: 'boolean', default: false },
      resume: { type: 'boolean', default: false },
      plan: { type: 'string' },
      'approved-sha256': { type: 'string' },
      apply: { type: 'boolean', default: false },
    },
  });
  if (values.apply || values.resume) {
    assert(!(values.apply && values.resume), 'FRONTEND_OPERATION_AMBIGUOUS');
    assert(
      /^[a-f0-9]{64}$/.test(values['approved-sha256'] || ''),
      'FRONTEND_REVIEWED_PLAN_REQUIRED',
    );
    equal(lib.fileHash(values.plan), values['approved-sha256']);
    const p = read(values.plan);
    console.log(
      JSON.stringify(
        await (values.resume ? resumeOwnedCandidate : apply)(
          p,
          productionAdapter(p),
        ),
      ),
    );
  } else {
    const p = await (values['prepare-resume'] ? resumePlan : plan)({
      ...values,
      writerObservation: values['writer-observation'],
      expected: read(values.expected),
      originalPlan: values['original-plan'],
      cacheMovePlan: values['cache-move-plan'],
      cacheMoveResult: values['cache-move-result'],
    });
    fs.writeFileSync(values.plan, JSON.stringify(p, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        plan: values.plan,
        sha256: lib.fileHash(values.plan),
        applied: false,
        historyAudit: p.historyAudit,
        reserveBytes: p.reserveBytes,
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
  resumePlan,
  resumeOwnedCandidate,
  equivalent,
  validateWriters,
  classifyWriters,
  productionAdapter,
};
