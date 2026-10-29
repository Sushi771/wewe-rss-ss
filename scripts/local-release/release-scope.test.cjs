const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  crypto = require('node:crypto');
const scope = require('./release-scope.cjs');
const { fileHash } = require('./lib.cjs');
function preservingRestart(f) {
  fs.mkdirSync(path.join(f.current, 'runtime'));
  fs.writeFileSync(path.join(f.current, 'runtime/node.exe'), 'synthetic-child-executable');
  Object.assign(f.policy, scope.inspect([f.installed, f.build]));
  const pointer=path.join(f.installed,'active.json'); fs.writeFileSync(pointer,JSON.stringify({format:1,id:'current'}));
  f.policy.preservingUpdate={format:1,operation:'restart',effects:['new-output-only','approved-active-switch'],active:{pointer,pointerSha256:fileHash(pointer),currentId:'current',candidateId:'candidate',currentManifestSha256:'b'.repeat(64),candidateManifestSha256:'e'.repeat(64),oldProcess:{pid:process.pid,startUtc:f.facts.records[0].startUtc,executableSha256:'c'.repeat(64)}}};
  f.policy.packageProofs={current:'b'.repeat(64),candidate:'e'.repeat(64)};
  f.policy.windowsReferences={packages:[{id:'current',path:f.current}]};
  f.facts.complete=false;f.facts.observationComplete=true;f.facts.categories.shortcuts='not_applicable';
  f.facts.records.push({kind:'pointers',packageId:'current',packagePath:f.current,identity:'synthetic-pointer',pointerPath:pointer});f.save();
  return {kind:'restart',root:f.installed,reserveBytes:4096,transition:true};
}
function sameSchemaRecovery(f) {
  const request = preservingRestart(f), candidate = path.join(f.installed, 'candidate');
  fs.mkdirSync(candidate);
  const manifests = [f.current, candidate].map((root, index) => {
    const manifest = { format: 1, id: index ? 'candidate' : 'current', sourceCommit: String(index + 1).repeat(40), schemaCompatibility: 'current', files: {}, links: {} };
    for (const [name, text] of Object.entries({ 'server/prisma/schema.prisma': 'model Example {\n id Int @id\n}\n', 'server/prisma/migrations/001/migration.sql': 'SELECT 1;\n' })) {
      const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); manifest.files[name] = fileHash(file);
    }
    fs.writeFileSync(path.join(root, 'release.json'), JSON.stringify(manifest)); return manifest;
  });
  const oldHash = fileHash(path.join(f.current, 'release.json')), newHash = fileHash(path.join(candidate, 'release.json'));
  f.policy.packageProofs = { current: oldHash, candidate: newHash };
  Object.assign(f.policy.preservingUpdate.active, { currentManifestSha256: oldHash, candidateManifestSha256: newHash });
  const proof = { format: 1, kind: 'same-schema-unknown-claim-rollback', businessDatabaseRestored: false,
    checks: { sameSchema: true, isolatedRuntimeStarted: true, unknownClaimsPreserved: true, businessRowsPreserved: true, rollbackStarted: true },
    rollback: { id: 'current', sourceCommit: manifests[0].sourceCommit, manifestSha256: oldHash },
    candidate: { id: 'candidate', sourceCommit: manifests[1].sourceCommit, manifestSha256: newHash },
    schemaProofSha256: crypto.createHash('sha256').update(JSON.stringify(require('./preserving-contract.cjs').validateSameSchema(...manifests))).digest('hex') };
  const proofPath = path.join(f.base, 'same-schema-proof.json');
  f.policy.windowsReferences.packages.push({ id: 'candidate', path: candidate });
  const saveProof = () => {
    fs.writeFileSync(proofPath, JSON.stringify(proof)); f.policy.compatibilityProofSha256 = fileHash(proofPath);
    f.policy.windowsReferences.compatibilityProof = { path: proofPath, sha256: f.policy.compatibilityProofSha256 };
    f.facts.compatibility.proofSha256 = f.policy.compatibilityProofSha256;
    Object.assign(f.policy, scope.inspect([f.installed, f.build])); f.save();
  };
  saveProof(); return { request, proof, saveProof, candidate };
}
test('same-schema recovery authorizes only the pinned old package without restoring business data', () => fixture((f) => {
  const s = sameSchemaRecovery(f);
  scope.within(s.request, (lease) => assert.deepEqual(lease.authorizeRecoveryPackage(f.current), s.proof.rollback), f.options());
}));
test('existing additive recovery proof remains accepted by its original branch', () => fixture((f) => {
  const s = sameSchemaRecovery(f); s.proof.kind = 'additive-schema-unknown-claim-rollback';
  s.proof.checks.additiveSchema = true; delete s.proof.checks.sameSchema; delete s.proof.checks.isolatedRuntimeStarted;
  s.saveProof();
  scope.within(s.request, (lease) => assert.deepEqual(lease.authorizeRecoveryPackage(f.current), s.proof.rollback), f.options());
}));
function effectRestart(f) {
  const s = sameSchemaRecovery(f);
  f.policy.format=2;f.policy.inventoryClassification='private-names-v1';f.policy.protectedIds=['current','candidate'];
  f.policy.preservingUpdate.effectScope={format:1,container:f.installed,allocations:[{path:f.build,mode:'audit-children'}],taskIdentities:[],lifecycleSha256:null};
  f.facts.processObservation='preserving-project-only';
  Object.assign(f.policy,scope.inspect([f.installed,f.build],{privateAccounting:'private-names-v1',preservingUpdate:f.policy.preservingUpdate}));f.save();
  return s;
}
test('effect restart accounts real audit outputs and rejects old-file or unapproved pointer writes',()=>fixture(f=>{
  const s=effectRestart(f),gateway=require('./lib.cjs').hostEffects;
  scope.within(s.request,lease=>{
    assert.throws(()=>gateway.fs.writeFileSync(path.join(f.current,'forbidden'),'bad'),/WRITE_OUTSIDE_OUTPUT/);
    assert.throws(()=>gateway.fs.writeFileSync(f.policy.preservingUpdate.active.pointer,'{}'),/POINTER_COMMIT_FORBIDDEN/);
    assert.throws(()=>gateway.fs.writeFileSync(path.join(f.installed,'.release-lifecycle.json'),'{}'),/CONTROL_WRITE_FORBIDDEN/);
    assert.throws(()=>gateway.fs.unlinkSync(path.join(f.installed,'active-11111111-1111-1111-1111-111111111111.tmp')),/POINTER_COMMIT_FORBIDDEN/);
    assert.throws(()=>lease.registerOutput(path.join(f.installed,'unapproved')),/ALLOCATION_INVALID/);
    const at=path.join(f.build,'audit');lease.registerOutput(at);gateway.fs.mkdirSync(at);lease.createdOutput(at);gateway.fs.writeFileSync(path.join(at,'receipt.json'),'{}');
    assert(lease.check().bytes>f.policy.baseline.bytes);
  },f.options());
  const state=JSON.parse(fs.readFileSync(path.join(f.base,f.policy.scopeId+'.state.json'))).payload;
  assert.equal(state.claim,null);assert.equal(state.outputs.length,1);assert.equal(state.outputs[0].complete,true);
}));
for(const mutation of ['parent name','protected package','active pointer','lifecycle control'])test('effect restart refuses changed '+mutation,()=>fixture(f=>{
  const s=effectRestart(f),lease=scope.open(s.request,f.options());
  if(mutation==='parent name')fs.mkdirSync(path.join(f.installed,'unexpected-history'));
  if(mutation==='protected package')fs.appendFileSync(path.join(f.current,'server/prisma/schema.prisma'),'changed');
  if(mutation==='active pointer')fs.writeFileSync(f.policy.preservingUpdate.active.pointer,'{}');
  if(mutation==='lifecycle control')fs.writeFileSync(path.join(f.installed,'.release-lifecycle.json'),'{}');
  assert.throws(()=>lease.check(),/FROZEN_HISTORY_CHANGED|PROTECTED_CHANGED|ACTIVE_BINDING_CHANGED|LIFECYCLE_CHANGED/);
  assert.throws(()=>lease.close(new Error('changed')),/FROZEN_HISTORY_CHANGED|PROTECTED_CHANGED|ACTIVE_BINDING_CHANGED|LIFECYCLE_CHANGED/);
}));
test('effect restart rejects concurrent writer and preserves an interrupted claim without resetting usage',()=>fixture(f=>{
  const s=effectRestart(f),lease=scope.open(s.request,f.options());
  assert.throws(()=>scope.open(s.request,f.options()),/EEXIST/);
  const at=path.join(f.build,'interrupted');lease.registerOutput(at);fs.mkdirSync(at);lease.createdOutput(at);fs.writeFileSync(path.join(at,'data'),'owned');
  assert.throws(()=>lease.close(new Error('interrupted')),/FAILED_OUTPUT_HELD_REQUIRES_REVIEW/);
  const file=path.join(f.base,f.policy.scopeId+'.state.json'),before=fs.readFileSync(file);
  assert.throws(()=>scope.open(s.request,f.options()),/INTERRUPTED_CLAIM_REQUIRES_REVIEW/);
  assert.deepEqual(fs.readFileSync(file),before);assert(fs.existsSync(at));
}));
function effectInstallScope(f) {
  const s=effectRestart(f),source=path.join(f.build,'candidate');fs.renameSync(s.candidate,source);
  f.policy.windowsReferences.packages.find(p=>p.id==='candidate').path=source;
  Object.assign(f.policy.preservingUpdate,{operation:'install',effects:['new-output-only']});
  f.policy.preservingUpdate.effectScope.allocations=[{path:s.candidate,mode:'exclusive-package'}];
  Object.assign(f.policy,scope.inspect([f.installed,f.build],{privateAccounting:'private-names-v1',preservingUpdate:f.policy.preservingUpdate}));f.save();
  return {target:s.candidate,request:{kind:'install',root:f.installed,reserveBytes:1024*1024,runtimeCopies:1}};
}
test('effect install refuses an appeared target without adopting it',()=>fixture(f=>{
  const e=effectInstallScope(f);fs.mkdirSync(e.target);
  assert.throws(()=>scope.open(e.request,f.options()),/BASELINE_MISMATCH|ALLOCATION_OCCUPIED/);
  assert.equal(fs.readdirSync(e.target).length,0);
}));
test('effect install refuses replaced owned output and keeps failed bytes for review',()=>fixture(f=>{
  const e=effectInstallScope(f),lease=scope.open(e.request,f.options());lease.registerOutput(e.target);fs.mkdirSync(e.target);lease.createdOutput(e.target);
  const moved=path.join(f.base,'held-output');fs.renameSync(e.target,moved);fs.mkdirSync(e.target);
  assert.throws(()=>lease.check(),/OWNED_OUTPUT_REPLACED/);
  assert.throws(()=>lease.close(new Error('replaced')),/OWNED_OUTPUT_REPLACED/);
  assert(fs.existsSync(moved));assert(fs.existsSync(e.target));
}));
test('effect install carries completed copy usage and cannot obtain a second runtime allowance',()=>fixture(f=>{
  const e=effectInstallScope(f);e.request.reserveBytes=4096;f.policy.maxNewRuntimeCopies=1;f.save();
  scope.within(e.request,lease=>{lease.registerOutput(e.target);fs.mkdirSync(e.target);lease.createdOutput(e.target);fs.writeFileSync(path.join(e.target,'node.exe'),'synthetic-counted-copy');},f.options());
  const ledger=path.join(f.base,f.policy.scopeId+'.state.json'),before=fs.readFileSync(ledger);
  assert.throws(()=>scope.open(e.request,f.options()),/RUNTIME_COPY_PEAK_EXCEEDED/);
  assert.deepEqual(fs.readFileSync(ledger),before);assert.equal(JSON.parse(before).payload.outputs.length,1);
}));
test('effect scope retains exact native process time matching without rounding a changed tick',()=>fixture(f=>{
  const s=effectRestart(f);f.policy.preservingUpdate.active.oldProcess.startUtc='2026-01-01T00:00:00.0000001Z';f.save();
  assert.throws(()=>scope.open(s.request,f.options()),/ACTIVE_BINDING_CHANGED/);
}));
for (const mutation of ['runtime evidence', 'schema digest', 'candidate manifest', 'restored database'])
  test('same-schema recovery refuses changed ' + mutation, () => fixture((f) => {
    const s = sameSchemaRecovery(f);
    if (mutation === 'runtime evidence') s.proof.checks.isolatedRuntimeStarted = false;
    if (mutation === 'schema digest') s.proof.schemaProofSha256 = 'f'.repeat(64);
    if (mutation === 'candidate manifest') s.proof.candidate.manifestSha256 = 'f'.repeat(64);
    if (mutation === 'restored database') s.proof.businessDatabaseRestored = true;
    s.saveProof();
    scope.within(s.request, (lease) => assert.throws(() => lease.authorizeRecoveryPackage(f.current), /RECOVERY_TARGET_UNPROVEN/), f.options());
  }));
test('preserving transition rejects independent unapproved process counterexample',()=>fixture(f=>{
  const request=preservingRestart(f);let admitted=false;
  assert.throws(()=>scope.within(request,lease=>{
    f.facts.records.push({...f.facts.records[0],pid:987654,startUtc:'2026-01-02T00:00:00Z',identity:'unapproved-secondary-writer'});
    try{lease.check(true);admitted=true;}catch(e){if(!/REFERENCES_CHANGED|QUERY_INCOMPLETE|WRITER|PROCESS/.test(e.message))throw e;}
  },f.options()),/REFERENCES_CHANGED/);
  assert.equal(admitted,false);
}));
test('preserving transition binds owned child and health-failure fallback without ignoring other records',()=>fixture(f=>{
  const request=preservingRestart(f), old=f.facts.records[0];
  scope.within(request,lease=>{
    f.facts.records=f.facts.records.filter(r=>r!==old);
    assert.throws(()=>lease.confirmPreservingProcessExit(old.pid),/EXIT_UNCONFIRMED/);
    lease.confirmPreservingProcessExit(old.pid,{pid:old.pid,stopped:true}); lease.check(true);
    const executable=path.join(f.current,'runtime/node.exe');
    const snapshot={pid:987653,startUtc:'2026-01-02T00:00:00Z',executable,commandLine:'synthetic-owned-command'};
    const child={...old,pid:snapshot.pid,startUtc:snapshot.startUtc,executableSha256:fileHash(executable),identity:'owned-child'};
    f.facts.records.push(child);
    assert.throws(()=>lease.bindPreservingChild({...snapshot,pid:old.pid},'current',snapshot.commandLine),/PROCESS_UNAPPROVED/);
    assert.throws(()=>lease.bindPreservingChild(snapshot,'current','different-command'),/PROCESS_UNAPPROVED/);
    lease.bindPreservingChild(snapshot,'current',snapshot.commandLine); lease.check(true);
    f.facts.records=f.facts.records.filter(r=>r!==child);
    lease.confirmPreservingProcessExit(snapshot.pid,{pid:snapshot.pid,stopped:true}); lease.check(true);
    const fallback={...snapshot,pid:987652};
    f.facts.records.push({...child,pid:fallback.pid,identity:'owned-fallback'});
    lease.bindPreservingChild(fallback,'current',fallback.commandLine); lease.check(true);
  },f.options());
}));
test('preserving transition rejects changed existing identity',()=>fixture(f=>{
  const request=preservingRestart(f);
  assert.throws(()=>scope.within(request,lease=>{
    f.facts.records[0].startUtc='2026-01-03T00:00:00Z';
    assert.throws(()=>lease.check(true),/REFERENCES_CHANGED/);
  },f.options()),/REFERENCES_CHANGED/);
}));
test('preserving transition refuses uncertain child evidence',()=>fixture(f=>{
  const request=preservingRestart(f);
  assert.throws(()=>scope.within(request,lease=>{
    f.facts.uncertainChildren.push(987651);
    assert.throws(()=>lease.check(true),/QUERY_INCOMPLETE/);
  },f.options()),/QUERY_INCOMPLETE/);
}));
function enableV3(f) {
  assert.equal(f.current === fs.realpathSync.native(f.current), true, 'fixture package path must be canonical');
  const m = { format: 1, id: 'current', files: { 'node.exe': fileHash(path.join(f.current, 'node.exe')) }, links: {} };
  const file = path.join(f.current, 'release.json');
  fs.writeFileSync(file, JSON.stringify(m));
  f.policy.packageProofs = { current: fileHash(file) };
  f.policy.protectedIds = ['current'];
  f.policy.windowsReferences = { format: 1, packages: [{ id: 'current', path: f.current }] };
  Object.assign(f.policy, scope.inspect([f.installed, f.build], { privateAccounting: 'private-names-v1' }));
  f.policy.format = 2; f.policy.inventoryClassification = 'private-names-v1'; f.save();
}

function splitPreservingBuild(f) {
  const request=buildOnly(f);enableV3(f);
  const pointer=path.join(f.installed,'active.json');fs.writeFileSync(pointer,JSON.stringify({format:1,id:'current'}));
  const s=fs.lstatSync(pointer,{bigint:true});
  f.policy.preservingUpdate={format:1,operation:'build',effects:['new-output-only'],rootRoles:{format:1,
    readOnlyRoots:[scope.inspect([f.installed],{privateAccounting:'private-names-v1'}).roots[0]],
    controls:[{path:pointer,identity:[s.dev,s.ino,s.birthtimeNs].map(String),sha256:fileHash(pointer)}]}};
  Object.assign(f.policy,scope.inspect([f.build],{privateAccounting:'private-names-v1'}));
  f.facts.complete=false;f.facts.observationComplete=true;
  f.facts.categories.tasks=f.facts.categories.shortcuts='not_applicable';
  f.facts.processObservation='build-control-only';f.facts.records=f.facts.records.filter(r=>r.kind!=='processes');f.save();
  return {request,pointer};
}
test('preserving split build accounts only fresh output and keeps old roots read only',()=>fixture(f=>{
  const archive=path.join(f.installed,'unrelated-history.bin');fs.writeFileSync(archive,'synthetic old history');
  const {request,pointer}=splitPreservingBuild(f);assert.equal(f.policy.baseline.bytes,0);
  let protectedReads=0;const open=fs.openSync;
  const lease=patch(fs,'openSync',function(file,...args){
    assert.notEqual(file,archive,'unrelated frozen history must not be opened for content');
    if(file===path.join(f.current,'node.exe'))protectedReads++;
    return open.call(this,file,...args);
  },()=>scope.open(request,f.options()));
  assert(protectedReads>0,'protected runtime content is verified');assert.equal(lease.check().bytes,0);
  assert.throws(()=>lease.registerOutput(path.join(f.installed,'forbidden')),/ROOT|OUTPUT/);
  lease.close();
  const gateway=require('./lib.cjs').hostEffects;
  scope.within(request,l=>{
    assert.throws(()=>gateway.fs.writeFileSync(path.join(f.current,'bad'),'bad'),/WRITE_OUTSIDE_OUTPUT/);
    assert.throws(()=>gateway.fs.writeFileSync(pointer,'{}'),/PRIVATE_INPUT/);
    const at=path.join(f.build,'owned');l.registerOutput(at);gateway.fs.mkdirSync(at);l.createdOutput(at);
    gateway.fs.writeFileSync(path.join(at,'file'),'owned');
  },f.options());
  assert.equal(fs.readFileSync(archive,'utf8'),'synthetic old history');
}));
for(const mutation of ['runtime','manifest','control'])test(`preserving split build rejects changed protected ${mutation}`,()=>fixture(f=>{
  const {request,pointer}=splitPreservingBuild(f);const lease=scope.open(request,f.options());
  fs.appendFileSync(mutation==='runtime'?path.join(f.current,'node.exe'):mutation==='manifest'?path.join(f.current,'release.json'):pointer,'changed');
  assert.throws(()=>lease.check(),/PROTECTED_CHANGED|CONTROL_CHANGED/);
  assert.throws(()=>lease.close(new Error('changed')),/PROTECTED_CHANGED|CONTROL_CHANGED/);
}));
test('preserving split build rejects replaced protected root and overlapping roles',()=>fixture(f=>{
  const {request}=splitPreservingBuild(f);
  f.policy.preservingUpdate.rootRoles.readOnlyRoots.push(f.policy.roots[0]);f.save();
  assert.throws(()=>scope.open(request,f.options()),/OVERLAPPING_ROOTS/);
  f.policy.preservingUpdate.rootRoles.readOnlyRoots.pop();f.save();
  const moved=path.join(f.base,'old-installed');fs.renameSync(f.installed,moved);fs.mkdirSync(f.installed);
  assert.throws(()=>scope.open(request,f.options()),/ROOT_CHANGED/);
}));
test('original complete mode still checks all historical accounting contents',()=>fixture(f=>{
  const lease=f.open();fs.appendFileSync(path.join(f.current,'node.exe'),'changed');
  assert.throws(()=>lease.check(),/FROZEN_HISTORY_CHANGED/);
  assert.throws(()=>lease.close(new Error('changed')),/FROZEN_HISTORY_CHANGED/);
}));
test('v3 adoption and checkpoint preserve private accounting and reject a changed private entry', () =>
  fixture((f) => {
    const privateFile = path.join(f.current, '.env');
    fs.writeFileSync(privateFile, 'synthetic');
    enableV3(f);
    const lease = f.open();
    lease.check();
    fs.appendFileSync(privateFile, 'changed');
    assert.throws(() => lease.check(), /FROZEN_HISTORY_CHANGED/);
    assert.throws(() => lease.close(new Error('changed')), /FROZEN_HISTORY_CHANGED/);
  }));
test('v3 must bind explicit format and rejects a v2 ledger', () =>
  fixture((f) => {
    const first = f.open(); first.close();
    enableV3(f);
    assert.throws(() => f.open(), /STATE_INVALID/);
  }));
test('a v3 managed output containing private material is rejected', () =>
  fixture((f) => {
    enableV3(f);
    const lease = f.open();
    const target = path.join(f.build, 'candidate');
    lease.registerOutput(target); fs.mkdirSync(target); lease.createdOutput(target);
    fs.writeFileSync(path.join(target, '.env'), 'synthetic');
    assert.throws(() => lease.close(), /PRIVATE_MANAGED_OUTPUT/);
  }));
test('v3 checks unreferenced physical protected copies before probe', () =>
  fixture((f) => {
    enableV3(f);
    const second = path.join(f.installed, 'second'); fs.mkdirSync(second);
    const file = path.join(second, 'release.json');
    fs.writeFileSync(file, JSON.stringify({ format: 1, id: 'second', files: { '.env': 'a'.repeat(64) }, links: {} }));
    f.policy.windowsReferences.packages.push({ id: 'second', path: second });
    f.policy.protectedIds.push('second'); f.policy.packageProofs.second = fileHash(file);
    Object.assign(f.policy, scope.inspect([f.installed, f.build], { privateAccounting: 'private-names-v1' }));
    f.save(); let queries = 0;
    const options = f.options(); options.query = () => { queries++; return f.facts; };
    assert.throws(() => scope.open({ kind: 'build', root: f.build, reserveBytes: 1 }, options), /PRIVATE_CONFLICT/);
    assert.equal(queries, 0);
  }));
test('v3 first adoption queries only after actual checksummed ledger exists', () =>
  fixture((f) => {
    enableV3(f);
    const options = f.options(), ledger = path.join(f.base, f.policy.scopeId + '.state.json');
    let queries = 0;
    options.query = () => {
      queries++;
      const doc = JSON.parse(fs.readFileSync(ledger, 'utf8'));
      assert.equal(doc.payload.format, 2);
      return structuredClone(f.facts);
    };
    const first = scope.open({ kind: 'build', root: f.build, reserveBytes: 1 }, options);
    first.close();
    const second = scope.open({ kind: 'build', root: f.build, reserveBytes: 1 }, options);
    second.close();
    assert(queries >= 2);
  }));
test('v3 checks every physical copy of the same protected id', () =>
  fixture((f) => {
    enableV3(f);
    const second = path.join(f.installed, 'second'); fs.mkdirSync(second);
    fs.copyFileSync(path.join(f.current, 'release.json'), path.join(second, 'release.json'));
    fs.writeFileSync(path.join(second, 'node.exe'), 'changed synthetic runtime');
    f.policy.windowsReferences.packages.push({ id: 'current', path: second });
    Object.assign(f.policy, scope.inspect([f.installed, f.build], { privateAccounting: 'private-names-v1' }));
    f.save();
    assert.throws(() => f.open(), /ARTIFACT_HASH_MISMATCH/);
  }));
test('v3 rejects a noncanonical package spelling before artifact access', () =>
  fixture((f) => {
    enableV3(f);
    f.policy.windowsReferences.packages[0].path = f.current + path.sep + '.';
    f.save();
    assert.throws(() => f.open(), /ARTIFACT_BINDING_INVALID/);
  }));
test('elapsed reference-query time cannot reset or exceed the shared operation deadline before allocation', () =>
  fixture((f) => {
    f.policy.scanBudget = { durationMs: 2000 };
    f.save();
    const options = f.options();
    let queries = 0;
    options.query = () => {
      queries++;
      const end = performance.now() + 2100;
      while (performance.now() < end) {}
      return structuredClone(f.facts);
    };
    assert.throws(
      () =>
        scope.open(
          { kind: 'install', root: f.installed, reserveBytes: 1 },
          options,
        ),
      /SCAN_TIME_BUDGET/,
    );
    assert.equal(queries, 1);
    assert(!fs.existsSync(path.join(f.installed, 'candidate')));
  }));
test('opt-in metadata checkpoints still hold a changed frozen file before another allocation', () =>
  fixture((f) => {
    f.policy.scanBudget = {
      profile: 'legacy-stream-v1',
      checkpointMode: 'identity-times-v1',
    };
    f.save();
    const lease = f.open();
    fs.appendFileSync(path.join(f.current, 'node.exe'), 'changed');
    assert.throws(
      () => lease.registerOutput(path.join(f.build, 'candidate')),
      /FROZEN_HISTORY_CHANGED/,
    );
    assert(!fs.existsSync(path.join(f.build, 'candidate')));
    assert.throws(
      () => lease.close(new Error('history changed')),
      /FROZEN_HISTORY_CHANGED/,
    );
  }));
test('default policy retains complete content hashing on every checkpoint', () =>
  fixture((f) => {
    const lease = f.open(),
      before = lease.inventoryMetrics().readBytes;
    lease.check();
    assert(lease.inventoryMetrics().readBytes > before);
    lease.close();
  }));
test('scope opens hash historical contents afresh, then checkpoint metadata without rereading historical bytes', () =>
  fixture((f) => {
    f.policy.scanBudget = {
      profile: 'legacy-stream-v1',
      checkpointMode: 'identity-times-v1',
    };
    f.save();
    const first = f.open(),
      read = first.inventoryMetrics().readBytes;
    assert(read > 0);
    first.check();
    first.check();
    assert.equal(first.inventoryMetrics().readBytes, read);
    first.close();
    const second = f.open();
    assert(second.inventoryMetrics().readBytes > 0);
    second.close();
  }));
test('old inventory format cannot be silently upgraded or adopted as a fresh baseline', () =>
  fixture((f) => {
    f.policy.baseline.format = 'old-in-memory-v1';
    f.save();
    assert.throws(() => f.open(), /INVENTORY_VERSION_REVIEW_REQUIRED/);
    assert(!fs.existsSync(path.join(f.base, f.policy.scopeId + '.state.json')));
  }));
function fixture(run) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-release-scope-'))),
    installed = path.join(base, 'installed'),
    build = path.join(base, 'build'),
    current = path.join(installed, 'current');
  fs.mkdirSync(current, { recursive: true });
  fs.mkdirSync(build);
  fs.writeFileSync(path.join(current, 'node.exe'), 'inert synthetic runtime');
  let facts = {
    complete: true,
    categories: Object.fromEntries(
      [
        'processes',
        'tasks',
        'shortcuts',
        'pointers',
        'rollback',
        'inflight',
      ].map((kind) => [kind, true]),
    ),
    records: [
      {
        kind: 'processes',
        packageId: 'current',
        packagePath: current,
        identity: 'synthetic-pid-identity',
        pid: process.pid,
        startUtc: '2026-01-01T00:00:00Z',
        executableSha256: 'c'.repeat(64),
      },
    ],
    errors: [],
    uncertainChildren: [],
    compatibility: {
      verified: true,
      businessDatabaseRestored: false,
      proofSha256: 'd'.repeat(64),
    },
  };
  const inspection = scope.inspect([installed, build]);
  const policy = {
    format: 1,
    scopeId: crypto.randomUUID(),
    registryDirectory: fs.realpathSync.native(base),
    registryIdentity: scope.inspect([base]).roots[0].identity,
    ...inspection,
    maxBytes: scope.DEFAULT_BYTES,
    maxGrowthBytes: 1024 * 1024,
    maxNewRuntimeCopies: 2,
    protectedIds: ['current', 'rollback', 'candidate'],
    compatibilityProofSha256: 'd'.repeat(64),
  };
  const config = path.join(base, 'reviewed-policy.json');
  fs.writeFileSync(config, JSON.stringify(policy));
  const f = {
    base,
    installed,
    build,
    current,
    policy,
    config,
    get facts() {
      return facts;
    },
    set facts(value) {
      facts = value;
    },
    save() {
      fs.writeFileSync(config, JSON.stringify(policy));
    },
    options() {
      return {
        configPath: config,
        configSha256: fileHash(config),
        query: () => structuredClone(facts),
      };
    },
    open(reserve = 4096, root = build, kind = 'build') {
      return scope.open({ kind, root, reserveBytes: reserve }, this.options());
    },
  };
  function clean() {
    assert(path.basename(base).startsWith('wewe-release-scope-'));
    fs.rmSync(base, { recursive: true });
  }
  try {
    const result = run(f);
    if (result?.then) return result.finally(clean);
    clean();
    return result;
  } catch (error) {
    clean();
    throw error;
  }
}
function output(f, lease, name = 'candidate', bytes = 128) {
  const at = path.join(f.build, name);
  lease.registerOutput(at);
  fs.mkdirSync(at);
  lease.createdOutput(at);
  fs.writeFileSync(path.join(at, 'runtime'), Buffer.alloc(bytes));
  return at;
}
function patch(object, key, value, run) {
  const old = object[key];
  object[key] = value;
  try {
    return run();
  } finally {
    object[key] = old;
  }
}

test('L1: source and destination bytes share one scope; exact completed output is held on reuse', () =>
  fixture((f) => {
    const lease = f.open();
    const at = output(f, lease);
    lease.close();
    scope.within(
      { kind: 'reference-inspection', root: f.installed, reserveBytes: 0 },
      (next) => {
        const measured = next.check();
        assert.equal(measured.bytes, f.policy.baseline.bytes + 128);
      },
      f.options(),
    );
    assert.equal(fs.readFileSync(path.join(at, 'runtime')).length, 128);
  }));
test('L2: a completed old output consumes total capacity until separately reviewed retirement', () =>
  fixture((f) => {
    f.policy.maxBytes = f.policy.baseline.bytes + 150;
    f.policy.maxGrowthBytes = 150;
    f.save();
    const lease = f.open(128);
    output(f, lease);
    lease.close();
    assert.throws(() => f.open(128), /COPY_PEAK/);
    assert(fs.existsSync(path.join(f.build, 'candidate/runtime')));
  }));
test('L3: intent before mkdir and a failed partial output remain a held claim on retry', () =>
  fixture((f) => {
    const lease = f.open();
    output(f, lease);
    assert.throws(
      () => lease.close(new Error('copy failed')),
      /FAILED_OUTPUT_HELD/,
    );
    assert.throws(() => f.open(), /INTERRUPTED_CLAIM/);
    assert(fs.existsSync(path.join(f.build, 'candidate/runtime')));
  }));
test('L3: confirmed inactive owned cleanup can finish without deleting any historical file', () =>
  fixture((f) => {
    const lease = f.open(),
      at = output(f, lease);
    lease.allowCleanup([at]);
    assert.equal(path.dirname(path.resolve(at)), f.build);
    fs.rmSync(at, { recursive: true });
    lease.close(new Error('confirmed synchronous failure'));
    const next = f.open();
    next.close();
    assert(fs.existsSync(path.join(f.current, 'node.exe')));
  }));
test('L4: build and install roots contend on the same persisted scope lock', () =>
  fixture((f) => {
    const build = f.open();
    assert.throws(() => f.open(128, f.installed, 'install'), /EEXIST/);
    const copied = path.join(f.base, 'copied-policy.json');
    fs.copyFileSync(f.config, copied);
    assert.throws(
      () =>
        scope.open(
          { kind: 'install', root: f.installed, reserveBytes: 128 },
          { ...f.options(), configPath: copied },
        ),
      /EEXIST/,
    );
    assert(!fs.existsSync(path.join(f.installed, 'candidate')));
    build.close();
  }));
test('L5: a junction/canonical path alias cannot obtain another reservation', () =>
  fixture((f) => {
    const alias = path.join(f.base, 'build-alias');
    fs.symlinkSync(
      f.build,
      alias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const lease = f.open();
    assert.throws(() => f.open(128, alias), /EEXIST/);
    lease.close();
  }));

test('L3/L11: killing only the owned inert fixture child leaves a durable hold', () =>
  fixture(async (f) => {
    const { spawn } = require('node:child_process'),
      { once } = require('node:events');
    const facts = path.join(f.base, 'facts.json'),
      probe = path.join(f.base, 'probe.cjs'),
      program = path.join(f.base, 'owned-child.cjs');
    fs.writeFileSync(facts, JSON.stringify(f.facts));
    fs.writeFileSync(
      probe,
      'process.stdout.write(require("node:fs").readFileSync(require("node:path").join(__dirname,"facts.json")));',
    );
    f.policy.probe = { path: probe, sha256: fileHash(probe) };
    f.save();
    fs.writeFileSync(
      program,
      `const fs=require('node:fs'),path=require('node:path'),scope=require(${JSON.stringify(require.resolve('./release-scope.cjs'))});const lease=scope.open({kind:'build',root:${JSON.stringify(f.build)},reserveBytes:4096});const at=path.join(${JSON.stringify(f.build)},'partial');lease.registerOutput(at);fs.mkdirSync(at);lease.createdOutput(at);fs.writeFileSync(path.join(at,'runtime'),'inert');process.send('persisted');setInterval(()=>{},1000);`,
    );
    const child = spawn(process.execPath, [program], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: {
        ...process.env,
        WEWE_RELEASE_SCOPE_FILE: f.config,
        WEWE_RELEASE_SCOPE_SHA256: fileHash(f.config),
      },
    });
    try {
      const message = await Promise.race([
        once(child, 'message'),
        once(child, 'exit').then(([code]) => {
          throw new Error('fixture exited ' + code);
        }),
      ]);
      assert.equal(message[0], 'persisted');
      const exited = once(child, 'exit');
      child.kill();
      await exited;
      assert.throws(() => f.open(), /EEXIST/);
      assert(fs.existsSync(path.join(f.build, 'partial/runtime')));
      assert(!fs.existsSync(path.join(f.build, 'candidate')));
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
    }
  }));
test('L5: link escape, overlapping aliases and hardlinked storage fail closed', () =>
  fixture((f) => {
    assert.throws(() => scope.inspect([f.installed, f.current]), /OVERLAPPING/);
    const alias = path.join(f.build, 'escape');
    fs.symlinkSync(
      f.base,
      alias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    assert.throws(() => f.open(), /LINK_ESCAPE/);
    fs.unlinkSync(alias);
    fs.linkSync(
      path.join(f.current, 'node.exe'),
      path.join(f.build, 'hardlink'),
    );
    assert.throws(() => f.open(), /HARDLINK/);
  }));
test('L6: choosing an unregistered root or moving history never earns capacity credit', () =>
  fixture((f) => {
    const outside = path.join(f.base, 'outside');
    fs.mkdirSync(outside);
    assert.throws(() => f.open(1, outside), /UNREGISTERED/);
    fs.renameSync(
      path.join(f.current, 'node.exe'),
      path.join(f.build, 'moved-runtime'),
    );
    assert.throws(() => f.open(), /BASELINE_MISMATCH/);
  }));
test('L7: new unclassified files, grown history and grown caches refuse before allocation', () => {
  for (const mode of ['new', 'grown', 'cache'])
    fixture((f) => {
      const lease = f.open();
      lease.close();
      if (mode === 'new')
        fs.writeFileSync(path.join(f.installed, 'unclassified'), 'unexpected');
      if (mode === 'grown')
        fs.appendFileSync(path.join(f.current, 'node.exe'), 'unexpected');
      if (mode === 'cache') {
        fs.mkdirSync(path.join(f.installed, '.verification-cache'));
        fs.writeFileSync(
          path.join(f.installed, '.verification-cache', 'new'),
          'unexpected',
        );
      }
      assert.throws(() => f.open(), /FROZEN_HISTORY_CHANGED/);
      assert(!fs.existsSync(path.join(f.build, 'candidate')));
    });
});
test('L7: same-size replacement is detected by identity and content, not byte totals alone', () =>
  fixture((f) => {
    const lease = f.open();
    lease.close();
    const file = path.join(f.current, 'node.exe'),
      size = fs.statSync(file).size;
    fs.unlinkSync(file);
    fs.writeFileSync(file, Buffer.alloc(size));
    assert.throws(() => f.open(), /FROZEN_HISTORY_CHANGED/);
  }));
test('L8: changed pointer, task, shortcut, rollback or in-flight reference blocks publication', () => {
  for (const kind of ['pointers', 'tasks', 'shortcuts', 'rollback', 'inflight'])
    fixture((f) => {
      const lease = f.open();
      f.facts.records.push({
        kind,
        packageId: 'current',
        packagePath: f.current,
        identity: 'changed-' + kind,
      });
      assert.throws(() => lease.check(), /REFERENCES_CHANGED/);
      assert.throws(() => lease.close(), /REFERENCES_CHANGED/);
    });
});
test('L9: reused PID, incomplete task/shortcut query and uncertain child exit all hold output', () => {
  for (const mode of ['pid', 'tasks', 'shortcuts', 'child'])
    fixture((f) => {
      const lease = f.open();
      const at = output(f, lease);
      if (mode === 'pid') f.facts.records[0].startUtc = 'different-start';
      if (mode === 'tasks' || mode === 'shortcuts')
        f.facts.categories[mode] = false;
      if (mode === 'child')
        f.facts.uncertainChildren.push('synthetic child exit unknown');
      assert.throws(() => lease.allowCleanup([at]));
      assert.throws(() => lease.close(new Error('failed')));
      assert(fs.existsSync(path.join(at, 'runtime')));
    });
});
test('L9: stable launcher references must resolve to a protected physical package', () =>
  fixture((f) => {
    f.facts.records.push({
      kind: 'shortcuts',
      packageId: 'fourth',
      packagePath: f.current,
      identity: 'stable-launcher-points-to-unregistered-fourth',
    });
    assert.throws(() => f.open(), /UNRESOLVED_REFERENCE/);
  }));
test('L10: combined copy peak, per-claim growth and actual physical reserve are separate checks', () => {
  fixture((f) => {
    f.policy.maxBytes = f.policy.baseline.bytes + 128;
    f.policy.maxGrowthBytes = 128;
    f.save();
    assert.throws(() => f.open(129), /COPY_PEAK/);
  });
  fixture((f) => {
    const lease = f.open(64);
    output(f, lease, 'candidate', 128);
    assert.throws(() => lease.check(), /RESERVATION_EXCEEDED/);
    assert.throws(() => lease.close(new Error('overflow')));
  });
  fixture((f) => {
    const original = fs.statfsSync;
    patch(
      fs,
      'statfsSync',
      (...args) => ({ ...original(...args), bavail: 0n }),
      () => assert.throws(() => f.open(), /PHYSICAL_RESERVE/),
    );
  });
});
test('L10: an over-default legacy ceiling requires an explicit pinned finite exception', () =>
  fixture((f) => {
    f.policy.maxBytes = scope.DEFAULT_BYTES + 1;
    f.save();
    assert.throws(() => f.open(), /EXCEPTION_NOT_APPROVED/);
    f.policy.exception = {
      approvalId: 'synthetic-review-only',
      baselineDigest: f.policy.baseline.digest,
      baselineBytes: f.policy.baseline.bytes,
      maxBytes: f.policy.maxBytes,
      maxGrowthBytes: f.policy.maxGrowthBytes,
    };
    f.save();
    const lease = f.open();
    lease.close();
  }));
test('L11: missing or corrupt adopted ledger never regenerates a clean baseline', () => {
  for (const mode of ['missing', 'corrupt'])
    fixture((f) => {
      const lease = f.open();
      lease.close();
      const ledger = path.join(f.base, f.policy.scopeId + '.state.json');
      if (mode === 'missing') fs.unlinkSync(ledger);
      else fs.writeFileSync(ledger, '{}');
      assert.throws(
        () => f.open(),
        mode === 'missing' ? /LEDGER_MISSING/ : /STATE_CORRUPT/,
      );
    });
});
test('L11: ledger replacement and changed owner preserve unknown claims and locks', () => {
  fixture((f) => {
    const lease = f.open(),
      ledger = path.join(f.base, f.policy.scopeId + '.state.json');
    fs.writeFileSync(ledger, '{}');
    assert.throws(() => lease.close(), /STATE_CORRUPT/);
  });
  fixture((f) => {
    const lease = f.open(),
      lock = path.join(f.base, f.policy.scopeId + '.lock');
    fs.writeFileSync(lock, 'foreign');
    assert.throws(() => lease.close(), /OWNER_CHANGED/);
    assert.equal(fs.readFileSync(lock, 'utf8'), 'foreign');
  });
});
test('L12: removing or replacing a held package does not itself authorize retirement or old DB restoration', () =>
  fixture((f) => {
    const lease = f.open(),
      at = output(f, lease);
    lease.close();
    fs.rmSync(at, { recursive: true });
    assert.throws(() => f.open(), /MANAGED_OUTPUT_CHANGED/);
    f.facts.compatibility.businessDatabaseRestored = true;
    assert.throws(() => f.open(), /COMPATIBILITY_UNPROVEN/);
  }));
test('a reviewed external reference probe is required by the actual production API', () =>
  fixture((f) => {
    assert.throws(
      () =>
        scope.open(
          { kind: 'install', root: f.installed, reserveBytes: 1 },
          { configPath: f.config, configSha256: fileHash(f.config) },
        ),
      /PROBE_UNAVAILABLE/,
    );
    assert.throws(
      () => scope.open({ kind: 'install', root: f.installed, reserveBytes: 1 }),
      /REVIEWED_POLICY_REQUIRED/,
    );
  }));
test('actual production controller and activation APIs stop before any action without a reviewed scope', () =>
  fixture(async (f) => {
    const oldFile = process.env.WEWE_RELEASE_SCOPE_FILE,
      oldSha = process.env.WEWE_RELEASE_SCOPE_SHA256;
    delete process.env.WEWE_RELEASE_SCOPE_FILE;
    delete process.env.WEWE_RELEASE_SCOPE_SHA256;
    try {
      await assert.rejects(
        require('./restart.cjs').controlledRestart({
          production: true,
          release: f.current,
        }),
        /REVIEWED_POLICY_REQUIRED/,
      );
      await assert.rejects(
        require('./switch.cjs').controlledSwitch({
          production: true,
          release: f.current,
        }),
        /REVIEWED_POLICY_REQUIRED/,
      );
      assert.throws(
        () => require('./logon-start.cjs').activateRunning(f.current),
        /REVIEWED_POLICY_REQUIRED/,
      );
      assert.equal(fs.readdirSync(f.build).length, 0);
    } finally {
      if (oldFile !== undefined) process.env.WEWE_RELEASE_SCOPE_FILE = oldFile;
      if (oldSha !== undefined) process.env.WEWE_RELEASE_SCOPE_SHA256 = oldSha;
    }
  }));
test('global runtime-copy allowance includes transient duplicates across roots', () =>
  fixture((f) => {
    f.policy.maxNewRuntimeCopies = 1;
    f.save();
    assert.throws(
      () =>
        scope.open(
          {
            kind: 'install',
            root: f.installed,
            reserveBytes: 4096,
            runtimeCopies: 2,
          },
          f.options(),
        ),
      /RUNTIME_COPY_PEAK/,
    );
    const lease = scope.open(
        { kind: 'build', root: f.build, reserveBytes: 4096, runtimeCopies: 1 },
        f.options(),
      ),
      at = output(f, lease);
    fs.writeFileSync(path.join(at, 'node.exe'), 'inert duplicate');
    lease.close();
    assert.throws(
      () =>
        scope.open(
          {
            kind: 'install',
            root: f.installed,
            reserveBytes: 4096,
            runtimeCopies: 1,
          },
          f.options(),
        ),
      /RUNTIME_COPY_PEAK/,
    );
  }));
test('even a planned switch cannot silently change a shortcut or rollback reference', () =>
  fixture((f) => {
    const lease = f.open();
    f.facts.records.push({
      kind: 'shortcuts',
      packageId: 'current',
      packagePath: f.current,
      identity: 'different-stable-launcher',
    });
    assert.throws(() => lease.check(true), /REFERENCES_CHANGED/);
    assert.throws(
      () => lease.close(undefined, { transition: true }),
      /REFERENCES_CHANGED/,
    );
  }));
test('the async scope remains exclusive across a controller await boundary', () =>
  fixture(async (f) => {
    await scope.within(
      { kind: 'switch', root: f.installed, reserveBytes: 0 },
      async () => {
        assert(scope.requireSession());
        await Promise.resolve();
        assert.throws(() => f.open(1), /NESTED_OPEN_FORBIDDEN/);
        scope.requireSession().check();
      },
      f.options(),
    );
    assert.equal(scope.session(), undefined);
    const lease = f.open();
    lease.close();
  }));

function buildOnly(f) {
  f.policy.phase = 'build-only';
  delete f.policy.compatibilityProofSha256;
  f.policy.buildOnly = {
    sourceCommit: 'a'.repeat(40),
    sourceHash: 'b'.repeat(64),
    outputRoot: f.build,
    runtimeSha256: fileHash(process.execPath),
    commands: [],
  };
  f.facts.compatibility = { stage: 'build-only', verified: false };
  f.save();
  return {
    kind: 'build',
    root: f.build,
    reserveBytes: 4096,
    runtimeCopies: 1,
    buildOnly: true,
    sourceCommit: 'a'.repeat(40),
    sourceHash: 'b'.repeat(64),
  };
}
test('preserving build only accepts explicit inapplicable shortcuts and owned new output', () =>
  fixture((f) => {
    const request = buildOnly(f);
    f.policy.preservingUpdate = { format: 1, operation: 'build', effects: ['new-output-only'] };
    f.facts.complete = false; f.facts.observationComplete = true; f.facts.categories.shortcuts = 'not_applicable'; f.facts.categories.tasks = 'not_applicable';
    f.save();
    const gateway = require('./lib.cjs').hostEffects;
    scope.within(request, (lease) => {
      const candidate = path.join(f.build, 'preserved-candidate');
      lease.registerOutput(candidate); gateway.fs.mkdirSync(candidate); lease.createdOutput(candidate);
      gateway.fs.writeFileSync(path.join(candidate, 'owned'), 'synthetic');
      assert.throws(() => gateway.fs.writeFileSync(path.join(f.current, 'old'), 'forbidden'), /WRITE_OUTSIDE_OUTPUT/);
      assert.throws(() => gateway.fs.rmSync(f.current, { recursive: true }), /WRITE_OUTSIDE_OUTPUT/);
      assert.throws(() => gateway.fs.writeFileSync(path.join(candidate, 'active.json'), '{}'), /PRIVATE_INPUT/);
    }, f.options());
  }));
test('preserving build refuses incomplete observation', () =>
  fixture((f) => {
    const request = buildOnly(f);
    f.policy.preservingUpdate = { format: 1, operation: 'build', effects: ['new-output-only'] };
    f.facts.complete = false; f.facts.observationComplete = false; f.facts.categories.shortcuts = 'not_applicable'; f.facts.categories.tasks = 'not_applicable'; f.save();
    assert.throws(() => scope.open(request, f.options()), /QUERY_INCOMPLETE/);
  }));
test('original complete mode rejects an inapplicable-shortcuts observation', () =>
  fixture((f) => {
    const request = buildOnly(f);
    f.facts.complete = false; f.facts.observationComplete = true; f.facts.categories.shortcuts = 'not_applicable';
    assert.throws(() => scope.open(request, f.options()), /QUERY_INCOMPLETE/);
  }));
test('preserving build leaves failed owned output and holds the claim', () =>
  fixture((f) => {
    const request = buildOnly(f);
    f.policy.preservingUpdate = { format: 1, operation: 'build', effects: ['new-output-only'] };
    f.facts.complete = false; f.facts.observationComplete = true; f.facts.categories.shortcuts = 'not_applicable'; f.facts.categories.tasks = 'not_applicable'; f.save();
    const lease = scope.open(request, f.options());
    const target = path.join(f.build, 'failed-candidate');
    lease.registerOutput(target); fs.mkdirSync(target); lease.createdOutput(target);
    assert.throws(() => lease.allowCleanup([target]), /PRESERVING_CLEANUP_FORBIDDEN/);
    assert.throws(() => lease.close(new Error('synthetic failure')), /FAILED_OUTPUT_HELD/);
    assert(fs.existsSync(target));
    assert.throws(() => scope.open(request, f.options()), /INTERRUPTED_CLAIM/);
  }));
test('preserving restart denies direct active, old package and database writes', () =>
  fixture((f) => {
    const pointer = path.join(f.installed, 'active.json'); fs.writeFileSync(pointer, JSON.stringify({ format: 1, id: 'current' }));
    f.policy.preservingUpdate = { format: 1, operation: 'restart', effects: ['new-output-only', 'approved-active-switch'], active: { pointer, pointerSha256: fileHash(pointer), currentId: 'current', candidateId: 'candidate', currentManifestSha256: 'b'.repeat(64), candidateManifestSha256: 'e'.repeat(64), oldProcess: { pid: process.pid, startUtc: f.facts.records[0].startUtc, executableSha256: 'c'.repeat(64) } } };
    f.policy.packageProofs = { current: 'b'.repeat(64), candidate: 'e'.repeat(64) };
    f.facts.complete = false; f.facts.observationComplete = true; f.facts.categories.shortcuts = 'not_applicable';
    f.facts.records.push({ kind: 'pointers', packageId: 'current', packagePath: f.current, identity: 'synthetic-pointer', pointerPath: pointer }); f.save();
    const gateway = require('./lib.cjs').hostEffects;
    scope.within({ kind: 'restart', root: f.installed, reserveBytes: 4096 }, (lease) => {
      assert.throws(() => gateway.fs.writeFileSync(pointer, '{}'), /POINTER_COMMIT_FORBIDDEN/);
      assert.throws(() => gateway.fs.writeFileSync(path.join(f.current, 'old'), 'bad'), /WRITE_OUTSIDE_OUTPUT/);
      assert.throws(() => gateway.fs.rmSync(f.current, { recursive: true }), /WRITE_OUTSIDE_OUTPUT/);
      assert.throws(() => gateway.fs.writeFileSync(path.join(f.base, 'data.db'), 'bad'), /WRITE_OUTSIDE_OUTPUT/);
      assert.throws(() => f.open(), /NESTED_OPEN/);
    }, f.options());
  }));
test('build-only binds source and isolated output; incomplete references and install remain blocked', () =>
  fixture((f) => {
    const request = buildOnly(f);
    for (const change of [
      { kind: 'install' },
      { sourceHash: 'c'.repeat(64) },
      { root: f.installed },
      { transition: true },
      { buildOnly: false },
    ])
      assert.throws(
        () => scope.open({ ...request, ...change }, f.options()),
        /BUILD_ONLY_BINDING/,
      );
    f.facts.complete = false;
    assert.throws(() => scope.open(request, f.options()), /QUERY_INCOMPLETE/);
    f.facts.complete = true;
    const lease = scope.open(request, f.options());
    assert.throws(
      () => lease.authorizePackage(f.current),
      /BUILD_ONLY_NO_INSTALL/,
    );
    lease.close();
  }));
test('build-only creates owned artifacts but rejects database, private config, process and pointer effects', () =>
  fixture(async (f) => {
    const request = buildOnly(f),
      gateway = require('./lib.cjs').hostEffects;
    await scope.within(
      request,
      async (lease) => {
        const output = path.join(f.build, 'candidate');
        lease.registerOutput(output);
        gateway.fs.mkdirSync(output);
        lease.createdOutput(output);
        gateway.fs.writeFileSync(
          path.join(output, 'build.log'),
          'synthetic compiler output',
        );
        const fd = gateway.fs.openSync(path.join(output, 'second.log'), 'wx');
        gateway.fs.writeSync(fd, 'owned');
        gateway.fs.closeSync(fd);
        assert.throws(
          () => gateway.fs.writeSync(fd, 'late'),
          /DESCRIPTOR_FORBIDDEN/,
        );
        assert.throws(
          () =>
            gateway.fs.writeFileSync(
              path.join(f.current, 'changed'),
              'forbidden',
            ),
          /WRITE_OUTSIDE_OUTPUT/,
        );
        assert.throws(
          () => gateway.fs.readFileSync(path.join(f.base, 'production.db')),
          /PRIVATE_INPUT/,
        );
        assert.throws(
          () =>
            gateway.fs.writeFileSync(path.join(output, 'active.json'), '{}'),
          /PRIVATE_INPUT/,
        );
        assert.throws(
          () =>
            require('./startup-sqlite.cjs').inspectDatabase(
              path.join(f.base, 'production.db'),
              '',
            ),
          /RUNTIME_FORBIDDEN/,
        );
        assert.throws(
          () => require('./switch.cjs').loadProductionEnvironment(),
          /RUNTIME_FORBIDDEN/,
        );
        await assert.rejects(
          require('./runtime.cjs').runtime(),
          /RUNTIME_FORBIDDEN/,
        );
        await assert.rejects(
          require('./restart.cjs').controlledRestart({ production: true }),
          /NOT_AUTHORIZED/,
        );
        assert.throws(
          () =>
            gateway.processes.execFileSync(process.execPath, [
              '-e',
              'process.exit(0)',
            ]),
          /COMMAND_FORBIDDEN/,
        );
        await assert.rejects(
          async () =>
            require('node:util').promisify(gateway.processes.execFile)(
              process.execPath,
              ['-e', 'process.exit(0)'],
            ),
          /COMMAND_FORBIDDEN/,
        );
      },
      f.options(),
    );
    assert.equal(
      fs.readFileSync(path.join(f.build, 'candidate/build.log'), 'utf8'),
      'synthetic compiler output',
    );
    assert(!fs.existsSync(path.join(f.current, 'changed')));
  }));
test('a build-only policy cannot adopt an existing unmanaged output root', () =>
  fixture((f) => {
    const request = buildOnly(f);
    fs.writeFileSync(path.join(f.build, 'unowned'), 'preserve');
    assert.throws(
      () => scope.open(request, f.options()),
      /BUILD_ROOT_NOT_EMPTY/,
    );
    assert.equal(
      fs.readFileSync(path.join(f.build, 'unowned'), 'utf8'),
      'preserve',
    );
  }));

function repairFixture(run){return fixture(f=>{
  const {request}=splitPreservingBuild(f),old=structuredClone(f.policy),next=structuredClone(f.policy);
  old.buildOnly.sourceCommit='c'.repeat(40);old.buildOnly.sourceHash='c'.repeat(64);
  const probe=path.join(f.base,'synthetic-probe.cjs');fs.writeFileSync(probe,'// never executed');
  old.probe={path:probe,sha256:'a'.repeat(64)};next.probe={path:probe,sha256:fileHash(probe)};
  const oldFile=path.join(f.base,'old-reviewed-policy.json');fs.writeFileSync(oldFile,JSON.stringify(old));
  const oldSha=fileHash(oldFile),query=()=>structuredClone(f.facts);
  f.facts.observationComplete=false;
  assert.throws(()=>scope.open({...request,sourceCommit:old.buildOnly.sourceCommit,sourceHash:old.buildOnly.sourceHash},
    {configPath:oldFile,configSha256:oldSha,query}),/REFERENCE_QUERY_INCOMPLETE/);
  f.facts.observationComplete=true;
  const ledger=path.join(f.base,f.policy.scopeId+'.state.json'),adopted=ledger+'.adopted';
  const prior=JSON.parse(fs.readFileSync(ledger,'utf8'));prior.payload.futureCounter={used:7,history:['keep']};
  prior.digest=require('node:crypto').createHash('sha256').update(JSON.stringify(prior.payload)).digest('hex');fs.writeFileSync(ledger,JSON.stringify(prior));
  const original=fs.readFileSync(ledger),origin=fs.readFileSync(adopted),st=fs.lstatSync(ledger,{bigint:true});
  const approval=path.join(f.base,'reviewed-binding-repair.json');
  const receipt={format:1,kind:'adopted-empty-build-binding-repair',scopeId:old.scopeId,registryDirectory:old.registryDirectory,registryIdentity:old.registryIdentity,
    oldPolicyPath:oldFile,oldPolicySha256:oldSha,newPolicySha256:'',priorLedgerSha256:fileHash(ledger),priorPayloadDigest:prior.digest,
    priorLedgerIdentity:[st.dev,st.ino,st.birthtimeNs].map(String),adoptionSha256:fileHash(adopted),
    auditedSourceIdentity:'b'.repeat(64),reviewEvidence:'synthetic independent approval',allowedDifferences:['buildOnly.sourceCommit','buildOnly.sourceHash','probe.sha256']};
  const save=()=>{fs.writeFileSync(f.config,JSON.stringify(next));receipt.newPolicySha256=fileHash(f.config);fs.writeFileSync(approval,JSON.stringify(receipt));};save();
  const options=()=>({configPath:f.config,configSha256:fileHash(f.config),query,bindingRepairFile:approval,bindingRepairSha256:fileHash(approval)});
  run({f,request,old,next,receipt,save,options,ledger,adopted,approval,original,origin,prior,open:extra=>scope.open(request,{...options(),...extra})});
});}
test('preserving binding repair preserves origin, all counters and exact replay',()=>repairFixture(x=>{
  x.open().close();let d=JSON.parse(fs.readFileSync(x.ledger));
  assert.deepEqual(d.payload.futureCounter,x.prior.payload.futureCounter);assert.equal(d.payload.configSha,x.receipt.newPolicySha256);
  assert.deepEqual(d.payload.outputs,[]);assert.equal(d.payload.claim,null);assert(d.payload.bindingRepair);
  assert(fs.readFileSync(x.adopted).equals(x.origin));const saved=fs.readFileSync(x.ledger);
  x.open().close();assert(fs.readFileSync(x.ledger).equals(saved));
}));
for(const kind of ['receipt','budget','root','claim','outputs','adoption','ledger','source-delta'])
 test('preserving binding repair rejects '+kind,()=>repairFixture(x=>{
  if(kind==='receipt')x.receipt.priorPayloadDigest='0'.repeat(64);
  if(kind==='budget')x.next.maxGrowthBytes++;
  if(kind==='root')x.next.roots[0].identity[1]='999';
  if(kind==='source-delta')x.receipt.allowedDifferences.push('maxBytes');
  if(kind==='claim'||kind==='outputs'){const d=JSON.parse(fs.readFileSync(x.ledger));if(kind==='claim')d.payload.claim={id:'unknown'};else d.payload.outputs=[{path:x.f.build}];d.digest=require('node:crypto').createHash('sha256').update(JSON.stringify(d.payload)).digest('hex');fs.writeFileSync(x.ledger,JSON.stringify(d));}
  if(kind==='adoption')fs.writeFileSync(x.adopted,'0'.repeat(64));
  if(kind==='ledger')fs.writeFileSync(x.ledger,'invalid');
  x.save();const before=fs.readFileSync(x.ledger);assert.throws(()=>x.open());assert(fs.readFileSync(x.ledger).equals(before));
}));
for(const stage of ['before-snapshot','before-commit','after-commit'])
 test('preserving binding repair interruption '+stage+' keeps authoritative state',()=>repairFixture(x=>{
  assert.throws(()=>x.open({onBindingRepairStep:n=>{if(n===stage)throw Error('synthetic interruption');}}),/BINDING_REPAIR_REVIEW_REQUIRED/);
  const d=JSON.parse(fs.readFileSync(x.ledger));assert.equal(d.digest,require('node:crypto').createHash('sha256').update(JSON.stringify(d.payload)).digest('hex'));
  assert(fs.readFileSync(x.adopted).equals(x.origin));
  if(stage==='after-commit')assert.equal(d.payload.configSha,x.receipt.newPolicySha256);else assert(fs.readFileSync(x.ledger).equals(x.original));
  x.open().close();
}));
test('preserving binding repair concurrent child cannot acquire the existing scope lock',()=>repairFixture(x=>{
  let called=false;x.open({onBindingRepairStep:n=>{if(n!=='before-commit')return;
    const script="try{require(process.argv[1]).open(JSON.parse(process.argv[2]),JSON.parse(process.argv[3]));process.exit(2)}catch(e){if(e.code!=='EEXIST')process.exit(3)}";
    const opts=x.options();delete opts.query;
    require('node:child_process').execFileSync(process.execPath,['-e',script,path.join(__dirname,'release-scope.cjs'),JSON.stringify(x.request),JSON.stringify(opts)],{windowsHide:true,timeout:10000});called=true;
  }}).close();assert.equal(called,true);
}));
test('preserving binding repair still stops on incomplete native facts after committing binding',()=>repairFixture(x=>{
  x.f.facts.observationComplete=false;assert.throws(()=>x.open(),/REFERENCE_QUERY_INCOMPLETE/);
  const d=JSON.parse(fs.readFileSync(x.ledger));assert.equal(d.payload.configSha,x.receipt.newPolicySha256);
  assert.equal(d.payload.claim,null);assert.deepEqual(d.payload.outputs,[]);assert(fs.readFileSync(x.adopted).equals(x.origin));
}));
test('preserving binding repair rejects mismatched approval pin and missing approval',()=>repairFixture(x=>{
  assert.throws(()=>x.open({bindingRepairSha256:'0'.repeat(64)}),/BINDING_REPAIR_REVIEW_REQUIRED/);
  assert.throws(()=>scope.open(x.request,{configPath:x.f.config,configSha256:fileHash(x.f.config),query:()=>structuredClone(x.f.facts)}),/STATE_INVALID/);
  assert(fs.readFileSync(x.ledger).equals(x.original));
}));
test('preserving binding repair rejects tampered audit snapshot on exact replay',()=>repairFixture(x=>{
  x.open().close();const original=fs.readFileSync(x.ledger),snapshot=x.ledger+'.binding-repair-'+fileHash(x.approval)+'.json';
  fs.appendFileSync(snapshot,'tampered');assert.throws(()=>x.open(),/BINDING_REPAIR_REVIEW_REQUIRED/);
  assert(fs.readFileSync(x.ledger).equals(original));assert(fs.readFileSync(x.adopted).equals(x.origin));
}));
test('preserving binding repair compare and swap refuses a late changed counter',()=>repairFixture(x=>{
  assert.throws(()=>x.open({onBindingRepairStep:n=>{if(n!=='before-commit')return;
    const d=JSON.parse(fs.readFileSync(x.ledger));d.payload.futureCounter.used=8;
    d.digest=require('node:crypto').createHash('sha256').update(JSON.stringify(d.payload)).digest('hex');fs.writeFileSync(x.ledger,JSON.stringify(d));
  }}),/BINDING_REPAIR_REVIEW_REQUIRED/);
  assert.equal(JSON.parse(fs.readFileSync(x.ledger)).payload.futureCounter.used,8);
  assert(fs.readFileSync(x.adopted).equals(x.origin));
}));
for(const claim of [false,0])
 test('preserving binding repair rejects non-null falsy claim '+String(claim),()=>repairFixture(x=>{
  const d=JSON.parse(fs.readFileSync(x.ledger));d.payload.claim=claim;
  d.digest=require('node:crypto').createHash('sha256').update(JSON.stringify(d.payload)).digest('hex');
  fs.writeFileSync(x.ledger,JSON.stringify(d));
  x.receipt.priorLedgerSha256=fileHash(x.ledger);x.receipt.priorPayloadDigest=d.digest;x.save();
  const before=fs.readFileSync(x.ledger);
  assert.throws(()=>x.open(),/RELEASE_SCOPE_BINDING_REPAIR_REVIEW_REQUIRED/);
  assert(fs.readFileSync(x.ledger).equals(before));assert(fs.readFileSync(x.adopted).equals(x.origin));
  assert.equal(fs.readdirSync(x.f.base).some(n=>n.includes('.binding-repair-')),false);
 }));
for(const missing of ['ledger','adoption','both'])
 test('preserving binding repair refuses missing '+missing+' without adoption',()=>repairFixture(x=>{
  if(missing!=='adoption')fs.unlinkSync(x.ledger);
  if(missing!=='ledger')fs.unlinkSync(x.adopted);
  const before=fs.readdirSync(x.f.base).sort();
  assert.throws(()=>x.open(),/RELEASE_SCOPE_BINDING_REPAIR_REVIEW_REQUIRED/);
  assert.deepEqual(fs.readdirSync(x.f.base).sort(),before);
  assert.equal(fs.existsSync(x.ledger),missing==='adoption');
  assert.equal(fs.existsSync(x.adopted),missing==='ledger');
  if(missing==='adoption')assert(fs.readFileSync(x.ledger).equals(x.original));
  if(missing==='ledger')assert(fs.readFileSync(x.adopted).equals(x.origin));
 }));

for(const mode of ['missing-marker','foreign-marker','process-record'])test('preserving split build rejects invalid control observation '+mode,()=>fixture(f=>{
 const {request}=splitPreservingBuild(f);if(mode==='missing-marker')delete f.facts.processObservation;if(mode==='foreign-marker')f.facts.processObservation='complete';if(mode==='process-record')f.facts.records.push({kind:'processes'});assert.throws(()=>scope.open(request,f.options()),/REFERENCE_QUERY_INCOMPLETE/);
}));
test('original complete mode rejects build control marker',()=>fixture(f=>{f.facts.processObservation='build-control-only';assert.throws(()=>f.open(),/REFERENCE_QUERY_INCOMPLETE/);}));

function successorReceipt(x,tag){
 const bytes=fs.readFileSync(x.f.config),oldFile=path.join(x.f.base,'approved-predecessor-'+tag+'.json');fs.writeFileSync(oldFile,bytes);
 const ledger=fs.readFileSync(x.ledger),d=JSON.parse(ledger),st=fs.lstatSync(x.ledger,{bigint:true}),h=d.payload.bindingRepair;
 Object.assign(x.receipt,{format:2,initialPolicySha256:fs.readFileSync(x.adopted,'utf8'),oldPolicyPath:oldFile,oldPolicySha256:fileHash(oldFile),priorLedgerSha256:fileHash(x.ledger),priorPayloadDigest:d.digest,priorLedgerIdentity:[st.dev,st.ino,st.birthtimeNs].map(String),predecessorApprovalSha256:h.approvalSha256,predecessorSnapshotSha256:h.snapshotSha256,allowedDifferences:['buildOnly.sourceCommit','buildOnly.sourceHash']});
 x.next.buildOnly.sourceCommit=tag.repeat(40);x.next.buildOnly.sourceHash=tag.repeat(64);x.request.sourceCommit=x.next.buildOnly.sourceCommit;x.request.sourceHash=x.next.buildOnly.sourceHash;x.save();return ledger;
}
test('preserving binding successor v1 to two separately approved v2 heads preserves audit and exact replay',()=>repairFixture(x=>{
 x.open().close();const first=fs.readdirSync(x.f.base).filter(n=>n.includes('.binding-repair-'));const firstBytes=fs.readFileSync(path.join(x.f.base,first[0]));
 for(const tag of ['d','e']){const previous=successorReceipt(x,tag);x.open().close();const committed=fs.readFileSync(x.ledger),d=JSON.parse(committed);assert.equal(d.payload.bindingRepair.format,2);assert.deepEqual(d.payload.futureCounter,{used:7,history:['keep']});const snapshot=JSON.parse(fs.readFileSync(x.ledger+'.binding-repair-'+fileHash(x.approval)+'.json'));assert(Buffer.from(snapshot.ledgerBase64,'base64').equals(previous));x.open().close();assert(fs.readFileSync(x.ledger).equals(committed));}
 assert(fs.readFileSync(x.adopted).equals(x.origin));assert(fs.readFileSync(path.join(x.f.base,first[0])).equals(firstBytes));assert.equal(fs.readdirSync(x.f.base).filter(n=>n.includes('.binding-repair-')).length,3);
}));
for(const kind of ['old-approval','initial-policy','predecessor-approval','predecessor-snapshot','bad-snapshot','fork','budget','missing-approval'])test('preserving binding successor rejects '+kind,()=>repairFixture(x=>{
 x.open().close();const oldApproval=fs.readFileSync(x.approval),previous=successorReceipt(x,'d');
 if(kind==='initial-policy')x.receipt.initialPolicySha256='0'.repeat(64);
 if(kind==='predecessor-approval')x.receipt.predecessorApprovalSha256='0'.repeat(64);
 if(kind==='predecessor-snapshot')x.receipt.predecessorSnapshotSha256='0'.repeat(64);
 if(kind==='fork')x.receipt.priorLedgerSha256='0'.repeat(64);
 if(kind==='budget')x.next.maxGrowthBytes++;
 if(kind==='bad-snapshot'){const h=JSON.parse(previous).payload.bindingRepair;fs.appendFileSync(x.ledger+'.binding-repair-'+h.approvalSha256+'.json','bad');}
 x.save();if(kind==='old-approval')fs.writeFileSync(x.approval,oldApproval);
 assert.throws(()=>x.open(kind==='missing-approval'?{bindingRepairFile:'',bindingRepairSha256:''}:{}),/BINDING_REPAIR|STATE_INVALID/);assert(fs.readFileSync(x.ledger).equals(previous));assert(fs.readFileSync(x.adopted).equals(x.origin));
}));
for(const stage of ['before-snapshot','before-commit','after-commit'])test('preserving binding successor fault '+stage+' retains valid authority',()=>repairFixture(x=>{
 x.open().close();const previous=successorReceipt(x,'d');assert.throws(()=>x.open({onBindingRepairStep:n=>{if(n===stage)throw Error('synthetic');}}),/BINDING_REPAIR/);
 const d=JSON.parse(fs.readFileSync(x.ledger));assert.equal(d.digest,require('node:crypto').createHash('sha256').update(JSON.stringify(d.payload)).digest('hex'));if(stage!=='after-commit')assert(fs.readFileSync(x.ledger).equals(previous));x.open().close();assert(fs.readFileSync(x.adopted).equals(x.origin));
}));
test('preserving binding successor concurrent child is refused by same lock',()=>repairFixture(x=>{
 x.open().close();successorReceipt(x,'d');let called=false;x.open({onBindingRepairStep:n=>{if(n!=='before-commit')return;const script="try{require(process.argv[1]).open(JSON.parse(process.argv[2]),JSON.parse(process.argv[3]));process.exit(2)}catch(e){if(e.code!=='EEXIST')process.exit(3)}";const opts=x.options();delete opts.query;require('node:child_process').execFileSync(process.execPath,['-e',script,path.join(__dirname,'release-scope.cjs'),JSON.stringify(x.request),JSON.stringify(opts)],{windowsHide:true,timeout:10000});called=true;}}).close();assert(called);
}));
