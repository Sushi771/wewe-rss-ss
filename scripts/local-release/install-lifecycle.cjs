// Finite upgrade admission for verified installed roles, not build worktrees.
// No historical deletion, service control, database copy, or network request.
const fs = require('./lib.cjs').hostEffects.fs,
  path = require('node:path'),
  crypto = require('node:crypto');
const {
  verifyRelease,
  fileHash,
  inside,
  releaseMetadata,
} = require('./lib.cjs');
const { canonical } = require('./space-budget.cjs');
const DEFAULTS = Object.freeze({
  packages: 3,
  bytes: 768 * 1024 ** 2,
  free: 4 * 1024 ** 3,
});
const id = (value) =>
  typeof value === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9T.Z-]{0,159}$/.test(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (values) => [...new Set(values)].sort();
function exists(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
}
function artifacts(root) {
  const rows = fs.readdirSync(root, { withFileTypes: true });
  if (rows.length > 4096) throw new Error('RELEASE_LAYOUT_REQUIRES_REVIEW');
  return rows
    .filter(
      (e) =>
        e.isDirectory() &&
        !e.isSymbolicLink() &&
        (exists(path.join(root, e.name, 'release.json')) ||
          exists(path.join(root, e.name, 'runtime/node.exe'))),
    )
    .map((e) => e.name)
    .sort();
}
function usage(folder, block) {
  let bytes = 0,
    physical = 0,
    entries = 0;
  const deadline = performance.now() + 10000;
  function visit(at) {
    for (const name of fs.readdirSync(at)) {
      if (++entries > 100000 || performance.now() > deadline)
        throw new Error('RELEASE_USAGE_SCAN_LIMIT');
      const file = path.join(at, name),
        s = fs.lstatSync(file);
      if (s.isSymbolicLink()) {
        physical += block;
        continue;
      }
      if (s.isDirectory()) {
        physical += block;
        visit(file);
      } else if (s.isFile()) {
        bytes += s.size;
        physical += Math.ceil(s.size / block) * block;
      } else throw new Error('Unsupported release entry');
      if (bytes > DEFAULTS.bytes)
        throw new Error('RELEASE_MANAGED_BYTES_EXCEEDED');
    }
  }
  visit(folder);
  return { bytes, physical };
}
function role(source, block) {
  const folder = fs.realpathSync.native(source),
    mfile = path.join(folder, 'release.json'),
    s = fs.lstatSync(mfile);
  if (!s.isFile() || s.isSymbolicLink() || s.size > 8 * 1024 ** 2)
    throw new Error('RELEASE_MANIFEST_REQUIRES_REVIEW');
  const amount = usage(folder, block),
    before = releaseMetadata(folder),
    manifestSha = fileHash(mfile),
    m = verifyRelease(folder);
  if (
    manifestSha !== fileHash(mfile) ||
    !equal(before, releaseMetadata(folder))
  )
    throw new Error('RELEASE_ROLE_CHANGED_DURING_VERIFICATION');
  if (
    !id(m.id) ||
    m.id !== path.basename(folder) ||
    m.schemaCompatibility !== 'current' ||
    !/^[a-f0-9]{40}$/.test(m.sourceCommit) ||
    !/^[a-f0-9]{64}$/.test(m.sourceHash) ||
    !/^[a-f0-9]{64}$/.test(m.files?.['runtime/node.exe'])
  )
    throw new Error('RELEASE_ROLE_PROOF_INVALID');
  return { folder, manifest: m, manifestSha, ...amount };
}
function loadState(file) {
  if (!exists(file)) return;
  const s = fs.lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink() || s.size > 65536)
    throw new Error('RELEASE_LIFECYCLE_STATE_INVALID');
  const value = JSON.parse(fs.readFileSync(file, 'utf8')),
    p = value.payload;
  if (
    !p ||
    p.format !== 1 ||
    p.maxPackages !== 3 ||
    p.maxBytes !== DEFAULTS.bytes ||
    value.digest !==
      crypto.createHash('sha256').update(JSON.stringify(p)).digest('hex') ||
    !Array.isArray(p.legacyIds) ||
    p.legacyIds.length > 128 ||
    !Array.isArray(p.managedIds) ||
    p.managedIds.length < 1 ||
    p.managedIds.length > 3 ||
    ![...p.legacyIds, ...p.managedIds].every(id) ||
    p.managedIds.some((value) => p.legacyIds.includes(value)) ||
    !equal(p.legacyIds, sorted(p.legacyIds)) ||
    !equal(p.managedIds, sorted(p.managedIds))
  )
    throw new Error('RELEASE_LIFECYCLE_STATE_INVALID');
  return p;
}
function store(file, payload) {
  const value = JSON.stringify({
    payload,
    digest: crypto
      .createHash('sha256')
      .update(JSON.stringify(payload))
      .digest('hex'),
  });
  if (Buffer.byteLength(value) > 65536)
    throw new Error('RELEASE_LIFECYCLE_STATE_LIMIT');
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, value);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (exists(temp)) fs.unlinkSync(temp);
  }
}
function installPair(root, plan, options = {}) {
  require('./release-scope.cjs').assertWritableSession(['install']);
  options.scope?.assertWritable?.(['install']);
  root = canonical(root);
  let selectedPolicy = options.scope?.policy || require('./release-scope.cjs').session()?.policy;
  if (!selectedPolicy && process.env.WEWE_RELEASE_SCOPE_FILE && /^[a-f0-9]{64}$/.test(process.env.WEWE_RELEASE_SCOPE_SHA256 || '')) {
    const file = canonical(process.env.WEWE_RELEASE_SCOPE_FILE), s = fs.lstatSync(file);
    if (!s.isFile() || s.isSymbolicLink() || s.size > 1024 * 1024 || fileHash(file) !== process.env.WEWE_RELEASE_SCOPE_SHA256)
      throw new Error('RELEASE_FROZEN_PLAN_MISMATCH');
    selectedPolicy = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  const retainOnly = selectedPolicy && require('./preserving-contract.cjs').preservingEffectScope(selectedPolicy);
  if (retainOnly && (selectedPolicy.preservingUpdate.operation !== 'install' || retainOnly.container !== root))
    throw new Error('RELEASE_PRESERVING_EFFECT_FORBIDDEN');
  const maxBytes = options.maxBytes ?? DEFAULTS.bytes,
    minFree = options.minFree ?? DEFAULTS.free;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > DEFAULTS.bytes ||
    !Number.isSafeInteger(minFree) ||
    minFree < DEFAULTS.free ||
    !id(plan?.current)
  )
    throw new Error('Invalid installed-release limits or current role');
  if (
    options.adoptLegacy !== undefined &&
    (!Array.isArray(options.adoptLegacy) ||
      options.adoptLegacy.length > 128 ||
      !options.adoptLegacy.every(id))
  )
    throw new Error('RELEASE_ADOPTION_REQUIRES_EXACT_INVENTORY');
  const pointer = path.join(root, 'active.json'),
    ps = fs.lstatSync(pointer);
  if (!ps.isFile() || ps.isSymbolicLink() || ps.size > 65536)
    throw new Error('RELEASE_CURRENT_POINTER_INVALID');
  const pointerSha = fileHash(pointer),
    active = JSON.parse(fs.readFileSync(pointer, 'utf8'));
  if (active.format !== 1 || active.id !== plan.current)
    throw new Error('RELEASE_CURRENT_CHANGED');
  const lock = path.join(root, '.build-budget.lock'),
    owner = Buffer.from(
      JSON.stringify({ pid: process.pid, token: crypto.randomUUID() }),
    );
  fs.writeFileSync(lock, owner, { flag: 'wx', mode: 0o600 });
  const assertOwner = () => {
    if (!fs.readFileSync(lock).equals(owner))
      throw new Error('RELEASE_INSTALL_OWNER_CHANGED');
  };
  const stateFile = path.join(root, '.release-lifecycle.json'),
    owned = [];
  let shared;
  let complete = false;
  try {
    const disk = fs.statfsSync(root, { bigint: true }),
      block = Number(disk.bsize);
    if (!Number.isSafeInteger(block) || block < 1)
      throw new Error('Invalid filesystem block size');
    const currentPath = path.join(root, plan.current);
    if (fs.lstatSync(currentPath).isSymbolicLink())
      throw new Error('RELEASE_ROLE_PATH_INVALID');
    const current = role(currentPath, block),
      candidate = role(plan.candidate, block),
      rollback = role(plan.rollback, block),
      roles = {
        current: current.manifest.id,
        rollback: rollback.manifest.id,
        candidate: candidate.manifest.id,
      };
    if (path.dirname(current.folder) !== root)
      throw new Error('RELEASE_ROLE_PATH_INVALID');
    for (const [name, r] of Object.entries({ current, candidate, rollback })) {
      const proof = plan.proofs?.[name];
      if (
        !proof ||
        proof.sourceCommit !== r.manifest.sourceCommit ||
        proof.manifestSha256 !== r.manifestSha
      )
        throw new Error('RELEASE_FROZEN_PLAN_MISMATCH');
    }
    const sources = new Map();
    for (const r of [current, rollback, candidate]) {
      const old = sources.get(r.manifest.id);
      if (old && old.manifestSha !== r.manifestSha)
        throw new Error('RELEASE_ROLE_ID_COLLISION');
      sources.set(r.manifest.id, r);
    }
    const ids = sorted([...sources.keys()]);
    if (ids.length > DEFAULTS.packages)
      throw new Error('RELEASE_PACKAGE_LIMIT_EXCEEDED');
    const prior = retainOnly ? undefined : loadState(stateFile),
      found = retainOnly ? fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : artifacts(root);
    let legacy;
    if (retainOnly) {
      if (retainOnly.lifecycleSha256 === null ? exists(stateFile) : !exists(stateFile) || fileHash(stateFile) !== retainOnly.lifecycleSha256)
        throw new Error('RELEASE_PRESERVING_LIFECYCLE_CHANGED');
      // Observed names are retained, unmanaged history, not a new global adoption.
      legacy = found.filter((value) => !ids.includes(value));
    } else if (prior) {
      legacy = prior.legacyIds;
      if (
        options.adoptLegacy !== undefined &&
        !equal(sorted(options.adoptLegacy), legacy)
      )
        throw new Error('RELEASE_LEGACY_BASELINE_IMMUTABLE');
      if (ids.some((value) => legacy.includes(value)))
        throw new Error('RELEASE_LEGACY_PROMOTION_REQUIRES_REVIEW');
      for (const previous of prior.managedIds)
        if (!ids.includes(previous) && exists(path.join(root, previous)))
          throw new Error('RELEASE_RETIREMENT_APPROVAL_REQUIRED');
      if (
        found.some(
          (value) =>
            !legacy.includes(value) &&
            !prior.managedIds.includes(value) &&
            !ids.includes(value),
        )
      )
        throw new Error('RELEASE_UNKNOWN_OUTPUT_REQUIRES_REVIEW');
    } else {
      legacy = found.filter((value) => !ids.includes(value));
      if (
        legacy.length > 128 ||
        legacy.some((value) => !id(value)) ||
        !Array.isArray(options.adoptLegacy) ||
        !equal(sorted(options.adoptLegacy), legacy)
      )
        throw new Error('RELEASE_ADOPTION_REQUIRES_EXACT_INVENTORY');
    }
    const missing = [];
    let retainedBytes = 0,
      physical = block * 64;
    for (const [value, source] of sources) {
      const target = path.join(root, value),
        s = exists(target);
      if (s) {
        if (!s.isDirectory() || s.isSymbolicLink())
          throw new Error('RELEASE_TARGET_REQUIRES_REVIEW');
        const kept = role(target, block);
        if (kept.manifestSha !== source.manifestSha)
          throw new Error('RELEASE_TARGET_MISMATCH');
        retainedBytes += kept.bytes;
      } else {
        missing.push({ target, source });
        retainedBytes += source.bytes;
        physical += source.physical;
      }
    }
    if (retainedBytes > maxBytes)
      throw new Error('RELEASE_MANAGED_BYTES_EXCEEDED');
    if (disk.bavail * disk.bsize - BigInt(physical) < BigInt(minFree))
      throw new Error('RELEASE_PHYSICAL_RESERVE_EXCEEDED');
    shared =
      options.scope ||
      require('./release-scope.cjs').open({
        kind: 'install',
        root,
        reserveBytes: physical,
        runtimeCopies: missing.length,
      });
    const installOwned = () => {
    if (retainOnly && !equal(require('./preserving-contract.cjs').preservingEffectScope(shared.policy), retainOnly))
      throw new Error('RELEASE_FROZEN_PLAN_MISMATCH');
    let schemaProofs;
    const preserving = shared.policy?.preservingUpdate;
    if (preserving) {
      if (preserving.operation !== 'install' || preserving.active.pointer !== pointer ||
          preserving.active.pointerSha256 !== pointerSha || preserving.active.currentId !== current.manifest.id ||
          preserving.active.candidateId !== candidate.manifest.id ||
          preserving.active.currentManifestSha256 !== current.manifestSha ||
          preserving.active.candidateManifestSha256 !== candidate.manifestSha)
        throw new Error('RELEASE_PRESERVING_ACTIVE_BINDING_CHANGED');
      schemaProofs = Object.fromEntries([['candidate', candidate], ['rollback', rollback]].map(([name, target]) =>
        [name, require('./preserving-contract.cjs').validateSameSchema(current.manifest, target.manifest, {
          oldRoot: current.folder, candidateRoot: target.folder,
          oldManifestSha256: current.manifestSha, candidateManifestSha256: target.manifestSha,
        })]));
    }
    shared.check();
    assertOwner();
    if (fileHash(pointer) !== pointerSha)
      throw new Error('RELEASE_CURRENT_CHANGED');
    // Persist exact managed intent before copying: a killed install cannot turn
    // partial output into a new unbounded legacy baseline on the next attempt.
    if (!retainOnly) store(stateFile, {
      format: 1,
      legacyIds: legacy,
      managedIds: ids,
      roles,
      maxPackages: 3,
      maxBytes: DEFAULTS.bytes,
    });
    for (const { target, source } of missing) {
      shared.check();
      shared.registerOutput(target);
      assertOwner();
      if (exists(target)) throw new Error('RELEASE_TARGET_APPEARED');
      fs.mkdirSync(target);
      owned.push({ target, identity: fs.lstatSync(target, { bigint: true }) });
      shared.createdOutput(target);
      fs.cpSync(source.folder, target, {
        recursive: true,
        force: false,
        errorOnExist: true,
        filter: (file) => !fs.lstatSync(file).isSymbolicLink(),
      });
      for (const [name, relative] of Object.entries(
        source.manifest.links || {},
      )) {
        const link = path.resolve(target, name),
          destination = path.resolve(target, relative);
        if (!inside(target, link) || !inside(target, destination))
          throw new Error('RELEASE_LINK_ESCAPE');
        fs.mkdirSync(path.dirname(link), { recursive: true });
        fs.symlinkSync(
          destination,
          link,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      }
      if (role(target, block).manifestSha !== source.manifestSha)
        throw new Error('RELEASE_INSTALLED_PROOF_CHANGED');
    }
    assertOwner();
    shared.check();
    if (fileHash(pointer) !== pointerSha)
      throw new Error('RELEASE_CURRENT_CHANGED');
    let finalBytes = 0;
    for (const value of ids) {
      const final = role(path.join(root, value), block);
      if (final.manifestSha !== sources.get(value).manifestSha)
        throw new Error('RELEASE_INSTALLED_PROOF_CHANGED');
      finalBytes += final.bytes;
    }
    if (!retainOnly &&
      artifacts(root).some(
        (value) => !ids.includes(value) && !legacy.includes(value),
      )
    )
      throw new Error('RELEASE_UNKNOWN_OUTPUT_REQUIRES_REVIEW');
    const finalDisk = fs.statfsSync(root, { bigint: true });
    if (
      finalBytes > maxBytes ||
      finalDisk.bavail * finalDisk.bsize < BigInt(minFree)
    )
      throw new Error('RELEASE_FINAL_BUDGET_EXCEEDED');
    complete = true;
    return {
      roles,
      managedIds: ids,
      managedBytes: finalBytes,
      legacyHeldIds: legacy.filter((value) => exists(path.join(root, value))),
      installedIds: missing.map((row) => row.source.manifest.id),
      reusedIds: ids.filter(
        (value) => !missing.some((row) => row.source.manifest.id === value),
      ),
      historicalDeletionPerformed: false,
      ...(retainOnly ? { historyObservation: { kind: 'immediate-directory-names-only', count: legacy.length, contentVerified: false, adopted: false } } : {}),
      ...(schemaProofs ? { schemaProofs } : {}),
    };
    };
    return shared.policy?.preservingUpdate ? require('./lib.cjs').hostEffects.context.run(shared, installOwned) : installOwned();
  } finally {
    try {
      assertOwner();
      if (!complete && owned.length) {
        shared?.allowCleanup(owned.map((row) => row.target));
        if (fileHash(pointer) !== pointerSha)
          throw new Error('RELEASE_CURRENT_CHANGED_PRESERVE_OUTPUT');
        for (const { target, identity } of owned) {
          const s = fs.lstatSync(target, { bigint: true });
          if (
            s.isSymbolicLink() ||
            s.dev !== identity.dev ||
            s.ino !== identity.ino ||
            s.birthtimeNs !== identity.birthtimeNs
          )
            throw new Error('RELEASE_FAILED_OUTPUT_CHANGED_PRESERVE');
        }
        for (const { target } of owned.reverse())
          fs.rmSync(target, { recursive: true });
      }
    } finally {
      try {
        assertOwner();
        fs.unlinkSync(lock);
      } finally {
        shared?.close(
          complete ? undefined : new Error('installation incomplete'),
        );
      }
    }
  }
}
module.exports = { installPair, DEFAULTS };
if (require.main === module) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--plan')
      throw new Error(
        'Usage: node install-lifecycle.cjs --plan <reviewed-private-json>',
      );
    const file = process.argv[3],
      s = fs.lstatSync(file);
    if (!s.isFile() || s.isSymbolicLink() || s.size > 65536)
      throw new Error('Invalid installation plan');
    const input = JSON.parse(fs.readFileSync(file, 'utf8'));
    console.log(
      JSON.stringify(
        installPair(input.root, input.plan, { adoptLegacy: input.adoptLegacy }),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
