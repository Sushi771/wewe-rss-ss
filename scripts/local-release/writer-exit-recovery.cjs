'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const stamp=p=>{const s=fs.lstatSync(p,{bigint:true});assert(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1n&&s.ino,'EXIT_OBJECT_UNPROVEN');return [s.dev,s.ino,s.birthtimeNs].map(String);};
function durable(p,value){const fd=fs.openSync(p,'wx',0o600);try{fs.writeFileSync(fd,value);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
// A new explicit abnormal-exit contract; no Stop receipt or historical source result is manufactured.
function recover({root,database,gate,sessions,expected,probe,verifyOnly=false}){
 root=fs.realpathSync.native(root);database=fs.realpathSync.native(database);const b=gate.binding(database);
 const lockPaths=[path.join(root,'.local-releases/.build-budget.lock'),path.join(root,'.active-release.lock')];
 const held=lockPaths.map(p=>{const s=sessions.find(x=>path.resolve(x.path)===p);assert(s&&typeof s.assertOwned==='function','EXIT_SESSION_REQUIRED');s.assertOwned();const raw=fs.readFileSync(p);const j=JSON.parse(raw);assert(j.pid===process.pid&&typeof j.token==='string'&&j.token.length,'EXIT_LOCK_OWNER');return{s,p,raw,id:stamp(p)};});
 function own(){for(const l of held){l.s.assertOwned();assert.deepEqual(stamp(l.p),l.id);assert(fs.readFileSync(l.p).equals(l.raw));}assert.equal(gate.binding(database).databaseIdentity,b.databaseIdentity);}
 const history=path.join(root,'.local-releases/.writer-exit-recovery');
 if(fs.existsSync(history)){assert(fs.realpathSync.native(history)===history&&!fs.lstatSync(history).isSymbolicLink());const entries=fs.readdirSync(history);assert(entries.length<128,'EXIT_HISTORY_LIMIT');for(const n of entries){assert(/^[a-f0-9]{64}$/.test(n),'EXIT_HISTORY_UNKNOWN');const d=path.join(history,n);assert(fs.lstatSync(d).isDirectory()&&!fs.lstatSync(d).isSymbolicLink());assert(fs.existsSync(path.join(d,'complete.json')),'EXIT_PRIOR_ATTEMPT_UNRESOLVED');}}
 if(!fs.existsSync(b.file)){own();return {status:'no-lease'};}
 const id=stamp(b.file),raw=fs.readFileSync(b.file);assert(raw.length<16384,'EXIT_LEASE_LIMIT');const r=JSON.parse(raw);
 const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);const born=Date.parse(r.startUtc);
 assert(r.version===1&&r.mode==='writer'&&r.databaseIdentity===b.databaseIdentity&&Number.isSafeInteger(r.pid)&&r.pid>0&&r.pid!==process.pid&&typeof r.startUtc==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z$/.test(r.startUtc)&&Number.isFinite(born)&&typeof r.nonce==='string'&&/^[a-f0-9-]{36}$/.test(r.nonce)&&Number.isSafeInteger(r.acquiredAt)&&r.acquiredAt>=born&&r.acquiredAt<=Date.now()&&hex(r.executableHash)&&hex(r.commandHash),'EXIT_LEASE_IDENTITY_MISSING');
 assert.equal(r.executableHash,expected.executableHash,'EXIT_UNAPPROVED_EXE');assert.equal(r.commandHash,expected.commandHash,'EXIT_UNAPPROVED_COMMAND');
 if(expected.leaseSha256)assert.equal(hash(raw),expected.leaseSha256,'EXIT_LEASE_CHANGED');
 function observe(){own();assert.deepEqual(stamp(b.file),id);assert(fs.readFileSync(b.file).equals(raw),'EXIT_LEASE_CHANGED');const v=probe(Object.freeze({...r}));own();assert(v&&v.complete===true&&Array.isArray(v.remaining)&&Array.isArray(v.portOwners)&&v.portOwners.length===0,'EXIT_OBSERVATION_INCOMPLETE');const boot=Date.parse(v.bootUtc),at=Date.parse(v.atUtc);assert(Number.isFinite(boot)&&Number.isFinite(at)&&boot<=at&&at>=r.acquiredAt&&Math.abs(Date.now()-at)<30000,'EXIT_BOOT_UNPROVEN');
  if(boot>born){assert(!v.owner||Date.parse(v.owner.startUtc)>=boot,'EXIT_BOOT_CONTRADICTION');return {fact:v,reason:'owner-from-prior-boot'};}
  if(v.owner){assert(v.owner.pid===r.pid&&typeof v.owner.startUtc==='string','EXIT_OWNER_UNPROVEN');throw Error(v.owner.startUtc===r.startUtc?'EXIT_OWNER_ALIVE':'EXIT_PID_REUSED_SAME_BOOT');}
  assert(v.remaining.length===0,'EXIT_DESCENDANT_PRESENT');return {fact:v,reason:'known-lease-owner-absent-with-complete-same-boot-tree'};
 }
 const first=observe(),second=observe();assert.equal(first.fact.bootUtc,second.fact.bootUtc,'EXIT_BOOT_CHANGED');assert.equal(first.reason,second.reason);assert(Date.parse(second.fact.atUtc)>=Date.parse(first.fact.atUtc));
 own();assert.deepEqual(stamp(b.file),id);assert(fs.readFileSync(b.file).equals(raw),'EXIT_LEASE_CHANGED');
 if(verifyOnly)return {status:'eligible-without-mutation',leaseSha256:hash(raw),reason:first.reason};
 if(!fs.existsSync(history))fs.mkdirSync(history);const dest=path.join(history,hash(raw));fs.mkdirSync(dest);const preserved=path.join(dest,'lease.json');
 durable(path.join(dest,'intent.json'),JSON.stringify({format:1,kind:'verified-abnormal-project-writer-exit',leaseSha256:hash(raw),original:b.file,originalIdentity:id,databaseIdentity:b.databaseIdentity,ownerResult:'unknown',sourceOutcome:'unknown',reason:first.reason,observations:[first.fact,second.fact]})+'\n');
 own();assert.deepEqual(stamp(b.file),id);assert(fs.readFileSync(b.file).equals(raw),'EXIT_LEASE_CHANGED');assert.equal(fs.statSync(dest).dev,fs.statSync(path.dirname(b.file)).dev,'EXIT_DIFFERENT_VOLUME');
 fs.renameSync(b.file,preserved);assert(fs.readFileSync(preserved).equals(raw));assert.deepEqual(stamp(preserved),id);own();
 durable(path.join(dest,'complete.json'),JSON.stringify({leaseSha256:hash(raw),originalIdentity:id,reason:first.reason,sourceOutcome:'unknown'})+'\n');return {status:'preserved-abnormal-exit-lease',receipt:dest,reason:first.reason};
}
module.exports={recover};
