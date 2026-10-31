jest.mock('./xhs-legacy-review', () => ({ ...jest.requireActual('./xhs-legacy-review'), assertLegacyDatabase: jest.fn(async () => undefined) }));
jest.mock('./xhs-dispatch-owner-observation', () => ({ observeDispatchOwner: jest.fn(() => 'dead') }));
jest.mock('./xhs-dispatch-owner', () => ({
  createDispatchOwner: () => ({ pid:22, startIdentity:'638000000000000001', nonce:'00000000-0000-4000-8000-000000000002' }),
  ownsDispatch: (v:any,e:any) => !!v && !!e && v.nonce===e.nonce && v.pid===e.pid && v.startIdentity===e.startIdentity,
}));
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { AsyncResource } from 'node:async_hooks';
import { createRedbookHttpTransport } from './xhs-http-transport';
import { XhsSubscriptionError } from './xhs-subscription-errors';
import { sqliteWrites } from './sqlite-write-coordinator';
import { RedbookPauseError } from './redbook-client';
import { writeSourceReceipt } from './xhs-source-receipt';
import { observeDispatchOwner } from './xhs-dispatch-owner-observation';
import { PrismaClient } from '@prisma/client';
import { mkdtemp, rm, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { splitSqliteStatements } from '../../../../scripts/sqlite-statements.cjs';
import { XhsWholeCreatorService } from './xhs-whole-creator.service';
import { XhsSubscriptionService } from './xhs-subscription.service';
import { XiaohongshuService } from './xiaohongshu.service';
import { XhsSubscriptionRuntime } from './xhs-subscription-runtime';
import { XhsEngagementService } from './xhs-engagement.service';
import { XhsSourceRiskStore } from './xhs-source-risk-store';
import { bindXhsSourceTotalBudget } from './xhs-source-request-policy';
import { legacyBudgetDigest } from './xhs-legacy-review';
import { createWholeGeneration } from './xhs-whole-generation';
import { prepareWholeSourceFence, markWholeSourceStarted, commitWholeSourceCheckpoint } from './xhs-whole-source-fence';

const hash = (v:unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
describe('whole creator generation through real runtime, policy and SQLite', () => {
  // Jest timeouts do not cancel the test body. Keep its promise so teardown
  // cannot reset the shared fixture while that body can still schedule work.
  let testBody: Promise<unknown> = Promise.resolve();
  let setupPromise: Promise<void> = Promise.resolve();
  let fixtureReady = true;
  let cleanupPromise: Promise<void> | undefined;
  const track = (fn: (...args: any[]) => unknown) => (...args: any[]) => {
    testBody = Promise.resolve().then(() => fn(...args));
    return testBody;
  };
  const it = Object.assign(
    (name: any, fn: any, timeout?: number) => globalThis.it(name, track(fn), timeout ?? 15000),
    { each: (rows: any) => (name: any, fn: any, timeout?: number) => globalThis.it.each(rows)(name, track(fn), timeout ?? 15000) },
  ) as jest.It;

  let db:PrismaClient, folder:string, runtime:XhsSubscriptionRuntime, subscriptions:XhsSubscriptionService, whole:XhsWholeCreatorService;
  let api:jest.Mock, shortLinks:jest.Mock, media:jest.Mock, original:any, live:boolean;
  const marker='xhs:dispatch-pending:whole:00000000-0000-4000-8000-000000000001';
  const noteKey=JSON.stringify(['xiaohongshu','note','note']);
  const author={id:'author',name:'Synthetic',profileUrl:'https://www.xiaohongshu.com/user/profile/author'};
  const input={jobId:'job',profileUrl:'https://xhslink.cn/o/Synthetic',confirmUnknown:true as const,
    phaseLimits:{profile:10,list:10,detail:10,media:300,metrics:10}};
  const read=async()=>JSON.parse((await db.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_whole_creator_jobs WHERE id='job'`)[0].document);
  const currentBudget=async()=>db.$queryRaw<Array<{id:string;used:number}>>`SELECT id,used FROM xhs_request_budgets WHERE id IN ('job','xhs:source-total') ORDER BY id`;
  const execute=async(id?:string)=>(whole as any).executeGeneration({jobId:'job',generationId:id??(await read()).generation.id,confirmUnknown:true});
  const drain=async()=>{await (whole as any).lane;await (subscriptions as any).lane;};
  function services() {
    runtime=new XhsSubscriptionRuntime({enabled:()=>live,api,shortLinks,media,requirePersistentRisk:true,profileParser:(raw:any)=>raw.author});
    runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    bindXhsSourceTotalBudget(db as any,runtime);
    (runtime as any).cookies={a1:'synthetic',web_session:'synthetic'};
    (runtime as any).stopCode='XHS_SOURCE_HISTORY_REVIEW_REQUIRED';
    subscriptions=new XhsSubscriptionService(db as any,runtime);
    subscriptions.bindLocalSaver(async()=>folder,async()=>({alreadySaved:false,mediaComplete:true,supplement:{status:'new'}}));
    whole=new XhsWholeCreatorService(db as any,subscriptions,runtime,new XhsEngagementService(db as any,runtime));
  }
  beforeAll(async()=>{
    folder=await mkdtemp(path.join(tmpdir(),'xhs-generation-flow-'));
    db=new PrismaClient({datasources:{db:{url:'file:'+path.join(folder,'fixture.db').replace(/\\/g,'/')}}});
    const migrations=path.resolve(__dirname,'../../prisma/migrations');
    for(const name of (await readdir(migrations)).sort())if((await stat(path.join(migrations,name))).isDirectory())
      for(const sql of splitSqliteStatements(await readFile(path.join(migrations,name,'migration.sql'),'utf8')))await db.$executeRawUnsafe(sql);
    // Match PrismaService's raw-query coordinator admission. A bare client misses
    // expired dispatch ALS inherited by response-event receipt callbacks.
    db.$use(async(params,next)=>['queryRaw','executeRaw'].includes(params.action)?sqliteWrites.write(()=>next(params)):next(params));
  },40000);
  beforeEach(()=>{
    if (!fixtureReady) throw new Error("Previous test cleanup is still running");
    fixtureReady=false; cleanupPromise=undefined; testBody=Promise.resolve();
    whole=undefined as any; subscriptions=undefined as any; runtime=undefined as any;
    setupPromise=(async()=>{
    (observeDispatchOwner as jest.Mock).mockReturnValue('dead');
    await db.$executeRaw`DELETE FROM xhs_limited_recovery_append`;await db.$executeRaw`DELETE FROM xhs_limited_recovery`;
    await db.$executeRaw`DELETE FROM xhs_subscription_tasks`;await db.$executeRaw`DELETE FROM xhs_whole_creator_jobs`;
    await db.$executeRaw`DELETE FROM xhs_metric_snapshots`;await db.$executeRaw`DELETE FROM xhs_request_budgets`;
    await db.xhsNote.deleteMany();await db.xhsCreator.deleteMany();
    await db.xhsCreator.create({data:{id:'creator',externalAuthorId:'author',profileUrl:author.profileUrl,displayName:author.name}});
    await db.xhsNote.create({data:{id:noteKey,creatorId:'creator',title:'Synthetic listed note',publishTime:0,kind:'image-text',status:'listed'}});
    await db.$executeRaw`UPDATE xhs_source_risk SET state='blocked',code='XHS_SOURCE_HISTORY_REVIEW_REQUIRED',owner=NULL,http_status=NULL,endpoint=NULL WHERE id='source'`;
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,used,request_limit,next_at,interval_ms) VALUES('job',6,310,0,0),('xhs:source-total',8,312,0,0),(${marker},1,1,0,0)`;
    const job:any={id:'job',creatorId:'creator',state:'paused',updatedAt:1,listEnd:false,items:{},code:'XHS_DOWNLOAD_BLOCKED',
      sourceFence:{marker,state:'started',phase:'detail',noteId:'note'},sourceGrant:{creatorId:'creator',authorId:'author',phases:['profile','list','detail','media','metrics'],
      limits:{profile:2,list:3,detail:5,media:300,metrics:0},used:{profile:2,list:2,detail:1,media:1,metrics:0}}};
    const budgets=await db.$queryRaw<any[]>`SELECT id,used,request_limit,next_at,interval_ms FROM xhs_request_budgets WHERE id IN ('job','xhs:source-total')`;
    const proof:any={boundaryVersion:'project-start-dispatch-v2',oldOwner:null,oldResult:'unknown',allowsRetry:false,claim:'no-local-project-writer-at-observation',
      lockIdentity:hash('lock'),lockNonce:'synthetic',holder:{pid:123},snapshot:{observed:true},scope:{jobId:'job',authorId:'author',noteId:'note',databaseIdentity:hash('db'),projectIdentity:hash('project'),
      unknownDigest:hash({fence:job.sourceFence,code:job.code}),budgetDigest:legacyBudgetDigest(job,budgets,'job')}};
    proof.proofId=hash({scope:proof.scope,lockIdentity:proof.lockIdentity,lockNonce:proof.lockNonce,holder:proof.holder,snapshot:proof.snapshot});job.legacyMaintenanceProof=proof;
    original=JSON.parse(JSON.stringify(job));
    await db.$executeRaw`INSERT INTO xhs_whole_creator_jobs(id,creator_id,state,document,updated_at) VALUES('job','creator','paused',${JSON.stringify(job)},1)`;
    api=jest.fn(async(request:any)=>{
      const route=new URL(request.url).pathname;
      const data=route.endsWith('otherinfo')?{author}:route.endsWith('user_posted')?{
        notes:[{note_id:'note',user:{user_id:'author'},xsec_token:'synthetic-list-token',type:'normal',display_title:'Synthetic listed note'}],has_more:false,cursor:''
      }:{items:[{id:'note',note_card:{note_id:'note',user:{user_id:'author',nickname:'Synthetic'},type:'normal',time:1760000000000,title:'Synthetic body title',desc:'Synthetic recovered body',image_list:[],
        interact_info:{liked_count:'1',collected_count:'2',share_count:'3',comment_count:'4'}}}]};
      return {status:200,url:request.url,body:{success:true,code:0,data}};
    });
    shortLinks=jest.fn(async(url:URL)=>({status:302,url:url.href,location:author.profileUrl}));
    media=jest.fn(async()=>{throw Error('unexpected synthetic media request');});live=true;services();
    })(); return setupPromise;
  });
  afterEach(async()=>{
    cleanupPromise ??= (async()=>{await setupPromise.catch(()=>{});await testBody.catch(()=>{});if(whole) await (whole as any).lane;if(subscriptions) await (subscriptions as any).lane;if(whole) await whole.onModuleDestroy();if(subscriptions) await subscriptions.onModuleDestroy();if(runtime) runtime.onModuleDestroy();jest.restoreAllMocks();fixtureReady=true;})();
    await cleanupPromise;
  });
  afterAll(async()=>{if (!fixtureReady) throw new Error("Test fixture still in use");await db.$disconnect();await rm(folder,{recursive:true,force:true});},40000);
  async function assertUnknownPreserved(){
    const job=await read();expect(job.sourceFence).toEqual(original.sourceFence);expect(job.legacyMaintenanceProof).toEqual(original.legacyMaintenanceProof);
    expect(job.legacyMaintenanceProof).toMatchObject({oldOwner:null,oldResult:'unknown',allowsRetry:false});
    expect((await db.$queryRaw<Array<{id:string}>>`SELECT id FROM xhs_request_budgets WHERE id=${marker}`)).toEqual([{id:marker}]);
    const rows=await currentBudget();expect(rows.find(r=>r.id==='job')!.used).toBeGreaterThanOrEqual(6);expect(rows.find(r=>r.id==='xhs:source-total')!.used).toBeGreaterThanOrEqual(8);
  }
  function directory(ids:string[]) {
    const normal=api.getMockImplementation()!;
    api.mockImplementation(async(request:any)=>{
      const value=await normal(request),route=new URL(request.url).pathname;
      if(route.endsWith('user_posted'))value.body.data={notes:ids.map(id=>({note_id:id,user:{user_id:'author'},xsec_token:'synthetic-list-'+id,type:'normal',display_title:'Synthetic '+id})),has_more:false,cursor:''};
      if(route.endsWith('/feed')){
        const id=JSON.parse(request.body).source_note_id,item=value.body.data.items[0];
        item.id=id;item.note_card.note_id=id;item.note_card.title='Synthetic '+id;item.note_card.desc='Synthetic body '+id;
      }
      return value;
    });
  }
  const requestedDetails=()=>api.mock.calls.filter(([r]:any[])=>new URL(r.url).pathname.endsWith('/feed')).map(([r]:any[])=>JSON.parse(r.body).source_note_id);
  it('distinguishes a live dispatch from an interrupted unknown without retrying',async()=>{
    let enter!:()=>void,release!:()=>void;
    const entered=new Promise<void>(resolve=>enter=resolve),gate=new Promise<void>(resolve=>release=resolve);
    api.mockImplementation(async()=>{enter();await gate;throw new RedbookPauseError('transport');});
    await whole.prepareGeneration(input);await execute();await entered;
    try {
      const current=(await whole.view('job')).generationRecovery!;
      expect(current.state).toBe('running');expect(current.newResult).toBe('in-progress');
      expect(current.resumable).toBe(false);expect(current.reviewable).toBe(false);
    } finally { release(); }
    await drain();
    const stopped=(await whole.view('job')).generationRecovery!;
    expect(stopped.state).toBe('paused');expect(stopped.newResult).toBe('unknown');
    expect(stopped.resumable).toBe(false);expect(api).toHaveBeenCalledTimes(1);
    const stale=await read();stale.state='running';
    await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(stale)} WHERE id='job'`;
    const restarted=(await whole.view('job')).generationRecovery!;
    expect(restarted.newResult).toBe('unknown');expect(restarted.resumable).toBe(false);
    await assertUnknownPreserved();
  });
  it('waits for source receipts before the business checkpoint can remove its fence',async()=>{
    let release!:()=>void,entered!:()=>void,workStarted=false;
    const delayed=new Promise<void>(resolve=>release=resolve),atStorage=new Promise<void>(resolve=>entered=resolve);
    const writer=(runtime as any).receiptWriter;
    (runtime as any).receiptWriter=async(scope:any,receipt:any)=>{await delayed;return writer(scope,receipt);};
    const storage=runtime.sourceStorage.bind(runtime);
    jest.spyOn(runtime,'sourceStorage').mockImplementation(work=>{
      const pending=storage(async()=>{workStarted=true;return work();});entered();return pending;
    });
    jest.spyOn(subscriptions,'refreshFull').mockRejectedValueOnce(Error('synthetic child creation failure'));
    await whole.prepareGeneration(input);await execute();await atStorage;
    try { expect(workStarted).toBe(false); } finally { release(); }
    await drain();const paused=await read();
    expect(paused.generation.profile.id).toBe('author');expect(paused.generation.activeFence).toBeUndefined();
    expect(paused.generation.lastSourceReceipt).toMatchObject({stage:'checkpoint',outcome:'checkpointed',settled:true,status:200});
    expect(paused.generation.lastSourceReceipt.events).toContainEqual({stage:'response',status:200});
  });
  it('continues after the durable profile checkpoint without resolving the homepage again',async()=>{
    const refresh=subscriptions.refreshFull.bind(subscriptions);let interrupted=false;
    jest.spyOn(subscriptions,'refreshFull').mockImplementation(async input=>{if(!interrupted){interrupted=true;throw Error('synthetic local child creation failure');}return refresh(input);});
    const resolve=jest.spyOn(runtime,'resolve');
    await whole.prepareGeneration(input);const generationId=(await read()).generation.id;
    await execute(generationId);await drain();const paused=await read();
    expect(paused.state).toBe('paused');expect(paused.generation.profile.id).toBe('author');expect(paused.generation.activeFence).toBeUndefined();
    expect(paused.generation.lastSourceReceipt.outcome).toBe('checkpointed');expect(resolve).toHaveBeenCalledTimes(1);
    expect(paused.generation.localFailure).toEqual({stage:'list-task',code:'XHS_LOCAL_OPERATION_FAILED'});
    await execute(generationId);await drain();const completed=await read();
    expect(resolve).toHaveBeenCalledTimes(1);expect(completed.state).toBe('partial');expect(completed.generation.profile).toEqual(paused.generation.profile);
    expect(requestedDetails()).toEqual(['note']);await assertUnknownPreserved();
  });
  // Two synthetic SQLite phases plus restart: 2.1s locally; CI delay is not yet attributed.
  it('resumes a checkpointed profile after restart at its exhausted cap using normal default list options',async()=>{
    const refresh=subscriptions.refreshFull.bind(subscriptions);let interrupted=false;
    jest.spyOn(subscriptions,'refreshFull').mockImplementation(async value=>{if(!interrupted){interrupted=true;throw Error('synthetic child creation failure');}return refresh(value);});
    await whole.prepareGeneration({...input,phaseLimits:{...input.phaseLimits,profile:4}});
    const generationId=(await read()).generation.id;await execute(generationId);await drain();
    const paused=await read();expect(paused.generation.profile.id).toBe('author');expect(paused.sourceGrant.used.profile).toBe(4);
    const requestsBefore=api.mock.calls.length,linksBefore=shortLinks.mock.calls.length;
    await whole.onModuleDestroy();await subscriptions.onModuleDestroy();runtime.onModuleDestroy();services();
    expect(runtime.hasAuthorContext('author')).toBe(false);
    await execute(generationId);await drain();const finished=await read();
    expect({state:finished.state,code:finished.code,phase:finished.generation.activeFence?.phase,routes:api.mock.calls.slice(requestsBefore).map(([r]:any[])=>new URL(r.url).pathname)}).toMatchObject({state:'partial'});expect(finished.listEnd).toBe(true);expect(finished.sourceGrant.used.profile).toBe(4);
    expect(finished.generation.profile).toEqual(paused.generation.profile);expect(shortLinks).toHaveBeenCalledTimes(linksBefore);
    const next=api.mock.calls.slice(requestsBefore).map(([request]:any[])=>new URL(request.url));
    expect(next[0].pathname.endsWith('user_posted')).toBe(true);expect(next.some(url=>url.pathname.endsWith('otherinfo'))).toBe(false);
    expect(next[0].searchParams.get('xsec_token')).toBe('');expect(next[0].searchParams.get('xsec_source')).toBe('');
    expect(requestedDetails()).toEqual(['note']);await assertUnknownPreserved();
  }, 15000);
  it.each([401,461])('retains a real list refusal %s after restoring checkpoint identity without a profile retry',async status=>{
    jest.spyOn(subscriptions,'refreshFull').mockRejectedValueOnce(Error('synthetic child creation failure'));
    await whole.prepareGeneration({...input,phaseLimits:{...input.phaseLimits,profile:4}});
    const generationId=(await read()).generation.id;await execute(generationId);await drain();
    const beforeRequests=api.mock.calls.length,beforeLinks=shortLinks.mock.calls.length;
    await whole.onModuleDestroy();await subscriptions.onModuleDestroy();runtime.onModuleDestroy();services();
    api.mockImplementation(async(request:any)=>({status,url:request.url,body:{success:false,code:-1}}));
    await execute(generationId);await drain();const paused=await read();
    expect(paused.state).toBe('paused');expect(paused.generation.activeFence.phase).toBe('list');
    expect(paused.generation.lastSourceReceipt).toMatchObject({status,settled:true,outcome:'response-received'});
    expect(paused.sourceGrant.used.profile).toBe(4);expect(api).toHaveBeenCalledTimes(beforeRequests+1);expect(shortLinks).toHaveBeenCalledTimes(beforeLinks);
    expect((await db.$queryRaw<any[]>`SELECT state,code FROM xhs_source_risk WHERE id='source'`)[0]).toMatchObject({state:'blocked',code:status===401?'XHS_SOURCE_AUTHENTICATION_BLOCKED':'XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED'});
    await expect(execute(generationId)).rejects.toThrow();expect(api).toHaveBeenCalledTimes(beforeRequests+1);await assertUnknownPreserved();
  });
  it('refuses checkpoint identity restoration outside its generation or for a foreign author',async()=>{
    expect(()=>runtime.restoreCheckpointAuthorContext({...author,collectedAt:1})).toThrow();
    await whole.prepareGeneration(input);const current=await read();
    current.generation.profile={...author,id:'foreign',collectedAt:1};
    await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(current)} WHERE id='job'`;
    const before=await currentBudget();await execute(current.generation.id);await drain();
    expect((await read()).code).toBe('XHS_AUTHOR_MISMATCH');expect(await currentBudget()).toEqual(before);
    expect(api).not.toHaveBeenCalled();expect(shortLinks).not.toHaveBeenCalled();
  });
  const receiptSecret='synthetic-SECRET-cookie-token-body-url-message';
  async function checkedFailureReceipt(settled=true) {
    const job=await read(),receipt=job.generation.lastSourceReceipt;
    expect(receipt).toBeDefined();expect(receipt.settled).toBe(settled);
    expect(job.generation.activeFence.receipt).toEqual(receipt);
    expect(Object.keys(receipt).every(k=>['generationId','marker','owner','phase','sequence','stage','outcome','settled','code','status','events'].includes(k))).toBe(true);
    expect(JSON.stringify(receipt)).not.toContain(receiptSecret);
    for(const event of receipt.events??[])expect(Object.keys(event).every(k=>['stage','status'].includes(k))).toBe(true);
    await assertUnknownPreserved();return receipt;
  }

  it('receipts native request construction failure as not-sent without an HTTP status',async()=>{
    const request=jest.fn(()=>{throw new TypeError(receiptSecret);});
    const observed=jest.fn((stage:any,status?:number,notSent?:boolean)=>runtime.observeSourceStage(stage,status,notSent));
    const native=createRedbookHttpTransport(request as any,observed);api.mockImplementation(native);
    await (whole as any).prepareGeneration(input);await execute();await drain();
    expect(request).toHaveBeenCalledTimes(1);expect(observed).toHaveBeenCalledWith('transport',undefined,true);
    const receipt=await checkedFailureReceipt();expect(receipt.outcome).toBe('not-sent');expect(receipt.status).toBeUndefined();
    expect(receipt.events.some((e:any)=>e.stage==='sent')).toBe(false);
  });
  it('receipts HTTP 461 while retaining the durable platform restriction',async()=>{
    api.mockImplementation(async(request:any)=>({status:461,url:request.url,body:{success:false,code:461,message:receiptSecret}}));
    await (whole as any).prepareGeneration(input);await execute();await drain();
    const receipt=await checkedFailureReceipt();expect(receipt).toMatchObject({status:461,outcome:'response-received',code:'XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED'});
    const risk=(await db.$queryRaw<Array<{state:string;code:string}>>`SELECT state,code FROM xhs_source_risk WHERE id='source'`)[0];
    expect(risk).toEqual({state:'blocked',code:'XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED'});expect((await whole.view('job')).generationRecovery?.newResult).toBe('restricted');
  });
  it('receipts profile parser rejection after HTTP 200 using only a fixed parser code',async()=>{
    (runtime as any).options.profileParser=()=>{const error=new XhsSubscriptionError('XHS_PROFILE_SCHEMA_UNRECOGNIZED');error.message=receiptSecret;throw error;};
    await (whole as any).prepareGeneration(input);await execute();await drain();
    const receipt=await checkedFailureReceipt();expect(receipt).toMatchObject({status:200,stage:'parse',outcome:'response-received',code:'XHS_PROFILE_SCHEMA_UNRECOGNIZED'});
    expect((await read()).generation.profile).toBeUndefined();expect(api).toHaveBeenCalledTimes(1);
  });
  it('receipts a real profile transaction storage failure without refunding dispatched counts',async()=>{
    await (whole as any).prepareGeneration(input);
    const transaction=db.$transaction.bind(db);let rejected=false;
    jest.spyOn(db,'$transaction').mockImplementation(((fn:any,options:any)=>transaction(async(tx:any)=>fn(new Proxy(tx,{get(target,key){
      if(key==='xhsCreator')return new Proxy(target.xhsCreator,{get(model,method){if(method==='update')return async()=>{rejected=true;throw Object.assign(Error(receiptSecret),{code:'P2002'});};return model[method];}});
      return target[key];
    }})),options)) as any);
    await execute();await drain();expect(rejected).toBe(true);
    const receipt=await checkedFailureReceipt();expect(receipt).toMatchObject({status:200,stage:'storage',outcome:'local-failure',code:'XHS_STORAGE_FAILED'});
    expect((await read()).generation.profile).toBeUndefined();expect((await db.xhsCreator.findUnique({where:{id:'creator'}}))?.lastCheckedAt).toBe(0);
    expect(await currentBudget()).toEqual([{id:'job',used:8},{id:'xhs:source-total',used:10}]);
  });
  it('receipts native sent then transport failure as unknown with no HTTP status',async()=>{
    const request=jest.fn(()=>{
      const req:any=new EventEmitter();req.destroy=jest.fn();req.end=()=>{req.emit('finish');queueMicrotask(()=>req.emit('error',new RedbookPauseError('transport')));};return req;
    });
    api.mockImplementation(createRedbookHttpTransport(request as any,(stage,status,notSent)=>runtime.observeSourceStage(stage,status,notSent)));
    await (whole as any).prepareGeneration(input);await execute();await drain();
    const receipt=await checkedFailureReceipt();expect(receipt).toMatchObject({stage:'sent',outcome:'unknown',code:'XHS_SOURCE_TRANSPORT_BLOCKED'});expect(receipt.status).toBeUndefined();
    expect(receipt.events.some((e:any)=>e.stage==='sent')).toBe(true);expect(request).toHaveBeenCalledTimes(1);
  });
  it('receipts checkpoint rollback after HTTP 200 without claiming a saved profile',async()=>{
    const checkpoint=runtime.checkpointWholeSource.bind(runtime);let rolledBack=false;
    jest.spyOn(runtime,'checkpointWholeSource').mockImplementation(async(tx,collectedAt)=>{await checkpoint(tx,collectedAt);rolledBack=true;throw Error(receiptSecret);});
    await (whole as any).prepareGeneration(input);await execute();await drain();expect(rolledBack).toBe(true);
    const receipt=await checkedFailureReceipt();expect(receipt).toMatchObject({stage:'checkpoint',status:200,outcome:'local-failure'});
    const job=await read();expect(job.generation.profile).toBeUndefined();expect(job.profile).toBeUndefined();expect(job.generation.activeFence.state).toBe('started');
    expect(await db.xhsMetricSnapshot.count()).toBe(0);expect(await currentBudget()).toEqual([{id:'job',used:8},{id:'xhs:source-total',used:10}]);
  });
  it('explicitly reviews a settled parser failure then completes the same generation with both historical markers retained',async()=>{
    const diagStart=performance.now();
    const diagMark=(step:string)=>console.info('RECOVERY_CI_STAGE',{case:'parser',step,elapsedMs:Math.round(performance.now()-diagStart)});
    (observeDispatchOwner as jest.Mock).mockReturnValue('alive');
    (runtime as any).options.profileParser=()=>{throw new XhsSubscriptionError('XHS_PROFILE_SCHEMA_UNRECOGNIZED');};
    await (whole as any).prepareGeneration(input);diagMark('prepared');const generationId=(await read()).generation.id;
    await execute(generationId);await drain();diagMark('first-drained');const failed=await read(),failedFence=failed.generation.activeFence;
    expect(failedFence.receipt).toMatchObject({stage:'parse',status:200,settled:true,code:'XHS_PROFILE_SCHEMA_UNRECOGNIZED'});
    const beforeCounts=await currentBudget(),beforeRequests=api.mock.calls.length+shortLinks.mock.calls.length;
    const reviewInput={jobId:'job',generationId,confirmUnknown:true as const};
    await whole.reviewGeneration(reviewInput);await drain();diagMark('reviewed');const reviewed=await read();
    expect(reviewed.state).toBe('paused');expect(reviewed.generation.activeFence).toBeUndefined();
    expect(reviewed.generation.reviews).toHaveLength(1);expect(reviewed.generation.reviews[0].fence).toEqual(failedFence);
    expect(reviewed.generation.lastSourceReceipt).toEqual(failedFence.receipt);
    expect(await currentBudget()).toEqual(beforeCounts);expect(api.mock.calls.length+shortLinks.mock.calls.length).toBe(beforeRequests);
    await expect(whole.reviewGeneration(reviewInput)).rejects.toThrow();
    expect(await read()).toEqual(reviewed);expect(api.mock.calls.length+shortLinks.mock.calls.length).toBe(beforeRequests);
    const retained=await db.$queryRaw<Array<{id:string}>>`SELECT id FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%' ORDER BY id`;
    expect(retained.map(r=>r.id).sort()).toEqual([marker,failedFence.marker].sort());
    (runtime as any).options.profileParser=(raw:any)=>raw.author;
    const normal=api.getMockImplementation()!;let lateCode:string|undefined,lateChecked=false,newMarker:string|undefined;
    // Test-side late-writer inspection owns its own context, not the source's
    // expired dispatch transaction context tested by the real middleware above.
    const inspectLate=AsyncResource.bind(async()=>{
      lateChecked=true;newMarker=(await read()).generation.activeFence.marker;
      try { await db.$transaction(tx=>writeSourceReceipt(tx,{jobId:'job',creatorId:'creator',authorId:'author',generationId,marker:failedFence.marker,owner:failedFence.owner},failedFence.receipt)); }
      catch(error){lateCode=(error as XhsSubscriptionError).code;}
      expect((await read()).generation.activeFence.marker).toBe(newMarker);
    });
    api.mockImplementation(async(request:any)=>{
      const value=await normal(request);
      if(!lateChecked&&new URL(request.url).pathname.endsWith('otherinfo')) {
        await inspectLate();
      }
      return value;
    });
    await execute(generationId);await drain();diagMark('resume-drained');const completed=await read();
    expect(lateChecked).toBe(true);expect(lateCode).toBe('XHS_WHOLE_SOURCE_FENCE_BLOCKED');expect(newMarker).not.toBe(failedFence.marker);
    expect(completed.state).toBe('partial');expect(completed.generation.id).toBe(generationId);expect(completed.generation.activeFence).toBeUndefined();
    expect(completed.generation.reviews).toEqual(reviewed.generation.reviews);
    expect(await db.$queryRaw<Array<{id:string}>>`SELECT id FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%' ORDER BY id`).toEqual(retained);
    expect((await db.xhsNote.findUnique({where:{id:noteKey}}))?.contentHtml).toContain('Synthetic recovered body');
    const total=api.mock.calls.length+shortLinks.mock.calls.length;
    expect(await currentBudget()).toEqual([{id:'job',used:6+total},{id:'xhs:source-total',used:8+total}]);
    await assertUnknownPreserved();
  }, 15000);
  // Initial regression run: after HTTP 200 the P2028 receipt incorrectly reported
  // XHS_SOURCE_TRANSPORT_BLOCKED instead of XHS_STORAGE_FAILED (1 failed, 20 skipped).
  it.each([200,461])('waits for an in-flight second transport before recording HTTP %s after dispatch rollback',async status=>{
    (observeDispatchOwner as jest.Mock).mockReturnValue('alive');
    const normal=api.getMockImplementation()!;
    let release!:()=>void,rollbackDone!:()=>void,entered=false,injected=false,runFinished=false;
    const responseGate=new Promise<void>(resolve=>{release=resolve;});
    const rolledBack=new Promise<void>(resolve=>{rollbackDone=resolve;});
    api.mockImplementation(async(request:any)=>{entered=true;await responseGate;return status===200?normal(request):{status,url:request.url,body:{success:false,code:status,message:receiptSecret}};});
    await (whole as any).prepareGeneration(input);const generationId=(await read()).generation.id;
    const transaction=db.$transaction.bind(db);
    jest.spyOn(db,'$transaction').mockImplementation(((fn:any,options:any)=>transaction(async(tx:any)=>fn(new Proxy(tx,{get(target,key){
      if(key==='$executeRaw')return async(strings:TemplateStringsArray,...values:any[])=>{
        const sql=Array.from(strings).join('?').replace(/\s+/g,' ').trim();
        if(entered&&!injected&&/^UPDATE xhs_request_budgets SET next_at=\? WHERE id=\?$/.test(sql)&&values[1]==='xhs:source-total'){
          injected=true;throw Object.assign(Error(receiptSecret),{code:'P2028'});
        }
        return target.$executeRaw(strings,...values);
      };
      return target[key];
    }})),options).catch((error:any)=>{if(error?.code==='P2028')rollbackDone();throw error;})) as any);
    try {
      await execute(generationId);void (whole as any).lane.then(()=>{runFinished=true;});
      await rolledBack;
      // Give the failed dispatch stack a chance to settle if it incorrectly detached
      // the actual transport promise. The response gate itself remains unresolved.
      await new Promise(resolve=>setTimeout(resolve,100));
      expect(entered).toBe(true);expect(injected).toBe(true);expect(runFinished).toBe(false);
      const pending=await read();expect(pending.state).toBe('running');expect(pending.generation.activeFence.state).toBe('started');
      expect(pending.generation.activeFence.receipt?.settled).not.toBe(true);expect(pending.generation.lastSourceReceipt?.settled).not.toBe(true);
      expect(shortLinks).toHaveBeenCalledTimes(1);expect(api).toHaveBeenCalledTimes(1);
      await expect(whole.reviewGeneration({jobId:'job',generationId,confirmUnknown:true})).rejects.toThrow();
      expect(await currentBudget()).toEqual([{id:'job',used:8},{id:'xhs:source-total',used:10}]);
      expect(pending.sourceGrant.used.profile).toBe(original.sourceGrant.used.profile+2);
    } finally {release();await drain();}
    // Dispatch persistence failed after entry: even a returned response cannot
    // prove every native stream is quiescent. Keep it unreviewable by a live owner.
    const receipt=await checkedFailureReceipt(false);expect(receipt.code).toBe(status===200?'XHS_STORAGE_FAILED':'XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED');expect(receipt.status).toBe(status);
    const paused=await read();expect(paused.state).toBe('paused');expect(paused.generation.profile).toBeUndefined();expect(paused.generation.reviews).toBeUndefined();
    expect(paused.sourceGrant.used.profile).toBe(original.sourceGrant.used.profile+2);
    if(status===461){
      const risk=(await db.$queryRaw<Array<{state:string;code:string}>>`SELECT state,code FROM xhs_source_risk WHERE id='source'`)[0];
      expect(risk).toEqual({state:'blocked',code:'XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED'});
    }
    await expect(whole.reviewGeneration({jobId:'job',generationId,confirmUnknown:true})).rejects.toThrow();
    const markers=await db.$queryRaw<Array<{id:string}>>`SELECT id FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%'`;
    expect(markers.map(r=>r.id).sort()).toEqual([marker,paused.generation.activeFence.marker].sort());
    expect(await currentBudget()).toEqual([{id:'job',used:8},{id:'xhs:source-total',used:10}]);
    expect(api).toHaveBeenCalledTimes(1);expect(shortLinks).toHaveBeenCalledTimes(1);
  });

  it('leaves ordinary homepage resolution fenced, including after a prepared generation',async()=>{
    await expect(runtime.resolve(input.profileUrl)).rejects.toThrow();
    await (whole as any).prepareGeneration(input);
    await expect(runtime.resolve(input.profileUrl)).rejects.toThrow();
    expect(api).not.toHaveBeenCalled();expect(shortLinks).not.toHaveBeenCalled();
    expect(await currentBudget()).toEqual([{id:'job',used:6},{id:'xhs:source-total',used:8}]);
    await assertUnknownPreserved();
  });
  it('chains approved homepage, profile, directory and body with legitimate list context and cumulative counts',async()=>{
    subscriptions.bindLocalSaver(async()=>{throw Error('unexpected picker');},async()=>{throw Error('unexpected export');});
    await (whole as any).prepareGeneration(input);expect(api).not.toHaveBeenCalled();expect(shortLinks).not.toHaveBeenCalled();
    await execute();await drain();const job=await read();
    expect(job.state).toBe('partial');expect(job.listEnd).toBe(true);expect(job.generation.basicCompleted).toBe(true);expect(job.items[noteKey].archive).toBeUndefined();
    expect((await db.xhsNote.findUnique({where:{id:noteKey}}))?.contentHtml).toContain('Synthetic recovered body');
    const routes=api.mock.calls.map(([r]:any[])=>new URL(r.url).pathname);
    expect(routes.some(r=>r.endsWith('otherinfo'))).toBe(true);expect(routes.some(r=>r.endsWith('user_posted'))).toBe(true);expect(routes.some(r=>r.endsWith('/feed'))).toBe(true);
    expect(shortLinks).toHaveBeenCalledTimes(1);expect(media).not.toHaveBeenCalled();
    const count=api.mock.calls.length+shortLinks.mock.calls.length;
    expect(await currentBudget()).toEqual([{id:'job',used:6+count},{id:'xhs:source-total',used:8+count}]);
    expect(job.sourceGrant.used.profile).toBeGreaterThan(original.sourceGrant.used.profile);
    expect(job.sourceGrant.used.list).toBeGreaterThan(original.sourceGrant.used.list);
    expect(job.sourceGrant.used.detail).toBeGreaterThan(original.sourceGrant.used.detail);
    expect((await db.$queryRaw<Array<{id:string}>>`SELECT id FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%'`)).toEqual([{id:marker}]);
    await assertUnknownPreserved();
    const before=count;await execute();await drain();expect(api.mock.calls.length+shortLinks.mock.calls.length).toBe(before);
  });
  it('rejects duplicate execution while the one approved generation is queued or running',async()=>{
    await (whole as any).prepareGeneration(input);const id=(await read()).generation.id;
    const outcomes=await Promise.allSettled([execute(id),execute(id)]);await drain();
    expect(outcomes.filter(v=>v.status==='fulfilled')).toHaveLength(1);expect(shortLinks).toHaveBeenCalledTimes(1);await assertUnknownPreserved();
  });
  it.each([461,401])('persists source rejection %s and restart cannot replay the generation',async status=>{
    api.mockImplementation(async(request:any)=>({status,url:request.url,body:{success:false,code:status}}));
    await (whole as any).prepareGeneration(input);await execute();await drain();
    expect((await read()).state).toBe('paused');expect(api).toHaveBeenCalledTimes(1);expect(shortLinks).toHaveBeenCalledTimes(1);
    const risk=(await db.$queryRaw<Array<{state:string;code:string}>>`SELECT state,code FROM xhs_source_risk WHERE id='source'`)[0];
    expect(risk.state).toBe('blocked');expect(risk.code).not.toBe('XHS_SOURCE_HISTORY_REVIEW_REQUIRED');
    await assertUnknownPreserved();const budget=await currentBudget();
    await whole.onModuleDestroy();await subscriptions.onModuleDestroy();runtime.onModuleDestroy();services();await whole.onModuleInit();
    await expect(execute()).rejects.toThrow();await expect((whole as any).prepareGeneration(input)).rejects.toThrow();
    expect(api).toHaveBeenCalledTimes(1);expect(shortLinks).toHaveBeenCalledTimes(1);expect(await currentBudget()).toEqual(budget);
  });
  it('does not checkpoint or replay a response from an expired session generation',async()=>{
    const normal=api.getMockImplementation()!;
    api.mockImplementation(async(request:any)=>{const value=await normal(request);(runtime as any).generation++;return value;});
    await (whole as any).prepareGeneration(input);await execute();await drain();
    const job=await read();expect(job.state).toBe('paused');expect(job.generation.activeFence?.state).toBe('started');
    expect(await db.xhsMetricSnapshot.count()).toBe(0);expect(api).toHaveBeenCalledTimes(1);
    await expect(execute()).rejects.toThrow();expect(api).toHaveBeenCalledTimes(1);await assertUnknownPreserved();
  });
  it('rejects a redirected foreign author instead of starting its directory or overwriting the subscription',async()=>{
    shortLinks.mockImplementation(async(url:URL)=>({status:302,url:url.href,location:'https://www.xiaohongshu.com/user/profile/other'}));
    await (whole as any).prepareGeneration(input);await execute();await drain();
    expect((await read()).state).toBe('paused');expect((await db.xhsCreator.findUnique({where:{id:'creator'}}))?.externalAuthorId).toBe('author');
    expect(api.mock.calls.every(([r]:any[])=>!new URL(r.url).pathname.endsWith('user_posted'))).toBe(true);await assertUnknownPreserved();
  });
  it('rejects stale generation IDs and wrong-owner late commits without clearing either marker',async()=>{
    const generation=await db.$transaction(tx=>createWholeGeneration(tx,input));
    const job=await read();job.state='running';job.generation.state='running';job.listEnd=true;job.generation.directoryIds=[noteKey];
    await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET state='running',document=${JSON.stringify(job)} WHERE id='job'`;
    const activeMarker='xhs:dispatch-pending:whole:00000000-0000-4000-8000-000000000003';
    const owner={pid:22,startIdentity:'638000000000000001',nonce:'00000000-0000-4000-8000-000000000002'};
    const scope={jobId:'job',creatorId:'creator',authorId:'author',generationId:generation.id,marker:activeMarker,phase:'detail' as const,noteId:'note',owner};
    await db.$transaction(tx=>prepareWholeSourceFence(tx,scope));
    await db.$transaction(tx=>(markWholeSourceStarted as any)(tx,'job',activeMarker,owner,'detail',generation.id));
    await expect(db.$transaction(tx=>(commitWholeSourceCheckpoint as any)(tx,'job',activeMarker,owner,undefined,'stale-generation'))).rejects.toThrow();
    await expect(db.$transaction(tx=>(commitWholeSourceCheckpoint as any)(tx,'job',activeMarker,{...owner,nonce:'wrong-owner'},undefined,generation.id))).rejects.toThrow();
    await expect(db.$transaction(tx=>(commitWholeSourceCheckpoint as any)(tx,'job',marker,owner,undefined,generation.id))).rejects.toThrow();
    expect((await read()).generation.activeFence.state).toBe('started');
    expect((await db.$queryRaw<Array<{id:string}>>`SELECT id FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%'`)).toHaveLength(2);
    expect(api).not.toHaveBeenCalled();expect(shortLinks).not.toHaveBeenCalled();await assertUnknownPreserved();
  });
  it('separates old missing notes from the returned directory and preserves their cached body without requesting them',async()=>{
    await db.xhsNote.update({where:{id:noteKey},data:{status:'complete',contentHtml:'<p>old cached body remains</p>'}});
    directory(['fresh']);await (whole as any).prepareGeneration(input);await execute();await drain();
    const job=await read(),freshKey=JSON.stringify(['xiaohongshu','note','fresh']);
    expect(job.generation.directoryIds).toEqual([freshKey]);expect(job.generation.missingIds).toEqual([noteKey]);
    expect(job.generation.originalNoteStatus).toBe('not-returned');expect(requestedDetails()).toEqual(['fresh']);
    expect((await db.xhsNote.findUnique({where:{id:noteKey}}))?.contentHtml).toBe('<p>old cached body remains</p>');
    expect((await db.xhsNote.findUnique({where:{id:freshKey}}))?.contentHtml).toContain('Synthetic body fresh');
    await assertUnknownPreserved();
  });
  it('explicitly resumes a known interruption and skips committed cached details',async()=>{
    const diagStart=performance.now();
    const diagMark=(step:string)=>console.info('RECOVERY_CI_STAGE',{case:'interruption',step,elapsedMs:Math.round(performance.now()-diagStart)});
    directory(['note','second']);let stopped=false;
    const checkpoint=runtime.checkpointWholeSource.bind(runtime);
    jest.spyOn(runtime,'checkpointWholeSource').mockImplementation(async(tx,at)=>{
      await checkpoint(tx,at);
      if(!stopped && (runtime as any).wholeSourceGroup.getStore()?.phase==='detail'){stopped=true;live=false;}
    });
    await (whole as any).prepareGeneration(input);diagMark('prepared');const id=(await read()).generation.id;await execute(id);await drain();diagMark('first-drained');
    const paused=await read();expect(paused.state).toBe('paused');expect(paused.generation.activeFence).toBeUndefined();
    expect(requestedDetails()).toEqual(['note']);const child=await subscriptions.task({taskId:paused.listTask});expect(child.completed).toBe(1);
    live=true;await execute(id);await drain();diagMark('resume-drained');const completed=await read();
    expect(completed.state).toBe('partial');expect(completed.generation.id).toBe(id);
    expect(requestedDetails()).toEqual(['note','second']);await assertUnknownPreserved();
  }, 15000);
  it('retains both unknown markers and consumed counts when a successful body response loses its checkpoint transaction',async()=>{
    const checkpoint=runtime.checkpointWholeSource.bind(runtime);let failed=false;
    jest.spyOn(runtime,'checkpointWholeSource').mockImplementation(async(tx,collectedAt)=>{
      const detail=(runtime as any).wholeSourceGroup.getStore()?.phase==='detail';
      await checkpoint(tx,collectedAt);
      if(detail&&!failed){failed=true;throw Error('synthetic body checkpoint rollback');}
    });
    await (whole as any).prepareGeneration(input);await execute();await drain();
    const paused=await read();expect(failed).toBe(true);expect(paused.state).toBe('paused');expect(paused.generation.activeFence?.state).toBe('started');
    const note=await db.xhsNote.findUnique({where:{id:noteKey}});expect(note?.status).toBe('listed');expect(note?.contentHtml).toBeFalsy();
    expect((await db.xhsMetricSnapshot.findMany({where:{ownerId:noteKey}}))).toHaveLength(0);
    const markers=await db.$queryRaw<Array<{id:string}>>`SELECT id FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%'`;
    expect(markers).toHaveLength(2);expect(markers.some(m=>m.id===marker)).toBe(true);expect(requestedDetails()).toEqual(['note']);
    const count=api.mock.calls.length+shortLinks.mock.calls.length;
    expect(await currentBudget()).toEqual([{id:'job',used:6+count},{id:'xhs:source-total',used:8+count}]);
    const budget=await currentBudget();await assertUnknownPreserved();
    await whole.onModuleDestroy();await subscriptions.onModuleDestroy();runtime.onModuleDestroy();services();await whole.onModuleInit();
    await expect(execute()).rejects.toThrow();expect(await currentBudget()).toEqual(budget);expect(requestedDetails()).toEqual(['note']);
  }, 15000);
  it('creates a current-directory child instead of resuming the old blocked archive selection',async()=>{
    const freshKey=JSON.stringify(['xiaohongshu','note','fresh']);
    await db.xhsNote.update({where:{id:noteKey},data:{status:'listed',contentHtml:'<p>old partial cache must remain</p>'}});
    await db.xhsNote.create({data:{id:freshKey,creatorId:'creator',title:'Fresh',publishTime:0,kind:'image-text',status:'listed'}});
    const old={taskId:'old-archive',creatorId:'creator',kind:'download',state:'blocked',noteIds:[noteKey,freshKey],items:{},directory:folder+'-old',
      total:2,completed:0,skipped:0,failed:1,remaining:2,code:'XHS_DOWNLOAD_BLOCKED',message:'Synthetic interrupted old selection'};
    const oldRaw=JSON.stringify(old);
    await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES('old-archive','creator','blocked',${oldRaw},1)`;
    const job=await read();job.archiveTask='old-archive';
    await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(job)} WHERE id='job'`;
    // Simulate a still-live context learned by the previous directory. The normal new
    // directory deliberately omits it; an old selection must not authorize its use.
    (runtime as any).adapter.tokens.set(JSON.stringify(['author','note']),{token:'synthetic-prior-list-token',source:'pc_user',expiresAt:Date.now()+60000,revision:0,linkChecked:true});
    const createChild=jest.spyOn(subscriptions,'downloadNotes');
    const saves=jest.fn(async()=>({alreadySaved:false,mediaComplete:true,supplement:{status:'new'}}));
    subscriptions.bindLocalSaver(async()=>folder,saves);directory(['fresh']);
    await (whole as any).prepareGeneration(input);await execute();await drain();
    expect(requestedDetails()).toEqual(['fresh']);
    expect((await db.xhsNote.findUnique({where:{id:noteKey}}))?.contentHtml).toBe('<p>old partial cache must remain</p>');
    expect((await db.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_subscription_tasks WHERE id='old-archive'`)[0].document).toBe(oldRaw);
    const current=await read();expect(current.generation.missingIds).toContain(noteKey);expect(current.archiveTask).toBe('old-archive');
    expect(createChild).not.toHaveBeenCalled();
    const child=JSON.parse((await db.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_subscription_tasks WHERE id=${current.listTask}`)[0].document);
    expect(child.noteIds).toEqual([freshKey]);expect(child.directory).toBeUndefined();expect(saves).not.toHaveBeenCalled();
    await assertUnknownPreserved();
  });
  it('allows media dispatch after a synthetic admission wait over ten seconds',async()=>{
    const fullRefresh=subscriptions.refreshFull.bind(subscriptions);jest.spyOn(subscriptions,'refreshFull').mockImplementation(args=>fullRefresh({...args,basicOnly:false,reuseCompleteCache:false}));
    const base=api.getMockImplementation()!;api.mockImplementation(async(req:any)=>{const result=await base(req);if(new URL(req.url).pathname.endsWith('/feed'))result.body.data.items[0].note_card.image_list=[{url_default:'https://sns-webpic.xhscdn.com/synthetic.png'}];return result;});
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=','base64');
    media.mockImplementation(async(_url:any,options:any)=>{expect(options.signal.aborted).toBe(false);return new Response(png,{status:200,headers:{'content-type':'image/png'}});});
    const originalDispatch=(runtime as any).sourceDispatch;(runtime as any).sourceDispatch=async(op:any,ready:any,group:any,charge:any)=>{if(charge==='media')await new Promise(r=>setTimeout(r,10100));return originalDispatch(op,ready,group,charge);};
    await whole.prepareGeneration(input);await execute();await drain();expect(media).toHaveBeenCalledTimes(1);expect((await read()).state).toBe('partial');await assertUnknownPreserved();
  },25000);
  it('sends no media request when the task is cancelled while admission is waiting',async()=>{
    const fullRefresh=subscriptions.refreshFull.bind(subscriptions);jest.spyOn(subscriptions,'refreshFull').mockImplementation(args=>fullRefresh({...args,basicOnly:false,reuseCompleteCache:false}));
    const base=api.getMockImplementation()!;api.mockImplementation(async(req:any)=>{const result=await base(req);if(new URL(req.url).pathname.endsWith('/feed'))result.body.data.items[0].note_card.image_list=[{url_default:'https://sns-webpic.xhscdn.com/synthetic.png'}];return result;});
    let enter!:()=>void,release!:()=>void;const queued=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>release=r);const originalDispatch=(runtime as any).sourceDispatch;
    (runtime as any).sourceDispatch=async(op:any,ready:any,group:any,charge:any)=>{if(charge==='media'){enter();await gate;}return originalDispatch(op,ready,group,charge);};
    await whole.prepareGeneration(input);await execute();await queued;try{await whole.cancel('job');}finally{release();}await drain();expect(media).not.toHaveBeenCalled();expect((await read()).state).toBe('cancelled');await assertUnknownPreserved();
  },15000);
  it('commits selected basic fields from one detail without media and leaves excluded unknown pending',async()=>{
    const safe=JSON.stringify(['xiaohongshu','note','safe']);
    await db.xhsNote.create({data:{id:safe,creatorId:'creator',title:'listed',publishTime:0,kind:'image-text',status:'listed'}});
    directory(['note','safe']);const normal=api.getMockImplementation()!;
    api.mockImplementation(async(req:any)=>{const response=await normal(req);if(new URL(req.url).pathname.endsWith('/feed'))response.body.data.items[0].note_card.image_list=[{url_default:'https://invalid.example/never-sent'}];return response;});
    await whole.prepareGeneration(input);const id=(await read()).generation.id;
    await whole.executeGeneration({jobId:'job',generationId:id,confirmUnknown:true,selectedIds:[safe]});await drain();
    const row=await db.xhsNote.findUnique({where:{id:safe}}),job=await read();
    expect(requestedDetails()).toEqual(['safe']);expect(media).not.toHaveBeenCalled();expect(row?.publishTime).toBe(1760000000);expect(row?.contentHtml).toContain('Synthetic body safe');expect(row?.status).toBe('listed');
    const metrics=await db.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_metric_snapshots WHERE owner_kind='note' AND owner_id=${safe}`;expect(JSON.parse(metrics[0].document).values).toMatchObject({likes:1,collects:2,shares:3,comments:4});
    const task=(await db.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_subscription_tasks WHERE id=${job.listTask}`)[0].document;
    expect(JSON.parse(task).mediaManifests[safe]).toMatchObject({state:'needs-review',manifest:{images:[{ordinal:1,resourceKey:null}]}});
    expect(task).not.toContain('invalid.example');
    expect(job.state).toBe('partial');expect(job.generation.basicCompleted).toBe(true);expect(job.generation.missingIds).toContain(noteKey);expect(job.generation.detailReceipts[safe]).toMatchObject({outcome:'checkpointed'});await assertUnknownPreserved();
  },15000);
  it('checkpoints media identity with basic data while signed URLs remain session-only',async()=>{
    const safe=JSON.stringify(['xiaohongshu','note','safe']);
    await db.xhsNote.create({data:{id:safe,creatorId:'creator',title:'listed',publishTime:0,kind:'image-text',status:'listed'}});
    directory(['note','safe']);const normal=api.getMockImplementation()!;
    api.mockImplementation(async(req:any)=>{const result=await normal(req);if(new URL(req.url).pathname.endsWith('/feed'))result.body.data.items[0].note_card.image_list=[{url_default:'https://sns-webpic.xhscdn.com/a.png?token=synthetic-secret'}];return result;});
    await whole.prepareGeneration(input);const id=(await read()).generation.id;
    await whole.executeGeneration({jobId:'job',generationId:id,confirmUnknown:true,selectedIds:[safe]});await drain();
    const job=await read(),task=(await db.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_subscription_tasks WHERE id=${job.listTask}`)[0].document;
    const saved=JSON.parse(task).mediaManifests[safe];expect(saved.state).toBe('pending');expect(saved.manifest.images).toHaveLength(1);
    expect(task).not.toContain('synthetic-secret');expect(task).not.toContain('sns-webpic');
    expect((await subscriptions.task({taskId:job.listTask})).mediaSummary).toMatchObject({manifestNotes:1,declaredImages:1,pendingImages:1,needsDetailRefreshNotes:0});
    expect(runtime.getTransientMediaUrl('author','safe',saved.manifest.version,saved.manifest.images[0].resourceKey)).toContain('synthetic-secret');
    runtime.onModuleDestroy();expect(runtime.getTransientMediaUrl('author','safe',saved.manifest.version,saved.manifest.images[0].resourceKey)).toBeUndefined();
    expect((await subscriptions.task({taskId:job.listTask})).mediaSummary).toMatchObject({pendingImages:1,needsDetailRefreshNotes:1});
    expect(requestedDetails()).toEqual(['safe']);expect(media).not.toHaveBeenCalled();await assertUnknownPreserved();
  },15000);
  it('explicitly resumes selected media without repeating detail and refuses the historical unknown',async()=>{
    const safe=JSON.stringify(['xiaohongshu','note','safe']);
    await db.xhsNote.create({data:{id:safe,creatorId:'creator',title:'listed',publishTime:0,kind:'image-text',status:'listed'}});
    directory(['note','safe']);const normal=api.getMockImplementation()!;
    api.mockImplementation(async(req:any)=>{const result=await normal(req);if(new URL(req.url).pathname.endsWith('/feed'))result.body.data.items[0].note_card.image_list=[{url_default:'https://sns-webpic.xhscdn.com/a.png?token=synthetic-secret'}];return result;});
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=','base64');
    media.mockImplementation(async()=>new Response(png,{status:200,headers:{'content-type':'image/png'}}));
    await whole.prepareGeneration(input);const id=(await read()).generation.id;
    await whole.executeGeneration({jobId:'job',generationId:id,confirmUnknown:true,selectedIds:[safe]});await drain();
    const before=await read();expect(requestedDetails()).toEqual(['safe']);expect(media).not.toHaveBeenCalled();
    await expect(whole.resumeMedia({jobId:'job',generationId:id,noteIds:[noteKey]})).rejects.toThrow();
    await whole.resumeMedia({jobId:'job',generationId:id,noteIds:[safe]});await drain();
    const after=await read();expect(after.state).toBe('partial');expect(after.generation.mediaResults[safe]).toBe('complete');
    expect(after.generation.detailReceipts[safe]).toEqual(before.generation.detailReceipts[safe]);
    expect(requestedDetails()).toEqual(['safe']);expect(media).toHaveBeenCalledTimes(1);
    const saved=await db.xhsNote.findUniqueOrThrow({where:{id:safe}});expect(saved.contentHtml).toContain('Synthetic body safe');expect(saved.contentHtml).toContain('data-xhs-media');
    await whole.resumeMedia({jobId:'job',generationId:id,noteIds:[safe]});await drain();expect(media).toHaveBeenCalledTimes(1);
    await assertUnknownPreserved();
  },20000);
  it('repairs only eight selected missing basics and reuses fourteen complete notes',async()=>{
    const key=(v:string)=>JSON.stringify(['xiaohongshu','note',v]), names=Array.from({length:22},(_,i)=>'repair-'+String(i).padStart(2,'0'));
    for(const name of [...names,'second-unknown'])await db.xhsNote.create({data:{id:key(name),creatorId:'creator',title:name,publishTime:0,kind:'image-text',status:'listed'}});
    directory(['note',...names,'second-unknown']);const normal=api.getMockImplementation()!;let first=true;
    api.mockImplementation(async(req:any)=>{const result=await normal(req);if(new URL(req.url).pathname.endsWith('/feed')){const n=JSON.parse(req.body).source_note_id;if(n==='second-unknown')result.body.data.items=[];else if(first&&names.slice(0,8).includes(n))delete result.body.data.items[0].note_card.interact_info.collected_count;}return result;});
    await whole.prepareGeneration({...input,phaseLimits:{...input.phaseLimits,detail:40}});const id=(await read()).generation.id;
    await whole.executeGeneration({jobId:'job',generationId:id,confirmUnknown:true,selectedIds:[...names,'second-unknown'].map(key)});await drain();
    expect(requestedDetails()).toEqual([...names,'second-unknown']);expect((await read()).state).toBe('paused');
    await whole.reviewGeneration({jobId:'job',generationId:id,confirmUnknown:true,excludeUnknown:true});
    await whole.executeGeneration({jobId:'job',generationId:id,confirmUnknown:true,selectedIds:names.map(key)});await drain();
    expect(requestedDetails()).toEqual([...names,'second-unknown']);first=false;api.mockClear();
    await expect(whole.resumeMissingBasic({jobId:'job',generationId:id,noteIds:[noteKey]})).rejects.toThrow();
    await expect(whole.resumeMissingBasic({jobId:'job',generationId:id,noteIds:[key('second-unknown')]})).rejects.toThrow();
    await whole.resumeMissingBasic({jobId:'job',generationId:id,noteIds:names.map(key)});await drain();
    expect(requestedDetails()).toEqual(names.slice(0,8));
    const job=await read();expect(job.state).toBe('partial');expect(Object.keys(job.generation.basicRepairResults)).toHaveLength(8);
    const tasks=await db.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_subscription_tasks WHERE id=${job.listTask}`;
    const basic=JSON.parse(tasks[0].document).basicResults;for(const n of names)expect(basic[key(n)]).toBe('complete');
    for(const name of names){const row=await db.xhsNote.findUniqueOrThrow({where:{id:key(name)}});expect(row.contentHtml).toContain('Synthetic body');}
    expect(await whole.resumeMissingBasic({jobId:'job',generationId:id,noteIds:names.map(key)})).toEqual({state:'nothing-missing'});
    expect(requestedDetails()).toEqual(names.slice(0,8));expect(await db.$queryRaw`SELECT id FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%'`).toHaveLength(2);await assertUnknownPreserved();
  },40000);
  it('stops a missing-basic repair on a platform restriction and rejects duplicate submission',async()=>{
    const key=(v:string)=>JSON.stringify(['xiaohongshu','note',v]),names=['repair-a','repair-b'];
    for(const n of names)await db.xhsNote.create({data:{id:key(n),creatorId:'creator',title:n,publishTime:0,kind:'image-text',status:'listed'}});
    directory(['note',...names]);const normal=api.getMockImplementation()!;let initial=true;
    api.mockImplementation(async(req:any)=>{const result=await normal(req);if(new URL(req.url).pathname.endsWith('/feed')){if(initial)delete result.body.data.items[0].note_card.interact_info.collected_count;else return {status:461,url:req.url,body:{success:false,code:461}};}return result;});
    await whole.prepareGeneration(input);const id=(await read()).generation.id;
    await whole.executeGeneration({jobId:'job',generationId:id,confirmUnknown:true,selectedIds:names.map(key)});await drain();
    initial=false;api.mockClear();
    await whole.resumeMissingBasic({jobId:'job',generationId:id,noteIds:names.map(key)});
    await expect(whole.resumeMissingBasic({jobId:'job',generationId:id,noteIds:names.map(key)})).rejects.toThrow();
    await drain();const job=await read();expect(job.state).toBe('paused');expect(requestedDetails()).toEqual(['repair-a']);
    await expect(whole.resumeMissingBasic({jobId:'job',generationId:id,noteIds:names.map(key)})).rejects.toThrow();
    expect(requestedDetails()).toEqual(['repair-a']);await assertUnknownPreserved();
  },20000);
  it('continues an interrupted selected basic repair from its persisted child without replaying completed detail',async()=>{
    const key=(v:string)=>JSON.stringify(['xiaohongshu','note',v]),names=['repair-a','repair-b'],ids=names.map(key);
    for(const n of names)await db.xhsNote.create({data:{id:key(n),creatorId:'creator',title:n,publishTime:0,kind:'image-text',status:'listed'}});
    directory(['note',...names]);const normal=api.getMockImplementation()!;let initial=true;
    api.mockImplementation(async(req:any)=>{const result=await normal(req);if(initial&&new URL(req.url).pathname.endsWith('/feed'))delete result.body.data.items[0].note_card.interact_info.collected_count;return result;});
    await whole.prepareGeneration(input);const id=(await read()).generation.id;
    await whole.executeGeneration({jobId:'job',generationId:id,confirmUnknown:true,selectedIds:ids});await drain();
    initial=false;api.mockClear();let stopped=false;const checkpoint=runtime.checkpointWholeSource.bind(runtime);
    jest.spyOn(runtime,'checkpointWholeSource').mockImplementation(async(tx,at)=>{await checkpoint(tx,at);if(!stopped&&(runtime as any).wholeSourceGroup.getStore()?.phase==='detail'){stopped=true;live=false;}});
    await whole.resumeMissingBasic({jobId:'job',generationId:id,noteIds:ids});await drain();
    const paused=await read();expect(paused.state).toBe('paused');expect(paused.basicRepairRequest.taskId).toBeTruthy();expect(requestedDetails()).toEqual(['repair-a']);
    await whole.onModuleDestroy();await subscriptions.onModuleDestroy();runtime.onModuleDestroy();services();await whole.onModuleInit();live=true;
    await expect(whole.resumeMissingBasic({jobId:'job',generationId:id,noteIds:[ids[1]]})).rejects.toThrow();
    await whole.resumeMissingBasic({jobId:'job',generationId:id,noteIds:ids});await drain();
    const done=await read();if(done.state!=='partial'){const child=await subscriptions.task({taskId:done.basicRepairRequest.taskId});console.info('synthetic repair resume diagnostic',{code:done.code,childState:child.state,childCode:child.code,activeFence:done.generation.activeFence?.state,details:requestedDetails()});}expect({state:done.state,code:done.code}).toEqual({state:'partial',code:'XHS_MEDIA_OR_SUPPLEMENT_PENDING'});expect(requestedDetails()).toEqual(['repair-a','repair-b']);expect(done.basicRepairRequest).toBeUndefined();
    await assertUnknownPreserved();
  },30000);
  it('marks a missing media manifest for review without treating it as zero images',async()=>{
    const safe=JSON.stringify(['xiaohongshu','note','safe']);
    await db.xhsNote.create({data:{id:safe,creatorId:'creator',title:'listed',publishTime:0,kind:'image-text',status:'listed'}});
    directory(['note','safe']);const normal=api.getMockImplementation()!;
    api.mockImplementation(async(req:any)=>{const result=await normal(req);if(new URL(req.url).pathname.endsWith('/feed'))delete result.body.data.items[0].note_card.image_list;return result;});
    await whole.prepareGeneration(input);const id=(await read()).generation.id;
    await whole.executeGeneration({jobId:'job',generationId:id,confirmUnknown:true,selectedIds:[safe]});await drain();
    const job=await read(),raw=(await db.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_subscription_tasks WHERE id=${job.listTask}`)[0].document;
    expect(JSON.parse(raw).mediaManifests[safe]).toEqual({state:'needs-review',code:'XHS_MEDIA_MANIFEST_UNAVAILABLE'});
    expect((await subscriptions.task({taskId:job.listTask})).mediaSummary).toMatchObject({manifestNotes:0,needsReviewNotes:1,needsDetailRefreshNotes:1});
    expect((await db.xhsNote.findUnique({where:{id:safe}}))?.contentHtml).toContain('Synthetic body safe');expect(media).not.toHaveBeenCalled();
  },15000);
  it('reuses complete basic fields even when media has not been archived',async()=>{
    const safe=JSON.stringify(['xiaohongshu','note','safe']);
    await db.xhsNote.create({data:{id:safe,creatorId:'creator',title:'Saved',publishTime:1760000000,kind:'image-text',status:'listed',contentHtml:'<div id="js_content"><p>Existing body</p></div>'}});
    const snapshot={values:{likes:1,collects:2,shares:3,comments:4},collectedAt:123,contract:'synthetic',evidence:'source-only'};
    await db.$executeRaw`INSERT INTO xhs_metric_snapshots(owner_kind,owner_id,document) VALUES('note',${safe},${JSON.stringify(snapshot)})`;
    directory(['note','safe']);await whole.prepareGeneration(input);const id=(await read()).generation.id;
    await whole.executeGeneration({jobId:'job',generationId:id,confirmUnknown:true,selectedIds:[safe]});await drain();
    expect(requestedDetails()).toEqual([]);expect(media).not.toHaveBeenCalled();
    expect((await db.xhsNote.findUnique({where:{id:safe}}))?.contentHtml).toContain('Existing body');await assertUnknownPreserved();
  },15000);
  it.each(['success','lost','restricted','media-invalid','active'] as const)('allows one explicitly bound excluded detail from a partial generation without replay: %s',async mode=>{
    await db.$executeRaw`UPDATE xhs_request_budgets SET interval_ms=1000 WHERE id IN ('job','xhs:source-total')`;
    const initial=await read(),proof=initial.legacyMaintenanceProof;
    const initialBudgets=await db.$queryRaw<any[]>`SELECT id,used,request_limit,next_at,interval_ms FROM xhs_request_budgets WHERE id IN ('job','xhs:source-total')`;
    proof.scope.budgetDigest=legacyBudgetDigest(initial,initialBudgets,'job');
    proof.proofId=hash({scope:proof.scope,lockIdentity:proof.lockIdentity,lockNonce:proof.lockNonce,holder:proof.holder,snapshot:proof.snapshot});
    await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(initial)} WHERE id='job'`;
    original=JSON.parse(JSON.stringify(initial));
    const safe=JSON.stringify(['xiaohongshu','note','safe']);
    await db.xhsNote.create({data:{id:safe,creatorId:'creator',title:'listed',publishTime:0,kind:'image-text',status:'listed'}});
    directory(['note','safe']);
    const normal=api.getMockImplementation()!;
    let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>release=r);
    api.mockImplementation(async(req:any)=>{if(new URL(req.url).pathname.endsWith('/feed')&&JSON.parse(req.body).source_note_id==='note'){if(mode==='lost')throw new RedbookPauseError('transport');if(mode==='restricted')return {status:461,url:req.url,body:{success:false,code:-1}};if(mode==='active'){enter();await gate;}}const response=await normal(req);if(new URL(req.url).pathname.endsWith('/feed')&&JSON.parse(req.body).source_note_id==='note')response.body.data.items[0].note_card.image_list=[{url_default:mode==='media-invalid'?'https://invalid.example/image.png':'https://sns-webpic.xhscdn.com/synthetic.png?synthetic=secret'}];return response;});
    await whole.prepareGeneration(input);const id=(await read()).generation.id;
    await whole.executeGeneration({jobId:'job',generationId:id,confirmUnknown:true,selectedIds:[safe]});await drain();
    expect((await read()).state).toBe('partial');
    await expect(whole.prepareReviewedAttempt({jobId:'job',confirmUnknownRetry:true,excludedNoteId:'safe'})).rejects.toThrow();
    await db.$executeRaw`UPDATE xhs_request_budgets SET next_at=0 WHERE id IN ('job','xhs:source-total')`;
    const prepared=await whole.prepareReviewedAttempt({jobId:'job',confirmUnknownRetry:true,excludedNoteId:'note'});
    const before=requestedDetails().length;
    const call=()=>whole.executeReviewedAttempt({jobId:'job',attemptId:prepared.id,url:'https://www.xiaohongshu.com/explore/note?xsec_token=synthetic-token&xsec_source=pc_share',confirmUnknownRetry:true});
    if(mode==='active'){
      const pending=call();await entered;
      try { expect((await whole.view('job')).reviewedRecovery?.state).toBe('in-progress');await expect(call()).rejects.toThrow(); } finally {release();}
      await pending;
    } else if(mode==='success'||mode==='media-invalid')await call();else await expect(call()).rejects.toThrow();
    await expect(call()).rejects.toThrow();
    expect(requestedDetails().slice(before)).toEqual(['note']);
    const job=await read();expect(job.sourceFence.state).toBe('started');expect(job.reviewAttempt.state).toBe(['success','media-invalid','active'].includes(mode)?'checkpointed':'consumed');
    if(['success','media-invalid','active'].includes(mode)){
      if(mode==='media-invalid')expect(job.reviewAttempt.receipt).toMatchObject({media:'needs-review',mediaFailure:'XHS_MEDIA_MANIFEST_UNAVAILABLE'});
      else expect(job.reviewAttempt.receipt.mediaManifest).toMatchObject([{ordinal:1,state:'not-downloaded',sourceQueryOmitted:true}]);
      expect(JSON.stringify(job.reviewAttempt.receipt)).not.toContain('synthetic=secret');
      expect((await db.xhsNote.findUnique({where:{id:noteKey}}))?.contentHtml).toContain('Synthetic body note');
      const listed=await new XiaohongshuService(db as any).notes('creator');
      expect(listed.items.find(item=>item.id===noteKey)?.basicStatus).toBe('complete');
      if(mode==='success'){
        await db.$executeRaw`UPDATE xhs_metric_snapshots SET document=json_set(document,'$.values.collects',NULL) WHERE owner_kind='note' AND owner_id=${safe}`;
        api.mockClear();await whole.resumeMissingBasic({jobId:'job',generationId:id,noteIds:[safe]});await drain();
        expect(requestedDetails()).toEqual(['safe']);expect((await read()).reviewAttempt.state).toBe('checkpointed');
        expect(await whole.resumeMissingBasic({jobId:'job',generationId:id,noteIds:[noteKey]})).toEqual({state:'nothing-missing'});
        expect(requestedDetails()).toEqual(['safe']);
        expect((await whole.view('job')).generationRecovery?.mediaRecoverableIds).toContain(noteKey);
        await whole.resumeMedia({jobId:'job',generationId:id,noteIds:[noteKey]});await drain();
        const afterMedia=await read();expect(afterMedia.generation.mediaResults[noteKey]).toBe('needs-detail-refresh');
        expect(afterMedia.reviewAttempt.state).toBe('checkpointed');expect(requestedDetails()).toEqual(['safe']);expect(media).not.toHaveBeenCalled();
      }
    } else expect((await db.xhsNote.findUnique({where:{id:noteKey}}))?.contentHtml).toBeNull();
    if(mode==='restricted')expect((await db.$queryRaw<Array<{code:string}>>`SELECT code FROM xhs_source_risk WHERE id='source'`)[0].code).toBe('XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED');
    if(mode==='lost'){
      expect((await whole.view('job')).reviewedRecovery?.state).toBe('consumed');
      const restarted=new XhsWholeCreatorService(db as any,subscriptions,runtime,new XhsEngagementService(db as any,runtime));
      expect((await restarted.view('job')).reviewedRecovery?.state).toBe('consumed');
    }
    await assertUnknownPreserved();
  },20000);
  it('resumes committed basic fields without replay after interruption',async()=>{
    const key=(v:string)=>JSON.stringify(['xiaohongshu','note',v]), ids=[key('safe-a'),key('safe-b')];
    for(const id of ids)await db.xhsNote.create({data:{id,creatorId:'creator',title:'listed',publishTime:0,kind:'image-text',status:'listed'}});
    directory(['note','safe-a','safe-b']);let stopped=false;const checkpoint=runtime.checkpointWholeSource.bind(runtime);
    jest.spyOn(runtime,'checkpointWholeSource').mockImplementation(async(tx,at)=>{await checkpoint(tx,at);if(!stopped&&(runtime as any).wholeSourceGroup.getStore()?.phase==='detail'){stopped=true;live=false;}});
    await whole.prepareGeneration(input);const id=(await read()).generation.id;const run=()=>whole.executeGeneration({jobId:'job',generationId:id,confirmUnknown:true,selectedIds:ids});
    await run();await drain();expect(requestedDetails()).toEqual(['safe-a']);expect((await read()).state).toBe('paused');
    await whole.onModuleDestroy();await subscriptions.onModuleDestroy();runtime.onModuleDestroy();services();await whole.onModuleInit();live=true;await run();await drain();
    expect(requestedDetails()).toEqual(['safe-a','safe-b']);expect(media).not.toHaveBeenCalled();expect((await read()).generation.basicCompleted).toBe(true);await assertUnknownPreserved();
  },20000);
  it('excludes a newly unknown detail and carries earlier basic receipts without replay',async()=>{
    const key=(v:string)=>JSON.stringify(['xiaohongshu','note',v]), a=key('safe-a'), b=key('safe-b');
    for(const id of [a,b])await db.xhsNote.create({data:{id,creatorId:'creator',title:'listed',publishTime:0,kind:'image-text',status:'listed'}});
    directory(['note','safe-a','safe-b']);const normal=api.getMockImplementation()!;
    api.mockImplementation(async(req:any)=>{const response=await normal(req);if(new URL(req.url).pathname.endsWith('/feed')&&JSON.parse(req.body).source_note_id==='safe-b')response.body.data.items=[];return response;});
    await whole.prepareGeneration(input);const id=(await read()).generation.id;
    await whole.executeGeneration({jobId:'job',generationId:id,confirmUnknown:true,selectedIds:[a,b]});await drain();
    expect(requestedDetails()).toEqual(['safe-a','safe-b']);const failed=await read();expect(failed.generation.activeFence?.noteId).toBe('safe-b');
    await expect(whole.reviewGeneration({jobId:'job',generationId:id,confirmUnknown:true})).rejects.toThrow();
    await whole.reviewGeneration({jobId:'job',generationId:id,confirmUnknown:true,excludeUnknown:true});const reviewed=await read();
    expect(reviewed.generation.selectedIds).toEqual([a]);expect(reviewed.generation.reviews.at(-1).decision).toBe('exclude');expect(reviewed.generation.carriedBasicResults[a]).toBe('complete');
    expect(await db.$queryRaw<Array<{id:string}>>`SELECT id FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%'`).toHaveLength(2);
    await whole.executeGeneration({jobId:'job',generationId:id,confirmUnknown:true,selectedIds:[a]});await drain();
    expect(requestedDetails()).toEqual(['safe-a','safe-b']);expect((await read()).generation.missingIds).toEqual(expect.arrayContaining([noteKey,b]));await assertUnknownPreserved();
    await expect(whole.prepareReviewedAttempt({jobId:'job',confirmUnknownRetry:true,excludedNoteId:'safe-a'})).rejects.toThrow();
    await expect(whole.prepareReviewedAttempt({jobId:'job',confirmUnknownRetry:true,excludedNoteId:'safe-b'})).resolves.toMatchObject({state:'prepared'});
  },20000);
  it('excludes an unknown note from an older media child before starting basic collection',async()=>{
    const key=(v:string)=>JSON.stringify(['xiaohongshu','note',v]), a=key('safe-a'), b=key('safe-b');
    for(const id of [a,b])await db.xhsNote.create({data:{id,creatorId:'creator',title:'listed',publishTime:0,kind:'image-text',status:'listed'}});
    directory(['note','safe-a','safe-b']);const normal=api.getMockImplementation()!;
    api.mockImplementation(async(req:any)=>{const response=await normal(req);if(new URL(req.url).pathname.endsWith('/feed'))response.body.data.items[0].note_card.image_list=[{url_default:'https://sns-webpic.xhscdn.com/synthetic.png'}];return response;});
    const {XhsMediaError}=require('./xhs-media-error');media.mockImplementation(async()=>{throw new XhsMediaError('XHS_MEDIA_REQUEST_REJECTED');});
    const refresh=subscriptions.refreshFull.bind(subscriptions);const oldMode=jest.spyOn(subscriptions,'refreshFull').mockImplementation(args=>refresh({...args,basicOnly:false}));
    await whole.prepareGeneration(input);const id=(await read()).generation.id;await whole.executeGeneration({jobId:'job',generationId:id,confirmUnknown:true,selectedIds:[a,b]});await drain();
    const paused=await read();expect(paused.generation.activeFence?.noteId).toBe('safe-a');expect(requestedDetails()).toEqual(['safe-a']);oldMode.mockRestore();
    await whole.reviewGeneration({jobId:'job',generationId:id,confirmUnknown:true,excludeUnknown:true});
    await whole.executeGeneration({jobId:'job',generationId:id,confirmUnknown:true,selectedIds:[b]});await drain();
    expect(requestedDetails()).toEqual(['safe-a','safe-b']);expect(media).toHaveBeenCalledTimes(1);expect((await db.xhsNote.findUnique({where:{id:b}}))?.contentHtml).toContain('Synthetic body safe-b');await assertUnknownPreserved();
  },20000);
  it('collects a synthetic 21-note basic range while excluding two unknown notes',async()=>{
    const key=(v:string)=>JSON.stringify(['xiaohongshu','note',v]), safe=Array.from({length:21},(_,i)=>'safe-'+String(i).padStart(2,'0'));
    for(const name of ['second-unknown',...safe])await db.xhsNote.create({data:{id:key(name),creatorId:'creator',title:name,publishTime:0,kind:'image-text',status:'listed'}});
    directory(['note','second-unknown',...safe]);await whole.prepareGeneration({...input,phaseLimits:{...input.phaseLimits,detail:30}});const id=(await read()).generation.id;
    await whole.executeGeneration({jobId:'job',generationId:id,confirmUnknown:true,selectedIds:safe.map(key)});await drain();
    expect(requestedDetails()).toEqual(safe);expect(media).not.toHaveBeenCalled();const job=await read();expect(job.state).toBe('partial');expect(job.generation.missingIds).toEqual(expect.arrayContaining([noteKey,key('second-unknown')]));
    const notes=await db.xhsNote.findMany({where:{id:{in:safe.map(key)}}});expect(notes).toHaveLength(21);expect(notes.every(n=>n.publishTime===1760000000&&!!n.contentHtml&&n.status==='listed')).toBe(true);
    expect(await db.xhsMetricSnapshot.count({where:{ownerKind:'note',ownerId:{in:safe.map(key)}}})).toBe(21);await assertUnknownPreserved();
  },40000);
  it('never dispatches a historical unknown note when a narrowed recovery is explicitly selected',async()=>{
    const safe=JSON.stringify(['xiaohongshu','note','safe']);
    await db.xhsNote.create({data:{id:safe,creatorId:'creator',title:'safe',publishTime:0,kind:'image-text',status:'listed'}});
    directory(['note','safe']); await whole.prepareGeneration(input);const id=(await read()).generation.id;
    await (whole as any).executeGeneration({jobId:'job',generationId:id,confirmUnknown:true,selectedIds:[safe]});await drain();
    expect(requestedDetails()).not.toContain('note');expect(requestedDetails()).toEqual(['safe']);await assertUnknownPreserved();
  },15000);
  it('keeps the narrowed scope through interruption and reuses verified cached bodies',async()=>{
    const key=(v:string)=>JSON.stringify(['xiaohongshu','note',v]);
    const cached=key('a-cached'), first=key('b-first'), second=key('c-second');
    for(const id of [cached,first,second]) await db.xhsNote.create({data:{id,creatorId:'creator',title:id,publishTime:id===cached?100:0,kind:'image-text',status:id===cached?'complete':'listed',contentHtml:id===cached?'<div id="js_content"><p>Verified cached body</p></div>':null}});
    await db.xhsMetricSnapshot.create({data:{ownerKind:'note',ownerId:cached,document:JSON.stringify({values:{likes:1,collects:1,shares:1,comments:1},collectedAt:Date.now(),contract:'synthetic',evidence:'source-only'})}});
    directory(['note','a-cached','b-first','c-second']);let stopped=false;
    const checkpoint=runtime.checkpointWholeSource.bind(runtime);
    jest.spyOn(runtime,'checkpointWholeSource').mockImplementation(async(tx,at)=>{await checkpoint(tx,at);if(!stopped && (runtime as any).wholeSourceGroup.getStore()?.phase==='detail'){stopped=true;live=false;}});
    await whole.prepareGeneration(input);const id=(await read()).generation.id;const selectedIds=[cached,first,second];
    const run=()=>whole.executeGeneration({jobId:'job',generationId:id,confirmUnknown:true,selectedIds});
    await run();await drain();expect((await read()).state).toBe('paused');expect(requestedDetails()).toEqual(['b-first']);
    await whole.onModuleDestroy();await subscriptions.onModuleDestroy();runtime.onModuleDestroy();services();await whole.onModuleInit();live=true;
    await expect(whole.executeGeneration({jobId:'job',generationId:id,confirmUnknown:true,selectedIds:[first,second]})).rejects.toThrow();
    await run();await drain();const result=await read();expect(requestedDetails()).toEqual(['b-first','c-second']);
    expect(result.generation.selectedIds).toEqual(selectedIds);expect(result.generation.missingIds).toContain(noteKey);expect(result.state).toBe('partial');
    expect((await db.xhsNote.findUnique({where:{id:cached}}))?.contentHtml).toContain('Verified cached body');
    await run();await drain();expect(requestedDetails()).toEqual(['b-first','c-second']);await assertUnknownPreserved();
  },20000);
  it('stops narrowed recovery at a platform refusal and cannot replay after restart',async()=>{
    const safe=JSON.stringify(['xiaohongshu','note','safe']);await db.xhsNote.create({data:{id:safe,creatorId:'creator',title:'safe',publishTime:0,kind:'image-text',status:'listed'}});
    directory(['note','safe']);const normal=api.getMockImplementation()!;
    api.mockImplementation(async(request:any)=>new URL(request.url).pathname.endsWith('/feed')?{status:461,url:request.url,body:{success:false,code:461}}:normal(request));
    await whole.prepareGeneration(input);const id=(await read()).generation.id;
    const run=()=>whole.executeGeneration({jobId:'job',generationId:id,confirmUnknown:true,selectedIds:[safe]});
    await expect(whole.executeGeneration({jobId:'job',generationId:id,confirmUnknown:true,selectedIds:[safe,noteKey]})).rejects.toThrow();
    await run();await drain();expect((await read()).state).toBe('paused');expect(requestedDetails()).toEqual(['safe']);const budget=await currentBudget();
    await whole.onModuleDestroy();await subscriptions.onModuleDestroy();runtime.onModuleDestroy();services();await whole.onModuleInit();
    await expect(run()).rejects.toThrow();expect(requestedDetails()).toEqual(['safe']);expect(await currentBudget()).toEqual(budget);await assertUnknownPreserved();
  },15000);
  it('replaces an old completed directory-only child and saves all returned basic fields',async()=>{
    const ids=['note',...Array.from({length:22},(_,i)=>`old-${i}`)];
    const keys=ids.map(id=>JSON.stringify(['xiaohongshu','note',id]));
    for(const [index,id] of ids.entries()) if(index) await db.xhsNote.create({data:{id:keys[index],creatorId:'creator',title:id,publishTime:0,kind:'image-text',status:'listed'}});
    const oldChild={taskId:'old-list',creatorId:'creator',kind:'list',state:'completed',total:23,completed:23,skipped:0,failed:0,remaining:0,listFinished:true,listedIds:keys,items:{}};
    await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES('old-list','creator','completed',${JSON.stringify(oldChild)},1)`;
    const initial=await read();initial.listEnd=true;initial.listTask='old-list';
    await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(initial)} WHERE id='job'`;
    directory(ids);const oldApi=api.getMockImplementation()!;
    api.mockImplementation(async(req:any)=>{const response=await oldApi(req);if(new URL(req.url).pathname.endsWith('/feed') && JSON.parse(req.body).source_note_id==='note')response.body.data.items[0].note_card.image_list=[{url_default:'https://sns-webpic.xhscdn.com/synthetic.png'}];return response;});
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=','base64');
    media.mockImplementation(async()=>new Response(png,{status:200,headers:{'content-type':'image/png'}}));
    const refresh=subscriptions.refreshFull.bind(subscriptions);let first=true;
    jest.spyOn(subscriptions,'refreshFull').mockImplementation(async args=>{if(first){first=false;throw Error('synthetic local failure');}return refresh(args);});
    await whole.prepareGeneration({...input,phaseLimits:{...input.phaseLimits,detail:30}});const generationId=(await read()).generation.id;
    await execute(generationId);await drain();const paused=await read();
    expect(paused.state).toBe('paused');expect(paused.generation.localFailure).toMatchObject({stage:'list-task'});expect(requestedDetails()).toEqual([]);
    await execute(generationId);await drain();const done=await read();
    expect(done.state).toBe('partial');expect(done.listTask).not.toBe('old-list');expect(done.generation.directoryIds).toHaveLength(23);
    expect(new Set(requestedDetails()).size).toBe(23);expect(requestedDetails()).toHaveLength(23);expect(media).not.toHaveBeenCalled();
    const notes=await db.xhsNote.findMany({where:{creatorId:'creator'}});expect(notes).toHaveLength(23);expect(notes.every(n=>n.status==='listed'&&n.contentHtml&&n.publishTime>0)).toBe(true);
    expect(notes.find(n=>n.id===noteKey)?.contentHtml).toContain('Synthetic body');
    const priorCount=api.mock.calls.length;await execute(generationId);await drain();expect(api).toHaveBeenCalledTimes(priorCount);
    await assertUnknownPreserved();
  },40000);
  it('rebuilds directory membership on continuation and avoids repeating a completed detail',async()=>{
    const doneKey=JSON.stringify(['xiaohongshu','note','a-done']),missingKey=JSON.stringify(['xiaohongshu','note','b-missing']),freshKey=JSON.stringify(['xiaohongshu','note','c-fresh']);
    directory(['a-done','b-missing','c-fresh']);let stopped=false;
    const checkpoint=runtime.checkpointWholeSource.bind(runtime);
    jest.spyOn(runtime,'checkpointWholeSource').mockImplementation(async(tx,at)=>{
      await checkpoint(tx,at);if(!stopped && (runtime as any).wholeSourceGroup.getStore()?.phase==='detail'){stopped=true;live=false;}
    });
    await whole.prepareGeneration(input);const generationId=(await read()).generation.id;
    await execute(generationId);await drain();const paused=await read();
    expect(paused.state).toBe('paused');expect(requestedDetails()).toEqual(['a-done']);
    directory(['a-done','c-fresh']);live=true;await execute(generationId);await drain();const current=await read();
    expect(requestedDetails()).toEqual(['a-done','c-fresh']);
    expect(current.generation.directoryIds).toEqual([doneKey,freshKey]);expect(current.generation.missingIds).toContain(missingKey);
    expect((await db.xhsNote.findUnique({where:{id:missingKey}}))?.status).toBe('listed');
    expect(await db.xhsMetricSnapshot.count({where:{ownerKind:'note',ownerId:missingKey}})).toBe(0);
    await assertUnknownPreserved();
  }, 15000);
  it('leaves historical export children unchanged when caching without a destination',async()=>{
    const originals = new Map<string,string>();
    for (const taskId of ['old-archive','old-download']) {
      const old={taskId,creatorId:'creator',kind:'download',state:'blocked',noteIds:[noteKey],items:{},directory:folder+'-old',total:1,completed:0,skipped:0,failed:1,remaining:1,code:'XHS_DOWNLOAD_BLOCKED'};
      const raw=JSON.stringify(old);originals.set(taskId,raw);
      await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES(${taskId},'creator','blocked',${raw},1)`;
    }
    const job=await read();job.archiveTask='old-archive';job.downloadTask='old-download';
    await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(job)} WHERE id='job'`;
    const pick=jest.fn(async()=>{throw Error('unexpected picker');}),save=jest.fn(async()=>{throw Error('unexpected export');});subscriptions.bindLocalSaver(pick,save);
    await whole.prepareGeneration(input);await execute();await drain();expect((await read()).state).toBe('partial');
    for(const [taskId,raw] of originals) expect((await db.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_subscription_tasks WHERE id=${taskId}`)[0].document).toBe(raw);
    expect(pick).not.toHaveBeenCalled();expect(save).not.toHaveBeenCalled();await assertUnknownPreserved();
  });

  it('retains only the fixed directory conflict code and never arbitrary local messages',()=>{
    const {TRPCError}=require('@trpc/server');const {safeSourceFailure}=require('./xhs-source-receipt');
    expect(safeSourceFailure(new TRPCError({code:'PRECONDITION_FAILED',message:'XHS_RESUME_DIRECTORY_CHANGED'}),'admitted').code).toBe('XHS_RESUME_DIRECTORY_CHANGED');
    expect(safeSourceFailure(new Error('private path synthetic-secret'),'admitted').code).toBe('XHS_LOCAL_OPERATION_FAILED');
    const {ArticleDownloadError}=require('../article-download');
    expect(safeSourceFailure(new ArticleDownloadError('private path synthetic-secret',409,{code:'DIRECTORY_PICK_REQUIRED'}),'admitted').code).toBe('XHS_SAVE_DIRECTORY_SELECTION_REQUIRED');
    expect(safeSourceFailure(new ArticleDownloadError('private path synthetic-secret',409,{code:'OTHER'}),'admitted').code).toBe('XHS_LOCAL_OPERATION_FAILED');
  });

  it('starts one cache child and rejects duplicate execution',async()=>{
    await whole.prepareGeneration(input);const id=(await read()).generation.id;
    let release!:()=>void,entered!:()=>void; const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
    const refresh=subscriptions.refreshFull.bind(subscriptions);let count=0;
    jest.spyOn(subscriptions,'refreshFull').mockImplementation(async args=>{count++;entered();await gate;return refresh(args);});
    const first=execute(id);await started;
    try {await expect(execute(id)).rejects.toThrow();} finally {release();}
    await first;await drain();expect((await read()).state).toBe('partial');expect(count).toBe(1);await assertUnknownPreserved();
  });
  it('continues without local directory authorization or export',async()=>{
    await whole.prepareGeneration(input);const job=await read();const pick=jest.fn(async()=>{throw Error('unexpected picker');});
    const save=jest.fn(async()=>{throw Error('unexpected export');});subscriptions.bindLocalSaver(pick,save);
    await execute(job.generation.id);await drain();expect((await read()).state).toBe('partial');expect(pick).not.toHaveBeenCalled();expect(save).not.toHaveBeenCalled();await assertUnknownPreserved();
  });
  it('does not leave a dispatched child when cancellation wins child checkpoint',async()=>{
    await whole.prepareGeneration(input);const job=await read();let release!:()=>void,entered!:()=>void;
    const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r),refresh=subscriptions.refreshFull.bind(subscriptions);
    jest.spyOn(subscriptions,'refreshFull').mockImplementation(async args=>{entered();await gate;return refresh(args);});
    const first=execute(job.generation.id);await started;await whole.cancel('job');release();await first;await drain();
    expect((await read()).state).toBe('cancelled');await assertUnknownPreserved();
  });

});
