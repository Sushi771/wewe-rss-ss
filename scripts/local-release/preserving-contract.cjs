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
function validateSameSchema(oldManifest, candidateManifest) {
  const schema = 'server/prisma/schema.prisma', migrations = 'server/prisma/migrations/';
  function collect(manifest) {
    if (manifest?.format !== 1 || manifest.schemaCompatibility !== 'current' || !manifest.files || !manifest.links)
      throw new Error('RELEASE_PRESERVING_SCHEMA_UNPROVEN');
    const entries = Object.entries(manifest.files).filter(([name]) => name === schema || name.startsWith(migrations))
      .sort(([a], [b]) => a.localeCompare(b));
    if (!entries.some(([name]) => name === schema) || !entries.some(([name]) => name.startsWith(migrations)) ||
        entries.some(([, digest]) => !hex(digest)) ||
        Object.keys(manifest.links).some((name) => name === schema || name.startsWith(migrations)))
      throw new Error('RELEASE_PRESERVING_SCHEMA_UNPROVEN');
    return entries;
  }
  if (JSON.stringify(collect(oldManifest)) !== JSON.stringify(collect(candidateManifest)))
    throw new Error('RELEASE_PRESERVING_SCHEMA_CHANGED');
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
  return { preserving, buildOnly, categories: {
    processes: true, tasks: buildOnly ? 'not_applicable' : true,
    shortcuts: preserving ? 'not_applicable' : true,
    pointers: true, rollback: true, inflight: true,
  } };
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
module.exports = { validatePreservingContract, validateSameSchema, validateActiveBinding, referenceApplicability, preservingRootRoles };
