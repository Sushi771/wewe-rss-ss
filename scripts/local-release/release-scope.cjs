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
  });
  const baseline = verifier.scan(roots);
  options.onMetrics?.(verifier.metrics());
  return { roots, baseline };
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
// One bounded adoption of the reviewed 6,643-byte partial workspace. This never
// moves/deletes evidence or imports old output receipts as compiler authority.
function heldRecovery(policy) {
  const spec = policy.buildOnly?.recoveryOf;
  if (!spec) return;
  const fail = () => {
    throw Error('RELEASE_SCOPE_HELD_RECOVERY_BINDING_INVALID');
  };
  const document = (ref) => {
    const stat = ref?.path && fs.lstatSync(ref.path);
    if (
      !stat ||
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 128 * 1024
    )
      fail();
    if (
      !ref ||
      !path.isAbsolute(ref.path || '') ||
      !/^[a-f0-9]{64}$/.test(ref.sha256 || '') ||
      canonical(ref.path) !== ref.path ||
      fileHash(ref.path) !== ref.sha256
    )
      fail();
    return read(ref.path, 128 * 1024);
  };
  if (spec.format !== 'held-6643-v1' || policy.phase !== 'build-only') fail();
  const plan = document(spec.plan),
    intent = document(spec.intent),
    moved = document(spec.moved);
  const old = plan.originalFailure,
    roots = plan.roots,
    map = plan.move;
  if (
    !/^[a-f0-9-]{36}$/.test(old?.scopeId || '') ||
    policy.baseline.bytes !== 6643 ||
    policy.baseline.runtimeCopies !== 0 ||
    policy.baseline.entries !== 8
  )
    fail();
  if (
    plan.kind !== 'one-off-retain-failed-6643-bytes' ||
    !old ||
    !roots ||
    !map ||
    !/^[a-f0-9-]{36}$/.test(old.claimId || '') ||
    old.scopeId === policy.scopeId ||
    roots.outputRoot !== policy.buildOnly.outputRoot ||
    roots.registry !== policy.registryDirectory ||
    hash(roots.outputIdentity) !== hash(policy.roots[0].identity) ||
    hash(roots.registryIdentity) !== hash(policy.registryIdentity) ||
    map.retainedBytes !== 6643 ||
    map.destination !== path.join(roots.outputRoot, '.held-' + old.claimId) ||
    path.dirname(map.source) !== roots.outputRoot ||
    present(map.source)
  )
    fail();
  const originalPolicy = document(old.policy),
    failure = document({ path: old.receiptPath, sha256: old.receiptSha256 });
  const ledger = document({ path: old.ledgerPath, sha256: old.ledgerSha256 });
  const sentinelStat = fs.lstatSync(old.adoptionSentinel.path);
  if (
    !sentinelStat.isFile() ||
    sentinelStat.isSymbolicLink() ||
    sentinelStat.size !== 64 ||
    canonical(old.adoptionSentinel.path) !== old.adoptionSentinel.path
  )
    fail();
  if (
    originalPolicy.phase !== 'build-only' ||
    originalPolicy.roots?.length !== 1 ||
    originalPolicy.roots[0].path !== roots.outputRoot ||
    hash(originalPolicy.roots[0].identity) !== hash(roots.outputIdentity) ||
    hash(originalPolicy.registryIdentity) !== hash(roots.registryIdentity) ||
    hash(identity(roots.registry)) !== hash(roots.registryIdentity) ||
    ledger.payload?.configSha !== old.policy.sha256 ||
    failure.policy?.sha256 !== old.policy.sha256 ||
    moved.controller?.check?.querySucceeded !== true ||
    moved.controller.check.matchingCount !== 0
  )
    fail();
  if (
    old.ledgerPath !== path.join(roots.registry, old.scopeId + '.state.json') ||
    hash(fileIdentity(old.ledgerPath)) !== hash(old.ledgerFileIdentity) ||
    old.adoptionSentinel.path !== old.ledgerPath + '.adopted' ||
    fileHash(old.adoptionSentinel.path) !== old.adoptionSentinel.sha256 ||
    originalPolicy.scopeId !== old.scopeId ||
    originalPolicy.registryDirectory !== roots.registry ||
    originalPolicy.buildOnly?.outputRoot !== roots.outputRoot ||
    policy.maxBytes > originalPolicy.maxBytes ||
    policy.maxGrowthBytes > originalPolicy.maxGrowthBytes ||
    policy.maxNewRuntimeCopies > originalPolicy.maxNewRuntimeCopies ||
    failure.exitCode !== 1 ||
    failure.controllerSession !== plan.controllerExit?.originalExecSession ||
    failure.claim?.id !== old.claimId ||
    !ledger.payload ||
    ledger.digest !== hash(ledger.payload) ||
    hash(ledger.payload.claim) !== hash(old.claim) ||
    ledger.payload.claim?.id !== old.claimId ||
    ledger.payload.outputs?.length !== 1 ||
    ledger.payload.outputs[0].complete !== false ||
    ledger.payload.outputs[0].path !== map.source ||
    ledger.payload.outputs[0].claim !== old.claimId
  )
    fail();
  for (const receipt of [intent, moved])
    if (
      receipt.planSha256 !== spec.plan.sha256 ||
      receipt.original?.claimId !== old.claimId ||
      receipt.original?.policySha256 !== old.policy.sha256 ||
      receipt.original?.ledgerSha256 !== old.ledgerSha256 ||
      receipt.source !== map.source ||
      receipt.destination !== map.destination ||
      receipt.retainedBytes !== 6643 ||
      receipt.capacityFreedBytes !== 0 ||
      receipt.oldOutputSuccessful !== false ||
      hash(receipt.files) !== hash(map.files) ||
      hash(receipt.directories) !== hash(map.directories)
    )
      fail();
  if (
    spec.intent.path !== plan.appendOnlyMapping?.intentPath ||
    spec.moved.path !== plan.appendOnlyMapping?.movedPath ||
    path.dirname(spec.intent.path) !== roots.registry ||
    path.dirname(spec.moved.path) !== roots.registry ||
    moved.status !== 'failed-retained-relocated' ||
    moved.intentSha256 !== spec.intent.sha256 ||
    moved.sourceAbsent !== true ||
    moved.destinationVerified !== true ||
    moved.oldLedgerUnchanged !== true ||
    moved.oldSentinelUnchanged !== true
  )
    fail();
  if (
    hash(identity(map.destination)) !==
    hash(map.directories?.find((row) => row.relative === '')?.identity)
  )
    fail();
  const names = ['build/package.json', 'build/schema.prisma', 'package.json'];
  const directories = ['', 'build', 'build/tmp', 'server'];
  const expectedFiles = new Map(
    (map.files || []).map((row) => [row.path.replace(/\\/g, '/'), row]),
  );
  const expectedDirs = new Map(
    (map.directories || []).map((row) => [
      row.relative.replace(/\\/g, '/'),
      row.identity,
    ]),
  );
  if (map.files?.length !== 3 || map.directories?.length !== 4) fail();
  if (
    hash([...expectedFiles.keys()].sort()) !== hash(names) ||
    hash([...expectedDirs.keys()].sort()) !== hash(directories) ||
    map.files.reduce((sum, row) => sum + row.bytes, 0) !== 6643
  )
    fail();
  let seenFiles = 0,
    seenDirs = 0;
  const visit = (at, relative = '') => {
    if (
      ++seenDirs > 4 ||
      hash(identity(at)) !== hash(expectedDirs.get(relative))
    )
      fail();
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const file = path.join(at, entry.name),
        key = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink()) fail();
      if (entry.isDirectory()) visit(file, key);
      else {
        const expected = expectedFiles.get(key),
          stat = fs.lstatSync(file);
        if (
          ++seenFiles > 3 ||
          !entry.isFile() ||
          !expected ||
          stat.nlink !== 1 ||
          stat.size !== expected.bytes ||
          fileHash(file) !== expected.sha256
        )
          fail();
      }
    }
  };
  visit(map.destination);
  if (seenFiles !== 3 || seenDirs !== 4) fail();
  const controls = fs.readdirSync(roots.registry);
  if (
    controls.length > 128 ||
    controls.reduce((sum, name) => {
      const s = fs.lstatSync(path.join(roots.registry, name));
      if (!s.isFile() || s.isSymbolicLink()) fail();
      return sum + s.size;
    }, 0) > 65536
  )
    throw Error('RELEASE_SCOPE_RECOVERY_CONTROL_BUDGET');
  return {
    oldScopeId: old.scopeId,
    oldClaimId: old.claimId,
    oldLedgerSha256: old.ledgerSha256,
    planSha256: spec.plan.sha256,
    intentSha256: spec.intent.sha256,
    movedSha256: spec.moved.sha256,
    heldPath: map.destination,
    retainedBytes: 6643,
    associationPath: path.join(
      roots.registry,
      'recovery-' + old.claimId + '.fresh-session.private.json',
    ),
  };
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
  if (
    configSha !== expected ||
    policy.format !== 1 ||
    !/^[a-f0-9-]{36}$/.test(policy.scopeId) ||
    !Array.isArray(policy.roots) ||
    !policy.roots.length ||
    policy.roots.length > 32 ||
    !Array.isArray(policy.protectedIds) ||
    (policy.phase !== 'build-only' && !policy.protectedIds.length) ||
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
  let buildSource;
  if (policy.phase === 'build-only') {
    const spec = policy.buildOnly;
    const sources = spec?.sources || (spec ? [spec] : []);
    const source =
      Array.isArray(sources) &&
      sources.find(
        (row) =>
          row.sourceCommit === request.sourceCommit &&
          row.sourceHash === request.sourceHash,
      );
    if (
      spec?.recoveryOf &&
      (!Array.isArray(spec.sources) ||
        request.pairSession !== true ||
        request.sourceCommit !== '3a36428210f22ea1986f0a96a6066e7fdc9baf46')
    )
      throw Error('RELEASE_SCOPE_RECOVERY_PAIR_REQUIRED');
    if (
      request.kind !== 'build' ||
      request.buildOnly !== true ||
      request.transition ||
      !spec ||
      !source ||
      !Array.isArray(sources) ||
      sources.length < 1 ||
      sources.length > 2 ||
      sources.some(
        (row) =>
          !/^[a-f0-9]{40}$/.test(row.sourceCommit || '') ||
          !/^[a-f0-9]{64}$/.test(row.sourceHash || ''),
      ) ||
      (spec.sources &&
        (sources.length !== 2 ||
          sources
            .map((row) => row.sourceCommit)
            .sort()
            .join(',') !==
            [
              '3a36428210f22ea1986f0a96a6066e7fdc9baf46',
              'f618e48f48ff0e3df1c646cb8a666a2461815732',
            ]
              .sort()
              .join(','))) ||
      !/^[a-f0-9]{64}$/.test(spec.runtimeSha256 || '') ||
      spec.runtimeSha256 !== fileHash(process.execPath) ||
      !Array.isArray(spec.commands) ||
      spec.commands.length > 3 ||
      spec.commands.some(
        (c) =>
          !path.isAbsolute(c.path) || !/^[a-f0-9]{64}$/.test(c.sha256 || ''),
      ) ||
      hash(spec.prismaGenerator || null) !==
        hash(request.prismaGenerator || null) ||
      (spec.prismaGenerator &&
        (!path.isAbsolute(spec.prismaGenerator.path || '') ||
          !/^[a-f0-9]{64}$/.test(spec.prismaGenerator.sha256 || '') ||
          fileHash(spec.prismaGenerator.path) !==
            spec.prismaGenerator.sha256)) ||
      request.root !== spec.outputRoot ||
      canonical(spec.outputRoot) !== spec.outputRoot ||
      !policy.roots.some((r) => r.path === spec.outputRoot) ||
      policy.roots.length !== 1 ||
      spec.outputRoot === path.resolve(__dirname, '../../.local-releases')
    )
      throw new Error('RELEASE_SCOPE_BUILD_ONLY_BINDING_REQUIRED');
    if (
      source.sourceRoot &&
      (request.sourceRoot !== source.sourceRoot ||
        canonical(source.sourceRoot) !== source.sourceRoot ||
        hash(identity(source.sourceRoot)) !== hash(source.sourceIdentity) ||
        contains(spec.outputRoot, source.sourceRoot))
    )
      throw Error('RELEASE_SCOPE_BUILD_ONLY_SOURCE_IDENTITY_CHANGED');
    buildSource = source;
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
  if (
    policy.baseline.format !== INVENTORY_FORMAT ||
    !/^[a-f0-9]{64}$/.test(policy.baseline.metadataDigest || '')
  )
    throw new Error('RELEASE_SCOPE_INVENTORY_VERSION_REVIEW_REQUIRED');
  const verifier = createVerifier(policy.scanBudget, {
    onSegment: options.onScanSegment,
    onRecord(row, content) {
      if (policy.phase !== 'build-only') return;
      const at = path.join(row[0], row[1]);
      for (const [root, tracker] of artifacts) {
        if (!contains(root, at)) continue;
        const expected = tracker.expected.get(at);
        if (
          !expected ||
          expected.kind !==
            { dir: 'directory', file: 'file', link: 'link' }[row[2]]
        )
          throw Error('RELEASE_ARTIFACT_UNREQUESTED: ' + at);
        if (
          (content !== undefined && content !== expected.sha256) ||
          (row[2] === 'link' && row.at(-1) !== expected.target)
        )
          throw Error('RELEASE_ARTIFACT_CHANGED: ' + at);
      }
    },
  });
  const useMetadata = verifier.limits.checkpointMode === 'identity-times-v1';
  let fullValidated = false;
  const verifiedOutputs = new Set();
  const descriptors = new Set();
  const descriptorWrites = new Map();
  const artifacts = new Map();
  const builtSources = new Set([request.sourceCommit]);
  let pairAdvanceAttempted = false;
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
    ledgerIdentity,
    recovery,
    recoveryLock,
    recoveryLockIdentity,
    associationSha;
  const configIdentity = fileIdentity(file);
  const recoveryControlBudget = (extra = 0) => {
    if (!recovery) return;
    const names = fs.readdirSync(directory);
    if (
      names.length > 128 ||
      names.reduce(
        (n, name) => n + fs.lstatSync(path.join(directory, name)).size,
        extra,
      ) > 65536
    )
      throw Error('RELEASE_SCOPE_RECOVERY_CONTROL_BUDGET');
  };
  const save = () => {
    if (recovery) {
      const bytes = Buffer.byteLength(
        JSON.stringify({ payload: prior, digest: hash(prior) }),
      );
      if (bytes > 8192) throw Error('RELEASE_SCOPE_RECOVERY_CONTROL_BUDGET');
      recoveryControlBudget(bytes + (present(ledger + '.adopted') ? 0 : 64));
    }
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
    if (
      recoveryLock &&
      (fs.readFileSync(recoveryLock, 'utf8') !== token ||
        hash(fileIdentity(recoveryLock)) !== hash(recoveryLockIdentity))
    )
      throw Error('RELEASE_SCOPE_RECOVERY_OWNER_CHANGED');
    if (associationSha && fileHash(recovery.associationPath) !== associationSha)
      throw Error('RELEASE_SCOPE_RECOVERY_ASSOCIATION_CHANGED');
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
    if (policy.phase === 'build-only') {
      // Only the new output root is observed. Do not fabricate global native
      // completeness or use this limited observation for cleanup/publication.
      const value = {
        scope: 'new-build-outputs-only',
        outputRoot: policy.buildOnly.outputRoot,
        globalReferences: 'unknown',
        compatibility: { stage: 'build-only', verified: false },
        records: [],
      };
      return { value, digest: hash(value) };
    }
    const value = query();
    verifier.assertBudget();
    const digest = validateReferences(value, policy);
    if (
      policy.phase === 'build-only' &&
      value.records.some((r) =>
        contains(policy.buildOnly.outputRoot, canonical(r.packagePath)),
      )
    )
      throw new Error('RELEASE_SCOPE_BUILD_ROOT_REFERENCED');
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
    if (recovery && hash(heldRecovery(policy)) !== hash(recovery))
      throw Error('RELEASE_SCOPE_HELD_RECOVERY_BINDING_INVALID');
    checkRoots(policy.roots);
    if (
      buildSource?.sourceRoot &&
      (canonical(buildSource.sourceRoot) !== buildSource.sourceRoot ||
        hash(identity(buildSource.sourceRoot)) !==
          hash(buildSource.sourceIdentity))
    )
      throw Error('RELEASE_SCOPE_BUILD_ONLY_SOURCE_IDENTITY_CHANGED');
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
    if (policy.phase === 'build-only')
      for (const row of prior.outputs)
        if (row.identity && !row.complete) artifacts.get(row.path).verify();
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
    recovery = heldRecovery(policy);
    if (recovery) {
      const at = path.join(directory, recovery.oldScopeId + '.lock');
      fs.writeFileSync(at, token, { flag: 'wx', mode: 0o600 });
      recoveryLock = at;
      recoveryLockIdentity = fileIdentity(at);
      if (hash(heldRecovery(policy)) !== hash(recovery))
        throw Error('RELEASE_SCOPE_HELD_RECOVERY_BINDING_INVALID');
    }
    if (present(ledger)) {
      if (policy.phase === 'build-only')
        throw Error('RELEASE_SCOPE_BUILD_ONLY_NEW_SESSION_REQUIRES_REVIEW');
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
        (recovery
          ? hash(fs.readdirSync(policy.buildOnly.outputRoot)) !==
            hash([path.basename(recovery.heldPath)])
          : fs.readdirSync(policy.buildOnly.outputRoot).length)
      )
        throw new Error('RELEASE_SCOPE_BUILD_ROOT_NOT_EMPTY');
      prior = { format: 1, configSha, outputs: [], claim: null };
      if (recovery) {
        if (present(recovery.associationPath))
          throw Error('RELEASE_SCOPE_RECOVERY_ASSOCIATION_ALREADY_SPENT');
        const association = {
          format: 1,
          kind: 'held-6643-fresh-memory-session',
          ...recovery,
          newScopeId: policy.scopeId,
          configSha,
        };
        const bytes = Buffer.from(JSON.stringify(association));
        if (bytes.length > 4096)
          throw Error('RELEASE_SCOPE_RECOVERY_CONTROL_BUDGET');
        recoveryControlBudget(bytes.length + 8192 + 64);
        const fd = fs.openSync(recovery.associationPath, 'wx', 0o600);
        try {
          fs.writeFileSync(fd, bytes);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        associationSha = fileHash(recovery.associationPath);
        prior.recovery = { ...recovery, associationSha256: associationSha };
      }
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
      approveDescriptor(fd, file, writing) {
        descriptors.add(fd);
        if (
          policy.phase === 'build-only' &&
          writing &&
          typeof file === 'string'
        ) {
          const at = path.resolve(file),
            row = prior.outputs.find(
              (r) =>
                r.claim === claim.id && !r.complete && contains(r.path, at),
            );
          if (row && artifacts.has(row.path)) {
            descriptorWrites.set(fd, {
              at,
              root: row.path,
              bytes: Buffer.alloc(0),
            });
            artifacts.get(row.path).apply([
              {
                path: at,
                kind: 'file',
                size: 0,
                sha256: require('./artifact-intents.cjs').digest(
                  Buffer.alloc(0),
                ),
              },
            ]);
          }
        }
      },
      assertFileAccess(method, args, writing) {
        if (policy.phase !== 'build-only') return;
        if (method === 'close') {
          descriptors.delete(args[0]);
          descriptorWrites.delete(args[0]);
        }
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
        if (!writing || ['close', 'fsync', 'fdatasync'].includes(method)) {
          if (
            ['readFile', 'createReadStream', 'openAsBlob', 'open'].includes(
              method,
            ) &&
            typeof args[0] === 'string'
          ) {
            const at = path.resolve(args[0]),
              row = prior.outputs.find((r) => contains(r.path, at));
            if (row && artifacts.has(row.path))
              artifacts.get(row.path).verify(at);
          }
          return;
        }
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
      hashSourceEnvironmentFixture(expectedSha256) {
        if (policy.phase !== 'build-only' || !buildSource?.sourceRoot)
          throw Error('BUILD_ENVIRONMENT_FIXTURE_BINDING_REQUIRED');
        check();
        return require('./verify-source.cjs').hashCommittedBuildEnvironment(
          buildSource.sourceRoot,
          buildSource.sourceCommit,
          expectedSha256,
        );
      },
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
        if (policy.phase === 'build-only')
          artifacts.set(
            at,
            require('./artifact-intents.cjs').createArtifacts(at, (cost) =>
              verifier.chargeArtifacts(cost),
            ),
          );
        save();
      },
      prepareArtifactMutation(method, args) {
        if (policy.phase !== 'build-only') return () => {};
        if (method === 'open') return () => {};
        if (method === 'write' && descriptorWrites.has(args[0])) {
          const record = descriptorWrites.get(args[0]);
          if (typeof args[1] !== 'string' || args[2] !== undefined)
            throw Error('RELEASE_ARTIFACT_DESCRIPTOR_WRITE_UNSUPPORTED');
          const bytes = Buffer.concat([record.bytes, Buffer.from(args[1])]);
          if (bytes.length > 16 * 1024 ** 2)
            throw Error('RELEASE_ARTIFACT_DESCRIPTOR_BUDGET');
          return () => {
            record.bytes = bytes;
            artifacts.get(record.root).apply([
              {
                path: record.at,
                kind: 'file',
                size: bytes.length,
                sha256: require('./artifact-intents.cjs').digest(bytes),
              },
            ]);
          };
        }
        const destination = ['cp', 'copyFile', 'symlink'].includes(method)
          ? args[1]
          : args[0];
        if (typeof destination !== 'string') return () => {};
        const at = path.resolve(destination);
        const row = prior.outputs.find(
          (r) => r.claim === claim.id && !r.complete && contains(r.path, at),
        );
        if (!row || !artifacts.has(row.path)) return () => {};
        const tracker = artifacts.get(row.path);
        if (['rm', 'rmdir', 'unlink', 'rename'].includes(method))
          tracker.verify(at);
        const events = require('./artifact-intents.cjs').mutationEvents(
          method,
          args,
          tracker.expected,
        );
        return () => tracker.apply(events);
      },
      acceptCompilerIntents(output, events) {
        const row = prior.outputs.find(
          (r) => r.path === output && r.claim === claim.id && !r.complete,
        );
        if (policy.phase !== 'build-only' || !row || !artifacts.has(output))
          throw Error('RELEASE_ARTIFACT_OWNED_OUTPUT_REQUIRED');
        artifacts.get(output).apply(events);
      },
      artifactFingerprint(output) {
        if (!artifacts.has(output))
          throw Error('RELEASE_ARTIFACT_OWNED_OUTPUT_REQUIRED');
        return artifacts.get(output).fingerprint();
      },
      nextBuild(next) {
        if (
          closed ||
          pairAdvanceAttempted ||
          policy.phase !== 'build-only' ||
          !policy.buildOnly.sources
        )
          throw Error('RELEASE_SCOPE_BUILD_PAIR_SESSION_REQUIRED');
        pairAdvanceAttempted = true;
        check();
        const source = policy.buildOnly.sources.find(
          (s) =>
            s.sourceCommit === next.sourceCommit &&
            s.sourceHash === next.sourceHash,
        );
        if (
          !source ||
          (recovery &&
            (next.pairSession !== true ||
              next.sourceCommit !==
                'f618e48f48ff0e3df1c646cb8a666a2461815732')) ||
          hash(policy.buildOnly.prismaGenerator || null) !==
            hash(next.prismaGenerator || null) ||
          builtSources.has(next.sourceCommit) ||
          next.kind !== 'build' ||
          next.buildOnly !== true ||
          next.root !== target ||
          next.transition ||
          !Number.isSafeInteger(next.reserveBytes) ||
          next.reserveBytes < 1 ||
          next.runtimeCopies !== 1 ||
          (source.sourceRoot &&
            (next.sourceRoot !== source.sourceRoot ||
              canonical(source.sourceRoot) !== source.sourceRoot ||
              hash(identity(source.sourceRoot)) !==
                hash(source.sourceIdentity)))
        )
          throw Error('RELEASE_SCOPE_BUILD_ONLY_BINDING_REQUIRED');
        for (const row of prior.outputs.filter((r) => r.claim === claim.id)) {
          artifacts.get(row.path).verify();
          const receipt = verifier.scan([
            { path: row.path, identity: row.identity },
          ]);
          Object.assign(row, {
            digest: receipt.digest,
            metadataDigest: receipt.metadataDigest,
            complete: true,
          });
        }
        save();
        const measure = check();
        if (
          measure.bytes + next.reserveBytes > policy.maxBytes ||
          measure.bytes + next.reserveBytes - policy.baseline.bytes >
            policy.maxGrowthBytes
        )
          throw Error('RELEASE_SCOPE_COPY_PEAK_EXCEEDED');
        if (
          measure.runtimeCopies + 1 - policy.baseline.runtimeCopies >
          policy.maxNewRuntimeCopies
        )
          throw Error('RELEASE_SCOPE_RUNTIME_COPY_PEAK_EXCEEDED');
        const disk = fs.statfsSync(target, { bigint: true });
        if (
          disk.bavail * disk.bsize - BigInt(next.reserveBytes) <
          BigInt(MIN_FREE)
        )
          throw Error('RELEASE_SCOPE_PHYSICAL_RESERVE_EXCEEDED');
        claim = {
          id: crypto.randomUUID(),
          kind: 'build',
          root: target,
          reserveBytes: next.reserveBytes,
          runtimeCopies: 1,
          startBytes: measure.bytes,
          startRuntimeCopies: measure.runtimeCopies,
          refs,
          outputs: [],
        };
        prior.claim = claim;
        buildSource = source;
        request = next;
        builtSources.add(next.sourceCommit);
        save();
      },
      allowCleanup(outputs) {
        assertWritable();
        if (policy.phase === 'build-only')
          throw new Error('RELEASE_SCOPE_BUILD_ONLY_FAILED_OUTPUT_HELD');
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
            row.digest = receipt.digest;
            row.metadataDigest = receipt.metadataDigest;
            row.complete = true;
          }
          prior.outputs = prior.outputs.filter((row) => present(row.path));
          prior.claim = null;
          save();
        } finally {
          owner();
          if (recoveryLock) fs.unlinkSync(recoveryLock);
          fs.unlinkSync(lock);
        }
      },
    };
  } catch (error) {
    owner();
    if (recoveryLock) fs.unlinkSync(recoveryLock);
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
  // Read-only preparation; open repeats validation while holding common locks.
  inspectHeldRecovery: heldRecovery,
  open,
  within,
  session,
  requireSession,
  assertWritableSession,
  DEFAULT_BYTES,
  MIN_FREE,
};
