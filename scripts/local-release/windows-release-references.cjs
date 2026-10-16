// Read-only Windows reference probe for release-scope.cjs. No service control,
// source execution, package writes, stale-owner recovery or inferred approvals.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const kinds = [
  'processes',
  'tasks',
  'shortcuts',
  'pointers',
  'rollback',
  'inflight',
];
const digest = (value) =>
  crypto.createHash('sha256').update(value).digest('hex');
const hash = (value) => digest(JSON.stringify(value));
function referenceDiagnostic(value = {}) {
  const token = (s) =>
    typeof s === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,95}$/.test(s)
      ? s
      : undefined;
  const codes = [
    ...new Set(
      (Array.isArray(value.codes) ? value.codes : []).filter(
        (s) =>
          typeof s === 'string' &&
          /^(REFERENCE|RELEASE_SCOPE|ONCE_PAIR|ONCE_PUBLICATION)_[A-Z_]{1,96}$/.test(
            s,
          ),
      ),
    ),
  ].slice(0, 16);
  const transportCodes = [
    'ETIMEDOUT',
    'ENOBUFS',
    'ENOENT',
    'EACCES',
    'EPERM',
    'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
  ];
  return {
    stage: [
      'policy',
      'native-validation',
      'policy-bindings',
      'processes',
      'collector-chain',
      'tasks',
      'shortcuts',
      'inflight',
      'final-verification',
      'probe-main',
      'scope-validation',
      'admission',
    ].includes(value.stage)
      ? value.stage
      : 'unknown',
    codes,
    ...(token(value.nativeStage)
      ? { nativeStage: token(value.nativeStage) }
      : {}),
    ...(token(value.nativeErrorId)
      ? { nativeErrorId: token(value.nativeErrorId) }
      : {}),
    ...(token(value.nativeCategory)
      ? { nativeCategory: token(value.nativeCategory) }
      : {}),
    ...(transportCodes.includes(value.transportCode)
      ? { transportCode: value.transportCode }
      : {}),
    ...(Number.isInteger(value.status) &&
    value.status >= 0 &&
    value.status <= 255
      ? { status: value.status }
      : {}),
    ...Object.fromEntries(
      ['complete', 'operationSufficient', 'globalReferenceComplete']
        .filter((k) => typeof value[k] === 'boolean')
        .map((k) => [k, value[k]]),
    ),
    ...(value.categories && typeof value.categories === 'object'
      ? {
          categories: Object.fromEntries(
            kinds.map((k) => [
              k,
              typeof value.categories[k] === 'boolean'
                ? value.categories[k]
                : null,
            ]),
          ),
        }
      : {}),
  };
}
const fail = (code) => {
  throw new Error(code);
};
const hex = (s) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const same = (a, b) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const inside = (root, at) => {
  const r = path.relative(root, at);
  return (
    r === '' ||
    (r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r))
  );
};
function exists(at) {
  try {
    return fs.lstatSync(at);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}
function canonical(at) {
  if (typeof at !== 'string' || !path.isAbsolute(at))
    fail('REFERENCE_ABSOLUTE_PATH_REQUIRED');
  return fs.realpathSync.native(at);
}
function identity(s) {
  return [s.dev, s.ino, s.size, s.birthtimeNs, s.mtimeNs, s.ctimeNs].map(
    String,
  );
}
function bytes(at, limit = 1024 * 1024) {
  const s = fs.lstatSync(at, { bigint: true });
  if (!s.isFile() || s.isSymbolicLink() || s.size > BigInt(limit))
    fail('REFERENCE_FILE_INVALID');
  const value = fs.readFileSync(at);
  if (hash(identity(s)) !== hash(identity(fs.lstatSync(at, { bigint: true }))))
    fail('REFERENCE_FILE_CHANGED');
  return value;
}
function json(at, limit) {
  return JSON.parse(
    bytes(at, limit)
      .toString('utf8')
      .replace(/^\uFEFF/, ''),
  );
}
function pinned(spec, limit) {
  if (!spec || !hex(spec.sha256)) fail('REFERENCE_PIN_REQUIRED');
  const value = bytes(canonical(spec.path), limit);
  if (digest(value) !== spec.sha256) fail('REFERENCE_PIN_CHANGED');
  return value;
}
// CommandLineToArgvW-style quote/backslash rules. Shell commands are never run.
function argv(command) {
  if (
    typeof command !== 'string' ||
    command.length > 32768 ||
    /[\0\r\n]/.test(command)
  )
    fail('REFERENCE_COMMAND_INVALID');
  const out = [];
  let i = 0;
  while (i < command.length) {
    while (/\s/.test(command[i] || '') && i < command.length) i++;
    if (i === command.length) break;
    let value = '',
      quoted = false;
    while (i < command.length && (quoted || !/\s/.test(command[i]))) {
      let slashes = 0;
      while (command[i] === '\\') {
        slashes++;
        i++;
      }
      if (command[i] === '"') {
        value += '\\'.repeat(Math.floor(slashes / 2));
        if (slashes % 2) value += '"';
        else if (quoted && command[i + 1] === '"') {
          value += '"';
          i++;
        } else quoted = !quoted;
        i++;
      } else {
        value += '\\'.repeat(slashes);
        if (i < command.length) value += command[i++];
      }
    }
    if (quoted) fail('REFERENCE_COMMAND_UNBALANCED');
    out.push(value);
  }
  return out;
}
const operationKind = 'non-retiring-once-pair-v1';
const processKind = 'once-related-processes-v1';
const operationHostNames =
  'node|nodejs|python[0-9.]*|pythonw|py|powershell|pwsh|cmd|wscript|cscript|mshta|rundll32|regsvr32|bash|sh|deno|bun';
const operationHost = new RegExp(
  '^(?:' + operationHostNames + ')(?:\\.exe)?$',
  'i',
);
const operationHostCommand = new RegExp(
  '(?:^|[\\\\/\\s"])(?:' + operationHostNames + ')(?:\\.exe)?(?:[\\s"]|$)',
  'i',
);
const processTuple = (p) => ({
  pid: p.pid,
  parentPid: p.parentPid,
  name: p.name,
  executable: p.executable ?? null,
  commandLine: p.commandLine ?? null,
  startUtc: p.startUtc,
  workingDirectory: p.workingDirectory ?? null,
});
const visibleProcess = (p) =>
  typeof p?.executable === 'string' &&
  !!p.executable.trim() &&
  typeof p.commandLine === 'string' &&
  !!p.commandLine.trim() &&
  typeof p.startUtc === 'string' &&
  Number.isFinite(Date.parse(p.startUtc));
// Only the already-verified read-only probe -> collector chain can own this
// transient console. Its exact observed identity is checked before removal.
function collectorChain(before, after, callerPid, self) {
  const own = before.get(self.pid),
    last = after.get(self.pid);
  if (
    !visibleProcess(own) ||
    !last ||
    own.parentPid !== callerPid ||
    hash(own) !== hash(last) ||
    !same(canonical(own.executable), canonical(self.executable)) ||
    hash(argv(own.commandLine)) !== hash(self.argv)
  )
    fail('REFERENCE_PROBE_IDENTITY_UNCERTAIN');
  const children = [...before.values()].filter((r) => r.parentPid === own.pid);
  if (children.length !== 1) fail('REFERENCE_PROBE_CHILD_UNCERTAIN');
  const child = children[0];
  if (
    !visibleProcess(child) ||
    !after.has(child.pid) ||
    hash(child) !== hash(after.get(child.pid)) ||
    !same(canonical(child.executable), canonical(self.collectorExecutable)) ||
    hash(argv(child.commandLine)) !== hash(self.collectorArgv) ||
    Date.parse(child.startUtc) < Date.parse(own.startUtc)
  )
    fail('REFERENCE_PROBE_CHILD_UNCERTAIN');
  const consoles = [...before.values()].filter(
    (r) => r.parentPid === child.pid,
  );
  if (consoles.length > 1) fail('REFERENCE_PROBE_CHILD_UNCERTAIN');
  const accepted = [own, child];
  if (consoles.length) {
    const console = consoles[0];
    const command = visibleProcess(console) ? argv(console.commandLine) : [];
    const consolePath = (s) =>
      canonical(s.startsWith('\\??\\') ? s.slice(4) : s);
    if (
      !self.consoleExecutable ||
      !Array.isArray(self.consoleArgv) ||
      !visibleProcess(console) ||
      !after.has(console.pid) ||
      console.name.toLowerCase() !== 'conhost.exe' ||
      hash(console) !== hash(after.get(console.pid)) ||
      !same(canonical(console.executable), canonical(self.consoleExecutable)) ||
      !command.length ||
      !same(consolePath(command[0]), consolePath(self.consoleArgv[0])) ||
      hash(command.slice(1)) !== hash(self.consoleArgv.slice(1)) ||
      Date.parse(console.startUtc) < Date.parse(child.startUtc)
    )
      fail('REFERENCE_PROBE_CONSOLE_UNCERTAIN');
    accepted.push(console);
  }
  const ids = new Set(accepted.map((r) => r.pid));
  for (const r of [...before.values(), ...after.values()])
    if (ids.has(r.parentPid) && !ids.has(r.pid))
      fail('REFERENCE_PROBE_CHILD_UNCERTAIN');
  return accepted.map(processTuple);
}
const taskKind = 'once-background-task-actions-v1';
const taskActionFields = [
  'execute',
  'arguments',
  'workingDirectory',
  'actionType',
  'cimClass',
  'id',
  'classId',
  'data',
  'identitySha256',
];
function taskActionTuple(task, index) {
  const a = task.actions[index];
  if (
    !a ||
    Object.keys(a).some((k) => !taskActionFields.includes(k)) ||
    ['execute', 'arguments', 'workingDirectory'].some(
      (k) => typeof a[k] !== 'string' || a[k].length > 32768,
    ) ||
    ['actionType', 'cimClass', 'id', 'classId', 'data'].some(
      (k) => a[k] != null && (typeof a[k] !== 'string' || a[k].length > 32768),
    ) ||
    (a.identitySha256 != null && !hex(a.identitySha256)) ||
    (task.actionsSha256 != null && !hex(task.actionsSha256))
  )
    fail('REFERENCE_TASK_ACTION_METADATA_INVALID');
  if (
    a.actionType === 'com-handler' &&
    (!/^\{[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\}$/i.test(
      a.classId || '',
    ) ||
      a.cimClass !== 'MSFT_TaskComHandlerAction' ||
      a.execute)
  )
    fail('REFERENCE_TASK_ACTION_METADATA_INVALID');
  return {
    taskIdentity: task.identity,
    actionIndex: index,
    taskActionsSha256: task.actionsSha256 ?? null,
    action: Object.fromEntries(
      taskActionFields.map((k) => [
        k,
        a[k] ?? (k === 'actionType' ? 'unreported' : null),
      ]),
    ),
  };
}
function operationTaskContract(p) {
  const c = p.windowsReferences?.operationCoverage?.taskCoverage;
  if (!c) return null;
  if (
    !operationProcessContract(p) ||
    c.format !== 1 ||
    c.kind !== taskKind ||
    c.globalTaskInvocationCoverageComplete !== false ||
    c.coverageClaim !==
      'bound-background-actions-only;indirect-db-access-unproven' ||
    Object.keys(c).sort().join('|') !==
      [
        'backgroundActions',
        'coverageClaim',
        'format',
        'globalTaskInvocationCoverageComplete',
        'kind',
      ].join('|') ||
    !Array.isArray(c.backgroundActions) ||
    c.backgroundActions.length > 1024 ||
    Buffer.byteLength(JSON.stringify(c.backgroundActions)) > 1024 ** 2
  )
    fail('REFERENCE_TASK_OPERATION_CONTRACT_INVALID');
  const seen = new Set();
  for (const row of c.backgroundActions) {
    const key = JSON.stringify([row.taskIdentity, row.actionIndex]);
    if (
      typeof row.taskIdentity !== 'string' ||
      !row.taskIdentity ||
      row.taskIdentity.length > 2048 ||
      !Number.isInteger(row.actionIndex) ||
      row.actionIndex < 0 ||
      row.actionIndex > 63 ||
      seen.has(key)
    )
      fail('REFERENCE_TASK_OPERATION_CONTRACT_INVALID');
    seen.add(key);
    const actions = [];
    actions[row.actionIndex] = row.action;
    const a = row.action;
    if (
      !hex(row.taskActionsSha256) ||
      !hex(a?.identitySha256) ||
      !(
        (a.actionType === 'exec' &&
          a.cimClass === 'MSFT_TaskExecAction' &&
          a.execute) ||
        (a.actionType === 'com-handler' &&
          a.cimClass === 'MSFT_TaskComHandlerAction')
      ) ||
      hash(row) !==
        hash(
          taskActionTuple(
            {
              identity: row.taskIdentity,
              actionsSha256: row.taskActionsSha256,
              actions,
            },
            row.actionIndex,
          ),
        )
    )
      fail('REFERENCE_TASK_OPERATION_CONTRACT_INVALID');
  }
  return c;
}
function validateOperationTaskSummary(p, value) {
  const contract = operationTaskContract(p);
  if (!contract) return false;
  const proof = value.operationCoverage?.taskCoverage;
  if (
    value.categories?.tasks !== false ||
    proof?.kind !== taskKind ||
    proof.contractSha256 !== hash(contract) ||
    proof.globalTaskInvocationCoverageComplete !== false ||
    proof.backgroundDbAccessExcluded !== false ||
    hash(proof.backgroundActions) !== hash(contract.backgroundActions)
  )
    fail('REFERENCE_OPERATION_TASK_COVERAGE_INVALID');
  return true;
}
function validateOperationStartupSummary(p, value) {
  const rows = (p.windowsReferences.harmlessActions || []).filter(
    (a) => a.uninspectedWorkingDirectory === true,
  );
  const expected = rows
    .map((a) => ({
      ...a.shortcut,
      executable: a.executable,
      uninspectedWorkingDirectory: true,
      backgroundDbAccessExcluded: false,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const actual = value.operationCoverage?.uninspectedStartupActions || [];
  if (
    !Array.isArray(actual) ||
    hash([...actual].sort((a, b) => a.path.localeCompare(b.path))) !==
      hash(expected)
  )
    fail('REFERENCE_OPERATION_STARTUP_ACTION_COVERAGE_INVALID');
}
function operationProcessContract(p) {
  const c = p.windowsReferences?.operationCoverage?.processCoverage;
  if (!c) return null;
  if (
    c.format !== 1 ||
    c.kind !== processKind ||
    c.globalDbWriterExclusion !== false ||
    Object.keys(c).sort().join('|') !==
      [
        'backgroundGaps',
        'coverageClaim',
        'format',
        'globalDbWriterExclusion',
        'kind',
      ].join('|') ||
    c.coverageClaim !==
      'related-processes-only;uninspected-background-db-access-unproven' ||
    !Array.isArray(c.backgroundGaps) ||
    c.backgroundGaps.length > 1024 ||
    Buffer.byteLength(JSON.stringify(c.backgroundGaps)) > 512 * 1024 ||
    new Set(c.backgroundGaps.map((r) => r.pid)).size !==
      c.backgroundGaps.length ||
    c.backgroundGaps.some(
      (r) =>
        !Number.isInteger(r.pid) ||
        r.pid <= 4 ||
        !Number.isInteger(r.parentPid) ||
        r.parentPid < 0 ||
        typeof r.name !== 'string' ||
        !r.name ||
        r.name.length > 260 ||
        typeof r.startUtc !== 'string' ||
        !Number.isFinite(Date.parse(r.startUtc)) ||
        [r.executable, r.commandLine, r.workingDirectory].some(
          (v) => v != null && (typeof v !== 'string' || v.length > 32768),
        ),
    ) ||
    !Number.isInteger(p.publication?.expected?.pid) ||
    p.publication.expected.pid <= 0 ||
    !Number.isInteger(p.publication?.expected?.port) ||
    p.publication.expected.port < 1 ||
    p.publication.expected.port > 65535
  )
    fail('REFERENCE_PROCESS_OPERATION_CONTRACT_INVALID');
  return c;
}
function operationProcessView(p, native, before, after, callerPid) {
  const contract = operationProcessContract(p);
  if (!contract) return null;
  const port = p.publication.expected.port;
  const facts = native.processCoverage;
  if (
    facts?.format !== 1 ||
    facts.port !== port ||
    !Array.isArray(facts.listenersBefore) ||
    !Array.isArray(facts.listenersAfter) ||
    facts.listenersBefore.length > 64 ||
    facts.listenersAfter.length > 64
  )
    fail('REFERENCE_OPERATION_PORT_QUERY_INCOMPLETE');
  const listenerRows = (rows) =>
    rows
      .map((r) => {
        if (
          r.port !== port ||
          !Number.isInteger(r.pid) ||
          r.pid <= 0 ||
          typeof r.address !== 'string' ||
          r.address.length > 128
        )
          fail('REFERENCE_OPERATION_PORT_QUERY_INCOMPLETE');
        return { port: r.port, pid: r.pid, address: r.address };
      })
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const portsBefore = listenerRows(facts.listenersBefore),
    portsAfter = listenerRows(facts.listenersAfter);
  if (hash(portsBefore) !== hash(portsAfter))
    fail('REFERENCE_OPERATION_PORT_CHANGED');
  const normalized = (s) =>
    String(s || '')
      .replaceAll('\\', '/')
      .replace(/\/+/g, '/')
      .toLowerCase();
  const needles = [
    ...p.roots.map((r) => r.path),
    ...p.windowsReferences.launchers.flatMap((l) => [
      l.entry,
      ...l.files.map((f) => f.path),
    ]),
    p.publication.database,
    path.basename(p.publication.database),
  ].map(normalized);
  const signal = (r) =>
    [r.executable, r.commandLine, r.workingDirectory].some((value) => {
      const text = normalized(value);
      return text && needles.some((n) => n && text.includes(n));
    });
  const related = new Set([
    p.publication.expected.pid,
    ...(p.publication.expectedChildren || []).map((r) => r.pid),
    ...portsBefore.map((r) => r.pid),
    ...portsAfter.map((r) => r.pid),
  ]);
  for (const r of [...before.values(), ...after.values()])
    if (signal(r)) related.add(r.pid);
  const children = new Map();
  for (const r of [...before.values(), ...after.values()]) {
    if (!children.has(r.parentPid)) children.set(r.parentPid, new Set());
    children.get(r.parentPid).add(r.pid);
  }
  const queue = [...related];
  for (let i = 0; i < queue.length; i++)
    for (const pid of children.get(queue[i]) || [])
      if (!related.has(pid)) {
        related.add(pid);
        queue.push(pid);
      }
  for (const owner of portsBefore)
    if (!before.has(owner.pid) || !after.has(owner.pid))
      fail('REFERENCE_OPERATION_PORT_OWNER_NOT_VISIBLE');
  const pins = new Map(contract.backgroundGaps.map((r) => [r.pid, r]));
  const background = [];
  const needsGap = (r) => {
    if (!visibleProcess(r)) return true;
    try {
      argv(r.commandLine);
    } catch {
      return true;
    }
    const text = r.commandLine;
    return (
      /\.(?:ps1|psm1|vbs|vbe|wsf|wsh|bat|cmd|js|cjs|mjs|py|pyw|pl|rb|sh)(?:[\s"']|$)/i.test(
        text,
      ) ||
      operationHost.test(path.basename(r.executable)) ||
      operationHostCommand.test(text)
    );
  };
  for (const r of [...before.values(), ...after.values()]) {
    if (related.has(r.pid)) {
      if (pins.has(r.pid)) fail('REFERENCE_BACKGROUND_BECAME_ASSOCIATED');
      if (!visibleProcess(r)) fail('REFERENCE_PROCESS_VISIBILITY_INCOMPLETE');
      const other = after.get(r.pid),
        first = before.get(r.pid);
      if (
        !first ||
        !other ||
        hash(processTuple(first)) !== hash(processTuple(other))
      )
        fail('REFERENCE_PROCESS_CHANGED');
      continue;
    }
    // The full-visibility controller remains subject to the existing live lock,
    // nonce and before/after identity checks; it is not a background exception.
    if (r.pid === callerPid) {
      if (
        !visibleProcess(r) ||
        !before.has(r.pid) ||
        !after.has(r.pid) ||
        hash(processTuple(before.get(r.pid))) !==
          hash(processTuple(after.get(r.pid)))
      )
        fail('REFERENCE_INFLIGHT_OWNER_CHANGED');
      if (pins.has(r.pid)) fail('REFERENCE_CONTROLLER_BACKGROUND_BOUND');
      continue;
    }
    if (!needsGap(r)) continue;
    // An opaque interpreter is an unresolved association signal, not an OS name
    // exemption. No process name authorizes a background acceptance.
    if (
      !visibleProcess(r) &&
      (operationHost.test(r.name) ||
        operationHost.test(path.basename(r.executable || '')) ||
        operationHostCommand.test(r.commandLine || ''))
    )
      fail('REFERENCE_OPAQUE_INTERPRETER_UNRESOLVED');
    const pin = pins.get(r.pid),
      first = before.get(r.pid),
      last = after.get(r.pid);
    if (
      !pin ||
      !first ||
      !last ||
      hash(processTuple(first)) !== hash(processTuple(last)) ||
      hash(processTuple(first)) !== hash(processTuple(pin))
    )
      fail('REFERENCE_BACKGROUND_GAP_UNBOUND');
    if (!background.some((x) => x.pid === r.pid)) background.push({ ...r });
  }
  if (background.length !== pins.size)
    fail('REFERENCE_BACKGROUND_BINDING_NOT_OBSERVED');
  background.sort((a, b) => a.pid - b.pid);
  return {
    related,
    background,
    summary: {
      kind: processKind,
      contractSha256: hash(contract),
      relatedChecksComplete: true,
      requiredPortChecked: true,
      globalDbWriterExclusion: false,
      globalProcessVisibilityComplete: false,
      globalInvocationCoverageComplete: false,
      backgroundGaps: background,
    },
  };
}
function validateOperationProcessSummary(p, value) {
  const contract = operationProcessContract(p);
  if (!contract) return false;
  const proof = value.operationCoverage?.processCoverage;
  if (
    value.categories?.processes !== false ||
    proof?.kind !== processKind ||
    proof.contractSha256 !== hash(contract) ||
    proof.relatedChecksComplete !== true ||
    proof.requiredPortChecked !== true ||
    proof.globalDbWriterExclusion !== false ||
    proof.globalProcessVisibilityComplete !== false ||
    proof.globalInvocationCoverageComplete !== false ||
    !Array.isArray(proof.backgroundGaps) ||
    hash(
      proof.backgroundGaps.map(processTuple).sort((a, b) => a.pid - b.pid),
    ) !==
      hash(
        contract.backgroundGaps.map(processTuple).sort((a, b) => a.pid - b.pid),
      )
  )
    fail('REFERENCE_OPERATION_PROCESS_COVERAGE_INVALID');
  return true;
}
const staticKinds = [
  'Desktop',
  'CommonDesktop',
  'StartMenu',
  'CommonStartMenu',
];
function operationStaticScopes(rows) {
  if (
    !Array.isArray(rows) ||
    rows.length !== 4 ||
    new Set(rows.map((r) => r.kind)).size !== 4 ||
    rows.some(
      (r) =>
        !staticKinds.includes(r.kind) ||
        r.inspected !== false ||
        r.reason !== 'outside-non-retiring-operation',
    )
  )
    fail('REFERENCE_STATIC_SCOPE_INVALID');
  return rows
    .map((r) => ({ kind: r.kind, inspected: false, reason: r.reason }))
    .sort((a, b) => a.kind.localeCompare(b.kind));
}
const profileRows = (rows) =>
  rows
    .map((r) => ({
      sid: r.sid,
      path: r.path,
      special: r.special,
      loaded: r.loaded,
      status: r.status,
      staticShortcutsInspected: r.staticShortcutsInspected,
    }))
    .sort((a, b) => a.sid.localeCompare(b.sid));
function operationContract(p) {
  const scope = p.windowsReferences?.operationCoverage;
  if (!scope) return null;
  const ids = [p.currentId, p.heldId, ...(p.pair || []).map((r) => r.id)];
  if (
    scope.format !== 1 ||
    scope.kind !== operationKind ||
    scope.staticScopeMode !== 'startup-and-pinned-launchers-v1' ||
    scope.preserveLegacy !== true ||
    scope.globalReferenceComplete !== false ||
    p.mode !== 'once-frozen-pair-v1' ||
    hash(p.approval?.operations) !== hash(['install', 'publish', 'rollback']) ||
    !Array.isArray(p.pair) ||
    p.pair.length !== 2 ||
    hash(p.pair.map((r) => r.role).sort()) !==
      hash(['candidate', 'rollback']) ||
    new Set(ids).size !== 4 ||
    hash([...p.protectedIds].sort()) !== hash([...ids].sort()) ||
    !Array.isArray(p.legacyIds) ||
    !p.legacyIds.includes(p.heldId) ||
    !path.isAbsolute(p.installRoot) ||
    p.pair.some(
      (r) =>
        r.target !== path.join(p.installRoot, r.id) ||
        !path.isAbsolute(r.source) ||
        inside(p.installRoot, r.source) ||
        p.approval[r.role + 'Commit'] !==
          p.protectedPackages?.find((s) => s.id === r.id)?.sourceCommit,
    ) ||
    p.publication?.database !==
      path.join(path.dirname(p.installRoot), 'apps/server/data/wewe-rss.db') ||
    p.publication?.limits?.maxBackups !== 1 ||
    p.publication.limits.maxPublications !== 1 ||
    p.publication.limits.maxRollbacks !== 1 ||
    !Array.isArray(scope.uninspectedProfiles) ||
    scope.uninspectedProfiles.length > 2 ||
    new Set(scope.uninspectedProfiles.map((r) => r.sid)).size !==
      scope.uninspectedProfiles.length ||
    scope.uninspectedProfiles.some(
      (r) =>
        !/^S-\d+(?:-\d+){2,15}$/.test(r.sid) ||
        typeof r.path !== 'string' ||
        !path.isAbsolute(r.path) ||
        path.resolve(r.path) !== r.path ||
        r.special !== false ||
        r.loaded !== false ||
        r.status !== 0 ||
        r.staticShortcutsInspected !== false,
    )
  )
    fail('REFERENCE_OPERATION_CONTRACT_INVALID');
  operationProcessContract(p);
  operationTaskContract(p);
  return scope;
}
function probe(policy, native, { callerPid = process.ppid, self } = {}) {
  const result = {
    complete: false,
    globalReferenceComplete: false,
    operationSufficient: false,
    categories: Object.fromEntries(kinds.map((k) => [k, false])),
    records: [],
    errors: [],
    uncertainChildren: [],
  };
  let stage = 'policy';
  try {
    const scope = operationContract(policy);
    if (scope) result.globalReferenceComplete = false;
    const cfg = policy.windowsReferences;
    if (
      !cfg ||
      cfg.format !== 1 ||
      !Array.isArray(cfg.packages) ||
      cfg.packages.length < 1 ||
      cfg.packages.length > 6 ||
      !Array.isArray(cfg.launchers) ||
      cfg.launchers.length > 16 ||
      !Array.isArray(cfg.rollbackFiles) ||
      cfg.rollbackFiles.length < 1 ||
      cfg.rollbackFiles.length > 16 ||
      !Array.isArray(policy.roots) ||
      !Array.isArray(policy.protectedIds)
    )
      fail('REFERENCE_POLICY_INVALID');
    stage = 'native-validation';
    if (
      !native ||
      native.format !== 1 ||
      (scope
        ? native.complete !== false ||
          native.operationSufficient !== true ||
          native.globalReferenceComplete !== false ||
          native.categories?.shortcuts !== false ||
          native.operationCoverage?.kind !== operationKind ||
          native.operationCoverage.staticScopeMode !== scope.staticScopeMode ||
          !Array.isArray(native.operationCoverage.profilesBefore) ||
          !Array.isArray(native.operationCoverage.profilesAfter) ||
          hash(profileRows(native.operationCoverage.profilesBefore)) !==
            hash(profileRows(scope.uninspectedProfiles)) ||
          hash(profileRows(native.operationCoverage.profilesAfter)) !==
            hash(profileRows(scope.uninspectedProfiles))
        : native.complete !== true ||
          native.globalReferenceComplete === false ||
          native.operationSufficient === true) ||
      !Array.isArray(native.errors) ||
      native.errors.length ||
      (scope
        ? ['processes', 'tasks']
        : ['processes', 'tasks', 'shortcuts']
      ).some((k) => native.categories?.[k] !== true)
    )
      fail('REFERENCE_NATIVE_QUERY_INCOMPLETE');
    stage = 'policy-bindings';
    const roots = policy.roots.map((r) => canonical(r.path));
    const manifests = new Map(),
      watched = new Map();
    const directoryWatches = new Map(),
      absentDirectories = new Set();
    const directoryId = (at) => {
      const s = fs.lstatSync(at, { bigint: true });
      if (!s.isDirectory() || s.isSymbolicLink() || !same(canonical(at), at))
        fail('REFERENCE_SHORTCUT_DIRECTORY_INVALID');
      return [s.dev, s.ino, s.birthtimeNs].map(String);
    };
    const entriesAt = (at) =>
      fs.readdirSync(at, { withFileTypes: true }).map((e) => ({
        name: e.name,
        kind:
          scope && e.isSymbolicLink()
            ? 'junction'
            : e.isDirectory()
              ? 'directory'
              : e.isFile()
                ? 'file'
                : 'other',
      }));
    const sortedEntries = (rows) => rows.map((e) => JSON.stringify(e)).sort();
    function watchDirectory(at, expected, entries) {
      if (
        !Array.isArray(expected) ||
        expected.length !== 3 ||
        !expected.every((v) => typeof v === 'string' && /^-?[0-9]+$/.test(v)) ||
        hash(directoryId(at)) !== hash(expected)
      )
        fail('REFERENCE_SHORTCUT_DIRECTORY_IDENTITY_CHANGED');
      if (
        entries &&
        hash(sortedEntries(entriesAt(at))) !== hash(sortedEntries(entries))
      )
        fail('REFERENCE_SHORTCUT_DIRECTORY_CHANGED');
      if (hash(directoryId(at)) !== hash(expected))
        fail('REFERENCE_SHORTCUT_DIRECTORY_IDENTITY_CHANGED');
      const prior = directoryWatches.get(at);
      if (prior && hash(prior.identity) !== hash(expected))
        fail('REFERENCE_SHORTCUT_DIRECTORY_IDENTITY_CHANGED');
      directoryWatches.set(at, {
        identity: expected,
        entries: entries || prior?.entries,
      });
    }
    const watchLimits = new Map();
    function watch(at, required = true, limit = 8 * 1024 ** 2) {
      const s = exists(at);
      if (!s) {
        if (required) fail('REFERENCE_SOURCE_MISSING');
        if (watched.has(at) && watched.get(at) !== null)
          fail('REFERENCE_SOURCE_CHANGED_DURING_QUERY');
        watched.set(at, null);
        return;
      }
      const value = bytes(at, limit);
      const current = {
        digest: digest(value),
        identity: identity(fs.lstatSync(at, { bigint: true })),
      };
      if (watched.has(at) && hash(watched.get(at)) !== hash(current))
        fail('REFERENCE_SOURCE_CHANGED_DURING_QUERY');
      watched.set(at, current);
      watchLimits.set(at, Math.max(watchLimits.get(at) || 0, limit));
      return value;
    }
    function watchPinned(spec, limit = 1024 * 1024) {
      if (!spec || !hex(spec.sha256)) fail('REFERENCE_PIN_REQUIRED');
      const value = watch(canonical(spec.path), true, limit);
      if (digest(value) !== spec.sha256) fail('REFERENCE_PIN_CHANGED');
      return value;
    }
    function packageAt(at) {
      at = canonical(at);
      const root = roots.find((r) => inside(r, at));
      if (!root) fail('REFERENCE_PACKAGE_OUTSIDE_SCOPE');
      let dir = fs.statSync(at).isDirectory() ? at : path.dirname(at);
      for (
        let depth = 0;
        depth < 64 && inside(root, dir);
        depth++, dir = path.dirname(dir)
      ) {
        const mfile = path.join(dir, 'release.json');
        if (exists(mfile)) {
          const mbytes = watch(mfile),
            m = JSON.parse(mbytes.toString('utf8'));
          if (
            m.format !== 1 ||
            !/^[a-f0-9]{40}$/.test(m.sourceCommit || '') ||
            m.id !== path.basename(dir) ||
            !policy.protectedIds.includes(m.id) ||
            !hex(policy.packageProofs?.[m.id]) ||
            policy.packageProofs[m.id] !== digest(mbytes)
          )
            fail('REFERENCE_PACKAGE_UNAPPROVED');
          const out = { packageId: m.id, packagePath: dir };
          manifests.set(dir, { m, out });
          return out;
        }
        if (same(dir, root)) break;
      }
      fail('REFERENCE_PACKAGE_UNRESOLVED');
    }
    const packages = cfg.packages.map((spec) => {
      const ref = packageAt(spec.path);
      if (
        ref.packageId !== spec.id ||
        !same(ref.packagePath, canonical(spec.path))
      )
        fail('REFERENCE_PACKAGE_BINDING_INVALID');
      return ref;
    });
    if (
      new Set(packages.map((p) => p.packagePath)).size !== packages.length ||
      policy.protectedIds.some(
        (id) => !packages.some((p) => p.packageId === id),
      )
    )
      fail('REFERENCE_PACKAGE_COVERAGE_INCOMPLETE');
    function record(kind, ref, detail) {
      result.records.push({ kind, ...ref, ...detail });
      if (result.records.length > 4096) fail('REFERENCE_RECORD_LIMIT');
    }
    function pointer(file) {
      const raw = watch(file),
        value = JSON.parse(raw.toString('utf8'));
      if (
        value.format !== 1 ||
        typeof value.id !== 'string' ||
        !/^[A-Za-z0-9T.Z-]+$/.test(value.id)
      )
        fail('REFERENCE_POINTER_INVALID');
      const ref = packageAt(path.join(path.dirname(file), value.id));
      record('pointers', ref, {
        pointerPath: canonical(file),
        identity: hash([
          canonical(file),
          digest(raw),
          watched.get(file).identity,
        ]),
      });
      return ref;
    }
    const pointers = new Map();
    for (const root of roots) {
      const file = path.join(root, 'active.json');
      if (watch(file, false)) pointers.set(file, pointer(file));
    }
    const launchers = cfg.launchers.map((l) => {
      if (
        !Array.isArray(l.argv) ||
        l.argv.length < 2 ||
        !l.argv.every((v) => typeof v === 'string') ||
        !Array.isArray(l.files) ||
        l.files.length < 1 ||
        l.files.length > 128 ||
        !l.argv.some((v) => same(v, l.entry)) ||
        !l.files.some((f) => same(f.path, l.entry))
      )
        fail('REFERENCE_LAUNCHER_INVALID');
      for (const f of l.files) {
        watchPinned(f);
      }
      watchPinned(l.executable, 256 * 1024 ** 2);
      if (!same(canonical(l.argv[0]), canonical(l.executable.path)))
        fail('REFERENCE_LAUNCHER_EXECUTABLE_CHANGED');
      const ptr = canonical(l.pointerPath);
      if (!pointers.has(ptr)) fail('REFERENCE_LAUNCHER_POINTER_UNRESOLVED');
      return {
        ...l,
        ref: pointers.get(ptr),
        cwd: canonical(l.workingDirectory),
      };
    });
    const harmlessActions = cfg.harmlessActions || [];
    const emptyStartupActions = [];
    const disclosedEmptyCwd = (a) =>
      scope &&
      a.kind === 'shortcuts' &&
      a.workingDirectory === '' &&
      a.uninspectedWorkingDirectory === true &&
      a.backgroundDbAccessExcluded === false;
    if (!Array.isArray(harmlessActions) || harmlessActions.length > 64)
      fail('REFERENCE_HARMLESS_ACTION_POLICY_INVALID');
    for (const action of harmlessActions) {
      if (
        !['tasks', 'shortcuts'].includes(action.kind) ||
        !Array.isArray(action.argv) ||
        !action.argv.length ||
        !action.argv.every((v) => typeof v === 'string') ||
        !same(canonical(action.argv[0]), canonical(action.executable?.path))
      )
        fail('REFERENCE_HARMLESS_ACTION_POLICY_INVALID');
      watchPinned(action.executable, 256 * 1024 ** 2);
      if (!disclosedEmptyCwd(action)) canonical(action.workingDirectory);
      else {
        const s = action.shortcut;
        if (
          !s ||
          s.workingDirectory !== '' ||
          s.target !== action.argv[0] ||
          hash([s.target, ...argv(s.arguments)]) !== hash(action.argv)
        )
          fail('REFERENCE_HARMLESS_ACTION_POLICY_INVALID');
        watchPinned({ path: s.path, sha256: s.sha256 });
      }
    }
    const relevantText = (text) =>
      typeof text === 'string' &&
      [...roots, ...cfg.launchers.map((l) => path.dirname(l.entry))].some(
        (root) =>
          text.toLowerCase().includes(root.toLowerCase()) ||
          text
            .replaceAll('\\', '/')
            .toLowerCase()
            .includes(root.replaceAll('\\', '/').toLowerCase()),
      );
    function pathReference(token, cwd) {
      if (typeof token !== 'string') fail('REFERENCE_COMMAND_INVALID');
      const at = path.isAbsolute(token)
        ? token
        : cwd
          ? path.resolve(cwd, token)
          : undefined;
      if (at && exists(at)) {
        const resolved = canonical(at);
        if (roots.some((root) => inside(root, resolved)))
          return packageAt(resolved);
      }
      if (relevantText(token)) fail('REFERENCE_COMMAND_PATH_UNRESOLVED');
    }
    function resolveInvocation(
      tokens,
      cwd,
      isProcess = false,
      kind = 'tasks',
      allowDatabaseArgument = false,
      sourceShortcut,
    ) {
      const launch = launchers.find(
        (l) =>
          hash(tokens) === hash(l.argv) &&
          (cwd
            ? same(canonical(cwd), l.cwd)
            : isProcess && l.cwdIndependent === true),
      );
      if (launch)
        return [
          {
            ...launch.ref,
            ...(isProcess
              ? {}
              : {
                  viaPointer: {
                    path: canonical(launch.pointerPath),
                    launcherSha256: hash(launch.files),
                  },
                }),
          },
        ];
      if (
        /^(cmd|powershell|pwsh)(\.exe)?$/i.test(
          path.basename(tokens[0] || ''),
        ) &&
        tokens.some((t) =>
          /^(\/c|\/k|-c|-command|-encodedcommand|-enc)$/i.test(t),
        )
      )
        fail('REFERENCE_SHELL_COMMAND_UNRESOLVED');
      const refs = new Map();
      for (const token of tokens) {
        // The exact identity-bound current runtime names the retained live DB
        // as data. A data-root file is not a release package. No other process
        // or task obtains this interpretation.
        if (allowDatabaseArgument && same(token, policy.publication.database))
          continue;
        const ref = pathReference(token, cwd);
        if (ref) refs.set(ref.packagePath, ref);
      }
      const host = path.basename(tokens[0] || '').toLowerCase();
      if (
        tokens.some((t) =>
          /^(-file|-f|-command|-encodedcommand|-enc|--eval|-e|\/c|\/k|\/\/e:.*)$/i.test(
            t,
          ),
        )
      )
        fail('REFERENCE_INDIRECT_LAUNCHER_UNREVIEWED');
      // An outside script can refer to any package without naming that package
      // in argv. Do not read/execute it to guess its meaning. Only an exact
      // reviewed launcher mapping, or a direct entry in an approved package,
      // can establish a script reference.
      if (
        /^(powershell|pwsh|cmd|wscript|cscript|mshta|rundll32|regsvr32)(\.exe)?$/.test(
          host,
        )
      )
        fail('REFERENCE_INDIRECT_LAUNCHER_UNREVIEWED');
      if (
        tokens.some((t) => /\.(ps1|psm1|vbs|vbe|wsf|wsh|bat|cmd|jse)$/i.test(t))
      )
        fail('REFERENCE_INDIRECT_LAUNCHER_UNREVIEWED');
      const scriptTokens = tokens.filter((t) =>
        /\.(ps1|psm1|vbs|vbe|js|jse|wsf|wsh|bat|cmd|cjs|mjs|py|pyw|pl|rb|sh)$/i.test(
          t,
        ),
      );
      for (const token of scriptTokens)
        if (!pathReference(token, cwd))
          fail('REFERENCE_INDIRECT_LAUNCHER_UNREVIEWED');
      if (
        /^(node|nodejs|python[0-9.]*|pythonw|py|perl|ruby|bash|sh|zsh|deno|bun)(\.exe)?$/.test(
          host,
        ) &&
        !scriptTokens.length
      )
        fail('REFERENCE_INDIRECT_LAUNCHER_UNREVIEWED');
      const cwdRef = cwd ? pathReference(cwd) : undefined;
      if (cwdRef) refs.set(cwdRef.packagePath, cwdRef);
      if ((tokens.some(relevantText) || relevantText(cwd)) && !refs.size)
        fail('REFERENCE_LAUNCHER_UNRESOLVED');
      if (
        !isProcess &&
        !refs.size &&
        !harmlessActions.some(
          (a) =>
            a.kind === kind &&
            hash(a.argv) === hash(tokens) &&
            (cwd
              ? same(canonical(cwd), canonical(a.workingDirectory))
              : cwd === '' &&
                disclosedEmptyCwd(a) &&
                hash(a.shortcut) === hash(sourceShortcut)),
        )
      )
        fail('REFERENCE_APPLICATION_ACTION_UNREVIEWED');
      return [...refs.values()];
    }
    for (const file of cfg.rollbackFiles) {
      const raw = watchPinned(file),
        doc = JSON.parse(raw.toString('utf8'));
      if (
        doc.format !== 1 ||
        !Array.isArray(doc.packages) ||
        !doc.packages.length ||
        doc.packages.length > 3
      )
        fail('REFERENCE_ROLLBACK_DOCUMENT_INVALID');
      for (const p of doc.packages) {
        const ref = packageAt(p.path);
        if (p.id !== ref.packageId) fail('REFERENCE_ROLLBACK_BINDING_INVALID');
        record('rollback', ref, {
          identity: hash([canonical(file.path), digest(raw), ref.packagePath]),
        });
      }
    }
    result.categories.pointers = result.categories.rollback = true;
    const proofRaw = watchPinned(cfg.compatibilityProof),
      proof = JSON.parse(proofRaw.toString('utf8'));
    if (
      digest(proofRaw) !== policy.compatibilityProofSha256 ||
      proof.format !== 1 ||
      proof.kind !== 'additive-schema-unknown-claim-rollback' ||
      proof.businessDatabaseRestored !== false ||
      [
        'additiveSchema',
        'unknownClaimsPreserved',
        'businessRowsPreserved',
        'rollbackStarted',
      ].some((k) => proof.checks?.[k] !== true)
    )
      fail('REFERENCE_COMPATIBILITY_UNPROVEN');
    for (const role of ['candidate', 'rollback']) {
      const p = proof[role];
      if (
        !p ||
        !policy.protectedIds.includes(p.id) ||
        policy.packageProofs[p.id] !== p.manifestSha256 ||
        !packages.some(
          (ref) =>
            ref.packageId === p.id &&
            manifests.get(ref.packagePath).m.sourceCommit === p.sourceCommit,
        )
      )
        fail('REFERENCE_COMPATIBILITY_BINDING_INVALID');
    }
    result.compatibility = {
      verified: true,
      businessDatabaseRestored: false,
      proofSha256: digest(proofRaw),
    };
    stage = 'processes';
    const processContract = operationProcessContract(policy);
    function processMap(list) {
      if (!Array.isArray(list) || list.length > 8192)
        fail('REFERENCE_PROCESS_QUERY_INVALID');
      const map = new Map();
      for (const p of list) {
        if (
          !Number.isInteger(p.pid) ||
          p.pid < 0 ||
          map.has(p.pid) ||
          !Number.isInteger(p.parentPid)
        )
          fail('REFERENCE_PROCESS_QUERY_INVALID');
        if (
          [0, 4].includes(p.pid) &&
          ['System Idle Process', 'System'].includes(p.name) &&
          !p.executable &&
          !p.commandLine
        )
          continue;
        if (
          (!processContract && (!p.executable || !p.commandLine)) ||
          typeof p.startUtc !== 'string' ||
          !Number.isFinite(Date.parse(p.startUtc))
        )
          fail('REFERENCE_PROCESS_VISIBILITY_INCOMPLETE');
        map.set(p.pid, p);
      }
      return map;
    }
    const before = processMap(native.processesBefore),
      after = processMap(native.processesAfter),
      matched = new Map();
    if (self) {
      stage = 'collector-chain';
      result.collectorChain = collectorChain(before, after, callerPid, self);
      for (const row of result.collectorChain) {
        before.delete(row.pid);
        after.delete(row.pid);
      }
    }
    stage = 'processes';
    const processView = processContract
      ? operationProcessView(policy, native, before, after, callerPid)
      : null;
    const approvedAuxiliary = (p) =>
      processView &&
      (policy.publication.expectedChildren || []).some(
        (e) =>
          p.pid === e.pid &&
          p.parentPid === e.parentPid &&
          p.executable === e.executable &&
          p.commandLine === e.commandLine,
      );
    // Win32_Process CreationDate has microsecond precision; the publication
    // helper separately verifies the exact .NET100ns creation identity/handle.
    const approvedParent = (p) =>
      processView &&
      p.pid === policy.publication.expected.pid &&
      (p.startUtc === policy.publication.expected.startUtc ||
        p.startUtc ===
          policy.publication.expected.startUtc.replace(
            /(\.\d{6})\dZ$/,
            '$10Z',
          )) &&
      p.executable === policy.publication.expected.executable &&
      p.commandLine === policy.publication.expected.commandLine;
    for (const p of before.values()) {
      if (processView && !processView.related.has(p.pid)) continue;
      const refs = approvedAuxiliary(p)
        ? []
        : resolveInvocation(
            argv(p.commandLine),
            p.workingDirectory,
            true,
            'tasks',
            approvedParent(p),
          );
      const executableRef = pathReference(p.executable);
      if (
        executableRef &&
        !refs.some((r) => same(r.packagePath, executableRef.packagePath))
      )
        refs.push(executableRef);
      if (refs.length) matched.set(p.pid, refs);
    }
    for (let pass = 0; pass < before.size; pass++) {
      let changed = false;
      for (const p of before.values())
        if (!matched.has(p.pid) && matched.has(p.parentPid)) {
          matched.set(p.pid, matched.get(p.parentPid));
          changed = true;
        }
      if (!changed) break;
    }
    if (processView)
      for (const pid of processView.related) {
        if (before.has(pid) && !matched.has(pid))
          fail('REFERENCE_ASSOCIATED_PROCESS_UNRESOLVED');
      }
    for (const [pid, refs] of matched) {
      const p = before.get(pid),
        current = after.get(pid);
      if (!current || hash(p) !== hash(current)) {
        result.uncertainChildren.push(pid);
        fail('REFERENCE_PROCESS_CHANGED');
      }
      const exe = canonical(p.executable),
        executableSha256 = digest(watch(exe, true, 256 * 1024 ** 2));
      for (const ref of refs)
        record('processes', ref, {
          pid,
          startUtc: p.startUtc,
          executableSha256,
          identity: hash([
            pid,
            p.parentPid,
            p.startUtc,
            exe,
            executableSha256,
            p.commandLine,
          ]),
        });
    }
    for (const p of after.values())
      if (
        !matched.has(p.pid) &&
        (!processView || processView.related.has(p.pid))
      ) {
        const refs = resolveInvocation(
          argv(p.commandLine),
          p.workingDirectory,
          true,
        );
        if (
          refs.length ||
          pathReference(p.executable) ||
          matched.has(p.parentPid)
        ) {
          result.uncertainChildren.push(p.pid);
          fail('REFERENCE_PROCESS_APPEARED');
        }
      }
    result.categories.processes = !processView;
    stage = 'tasks';
    if (
      !Array.isArray(native.tasks) ||
      native.tasks.length > 8192 ||
      !Array.isArray(native.shortcuts) ||
      native.shortcuts.length > 8192 ||
      !Array.isArray(native.tasksAfter) ||
      hash(native.tasks) !== hash(native.tasksAfter) ||
      !Array.isArray(native.shortcutCoverage) ||
      [
        'Desktop',
        'CommonDesktop',
        'StartMenu',
        'CommonStartMenu',
        'Startup',
        'CommonStartup',
      ].some(
        (k) =>
          !native.shortcutCoverage.some(
            (r) =>
              r.kind === k &&
              (['enumerated', 'absent'].includes(r.status) ||
                (scope &&
                  staticKinds.includes(k) &&
                  r.status === 'not-inspected-operation-scope')),
          ),
      )
    )
      fail('REFERENCE_HOST_COVERAGE_INCOMPLETE');
    const junctions = scope ? native.operationCoverage.staticJunctions : [];
    if (!Array.isArray(junctions) || junctions.length)
      fail('REFERENCE_STATIC_JUNCTION_INVALID');
    if (
      native.shortcutCoverage.length !== 6 ||
      new Set(native.shortcutCoverage.map((c) => c.kind)).size !== 6 ||
      !Array.isArray(native.shortcutDirectories)
    )
      fail('REFERENCE_HOST_COVERAGE_INCOMPLETE');
    for (const coverage of native.shortcutCoverage) {
      if (scope && staticKinds.includes(coverage.kind)) {
        if (coverage.status !== 'not-inspected-operation-scope')
          fail('REFERENCE_STATIC_SCOPE_INVALID');
        continue;
      }
      if (
        typeof coverage.path !== 'string' ||
        !path.isAbsolute(coverage.path) ||
        path.resolve(coverage.path) !== coverage.path
      )
        fail('REFERENCE_HOST_COVERAGE_INCOMPLETE');
      if (coverage.status === 'absent') {
        const ancestor = coverage.ancestor;
        if (
          !ancestor ||
          typeof ancestor.path !== 'string' ||
          !path.isAbsolute(ancestor.path) ||
          same(ancestor.path, coverage.path) ||
          !inside(ancestor.path, coverage.path)
        )
          fail('REFERENCE_HOST_COVERAGE_INCOMPLETE');
        watchDirectory(ancestor.path, ancestor.identity);
        if (exists(coverage.path))
          fail('REFERENCE_SHORTCUT_ABSENT_DIRECTORY_APPEARED');
        absentDirectories.add(coverage.path);
      } else {
        const snapshot = native.shortcutDirectories.find((d) =>
          same(d.path, coverage.path),
        );
        if (!snapshot || hash(snapshot.identity) !== hash(coverage.identity))
          fail('REFERENCE_HOST_COVERAGE_INCOMPLETE');
        watchDirectory(coverage.path, coverage.identity);
      }
    }
    const uninspectedStaticScopes = scope
      ? operationStaticScopes(
          native.shortcutCoverage.filter((c) => staticKinds.includes(c.kind)),
        )
      : null;
    const taskContract = operationTaskContract(policy);
    const taskPins = new Map(
      (taskContract?.backgroundActions || []).map((r) => [
        JSON.stringify([r.taskIdentity, r.actionIndex]),
        r,
      ]),
    );
    const taskBackground = [];
    const taskNeedles = [
      ...policy.roots.map((r) => r.path),
      ...cfg.launchers.flatMap((l) => [l.entry, ...l.files.map((f) => f.path)]),
      policy.publication?.database,
      path.basename(policy.publication?.database || ''),
    ]
      .filter(Boolean)
      .map((s) => s.replaceAll('\\', '/').toLowerCase());
    const seenTasks = new Set();
    for (const t of native.tasks) {
      if (!t.identity || !Array.isArray(t.actions) || !t.actions.length)
        fail('REFERENCE_TASK_INVALID');
      if (seenTasks.has(t.identity) || t.actions.length > 64)
        fail('REFERENCE_TASK_INVALID');
      seenTasks.add(t.identity);
      for (const [index, action] of t.actions.entries()) {
        const pin = taskPins.get(JSON.stringify([t.identity, index]));
        if (pin) {
          const row = taskActionTuple(t, index);
          const text = [t.identity, ...Object.values(action)]
            .filter((v) => typeof v === 'string')
            .map((v) => v.replaceAll('\\', '/').toLowerCase())
            .join('\n');
          if (taskNeedles.some((n) => text.includes(n)))
            fail('REFERENCE_BACKGROUND_TASK_BECAME_ASSOCIATED');
          if (hash(row) !== hash(pin))
            fail('REFERENCE_BACKGROUND_TASK_CHANGED');
          taskBackground.push(row);
          continue;
        }
        if (
          typeof action.execute !== 'string' ||
          !action.execute ||
          typeof action.arguments !== 'string'
        )
          fail('REFERENCE_TASK_ACTION_UNRESOLVED');
        const tokens = [action.execute, ...argv(action.arguments)];
        for (const ref of resolveInvocation(tokens, action.workingDirectory))
          record('tasks', ref, { identity: hash([t.identity, action]) });
      }
    }
    if (taskBackground.length !== taskPins.size)
      fail('REFERENCE_BACKGROUND_TASK_BINDING_NOT_OBSERVED');
    result.categories.tasks = !taskContract;
    if (
      !Array.isArray(native.shortcutDirectories) ||
      native.shortcutDirectories.length > 4096
    )
      fail('REFERENCE_SHORTCUT_DIRECTORY_QUERY_INCOMPLETE');
    for (const dir of native.shortcutDirectories) {
      if (
        !Array.isArray(dir.entries) ||
        !native.shortcutCoverage.some(
          (c) => c.status === 'enumerated' && inside(c.path, dir.path),
        )
      )
        fail('REFERENCE_SHORTCUT_DIRECTORY_INVALID');
      watchDirectory(dir.path, dir.identity, dir.entries);
      for (const e of dir.entries) {
        if (e.kind === 'junction') fail('REFERENCE_STATIC_JUNCTION_INVALID');
        if (
          e.kind === 'directory' &&
          !native.shortcutDirectories.some((child) =>
            same(child.path, path.join(dir.path, e.name)),
          )
        )
          fail('REFERENCE_SHORTCUT_DIRECTORY_QUERY_INCOMPLETE');
        if (
          e.kind === 'file' &&
          path.extname(e.name).toLowerCase() === '.lnk' &&
          !native.shortcuts.some((s) =>
            same(s.path, path.join(dir.path, e.name)),
          )
        )
          fail('REFERENCE_SHORTCUT_DIRECTORY_QUERY_INCOMPLETE');
      }
    }
    stage = 'shortcuts';
    const pinnedShortcuts = scope
      ? cfg.launchers
          .flatMap((l) => l.files)
          .filter((f) => path.extname(f.path).toLowerCase() === '.lnk')
      : [];
    if (
      scope &&
      pinnedShortcuts.some(
        (p) => !native.shortcuts.some((s) => same(s.path, p.path)),
      )
    )
      fail('REFERENCE_PINNED_SHORTCUT_QUERY_INCOMPLETE');
    for (const s of native.shortcuts) {
      if (
        scope &&
        !pinnedShortcuts.some(
          (p) => typeof s.path === 'string' && same(p.path, s.path),
        ) &&
        !native.shortcutCoverage.some(
          (c) =>
            ['Startup', 'CommonStartup'].includes(c.kind) &&
            c.status === 'enumerated' &&
            typeof s.path === 'string' &&
            inside(c.path, s.path),
        )
      )
        fail('REFERENCE_SHORTCUT_OUTSIDE_OPERATION_SCOPE');
      if (
        !s.path ||
        !s.target ||
        typeof s.arguments !== 'string' ||
        !hex(s.sha256)
      )
        fail('REFERENCE_SHORTCUT_INVALID');
      const actual = digest(watch(s.path));
      if (actual !== s.sha256) fail('REFERENCE_SHORTCUT_CHANGED');
      const emptyAction = harmlessActions.find(
        (a) => disclosedEmptyCwd(a) && hash(a.shortcut) === hash(s),
      );
      if (emptyAction)
        emptyStartupActions.push({
          ...s,
          executable: emptyAction.executable,
          uninspectedWorkingDirectory: true,
          backgroundDbAccessExcluded: false,
        });
      for (const ref of resolveInvocation(
        [s.target, ...argv(s.arguments)],
        s.workingDirectory,
        false,
        'shortcuts',
        false,
        s,
      ))
        record('shortcuts', ref, {
          identity: hash([
            s.path,
            actual,
            s.target,
            s.arguments,
            s.workingDirectory,
          ]),
        });
    }
    result.categories.shortcuts = !scope;
    if (
      emptyStartupActions.length !==
      harmlessActions.filter(disclosedEmptyCwd).length
    )
      fail('REFERENCE_STARTUP_ACTION_BINDING_NOT_OBSERVED');
    // The querying controller owns the scope lock. Its changing in-progress
    // intent is checked, but is not an external reference to its own output.
    stage = 'inflight';
    const registry = canonical(policy.registryDirectory),
      prefix = path.join(registry, policy.scopeId);
    const lockRaw = watch(prefix + '.lock'),
      lock = JSON.parse(lockRaw.toString('utf8'));
    if (
      lock.pid !== callerPid ||
      !Number.isInteger(callerPid) ||
      !before.has(callerPid) ||
      !after.has(callerPid) ||
      before.get(callerPid).startUtc !== after.get(callerPid).startUtc ||
      lock.configSha !== native.policySha256 ||
      typeof lock.nonce !== 'string' ||
      !lock.nonce
    )
      fail('REFERENCE_CONTROLLER_OWNER_UNCERTAIN');
    function envelope(file) {
      const raw = watch(file),
        doc = JSON.parse(raw.toString('utf8'));
      if (!doc.payload || hash(doc.payload) !== doc.digest)
        fail('REFERENCE_INFLIGHT_STATE_CORRUPT');
      return doc.payload;
    }
    const ledgerFile = prefix + '.state.json',
      ledger = envelope(ledgerFile);
    if (ledger.configSha !== lock.configSha || !Array.isArray(ledger.outputs))
      fail('REFERENCE_INFLIGHT_STATE_INVALID');
    if (ledger.continuation || policy.preCopyContinuation) {
      if (
        !ledger.complete &&
        (ledger.claim?.kind !== 'install' ||
          ledger.continuationAttempt?.nonce !== lock.nonce ||
          ledger.continuationAttempt.status !== 'running')
      )
        fail('REFERENCE_CONTINUATION_OWNER_UNCERTAIN');
      const authority =
        require('./once-pair-admission.cjs').validateContinuation(
          policy,
          ledger,
          lock.configSha,
        );
      for (const pin of authority.files) watchPinned(pin);
    }
    if (
      ledger.claim &&
      (typeof ledger.claim.id !== 'string' ||
        !ledger.claim.id ||
        typeof ledger.claim.root !== 'string' ||
        !roots.some((r) => inside(r, canonical(ledger.claim.root))) ||
        !Array.isArray(ledger.claim.outputs) ||
        ledger.claim.outputs.some(
          (at) =>
            !ledger.outputs.some(
              (o) => o.path === at && o.claim === ledger.claim.id,
            ),
        ))
    )
      fail('REFERENCE_INFLIGHT_STATE_INVALID');
    for (const o of ledger.outputs) {
      if (!path.isAbsolute(o.path) || !roots.some((r) => inside(r, o.path)))
        fail('REFERENCE_INFLIGHT_PATH_UNRESOLVED');
      if (
        !o.complete &&
        (!ledger.claim ||
          o.claim !== ledger.claim.id ||
          !ledger.claim.outputs.includes(o.path))
      )
        fail('REFERENCE_FOREIGN_INFLIGHT_CLAIM');
    }
    for (const root of roots) {
      const build = path.join(root, '.build-budget.lock');
      const raw = watch(build, false);
      if (raw) {
        const b = JSON.parse(raw.toString('utf8'));
        if (b.pid !== callerPid || typeof b.token !== 'string' || !b.token)
          fail('REFERENCE_FOREIGN_BUILD_OWNER');
      }
      const lifecycle = path.join(root, '.release-lifecycle.json');
      if (exists(lifecycle)) {
        const state = envelope(lifecycle);
        if (
          !Array.isArray(state.managedIds) ||
          state.managedIds.some((id) => !policy.protectedIds.includes(id)) ||
          !state.roles ||
          ['current', 'candidate', 'rollback'].some(
            (role) => !state.managedIds.includes(state.roles[role]),
          ) ||
          state.roles.rollback !== proof.rollback.id
        )
          fail('REFERENCE_UNREVIEWED_ROLLBACK_ROLE');
      } else watch(lifecycle, false);
    }
    result.categories.inflight = true;
    stage = 'final-verification';
    for (const [at, expected] of watched) {
      if (
        expected === null
          ? !!exists(at)
          : digest(bytes(at, watchLimits.get(at))) !== expected.digest ||
            hash(identity(fs.lstatSync(at, { bigint: true }))) !==
              hash(expected.identity)
      )
        fail('REFERENCE_SOURCE_CHANGED_DURING_QUERY');
    }
    for (const [at, expected] of directoryWatches)
      watchDirectory(at, expected.identity, expected.entries);
    for (const at of absentDirectories)
      if (exists(at)) fail('REFERENCE_SHORTCUT_ABSENT_DIRECTORY_APPEARED');
    result.records.sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    );
    result.complete = !scope;
    result.globalReferenceComplete = !scope;
    if (scope) {
      result.operationSufficient = true;
      result.operationCoverage = {
        kind: operationKind,
        staticScopeMode: scope.staticScopeMode,
        contractSha256: hash(scope),
        startupComplete: true,
        pinnedLaunchersVerified: true,
        uninspectedProfiles: profileRows(
          native.operationCoverage.profilesAfter,
        ),
        uninspectedStaticScopes,
        uninspectedStaticJunctions: [],
        uninspectedStartupActions: emptyStartupActions,
        ...(processView ? { processCoverage: processView.summary } : {}),
        ...(taskContract
          ? {
              taskCoverage: {
                kind: taskKind,
                contractSha256: hash(taskContract),
                globalTaskInvocationCoverageComplete: false,
                backgroundDbAccessExcluded: false,
                backgroundActions: taskContract.backgroundActions,
              },
            }
          : {}),
      };
    }
  } catch (error) {
    // Keep private paths/command lines out of errors. Full raw host evidence is
    // never printed. A failed category is not silently declared empty.
    result.errors.push(
      /^REFERENCE_[A-Z_]+$/.test(error.message)
        ? error.message
        : 'REFERENCE_QUERY_FAILED',
    );
    result.referenceDiagnostic = referenceDiagnostic({
      stage,
      codes: [
        ...result.errors,
        error.message,
        ...(stage === 'native-validation' && Array.isArray(native?.errors)
          ? native.errors
          : []),
      ],
      ...(stage === 'native-validation'
        ? {
            nativeStage: native?.failureContext?.stage,
            nativeErrorId: native?.failureContext?.errorId,
            nativeCategory: native?.failureContext?.category,
          }
        : {}),
      complete: result.complete,
      operationSufficient: result.operationSufficient,
      globalReferenceComplete: result.globalReferenceComplete,
      categories: result.categories,
    });
  }
  return result;
}
function main(policyFile) {
  const policyBytes = bytes(canonical(policyFile)),
    policy = JSON.parse(policyBytes.toString('utf8'));
  const policyIdentity = identity(
    fs.lstatSync(canonical(policyFile), { bigint: true }),
  );
  const collector = path.join(
    __dirname,
    'windows-release-reference-collector.ps1',
  );
  if (process.platform !== 'win32') fail('REFERENCE_WINDOWS_REQUIRED');
  if (
    !policy.probe ||
    !same(canonical(policy.probe.path), canonical(__filename))
  )
    fail('REFERENCE_PROBE_PIN_REQUIRED');
  pinned(policy.probe);
  const probeIdentity = identity(
    fs.lstatSync(canonical(policy.probe.path), { bigint: true }),
  );
  const helper = path.join(
    __dirname,
    'windows-reference-directory-identity.cs',
  );
  if (
    policy.windowsReferences?.collectorIdentitySha256 !== digest(bytes(helper))
  )
    fail('REFERENCE_COLLECTOR_PIN_CHANGED');
  const collectorIdentity = identity(fs.lstatSync(collector, { bigint: true })),
    helperIdentity = identity(fs.lstatSync(helper, { bigint: true }));
  if (policy.windowsReferences?.collectorSha256 !== digest(bytes(collector)))
    fail('REFERENCE_COLLECTOR_PIN_CHANGED');
  const collectorExecutable = path.join(
    process.env.SystemRoot,
    'System32/WindowsPowerShell/v1.0/powershell.exe',
  );
  const collectorArgs = [
    '-NoProfile',
    '-NonInteractive',
    '-File',
    collector,
    '-PolicyFile',
    canonical(policyFile),
  ];
  const output = execFileSync(collectorExecutable, collectorArgs, {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 4 * 1024 ** 2,
  });
  const native = JSON.parse(output.replace(/^\uFEFF/, ''));
  if (
    native.policySha256 !== digest(policyBytes) ||
    digest(bytes(policyFile)) !== digest(policyBytes) ||
    hash(policyIdentity) !==
      hash(identity(fs.lstatSync(canonical(policyFile), { bigint: true })))
  )
    fail('REFERENCE_POLICY_CHANGED');
  pinned(policy.probe);
  if (policy.windowsReferences.collectorSha256 !== digest(bytes(collector)))
    fail('REFERENCE_COLLECTOR_PIN_CHANGED');
  if (
    hash(probeIdentity) !==
      hash(
        identity(fs.lstatSync(canonical(policy.probe.path), { bigint: true })),
      ) ||
    hash(collectorIdentity) !==
      hash(identity(fs.lstatSync(collector, { bigint: true }))) ||
    hash(helperIdentity) !==
      hash(identity(fs.lstatSync(helper, { bigint: true }))) ||
    policy.windowsReferences.collectorIdentitySha256 !== digest(bytes(helper))
  )
    fail('REFERENCE_COLLECTOR_PIN_CHANGED');
  const result = probe(policy, native, {
    self: {
      pid: process.pid,
      executable: process.execPath,
      argv: [process.execPath, process.argv[1], policyFile],
      collectorExecutable,
      collectorArgv: [collectorExecutable, ...collectorArgs],
      consoleExecutable: path.join(
        process.env.SystemRoot,
        'System32/conhost.exe',
      ),
      consoleArgv: [
        '\\??\\' + path.join(process.env.SystemRoot, 'System32/conhost.exe'),
        '0x4',
      ],
    },
  });
  // Recheck after resolution as well: configured immutable sources must not
  // change while the resolver performs its later filesystem checks.
  pinned(policy.probe);
  if (
    digest(bytes(policyFile)) !== digest(policyBytes) ||
    hash(policyIdentity) !==
      hash(identity(fs.lstatSync(canonical(policyFile), { bigint: true })))
  )
    fail('REFERENCE_POLICY_CHANGED');
  if (
    hash(probeIdentity) !==
      hash(
        identity(fs.lstatSync(canonical(policy.probe.path), { bigint: true })),
      ) ||
    policy.windowsReferences.collectorSha256 !== digest(bytes(collector)) ||
    hash(collectorIdentity) !==
      hash(identity(fs.lstatSync(collector, { bigint: true }))) ||
    policy.windowsReferences.collectorIdentitySha256 !==
      digest(bytes(helper)) ||
    hash(helperIdentity) !==
      hash(identity(fs.lstatSync(helper, { bigint: true })))
  )
    fail('REFERENCE_COLLECTOR_PIN_CHANGED');
  return result;
}
function cliResult(run) {
  try {
    return run();
  } catch (error) {
    return {
      complete: false,
      globalReferenceComplete: false,
      operationSufficient: false,
      categories: Object.fromEntries(kinds.map((k) => [k, false])),
      records: [],
      errors: [
        /^REFERENCE_[A-Z_]+$/.test(error.message)
          ? error.message
          : 'REFERENCE_NATIVE_QUERY_FAILED',
      ],
      uncertainChildren: [],
      referenceDiagnostic: referenceDiagnostic({
        stage: 'probe-main',
        codes: [error.message, 'REFERENCE_NATIVE_QUERY_FAILED'],
        transportCode: error.code,
        status: error.status,
      }),
    };
  }
}
if (require.main === module) {
  const value = cliResult(() => {
    if (process.argv.length !== 3) fail('REFERENCE_POLICY_ARGUMENT_REQUIRED');
    return main(process.argv[2]);
  });
  process.stdout.write(JSON.stringify(value) + '\n');
}
module.exports = {
  probe,
  argv,
  main,
  operationContract,
  operationProfiles: profileRows,
  operationStaticScopes,
  operationProcessContract,
  operationProcessView,
  operationProcessTuple: processTuple,
  validateOperationProcessSummary,
  collectorChain,
  taskActionTuple,
  operationTaskContract,
  validateOperationTaskSummary,
  validateOperationStartupSummary,
  referenceDiagnostic,
  cliResult,
};
