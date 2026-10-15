// One reviewed registry and lock for every cooperating release writer.
// No history deletion, process termination, service control or DB restoration.
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { execFileSync } = require('node:child_process');
const { fileHash } = require('./lib.cjs');
const DEFAULT_BYTES = 768 * 1024 ** 2,
  MIN_FREE = 4 * 1024 ** 3;
const context = new AsyncLocalStorage();
const hash = (v) =>
  crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const controls = new Set([
  '.build-budget.lock',
  '.release-lifecycle.json',
  'active.json',
]);
function read(file, max = 1024 * 1024) {
  const s = fs.lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink() || s.size > max)
    throw new Error('RELEASE_SCOPE_DOCUMENT_INVALID');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function identity(file) {
  const s = fs.lstatSync(file, { bigint: true });
  if (!s.isDirectory() || s.isSymbolicLink())
    throw new Error('RELEASE_SCOPE_ROOT_INVALID');
  return [s.dev, s.ino, s.birthtimeNs].map(String);
}
function fileIdentity(file) {
  const s = fs.lstatSync(file, { bigint: true });
  if (!s.isFile() || s.isSymbolicLink())
    throw new Error('RELEASE_SCOPE_STATE_REPLACED');
  return [s.dev, s.ino, s.birthtimeNs].map(String);
}
function canonical(file) {
  return fs.realpathSync.native(file);
}
function contains(root, file) {
  const r = path.relative(root, file);
  return (
    r === '' ||
    (!r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r))
  );
}
function present(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
}
function atomic(file, payload) {
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({ payload, digest: hash(payload) }));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (present(tmp)) fs.unlinkSync(tmp);
  }
}
function state(file) {
  const v = read(file, 8 * 1024 ** 2);
  if (!v.payload || v.digest !== hash(v.payload))
    throw new Error('RELEASE_SCOPE_STATE_CORRUPT');
  return v.payload;
}
function scan(roots, excluded = []) {
  let bytes = 0,
    entries = 0,
    runtimeCopies = 0;
  const rows = [],
    deadline = performance.now() + 30000;
  const excludedAt = (file) =>
    excluded.some((output) => contains(output, file));
  for (const root of roots) {
    const folder = canonical(root.path);
    if (hash(identity(folder)) !== hash(root.identity) || folder !== root.path)
      throw new Error('RELEASE_SCOPE_ROOT_CHANGED');
    function visit(at, relative = '') {
      const s = fs.lstatSync(at, { bigint: true });
      if (++entries > 100000 || performance.now() > deadline)
        throw new Error('RELEASE_SCOPE_SCAN_INCOMPLETE');
      const key = [root.path, relative.replace(/\\/g, '/')];
      if (s.isSymbolicLink()) {
        const target = canonical(at);
        if (!roots.some((r) => contains(r.path, target)))
          throw new Error('RELEASE_SCOPE_LINK_ESCAPE');
        if (!excludedAt(at))
          rows.push([...key, 'link', String(s.dev), String(s.ino), target]);
        return;
      }
      if (s.isDirectory()) {
        if (!excludedAt(at))
          rows.push([
            ...key,
            'dir',
            String(s.dev),
            String(s.ino),
            String(s.birthtimeNs),
          ]);
        for (const name of fs.readdirSync(at).sort())
          visit(path.join(at, name), path.join(relative, name));
        return;
      }
      if (!s.isFile() || s.nlink > 1n)
        throw new Error('RELEASE_SCOPE_UNSUPPORTED_FILE_OR_HARDLINK');
      bytes += Number(s.size);
      if (path.basename(at).toLowerCase() === 'node.exe') runtimeCopies++;
      if (!Number.isSafeInteger(bytes))
        throw new Error('RELEASE_SCOPE_BYTES_INVALID');
      const control =
        path.dirname(at) === folder && controls.has(path.basename(at));
      if (control && s.size > 65536n)
        throw new Error('RELEASE_SCOPE_CONTROL_FILE_LIMIT');
      if (!control && !excludedAt(at)) {
        const digest = fileHash(at),
          after = fs.lstatSync(at, { bigint: true });
        for (const field of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'])
          if (s[field] !== after[field])
            throw new Error('RELEASE_SCOPE_FILE_CHANGED_DURING_SCAN');
        rows.push([
          ...key,
          'file',
          ...[s.dev, s.ino, s.birthtimeNs, s.size, s.mtimeNs, s.ctimeNs].map(
            String,
          ),
          digest,
        ]);
      }
    }
    visit(folder);
  }
  return { bytes, entries, runtimeCopies, digest: hash(rows) };
}
function inspect(paths) {
  const roots = paths
    .map((value) => {
      const folder = canonical(value);
      return { path: folder, identity: identity(folder) };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  if (roots.length < 1 || roots.length > 32)
    throw new Error('RELEASE_SCOPE_ROOT_COUNT');
  for (let i = 0; i < roots.length; i++)
    for (let j = 0; j < i; j++)
      if (
        hash(roots[i].identity) === hash(roots[j].identity) ||
        contains(roots[i].path, roots[j].path) ||
        contains(roots[j].path, roots[i].path)
      )
        throw new Error('RELEASE_SCOPE_OVERLAPPING_ROOTS');
  return { roots, baseline: scan(roots) };
}
function validateReferences(value, policy) {
  const kinds = [
    'processes',
    'tasks',
    'shortcuts',
    'pointers',
    'rollback',
    'inflight',
  ];
  if (
    !value ||
    value.complete !== true ||
    kinds.some((k) => value.categories?.[k] !== true) ||
    !Array.isArray(value.records) ||
    value.records.length > 4096 ||
    !Array.isArray(value.errors) ||
    value.errors.length ||
    !Array.isArray(value.uncertainChildren) ||
    value.uncertainChildren.length
  )
    throw new Error('RELEASE_SCOPE_REFERENCE_QUERY_INCOMPLETE');
  if (
    value.compatibility?.verified !== true ||
    value.compatibility.businessDatabaseRestored !== false ||
    value.compatibility.proofSha256 !== policy.compatibilityProofSha256
  )
    throw new Error('RELEASE_SCOPE_COMPATIBILITY_UNPROVEN');
  for (const r of value.records) {
    if (
      !kinds.includes(r.kind) ||
      typeof r.packageId !== 'string' ||
      !policy.protectedIds.includes(r.packageId) ||
      typeof r.packagePath !== 'string' ||
      !policy.roots.some((root) =>
        contains(root.path, canonical(r.packagePath)),
      ) ||
      typeof r.identity !== 'string' ||
      !r.identity
    )
      throw new Error('RELEASE_SCOPE_UNRESOLVED_REFERENCE');
    if (
      r.viaPointer &&
      (!['tasks', 'shortcuts'].includes(r.kind) ||
        typeof r.viaPointer.path !== 'string' ||
        !path.isAbsolute(r.viaPointer.path) ||
        canonical(r.viaPointer.path) !== r.viaPointer.path ||
        !policy.roots.some((root) => contains(root.path, r.viaPointer.path)) ||
        path.basename(r.viaPointer.path) !== 'active.json' ||
        !/^[a-f0-9]{64}$/.test(r.viaPointer.launcherSha256 || '') ||
        !value.records.some(
          (p) =>
            p.kind === 'pointers' &&
            p.pointerPath === r.viaPointer.path &&
            p.packageId === r.packageId &&
            p.packagePath === r.packagePath,
        ))
    )
      throw new Error('RELEASE_SCOPE_UNRESOLVED_REFERENCE');
    if (
      r.kind === 'processes' &&
      (!Number.isInteger(r.pid) ||
        r.pid < 1 ||
        typeof r.startUtc !== 'string' ||
        !/^[a-f0-9]{64}$/.test(r.executableSha256))
    )
      throw new Error('RELEASE_SCOPE_PROCESS_IDENTITY_UNCERTAIN');
  }
  return hash(value);
}
function open(request, options = {}) {
  request = { runtimeCopies: 0, ...request };
  const configPath = options.configPath || process.env.WEWE_RELEASE_SCOPE_FILE,
    expected = options.configSha256 || process.env.WEWE_RELEASE_SCOPE_SHA256;
  if (!configPath || !/^[a-f0-9]{64}$/.test(expected || ''))
    throw new Error('RELEASE_SCOPE_REVIEWED_POLICY_REQUIRED');
  const file = canonical(configPath),
    policy = read(file),
    configSha = fileHash(file);
  if (
    configSha !== expected ||
    policy.format !== 1 ||
    !/^[a-f0-9-]{36}$/.test(policy.scopeId) ||
    !Array.isArray(policy.roots) ||
    !policy.roots.length ||
    policy.roots.length > 32 ||
    !Array.isArray(policy.protectedIds) ||
    !policy.protectedIds.length ||
    policy.protectedIds.length > 3 ||
    new Set(policy.protectedIds).size !== policy.protectedIds.length ||
    !Number.isSafeInteger(policy.maxBytes) ||
    policy.maxBytes < 1 ||
    !Number.isSafeInteger(policy.maxGrowthBytes) ||
    policy.maxGrowthBytes < 0 ||
    policy.maxGrowthBytes > DEFAULT_BYTES ||
    !policy.baseline ||
    !Number.isSafeInteger(policy.baseline.bytes) ||
    policy.baseline.bytes < 0 ||
    !Number.isSafeInteger(request.reserveBytes) ||
    request.reserveBytes < 0
  )
    throw new Error('RELEASE_SCOPE_POLICY_INVALID');
  if (
    !Number.isInteger(policy.maxNewRuntimeCopies) ||
    policy.maxNewRuntimeCopies < 0 ||
    policy.maxNewRuntimeCopies > 4 ||
    !Number.isInteger(policy.baseline.runtimeCopies) ||
    !Number.isInteger(request.runtimeCopies) ||
    request.runtimeCopies < 0 ||
    request.runtimeCopies > 4
  )
    throw new Error('RELEASE_SCOPE_RUNTIME_POLICY_INVALID');
  if (
    policy.maxBytes > DEFAULT_BYTES &&
    (!policy.exception?.approvalId ||
      policy.exception.baselineDigest !== policy.baseline.digest ||
      policy.exception.baselineBytes !== policy.baseline.bytes ||
      policy.exception.maxBytes !== policy.maxBytes ||
      policy.exception.maxGrowthBytes !== policy.maxGrowthBytes)
  )
    throw new Error('RELEASE_SCOPE_BASELINE_EXCEPTION_NOT_APPROVED');
  if (!/^[a-f0-9]{64}$/.test(policy.compatibilityProofSha256 || ''))
    throw new Error('RELEASE_SCOPE_COMPATIBILITY_UNPROVEN');
  const checkRoots = (inspectPaths) => {
    for (let i = 0; i < inspectPaths.length; i++) {
      const root = inspectPaths[i];
      if (
        !path.isAbsolute(root.path) ||
        canonical(root.path) !== root.path ||
        hash(identity(root.path)) !== hash(root.identity)
      )
        throw new Error('RELEASE_SCOPE_ROOT_CHANGED');
      for (let j = 0; j < i; j++)
        if (
          hash(root.identity) === hash(inspectPaths[j].identity) ||
          contains(root.path, inspectPaths[j].path) ||
          contains(inspectPaths[j].path, root.path)
        )
          throw new Error('RELEASE_SCOPE_OVERLAPPING_ROOTS');
    }
  };
  checkRoots(policy.roots);
  const target = request.root ? canonical(request.root) : undefined;
  if (target && !policy.roots.some((root) => contains(root.path, target)))
    throw new Error('RELEASE_SCOPE_UNREGISTERED_ROOT');
  if (policy.roots.some((root) => contains(root.path, file)))
    throw new Error('RELEASE_SCOPE_REGISTRY_MUST_BE_OUTSIDE_OUTPUTS');
  if (
    typeof policy.registryDirectory !== 'string' ||
    canonical(policy.registryDirectory) !== policy.registryDirectory ||
    hash(identity(policy.registryDirectory)) !==
      hash(policy.registryIdentity) ||
    policy.roots.some((root) => contains(root.path, policy.registryDirectory))
  )
    throw new Error('RELEASE_SCOPE_REGISTRY_IDENTITY_INVALID');
  const directory = policy.registryDirectory,
    lock = path.join(directory, policy.scopeId + '.lock'),
    ledger = path.join(directory, policy.scopeId + '.state.json');
  const token = JSON.stringify({
    pid: process.pid,
    nonce: crypto.randomUUID(),
    configSha,
  });
  fs.writeFileSync(lock, token, { flag: 'wx', mode: 0o600 });
  let prior,
    closed = false,
    refs,
    initialFacts,
    claim,
    ledgerIdentity;
  const configIdentity = fileIdentity(file);
  const save = () => {
    atomic(ledger, prior);
    ledgerIdentity = fileIdentity(ledger);
  };
  const owner = () => {
    if (fs.readFileSync(lock, 'utf8') !== token)
      throw new Error('RELEASE_SCOPE_OWNER_CHANGED');
    if (fileHash(file) !== configSha)
      throw new Error('RELEASE_SCOPE_POLICY_CHANGED');
    if (
      hash(fileIdentity(file)) !== hash(configIdentity) ||
      (ledgerIdentity &&
        (!present(ledger) ||
          hash(fileIdentity(ledger)) !== hash(ledgerIdentity)))
    )
      throw new Error('RELEASE_SCOPE_STATE_REPLACED');
  };
  const query = () => {
    if (options.query) return options.query();
    if (!policy.probe || fileHash(policy.probe.path) !== policy.probe.sha256)
      throw new Error('RELEASE_SCOPE_REFERENCE_PROBE_UNAVAILABLE');
    return JSON.parse(
      execFileSync(process.execPath, [policy.probe.path, file], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      }),
    );
  };
  const references = (allowTransition = false) => {
    const value = query(),
      digest = validateReferences(value, policy);
    const stable = (v) =>
      v.records
        .filter((r) => !['processes', 'pointers'].includes(r.kind))
        .map((r) =>
          r.viaPointer
            ? { ...r, packageId: undefined, packagePath: undefined }
            : r,
        )
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (
      refs &&
      digest !== refs &&
      (!allowTransition || hash(stable(value)) !== hash(stable(initialFacts)))
    )
      throw new Error('RELEASE_SCOPE_REFERENCES_CHANGED');
    return { value, digest };
  };
  const check = (allowTransition = false) => {
    owner();
    checkRoots(policy.roots);
    if (present(ledger) && hash(state(ledger)) !== hash(prior))
      throw new Error('RELEASE_SCOPE_STATE_REPLACED');
    const measure = scan(
      policy.roots,
      prior.outputs.map((row) => row.path),
    );
    if (measure.digest !== policy.baseline.digest)
      throw new Error('RELEASE_SCOPE_FROZEN_HISTORY_CHANGED');
    if (
      measure.bytes > policy.maxBytes ||
      measure.bytes - policy.baseline.bytes > policy.maxGrowthBytes
    )
      throw new Error('RELEASE_SCOPE_TOTAL_BYTES_EXCEEDED');
    if (
      measure.runtimeCopies - policy.baseline.runtimeCopies >
      policy.maxNewRuntimeCopies
    )
      throw new Error('RELEASE_SCOPE_RUNTIME_COPIES_EXCEEDED');
    if (claim && measure.bytes - claim.startBytes > claim.reserveBytes)
      throw new Error('RELEASE_SCOPE_RESERVATION_EXCEEDED');
    if (
      claim &&
      measure.runtimeCopies - claim.startRuntimeCopies > claim.runtimeCopies
    )
      throw new Error('RELEASE_SCOPE_RUNTIME_RESERVATION_EXCEEDED');
    for (const row of prior.outputs)
      if (row.complete) {
        if (
          !present(row.path) ||
          hash(identity(row.path)) !== hash(row.identity) ||
          scan([{ path: row.path, identity: row.identity }]).digest !==
            row.digest
        )
          throw new Error('RELEASE_SCOPE_MANAGED_OUTPUT_CHANGED');
      }
    for (const row of prior.outputs)
      if (
        !row.complete &&
        row.identity &&
        present(row.path) &&
        hash(identity(row.path)) !== hash(row.identity)
      )
        throw new Error('RELEASE_SCOPE_OWNED_OUTPUT_REPLACED');
    for (const root of policy.roots) {
      const disk = fs.statfsSync(root.path, { bigint: true });
      if (disk.bavail * disk.bsize < BigInt(MIN_FREE))
        throw new Error('RELEASE_SCOPE_PHYSICAL_RESERVE_EXCEEDED');
    }
    references(allowTransition);
    return measure;
  };
  try {
    if (present(ledger)) {
      ledgerIdentity = fileIdentity(ledger);
      prior = state(ledger);
      if (
        prior.format !== 1 ||
        prior.configSha !== configSha ||
        !Array.isArray(prior.outputs) ||
        prior.outputs.length > 128 ||
        new Set(prior.outputs.map((row) => row.path)).size !==
          prior.outputs.length ||
        prior.outputs.some(
          (row) =>
            typeof row.path !== 'string' ||
            !path.isAbsolute(row.path) ||
            !policy.roots.some((root) => contains(root.path, row.path)) ||
            (!prior.claim &&
              (row.complete !== true ||
                !Array.isArray(row.identity) ||
                row.identity.length !== 3 ||
                !/^[a-f0-9]{64}$/.test(row.digest || ''))),
        )
      )
        throw new Error('RELEASE_SCOPE_STATE_INVALID');
      if (prior.claim)
        throw new Error('RELEASE_SCOPE_INTERRUPTED_CLAIM_REQUIRES_REVIEW');
    } else {
      // The sentinel lives beside the reviewed policy, outside all accounting roots.
      // A missing ledger after adoption is never a new clean baseline.
      const sentinel = ledger + '.adopted';
      if (present(sentinel))
        throw new Error('RELEASE_SCOPE_LEDGER_MISSING_REQUIRES_REVIEW');
      prior = { format: 1, configSha, outputs: [], claim: null };
      const initial = scan(policy.roots);
      if (initial.digest !== policy.baseline.digest)
        throw new Error('RELEASE_SCOPE_BASELINE_MISMATCH');
      save();
      fs.writeFileSync(sentinel, configSha, { flag: 'wx', mode: 0o600 });
    }
    const facts = references();
    refs = facts.digest;
    initialFacts = structuredClone(facts.value);
    const measure = check();
    if (
      measure.bytes + request.reserveBytes > policy.maxBytes ||
      measure.bytes + request.reserveBytes - policy.baseline.bytes >
        policy.maxGrowthBytes
    )
      throw new Error('RELEASE_SCOPE_COPY_PEAK_EXCEEDED');
    if (
      measure.runtimeCopies +
        request.runtimeCopies -
        policy.baseline.runtimeCopies >
      policy.maxNewRuntimeCopies
    )
      throw new Error('RELEASE_SCOPE_RUNTIME_COPY_PEAK_EXCEEDED');
    for (const root of policy.roots) {
      const disk = fs.statfsSync(root.path, { bigint: true });
      if (
        disk.bavail * disk.bsize - BigInt(request.reserveBytes) <
        BigInt(MIN_FREE)
      )
        throw new Error('RELEASE_SCOPE_PHYSICAL_RESERVE_EXCEEDED');
    }
    claim = {
      id: crypto.randomUUID(),
      kind: request.kind,
      root: target,
      reserveBytes: request.reserveBytes,
      runtimeCopies: request.runtimeCopies,
      startBytes: measure.bytes,
      startRuntimeCopies: measure.runtimeCopies,
      refs,
      outputs: [],
    };
    prior.claim = claim;
    save();
    return {
      policy,
      check,
      authorizePackage(folder) {
        const m = read(
          path.join(canonical(folder), 'release.json'),
          8 * 1024 ** 2,
        );
        if (
          !policy.protectedIds.includes(m.id) ||
          policy.packageProofs?.[m.id] !==
            fileHash(path.join(folder, 'release.json'))
        )
          throw new Error('RELEASE_SCOPE_PACKAGE_NOT_IN_FROZEN_PLAN');
        checkRoots(policy.roots);
        if (
          !policy.roots.some((root) => contains(root.path, canonical(folder)))
        )
          throw new Error('RELEASE_SCOPE_UNREGISTERED_ROOT');
      },
      registerOutput(output) {
        check();
        const at = path.resolve(output),
          parent = canonical(path.dirname(at));
        if (
          path.dirname(at) !== parent ||
          !policy.roots.some((root) => contains(root.path, at)) ||
          present(at) ||
          prior.outputs.some(
            (row) => contains(row.path, at) || contains(at, row.path),
          )
        )
          throw new Error('RELEASE_SCOPE_OUTPUT_INVALID');
        const row = { path: at, complete: false, claim: claim.id };
        prior.outputs.push(row);
        claim.outputs.push(at);
        save();
      },
      createdOutput(output) {
        owner();
        const at = canonical(output),
          row = prior.outputs.find(
            (r) => r.path === at && r.claim === claim.id && !r.complete,
          );
        if (!row || row.identity)
          throw new Error('RELEASE_SCOPE_OUTPUT_CLAIM_INVALID');
        row.identity = identity(at);
        save();
      },
      allowCleanup(outputs) {
        check();
        const facts = references().value;
        if (
          outputs.some((at) =>
            facts.records.some(
              (r) =>
                contains(path.resolve(at), canonical(r.packagePath)) ||
                contains(canonical(r.packagePath), path.resolve(at)),
            ),
          )
        )
          throw new Error('RELEASE_SCOPE_REFERENCED_OUTPUT_PRESERVE');
      },
      close(error, { transition = false } = {}) {
        if (closed) return;
        closed = true;
        try {
          owner();
          check(transition);
          for (const row of prior.outputs.filter((r) => r.claim === claim.id)) {
            if (!present(row.path)) continue;
            if (error)
              throw new Error(
                'RELEASE_SCOPE_FAILED_OUTPUT_HELD_REQUIRES_REVIEW',
              );
            row.identity = identity(row.path);
            row.digest = scan([
              { path: row.path, identity: row.identity },
            ]).digest;
            row.complete = true;
          }
          prior.outputs = prior.outputs.filter((row) => present(row.path));
          prior.claim = null;
          save();
        } finally {
          owner();
          fs.unlinkSync(lock);
        }
      },
    };
  } catch (error) {
    owner();
    fs.unlinkSync(lock);
    throw error;
  }
}
function session() {
  return context.getStore();
}
function requireSession() {
  const value = session();
  if (!value) throw new Error('RELEASE_SCOPE_SESSION_REQUIRED');
  return value;
}
function within(request, run, options) {
  if (session()) {
    session().check();
    return run(session());
  }
  const lease = open(request, options);
  let result;
  try {
    result = context.run(lease, () => run(lease));
  } catch (error) {
    lease.close(error);
    throw error;
  }
  if (result && typeof result.then === 'function')
    return result.then(
      (value) => {
        lease.close(undefined, { transition: request.transition === true });
        return value;
      },
      (error) => {
        lease.close(error, { transition: request.transition === true });
        throw error;
      },
    );
  lease.close();
  return result;
}
module.exports = {
  inspect,
  open,
  within,
  session,
  requireSession,
  DEFAULT_BYTES,
  MIN_FREE,
};
