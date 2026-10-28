const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { validatePreservingContract, validateSameSchema, validateActiveBinding } = require('./preserving-contract.cjs');
const { referenceApplicability } = require('./preserving-contract.cjs');
const { preservingRootRoles } = require('./preserving-contract.cjs');

test('preserving reference diagnostic keeps known failures and strips arbitrary host text',()=>{
  const d=require('./reference-diagnostics.cjs');
  for(const code of ['REFERENCE_PROCESS_VISIBILITY_INCOMPLETE','REFERENCE_PROBE_IDENTITY_UNCERTAIN','REFERENCE_CONTROLLER_OWNER_UNCERTAIN','REFERENCE_INFLIGHT_STATE_INVALID','REFERENCE_NATIVE_DEADLINE'])assert.equal(d.safeReason(code),code);
  for(const text of ['C:/private/file','https://example.invalid/?token=secret','REFERENCE_FAKE_SECRET_TOKEN','arbitrary exception'])assert.equal(d.safeReason(text),'REFERENCE_REASON_UNAVAILABLE');
  const summary=d.referenceFailure({errors:['REFERENCE_CONTROLLER_OWNER_UNCERTAIN','https://example.invalid/?token=secret'],categories:{processes:true,tasks:false},uncertainChildren:[123]}, {processes:true,tasks:'not_applicable',shortcuts:'not_applicable',pointers:true,rollback:true,inflight:true});
  assert(summary.includes('REFERENCE_CONTROLLER_OWNER_UNCERTAIN'));
  assert(summary.includes('REFERENCE_CATEGORY_TASKS_UNAVAILABLE'));
  assert(summary.includes('REFERENCE_UNCERTAIN_PROCESS'));
  assert(!summary.includes('secret'));assert(!summary.includes('123'));assert(!summary.includes('http'));
});
test('preserving collector failure classification uses observable fixed signals only',()=>{
  const {collectorFailure}=require('./reference-diagnostics.cjs');
  for(const [input,expected] of [[{code:'ETIMEDOUT'},'REFERENCE_NATIVE_TIMEOUT'],[{code:'ENOENT'},'REFERENCE_NATIVE_EXECUTABLE_MISSING'],[{code:'EPERM'},'REFERENCE_NATIVE_ACCESS_DENIED'],[{stderr:'AuthorizationManager private-target'},'REFERENCE_NATIVE_SCRIPT_SECURITY_REJECTED'],[{stderr:'private-target arbitrary failure'},'REFERENCE_NATIVE_QUERY_FAILED']])assert.equal(collectorFailure(input),expected);
});
test('preserving probe CLI keeps fixed argument failure without running native collection',()=>{
  const {execFileSync}=require('node:child_process');
  const output=execFileSync(process.execPath,[path.join(__dirname,'windows-release-references.cjs')],{encoding:'utf8',windowsHide:true,timeout:10000});
  const result=JSON.parse(output);assert.deepEqual(result.errors,['REFERENCE_POLICY_ARGUMENT_REQUIRED']);
  assert.equal(result.complete,false);assert.deepEqual(result.records,[]);
});

test('preserving split root roles require strict build, v3 inventory and explicit controls',()=>{
  const p={format:2,phase:'build-only',preservingUpdate:{format:1,operation:'build',effects:['new-output-only'],rootRoles:{format:1,
    readOnlyRoots:[{path:path.resolve('old'),identity:['1','2','3']}],controls:[{path:path.resolve('old','active.json'),sha256:'a'.repeat(64),identity:['1','4','3']}]}}};
  assert.equal(preservingRootRoles(p),p.preservingUpdate.rootRoles);
  assert.throws(()=>preservingRootRoles({...p,format:1}),/ROOT_ROLES_INVALID/);
  assert.throws(()=>preservingRootRoles({...p,phase:undefined}),/EFFECT_FORBIDDEN/);
  assert.throws(()=>preservingRootRoles({...p,preservingUpdate:{...p.preservingUpdate,rootRoles:{...p.preservingUpdate.rootRoles,controls:[]}}}),/ROOT_ROLES_INVALID/);
  for(const name of ['.env','secrets.db',path.join('.git','config')])
    assert.throws(()=>preservingRootRoles({...p,preservingUpdate:{...p.preservingUpdate,rootRoles:{...p.preservingUpdate.rootRoles,
      controls:[{...p.preservingUpdate.rootRoles.controls[0],path:path.resolve('old',name)}]}}}),/ROOT_ROLES_INVALID/);
});

test('preserving build applicability follows validated operation and effects only', () => {
  const policy={phase:'build-only',preservingUpdate:{format:1,operation:'build',effects:['new-output-only']}};
  const a=referenceApplicability(policy);
  assert.equal(a.buildOnly,true);assert.equal(a.categories.tasks,'not_applicable');
  for(const k of ['processes','pointers','rollback','inflight'])assert.equal(a.categories[k],true);
  assert.equal(referenceApplicability({}).categories.tasks,true);
  assert.throws(()=>referenceApplicability({...policy,phase:undefined}),/EFFECT_FORBIDDEN/);
  assert.throws(()=>referenceApplicability({...policy,preservingUpdate:{...policy.preservingUpdate,effects:['new-output-only','approved-active-switch']}}),/EFFECT_FORBIDDEN/);
  assert.throws(()=>referenceApplicability({...policy,preservingUpdate:{...policy.preservingUpdate,operation:'install'}}),/EFFECT_FORBIDDEN/);
});

test('ordinary policies preserve existing behavior', () => {
  assert.equal(validatePreservingContract({}, { kind: 'build' }), null);
});
test('schema and every migration must match exactly; linked or missing schema is rejected', () => {
  const original = { format: 1, schemaCompatibility: 'current', links: {}, files: { 'server/prisma/schema.prisma': 'a'.repeat(64), 'server/prisma/migrations/001/migration.sql': 'b'.repeat(64) } };
  validateSameSchema(original, structuredClone(original));
  const changed = structuredClone(original); changed.files['server/prisma/migrations/001/migration.sql'] = 'c'.repeat(64);
  assert.throws(() => validateSameSchema(original, changed), /SCHEMA_CHANGED/);
  const extra = structuredClone(original); extra.files['server/prisma/migrations/002/migration.sql'] = 'd'.repeat(64);
  assert.throws(() => validateSameSchema(original, extra), /SCHEMA_CHANGED/);
  const linked = structuredClone(original); linked.links['server/prisma/schema.prisma'] = 'elsewhere';
  assert.throws(() => validateSameSchema(original, linked), /SCHEMA_UNPROVEN/);
  const empty = structuredClone(original); delete empty.files['server/prisma/schema.prisma'];
  assert.throws(() => validateSameSchema(original, empty), /SCHEMA_UNPROVEN/);
});
test('preserving build permits only a versioned new output contract', () => {
  const policy = { phase: 'build-only', preservingUpdate: { format: 1, operation: 'build', effects: ['new-output-only'] } };
  const request = { kind: 'build', buildOnly: true };
  assert.equal(validatePreservingContract(policy, request), policy.preservingUpdate);
  assert.throws(() => validatePreservingContract({ ...policy, preservingUpdate: { ...policy.preservingUpdate, effects: ['new-output-only', 'delete-old'] } }, request), /EFFECT_FORBIDDEN/);
  assert.throws(() => validatePreservingContract(policy, { ...request, transition: true }), /EFFECT_FORBIDDEN/);
  assert.throws(() => validatePreservingContract(policy, { kind: 'install' }), /CONTRACT_INVALID/);
});
test('active switch requires exact pointer, both manifest pins and process identity', () => {
  const active = { pointer: path.resolve('fixture', 'active.json'), currentId: 'current', candidateId: 'candidate', pointerSha256: 'a'.repeat(64), currentManifestSha256: 'b'.repeat(64), candidateManifestSha256: 'c'.repeat(64), oldProcess: { pid: 1, startUtc: '2026-01-01T00:00:00Z', executableSha256: 'd'.repeat(64) } };
  const spec = { format: 1, operation: 'restart', effects: ['new-output-only', 'approved-active-switch'], active };
  assert.equal(validatePreservingContract({ preservingUpdate: spec }, { kind: 'restart' }), spec);
  assert.throws(() => validatePreservingContract({ preservingUpdate: { ...spec, active: { ...active, oldProcess: null } } }, { kind: 'restart' }), /EFFECT_FORBIDDEN/);
  assert.throws(() => validatePreservingContract({ preservingUpdate: { ...spec, active: { ...active, pointerSha256: '' } } }, { kind: 'restart' }), /EFFECT_FORBIDDEN/);
  assert.throws(() => validatePreservingContract({ preservingUpdate: { ...spec, effects: ['new-output-only', 'delete-old'] } }, { kind: 'restart' }), /EFFECT_FORBIDDEN/);
});
test('pointer, package and process changes individually fail the active binding', () => {
  const p = { pointerSha256: 'a'.repeat(64), currentId: 'current', candidateId: 'candidate', currentManifestSha256: 'b'.repeat(64), candidateManifestSha256: 'c'.repeat(64), oldProcess: { pid: 7, startUtc: '2026-01-01T00:00:00Z', executableSha256: 'd'.repeat(64) } };
  const o = { pointerSha256: p.pointerSha256, pointerId: p.currentId, currentId: p.currentId, candidateId: p.candidateId, currentManifestSha256: p.currentManifestSha256, candidateManifestSha256: p.candidateManifestSha256, process: { ...p.oldProcess } };
  validateActiveBinding({ active: p }, o);
  for (const field of ['pointerSha256', 'pointerId', 'currentId', 'candidateId', 'currentManifestSha256', 'candidateManifestSha256'])
    assert.throws(() => validateActiveBinding({ active: p }, { ...o, [field]: 'changed' }), /ACTIVE_BINDING_CHANGED/);
  for (const field of ['pid', 'startUtc', 'executableSha256'])
    assert.throws(() => validateActiveBinding({ active: p }, { ...o, process: { ...o.process, [field]: 'changed' } }), /ACTIVE_BINDING_CHANGED/);
});
