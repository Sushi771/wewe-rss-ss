// One fixed maintenance run; only the verified installed-pair pre-stop checkpoint
// can transfer once. No general resume, cleanup or credit reset.
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const cp = require('node:child_process');
const once = require('./once-pair-admission.cjs');
const publication = require('./once-pair-publication.cjs');
const { fileHash, verifyRelease, hostEffects } = require('./lib.cjs');
const KIND = 'fixed-once-maintenance-v1';
const RECOVERY = '0b5892ec8036553daaf8989e70990b1e464c62b1';
const CANDIDATE = '0ac65de954ab0ba0be5f1174d2307c28ddaf2440';
const SOURCE_PROTOCOL =
  'c07af55b3cf3b24a6b0361e968aca315c1567b55185f55828766b0fa27994579';
const hash = (value) =>
  crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code) => {
  throw Error('FIXED_MAINTENANCE_' + code);
};
const present = (at) => {
  try {
    return fs.lstatSync(at);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
};
const canonical = (at) => fs.realpathSync.native(at);
const identity = (at) => {
  const s = fs.lstatSync(at, { bigint: true });
  if (s.isSymbolicLink() || s.nlink !== 1n) fail('ALIAS');
  return [s.dev, s.ino, s.birthtimeNs].map(String);
};
const directoryIdentity = (at) => {
  const s = fs.lstatSync(at, { bigint: true });
  if (!s.isDirectory() || s.isSymbolicLink() || canonical(at) !== at)
    fail('DIRECTORY');
  return [s.dev, s.ino, s.birthtimeNs].map(String);
};
const pinAt = (at) => ({
  path: at,
  sha256: fileHash(at),
  identity: identity(at),
});
const recordPath = (p) =>
  path.join(p.registryDirectory, p.scopeId + '.maintenance.json');
const lockPath = (p) => path.join(p.registryDirectory, p.scopeId + '.lock');
const preStopPath = (p) => recordPath(p) + '.pre-stop.json';
const toolPins = () => ({
  ...once.codePins(),
  'fixed-maintenance.cjs': fileHash(__filename),
});
function oldToolEvidence(c, old) {
  const pins = old.maintenance?.toolPins;
  if (
    !pins ||
    !c.tools ||
    Object.keys(c.tools).sort().join('|') !==
      Object.keys(toolPins()).sort().join('|')
  )
    fail('PRE_STOP_OLD_TOOL');
  let directory;
  for (const [name, spec] of Object.entries(c.tools)) {
    if (
      !spec ||
      spec.sha256 !== pins[name] ||
      path.basename(spec.path || '') !== name
    )
      fail('PRE_STOP_OLD_TOOL');
    const parent = path.dirname(spec.path);
    if (directory && parent !== directory) fail('PRE_STOP_OLD_TOOL');
    directory = parent;
    once.pinnedDocument(spec, path.join(directory, name), true);
  }
}
function projection(p) {
  const q = structuredClone(p);
  delete q.maintenance;
  delete q.codePins;
  delete q.probe;
  if (q.windowsReferences) {
    delete q.windowsReferences.collectorSha256;
    delete q.windowsReferences.collectorIdentitySha256;
    if (q.windowsReferences.operationCoverage?.processCoverage)
      delete q.windowsReferences.operationCoverage.processCoverage
        .backgroundGaps;
  }
  return q;
}
function bindings(p, expected, requireApproval = false) {
  const m = p.maintenance;
  if (
    !m ||
    m.format !== 1 ||
    m.kind !== KIND ||
    canonical(m.planPath) !== m.planPath ||
    fileHash(m.planPath) !== expected ||
    Object.keys(m)
      .filter((k) => k !== 'continueBeforeStop')
      .sort()
      .join('|') !==
      [
        'approval',
        'format',
        'kind',
        'planPath',
        'sourceFiles',
        'sourcePolicy',
        'toolPins',
      ].join('|') ||
    hash(m.toolPins) !== hash(toolPins()) ||
    !m.approval ||
    !m.approval.id ||
    (Object.hasOwn(m, 'continueBeforeStop') &&
      (!m.continueBeforeStop || typeof m.continueBeforeStop !== 'object')) ||
    (requireApproval && m.approval.confirmed !== true)
  )
    fail('PLAN_BINDING');
  for (const [name, digest] of Object.entries(m.toolPins)) {
    const at = path.join(__dirname, name);
    if (
      canonical(at) !== at ||
      fs.lstatSync(at).nlink !== 1 ||
      fileHash(at) !== digest
    )
      fail('TOOL_PIN');
  }
  const old = JSON.parse(once.pinnedDocument(m.sourcePolicy, undefined, true));
  if (
    old.maintenance ||
    old.scopeId !== p.scopeId ||
    old.approval?.confirmed !== true ||
    hash(projection(old)) !== hash(projection(p))
  )
    fail('SOURCE_POLICY');
  const protocol = hash(Object.entries(old.codePins || {}));
  if (
    protocol !== SOURCE_PROTOCOL &&
    protocol !== hash(Object.entries(once.codePins()))
  )
    fail('SOURCE_PROTOCOL');
  if (
    Object.keys(old.codePins || {})
      .sort()
      .join('|') !== Object.keys(once.codePins()).sort().join('|')
  )
    fail('SOURCE_PROTOCOL');
  for (const [name, digest] of Object.entries(old.codePins))
    if (fileHash(path.join(path.dirname(old.probe.path), name)) !== digest)
      fail('SOURCE_TOOL_CHANGED');
  const prefix = path.join(p.registryDirectory, p.scopeId + '.state.json');
  if (
    Object.keys(m.sourceFiles || {})
      .sort()
      .join('|') !== 'adopted|continuation|ledger'
  )
    fail('SOURCE_FILES');
  const oldText = once.pinnedDocument(m.sourceFiles.ledger, prefix, true),
    envelope = JSON.parse(oldText),
    s = envelope.payload;
  once.pinnedDocument(m.sourceFiles.adopted, prefix + '.adopted', true);
  once.pinnedDocument(
    m.sourceFiles.continuation,
    prefix + '.continuation.json',
    true,
  );
  if (
    !s ||
    hash(s) !== envelope.digest ||
    s.format !== 1 ||
    s.once !== once.MODE ||
    s.configSha !== m.sourcePolicy.sha256 ||
    Object.keys(s).some(
      (k) =>
        ![
          'format',
          'once',
          'configSha',
          'outputs',
          'claim',
          'slots',
          'complete',
          'continuation',
          'continuationAttempt',
        ].includes(k),
    ) ||
    s.claim !== null ||
    !Array.isArray(s.outputs) ||
    s.outputs.length ||
    (s.complete !== undefined && s.complete !== false) ||
    !Array.isArray(s.slots) ||
    s.slots.length !== 2 ||
    new Set(s.slots.map((x) => x.id)).size !== 2 ||
    s.slots.some(
      (x) =>
        Object.keys(x).some(
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
        x.started !== false ||
        x.complete !== false ||
        x.identity !== null ||
        (x.copied !== undefined && x.copied !== false) ||
        !p.pair.some((t) => t.id === x.id && t.target === x.path),
    ) ||
    s.continuationAttempt?.status !== 'held' ||
    Object.keys(s.continuationAttempt).sort().join('|') !==
      [
        'error',
        'finishedAtUtc',
        'nonce',
        'priorFailedAttemptCountComplete',
        'priorFailedAttempts',
        'startedAtUtc',
        'status',
      ].join('|') ||
    typeof s.continuationAttempt.nonce !== 'string' ||
    !s.continuationAttempt.nonce ||
    !Number.isFinite(Date.parse(s.continuationAttempt.startedAtUtc)) ||
    !Number.isFinite(Date.parse(s.continuationAttempt.finishedAtUtc)) ||
    s.continuationAttempt.priorFailedAttempts !== 1 ||
    s.continuationAttempt.priorFailedAttemptCountComplete !== false
  )
    fail('SOURCE_NOT_UNUSED_HELD');
  once.validateContinuation(old, s, m.sourcePolicy.sha256);
  for (const role of ['candidate', 'rollback']) {
    const item = p.pair.find((x) => x.role === role),
      spec = p.protectedPackages.find((x) => x.id === item.id);
    if (spec.sourceCommit !== (role === 'candidate' ? CANDIDATE : RECOVERY))
      fail('FIXED_PACKAGE');
  }
  if (m.continueBeforeStop)
    oldToolEvidence(
      m.continueBeforeStop,
      JSON.parse(
        once.pinnedDocument(m.continueBeforeStop.plan, undefined, true),
      ),
    );
  return { old, source: s };
}
function validateOwner(p, expected, lock, record, callerPid, terminal = false) {
  bindings(p, expected, true);
  if (
    lock.kind !== KIND ||
    lock.pid !== callerPid ||
    !Number.isInteger(callerPid) ||
    !lock.nonce ||
    lock.configSha !== expected ||
    !lock.recordPin ||
    lock.recordPin.path !== recordPath(p)
  )
    fail('OWNER');
  const envelope = JSON.parse(
    once.pinnedDocument(lock.recordPin, recordPath(p), true),
  );
  if (
    hash(envelope.payload) !== envelope.digest ||
    hash(envelope.payload) !== hash(record) ||
    record.kind !== KIND ||
    record.configSha !== expected ||
    record.sourceSha !== hash(p.maintenance.sourceFiles) ||
    record.pid !== callerPid ||
    record.nonce !== lock.nonce ||
    !(
      terminal
        ? ['running', 'recovering', 'passed', 'recovered', 'hold']
        : ['running', 'recovering']
    ).includes(record.status) ||
    (record.claim === null
      ? !terminal
      : record.claim?.kind !== 'maintenance' ||
        record.claim.id !== lock.nonce) ||
    [
      'backupSpent',
      'migrationAttempted',
      'recoverySpent',
      'publicationSpent',
      'stopAttempted',
    ].some((k) => typeof record[k] !== 'boolean') ||
    record.format !== 1 ||
    Object.keys(record).some(
      (k) =>
        ![
          'format',
          'kind',
          'configSha',
          'sourceSha',
          'pid',
          'nonce',
          'status',
          'stage',
          'backupSpent',
          'migrationAttempted',
          'recoverySpent',
          'publicationSpent',
          'stopAttempted',
          'slots',
          'outputs',
          'claim',
          'service',
          'pointer',
          'auditIdentity',
          'history',
          'health',
          'backup',
          'baseline',
          'migrationResult',
          'error',
          'preStopContinuation',
        ].includes(k),
    ) ||
    !Array.isArray(record.slots) ||
    record.slots.length !== 2 ||
    new Set(record.slots.map((s) => s.id)).size !== 2 ||
    !Array.isArray(record.outputs) ||
    record.slots.some(
      (s) =>
        !p.pair.some((t) => s.id === t.id && s.path === t.target) ||
        typeof s.started !== 'boolean' ||
        typeof s.complete !== 'boolean' ||
        (s.complete && !s.started),
    ) ||
    record.outputs.some(
      (o) =>
        ![...p.pair.map((t) => t.target), p.publication.auditRoot].includes(
          o.path,
        ) || o.claim !== lock.nonce,
    ) ||
    (record.service && !validService(p, record))
  )
    fail('RECORD_OWNER');
  if (p.maintenance.continueBeforeStop) {
    const receipt = JSON.parse(
      once.pinnedDocument(record.preStopContinuation, preStopPath(p), true),
    );
    const c = p.maintenance.continueBeforeStop;
    const prior = JSON.parse(receipt.recordText).payload;
    if (
      receipt.kind !== 'installed-pair-pre-stop-v1' ||
      receipt.configSha !== expected ||
      receipt.pid !== callerPid ||
      receipt.nonce !== lock.nonce ||
      receipt.exited?.format !== 1 ||
      receipt.exited.pid !== c.controller.pid ||
      receipt.exited.exited !== true ||
      receipt.exited.observation !== 'current-pid-absence-only' ||
      record.history.length < prior.history.length + 1 ||
      hash(record.history.slice(0, prior.history.length)) !==
        hash(prior.history) ||
      record.history[prior.history.length]?.stage !== 'pre-stop-continuation' ||
      hash(receipt.previous) !== hash(c) ||
      crypto.createHash('sha256').update(receipt.recordText).digest('hex') !==
        c.record.sha256 ||
      crypto.createHash('sha256').update(receipt.lockText).digest('hex') !==
        c.lock.sha256
    )
      fail('PRE_STOP_RECEIPT');
  } else if (record.preStopContinuation) fail('PRE_STOP_RECEIPT');
  return record;
}

// One checkpoint, using the same record and remaining allowance. The fixed
// receipt consumes transfer before replacing authority; any partial install holds.
function preStopSource(plan) {
  const { p, pair } = plan,
    c = p.maintenance.continueBeforeStop;
  if (
    !c ||
    Object.keys(c).sort().join('|') !== 'controller|lock|plan|record|tools' ||
    present(preStopPath(p))
  )
    fail('PRE_STOP_SOURCE');
  const planText = once.pinnedDocument(c.plan, undefined, true),
    old = JSON.parse(planText),
    recordText = once.pinnedDocument(c.record, recordPath(p), true),
    envelope = JSON.parse(recordText),
    lockText = once.pinnedDocument(c.lock, lockPath(p), true),
    lock = JSON.parse(lockText),
    r = envelope.payload;
  const normalized = (value) => {
    const q = structuredClone(value);
    delete q.codePins;
    delete q.probe;
    delete q.windowsReferences.collectorSha256;
    delete q.windowsReferences.collectorIdentitySha256;
    delete q.maintenance.toolPins;
    delete q.maintenance.planPath;
    delete q.maintenance.approval;
    delete q.maintenance.continueBeforeStop;
    return q;
  };
  const vector = (pins) =>
    hash(Object.entries(pins).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  if (
    !old.maintenance ||
    old.maintenance.continueBeforeStop ||
    old.maintenance.approval?.confirmed !== true ||
    old.maintenance.planPath !== c.plan.path ||
    hash(normalized(old)) !== hash(normalized(p)) ||
    ![
      'eb47168a408dcff98f07579e12a708f5a20d68f14a307a8d4109a13336866fc4',
      '14074b5b389c07f69fbbd8ada8083a629c5efd1982d59d2d8e5abf8a261cae93',
      vector(toolPins()),
    ].includes(vector(old.maintenance.toolPins)) ||
    Object.keys(old.maintenance.toolPins).sort().join('|') !==
      Object.keys(toolPins()).sort().join('|') ||
    hash(old.codePins) !==
      hash(
        Object.fromEntries(
          Object.entries(old.maintenance.toolPins).filter(
            ([k]) => k !== 'fixed-maintenance.cjs',
          ),
        ),
      ) ||
    old.probe.sha256 !== old.codePins['windows-release-references.cjs']
  )
    fail('PRE_STOP_PLAN');
  oldToolEvidence(c, old);
  const controller = c.controller;
  if (
    !controller ||
    Object.keys(controller).sort().join('|') !== 'historicalIdentity|pid' ||
    !Number.isInteger(controller.pid) ||
    controller.pid <= 0 ||
    controller.pid === process.pid ||
    controller.historicalIdentity !== 'not-recorded'
  )
    fail('PRE_STOP_CONTROLLER');
  if (
    !r ||
    envelope.digest !== hash(r) ||
    r.format !== 1 ||
    r.kind !== KIND ||
    r.configSha !== c.plan.sha256 ||
    r.sourceSha !== hash(p.maintenance.sourceFiles) ||
    r.pid !== controller.pid ||
    r.nonce !== lock.nonce ||
    !r.nonce ||
    lock.kind !== KIND ||
    lock.pid !== r.pid ||
    lock.configSha !== c.plan.sha256 ||
    hash(lock.recordPin) !== hash(c.record) ||
    Object.keys(lock).sort().join('|') !==
      'configSha|kind|nonce|pid|recordPin' ||
    r.status !== 'hold' ||
    r.stage !== 'hold' ||
    r.preStopContinuation ||
    [
      'stopAttempted',
      'backupSpent',
      'migrationAttempted',
      'recoverySpent',
      'publicationSpent',
    ].some((k) => r[k] !== false) ||
    r.service !== null ||
    r.auditIdentity !== null ||
    ['backup', 'baseline', 'migrationResult', 'health'].some((k) =>
      Object.hasOwn(r, k),
    ) ||
    !Array.isArray(r.history) ||
    hash(r.history.map((x) => x.stage)) !==
      hash([
        'copy-candidate-intent',
        'copy-candidate-complete',
        'copy-rollback-intent',
        'copy-rollback-complete',
      ]) ||
    r.error?.code !== 'ONCE_PUBLICATION_INPUT_PIN' ||
    !Array.isArray(r.slots) ||
    r.slots.length !== 2 ||
    !Array.isArray(r.outputs) ||
    r.outputs.length !== 2 ||
    hash(r.claim) !==
      hash({
        id: r.nonce,
        kind: 'maintenance',
        root: p.installRoot,
        outputs: pair.map((x) => x.target),
      }) ||
    r.slots.some(
      (s) =>
        s.started !== true ||
        s.complete !== true ||
        !pair.some((x) => x.id === s.id && x.target === s.path) ||
        hash(directoryIdentity(s.path)) !== hash(s.identity),
    ) ||
    new Set(r.slots.map((s) => s.id)).size !== 2 ||
    r.outputs.some(
      (o) =>
        o.complete !== true ||
        o.claim !== r.nonce ||
        !pair.some((x) => x.target === o.path),
    ) ||
    new Set(r.outputs.map((o) => o.path)).size !== 2 ||
    present(p.publication.auditRoot)
  )
    fail('PRE_STOP_STATE');
  const allowedKeys = [
    'format',
    'kind',
    'configSha',
    'sourceSha',
    'pid',
    'nonce',
    'status',
    'stage',
    'backupSpent',
    'migrationAttempted',
    'recoverySpent',
    'publicationSpent',
    'stopAttempted',
    'slots',
    'outputs',
    'claim',
    'service',
    'pointer',
    'auditIdentity',
    'history',
    'error',
  ];
  if (
    Object.keys(r).some((k) => !allowedKeys.includes(k)) ||
    r.slots.some(
      (s) =>
        Object.keys(s).sort().join('|') !== 'complete|id|identity|path|started',
    ) ||
    r.outputs.some(
      (o) => Object.keys(o).sort().join('|') !== 'claim|complete|path',
    )
  )
    fail('PRE_STOP_STATE');
  const pointer = path.join(p.installRoot, 'active.json');
  if (
    hash(r.pointer) !==
    hash({
      path: pointer,
      sha256: p.pointerSha256,
      identity: identity(pointer),
    })
  )
    fail('PRE_STOP_POINTER');
  for (const item of pair) {
    verifyRelease(item.target);
    if (
      fileHash(path.join(item.target, 'release.json')) !==
      item.pkg.spec.manifestSha256
    )
      fail('PRE_STOP_PACKAGE');
  }
  return { record: r, recordText, lockText, previous: c };
}
function validService(p, r) {
  const s = r.service,
    release = s.release;
  const allowed = r.recoverySpent
    ? [
        r.migrationAttempted
          ? p.pair.find((t) => t.role === 'rollback').target
          : path.join(p.installRoot, p.currentId),
      ]
    : [p.pair.find((t) => t.role === 'candidate').target];
  const args = [
    path.join(release, 'runtime/node.exe'),
    path.join(release, 'runtime.cjs'),
    'start',
    '--database',
    p.publication.database,
    '--port',
    '4000',
    '--production',
  ];
  return (
    allowed.includes(release) &&
    Number.isInteger(s.pid) &&
    s.pid > 0 &&
    Number.isFinite(Date.parse(s.startUtc)) &&
    s.port === 4000 &&
    s.executable === args[0] &&
    hash(require('./windows-release-references.cjs').argv(s.commandLine)) ===
      hash(args)
  );
}
function review(file, expected) {
  if (hostEffects.currentLease()) fail('NESTED');
  const plan = once.checkPlan(file, expected, false),
    { p } = plan;
  bindings(p, expected, false);
  publication.validate(p);
  const continuation = p.maintenance.continueBeforeStop
    ? preStopSource(plan)
    : null;
  if (
    (!continuation && p.pair.some((x) => present(x.target))) ||
    present(p.publication.auditRoot) ||
    (!continuation && (present(recordPath(p)) || present(lockPath(p))))
  )
    fail('EXISTING_OUTPUT_OR_OWNER');
  const allowed = new Set(
    Object.values(p.maintenance.sourceFiles).map((x) => path.basename(x.path)),
  );
  if (continuation) {
    allowed.add(path.basename(recordPath(p)));
    allowed.add(path.basename(lockPath(p)));
  }
  if (
    fs
      .readdirSync(p.registryDirectory)
      .some((n) => n.startsWith(p.scopeId) && !allowed.has(n)) ||
    fs
      .readdirSync(p.installRoot)
      .some((n) => n.startsWith('active-') && n.endsWith('.tmp'))
  )
    fail('FOREIGN_CONTROL');
  return { ...plan, continuation };
}
async function execute(file, expected, options = {}) {
  const plan = review(file, expected),
    { p, pair } = plan,
    m = p.maintenance,
    u = publication.validate(p);
  bindings(p, expected, true);
  const lock = lockPath(p),
    recordFile = recordPath(p),
    pointer = path.join(p.installRoot, 'active.json');
  const initialDatabaseBytes = publication.databaseBytes(u.database);
  const nonce = crypto.randomUUID(),
    sourceSha = hash(m.sourceFiles),
    knownControls = new Set([
      ...Object.values(m.sourceFiles).map((x) => x.path),
      lock,
      recordFile,
      ...(plan.continuation ? [preStopPath(p)] : []),
    ]);
  const auditParents = [];
  for (let at = path.dirname(u.auditRoot); ; at = path.dirname(at)) {
    if (
      auditParents.length >= 128 ||
      !p.roots.some((r) => at === r.path || at.startsWith(r.path + path.sep))
    )
      fail('AUDIT_ANCESTRY');
    auditParents.push({ path: at, identity: directoryIdentity(at) });
    if (p.roots.some((r) => r.path === at)) break;
  }
  let lockPin = plan.continuation ? m.continueBeforeStop.lock : undefined,
    recordPin = plan.continuation ? m.continueBeforeStop.record : undefined,
    persistedRecord,
    transferring = !!plan.continuation,
    uncertain = false,
    safeStopped = false,
    child,
    record = {
      format: 1,
      kind: KIND,
      configSha: expected,
      sourceSha,
      pid: process.pid,
      nonce,
      status: 'running',
      stage: 'initialized',
      backupSpent: false,
      migrationAttempted: false,
      recoverySpent: false,
      publicationSpent: false,
      stopAttempted: false,
      slots: pair.map((x) => ({
        id: x.id,
        path: x.target,
        started: false,
        complete: false,
        identity: null,
      })),
      outputs: [],
      claim: {
        id: nonce,
        kind: 'maintenance',
        root: p.installRoot,
        outputs: [],
      },
      service: null,
      pointer: {
        path: pointer,
        sha256: p.pointerSha256,
        identity: identity(pointer),
      },
      auditIdentity: null,
      history: [],
    };
  if (plan.continuation) record = structuredClone(plan.continuation.record);
  const rounded = (n) => Math.ceil(n / plan.metadataBlock) * plan.metadataBlock;
  const controlFiles = () => {
    const files = fs
      .readdirSync(p.registryDirectory)
      .filter((n) => n.startsWith(p.scopeId))
      .map((n) => path.join(p.registryDirectory, n));
    if (present(u.auditRoot))
      for (const n of fs.readdirSync(u.auditRoot))
        if (n !== 'backups') files.push(path.join(u.auditRoot, n));
    for (const n of fs.readdirSync(p.installRoot))
      if (n.startsWith('active-') && n.endsWith('.tmp'))
        files.push(path.join(p.installRoot, n));
    return files;
  };
  const metadataUsed = () =>
    controlFiles().reduce((sum, at) => {
      const s = fs.lstatSync(at);
      if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1)
        fail('CONTROL_ALIAS');
      return sum + rounded(s.size);
    }, 0);
  const guardPins = () => {
    bindings(p, expected, true);
    for (const root of [
      ...p.roots,
      { path: p.registryDirectory, identity: p.registryIdentity },
      ...auditParents,
    ])
      if (hash(directoryIdentity(root.path)) !== hash(root.identity))
        fail('DIRECTORY_CHANGED');
    if (
      canonical(u.database) !== u.database ||
      hash(identity(u.database)) !== hash(u.databaseIdentity)
    )
      fail('DATABASE_CHANGED');
    if (
      fileHash(pointer) !== record.pointer.sha256 ||
      hash(identity(pointer)) !== hash(record.pointer.identity)
    )
      fail('POINTER_CHANGED');
    for (const slot of record.slots)
      if (
        slot.identity &&
        hash(directoryIdentity(slot.path)) !== hash(slot.identity)
      )
        fail('TARGET_CHANGED');
    if (
      record.auditIdentity &&
      hash(directoryIdentity(u.auditRoot)) !== hash(record.auditIdentity)
    )
      fail('AUDIT_CHANGED');
  };
  const owner = () => {
    if (uncertain) fail('UNCERTAIN_HOLD');
    guardPins();
    if (lockPin) {
      const raw = once.pinnedDocument(lockPin, lock, true);
      if (transferring) {
        once.pinnedDocument(m.continueBeforeStop.record, recordFile, true);
        once.pinnedDocument(m.continueBeforeStop.plan, undefined, true);
      } else if (recordPin)
        validateOwner(
          p,
          expected,
          JSON.parse(raw),
          persistedRecord,
          process.pid,
          true,
        );
    }
    for (const at of controlFiles())
      if (!knownControls.has(at)) fail('FOREIGN_CONTROL');
    if (metadataUsed() > once.LIMITS.metadata) fail('METADATA_LIMIT');
  };
  const create = (at, text) => {
    if (
      metadataUsed() + rounded(Buffer.byteLength(text)) >
      once.LIMITS.metadata
    )
      fail('METADATA_LIMIT');
    const fd = fs.openSync(at, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const proof = pinAt(at);
    if (once.pinnedDocument(proof, at, true) !== text) fail('CONTROL_READBACK');
    return proof;
  };
  const replace = (at, text, previousPin) => {
    const temporary = at + '.' + nonce + '.tmp';
    const proof = create(temporary, text);
    once.pinnedDocument(previousPin, at, true);
    fs.renameSync(temporary, at);
    const final = pinAt(at);
    // Windows can retain the destination birthtime when replacing a file.
    if (
      hash(final.identity.slice(0, 2)) !== hash(proof.identity.slice(0, 2)) ||
      final.sha256 !== proof.sha256 ||
      once.pinnedDocument(final, at, true) !== text
    )
      fail('CONTROL_REPLACE');
    return final;
  };
  const save = () => {
    owner();
    try {
      const text = JSON.stringify({ payload: record, digest: hash(record) });
      if (Buffer.byteLength(text) > 256 * 1024) fail('RECORD_LIMIT');
      recordPin = replace(recordFile, text, recordPin);
      once.pinnedDocument(lockPin, lock, true);
      lockPin = replace(
        lock,
        JSON.stringify({
          kind: KIND,
          pid: process.pid,
          nonce,
          configSha: expected,
          recordPin,
        }),
        lockPin,
      );
      persistedRecord = structuredClone(record);
      owner();
    } catch (e) {
      uncertain = true;
      throw e;
    }
  };
  const stage = (name) => {
    record.stage = name;
    record.history.push({ stage: name, atUtc: new Date().toISOString() });
    save();
  };
  const check = () => {
    owner();
    const usedCopy = record.slots.reduce(
      (n, s) =>
        n + (s.started ? pair.find((x) => x.id === s.id).pkg.physical : 0),
      0,
    );
    if (
      usedCopy > once.LIMITS.copy ||
      publication.databaseBytes(u.database) - initialDatabaseBytes >
        u.limits.migrationBytes
    )
      fail('PHYSICAL_LIMIT');
    const audit = present(u.auditRoot)
      ? publication.measure(
          u.auditRoot,
          u.limits.backupBytes + u.limits.auditBytes,
        )
      : 0;
    publication.reserve([
      [
        p.installRoot,
        Math.max(0, once.LIMITS.copy - usedCopy) +
          Math.max(0, once.LIMITS.metadata - metadataUsed()),
      ],
      [
        u.auditRoot,
        Math.max(0, u.limits.backupBytes + u.limits.auditBytes - audit),
      ],
      [
        u.database,
        Math.max(
          0,
          u.limits.migrationBytes -
            Math.max(
              0,
              publication.databaseBytes(u.database) - initialDatabaseBytes,
            ),
        ),
      ],
    ]);
  };
  let facts;
  const references = () => {
    check();
    facts = hostEffects.context.run(
      {
        assertWritable() {
          fail('OBSERVATION_WRITE');
        },
        assertOperation() {
          fail('NESTED');
        },
      },
      () =>
        options.query
          ? options.query(p, record)
          : JSON.parse(
              cp.execFileSync(process.execPath, [p.probe.path, plan.file], {
                encoding: 'utf8',
                timeout: 30000,
                maxBuffer: 1024 ** 2,
                windowsHide: true,
              }),
            ),
    );
    require('./release-scope.cjs').validateReferences(
      facts,
      p,
      record.stage.startsWith('copy')
        ? 'install'
        : record.status === 'recovering'
          ? 'rollback'
          : 'publish',
    );
    const summary = {
      kind: KIND,
      configSha: expected,
      nonce,
      recordSha256: recordPin.sha256,
      recordIdentity: recordPin.identity,
    };
    if (hash(facts.maintenanceOwner) !== hash(summary))
      fail('REFERENCE_OWNER_BINDING');
    owner();
    return facts;
  };
  const ops =
    options.operations ||
    publication.nativeOperations(p, u, u.auditRoot, check);
  const exact = (a, b) => {
    for (const k of ['pid', 'startUtc', 'executable', 'commandLine', 'port'])
      if (a[k] !== b[k]) fail('PROCESS_IDENTITY');
  };
  const auxiliaries = (action) => {
    if (!u.expectedChildren.length) return;
    const r = ops.identity(action, 0);
    if (
      r?.format !== 1 ||
      r.verifiedCount !== u.expectedChildren.length ||
      !Array.isArray(r.remainingPids) ||
      (action === 'WaitAuxiliary' &&
        (r.exited !== true || r.remainingPids.length))
    )
      fail('AUXILIARY_IDENTITY');
  };
  const writersStopped = () => {
    references();
    const ports = ops.identity('Port', 0);
    if (
      !Array.isArray(ports) ||
      ports.length ||
      facts.records.some((x) => x.kind === 'processes')
    )
      fail('WRITERS_NOT_STOPPED');
  };
  const proofFile = (name, value) => {
    owner();
    const at = path.join(u.auditRoot, name + '.json');
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > 256 * 1024) fail('PROOF_LIMIT');
    const proof = create(at, text);
    knownControls.add(at);
    return proof;
  };
  const publish = (id) => {
    const result = publication.atomicPublish(
      pointer,
      id,
      check,
      (at) => {
        knownControls.add(at);
        const proof = pinAt(at);
        once.pinnedDocument(proof, at, true);
      },
      () => {
        if (metadataUsed() + rounded(1024) > once.LIMITS.metadata)
          fail('METADATA_LIMIT');
      },
    );
    record.pointer = { path: pointer, ...result };
    save();
  };
  const service = async (release, recovery) => {
    child = ops.start(release, { recovery });
    const healthy = await ops.ready(child),
      snapshot = ops.identity('Snapshot', child.pid);
    if (
      snapshot.pid !== child.pid ||
      snapshot.executable !== path.join(release, 'runtime/node.exe')
    )
      fail('CHILD_IDENTITY');
    record.service = { ...snapshot, release };
    record.health = healthy;
    save();
    references();
    return snapshot;
  };
  publication.reserve([
    [
      p.installRoot,
      (plan.continuation
        ? Math.max(
            0,
            once.LIMITS.copy - pair.reduce((n, x) => n + x.pkg.physical, 0),
          )
        : once.LIMITS.copy) +
        Math.max(0, once.LIMITS.metadata - metadataUsed()),
    ],
    [u.auditRoot, u.limits.backupBytes + u.limits.auditBytes],
    [u.database, u.limits.migrationBytes],
  ]);
  // Only approved execution creates authority. Partial initialization is held.
  try {
    if (plan.continuation) {
      owner();
      const c = m.continueBeforeStop;
      const exited = ops.identity(
        'ControllerExited',
        c.controller.pid,
        c.controller,
      );
      if (
        exited?.format !== 1 ||
        exited.pid !== c.controller.pid ||
        exited.exited !== true ||
        exited.observation !== 'current-pid-absence-only'
      )
        fail('PRE_STOP_CONTROLLER_EXIT');
      owner();
      const receiptPin = create(
        preStopPath(p),
        JSON.stringify({
          kind: 'installed-pair-pre-stop-v1',
          configSha: expected,
          pid: process.pid,
          nonce,
          previous: c,
          exited,
          recordText: plan.continuation.recordText,
          lockText: plan.continuation.lockText,
          atUtc: new Date().toISOString(),
        }),
      );
      record.configSha = expected;
      record.pid = process.pid;
      record.nonce = nonce;
      record.status = 'running';
      record.stage = 'pre-stop-continuation';
      record.claim.id = nonce;
      record.outputs.forEach((o) => (o.claim = nonce));
      record.preStopContinuation = receiptPin;
      record.history.push({
        stage: 'pre-stop-continuation',
        atUtc: new Date().toISOString(),
      });
      recordPin = replace(
        recordFile,
        JSON.stringify({ payload: record, digest: hash(record) }),
        recordPin,
      );
      lockPin = replace(
        lock,
        JSON.stringify({
          kind: KIND,
          pid: process.pid,
          nonce,
          configSha: expected,
          recordPin,
        }),
        lockPin,
      );
      persistedRecord = structuredClone(record);
      transferring = false;
      owner();
    } else {
      lockPin = create(
        lock,
        JSON.stringify({
          kind: KIND,
          pid: process.pid,
          nonce,
          configSha: expected,
          recordPin: null,
        }),
      );
      recordPin = create(
        recordFile,
        JSON.stringify({ payload: record, digest: hash(record) }),
      );
      lockPin = replace(
        lock,
        JSON.stringify({
          kind: KIND,
          pid: process.pid,
          nonce,
          configSha: expected,
          recordPin,
        }),
        lockPin,
      );
      persistedRecord = structuredClone(record);
    }
  } catch (e) {
    uncertain = true;
    throw e;
  }
  try {
    references();
    for (const item of plan.continuation ? [] : pair) {
      references();
      const slot = record.slots.find((x) => x.id === item.id);
      if (present(item.target)) fail('TARGET_PRESENT');
      slot.started = true;
      record.outputs.push({ path: item.target, claim: nonce, complete: false });
      record.claim.outputs.push(item.target);
      stage('copy-' + item.role + '-intent');
      fs.mkdirSync(item.target);
      slot.identity = directoryIdentity(item.target);
      save();
      once.copyPackageFiles(item, slot, owner);
      hostEffects.context.run({ assertWritable: owner }, () =>
        require('./install-lifecycle.cjs').copyPackageLinks(
          item.target,
          item.pkg.manifest,
        ),
      );
      verifyRelease(item.target);
      if (
        fileHash(path.join(item.target, 'release.json')) !==
        item.pkg.spec.manifestSha256
      )
        fail('COPY_PROOF');
      slot.complete = true;
      record.outputs.find((x) => x.path === item.target).complete = true;
      stage('copy-' + item.role + '-complete');
    }
    const candidate = pair.find((x) => x.role === 'candidate').target,
      rollback = pair.find((x) => x.role === 'rollback').target;
    publication.additiveMigrations(candidate, u);
    const inspection = ops.inspect(candidate, u.database, false);
    if (hash(inspection.pending) !== hash(u.pendingMigrations))
      fail('MIGRATION_PLAN');
    exact(ops.identity('Snapshot', u.expected.pid), u.expected);
    auxiliaries('AuxiliarySnapshot');
    references();
    record.stopAttempted = true;
    stage('stop-intent');
    if (ops.identity('Stop', u.expected.pid, u.expected)?.stopped !== true)
      fail('STOP_UNCERTAIN');
    auxiliaries('WaitAuxiliary');
    writersStopped();
    safeStopped = true;
    stage('old-stopped');
    record.outputs.push({ path: u.auditRoot, claim: nonce, complete: false });
    record.claim.outputs.push(u.auditRoot);
    stage('audit-intent');
    fs.mkdirSync(u.auditRoot);
    record.auditIdentity = directoryIdentity(u.auditRoot);
    save();
    if (record.backupSpent) fail('BACKUP_SPENT');
    if (publication.databaseBytes(u.database) > u.limits.sourceCeilingBytes)
      fail('SOURCE_LIMIT');
    record.backupSpent = true;
    stage('backup-intent');
    record.backup = ops.backup(candidate);
    save();
    const baseline = ops.state(u.database);
    record.baseline = proofFile('baseline', baseline);
    save();
    ops.state(record.backup.backup, record.baseline.path);
    writersStopped();
    const afterBackupInspection = ops.inspect(candidate, u.database, false);
    if (hash(afterBackupInspection.pending) !== hash(u.pendingMigrations))
      fail('MIGRATION_PLAN_CHANGED');
    if (record.migrationAttempted) fail('MIGRATION_SPENT');
    record.migrationAttempted = true;
    stage('migration-intent');
    let migrated;
    try {
      migrated = await ops.migrate(candidate);
    } catch (error) {
      if (error.migrationExitConfirmed !== true) uncertain = true;
      throw error;
    }
    if (hash(migrated.appliedMigrationNames) !== hash(u.pendingMigrations))
      fail('MIGRATION_RESULT');
    record.migrationResult = migrated;
    stage('migrated');
    ops.state(u.database, record.baseline.path);
    ops.inspect(candidate, u.database, true);
    writersStopped();
    await service(candidate, false);
    record.publicationSpent = true;
    stage('publication-intent');
    try {
      publish(path.basename(candidate));
    } catch (e) {
      uncertain = true;
      throw e;
    }
    exact(ops.identity('Snapshot', child.pid), record.service);
    record.status = 'passed';
    record.stage = 'completed';
    record.claim = null;
    record.outputs.forEach((x) => (x.complete = true));
    save();
    child.unref?.();
    return {
      status: record.status,
      backupSpent: record.backupSpent,
      migrationAttempted: record.migrationAttempted,
      recoverySpent: record.recoverySpent,
    };
  } catch (error) {
    if (!uncertain) {
      const api = require('./windows-release-references.cjs');
      const diagnostic = api.referenceDiagnostic({
        stage: 'admission',
        codes: [error.message],
        ...error.referenceDiagnostic,
      });
      const privateDiagnostic = api.privateReferenceDiagnostic(
        error.privateReferenceDiagnostic,
      );
      record.error = {
        code: /^[A-Z_]+$/.test(error.message)
          ? error.message
          : 'MAINTENANCE_FAILED',
        referenceDiagnostic: diagnostic,
        ...(privateDiagnostic
          ? { privateReferenceDiagnostic: privateDiagnostic }
          : {}),
      };
      try {
        save();
        error.referenceDiagnostic = { ...diagnostic, diagnosticStored: true };
      } catch {
        uncertain = true;
        error.referenceDiagnostic = { ...diagnostic, diagnosticStored: false };
      }
    }
    if (safeStopped && !uncertain && !record.recoverySpent) {
      try {
        owner();
        const previousService = record.service;
        if (child && previousService)
          exact(ops.identity('Snapshot', child.pid), previousService);
        record.recoverySpent = true;
        record.status = 'recovering';
        record.service = null;
        stage('recovery-intent');
        if (child) {
          await ops.stopChild(child);
          child = undefined;
          save();
        }
        writersStopped();
        const target = record.migrationAttempted
          ? pair.find((x) => x.role === 'rollback').target
          : path.join(p.installRoot, p.currentId);
        await service(target, true);
        stage('recovery-publication-intent');
        try {
          publish(path.basename(target));
        } catch (e) {
          uncertain = true;
          throw e;
        }
        record.status = 'recovered';
        record.stage = 'completed';
        record.claim = null;
        record.outputs.forEach((x) => (x.complete = true));
        save();
        child.unref?.();
        return {
          status: record.status,
          backupSpent: record.backupSpent,
          migrationAttempted: record.migrationAttempted,
          recoverySpent: true,
        };
      } catch (recoveryError) {
        error = recoveryError;
      }
    }
    if (!uncertain) {
      try {
        record.status = 'hold';
        record.stage = 'hold';
        save();
      } catch {
        uncertain = true;
      }
    }
    // Lock, record, partial packages and original controls are never deleted.
    throw error;
  }
}
function main(argv) {
  if (argv.length !== 3 || !['--review', '--execute'].includes(argv[0]))
    fail('USAGE');
  if (argv[0] === '--review') {
    const plan = review(argv[1], argv[2]);
    return {
      kind: KIND,
      approved: plan.p.maintenance.approval.confirmed === true,
      authorityCreated: false,
      productionActions: 0,
    };
  }
  return execute(argv[1], argv[2]);
}
function formatCliError(error) {
  const code =
    /^(FIXED_MAINTENANCE|ONCE_PAIR|ONCE_PUBLICATION|REFERENCE|RELEASE_SCOPE)_[A-Z_]+$/.test(
      error.message,
    )
      ? error.message
      : 'FIXED_MAINTENANCE_FAILED';
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
  KIND,
  review,
  execute,
  main,
  validateOwner,
  recordPath,
  toolPins,
  formatCliError,
};
if (require.main === module)
  Promise.resolve()
    .then(() => main(process.argv.slice(2)))
    .then((v) => process.stdout.write(JSON.stringify(v) + '\n'))
    .catch((e) => {
      process.stderr.write(formatCliError(e));
      process.exitCode = 1;
    });
