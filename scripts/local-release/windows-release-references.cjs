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
function consoleInvocation(tokens, executable) {
  return (
    tokens.length === 2 &&
    tokens[0].startsWith('\\??\\') &&
    same(tokens[0].slice(4), executable) &&
    /^0x[0-9a-f]{1,16}$/i.test(tokens[1])
  );
}
function probe(
  policy,
  native,
  { callerPid = process.ppid, self, recovery } = {},
) {
  const result = {
    complete: false,
    categories: Object.fromEntries(kinds.map((k) => [k, false])),
    records: [],
    errors: [],
    uncertainChildren: [],
  };
  try {
    const cfg = policy.windowsReferences;
    const applicability =
      require('./preserving-contract.cjs').referenceApplicability(policy);
    const { preserving, buildOnly } = applicability;
    const rootRoles = require('./preserving-contract.cjs').preservingRootRoles(
      policy,
    );
    const controlOnly = buildOnly && !!rootRoles;
    const projectOnly = applicability.projectOnly,
      narrowControl = controlOnly || projectOnly;
    const processFamily = policy.preservingUpdate?.processFamily?.format === 1;
    const effectScope =
      projectOnly &&
      require('./preserving-contract.cjs').preservingEffectScope(policy);
    if (controlOnly) {
      result.processObservation = 'build-control-only';
      result.categories.tasks = result.categories.shortcuts = 'not_applicable';
    }
    if (projectOnly) result.processObservation = 'preserving-project-only';
    if (
      !cfg ||
      cfg.format !== 1 ||
      !Array.isArray(cfg.packages) ||
      cfg.packages.length < 1 ||
      cfg.packages.length > 6 ||
      (!buildOnly &&
        (!Array.isArray(cfg.launchers) || cfg.launchers.length > 16)) ||
      !Array.isArray(cfg.rollbackFiles) ||
      cfg.rollbackFiles.length < 1 ||
      cfg.rollbackFiles.length > 16 ||
      !Array.isArray(policy.roots) ||
      !Array.isArray(policy.protectedIds)
    )
      fail('REFERENCE_POLICY_INVALID');
    if (
      !native ||
      (preserving
        ? native.format !== 2 ||
          native.complete !== false ||
          native.observationComplete !== true
        : native.format !== 1 || native.complete !== true) ||
      !Array.isArray(native.errors) ||
      native.errors.length ||
      ['processes', 'tasks', 'shortcuts'].some(
        (k) => native.categories?.[k] !== applicability.categories[k],
      )
    )
      fail('REFERENCE_NATIVE_QUERY_INCOMPLETE');
    const referenceRoots = rootRoles
      ? [...policy.roots, ...rootRoles.readOnlyRoots]
      : policy.roots;
    if (
      controlOnly &&
      (policy.roots.length !== 1 ||
        !same(
          canonical(policy.buildOnly?.outputRoot),
          canonical(policy.roots[0].path),
        ))
    )
      fail('REFERENCE_POLICY_INVALID');
    const roots = referenceRoots.map((r) => canonical(r.path));
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
        kind: e.isDirectory() ? 'directory' : e.isFile() ? 'file' : 'other',
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
    const consoleSpec =
      processFamily && policy.preservingUpdate.processFamily.consoleHost;
    let consolePath;
    if (consoleSpec) {
      consolePath = canonical(consoleSpec.path);
      if (
        process.platform !== 'win32' ||
        !same(
          consolePath,
          path.join(process.env.SystemRoot, 'System32/conhost.exe'),
        ) ||
        !Array.isArray(consoleSpec.argv) ||
        !consoleInvocation(consoleSpec.argv, consolePath) ||
        hash(identity(fs.lstatSync(consolePath, { bigint: true }))) !==
          hash(consoleSpec.identity)
      )
        fail('REFERENCE_PROBE_CHILD_UNCERTAIN');
      watchPinned(consoleSpec, 256 * 1024 ** 2);
    }
    if (rootRoles) {
      for (const root of rootRoles.readOnlyRoots)
        if (
          canonical(root.path) !== root.path ||
          hash(directoryId(root.path)) !== hash(root.identity)
        )
          fail('REFERENCE_PROTECTED_ROOT_CHANGED');
      for (const control of rootRoles.controls) {
        if (!rootRoles.readOnlyRoots.some((r) => inside(r.path, control.path)))
          fail('REFERENCE_CONTROL_OUTSIDE_PROTECTED_ROOT');
        require('./private-artifact-proof.cjs').verifyControl(control);
        watchPinned(control);
        const s = fs.lstatSync(control.path, { bigint: true });
        if (
          hash([s.dev, s.ino, s.birthtimeNs].map(String)) !==
          hash(control.identity)
        )
          fail('REFERENCE_CONTROL_CHANGED');
      }
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
    const launchers = (buildOnly ? [] : cfg.launchers).map((l) => {
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
      const fixed = l.packageId !== undefined;
      if (
        (!fixed || path.isAbsolute(l.argv[0])) &&
        !same(canonical(l.argv[0]), canonical(l.executable.path))
      )
        fail('REFERENCE_LAUNCHER_EXECUTABLE_CHANGED');
      let ref;
      if (fixed) {
        // Runtime invocations bind to immutable packages, not the active pointer.
        // A bare interpreter name is accepted only as an exact reviewed argv;
        // the actual process executable must still match its pinned path.
        if (l.pointerPath !== undefined) fail('REFERENCE_LAUNCHER_INVALID');
        ref = packages.find((p) => p.packageId === l.packageId);
        if (!ref || !same(packageAt(l.entry).packagePath, ref.packagePath))
          fail('REFERENCE_LAUNCHER_INVALID');
        if (
          l.parentEntry !== undefined &&
          !same(packageAt(l.parentEntry).packagePath, ref.packagePath)
        )
          fail('REFERENCE_LAUNCHER_INVALID');
      } else {
        if (l.parentEntry !== undefined) fail('REFERENCE_LAUNCHER_INVALID');
        const ptr = canonical(l.pointerPath);
        if (!pointers.has(ptr)) fail('REFERENCE_LAUNCHER_POINTER_UNRESOLVED');
        ref = pointers.get(ptr);
      }
      return {
        ...l,
        ref,
        invocationSha256: fixed ? hash(l) : undefined,
        cwd: canonical(l.workingDirectory),
      };
    });
    for (const l of launchers.filter((l) => l.packageId !== undefined)) {
      if (
        launchers.filter(
          (p) => p.packageId === l.packageId && same(p.entry, l.entry),
        ).length !== 1
      )
        fail('REFERENCE_LAUNCHER_INVALID');
      if (l.parentEntry !== undefined) {
        const parent = launchers.find(
          (p) => p.packageId === l.packageId && same(p.entry, l.parentEntry),
        );
        if (!parent || parent.parentEntry !== undefined)
          fail('REFERENCE_LAUNCHER_INVALID');
        l.parentInvocationSha256 = parent.invocationSha256;
      }
    }
    if (processFamily) {
      for (const id of [
        policy.preservingUpdate.active.currentId,
        policy.preservingUpdate.active.candidateId,
      ]) {
        if (
          launchers.filter(
            (l) => l.packageId === id && l.parentEntry === undefined,
          ).length !== 1
        )
          fail('REFERENCE_LAUNCHER_INVALID');
      }
    }
    const harmlessActions = buildOnly ? [] : cfg.harmlessActions || [];
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
      [
        ...roots,
        ...launchers.map((l) => path.dirname(l.entry)),
        ...(projectOnly ? launchers.map((l) => l.cwd) : []),
      ].some(
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
      processExecutable,
    ) {
      const launch = launchers.find(
        (l) =>
          (l.packageId === undefined || isProcess) &&
          hash(tokens) === hash(l.argv) &&
          (cwd
            ? same(canonical(cwd), l.cwd)
            : isProcess && l.cwdIndependent === true),
      );
      if (
        launch &&
        isProcess &&
        (!processExecutable ||
          !same(
            canonical(processExecutable),
            canonical(launch.executable.path),
          ))
      )
        fail('REFERENCE_LAUNCHER_EXECUTABLE_CHANGED');
      if (launch)
        return [
          {
            ...launch.ref,
            ...(launch.packageId === undefined
              ? {}
              : {
                  invocationSha256: launch.invocationSha256,
                  parentInvocationSha256: launch.parentInvocationSha256 || null,
                }),
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
    const rollbackIds = new Set();
    let proof;
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
        rollbackIds.add(ref.packageId);
        record('rollback', ref, {
          identity: hash([canonical(file.path), digest(raw), ref.packagePath]),
        });
      }
    }
    result.categories.pointers = result.categories.rollback = true;
    if (policy.phase === 'build-only') {
      result.compatibility = { stage: 'build-only', verified: false };
    } else {
      const proofRaw = watchPinned(cfg.compatibilityProof);
      proof = JSON.parse(proofRaw.toString('utf8'));
      const sameSchema = proof.kind === 'same-schema-unknown-claim-rollback';
      if (
        digest(proofRaw) !== policy.compatibilityProofSha256 ||
        proof.format !== 1 ||
        (!sameSchema &&
          proof.kind !== 'additive-schema-unknown-claim-rollback') ||
        proof.businessDatabaseRestored !== false ||
        [
          ...(sameSchema ? [] : ['additiveSchema']),
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
      if (sameSchema) {
        try {
          require('./preserving-contract.cjs').validateSameSchemaCompatibility(
            proof,
            policy,
            packages.map((ref) => ({
              root: ref.packagePath,
              manifest: manifests.get(ref.packagePath).m,
              manifestSha256: policy.packageProofs[ref.packageId],
            })),
          );
        } catch {
          fail('REFERENCE_COMPATIBILITY_UNPROVEN');
        }
      }
      result.compatibility = {
        verified: true,
        businessDatabaseRestored: false,
        proofSha256: digest(proofRaw),
      };
    }
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
          !narrowControl &&
          (!p.executable ||
            !p.commandLine ||
            typeof p.startUtc !== 'string' ||
            !Number.isFinite(Date.parse(p.startUtc)))
        )
          fail('REFERENCE_PROCESS_VISIBILITY_INCOMPLETE');
        map.set(p.pid, p);
      }
      return map;
    }
    const before = processMap(native.processesBefore),
      after = processMap(native.processesAfter),
      matched = new Map();
    const visible = (p) =>
      p &&
      typeof p.executable === 'string' &&
      !!p.executable &&
      typeof p.commandLine === 'string' &&
      !!p.commandLine &&
      typeof p.startUtc === 'string' &&
      Number.isFinite(Date.parse(p.startUtc));
    if (narrowControl) {
      if (!self) fail('REFERENCE_PROBE_IDENTITY_UNCERTAIN');
      for (const pid of [callerPid, self.pid]) {
        const p = before.get(pid),
          q = after.get(pid);
        if (!visible(p) || !visible(q) || hash(p) !== hash(q))
          fail('REFERENCE_PROCESS_VISIBILITY_INCOMPLETE');
        watch(canonical(p.executable), true, 256 * 1024 ** 2);
      }
    }
    if (self) {
      const p = before.get(self.pid),
        current = after.get(self.pid);
      if (
        !p ||
        !current ||
        (narrowControl && (!visible(p) || !visible(current))) ||
        p.parentPid !== callerPid ||
        hash(p) !== hash(current) ||
        !same(canonical(p.executable), canonical(self.executable)) ||
        hash(argv(p.commandLine)) !== hash(self.argv)
      )
        fail('REFERENCE_PROBE_IDENTITY_UNCERTAIN');
      const children = [...before.values()].filter(
        (p) => p.parentPid === self.pid,
      );
      const collectors = narrowControl
        ? children.filter(
            (p) =>
              visible(p) &&
              same(p.executable, self.collectorExecutable) &&
              hash(argv(p.commandLine)) === hash(self.collectorArgv),
          )
        : children;
      if (collectors.length !== 1) fail('REFERENCE_PROBE_CHILD_UNCERTAIN');
      const child = collectors[0];
      if (
        !after.has(child.pid) ||
        (narrowControl &&
          (!visible(child) || !visible(after.get(child.pid)))) ||
        hash(child) !== hash(after.get(child.pid)) ||
        !same(
          canonical(child.executable),
          canonical(self.collectorExecutable),
        ) ||
        hash(argv(child.commandLine)) !== hash(self.collectorArgv) ||
        (!narrowControl &&
          [...before.values(), ...after.values()].some(
            (p) =>
              p.parentPid === child.pid ||
              (p.parentPid === self.pid && p.pid !== child.pid),
          ))
      )
        fail('REFERENCE_PROBE_CHILD_UNCERTAIN');
      const consolePids = [];
      if (narrowControl) {
        const related = [...before.values(), ...after.values()];
        const hosts = new Set(
          related
            .filter(
              (p) =>
                (p.parentPid === self.pid && p.pid !== child.pid) ||
                p.parentPid === child.pid,
            )
            .map((p) => p.pid),
        );
        if (hosts.size) {
          if (!self.consoleHost || !Array.isArray(self.consoleHost.identity))
            fail('REFERENCE_PROBE_CHILD_UNCERTAIN');
          watchPinned(self.consoleHost, 256 * 1024 ** 2);
          if (
            hash(
              identity(
                fs.lstatSync(canonical(self.consoleHost.path), {
                  bigint: true,
                }),
              ),
            ) !== hash(self.consoleHost.identity)
          )
            fail('REFERENCE_PROBE_CHILD_UNCERTAIN');
          const byParent = new Set();
          for (const pid of hosts) {
            const p = before.get(pid),
              q = after.get(pid);
            if (
              !visible(p) ||
              !visible(q) ||
              hash(p) !== hash(q) ||
              byParent.has(p.parentPid) ||
              !same(
                canonical(p.executable),
                canonical(self.consoleHost.path),
              ) ||
              related.some((r) => r.parentPid === pid)
            )
              fail('REFERENCE_PROBE_CHILD_UNCERTAIN');
            const tokens = argv(p.commandLine),
              outputs = (
                controlOnly
                  ? [policy.buildOnly.outputRoot]
                  : effectScope.allocations.map((a) => a.path)
              ).map((p) => p.replaceAll('\\', '/').toLowerCase());
            if (
              !consoleInvocation(tokens, canonical(self.consoleHost.path)) ||
              [p.executable, p.commandLine, p.workingDirectory].some(
                (t) =>
                  typeof t === 'string' &&
                  outputs.some((output) =>
                    t.replaceAll('\\', '/').toLowerCase().includes(output),
                  ),
              )
            )
              fail('REFERENCE_PROBE_CHILD_UNCERTAIN');
            byParent.add(p.parentPid);
            consolePids.push(pid);
          }
        }
      }
      // Only this bound query invocation and its proven system console hosts
      // are transient. Arbitrary query descendants remain refused.
      for (const pid of [self.pid, child.pid, ...consolePids]) {
        before.delete(pid);
        after.delete(pid);
      }
    }
    if (processFamily) {
      // Topology only, never unrelated argv or executable paths. Exit confirmation
      // uses both observations to reject PID reuse and newly orphaned children.
      result.processTopology = [before, after].flatMap((sample, phase) =>
        [...sample.values()].map(({ pid, parentPid }) => ({
          pid,
          parentPid,
          phase,
        })),
      );
      result.exitedProcesses = [];
      result.consoleProcesses = [];
      result.exitedConsoleProcesses = [];
    }
    const consoleRows = new Set();
    if (consoleSpec) {
      for (const p of before.values()) {
        if (
          !visible(p) ||
          !same(p.executable, consolePath) ||
          !consoleInvocation(argv(p.commandLine), consolePath) ||
          hash(argv(p.commandLine)) !== hash(consoleSpec.argv)
        )
          continue;
        const current = after.get(p.pid);
        if (current && hash(p) !== hash(current)) continue;
        const row = {
          pid: p.pid,
          parentPid: p.parentPid,
          startUtc: p.startUtc,
          executableSha256: consoleSpec.sha256,
          consoleHost: true,
          invocationSha256: hash(consoleSpec),
          identity: hash([
            p.pid,
            p.parentPid,
            p.startUtc,
            canonical(p.executable),
            consoleSpec.sha256,
            p.commandLine,
          ]),
        };
        (current
          ? result.consoleProcesses
          : result.exitedConsoleProcesses
        ).push(row);
        consoleRows.add(p.pid);
      }
    }
    if (!controlOnly) {
      for (const p of before.values()) {
        if (consoleRows.has(p.pid)) continue;
        if (
          projectOnly &&
          p.pid !== policy.preservingUpdate.active.oldProcess.pid &&
          ![p.executable, p.commandLine, p.workingDirectory].some(relevantText)
        )
          continue;
        if (projectOnly && !visible(p))
          fail('REFERENCE_PROCESS_VISIBILITY_INCOMPLETE');
        const refs = resolveInvocation(
          argv(p.commandLine),
          p.workingDirectory,
          true,
          undefined,
          p.executable,
        );
        const executableRef = pathReference(p.executable);
        if (
          executableRef &&
          !refs.some((r) => same(r.packagePath, executableRef.packagePath))
        )
          refs.push(executableRef);
        if (refs.length) {
          if (processFamily && (refs.length !== 1 || !refs[0].invocationSha256))
            fail('REFERENCE_PROCESS_FAMILY_UNREVIEWED');
          matched.set(p.pid, refs);
        }
      }
      for (let pass = 0; pass < before.size; pass++) {
        let changed = false;
        for (const p of before.values())
          if (!matched.has(p.pid) && matched.has(p.parentPid)) {
            if (processFamily && !consoleRows.has(p.pid))
              fail('REFERENCE_PROCESS_FAMILY_UNREVIEWED');
            matched.set(p.pid, matched.get(p.parentPid));
            changed = true;
          }
        if (!changed) break;
      }
      for (const [pid, refs] of matched) {
        const p = before.get(pid),
          current = after.get(pid);
        if (
          projectOnly &&
          (!visible(p) ||
            (processFamily ? current && !visible(current) : !visible(current)))
        )
          fail('REFERENCE_PROCESS_VISIBILITY_INCOMPLETE');
        if (
          (!current && !processFamily) ||
          (current && hash(p) !== hash(current))
        ) {
          result.uncertainChildren.push(pid);
          fail('REFERENCE_PROCESS_CHANGED');
        }
        if (consoleRows.has(pid)) continue;
        const exe = canonical(p.executable),
          executableSha256 = digest(watch(exe, true, 256 * 1024 ** 2));
        for (const ref of refs)
          (current
            ? (detail) => record('processes', ref, detail)
            : (detail) =>
                result.exitedProcesses.push({
                  kind: 'processes',
                  ...ref,
                  ...detail,
                }))({
            pid,
            ...(processFamily ? { parentPid: p.parentPid } : {}),
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
          if (
            projectOnly &&
            p.pid !== policy.preservingUpdate.active.oldProcess.pid &&
            !matched.has(p.parentPid) &&
            ![p.executable, p.commandLine, p.workingDirectory].some(
              relevantText,
            )
          )
            continue;
          if (projectOnly && !visible(p))
            fail('REFERENCE_PROCESS_VISIBILITY_INCOMPLETE');
          const refs = resolveInvocation(
            argv(p.commandLine),
            p.workingDirectory,
            true,
            undefined,
            p.executable,
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
    } else {
      // Only the bound control chain is claimed observed. All other host activity
      // remains outside this new-output-only operation's observation contract.
      const output = canonical(policy.buildOnly.outputRoot)
        .replaceAll('\\', '/')
        .toLowerCase();
      for (const p of [...before.values(), ...after.values()]) {
        if (p.pid === callerPid) continue;
        if (
          [p.executable, p.commandLine, p.workingDirectory].some(
            (t) =>
              typeof t === 'string' &&
              t.replaceAll('\\', '/').toLowerCase().includes(output),
          )
        )
          fail('REFERENCE_PROCESS_APPEARED');
      }
    }
    result.categories.processes = true;
    const relevantTask = (t) =>
      effectScope.taskIdentities.includes(t?.identity) ||
      (Array.isArray(t?.actions) &&
        t.actions.some((a) =>
          [a.execute, a.arguments, a.workingDirectory].some(relevantText),
        ));
    const taskRows = buildOnly
      ? []
      : projectOnly && Array.isArray(native.tasks)
        ? native.tasks.filter(relevantTask)
        : native.tasks;
    const taskRowsAfter = buildOnly
      ? []
      : projectOnly && Array.isArray(native.tasksAfter)
        ? native.tasksAfter.filter(relevantTask)
        : native.tasksAfter;
    if (
      (!buildOnly &&
        (!Array.isArray(native.tasks) ||
          native.tasks.length > 8192 ||
          !Array.isArray(native.tasksAfter) ||
          hash(taskRows) !== hash(taskRowsAfter))) ||
      (!buildOnly &&
        (!Array.isArray(native.shortcuts) || native.shortcuts.length > 8192))
    )
      fail('REFERENCE_HOST_COVERAGE_INCOMPLETE');
    if (
      !preserving &&
      (!Array.isArray(native.shortcutCoverage) ||
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
                r.kind === k && ['enumerated', 'absent'].includes(r.status),
            ),
        ))
    )
      fail('REFERENCE_HOST_COVERAGE_INCOMPLETE');
    if (
      !preserving &&
      (native.shortcutCoverage.length !== 6 ||
        new Set(native.shortcutCoverage.map((c) => c.kind)).size !== 6 ||
        !Array.isArray(native.shortcutDirectories))
    )
      fail('REFERENCE_HOST_COVERAGE_INCOMPLETE');
    for (const coverage of preserving ? [] : native.shortcutCoverage) {
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
    for (const t of buildOnly ? [] : taskRows) {
      if (
        projectOnly &&
        !effectScope.taskIdentities.includes(t.identity) &&
        !t.actions?.some((a) =>
          [a.execute, a.arguments, a.workingDirectory].some(relevantText),
        )
      )
        continue;
      if (projectOnly && !effectScope.taskIdentities.includes(t.identity))
        fail('REFERENCE_TASK_INVALID');
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
    if (
      projectOnly &&
      effectScope.taskIdentities.some(
        (id) => !taskRows.some((t) => t.identity === id),
      )
    )
      fail('REFERENCE_TASK_INVALID');
    result.categories.tasks = applicability.categories.tasks;
    if (
      !preserving &&
      (!Array.isArray(native.shortcutDirectories) ||
        native.shortcutDirectories.length > 4096)
    )
      fail('REFERENCE_SHORTCUT_DIRECTORY_QUERY_INCOMPLETE');
    for (const dir of preserving ? [] : native.shortcutDirectories) {
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
    for (const s of preserving ? [] : native.shortcuts) {
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
    result.categories.shortcuts = preserving ? 'not_applicable' : true;
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
    if (recovery !== undefined) {
      // Read-only bridge for the exact old claim while the same controller owns
      // the new-policy lock. Ordinary observations still require all three pins.
      const refuse = () => fail('REFERENCE_INFLIGHT_STATE_INVALID');
      const checked = (at, wanted, limit = 1024 * 1024) => {
        if (
          !hex(wanted) ||
          canonical(at) !== at ||
          require('./scope-inventory.cjs').isPrivatePath(at)
        )
          refuse();
        const s = fs.lstatSync(at, { bigint: true });
        if (s.nlink !== 1n) refuse();
        const raw = watch(at, true, limit);
        if (digest(raw) !== wanted) refuse();
        return raw;
      };
      if (
        !recovery ||
        Object.keys(recovery).sort().join(',') !==
          'approvalPath,approvalSha256,lockSha256,policyPath' ||
        !hex(recovery.lockSha256) ||
        digest(lockRaw) !== recovery.lockSha256 ||
        ledger.configSha === lock.configSha ||
        !projectOnly ||
        policy.format !== 2 ||
        policy.preservingUpdate.operation !== 'install'
      )
        refuse();
      const a = JSON.parse(
        checked(recovery.approvalPath, recovery.approvalSha256, 65536),
      );
      if (
        !a ||
        hash(Object.keys(a).sort()) !==
          hash(
            [
              'format',
              'kind',
              'scopeId',
              'registryDirectory',
              'registryIdentity',
              'oldPolicyPath',
              'oldPolicySha256',
              'newPolicySha256',
              'priorLedgerSha256',
              'priorPayloadDigest',
              'priorLedgerIdentity',
              'adoptionSha256',
              'auditedSourceIdentity',
              'reviewEvidence',
              'claimId',
              'claimSha256',
              'failureCode',
              'failureEvidencePath',
              'failureEvidenceSha256',
              'toolBinding',
              'probeBinding',
              'releasedBuildLock',
              'allowedDifferences',
            ].sort(),
          ) ||
        !/^[a-f0-9-]{36}$/.test(a.claimId || '') ||
        !hex(a.claimSha256)
      )
        refuse();
      const old = JSON.parse(checked(a.oldPolicyPath, a.oldPolicySha256));
      const current = JSON.parse(
        checked(recovery.policyPath, a.newPolicySha256),
      );
      const original = JSON.parse(
        checked(ledgerFile, a.priorLedgerSha256, 65536),
      );
      const stat = fs.lstatSync(ledgerFile, { bigint: true });
      const claim = ledger.claim;
      if (
        a.format !== 1 ||
        a.kind !== 'interrupted-empty-install-claim-recovery' ||
        a.scopeId !== policy.scopeId ||
        a.registryDirectory !== registry ||
        hash(a.registryIdentity) !== hash(policy.registryIdentity) ||
        hash(directoryId(registry)) !== hash(policy.registryIdentity) ||
        a.newPolicySha256 !== native.policySha256 ||
        a.oldPolicySha256 !== ledger.configSha ||
        hash(current) !== hash(policy) ||
        old.scopeId !== policy.scopeId ||
        old.format !== 2 ||
        original.digest !== hash(original.payload) ||
        original.digest !== a.priorPayloadDigest ||
        hash(original.payload) !== hash(ledger) ||
        ledger.format !== 2 ||
        ledger.bindingRepair ||
        hash(a.priorLedgerIdentity) !==
          hash([stat.dev, stat.ino, stat.birthtimeNs].map(String)) ||
        !Array.isArray(ledger.outputs) ||
        ledger.outputs.length ||
        !claim ||
        claim.id !== a.claimId ||
        hash(claim) !== a.claimSha256 ||
        claim.kind !== 'install' ||
        claim.root !== effectScope.container ||
        !Number.isSafeInteger(claim.reserveBytes) ||
        claim.reserveBytes < 1 ||
        claim.runtimeCopies !== 1 ||
        !hex(claim.refs) ||
        !Array.isArray(claim.outputs) ||
        claim.outputs.length ||
        a.failureCode !== 'RELEASE_SCOPE_SCAN_TIME_BUDGET' ||
        typeof a.reviewEvidence !== 'string' ||
        !a.reviewEvidence
      )
        refuse();
      if (
        checked(ledgerFile + '.adopted', a.adoptionSha256, 64).toString(
          'utf8',
        ) !== a.oldPolicySha256
      )
        refuse();
      watchDirectory(registry, policy.registryIdentity);
      checked(a.failureEvidencePath, a.failureEvidenceSha256);
      const budget = {
        profile: 'legacy-stream-v1',
        checkpointMode: 'full',
        scanEntries: 100000,
        operationEntries: 1000000,
        scanReadBytes: 1073741824,
        operationReadBytes: 2147483648,
        durationMs: 300000,
      };
      if (
        Object.hasOwn(old, 'scanBudget') ||
        !policy.scanBudget ||
        Object.keys(policy.scanBudget).length !== Object.keys(budget).length ||
        Object.entries(budget).some(([k, v]) => policy.scanBudget[k] !== v)
      )
        refuse();
      const pin = a.toolBinding,
        observer = a.probeBinding;
      if (
        !pin ||
        pin.path !== canonical(path.join(__dirname, 'release-scope.cjs')) ||
        Object.keys(pin).sort().join(',') !== 'newSha256,oldSha256,path' ||
        !hex(pin.oldSha256) ||
        pin.oldSha256 === pin.newSha256 ||
        a.auditedSourceIdentity !== pin.newSha256 ||
        !observer ||
        hash(observer.old) !== hash(old.probe) ||
        hash(observer.new) !== hash(policy.probe) ||
        Object.keys(observer).sort().join(',') !== 'new,old' ||
        policy.probe.path !== canonical(__filename) ||
        old.probe.path !== policy.probe.path ||
        !hex(old.probe.sha256) ||
        old.probe.sha256 === policy.probe.sha256
      )
        refuse();
      checked(pin.path, pin.newSha256);
      checked(policy.probe.path, policy.probe.sha256);
      const ps = fs.lstatSync(policy.probe.path, { bigint: true });
      if (
        hash(policy.probe.identity) !==
        hash([ps.dev, ps.ino, ps.size, ps.mtimeNs, ps.ctimeNs].map(String))
      )
        refuse();
      if (
        hash({
          ...policy.probe,
          sha256: old.probe.sha256,
          identity: old.probe.identity,
        }) !== hash(old.probe)
      )
        refuse();
      const matches = [];
      old.windowsReferences.launchers.forEach((l, i) =>
        l.files.forEach((f, j) => {
          if (f.path === pin.path) matches.push([i, j]);
        }),
      );
      if (matches.length !== 1) refuse();
      const [i, j] = matches[0],
        restored = structuredClone(policy),
        previous = old.windowsReferences.launchers[i],
        next = policy.windowsReferences.launchers[i];
      if (
        !previous.pointerPath ||
        previous.packageId !== undefined ||
        previous.files[j].sha256 !== pin.oldSha256 ||
        next.files[j].sha256 !== pin.newSha256
      )
        refuse();
      restored.windowsReferences.launchers[i].files[j].sha256 = pin.oldSha256;
      delete restored.scanBudget;
      restored.probe = structuredClone(old.probe);
      if (
        hash(restored) !== hash(old) ||
        hash(a.allowedDifferences) !==
          hash([
            'scanBudget',
            `windowsReferences.launchers.${i}.files.${j}.sha256`,
            'probe.sha256',
            'probe.identity',
          ])
      )
        refuse();
      const released = a.releasedBuildLock,
        writer = path.join(__dirname, 'install-lifecycle.cjs');
      if (
        !released ||
        !Number.isInteger(released.ownerPidDigits) ||
        released.ownerPidDigits < 1 ||
        released.ownerPidDigits > 10 ||
        Object.keys(released).sort().join(',') !==
          'ownerPidDigits,writerSha256' ||
        previous.files.some(
          (f) => f.path === writer && f.sha256 !== released.writerSha256,
        )
      )
        refuse();
      checked(writer, released.writerSha256);
      const extra = Buffer.byteLength(
        JSON.stringify({
          pid: 10 ** (released.ownerPidDigits - 1),
          token: '00000000-0000-0000-0000-000000000000',
        }),
      );
      if (
        claim.startBytes !== policy.baseline.bytes + extra ||
        claim.startRuntimeCopies !== policy.baseline.runtimeCopies
      )
        refuse();
      for (const p of [
        path.join(effectScope.container, '.build-budget.lock'),
        path.join(path.dirname(effectScope.container), '.active-release.lock'),
      ])
        if (watch(p, false)) refuse();
      for (const allocation of effectScope.allocations) {
        if (allocation.mode !== 'exclusive-package' || exists(allocation.path))
          refuse();
        absentDirectories.add(allocation.path);
      }
    } else if (
      ledger.configSha !== lock.configSha ||
      !Array.isArray(ledger.outputs)
    )
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
          (policy.phase === 'build-only'
            ? !rollbackIds.has(state.roles.rollback)
            : state.roles.rollback !== proof.rollback.id)
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
    if (preserving) result.observationComplete = true;
    else result.complete = true;
  } catch (error) {
    // Keep private paths/command lines out of errors. Full raw host evidence is
    // never printed. A failed category is not silently declared empty.
    result.errors.push(
      require('./reference-diagnostics.cjs').safeReason(error.message),
    );
  }
  return result;
}
function main(policyFile, recovery) {
  const policyBytes = bytes(canonical(policyFile)),
    policy = JSON.parse(policyBytes.toString('utf8'));
  require('./preserving-contract.cjs').referenceApplicability(policy);
  require('./preserving-contract.cjs').preservingRootRoles(policy);
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
  const applicability =
    require('./preserving-contract.cjs').referenceApplicability(policy);
  const controlOnly =
    (applicability.buildOnly &&
      !!require('./preserving-contract.cjs').preservingRootRoles(policy)) ||
    applicability.projectOnly;
  const hostPath = controlOnly
    ? canonical(path.join(process.env.SystemRoot, 'System32/conhost.exe'))
    : undefined;
  if (
    controlOnly &&
    !same(hostPath, path.join(process.env.SystemRoot, 'System32/conhost.exe'))
  )
    fail('REFERENCE_COLLECTOR_PIN_CHANGED');
  const consoleHost = controlOnly
    ? {
        path: hostPath,
        sha256: digest(bytes(hostPath, 256 * 1024 ** 2)),
        identity: identity(fs.lstatSync(hostPath, { bigint: true })),
      }
    : undefined;
  const collectorArgs = [
    '-NoProfile',
    '-NonInteractive',
    '-File',
    collector,
    '-PolicyFile',
    canonical(policyFile),
  ];
  let output;
  try {
    output = execFileSync(collectorExecutable, collectorArgs, {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 20000,
      maxBuffer: 4 * 1024 ** 2,
    });
  } catch (error) {
    fail(require('./reference-diagnostics.cjs').collectorFailure(error));
  }
  let native;
  try {
    native = JSON.parse(output.replace(/^\uFEFF/, ''));
  } catch {
    fail('REFERENCE_NATIVE_OUTPUT_INVALID');
  }
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
  if (
    consoleHost &&
    (digest(bytes(hostPath, 256 * 1024 ** 2)) !== consoleHost.sha256 ||
      hash(identity(fs.lstatSync(hostPath, { bigint: true }))) !==
        hash(consoleHost.identity))
  )
    fail('REFERENCE_COLLECTOR_PIN_CHANGED');
  const result = probe(policy, native, {
    ...(recovery
      ? { recovery: { ...recovery, policyPath: canonical(policyFile) } }
      : {}),
    self: {
      pid: process.pid,
      executable: process.execPath,
      argv: [
        process.execPath,
        process.argv[1],
        policyFile,
        ...(recovery
          ? [
              '--empty-install-recovery',
              recovery.approvalPath,
              recovery.approvalSha256,
              recovery.lockSha256,
            ]
          : []),
      ],
      collectorExecutable,
      consoleHost,
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
function policyArguments(args) {
  if (
    args.length !== 3 &&
    (args.length !== 7 ||
      args[3] !== '--empty-install-recovery' ||
      !hex(args[5]) ||
      !hex(args[6]))
  )
    fail('REFERENCE_POLICY_ARGUMENT_REQUIRED');
  return {
    policyFile: args[2],
    recovery:
      args.length === 7
        ? {
            approvalPath: args[4],
            approvalSha256: args[5],
            lockSha256: args[6],
          }
        : undefined,
  };
}
if (require.main === module) {
  let value;
  try {
    const args = policyArguments(process.argv);
    value = main(args.policyFile, args.recovery);
  } catch (error) {
    value = {
      complete: false,
      categories: Object.fromEntries(kinds.map((k) => [k, false])),
      records: [],
      errors: [
        require('./reference-diagnostics.cjs').safeReason(error.message),
      ],
      uncertainChildren: [],
    };
  }
  process.stdout.write(JSON.stringify(value) + '\n');
}
module.exports = { probe, argv, main, policyArguments };
