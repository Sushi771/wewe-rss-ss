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
    if (
      !native ||
      native.format !== 1 ||
      (scope
        ? native.complete !== false ||
          native.operationSufficient !== true ||
          native.globalReferenceComplete !== false ||
          native.categories?.shortcuts !== false ||
          native.operationCoverage?.kind !== operationKind ||
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
    const roots = policy.roots.map((r) => canonical(r.path));
    const manifests = new Map(),
      watched = new Map();
    const directoryWatches = new Map(),
      absentDirectories = new Set();
    const junctionWatches = new Map();
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
      canonical(action.workingDirectory);
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
    function resolveInvocation(tokens, cwd, isProcess = false, kind = 'tasks') {
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
            cwd &&
            same(canonical(cwd), canonical(a.workingDirectory)),
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
          !p.executable ||
          !p.commandLine ||
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
      const p = before.get(self.pid),
        current = after.get(self.pid);
      if (
        !p ||
        !current ||
        p.parentPid !== callerPid ||
        hash(p) !== hash(current) ||
        !same(canonical(p.executable), canonical(self.executable)) ||
        hash(argv(p.commandLine)) !== hash(self.argv)
      )
        fail('REFERENCE_PROBE_IDENTITY_UNCERTAIN');
      const children = [...before.values()].filter(
        (p) => p.parentPid === self.pid,
      );
      if (children.length !== 1) fail('REFERENCE_PROBE_CHILD_UNCERTAIN');
      const child = children[0];
      if (
        !after.has(child.pid) ||
        hash(child) !== hash(after.get(child.pid)) ||
        !same(
          canonical(child.executable),
          canonical(self.collectorExecutable),
        ) ||
        hash(argv(child.commandLine)) !== hash(self.collectorArgv) ||
        [...before.values(), ...after.values()].some(
          (p) =>
            p.parentPid === child.pid ||
            (p.parentPid === self.pid && p.pid !== child.pid),
        )
      )
        fail('REFERENCE_PROBE_CHILD_UNCERTAIN');
      // Exactly this hash-pinned read-only invocation is transient. Every other
      // descendant is still retained, including children of the controller.
      for (const pid of [self.pid, child.pid]) {
        before.delete(pid);
        after.delete(pid);
      }
    }
    for (const p of before.values()) {
      const refs = resolveInvocation(
        argv(p.commandLine),
        p.workingDirectory,
        true,
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
      if (!matched.has(p.pid)) {
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
    result.categories.processes = true;
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
                  !['Startup', 'CommonStartup'].includes(k) &&
                  r.status === 'uninspected-static-junction')),
          ),
      )
    )
      fail('REFERENCE_HOST_COVERAGE_INCOMPLETE');
    const junctions = scope ? native.operationCoverage.staticJunctions : [];
    if (!Array.isArray(junctions) || junctions.length > 64)
      fail('REFERENCE_STATIC_JUNCTION_INVALID');
    for (const r of junctions) {
      if (
        !scope ||
        r.inspected !== false ||
        r.reason !== 'unrelated-static-junction' ||
        typeof r.path !== 'string' ||
        !path.isAbsolute(r.path) ||
        path.resolve(r.path) !== r.path ||
        native.shortcutCoverage.some(
          (c) =>
            ['Startup', 'CommonStartup'].includes(c.kind) &&
            inside(c.path, r.path),
        ) ||
        !native.shortcutCoverage.some(
          (c) =>
            !['Startup', 'CommonStartup'].includes(c.kind) &&
            inside(c.path, r.path),
        )
      )
        fail('REFERENCE_STATIC_JUNCTION_INVALID');
      const read = () => {
        const stat = fs.lstatSync(r.path, { bigint: true });
        if (!stat.isSymbolicLink()) fail('REFERENCE_STATIC_JUNCTION_CHANGED');
        return { identity: identity(stat), target: fs.readlinkSync(r.path) };
      };
      const snapshot = read();
      junctionWatches.set(r.path, { read, snapshot });
    }
    if (
      native.shortcutCoverage.length !== 6 ||
      new Set(native.shortcutCoverage.map((c) => c.kind)).size !== 6 ||
      !Array.isArray(native.shortcutDirectories)
    )
      fail('REFERENCE_HOST_COVERAGE_INCOMPLETE');
    for (const coverage of native.shortcutCoverage) {
      if (
        typeof coverage.path !== 'string' ||
        !path.isAbsolute(coverage.path) ||
        path.resolve(coverage.path) !== coverage.path
      )
        fail('REFERENCE_HOST_COVERAGE_INCOMPLETE');
      if (coverage.status === 'uninspected-static-junction') {
        if (!scope || !junctionWatches.has(coverage.path))
          fail('REFERENCE_STATIC_JUNCTION_INVALID');
      } else if (coverage.status === 'absent') {
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
    for (const t of native.tasks) {
      if (!t.identity || !Array.isArray(t.actions) || !t.actions.length)
        fail('REFERENCE_TASK_INVALID');
      for (const action of t.actions) {
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
    result.categories.tasks = true;
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
        if (
          e.kind === 'junction' &&
          (!scope || !junctionWatches.has(path.join(dir.path, e.name)))
        )
          fail('REFERENCE_STATIC_JUNCTION_INVALID');
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
    for (const s of native.shortcuts) {
      if (
        !s.path ||
        !s.target ||
        typeof s.arguments !== 'string' ||
        !hex(s.sha256)
      )
        fail('REFERENCE_SHORTCUT_INVALID');
      const actual = digest(watch(s.path));
      if (actual !== s.sha256) fail('REFERENCE_SHORTCUT_CHANGED');
      for (const ref of resolveInvocation(
        [s.target, ...argv(s.arguments)],
        s.workingDirectory,
        false,
        'shortcuts',
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
    // The querying controller owns the scope lock. Its changing in-progress
    // intent is checked, but is not an external reference to its own output.
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
    for (const value of junctionWatches.values())
      if (hash(value.read()) !== hash(value.snapshot))
        fail('REFERENCE_STATIC_JUNCTION_CHANGED');
    result.complete = !scope;
    result.globalReferenceComplete = !scope;
    if (scope) {
      result.operationSufficient = true;
      result.operationCoverage = {
        kind: operationKind,
        contractSha256: hash(scope),
        startupComplete: true,
        pinnedLaunchersVerified: true,
        uninspectedProfiles: profileRows(
          native.operationCoverage.profilesAfter,
        ),
        uninspectedStaticJunctions: [...junctionWatches]
          .map(([at, v]) => ({
            path: at,
            inspected: false,
            reason: 'unrelated-static-junction',
            ...v.snapshot,
          }))
          .sort((a, b) => a.path.localeCompare(b.path)),
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
if (require.main === module) {
  let value;
  try {
    if (process.argv.length !== 3) fail('REFERENCE_POLICY_ARGUMENT_REQUIRED');
    value = main(process.argv[2]);
  } catch {
    value = {
      complete: false,
      globalReferenceComplete: false,
      operationSufficient: false,
      categories: Object.fromEntries(kinds.map((k) => [k, false])),
      records: [],
      errors: ['REFERENCE_NATIVE_QUERY_FAILED'],
      uncertainChildren: [],
    };
  }
  process.stdout.write(JSON.stringify(value) + '\n');
}
module.exports = {
  probe,
  argv,
  main,
  operationContract,
  operationProfiles: profileRows,
};
