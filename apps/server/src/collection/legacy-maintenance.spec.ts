import {LegacyMaintenanceVerifier,validateMaintenance,Scope,Evidence,Identity,Controller} from './legacy-maintenance';
let serverNow=7000;beforeEach(()=>{serverNow=7000});
const makeVerifier=(observe?:Controller)=>new LegacyMaintenanceVerifier(observe,()=>serverNow);
const h=(c:string)=>c.repeat(64);
const ident=(pid:number):Identity=>({pid,startIdentity:'638000000000000000',executableHash:h('a'),commandHash:h('b')});
const scope:Scope={jobId:'job',authorId:'author',noteId:'note',projectIdentity:h('c'),databaseIdentity:h('d'),unknownDigest:h('e'),budgetDigest:h('f')};
function fixture():Evidence{return {scope:structuredClone(scope),capturedAt:6000,lock:{nonce:'00000000-0000-4000-8000-000000000001',identity:h('a'),projectIdentity:scope.projectIdentity,holder:ident(20),held:true,coverage:'project-start-dispatch-v1',acquiredAt:1000},writers:{complete:true,projectIdentity:scope.projectIdentity,expected:[ident(10)],stopped:[{identity:ident(10),exitedAt:3000}],active:[]},probe:{databaseIdentity:scope.databaseIdentity,mode:'exclusive',succeeded:true,enteredAt:4000,rolledBackAt:4100,connectionClosedAt:4200},snapshot:{databaseIdentity:scope.databaseIdentity,unknownDigest:scope.unknownDigest,budgetDigest:scope.budgetDigest,capturedAt:5000,connectionClosedAt:5100}};}
const reject=(e:Evidence)=>expect(()=>validateMaintenance(scope,e,7000)).toThrow('LEGACY_MAINTENANCE_UNPROVEN');
it('accepts only complete scope-bound facts, preserving missing owner and unknown result',async()=>{
 const observe=jest.fn(async()=>fixture());const verifier=makeVerifier(observe);const cap=await verifier.collectFromController(scope);
 const record=await verifier.takeForPersistence(cap,scope);expect(record).toMatchObject({oldOwner:null,oldResult:'unknown',allowsRetry:false,claim:'no-local-project-writer-at-observation'});expect(observe).toHaveBeenCalledTimes(2);
 await expect(verifier.takeForPersistence(cap,scope)).rejects.toThrow();
});
it('refuses client-submitted JSON, an unissued object, or a token from another controller',async()=>{
 const verifier=makeVerifier(async()=>fixture());await expect(verifier.takeForPersistence(fixture(),scope)).rejects.toThrow();
 const cap=await verifier.collectFromController(scope);const second=makeVerifier(async()=>fixture());await expect(second.takeForPersistence(cap,scope)).rejects.toThrow();
});
it('refuses the unsupported default adapter rather than trusting an old restart summary',async()=>{
 await expect(makeVerifier().collectFromController(scope)).rejects.toThrow();reject({oldStopped:true,passed:true} as any);
});
it.each(['disabled-lock','new-lock','new-holder','new-writer','new-budget','new-fence','new-db'])('refuses live evidence change: %s',async change=>{
 let value=fixture();const verifier=makeVerifier(async()=>structuredClone(value));const cap=await verifier.collectFromController(scope);
 if(change==='disabled-lock')value.lock.held=false;
 if(change==='new-lock')value.lock.nonce='00000000-0000-4000-8000-000000000002';
 if(change==='new-holder')value.lock.holder.startIdentity='638000000000000001';
 if(change==='new-writer')value.writers.active.push(ident(30));
 if(change==='new-budget')value.snapshot.budgetDigest=h('a');
 if(change==='new-fence')value.snapshot.unknownDigest=h('a');
 if(change==='new-db')value.snapshot.databaseIdentity=h('a');
 await expect(verifier.takeForPersistence(cap,scope)).rejects.toThrow();
});
it('refuses PID reuse or a stop receipt for another executable/command',()=>{
 for(const key of ['startIdentity','executableHash','commandHash'] as const){const e=fixture();e.writers.stopped[0].identity[key]=key==='startIdentity'?'638000000000000001':h('f');reject(e)}
});
it('refuses incomplete writers or an unobserved expected writer',()=>{
 const a=fixture();a.writers.complete=false;reject(a);const b=fixture();b.writers.expected.push(ident(30));reject(b);const c=fixture();c.writers.expected=[];c.writers.stopped=[];reject(c);
});
it('requires exclusive probe rollback and both database connections closed after stop',()=>{
 const a=fixture();a.probe.connectionClosedAt=0;reject(a);const b=fixture();b.snapshot.connectionClosedAt=0;reject(b);const c=fixture();c.probe.enteredAt=2000;reject(c);const d=fixture();d.probe.mode='read' as any;reject(d);
});
it('refuses expired or future observations and cannot refresh an expired issued token',async()=>{
 expect(()=>validateMaintenance(scope,fixture(),5000)).toThrow();expect(()=>validateMaintenance(scope,fixture(),40000)).toThrow();
 let e=fixture();const verifier=makeVerifier(async()=>e);const cap=await verifier.collectFromController(scope);e={...e,capturedAt:40000};serverNow=40000;await expect(verifier.takeForPersistence(cap,scope)).rejects.toThrow();
});
it('refuses a changed task scope before persistence',async()=>{
 const verifier=makeVerifier(async()=>fixture());const cap=await verifier.collectFromController(scope);await expect(verifier.takeForPersistence(cap,{...scope,noteId:'other'})).rejects.toThrow();
});
it('detaches scope and observations from caller mutation',async()=>{
 const e=fixture(),requested={...scope};const verifier=makeVerifier(async()=>e);const cap=await verifier.collectFromController(requested);requested.noteId='other';e.lock.held=false;await expect(verifier.takeForPersistence(cap,scope)).rejects.toThrow();
});
it('refuses truthy strings in place of verified booleans',()=>{
 const e=fixture();e.lock.held='false' as any;reject(e);const b=fixture();b.writers.complete='true' as any;reject(b);const c=fixture();c.probe.succeeded='true' as any;reject(c);
});
it('consumes the in-memory capability before asynchronous revalidation so concurrent callers cannot duplicate it',async()=>{
 const verifier=makeVerifier(async()=>fixture());const cap=await verifier.collectFromController(scope);const r=await Promise.allSettled([verifier.takeForPersistence(cap,scope),verifier.takeForPersistence(cap,scope)]);expect(r.filter(x=>x.status==='fulfilled')).toHaveLength(1);
});

it('derives a stable proof identity for a future unique persistence key without issuing retry authority',async()=>{
 const first=makeVerifier(async()=>fixture()),second=makeVerifier(async()=>fixture());
 const a=await first.collectFromController(scope),b=await second.collectFromController(scope);
 const x=await first.takeForPersistence(a,scope),y=await second.takeForPersistence(b,scope);
 expect(x.proofId).toBe(y.proofId);expect(x.proofId).toMatch(/^[a-f0-9]{64}$/);expect(x.allowsRetry).toBe(false);
});

it('can reuse exact existing restart UTC start identity without rounding or inventing an old owner',()=>{const e=fixture();const utc='2026-10-28T01:51:31.9191621Z';e.writers.expected[0].startIdentity=utc;e.writers.stopped[0].identity.startIdentity=utc;expect(validateMaintenance(scope,e,7000)).toMatch(/^[a-f0-9]{64}$/);e.writers.stopped[0].identity.startIdentity='2026-10-28T01:51:31.9191622Z';reject(e);});

it('rejects evidence that expires while the initial asynchronous observation is pending',async()=>{
 const verifier=makeVerifier(async()=>{serverNow+=44000;return fixture()});
 await expect(verifier.collectFromController(scope)).rejects.toThrow('LEGACY_MAINTENANCE_UNPROVEN');
});
it('rechecks both old and fresh evidence after delayed persistence observation',async()=>{
 let calls=0;const verifier=makeVerifier(async()=>{if(++calls===2){serverNow+=44000;return {...fixture(),capturedAt:serverNow}}return fixture()});
 const token=await verifier.collectFromController(scope);
 await expect(verifier.takeForPersistence(token,scope)).rejects.toThrow('LEGACY_MAINTENANCE_UNPROVEN');
});
it('permits observations that finish promptly with a fresh server time',async()=>{
 const verifier=makeVerifier(async()=>{serverNow+=5;return fixture()});
 const token=await verifier.collectFromController(scope);const result=await verifier.takeForPersistence(token,scope);
 expect(result.recordedAt).toBe(7010);expect(result.allowsRetry).toBe(false);expect(result.oldOwner).toBeNull();expect(result.oldResult).toBe('unknown');
});
