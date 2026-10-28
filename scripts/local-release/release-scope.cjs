// One reviewed registry and lock for every cooperating release writer.
// No history deletion, process termination, service control or DB restoration.
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { fileHash } = require('./lib.cjs');
const DEFAULT_BYTES = 768 * 1024 ** 2,
  MIN_FREE = 4 * 1024 ** 3;
const context = require('./lib.cjs').hostEffects.context;
const WRITE_KINDS = ['build', 'install', 'activate', 'restart', 'switch'];
const BOUND_OPERATION = Symbol('bound-operation');
const hash = (v) =>
  crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const {
  createVerifier,
  FORMAT: INVENTORY_FORMAT,
  PRIVATE_FORMAT,
  PRIVATE_RULES,
} = require('./scope-inventory.cjs');
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
function inspect(paths, options = {}) {
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
  const verifier = createVerifier(options.scanBudget, {
    onSegment: options.onSegment,
    privateAccounting: options.privateAccounting,
  });
  const baseline = verifier.scan(roots);
  options.onMetrics?.(verifier.metrics());
  return { roots, baseline };
}
function validateReferences(value, policy) {
  const preserving = policy.preservingUpdate?.format === 1;
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
    (preserving ? value.complete !== false || value.observationComplete !== true : value.complete !== true) ||
    kinds.some((k) => value.categories?.[k] !== (preserving && k === 'shortcuts' ? 'not_applicable' : true)) ||
    !Array.isArray(value.records) ||
    value.records.length > 4096 ||
    (preserving && value.records.some((r) => r.kind === 'shortcuts')) ||
    !Array.isArray(value.errors) ||
    value.errors.length ||
    !Array.isArray(value.uncertainChildren) ||
    value.uncertainChildren.length
  )
    throw new Error('RELEASE_SCOPE_REFERENCE_QUERY_INCOMPLETE');
  if (policy.phase === 'build-only') {
    if (
      value.compatibility?.stage !== 'build-only' ||
      value.compatibility.verified !== false
    )
      throw new Error('RELEASE_SCOPE_BUILD_STAGE_REQUIRED');
  } else if (
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
function open(request, options = {}, boundOperation) {
  if (session()) throw new Error('RELEASE_SCOPE_NESTED_OPEN_FORBIDDEN');
  request = { runtimeCopies: 0, ...request };
  if (
    boundOperation !== BOUND_OPERATION &&
    (!WRITE_KINDS.includes(request.kind) || request.reserveBytes < 1)
  )
    throw new Error('RELEASE_SCOPE_OBSERVATION_REQUIRES_WITHIN');
  const configPath = options.configPath || process.env.WEWE_RELEASE_SCOPE_FILE,
    expected = options.configSha256 || process.env.WEWE_RELEASE_SCOPE_SHA256;
  if (!configPath || !/^[a-f0-9]{64}$/.test(expected || ''))
    throw new Error('RELEASE_SCOPE_REVIEWED_POLICY_REQUIRED');
  const file = canonical(configPath),
    policy = read(file),
    configSha = fileHash(file);
  const preserving = policy.preservingUpdate === undefined ? null : require('./preserving-contract.cjs').validatePreservingContract(policy, request);
  if (
    configSha !== expected ||
    ![1, 2].includes(policy.format) ||
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
  if (policy.phase !== undefined && policy.phase !== 'build-only')
    throw new Error('RELEASE_SCOPE_PHASE_INVALID');
  if (policy.phase === 'build-only') {
    const spec = policy.buildOnly;
    if (
      request.kind !== 'build' ||
      request.buildOnly !== true ||
      request.transition ||
      !spec ||
      !/^[a-f0-9]{40}$/.test(spec.sourceCommit || '') ||
      !/^[a-f0-9]{64}$/.test(spec.sourceHash || '') ||
      !/^[a-f0-9]{64}$/.test(spec.runtimeSha256 || '') ||
      spec.runtimeSha256 !== fileHash(process.execPath) ||
      !Array.isArray(spec.commands) ||
      spec.commands.length > 3 ||
      spec.commands.some(
        (c) =>
          !path.isAbsolute(c.path) || !/^[a-f0-9]{64}$/.test(c.sha256 || ''),
      ) ||
      request.sourceCommit !== spec.sourceCommit ||
      request.sourceHash !== spec.sourceHash ||
      request.root !== spec.outputRoot ||
      canonical(spec.outputRoot) !== spec.outputRoot ||
      !policy.roots.some((r) => r.path === spec.outputRoot) ||
      spec.outputRoot === path.resolve(__dirname, '../../.local-releases')
    )
      throw new Error('RELEASE_SCOPE_BUILD_ONLY_BINDING_REQUIRED');
  } else if (
    request.buildOnly ||
    !/^[a-f0-9]{64}$/.test(policy.compatibilityProofSha256 || '')
  )
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
  const privateMode = policy.format === 2;
  if (
    (privateMode ?
      policy.inventoryClassification !== PRIVATE_RULES ||
      policy.baseline.format !== PRIVATE_FORMAT ||
      policy.baseline.classification !== PRIVATE_RULES ||
      policy.baseline.privateContentVerified !== false ||
      !Number.isSafeInteger(policy.baseline.privateBytes) ||
      !Number.isSafeInteger(policy.baseline.privateEntries) :
      policy.inventoryClassification !== undefined || policy.baseline.format !== INVENTORY_FORMAT) ||
    !/^[a-f0-9]{64}$/.test(policy.baseline.metadataDigest || '')
  )
    throw new Error('RELEASE_SCOPE_INVENTORY_VERSION_REVIEW_REQUIRED');
  const verifier = createVerifier(policy.scanBudget, {
    onSegment: options.onScanSegment,
    privateAccounting: privateMode ? PRIVATE_RULES : undefined,
  });
  const useMetadata = verifier.limits.checkpointMode === 'identity-times-v1';
  let fullValidated = false;
  const verifiedOutputs = new Set();
  let pointerCommit;
  const descriptors = new Set();
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
  let expectedProcesses;
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
    const value = query();
    verifier.assertBudget();
    const digest = validateReferences(value, policy);
    if (preserving && !expectedProcesses)
      expectedProcesses = structuredClone(value.records.filter((r) => r.kind === 'processes'));
    if (preserving && refs) {
      const clean = (rows) => rows.map(({ ownedTransition, ...r }) => r).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
      if (hash(clean(value.records.filter((r) => r.kind === 'processes'))) !== hash(clean(expectedProcesses)))
        throw new Error('RELEASE_SCOPE_REFERENCES_CHANGED');
    }
    if (preserving && preserving.operation !== 'build' && !refs) {
      const a = preserving.active;
      if (canonical(a.pointer) !== a.pointer || !policy.roots.some((r) => contains(r.path, a.pointer)) ||
          fileHash(a.pointer) !== a.pointerSha256 || read(a.pointer).id !== a.currentId ||
          policy.packageProofs?.[a.currentId] !== a.currentManifestSha256 ||
          policy.packageProofs?.[a.candidateId] !== a.candidateManifestSha256 ||
          !value.records.some((r) => r.kind === 'pointers' && r.pointerPath === a.pointer && r.packageId === a.currentId) ||
          !value.records.some((r) => r.kind === 'processes' && r.packageId === a.currentId && r.pid === a.oldProcess.pid &&
            r.startUtc === a.oldProcess.startUtc && r.executableSha256 === a.oldProcess.executableSha256))
        throw new Error('RELEASE_PRESERVING_ACTIVE_BINDING_CHANGED');
    }
    if (
      policy.phase === 'build-only' &&
      value.records.some((r) =>
        contains(policy.buildOnly.outputRoot, canonical(r.packagePath)),
      )
    )
      throw new Error('RELEASE_SCOPE_BUILD_ROOT_REFERENCED');
    const stable = (v) =>
      v.records
        .filter((r) => r.kind !== 'pointers' && (preserving || r.kind !== 'processes'))
        .map(({ ownedTransition, ...r }) => r)
        .map((r) =>
          r.viaPointer
            ? { ...r, packageId: undefined, packagePath: undefined }
            : r,
        )
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (
      refs &&
      digest !== refs &&
      (!allowTransition || hash(stable(value)) !== hash(stable(preserving ? {
        ...initialFacts, records: [...initialFacts.records.filter((r) => r.kind !== 'processes'), ...expectedProcesses],
      } : initialFacts)))
    )
      throw new Error('RELEASE_SCOPE_REFERENCES_CHANGED');
    return { value, digest };
  };
  const check = (allowTransition = false) => {
    owner();
    checkRoots(policy.roots);
    if (present(ledger) && hash(state(ledger)) !== hash(prior))
      throw new Error('RELEASE_SCOPE_STATE_REPLACED');
    const measure = verifier.scan(
      policy.roots,
      prior.outputs.map((row) => row.path),
      { metadataOnly: useMetadata && fullValidated },
    );
    if (
      measure.metadataDigest !== policy.baseline.metadataDigest ||
      ((!useMetadata || !fullValidated) &&
        measure.digest !== policy.baseline.digest)
    )
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
          hash(identity(row.path)) !== hash(row.identity)
        )
          throw new Error('RELEASE_SCOPE_MANAGED_OUTPUT_CHANGED');
        const snapshot = verifier.scan(
          [{ path: row.path, identity: row.identity }],
          [],
          { metadataOnly: useMetadata && verifiedOutputs.has(row.path) },
        );
        if (privateMode && snapshot.privateEntries !== 0)
          throw new Error('RELEASE_SCOPE_PRIVATE_MANAGED_OUTPUT');
        if (
          snapshot.metadataDigest !== row.metadataDigest ||
          ((!useMetadata || !verifiedOutputs.has(row.path)) &&
            snapshot.digest !== row.digest)
        )
          throw new Error('RELEASE_SCOPE_MANAGED_OUTPUT_CHANGED');
        verifiedOutputs.add(row.path);
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
    fullValidated = true;
    return measure;
  };
  try {
    if (privateMode) {
      const packages = policy.windowsReferences?.packages;
      if (!Array.isArray(packages) || packages.length < 1 || packages.length > 6)
        throw new Error('RELEASE_SCOPE_ARTIFACT_BINDING_INVALID');
      const checked = new Set(), covered = new Set();
      let proofBytes = 0;
      for (const row of packages) {
        if (!row || !policy.protectedIds.includes(row.id) || typeof row.path !== 'string' ||
            !path.isAbsolute(row.path) || path.resolve(row.path) !== row.path ||
            canonical(row.path) !== row.path ||
            !policy.roots.some((root) => contains(root.path, row.path)) ||
            checked.has(row.path.toLowerCase()))
          throw new Error('RELEASE_SCOPE_ARTIFACT_BINDING_INVALID');
        const actualId = require('./private-artifact-proof.cjs').verifyManifest(
          row.path, policy.packageProofs?.[row.id], (n) => {
            proofBytes += n;
            if (proofBytes > verifier.limits.scanReadBytes)
              throw new Error('RELEASE_SCOPE_SCAN_READ_BUDGET');
            verifier.chargeExternal(n);
          });
        if (actualId !== row.id) throw new Error('RELEASE_SCOPE_ARTIFACT_BINDING_INVALID');
        checked.add(row.path.toLowerCase());
        covered.add(row.id);
      }
      if (policy.protectedIds.some((id) => !covered.has(id)))
        throw new Error('RELEASE_SCOPE_ARTIFACT_BINDING_INVALID');
    }
    if (present(ledger)) {
      ledgerIdentity = fileIdentity(ledger);
      prior = state(ledger);
      if (
        prior.format !== policy.format ||
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
                !/^[a-f0-9]{64}$/.test(row.digest || '') ||
                !/^[a-f0-9]{64}$/.test(row.metadataDigest || ''))),
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
      if (
        policy.phase === 'build-only' &&
        fs.readdirSync(policy.buildOnly.outputRoot).length
      )
        throw new Error('RELEASE_SCOPE_BUILD_ROOT_NOT_EMPTY');
      prior = { format: policy.format, configSha, outputs: [], claim: null };
      const initial = verifier.scan(policy.roots);
      if (
        initial.digest !== policy.baseline.digest ||
        initial.metadataDigest !== policy.baseline.metadataDigest
      )
        throw new Error('RELEASE_SCOPE_BASELINE_MISMATCH');
      fullValidated = true;
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
    const assertWritable = (kinds = WRITE_KINDS, reserveBytes = 1) => {
      owner();
      if (
        !WRITE_KINDS.includes(claim.kind) ||
        !kinds.includes(claim.kind) ||
        claim.reserveBytes < reserveBytes
      )
        throw new Error('RELEASE_SCOPE_WRITE_OPERATION_NOT_AUTHORIZED');
    };
    return {
      policy,
      check,
      assertWritable,
      confirmPreservingProcessExit(pid, receipt) {
        if (!preserving || preserving.operation !== 'restart') return;
        owner();
        if (receipt?.pid !== pid || receipt.stopped !== true)
          throw new Error('RELEASE_PRESERVING_PROCESS_EXIT_UNCONFIRMED');
        const known = expectedProcesses.filter((r) => r.pid === pid);
        if (!known.length || (pid !== preserving.active.oldProcess.pid && !known.every((r) => r.ownedTransition === true)))
          throw new Error('RELEASE_PRESERVING_PROCESS_UNAPPROVED');
        const facts = query(); validateReferences(facts, policy); verifier.assertBudget();
        const next = expectedProcesses.filter((r) => r.pid !== pid);
        const actual = facts.records.filter((r) => r.kind === 'processes');
        const clean = (rows) => rows.map(({ ownedTransition, ...r }) => r).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
        if (hash(clean(actual)) !== hash(clean(next))) throw new Error('RELEASE_SCOPE_REFERENCES_CHANGED');
        expectedProcesses = next;
      },
      bindPreservingChild(snapshot, packageId, expectedCommand) {
        if (!preserving || preserving.operation !== 'restart') return;
        owner();
        const a = preserving.active;
        const pkg = policy.windowsReferences?.packages?.find((p) => p.id === packageId &&
          canonical(path.join(p.path, 'runtime/node.exe')) === canonical(snapshot.executable));
        if (!pkg || ![a.currentId, a.candidateId].includes(packageId) || !Number.isInteger(snapshot.pid) || snapshot.pid < 1 ||
            snapshot.pid === a.oldProcess.pid || expectedProcesses.some((r) => r.pid === snapshot.pid) || snapshot.commandLine !== expectedCommand)
          throw new Error('RELEASE_PRESERVING_PROCESS_UNAPPROVED');
        const facts = query(); validateReferences(facts, policy); verifier.assertBudget();
        const actual = facts.records.filter((r) => r.kind === 'processes');
        const added = actual.filter((r) => r.pid === snapshot.pid);
        const clean = (rows) => rows.map(({ ownedTransition, ...r }) => r).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
        if (added.length !== 1 || added[0].packageId !== packageId || added[0].startUtc !== snapshot.startUtc ||
            added[0].executableSha256 !== fileHash(snapshot.executable) ||
            hash(clean(actual.filter((r) => r.pid !== snapshot.pid))) !== hash(clean(expectedProcesses)))
          throw new Error('RELEASE_SCOPE_REFERENCES_CHANGED');
        expectedProcesses.push({ ...added[0], ownedTransition: true });
      },
      authorizePointerCommit(temporary, destination, id, recovery) {
        if (!preserving) return;
        owner();
        const a = preserving.active;
        if (preserving.operation !== 'restart' || destination !== a.pointer || path.dirname(temporary) !== path.dirname(destination) ||
            !/^active-[a-f0-9-]+\.tmp$/.test(path.basename(temporary)) || read(temporary).format !== 1 || read(temporary).id !== id ||
            id !== (recovery ? a.currentId : a.candidateId))
          throw new Error('RELEASE_PRESERVING_POINTER_COMMIT_FORBIDDEN');
        const nextHash = crypto.createHash('sha256').update(JSON.stringify({ format: 1, id: a.candidateId }) + '\n').digest('hex');
        if (!(recovery ? [a.pointerSha256, nextHash] : [a.pointerSha256]).includes(fileHash(destination)))
          throw new Error('RELEASE_PRESERVING_ACTIVE_BINDING_CHANGED');
        pointerCommit = { temporary, destination };
      },
      approveDescriptor(fd, file, writing) {
        if (writing) descriptors.add(fd);
      },
      assertFileAccess(method, args, writing) {
        if (preserving && preserving.operation !== 'build' && writing && !['close', 'fsync', 'fdatasync'].includes(method)) {
          const values = ['copyFile', 'cp', 'symlink', 'link'].includes(method) ? [args[1]] : method === 'rename' ? args.slice(0, 2) : [args[0]];
          for (const value of values) {
            if (typeof value === 'number' && descriptors.has(value)) continue;
            if (typeof value !== 'string') throw new Error('RELEASE_PRESERVING_DESCRIPTOR_FORBIDDEN');
            const at = path.resolve(value), root = claim.root;
            if (at === preserving.active.pointer) {
              if (method !== 'rename' || !pointerCommit || args[0] !== pointerCommit.temporary || args[1] !== pointerCommit.destination)
                throw new Error('RELEASE_PRESERVING_POINTER_COMMIT_FORBIDDEN');
            }
            const admin = at === path.join(root, '.build-budget.lock') || at === path.join(path.dirname(root), '.active-release.lock') ||
              at === path.join(root, '.release-lifecycle.json') || (path.dirname(at) === root && /^\.release-lifecycle\.json\.[a-f0-9-]+\.tmp$/.test(path.basename(at))) ||
              (preserving.operation === 'restart' && (at === preserving.active.pointer || (path.dirname(at) === path.dirname(preserving.active.pointer) && /^active-[a-f0-9-]+\.tmp$/.test(path.basename(at)))));
            if (admin) {
              if (['rm', 'rmdir', 'unlink'].includes(method) && !at.endsWith('.lock') && !at.endsWith('.tmp'))
                throw new Error('RELEASE_PRESERVING_CONTROL_DELETE_FORBIDDEN');
              if (present(at) && fs.lstatSync(at).isSymbolicLink()) throw new Error('RELEASE_PRESERVING_WRITE_LINK_ESCAPE');
              if (canonical(path.dirname(at)) !== path.dirname(at)) throw new Error('RELEASE_PRESERVING_WRITE_LINK_ESCAPE');
              continue;
            }
            const output = prior.outputs.find((r) => r.claim === claim.id && !r.complete && contains(r.path, at));
            if (!output || ['rm', 'rmdir', 'unlink'].includes(method)) throw new Error('RELEASE_PRESERVING_WRITE_OUTSIDE_OUTPUT');
            if (present(at) && (fs.lstatSync(at).isSymbolicLink() || !contains(output.path, canonical(at))))
              throw new Error('RELEASE_PRESERVING_WRITE_LINK_ESCAPE');
            let ancestor = path.dirname(at);
            while (!present(ancestor)) ancestor = path.dirname(ancestor);
            if (!policy.roots.some((r) => contains(r.path, canonical(ancestor)))) throw new Error('RELEASE_PRESERVING_WRITE_LINK_ESCAPE');
          }
          if (method === 'rename' && pointerCommit && args[1] === pointerCommit.destination) pointerCommit = undefined;
        }
        if (policy.phase !== 'build-only') return;
        if (method === 'close') descriptors.delete(args[0]);
        const paths = ['copyFile', 'cp', 'symlink', 'link', 'rename'].includes(
          method,
        )
          ? args.slice(0, 2)
          : [args[0]];
        for (const at of paths.filter((v) => typeof v === 'string'))
          if (
            /\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm|journal))?$/i.test(at) ||
            /(?:^|[\\/])(?:\.env(?:\..*)?|active\.json)$/i.test(at)
          )
            throw new Error('RELEASE_SCOPE_BUILD_ONLY_PRIVATE_INPUT_FORBIDDEN');
        if (!writing || ['close', 'fsync', 'fdatasync'].includes(method))
          return;
        const destinations = ['copyFile', 'cp', 'symlink', 'link'].includes(
          method,
        )
          ? [args[1]]
          : method === 'rename'
            ? args.slice(0, 2)
            : [args[0]];
        for (const value of destinations) {
          if (typeof value !== 'string') {
            if (typeof value === 'number' && descriptors.has(value)) continue;
            throw new Error('RELEASE_SCOPE_BUILD_ONLY_DESCRIPTOR_FORBIDDEN');
          }
          const at = path.resolve(value),
            buildRoot = policy.buildOnly.outputRoot;
          if (at === path.join(buildRoot, '.build-budget.lock')) continue;
          if (method === 'mkdir' && at === buildRoot && present(at)) continue;
          const output = prior.outputs.find(
            (row) =>
              row.claim === claim.id && !row.complete && contains(row.path, at),
          );
          if (!output)
            throw new Error('RELEASE_SCOPE_BUILD_ONLY_WRITE_OUTSIDE_OUTPUT');
          if (
            present(at) &&
            (fs.lstatSync(at).isSymbolicLink() ||
              !contains(output.path, canonical(at)))
          )
            throw new Error('RELEASE_SCOPE_BUILD_ONLY_WRITE_LINK_ESCAPE');
          let ancestor = path.dirname(at);
          while (!present(ancestor)) ancestor = path.dirname(ancestor);
          if (!contains(buildRoot, canonical(ancestor)))
            throw new Error('RELEASE_SCOPE_BUILD_ONLY_WRITE_LINK_ESCAPE');
        }
      },
      assertBuildCommand(method, args) {
        if (policy.phase !== 'build-only') return;
        const [executable, argv, commandOptions] = args;
        const pinned =
          Array.isArray(argv) &&
          policy.buildOnly.commands.find((c) => c.path === argv[0]);
        if (
          !['execFileSync', 'execFile', 'spawn', 'spawnSync'].includes(
            method,
          ) ||
          commandOptions?.shell ||
          executable !== process.execPath ||
          !Array.isArray(argv) ||
          !argv.length ||
          !pinned ||
          fileHash(pinned.path) !== pinned.sha256 ||
          !/(?:[\\/]typescript[\\/]bin[\\/]tsc|[\\/]prisma[\\/]build[\\/]index\.js|[\\/]vite[\\/]bin[\\/]vite\.js)$/.test(
            argv[0],
          ) ||
          argv.some((v) =>
            /^(?:--database|--production|--rehearsal|--eval|-e|--require|-r)$/.test(
              v,
            ),
          )
        )
          throw new Error('RELEASE_SCOPE_BUILD_ONLY_COMMAND_FORBIDDEN');
      },
      assertOperation(nested, nestedOptions = {}) {
        owner();
        const at = nested.root ? canonical(nested.root) : undefined;
        if (
          nested.kind !== claim.kind ||
          at !== claim.root ||
          !Number.isSafeInteger(nested.reserveBytes) ||
          nested.reserveBytes < 0 ||
          nested.reserveBytes > claim.reserveBytes ||
          !Number.isInteger(nested.runtimeCopies ?? 0) ||
          (nested.runtimeCopies ?? 0) < 0 ||
          (nested.runtimeCopies ?? 0) > claim.runtimeCopies ||
          (nested.transition === true && request.transition !== true) ||
          (nestedOptions.configPath &&
            canonical(nestedOptions.configPath) !== file) ||
          (nestedOptions.configSha256 &&
            nestedOptions.configSha256 !== configSha)
        )
          throw new Error('RELEASE_SCOPE_NESTED_OPERATION_EXCEEDS_CLAIM');
      },
      inventoryMetrics: () => verifier.metrics(),
      assertOwnedDirectory(folder) {
        assertWritable();
        const at = canonical(folder),
          row = prior.outputs.find(
            (r) =>
              r.claim === claim.id &&
              !r.complete &&
              r.identity &&
              contains(r.path, at),
          );
        if (!row || hash(identity(row.path)) !== hash(row.identity))
          throw new Error('RELEASE_SCOPE_OWNED_AUDIT_REQUIRED');
        return at;
      },
      authorizePackage(folder) {
        owner();
        if (policy.phase === 'build-only')
          throw new Error('RELEASE_SCOPE_BUILD_ONLY_NO_INSTALL');
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
      authorizePublication(folder) {
        assertWritable(['activate', 'restart', 'switch'], 4096);
        if (path.dirname(canonical(folder)) !== claim.root)
          throw new Error('RELEASE_SCOPE_PUBLICATION_ROOT_NOT_AUTHORIZED');
        this.authorizePackage(folder);
      },
      authorizeRecoveryPackage(folder) {
        if (!['restart', 'switch'].includes(claim.kind))
          throw new Error('RELEASE_SCOPE_RECOVERY_OPERATION_REQUIRED');
        this.authorizePublication(folder);
        const spec = policy.windowsReferences?.compatibilityProof;
        if (!spec || spec.sha256 !== policy.compatibilityProofSha256)
          throw new Error('RELEASE_SCOPE_RECOVERY_PROOF_REQUIRED');
        const fd = fs.openSync(canonical(spec.path), 'r'),
          buffer = Buffer.alloc(1024 * 1024 + 1);
        let count = 0;
        try {
          while (count < buffer.length) {
            const n = fs.readSync(
              fd,
              buffer,
              count,
              buffer.length - count,
              null,
            );
            if (!n) break;
            count += n;
          }
        } finally {
          fs.closeSync(fd);
        }
        const raw = buffer.subarray(0, count);
        if (
          count > 1024 * 1024 ||
          crypto.createHash('sha256').update(raw).digest('hex') !== spec.sha256
        )
          throw new Error('RELEASE_SCOPE_RECOVERY_PROOF_CHANGED');
        const proof = JSON.parse(raw.toString('utf8')),
          m = read(path.join(folder, 'release.json'), 8 * 1024 ** 2);
        if (
          proof.format !== 1 ||
          proof.kind !== 'additive-schema-unknown-claim-rollback' ||
          proof.businessDatabaseRestored !== false ||
          [
            'additiveSchema',
            'unknownClaimsPreserved',
            'businessRowsPreserved',
            'rollbackStarted',
          ].some((k) => proof.checks?.[k] !== true) ||
          proof.rollback?.id !== m.id ||
          proof.rollback?.sourceCommit !== m.sourceCommit ||
          proof.rollback?.manifestSha256 !==
            fileHash(path.join(folder, 'release.json'))
        )
          throw new Error('RELEASE_SCOPE_RECOVERY_TARGET_UNPROVEN');
        // This authorizes only the already installed compatible app. It grants
        // no new output, copy budget, registry reset or database restoration.
        return proof.rollback;
      },
      registerOutput(output) {
        assertWritable();
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
        assertWritable();
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
        assertWritable();
        if (preserving) throw new Error('RELEASE_PRESERVING_CLEANUP_FORBIDDEN');
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
            const receipt = verifier.scan([
              { path: row.path, identity: row.identity },
            ]);
            if (privateMode && receipt.privateEntries !== 0)
              throw new Error('RELEASE_SCOPE_PRIVATE_MANAGED_OUTPUT');
            row.digest = receipt.digest;
            row.metadataDigest = receipt.metadataDigest;
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
function assertWritableSession(kinds, reserveBytes) {
  session()?.assertWritable(kinds, reserveBytes);
}
function within(request, run, options) {
  if (session()) {
    session().assertOperation(request, options);
    session().check();
    return run(session());
  }
  const lease = open(request, options, BOUND_OPERATION);
  let result;
  try {
    result = context.run(lease, () => run(lease));
  } catch (error) {
    lease.close(error, { transition: request.transition === true });
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
  lease.close(undefined, { transition: request.transition === true });
  return result;
}
module.exports = {
  inspect,
  open,
  within,
  session,
  requireSession,
  assertWritableSession,
  DEFAULT_BYTES,
  MIN_FREE,
};
