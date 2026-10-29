// Versioned operation contract; full reference policy remains the default.
// This validator alone does not authorize a write or substitute for observations.
const path = require('node:path');
const hex = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function validatePreservingContract(policy, request) {
  const spec = policy.preservingUpdate;
  if (spec === undefined) return null;
  if (!spec || spec.format !== 1 || !['build', 'install', 'restart'].includes(spec.operation) ||
      spec.operation !== request.kind || !Array.isArray(spec.effects) ||
      spec.effects.some((v) => typeof v !== 'string') || new Set(spec.effects).size !== spec.effects.length)
    throw new Error('RELEASE_PRESERVING_CONTRACT_INVALID');
  if (spec.operation === 'build') {
    if (policy.phase !== 'build-only' || request.buildOnly !== true || request.transition ||
        spec.effects.length !== 1 || spec.effects[0] !== 'new-output-only')
      throw new Error('RELEASE_PRESERVING_EFFECT_FORBIDDEN');
  } else {
    const allowed = spec.operation === 'install' ? ['new-output-only'] : ['new-output-only', 'approved-active-switch'];
    if (policy.phase === 'build-only' || spec.effects.length !== allowed.length ||
        allowed.some((e) => !spec.effects.includes(e)) ||
        !spec.active || typeof spec.active.pointer !== 'string' ||
        !path.isAbsolute(spec.active.pointer) || path.basename(spec.active.pointer) !== 'active.json' ||
        typeof spec.active.currentId !== 'string' || !/^[A-Za-z0-9T.Z-]+$/.test(spec.active.currentId) ||
        typeof spec.active.candidateId !== 'string' || !/^[A-Za-z0-9T.Z-]+$/.test(spec.active.candidateId) ||
        !hex(spec.active.pointerSha256) || !hex(spec.active.currentManifestSha256) ||
        !hex(spec.active.candidateManifestSha256) ||
        !Number.isInteger(spec.active.oldProcess?.pid) || spec.active.oldProcess.pid < 1 ||
        typeof spec.active.oldProcess.startUtc !== 'string' || !spec.active.oldProcess.startUtc ||
        !hex(spec.active.oldProcess.executableSha256))
      throw new Error('RELEASE_PRESERVING_EFFECT_FORBIDDEN');
  }
  return spec;
}
function validateSameSchema(oldManifest, candidateManifest, packages = {}) {
  const fs = require('node:fs'), crypto = require('node:crypto');
  const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
  const schema = 'server/prisma/schema.prisma', migrations = 'server/prisma/migrations/';
  const relevant = (name) => name === schema || name.startsWith(migrations);
  const validName = (name) => !name.includes('\\') && !name.includes(':') &&
    !name.split('/').some((part) => !part || part === '.' || part === '..');
  function collect(manifest) {
    if (manifest?.format !== 1 || manifest.schemaCompatibility !== 'current' || !manifest.files || !manifest.links)
      throw new Error('RELEASE_PRESERVING_SCHEMA_UNPROVEN');
    const entries = Object.entries(manifest.files).filter(([name]) => relevant(name))
      .sort(([a], [b]) => a.localeCompare(b));
    if (!entries.some(([name]) => name === schema) || !entries.some(([name]) => name.startsWith(migrations)) ||
        entries.some(([name, digest]) => !validName(name) || !hex(digest)) ||
        Object.keys(manifest.links).some((name) => relevant(name) || name === 'server' ||
          name === 'server/prisma' || name === 'server/prisma/migrations'))
      throw new Error('RELEASE_PRESERVING_SCHEMA_UNPROVEN');
    return entries;
  }
  const oldEntries = collect(oldManifest), candidateEntries = collect(candidateManifest);
  if (JSON.stringify(oldEntries) === JSON.stringify(candidateEntries))
    return { format: 1, comparison: 'raw-sha256', files: oldEntries.map(([name, rawSha256]) => ({ name, rawSha256 })) };
  if (JSON.stringify(oldEntries.map(([name]) => name)) !== JSON.stringify(candidateEntries.map(([name]) => name)) ||
      !packages.oldRoot || !packages.candidateRoot)
    throw new Error('RELEASE_PRESERVING_SCHEMA_CHANGED');

  // Only the unequal-hash path reads packages. Callers still perform full release
  // verification. Each manifest pin and every schema/migration byte is rechecked
  // here; no migration file or database checksum is rewritten.
  const checks = [];
  const identity = (s) => [s.dev, s.ino, s.mode, s.nlink, s.size, s.mtimeMs, s.ctimeMs, s.birthtimeMs].join(':');
  function snapshot(file, directory = false) {
    const s = fs.lstatSync(file);
    if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1))
      throw new Error('RELEASE_PRESERVING_SCHEMA_UNPROVEN');
    const stamp = identity(s);
    checks.push(() => {
      const after = fs.lstatSync(file);
      if (after.isSymbolicLink() || identity(after) !== stamp)
        throw new Error('RELEASE_PRESERVING_SCHEMA_UNPROVEN');
    });
    return s;
  }
  function read(file) {
    const before = snapshot(file);
    if (before.size > 8 * 1024 * 1024) throw new Error('RELEASE_PRESERVING_SCHEMA_UNPROVEN');
    const fd = fs.openSync(file, 'r');
    try {
      if (identity(fs.fstatSync(fd)) !== identity(before)) throw new Error('RELEASE_PRESERVING_SCHEMA_UNPROVEN');
      const bytes = fs.readFileSync(fd);
      if (identity(fs.fstatSync(fd)) !== identity(before)) throw new Error('RELEASE_PRESERVING_SCHEMA_UNPROVEN');
      return bytes;
    } finally { fs.closeSync(fd); }
  }
  function utf8(bytes) {
    // ignoreBOM=true means preserve U+FEFF, rather than strip it. Fatal decoding
    // rejects invalid UTF-8; round-trip equality also preserves all original bytes.
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('RELEASE_PRESERVING_SCHEMA_UNPROVEN');
    return text;
  }
  function inspect(root, manifest, entries, manifestSha256) {
    if (!path.isAbsolute(root) || !hex(manifestSha256)) throw new Error('RELEASE_PRESERVING_SCHEMA_UNPROVEN');
    snapshot(root, true);
    if (path.resolve(fs.realpathSync.native(root)).toLowerCase() !== path.resolve(root).toLowerCase())
      throw new Error('RELEASE_PRESERVING_SCHEMA_UNPROVEN');
    const manifestBytes = read(path.join(root, 'release.json'));
    if (hash(manifestBytes) !== manifestSha256 || JSON.stringify(JSON.parse(utf8(manifestBytes))) !== JSON.stringify(manifest))
      throw new Error('RELEASE_PRESERVING_SCHEMA_UNPROVEN');
    for (const name of ['server', 'server/prisma']) snapshot(path.join(root, name), true);
    const names = [schema];
    function walk(name) {
      const folder = path.join(root, name); snapshot(folder, true);
      const children = fs.readdirSync(folder).sort();
      if (children.length > 4096 || names.length > 4096) throw new Error('RELEASE_PRESERVING_SCHEMA_UNPROVEN');
      for (const child of children) {
        const relative = name + '/' + child, file = path.join(root, relative), s = fs.lstatSync(file);
        if (!validName(relative) || s.isSymbolicLink()) throw new Error('RELEASE_PRESERVING_SCHEMA_UNPROVEN');
        if (s.isDirectory()) walk(relative);
        else if (s.isFile()) names.push(relative);
        else throw new Error('RELEASE_PRESERVING_SCHEMA_UNPROVEN');
      }
    }
    walk('server/prisma/migrations');
    names.sort((a, b) => a.localeCompare(b));
    if (JSON.stringify(names) !== JSON.stringify(entries.map(([name]) => name)))
      throw new Error('RELEASE_PRESERVING_SCHEMA_UNPROVEN');
    return entries.map(([name, rawSha256]) => {
      const bytes = read(path.join(root, name));
      if (hash(bytes) !== rawSha256) throw new Error('RELEASE_PRESERVING_SCHEMA_UNPROVEN');
      const normalized = Buffer.from(utf8(bytes).replace(/\r\n/g, '\n'), 'utf8');
      return { name, rawSha256, normalized, normalizedSha256: hash(normalized) };
    });
  }
  try {
    const old = inspect(packages.oldRoot, oldManifest, oldEntries, packages.oldManifestSha256);
    const candidate = inspect(packages.candidateRoot, candidateManifest, candidateEntries, packages.candidateManifestSha256);
    if (old.some((row, i) => !row.normalized.equals(candidate[i].normalized)))
      throw new Error('RELEASE_PRESERVING_SCHEMA_CHANGED');
    checks.forEach((check) => check());
    return { format: 1, comparison: 'crlf-to-lf-only',
      oldManifestSha256: packages.oldManifestSha256, candidateManifestSha256: packages.candidateManifestSha256,
      files: old.map((row, i) => ({ name: row.name, oldRawSha256: row.rawSha256,
        candidateRawSha256: candidate[i].rawSha256, normalizedSha256: row.normalizedSha256 })) };
  } catch (error) {
    if (error.message === 'RELEASE_PRESERVING_SCHEMA_CHANGED') throw error;
    throw new Error('RELEASE_PRESERVING_SCHEMA_UNPROVEN');
  }
}
function validateActiveBinding(spec, observation) {
  const p = spec?.active, o = observation;
  if (!p || !o || o.pointerSha256 !== p.pointerSha256 || o.pointerId !== p.currentId ||
      o.currentId !== p.currentId || o.candidateId !== p.candidateId ||
      o.currentManifestSha256 !== p.currentManifestSha256 || o.candidateManifestSha256 !== p.candidateManifestSha256 ||
      o.process?.pid !== p.oldProcess?.pid || o.process?.startUtc !== p.oldProcess?.startUtc ||
      o.process?.executableSha256 !== p.oldProcess?.executableSha256)
    throw new Error('RELEASE_PRESERVING_ACTIVE_BINDING_CHANGED');
}
function referenceApplicability(policy) {
  const spec = policy.preservingUpdate;
  const validated = spec === undefined ? null : validatePreservingContract(policy, {
    kind: spec?.operation, buildOnly: policy.phase === 'build-only', transition: false,
  });
  const preserving = validated !== null;
  const buildOnly = preserving && validated.operation === 'build';
  const projectOnly = !!preservingEffectScope(policy);
  return { preserving, buildOnly, projectOnly, categories: {
    processes: true, tasks: buildOnly ? 'not_applicable' : true,
    shortcuts: preserving ? 'not_applicable' : true,
    pointers: true, rollback: true, inflight: true,
  } };
}
function preservingEffectScope(policy) {
  const spec = policy.preservingUpdate, effects = spec?.effectScope;
  if (effects === undefined) return null;
  const invalid = () => { throw new Error('RELEASE_PRESERVING_EFFECT_SCOPE_INVALID'); };
  if (!spec || !['install', 'restart'].includes(spec.operation) || policy.format !== 2 || policy.phase !== undefined) invalid();
  validatePreservingContract(policy, { kind: spec.operation });
  if (effects.format !== 1 || Object.keys(effects).some((key) => !['format','container','allocations','taskIdentities','lifecycleSha256'].includes(key)) ||
      !Array.isArray(policy.roots) || effects.container !== path.dirname(spec.active.pointer) ||
      !policy.roots?.some((r) => r.path === effects.container) ||
      !Array.isArray(effects.allocations) || effects.allocations.length !== 1 ||
      !Array.isArray(effects.taskIdentities) || effects.taskIdentities.length > 16 ||
      new Set(effects.taskIdentities).size !== effects.taskIdentities.length ||
      effects.taskIdentities.some((v) => typeof v !== 'string' || !v || v.length > 260 || /[\0\r\n]/.test(v)) ||
      !(effects.lifecycleSha256 === null || hex(effects.lifecycleSha256))) invalid();
  const allocation = effects.allocations[0];
  if (!allocation || Object.keys(allocation).some((key) => !['path','mode'].includes(key)) || !path.isAbsolute(allocation.path || '') || path.resolve(allocation.path) !== allocation.path ||
      !policy.roots.some((r) => { const rel = path.relative(r.path, allocation.path); return !rel || !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel); })) invalid();
  if (spec.operation === 'install' ? allocation.mode !== 'exclusive-package' || allocation.path !== path.join(effects.container, spec.active.candidateId) :
      allocation.mode !== 'audit-children' || effects.container === allocation.path || allocation.path.startsWith(effects.container + path.sep)) invalid();
  return effects;
}
function preservingRootRoles(policy) {
  const roles=policy.preservingUpdate?.rootRoles;
  if(roles===undefined)return null;
  if(!referenceApplicability(policy).buildOnly || policy.format!==2 || roles.format!==1 ||
    !Array.isArray(roles.readOnlyRoots) || roles.readOnlyRoots.length<1 || roles.readOnlyRoots.length>8 ||
    !Array.isArray(roles.controls) || roles.controls.length<1 || roles.controls.length>16 ||
    roles.readOnlyRoots.some(r=>!r || !path.isAbsolute(r.path||'') || !Array.isArray(r.identity) || r.identity.length!==3 || r.identity.some(x=>typeof x!=='string')) ||
    roles.controls.some(r=>!r || !path.isAbsolute(r.path||'') || require('./scope-inventory.cjs').isPrivatePath(r.path) || !hex(r.sha256) || !Array.isArray(r.identity) || r.identity.length!==3 || r.identity.some(x=>typeof x!=='string')))
    throw new Error('RELEASE_PRESERVING_ROOT_ROLES_INVALID');
  return roles;
}
// Both callers supply manifests already bound by the existing physical-package
// verifier. This proof is restricted to the approved preserving pair; it never
// claims that a same-schema update performed an additive migration.
function validateSameSchemaCompatibility(proof, policy, packages) {
  const spec = policy.preservingUpdate;
  const invalid = () => { throw new Error('RELEASE_PRESERVING_COMPATIBILITY_UNPROVEN'); };
  if (!spec || !['install', 'restart'].includes(spec.operation)) invalid();
  validatePreservingContract(policy, { kind: spec.operation });
  if (proof?.format !== 1 || proof.kind !== 'same-schema-unknown-claim-rollback' ||
      proof.businessDatabaseRestored !== false || !hex(proof.schemaProofSha256) ||
      ['sameSchema', 'isolatedRuntimeStarted', 'unknownClaimsPreserved', 'businessRowsPreserved', 'rollbackStarted']
        .some((key) => proof.checks?.[key] !== true) ||
      !Array.isArray(packages) || packages.length < 2 || packages.length > 6)
    invalid();
  const bound = {};
  for (const role of ['rollback', 'candidate']) {
    const p = proof[role], current = role === 'rollback';
    if (!p || p.id !== (current ? spec.active.currentId : spec.active.candidateId) ||
        p.manifestSha256 !== (current ? spec.active.currentManifestSha256 : spec.active.candidateManifestSha256) ||
        policy.packageProofs?.[p.id] !== p.manifestSha256 || !hex(p.manifestSha256) ||
        !/^[a-f0-9]{40}$/.test(p.sourceCommit || '')) invalid();
    bound[role] = packages.filter((row) => row.manifest?.id === p.id);
    if (!bound[role].length || bound[role].some((row) =>
      !path.isAbsolute(row.root || '') || row.manifestSha256 !== p.manifestSha256 ||
      row.manifest.sourceCommit !== p.sourceCommit)) invalid();
  }
  for (const old of bound.rollback) for (const candidate of bound.candidate) {
    const compared = validateSameSchema(old.manifest, candidate.manifest, {
      oldRoot: old.root, candidateRoot: candidate.root,
      oldManifestSha256: old.manifestSha256, candidateManifestSha256: candidate.manifestSha256,
    });
    if (require('node:crypto').createHash('sha256').update(JSON.stringify(compared)).digest('hex') !== proof.schemaProofSha256)
      invalid();
  }
  return proof;
}
module.exports = { validatePreservingContract, validateSameSchema, validateActiveBinding, referenceApplicability, preservingRootRoles, preservingEffectScope, validateSameSchemaCompatibility };
