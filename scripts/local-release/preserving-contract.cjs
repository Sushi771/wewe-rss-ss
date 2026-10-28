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
module.exports = { validatePreservingContract, validateSameSchema, validateActiveBinding };
