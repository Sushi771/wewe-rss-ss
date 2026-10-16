// One reviewed installation pair. No activation, DB access, history deletion or builds.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const processes = require('node:child_process');
const { hostEffects, fileHash, verifyRelease } = require('./lib.cjs');
const { createVerifier } = require('./scope-inventory.cjs');
const LIMITS = Object.freeze({
  bytes: 245837824,
  copy: 244789248,
  metadata: 1048576,
  runtimes: 2,
  free: 4 * 1024 ** 3,
});
const MODE = 'once-frozen-pair-v1';
const PIN_FILES = [
  'lib.cjs',
  'release-scope.cjs',
  'scope-inventory.cjs',
  'install-lifecycle.cjs',
  'space-budget.cjs',
  'once-pair-admission.cjs',
  'once-pair-publication.cjs',
  'once-pair-state.py',
  'process-identity.ps1',
  'tcp-listeners.ps1',
  'windows-release-references.cjs',
  'windows-release-reference-collector.ps1',
  'windows-reference-directory-identity.cs',
];
const hash = (value) =>
  crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code) => {
  throw new Error('ONCE_PAIR_' + code);
};
const present = (file) => {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
};
const canonical = (file) => fs.realpathSync.native(file);
const contains = (root, file) => {
  const relative = path.relative(root, file);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith('..' + path.sep) &&
      !path.isAbsolute(relative))
  );
};
const identity = (file) => {
  const s = fs.lstatSync(file, { bigint: true });
  if (!s.isDirectory() || s.isSymbolicLink()) fail('DIRECTORY_IDENTITY');
  return [s.dev, s.ino, s.birthtimeNs].map(String);
};
const fileIdentity = (file) => {
  const s = fs.lstatSync(file, { bigint: true });
  if (!s.isFile() || s.isSymbolicLink()) fail('FILE_IDENTITY');
  return [s.dev, s.ino, s.birthtimeNs].map(String);
};
function read(file, maximum = LIMITS.metadata) {
  const s = fs.lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink() || s.size > maximum)
    fail('DOCUMENT_LIMIT');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function codePins() {
  return Object.fromEntries(
    PIN_FILES.map((name) => [name, fileHash(path.join(__dirname, name))]),
  );
}
const continuationKind = 'verified-pre-copy-continuation-v1';
// Reviewed c438798 protocol writes publication/credit intent before business
// effects. Arbitrary historical code pins cannot establish unused credits.
const legacyPreCopyPins =
  '377a9e77c6096bc0c46ee1cdef6289eb6be03f046add701ad1154649f346cfec';
const continuationPath = (p) =>
  path.join(p.registryDirectory, p.scopeId + '.state.json.continuation.json');
function pinnedDocument(spec, exactPath, raw = false) {
  if (
    !spec ||
    Object.keys(spec).sort().join('|') !== 'identity|path|sha256' ||
    !Array.isArray(spec.identity) ||
    spec.identity.length !== 3 ||
    (exactPath && spec.path !== exactPath) ||
    canonical(spec.path) !== spec.path ||
    !/^[a-f0-9]{64}$/.test(spec.sha256 || '') ||
    hash(fileIdentity(spec.path)) !== hash(spec.identity) ||
    fs.lstatSync(spec.path).nlink !== 1
  )
    fail('CONTINUATION_INPUT_PIN');
  const fd = fs.openSync(spec.path, 'r');
  try {
    const readPinnedBytes = () => {
      const before = fs.fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.size > BigInt(LIMITS.metadata))
        fail('DOCUMENT_LIMIT');
      if (
        before.nlink !== 1n ||
        hash([before.dev, before.ino, before.birthtimeNs].map(String)) !==
          hash(spec.identity)
      )
        fail('CONTINUATION_INPUT_CHANGED');
      // One extra byte detects growth without ever reading an unbounded file.
      const buffer = Buffer.alloc(Number(before.size) + 1);
      let length = 0;
      while (length < buffer.length) {
        const n = fs.readSync(
          fd,
          buffer,
          length,
          buffer.length - length,
          length,
        );
        if (!n) break;
        length += n;
      }
      const after = fs.fstatSync(fd, { bigint: true });
      const bytes = buffer.subarray(0, length);
      if (
        BigInt(length) !== before.size ||
        after.size !== before.size ||
        after.nlink !== 1n ||
        hash([after.dev, after.ino, after.birthtimeNs].map(String)) !==
          hash(spec.identity) ||
        crypto.createHash('sha256').update(bytes).digest('hex') !==
          spec.sha256 ||
        hash(fileIdentity(spec.path)) !== hash(spec.identity) ||
        canonical(spec.path) !== spec.path
      )
        fail('CONTINUATION_INPUT_CHANGED');
      return bytes;
    };
    const bytes = readPinnedBytes();
    readPinnedBytes();
    return raw ? bytes.toString('utf8') : JSON.parse(bytes.toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
}
function continuationProjection(policy) {
  const q = structuredClone(policy);
  delete q.preCopyContinuation;
  delete q.codePins;
  delete q.probe;
  if (q.approval) {
    delete q.approval.id;
    delete q.approval.confirmed;
    delete q.approval.receipt;
    delete q.approval.continuation;
  }
  if (q.windowsReferences) {
    delete q.windowsReferences.collectorSha256;
    delete q.windowsReferences.collectorIdentitySha256;
    if (q.windowsReferences.operationCoverage?.processCoverage)
      delete q.windowsReferences.operationCoverage.processCoverage
        .backgroundGaps;
  }
  return q;
}
function preCopyState(state, p, fromSha) {
  if (
    !state ||
    Object.keys(state).some(
      (k) =>
        ![
          'format',
          'once',
          'configSha',
          'outputs',
          'claim',
          'slots',
          'complete',
        ].includes(k),
    ) ||
    state.format !== 1 ||
    state.once !== MODE ||
    state.configSha !== fromSha ||
    state.claim !== null ||
    !Array.isArray(state.outputs) ||
    state.outputs.length ||
    (state.complete !== undefined && state.complete !== false) ||
    !Array.isArray(state.slots) ||
    state.slots.length !== 2 ||
    state.slots.some(
      (s) =>
        Object.keys(s).some(
          (k) =>
            ![
              'id',
              'path',
              'started',
              'complete',
              'identity',
              'copied',
            ].includes(k),
        ) ||
        s.started !== false ||
        s.complete !== false ||
        s.identity !== null ||
        (s.copied !== undefined && s.copied !== false) ||
        !p.pair.some((t) => t.id === s.id && t.target === s.path),
    ) ||
    new Set(state.slots.map((s) => s.id)).size !== 2
  )
    fail('CONTINUATION_NOT_PRE_COPY');
}
function continuationPolicy(p, expected) {
  const c = p.preCopyContinuation;
  if (
    !c ||
    c.format !== 1 ||
    c.kind !== continuationKind ||
    !/^[a-f0-9-]{36}$/.test(c.id || '') ||
    Object.keys(c).sort().join('|') !==
      [
        'format',
        'id',
        'kind',
        'previousLedger',
        'previousOutcome',
        'previousPolicy',
        'previousSentinel',
      ].join('|')
  )
    fail('CONTINUATION_CONTRACT');
  const old = pinnedDocument(c.previousPolicy);
  if (
    c.previousPolicy.sha256 === expected ||
    old.preCopyContinuation ||
    old.approval?.confirmed !== true ||
    p.approval?.confirmed !== true ||
    !p.approval.id ||
    p.approval.id === old.approval.id ||
    hash(p.approval.continuation) !==
      hash({
        id: c.id,
        fromConfigSha: c.previousPolicy.sha256,
        fromLedgerSha: c.previousLedger.sha256,
        fromSentinelSha: c.previousSentinel.sha256,
      }) ||
    hash(continuationProjection(old)) !== hash(continuationProjection(p))
  )
    fail('CONTINUATION_POLICY_DIFFERENCE');
  const oldRoot = path.dirname(old.probe.path);
  const oldPins = hash(PIN_FILES.map((name) => [name, old.codePins?.[name]])),
    currentPins = codePins();
  if (
    oldPins !== legacyPreCopyPins &&
    oldPins !== hash(PIN_FILES.map((name) => [name, currentPins[name]]))
  )
    fail('CONTINUATION_UNSUPPORTED_OLD_PROTOCOL');
  if (
    Object.keys(old.codePins || {})
      .sort()
      .join('|') !== [...PIN_FILES].sort().join('|') ||
    old.probe.sha256 !== old.codePins['windows-release-references.cjs']
  )
    fail('CONTINUATION_OLD_CODE_PIN');
  for (const name of PIN_FILES) {
    const at = path.join(oldRoot, name);
    if (canonical(at) !== at || fileHash(at) !== old.codePins[name])
      fail('CONTINUATION_OLD_CODE_PIN');
  }
  const outcome = pinnedDocument(c.previousOutcome);
  // Historical outcome is pinned evidence, never proof of unused credits by
  // itself. Old code protocol + exact pre-copy state/targets provide that proof.
  if (
    outcome.outcome !== 'HELD_BEFORE_PACKAGE_COPY' ||
    outcome.executionPolicySha256 !== c.previousPolicy.sha256
  )
    fail('CONTINUATION_FAILURE_EVIDENCE');
  return { c, old };
}
function validateContinuation(p, state, expected) {
  if (
    p.mode !== MODE ||
    state.format !== 1 ||
    state.once !== MODE ||
    state.configSha !== expected
  )
    fail('CONTINUATION_STATE_BINDING');
  if (!state.continuation) {
    if (p.preCopyContinuation) fail('CONTINUATION_STATE_MISSING');
    return null;
  }
  const { c } = continuationPolicy(p, expected),
    s = state.continuation,
    at = continuationPath(p);
  if (
    fs
      .readdirSync(p.registryDirectory)
      .some(
        (name) =>
          name.startsWith(p.scopeId + '.state.json.') &&
          ![p.scopeId + '.state.json.adopted', path.basename(at)].includes(
            name,
          ),
      )
  )
    fail('CONTINUATION_FOREIGN_CONTROL');
  if (
    Object.keys(s).sort().join('|') !==
      ['id', 'receiptIdentity', 'receiptSha256'].join('|') ||
    s.id !== c.id ||
    hash(fileIdentity(at)) !== hash(s.receiptIdentity) ||
    fileHash(at) !== s.receiptSha256 ||
    canonical(at) !== at ||
    fs.lstatSync(at).nlink !== 1
  )
    fail('CONTINUATION_RECEIPT_CHANGED');
  const r = pinnedDocument(
    { path: at, sha256: s.receiptSha256, identity: s.receiptIdentity },
    at,
  );
  if (
    r.format !== 1 ||
    r.kind !== continuationKind ||
    r.id !== c.id ||
    r.fromConfigSha !== c.previousPolicy.sha256 ||
    r.toConfigSha !== expected ||
    r.approvalId !== p.approval.id ||
    hash(r.previousLedger) !== hash(c.previousLedger) ||
    hash(r.previousSentinel) !== hash(c.previousSentinel) ||
    hash(r.previousPolicy) !== hash(c.previousPolicy) ||
    hash(r.previousOutcome) !== hash(c.previousOutcome) ||
    typeof r.previousLedgerText !== 'string' ||
    crypto.createHash('sha256').update(r.previousLedgerText).digest('hex') !==
      c.previousLedger.sha256 ||
    r.previousSentinelText !== c.previousPolicy.sha256
  )
    fail('CONTINUATION_RECEIPT_INVALID');
  const envelope = JSON.parse(r.previousLedgerText);
  if (envelope.digest !== hash(envelope.payload))
    fail('CONTINUATION_HISTORY_CORRUPT');
  preCopyState(envelope.payload, p, c.previousPolicy.sha256);
  pinnedDocument(
    c.previousSentinel,
    path.join(p.registryDirectory, p.scopeId + '.state.json.adopted'),
    true,
  );
  if (
    fs.readFileSync(c.previousSentinel.path, 'utf8') !== r.previousSentinelText
  )
    fail('CONTINUATION_SENTINEL_CHANGED');
  return {
    sentinelConfigSha: r.fromConfigSha,
    files: [
      { path: at, sha256: s.receiptSha256, identity: s.receiptIdentity },
      c.previousPolicy,
      c.previousOutcome,
      c.previousSentinel,
    ],
  };
}
function checkPlan(
  policyFile,
  expected,
  requireApproval = false,
  allowPublished = false,
) {
  if (hostEffects.currentLease()) fail('NESTED_ADMISSION');
  const file = canonical(policyFile),
    p = read(file),
    configSha = fileHash(file);
  if (
    !/^[a-f0-9]{64}$/.test(expected || '') ||
    configSha !== expected ||
    p.format !== 1 ||
    p.mode !== MODE ||
    !/^[a-f0-9-]{36}$/.test(p.scopeId || '')
  )
    fail('POLICY_PIN');
  if (
    requireApproval &&
    (!p.approval ||
      p.approval.confirmed !== true ||
      typeof p.approval.id !== 'string' ||
      !p.approval.id ||
      p.approval.id.length > 160)
  )
    fail('EXPLICIT_APPROVAL_REQUIRED');
  if (hash(p.limits) !== hash(LIMITS) || hash(p.codePins) !== hash(codePins()))
    fail('FINITE_LIMITS_OR_CODE_PIN');
  if (!Array.isArray(p.roots) || !p.roots.length || p.roots.length > 32)
    fail('ROOT_SET');
  for (let i = 0; i < p.roots.length; i++) {
    const root = p.roots[i];
    if (
      !path.isAbsolute(root.path) ||
      canonical(root.path) !== root.path ||
      hash(identity(root.path)) !== hash(root.identity)
    )
      fail('ROOT_IDENTITY');
    if (
      p.roots
        .slice(0, i)
        .some(
          (other) =>
            contains(root.path, other.path) || contains(other.path, root.path),
        )
    )
      fail('OVERLAPPING_ROOTS');
  }
  if (
    canonical(p.registryDirectory) !== p.registryDirectory ||
    hash(identity(p.registryDirectory)) !== hash(p.registryIdentity) ||
    p.roots.some(
      (root) =>
        contains(root.path, p.registryDirectory) || contains(root.path, file),
    )
  )
    fail('CANONICAL_REGISTRY');
  if (
    canonical(p.installRoot) !== p.installRoot ||
    !p.roots.some((root) => contains(root.path, p.installRoot))
  )
    fail('INSTALL_ROOT');
  if (
    !Array.isArray(p.protectedPackages) ||
    p.protectedPackages.length !== 4 ||
    new Set(p.protectedPackages.map((item) => item.id)).size !== 4
  )
    fail('FOUR_EXACT_PROTECTED_IDS');
  if (
    !Array.isArray(p.pair) ||
    p.pair.length !== 2 ||
    new Set(p.pair.map((item) => item.id)).size !== 2 ||
    !['candidate', 'rollback'].every((role) =>
      p.pair.some((item) => item.role === role),
    )
  )
    fail('EXACT_PAIR');
  if (
    !Array.isArray(p.legacyIds) ||
    p.legacyIds.length > 129 ||
    new Set(p.legacyIds).size !== p.legacyIds.length ||
    p.legacyIds.some((id) => !/^[A-Za-z0-9][A-Za-z0-9T.Z-]{0,159}$/.test(id))
  )
    fail('LEGACY_INVENTORY');
  const pointer = path.join(p.installRoot, 'active.json');
  const pointerId = read(pointer, 65536).id;
  const publishedHash = crypto
    .createHash('sha256')
    .update(JSON.stringify({ format: 1, id: pointerId }) + '\n')
    .digest('hex');
  if (
    (fileHash(pointer) !== p.pointerSha256 || pointerId !== p.currentId) &&
    !(
      allowPublished &&
      p.publication &&
      [p.currentId, ...p.pair.map((item) => item.id)].includes(pointerId) &&
      fileHash(pointer) === publishedHash
    )
  )
    fail('CURRENT_POINTER');
  const protectedIds = p.protectedPackages.map((item) => item.id);
  if (
    hash(p.protectedIds) !== hash(protectedIds) ||
    hash(p.packageProofs) !==
      hash(
        Object.fromEntries(
          p.protectedPackages.map((item) => [item.id, item.manifestSha256]),
        ),
      )
  )
    fail('REFERENCE_PACKAGE_PINS');
  if (
    !protectedIds.includes(p.currentId) ||
    !protectedIds.includes(p.heldId) ||
    p.currentId === p.heldId ||
    p.pair.some((item) => item.id === p.currentId || item.id === p.heldId) ||
    !p.legacyIds.includes(p.heldId)
  )
    fail('HELD_FALLBACK_REQUIRED');
  const block = Number(fs.statfsSync(p.installRoot, { bigint: true }).bsize);
  const metadataBlock = Math.max(
    block,
    Number(fs.statfsSync(p.registryDirectory, { bigint: true }).bsize),
  );
  if (
    !Number.isSafeInteger(block) ||
    block < 1 ||
    !Number.isSafeInteger(metadataBlock) ||
    metadataBlock > 65536
  )
    fail('BLOCK_SIZE');
  const verifier = createVerifier({
    profile: 'legacy-stream-v1',
    checkpointMode: 'identity-times-v1',
    scanEntries: 100000,
    operationEntries: 1000000,
    scanReadBytes: 1024 ** 3,
    operationReadBytes: 8 * 1024 ** 3,
    durationMs: 120000,
  });
  const packages = new Map();
  for (const spec of p.protectedPackages) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9T.Z-]{0,159}$/.test(spec.id) ||
      canonical(spec.path) !== spec.path ||
      path.basename(spec.path) !== spec.id ||
      !p.roots.some((root) => contains(root.path, spec.path)) ||
      hash(identity(spec.path)) !== hash(spec.identity)
    )
      fail('PROTECTED_PACKAGE_PATH');
    const scan = verifier.scan([{ path: spec.path, identity: spec.identity }]);
    if (scan.runtimeCopies !== 1) fail('ONE_RUNTIME_PER_PACKAGE');
    if (fileHash(path.join(spec.path, 'release.json')) !== spec.manifestSha256)
      fail('MANIFEST_PIN');
    const m = verifyRelease(spec.path);
    if (
      m.id !== spec.id ||
      m.sourceCommit !== spec.sourceCommit ||
      !/^[a-f0-9]{40}$/.test(spec.sourceCommit) ||
      Object.keys(m.files).length > 10000
    )
      fail('PACKAGE_PROOF');
    const files = { ...m.files, 'release.json': spec.manifestSha256 };
    const snapshots = {};
    let physical = 0;
    const directories = new Set(['']);
    for (const [relative, sha256] of Object.entries(files)) {
      const at = path.resolve(spec.path, relative);
      if (
        !contains(spec.path, at) ||
        at === spec.path ||
        !/^[a-f0-9]{64}$/.test(sha256)
      )
        fail('MANIFEST_PATH');
      const stat = fs.lstatSync(at, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || canonical(at) !== at)
        fail('PACKAGE_FILE_ALIAS');
      snapshots[relative] = {
        bytes: Number(stat.size),
        sha256,
        identity: [
          stat.dev,
          stat.ino,
          stat.birthtimeNs,
          stat.ctimeNs,
          stat.mtimeNs,
        ].map(String),
      };
      physical += Math.ceil(Number(stat.size) / block) * block;
      for (
        let dir = path.dirname(relative);
        dir !== '.';
        dir = path.dirname(dir)
      )
        directories.add(dir);
    }
    for (const [name, target] of Object.entries(m.links || {})) {
      if (
        !contains(spec.path, path.resolve(spec.path, name)) ||
        !contains(spec.path, path.resolve(spec.path, target))
      )
        fail('PACKAGE_LINK_ESCAPE');
      physical += block;
      for (let dir = path.dirname(name); dir !== '.'; dir = path.dirname(dir))
        directories.add(dir);
    }
    physical += (directories.size - 1) * block;
    packages.set(spec.id, {
      spec,
      manifest: m,
      files: snapshots,
      physical,
      directories,
      scan,
    });
  }
  if (
    [...packages.values()].reduce((sum, item) => sum + item.scan.bytes, 0) >
    768 * 1024 ** 2
  )
    fail('PROTECTED_PACKAGE_BYTES');
  const pair = p.pair.map((item) => {
    const pkg = packages.get(item.id);
    if (
      !pkg ||
      item.target !== path.join(p.installRoot, item.id) ||
      item.source !== pkg.spec.path ||
      contains(p.installRoot, item.source) ||
      pkg.manifest.schemaCompatibility !== 'current'
    )
      fail('PAIR_BINDING');
    return { ...item, pkg };
  });
  require('./windows-release-references.cjs').operationContract(p);
  if (
    block * 64 + pair.reduce((sum, item) => sum + item.pkg.physical, 0) >
    LIMITS.copy
  )
    fail('COPY_RESERVATION');
  if (
    p.protectedPackages.find((item) => item.id === p.currentId).path !==
      path.join(p.installRoot, p.currentId) ||
    p.protectedPackages.find((item) => item.id === p.heldId).path !==
      path.join(p.installRoot, p.heldId)
  )
    fail('INSTALLED_ROLE_PATH');
  const proofSpec = p.windowsReferences?.compatibilityProof;
  if (
    !proofSpec ||
    proofSpec.sha256 !== p.compatibilityProofSha256 ||
    fileHash(proofSpec.path) !== proofSpec.sha256
  )
    fail('COMPATIBILITY_PIN');
  const proof = read(proofSpec.path);
  if (
    proof.kind !== 'additive-schema-unknown-claim-rollback' ||
    proof.businessDatabaseRestored !== false ||
    [
      'additiveSchema',
      'unknownClaimsPreserved',
      'businessRowsPreserved',
      'rollbackStarted',
    ].some((key) => proof.checks?.[key] !== true)
  )
    fail('COMPATIBILITY_CHECKS');
  for (const role of ['candidate', 'rollback']) {
    const item = pair.find((row) => row.role === role);
    if (
      proof[role]?.id !== item.id ||
      proof[role]?.sourceCommit !== item.pkg.spec.sourceCommit ||
      proof[role]?.manifestSha256 !== item.pkg.spec.manifestSha256
    )
      fail('COMPATIBILITY_ROLE');
  }
  return { file, configSha, p, packages, pair, block, metadataBlock, verifier };
}
function withAdmission(policyFile, expected, action, options = {}) {
  const plan = checkPlan(policyFile, expected, true),
    { p, pair } = plan;
  const lock = path.join(p.registryDirectory, p.scopeId + '.lock'),
    ledger = path.join(p.registryDirectory, p.scopeId + '.state.json'),
    sentinel = ledger + '.adopted';
  const nonce = crypto.randomUUID(),
    token = JSON.stringify({ pid: process.pid, nonce, configSha: expected });
  const cfgIdentity = fileIdentity(plan.file),
    pins = codePins();
  let state,
    ledgerIdentity,
    lockIdentity,
    sentinelIdentity,
    ledgerSha,
    closed = false,
    lastReceipt,
    allocatedThisCall = 0;
  let sentinelConfigSha = expected,
    continuationAuthority = null,
    continuationStarted = false,
    continuationCommitted = false;
  const descriptors = new Map(),
    ownedMetadata = new Set();
  const metadataPath = (at) =>
    at === path.join(p.installRoot, '.build-budget.lock') ||
    at === path.join(p.installRoot, '.release-lifecycle.json') ||
    (/^\.release-lifecycle\.json\.[a-f0-9-]{36}\.tmp$/.test(
      path.basename(at),
    ) &&
      path.dirname(at) === p.installRoot);
  const controlFiles = () => [
    ...new Set([
      lock,
      ledger,
      sentinel,
      ...fs
        .readdirSync(p.registryDirectory)
        .filter((name) => name.startsWith(p.scopeId + '.state.json.'))
        .map((name) => path.join(p.registryDirectory, name)),
      ...fs
        .readdirSync(p.installRoot)
        .filter((name) => metadataPath(path.join(p.installRoot, name)))
        .map((name) => path.join(p.installRoot, name)),
    ]),
  ];
  const metadataUsed = () =>
    controlFiles().reduce((sum, file) => {
      const s = present(file);
      if (s && (!s.isFile() || s.isSymbolicLink())) fail('METADATA_ALIAS');
      return (
        sum +
        (s ? Math.ceil(s.size / plan.metadataBlock) * plan.metadataBlock : 0)
      );
    }, plan.metadataBlock * 8);
  const owner = () => {
    if (
      fs.readFileSync(lock, 'utf8') !== token ||
      fileHash(plan.file) !== expected ||
      hash(fileIdentity(plan.file)) !== hash(cfgIdentity) ||
      hash(codePins()) !== hash(pins) ||
      hash(identity(p.registryDirectory)) !== hash(p.registryIdentity)
    )
      fail('OWNER_OR_POLICY_CHANGED');
    if (lockIdentity && hash(fileIdentity(lock)) !== hash(lockIdentity))
      fail('LOCK_REPLACED');
    if (!ledgerIdentity && present(ledger)) fail('UNEXPECTED_LEDGER');
    if (ledgerIdentity && hash(fileIdentity(ledger)) !== hash(ledgerIdentity))
      fail('LEDGER_REPLACED');
    if (ledgerSha && fileHash(ledger) !== ledgerSha) fail('LEDGER_CHANGED');
    if (
      sentinelIdentity &&
      hash(fileIdentity(sentinel)) !== hash(sentinelIdentity)
    )
      fail('SENTINEL_REPLACED');
    if (!sentinelIdentity && present(sentinel)) fail('UNEXPECTED_SENTINEL');
    if (
      present(sentinel) &&
      fs.readFileSync(sentinel, 'utf8') !== sentinelConfigSha
    )
      fail('SENTINEL_CHANGED');
    if (continuationAuthority)
      for (const pin of continuationAuthority.files) {
        if (
          canonical(pin.path) !== pin.path ||
          hash(fileIdentity(pin.path)) !== hash(pin.identity) ||
          fileHash(pin.path) !== pin.sha256 ||
          fs.lstatSync(pin.path).nlink !== 1
        )
          fail('CONTINUATION_AUTHORITY_CHANGED');
      }
  };
  function save() {
    owner();
    const text = JSON.stringify({ payload: state, digest: hash(state) }),
      temporary = ledger + '.' + nonce + '.tmp';
    if (
      Math.ceil(Buffer.byteLength(text) / plan.metadataBlock) *
        plan.metadataBlock +
        metadataUsed() >
      LIMITS.metadata
    )
      fail('METADATA_LIMIT');
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, text);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    const publishedIdentity = fileIdentity(temporary),
      publishedSha = crypto.createHash('sha256').update(text).digest('hex');
    owner();
    fs.renameSync(temporary, ledger);
    ledgerIdentity = publishedIdentity;
    ledgerSha = publishedSha;
    owner();
  }
  function query() {
    const observation = {
      assertWritable() {
        fail('OBSERVATION_WRITE_DENIED');
      },
      assertOperation() {
        fail('NESTED_ADMISSION');
      },
    };
    const facts = hostEffects.context.run(observation, () => {
      if (options.query) return options.query();
      if (
        !p.probe ||
        canonical(p.probe.path) !==
          canonical(path.join(__dirname, 'windows-release-references.cjs')) ||
        fileHash(p.probe.path) !== p.probe.sha256
      )
        fail('REFERENCE_PROBE_PIN');
      return JSON.parse(
        processes.execFileSync(process.execPath, [p.probe.path, plan.file], {
          encoding: 'utf8',
          timeout: 30000,
          maxBuffer: 1024 ** 2,
          windowsHide: true,
        }),
      );
    });
    require('./release-scope.cjs').validateReferences(
      facts,
      {
        ...p,
        protectedIds: p.protectedPackages.map((item) => item.id),
        packageProofs: Object.fromEntries(
          p.protectedPackages.map((item) => [item.id, item.manifestSha256]),
        ),
      },
      'install',
    );
    for (const record of facts.records) {
      const allowed = [
        plan.packages.get(record.packageId)?.spec.path,
        pair.find((item) => item.id === record.packageId)?.target,
      ].filter(Boolean);
      if (!allowed.includes(canonical(record.packagePath)))
        fail('UNAPPROVED_REFERENCE_PATH');
    }
    const digest = hash({
      records: facts.records,
      operationCoverage: facts.operationCoverage,
    });
    if (state.claim.refs && state.claim.refs !== digest)
      fail('REFERENCES_CHANGED');
    state.claim.refs = digest;
  }
  function check() {
    owner();
    if (fileHash(path.join(p.installRoot, 'active.json')) !== p.pointerSha256)
      fail('CURRENT_POINTER_CHANGED');
    for (const root of p.roots)
      if (
        canonical(root.path) !== root.path ||
        hash(identity(root.path)) !== hash(root.identity)
      )
        fail('ROOT_IDENTITY');
    for (const item of plan.packages.values()) {
      const receipt = plan.verifier.scan([
        { path: item.spec.path, identity: item.spec.identity },
      ]);
      if (
        receipt.digest !== item.scan.digest ||
        receipt.metadataDigest !== item.scan.metadataDigest
      )
        fail('PROTECTED_PACKAGE_CHANGED');
    }
    query();
    const copied = state.slots.reduce(
      (sum, slot) =>
        sum +
        (slot.copied || slot.complete
          ? pair.find((item) => item.id === slot.id).pkg.physical
          : 0),
      0,
    );
    for (const outputRoot of [p.installRoot, p.registryDirectory]) {
      const disk = fs.statfsSync(outputRoot, { bigint: true });
      if (
        disk.bavail * disk.bsize <
        BigInt(
          LIMITS.free +
            (outputRoot === p.installRoot ? LIMITS.copy - copied : 0) +
            LIMITS.metadata,
        )
      )
        fail('PHYSICAL_RESERVE');
    }
    if (metadataUsed() > LIMITS.metadata) fail('METADATA_LIMIT');
  }
  function assertWritable(kinds) {
    owner();
    if (closed) fail('CLOSED');
    if (!Array.isArray(kinds) || !kinds.includes('install'))
      fail('INSTALL_ONLY');
  }
  function authorizedFs(method, args) {
    assertWritable(['install']);
    if (method.startsWith('process.')) fail('PROCESS_DENIED');
    if (!method.endsWith('Sync')) fail('UNREVIEWED_FILE_API');
    if (method === 'symlinkSync') {
      const link = path.resolve(args[1]);
      const slot = state.slots.find(
        (row) => row.identity && !row.complete && contains(row.path, link),
      );
      const item = slot && pair.find((row) => row.id === slot.id);
      const relative =
        slot && path.relative(slot.path, link).split(path.sep).join('/');
      if (
        item?.pkg.manifest.links?.[relative] &&
        path.resolve(args[0]) ===
          path.resolve(slot.path, item.pkg.manifest.links[relative]) &&
        hash(identity(slot.path)) === hash(slot.identity) &&
        canonical(path.dirname(link)) === path.dirname(link) &&
        canonical(args[0]) === path.resolve(args[0])
      )
        return;
      fail('OUTPUT_CAPABILITY');
    }
    const at =
      typeof args[0] === 'number'
        ? descriptors.get(args[0])
        : typeof args[0] === 'string'
          ? path.resolve(args[0])
          : undefined;
    if (!at) fail('UNREGISTERED_DESCRIPTOR');
    if (
      ['openSync', 'writeFileSync', 'fsyncSync', 'unlinkSync'].includes(
        method,
      ) &&
      metadataPath(at)
    ) {
      const existing = present(at);
      if (existing && (!existing.isFile() || existing.isSymbolicLink()))
        fail('METADATA_ALIAS');
      if (method === 'openSync' && (args[1] !== 'wx' || existing))
        fail('METADATA_EXCLUSIVE_CREATE');
      if (
        method === 'writeFileSync' &&
        typeof args[0] !== 'number' &&
        (args[2]?.flag !== 'wx' || existing)
      )
        fail('METADATA_EXCLUSIVE_CREATE');
      if (
        ['fsyncSync', 'unlinkSync'].includes(method) &&
        !ownedMetadata.has(at)
      )
        fail('FOREIGN_METADATA');
      if (method === 'writeFileSync') {
        const data = args[1];
        const length = Buffer.isBuffer(data)
          ? data.length
          : Buffer.byteLength(String(data));
        if (
          metadataUsed() +
            Math.ceil(length / plan.metadataBlock) * plan.metadataBlock >
          LIMITS.metadata
        )
          fail('METADATA_LIMIT');
        if (path.basename(at).startsWith('.release-lifecycle.json')) {
          const envelope = JSON.parse(String(data)),
            value = envelope.payload;
          const expectedIds = [
            p.currentId,
            ...pair.map((item) => item.id),
          ].sort();
          if (
            !value ||
            envelope.digest !== hash(value) ||
            hash([...value.managedIds].sort()) !== hash(expectedIds) ||
            hash([...value.legacyIds].sort()) !==
              hash([...p.legacyIds].sort()) ||
            value.roles.current !== p.currentId ||
            pair.some((item) => value.roles[item.role] !== item.id)
          )
            fail('LIFECYCLE_PLAN_CHANGED');
        }
      }
      if (method === 'writeFileSync' || method === 'openSync')
        ownedMetadata.add(at);
      return;
    }
    if (
      method === 'renameSync' &&
      ownedMetadata.has(at) &&
      metadataPath(at) &&
      args[1] === path.join(p.installRoot, '.release-lifecycle.json')
    )
      return;
    const slot = state.slots.find(
      (row) => at === row.path || contains(row.path, at),
    );
    const item = slot && pair.find((row) => row.id === slot.id);
    if (
      slot &&
      slot.started &&
      !slot.complete &&
      method === 'mkdirSync' &&
      (at === slot.path ||
        item.pkg.directories.has(path.relative(slot.path, at)))
    ) {
      if (
        present(at) &&
        (!fs.lstatSync(at).isDirectory() ||
          fs.lstatSync(at).isSymbolicLink() ||
          canonical(at) !== at)
      )
        fail('TARGET_ALIAS');
      if (slot.identity && hash(identity(slot.path)) !== hash(slot.identity))
        fail('TARGET_IDENTITY');
      return;
    }
    fail('OUTPUT_CAPABILITY');
  }
  const lease = {
    legacyLimit: 129,
    policy: p,
    assertWritable,
    assertHostEffect: authorizedFs,
    noteDescriptor(fd, file) {
      descriptors.set(fd, path.resolve(file));
    },
    forgetDescriptor(fd) {
      descriptors.delete(fd);
    },
    assertOperation() {
      fail('NESTED_ADMISSION');
    },
    check,
    registerOutput(output) {
      assertWritable(['install']);
      check();
      const slot = state.slots.find((row) => row.path === path.resolve(output));
      if (!slot || slot.started || present(slot.path))
        fail('TARGET_ALREADY_PRESENT_OR_SPENT');
      slot.started = true;
      state.claim.outputs.push(slot.path);
      state.outputs.push({
        path: slot.path,
        claim: state.claim.id,
        complete: false,
      });
      save();
      allocatedThisCall++;
    },
    createdOutput(output) {
      assertWritable(['install']);
      const slot = state.slots.find((row) => row.path === path.resolve(output));
      if (!slot || !slot.started || slot.identity) fail('TARGET_IDENTITY');
      slot.identity = identity(slot.path);
      save();
    },
    copyPackage(source, target) {
      assertWritable(['install']);
      check();
      const item = pair.find(
          (row) => row.source === source && row.target === target,
        ),
        slot = item && state.slots.find((row) => row.id === item.id);
      if (
        !slot?.identity ||
        slot.complete ||
        hash(identity(target)) !== hash(slot.identity)
      )
        fail('COPY_BINDING');
      const buffer = Buffer.alloc(64 * 1024);
      for (const [relative, spec] of Object.entries(item.pkg.files)) {
        owner();
        if (hash(identity(target)) !== hash(slot.identity))
          fail('TARGET_IDENTITY');
        const from = path.resolve(source, relative),
          to = path.resolve(target, relative);
        let directory = target;
        for (const component of path
          .relative(target, path.dirname(to))
          .split(path.sep)
          .filter(Boolean)) {
          directory = path.join(directory, component);
          if (!present(directory)) fs.mkdirSync(directory);
          const stat = fs.lstatSync(directory);
          if (
            !stat.isDirectory() ||
            stat.isSymbolicLink() ||
            canonical(directory) !== directory
          )
            fail('TARGET_ALIAS');
        }
        if (!contains(target, canonical(path.dirname(to))))
          fail('TARGET_ALIAS');
        const input = fs.openSync(from, 'r'),
          digest = crypto.createHash('sha256');
        let output;
        try {
          output = fs.openSync(to, 'wx');
          const before = fs.fstatSync(input, { bigint: true });
          if (
            hash(
              [
                before.dev,
                before.ino,
                before.birthtimeNs,
                before.ctimeNs,
                before.mtimeNs,
              ].map(String),
            ) !== hash(spec.identity) ||
            Number(before.size) !== spec.bytes
          )
            fail('COPY_SOURCE_CHANGED');
          let remaining = spec.bytes;
          while (remaining) {
            const count = fs.readSync(
              input,
              buffer,
              0,
              Math.min(remaining, buffer.length),
              null,
            );
            if (!count) fail('COPY_SOURCE_TRUNCATED');
            digest.update(buffer.subarray(0, count));
            let written = 0;
            while (written < count)
              written += fs.writeSync(output, buffer, written, count - written);
            remaining -= count;
          }
          if (
            fs.readSync(input, buffer, 0, 1, null) ||
            digest.digest('hex') !== spec.sha256
          )
            fail('COPY_SOURCE_HASH');
          const after = fs.fstatSync(input, { bigint: true });
          if (
            hash(
              [
                after.dev,
                after.ino,
                after.birthtimeNs,
                after.ctimeNs,
                after.mtimeNs,
              ].map(String),
            ) !== hash(spec.identity)
          )
            fail('COPY_SOURCE_CHANGED');
        } finally {
          if (output !== undefined) fs.closeSync(output);
          fs.closeSync(input);
        }
      }
      slot.copied = true;
      save();
    },
    allowCleanup() {
      fail('FAILED_OUTPUTS_HELD');
    },
    close(error) {
      if (closed) return;
      closed = true;
      try {
        owner();
        if (error) {
          if (state.slots.some((row) => row.started && !row.complete)) {
            save();
            fail('INTERRUPTED_OUTPUT_HELD');
          }
          state.claim = null;
          save();
          return;
        }
        check();
        for (const slot of state.slots) {
          const item = pair.find((row) => row.id === slot.id);
          const m = verifyRelease(slot.path);
          if (
            fileHash(path.join(slot.path, 'release.json')) !==
              item.pkg.spec.manifestSha256 ||
            m.id !== item.id ||
            hash(identity(slot.path)) !== hash(slot.identity)
          )
            fail('FINAL_OUTPUT_PROOF');
          slot.complete = true;
          const output = state.outputs.find((row) => row.path === slot.path);
          output.complete = true;
          output.identity = slot.identity;
        }
        state.claim = null;
        state.complete = true;
        if (state.continuationAttempt?.nonce === nonce) {
          state.continuationAttempt.status = 'installed';
          state.continuationAttempt.finishedAtUtc = new Date().toISOString();
        }
        save();
        lastReceipt = {
          installedIds: state.slots.map((row) => row.id),
          protectedIds: p.protectedPackages.map((row) => row.id),
          maxAdditionalBytes: LIMITS.bytes,
          newRuntimeCopies: allocatedThisCall,
          historicalDeletionPerformed: false,
          publicationAuthorized: false,
        };
      } finally {
        owner();
        fs.unlinkSync(lock);
      }
    },
    receipt() {
      return lastReceipt;
    },
  };
  // Capacity is checked before even the first control-file allocation.
  for (const outputRoot of [p.installRoot, p.registryDirectory]) {
    const disk = fs.statfsSync(outputRoot, { bigint: true });
    if (
      disk.bavail * disk.bsize <
      BigInt(
        LIMITS.free +
          (outputRoot === p.installRoot ? LIMITS.copy : 0) +
          LIMITS.metadata,
      )
    )
      fail('PHYSICAL_RESERVE');
  }
  fs.writeFileSync(lock, token, { flag: 'wx', mode: 0o600 });
  lockIdentity = fileIdentity(lock);
  try {
    if (present(ledger)) {
      const envelope = read(ledger);
      state = envelope.payload;
      if (
        !state ||
        envelope.digest !== hash(state) ||
        state.once !== MODE ||
        state.claim ||
        state.slots?.length !== 2
      )
        fail('INTERRUPTED_OR_FOREIGN_LEDGER');
      let continued = false;
      if (state.configSha !== expected && p.preCopyContinuation) {
        const { c } = continuationPolicy(p, expected),
          receipt = continuationPath(p);
        if (present(receipt)) fail('CONTINUATION_ALREADY_CONSUMED');
        const previousLedgerText = pinnedDocument(
            c.previousLedger,
            ledger,
            true,
          ),
          sourceEnvelope = JSON.parse(previousLedgerText);
        if (
          sourceEnvelope.digest !== hash(sourceEnvelope.payload) ||
          hash(state) !== hash(sourceEnvelope.payload)
        )
          fail('CONTINUATION_SOURCE_CHANGED');
        const oldSentinel = pinnedDocument(c.previousSentinel, sentinel, true);
        if (
          oldSentinel !== c.previousPolicy.sha256 ||
          state.configSha !== c.previousPolicy.sha256
        )
          fail('CONTINUATION_SOURCE_CONFIG');
        preCopyState(state, p, c.previousPolicy.sha256);
        if (
          pair.some((item) => present(item.target)) ||
          (p.publication && present(p.publication.auditRoot)) ||
          fs
            .readdirSync(p.registryDirectory)
            .some(
              (name) =>
                name.startsWith(p.scopeId + '.state.json.') &&
                name !== path.basename(sentinel),
            )
        )
          fail('CONTINUATION_TARGET_OR_CONTROL_EXISTS');
        if (
          p.publication &&
          (canonical(p.publication.database) !== p.publication.database ||
            hash(fileIdentity(p.publication.database)) !==
              hash(p.publication.databaseIdentity))
        )
          fail('CONTINUATION_DATABASE_CHANGED');
        if (
          fileHash(path.join(p.installRoot, 'active.json')) !== p.pointerSha256
        )
          fail('CONTINUATION_POINTER_CHANGED');
        ledgerIdentity = c.previousLedger.identity;
        ledgerSha = c.previousLedger.sha256;
        sentinelIdentity = fileIdentity(sentinel);
        sentinelConfigSha = oldSentinel;
        const receiptValue = {
          format: 1,
          kind: continuationKind,
          id: c.id,
          fromConfigSha: c.previousPolicy.sha256,
          toConfigSha: expected,
          approvalId: p.approval.id,
          previousPolicy: c.previousPolicy,
          previousLedger: c.previousLedger,
          previousSentinel: c.previousSentinel,
          previousOutcome: c.previousOutcome,
          previousLedgerText,
          previousSentinelText: oldSentinel,
          createdAtUtc: new Date().toISOString(),
          priorFailedAttempts: 1,
          priorFailedAttemptCountComplete: false,
        };
        const text = JSON.stringify(receiptValue);
        if (
          Buffer.byteLength(text) > 65536 ||
          metadataUsed() +
            Math.ceil(Buffer.byteLength(text) / plan.metadataBlock) *
              plan.metadataBlock +
            plan.metadataBlock >
            LIMITS.metadata
        )
          fail('METADATA_LIMIT');
        owner();
        continuationStarted = true;
        const fd = fs.openSync(receipt, 'wx', 0o600);
        try {
          fs.writeFileSync(fd, text);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        const receiptPin = {
          path: receipt,
          sha256: crypto.createHash('sha256').update(text).digest('hex'),
          identity: fileIdentity(receipt),
        };
        if (fileHash(receipt) !== receiptPin.sha256)
          fail('CONTINUATION_RECEIPT_CHANGED');
        continuationAuthority = {
          sentinelConfigSha: oldSentinel,
          files: [
            receiptPin,
            c.previousPolicy,
            c.previousOutcome,
            c.previousSentinel,
          ],
        };
        owner();
        state.configSha = expected;
        state.continuation = {
          id: c.id,
          receiptSha256: receiptPin.sha256,
          receiptIdentity: receiptPin.identity,
        };
        state.continuationAttempt = {
          nonce,
          startedAtUtc: new Date().toISOString(),
          status: 'running',
          priorFailedAttempts: 1,
          priorFailedAttemptCountComplete: false,
        };
        save();
        continuationCommitted = true;
        continued = true;
      }
      if (state.configSha !== expected) fail('INTERRUPTED_OR_FOREIGN_LEDGER');
      if (!continued && state.continuation) {
        continuationAuthority = validateContinuation(p, state, expected);
        sentinelConfigSha = continuationAuthority.sentinelConfigSha;
        if (!state.complete) fail('CONTINUATION_ALREADY_CONSUMED');
      }
      if (
        !continued &&
        (!state.complete ||
          state.outputs?.length !== 2 ||
          pair.some(
            (item) =>
              !state.slots.some(
                (slot) =>
                  slot.id === item.id &&
                  slot.path === item.target &&
                  slot.complete &&
                  hash(identity(slot.path)) === hash(slot.identity),
              ),
          ) ||
          state.slots.some(
            (slot) =>
              !pair.some(
                (item) => item.id === slot.id && item.target === slot.path,
              ),
          ) ||
          !present(sentinel) ||
          fs.readFileSync(sentinel, 'utf8') !== sentinelConfigSha)
      )
        fail('INVALID_COMPLETED_LEDGER');
      ledgerIdentity = fileIdentity(ledger);
      ledgerSha = fileHash(ledger);
      sentinelIdentity = fileIdentity(sentinel);
    } else {
      if (p.preCopyContinuation) fail('CONTINUATION_SOURCE_MISSING');
      if (
        present(sentinel) ||
        fs
          .readdirSync(p.registryDirectory)
          .some(
            (name) =>
              name.startsWith(p.scopeId + '.state.json.') &&
              name.endsWith('.tmp'),
          ) ||
        pair.some((item) => present(item.target))
      )
        fail('ADOPTION_REQUIRES_REVIEW');
      state = {
        format: 1,
        once: MODE,
        configSha: expected,
        outputs: [],
        claim: null,
        slots: pair.map((item) => ({
          id: item.id,
          path: item.target,
          started: false,
          complete: false,
          identity: null,
        })),
      };
      save();
      fs.writeFileSync(sentinel, expected, { flag: 'wx', mode: 0o600 });
      sentinelIdentity = fileIdentity(sentinel);
    }
    state.claim = {
      id: crypto.randomUUID(),
      kind: 'install',
      root: p.installRoot,
      reserveBytes: LIMITS.bytes,
      runtimeCopies: state.complete ? 0 : 2,
      outputs: [],
      refs: null,
    };
    save();
    check();
    return hostEffects.context.run(lease, () => {
      try {
        const result = action(lease, plan);
        if (result?.then) fail('SYNCHRONOUS_INSTALL_ONLY');
        lease.close();
        return { ...result, admission: lease.receipt() };
      } catch (error) {
        lease.close(error);
        throw error;
      }
    });
  } catch (error) {
    // A failed/uncertain consumption write cannot be retried with a new ID.
    // Keep the current exclusive lock and any partial fixed receipt as evidence.
    if (continuationStarted && !continuationCommitted) throw error;
    let stillOwned = false;
    try {
      owner();
      stillOwned = true;
    } catch {
      /* Preserve foreign/uncertain authority, including the lock. */
    }
    if (stillOwned) {
      const diagnosticApi = require('./windows-release-references.cjs');
      const privateDiagnostic = diagnosticApi.privateReferenceDiagnostic(
        error.privateReferenceDiagnostic,
      );
      if (privateDiagnostic) {
        state.referenceFailures ||= [];
        state.referenceFailures.push({
          nonce,
          operation: 'install',
          atUtc: new Date().toISOString(),
          diagnostic: diagnosticApi.referenceDiagnostic(
            error.referenceDiagnostic,
          ),
          privateDiagnostic,
        });
        try {
          save();
          error.referenceDiagnostic = diagnosticApi.referenceDiagnostic({
            ...error.referenceDiagnostic,
            diagnosticStored: true,
          });
        } catch {
          // Preserve the original refusal and lock if evidence cannot be saved.
          error.referenceDiagnostic = diagnosticApi.referenceDiagnostic({
            ...error.referenceDiagnostic,
            diagnosticStored: false,
          });
          throw error;
        }
      }
      if (state?.continuationAttempt?.nonce === nonce) {
        state.continuationAttempt.status = 'held';
        state.continuationAttempt.finishedAtUtc = new Date().toISOString();
        state.continuationAttempt.error =
          require('./windows-release-references.cjs').referenceDiagnostic({
            stage: 'admission',
            codes: [error.message],
            ...error.referenceDiagnostic,
          });
        save();
      }
      if (
        state?.claim &&
        !state.slots.some((row) => row.started && !row.complete)
      ) {
        state.claim = null;
        save();
      }
      fs.unlinkSync(lock);
    }
    throw error;
  }
}
function main(argv) {
  if (
    ![2, 3].includes(argv.length) ||
    !['--review', '--apply', '--deploy', '--rollback'].includes(argv[0]) ||
    (argv[0] === '--review' && argv.length !== 3)
  )
    fail('USAGE');
  if (argv[0] === '--review') {
    const result = checkPlan(argv[1], argv[2]);
    const publication = result.p.publication
      ? require('./once-pair-publication.cjs').validate(result.p)
      : null;
    return {
      admission: false,
      registryWritten: false,
      referencesQueried: false,
      currentId: result.p.currentId,
      heldId: result.p.heldId,
      targets: result.p.pair,
      limits: LIMITS,
      ...(publication ? { publicationLimits: publication.limits } : {}),
    };
  }
  // The two-argument form avoids a self-referential digest in the policy's
  // exact launcher argv pin. This is process-local input, never machine config.
  const expected = argv[2] || process.env.WEWE_ONCE_PAIR_SHA256;
  if (['--deploy', '--rollback'].includes(argv[0]))
    return require('./once-pair-publication.cjs').execute(argv[1], expected, {
      rollback: argv[0] === '--rollback',
    });
  return withAdmission(argv[1], expected, (lease, result) => {
    const candidate = result.pair.find((row) => row.role === 'candidate'),
      rollback = result.pair.find((row) => row.role === 'rollback');
    return require('./install-lifecycle.cjs').installPair(
      result.p.installRoot,
      {
        current: result.p.currentId,
        candidate: candidate.source,
        rollback: rollback.source,
        proofs: Object.fromEntries(
          ['current', 'candidate', 'rollback'].map((role) => {
            const spec =
              role === 'current'
                ? result.p.protectedPackages.find(
                    (row) => row.id === result.p.currentId,
                  )
                : result.pair.find((row) => row.role === role).pkg.spec;
            return [
              role,
              {
                sourceCommit: spec.sourceCommit,
                manifestSha256: spec.manifestSha256,
              },
            ];
          }),
        ),
      },
      { scope: lease, adoptLegacy: result.p.legacyIds },
    );
  });
}
function formatCliError(error) {
  const code =
    /^(REFERENCE|RELEASE_SCOPE|ONCE_PAIR|ONCE_PUBLICATION)_[A-Z_]+$/.test(
      error.message,
    )
      ? error.message
      : 'ONCE_PAIR_FAILED';
  return (
    code +
    '\n' +
    (error.referenceDiagnostic
      ? 'REFERENCE_DIAGNOSTIC ' +
        JSON.stringify(
          require('./windows-release-references.cjs').referenceDiagnostic(
            error.referenceDiagnostic,
          ),
        ) +
        '\n'
      : '')
  );
}
module.exports = {
  LIMITS,
  MODE,
  codePins,
  checkPlan,
  withAdmission,
  main,
  formatCliError,
  validateContinuation,
  continuationPath,
};
if (require.main === module) {
  Promise.resolve()
    .then(() => main(process.argv.slice(2)))
    .then((result) => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch((error) => {
      process.stderr.write(formatCliError(error));
      process.exitCode = 1;
    });
}
