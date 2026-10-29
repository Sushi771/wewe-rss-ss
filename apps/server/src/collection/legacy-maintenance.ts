import { createHash } from 'node:crypto';
export type Identity={pid:number;startIdentity:string;executableHash:string;commandHash:string};
export type Scope={jobId:string;authorId:string;noteId:string;projectIdentity:string;databaseIdentity:string;unknownDigest:string;budgetDigest:string};
export type Evidence={scope:Scope;capturedAt:number;lock:{nonce:string;identity:string;projectIdentity:string;holder:Identity;held:boolean;coverage:'project-start-dispatch-v1'|'project-start-dispatch-v2';acquiredAt:number;claimAcquiredAt?:number};writers:{complete:boolean;projectIdentity:string;expected:Identity[];stopped:{identity:Identity;exitedAt:number}[];active:Identity[];observedAt?:number};probe:{databaseIdentity:string;mode:'exclusive';succeeded:boolean;enteredAt:number;rolledBackAt:number;connectionClosedAt:number};snapshot:{databaseIdentity:string;unknownDigest:string;budgetDigest:string;capturedAt:number;connectionClosedAt:number}};
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail=():never=>{throw Error('LEGACY_MAINTENANCE_UNPROVEN')};
const hex=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const time=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>=0;
const startIdentity=(v:unknown)=>typeof v==='string'&&(/^[0-9]{15,20}$/.test(v)||(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(v)&&Number.isFinite(Date.parse(v))));
const identity=(v:Identity)=>v&&Number.isSafeInteger(v.pid)&&v.pid>0&&startIdentity(v.startIdentity)&&hex(v.executableHash)&&hex(v.commandHash);
function sameScope(a:Scope,b:Scope){return !!a&&!!b&&['jobId','authorId','noteId','projectIdentity','databaseIdentity','unknownDigest','budgetDigest'].every(k=>a[k as keyof Scope]===b[k as keyof Scope]);}
function scopeValid(s:Scope){if(!s||!['jobId','authorId','noteId'].every(k=>typeof s[k as keyof Scope]==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(s[k as keyof Scope]))||![s.projectIdentity,s.databaseIdentity,s.unknownDigest,s.budgetDigest].every(hex))return fail();}
/** Pure consistency check only. A successful digest never authorizes a retry. */
export function validateMaintenance(scope:Scope,e:Evidence,now:number):string{
 scopeValid(scope);
 if(!e||!sameScope(scope,e.scope)||!time(now)||!time(e.capturedAt)||e.capturedAt>now||now-e.capturedAt>30000)return fail();
 const {lock:l,writers:w,probe:p,snapshot:s}=e;
 if(!l||l.held!==true||!['project-start-dispatch-v1','project-start-dispatch-v2'].includes(l.coverage)||l.projectIdentity!==scope.projectIdentity||!hex(l.identity)||typeof l.nonce!=='string'||!/^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.test(l.nonce)||!identity(l.holder)||!time(l.acquiredAt)||l.acquiredAt>e.capturedAt)return fail();
 if(!w||w.complete!==true||w.projectIdentity!==scope.projectIdentity||!Array.isArray(w.active)||w.active.length||!Array.isArray(w.expected)||!w.expected.length||w.expected.length>16||!Array.isArray(w.stopped)||w.stopped.length!==w.expected.length)return fail();
 if(w.expected.some(v=>!identity(v)||v.pid===l.holder.pid)||new Set(w.expected.map(v=>v.pid)).size!==w.expected.length)return fail();
 const expected=w.expected.map(hash),stopped=w.stopped.map(v=>{if(!identity(v.identity)||!time(v.exitedAt)||v.exitedAt<(l.coverage==='project-start-dispatch-v1'?l.acquiredAt:l.claimAcquiredAt!)||v.exitedAt>e.capturedAt)return fail();return hash(v.identity)});
 if(new Set(stopped).size!==stopped.length||expected.some(v=>!stopped.includes(v)))return fail();
 if(l.coverage==='project-start-dispatch-v2'&&(!time(l.claimAcquiredAt)||l.claimAcquiredAt>l.acquiredAt))return fail();
 if(l.coverage==='project-start-dispatch-v2'&&(!time(w.observedAt)||w.observedAt>e.capturedAt||now-w.observedAt>30000))return fail();
 const exitedAt=Math.max(...w.stopped.map(v=>v.exitedAt));
 if(!p||p.databaseIdentity!==scope.databaseIdentity||p.mode!=='exclusive'||p.succeeded!==true||![p.enteredAt,p.rolledBackAt,p.connectionClosedAt].every(time)||p.enteredAt<Math.max(exitedAt,l.acquiredAt)||p.rolledBackAt<p.enteredAt||p.connectionClosedAt<p.rolledBackAt||p.connectionClosedAt>e.capturedAt)return fail();
 if(!s||s.databaseIdentity!==scope.databaseIdentity||s.unknownDigest!==scope.unknownDigest||s.budgetDigest!==scope.budgetDigest||!time(s.capturedAt)||!time(s.connectionClosedAt)||s.capturedAt<exitedAt||s.connectionClosedAt<s.capturedAt||s.connectionClosedAt>e.capturedAt)return fail();
 return hash(e);
}
/** Backend controller port, never a client-submitted proof. Default is unsupported. */
export type Controller=(scope:Readonly<Scope>)=>Promise<Evidence>;
export class LegacyMaintenanceVerifier{
 private tokens=new WeakMap<object,{scope:Scope;evidence:Evidence}>();
 constructor(private readonly observe:Controller=async()=>fail(), private readonly clock:()=>number=Date.now){}
 async collectFromController(scope:Scope):Promise<object>{
  scopeValid(scope);const bound=structuredClone(scope);const e=structuredClone(await this.observe(Object.freeze(structuredClone(bound))));validateMaintenance(bound,e,this.clock());
  const token=Object.freeze({});this.tokens.set(token,{scope:bound,evidence:e});return token;
 }
 /** One-shot record proposal: the service must persist atomically and retain its separate execution guards. */
 async takeForPersistence(token:object,scope:Scope){
  const old=this.tokens.get(token);this.tokens.delete(token);if(!old||!sameScope(old.scope,scope))return fail();
  validateMaintenance(old.scope,old.evidence,this.clock());
  const fresh=structuredClone(await this.observe(Object.freeze(structuredClone(old.scope))));
  const now=this.clock();validateMaintenance(old.scope,old.evidence,now);const digest=validateMaintenance(old.scope,fresh,now);
  const a=old.evidence,b=fresh;
  if(b.capturedAt<a.capturedAt||hash(a.lock)!==hash(b.lock)||hash(a.writers)!==hash(b.writers)||hash(a.probe)!==hash(b.probe)||hash(a.snapshot)!==hash(b.snapshot))return fail();
  return Object.freeze({version:1,boundaryVersion:b.lock.coverage,snapshot:Object.freeze(structuredClone(b.snapshot)),proofId:hash({scope:old.scope,lockIdentity:b.lock.identity,lockNonce:b.lock.nonce,holder:b.lock.holder,snapshot:b.snapshot}),scope:Object.freeze(structuredClone(old.scope)),observationDigest:digest,recordedAt:now,lockIdentity:b.lock.identity,lockNonce:b.lock.nonce,holder:Object.freeze(structuredClone(b.lock.holder)),oldOwner:null,oldResult:'unknown' as const,allowsRetry:false as const,claim:'no-local-project-writer-at-observation' as const});
 }
}
