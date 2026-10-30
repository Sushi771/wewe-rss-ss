jest.mock('./xhs-dispatch-owner-observation',()=>({observeDispatchOwner:jest.fn(()=>'dead')}));
jest.mock('./xhs-dispatch-owner',()=>({createDispatchOwner:()=>({pid:22,startIdentity:'638000000000000001',nonce:'00000000-0000-4000-8000-000000000002'}),ownsDispatch:(v:any,e:any)=>v?.nonce===e?.nonce&&v?.pid===e?.pid&&v?.startIdentity===e?.startIdentity}));
import {PrismaClient} from '@prisma/client';
import {mkdtemp,rm,readdir,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';import * as path from 'node:path';
import {splitSqliteStatements} from '../../../../scripts/sqlite-statements.cjs';
import {XhsWholeCreatorService} from './xhs-whole-creator.service';import {XhsSubscriptionService} from './xhs-subscription.service';import {XhsSubscriptionRuntime} from './xhs-subscription-runtime';import {XhsEngagementService} from './xhs-engagement.service';import {XhsSourceRiskStore} from './xhs-source-risk-store';
import {attemptDigest,originalAttemptDigest,createReviewedAttempt} from './xhs-reviewed-attempt';
import {ConfigService} from '@nestjs/config';import {TrpcRouter} from '../trpc/trpc.router';import {TrpcService} from '../trpc/trpc.service';
import {createHTTPServer} from '@trpc/server/adapters/standalone';
import {createRequire} from 'node:module';
const {createTRPCProxyClient,httpLink}=createRequire(path.resolve(__dirname,'../../../web/package.json'))('@trpc/client');
describe('reviewed recovery product chain',()=>{
 let db:PrismaClient,folder:string,whole:XhsWholeCreatorService,runtime:XhsSubscriptionRuntime,api:jest.Mock,media:jest.Mock,live:boolean,caller:any,input:any,router:any;
 const marker='xhs:dispatch-pending:whole:00000000-0000-4000-8000-000000000001';
 beforeAll(async()=>{folder=await mkdtemp(path.join(tmpdir(),'xhs-product-'));db=new PrismaClient({datasources:{db:{url:'file:'+path.join(folder,'s.db').replace(/\\/g,'/')}}});const root=path.resolve(__dirname,'../../prisma/migrations');for(const name of (await readdir(root)).sort())if((await stat(path.join(root,name))).isDirectory())for(const sql of splitSqliteStatements(await readFile(path.join(root,name,'migration.sql'),'utf8')))await db.$executeRawUnsafe(sql)},40000);
 beforeEach(async()=>{
  // One atomic reset/seed, instead of eleven durable autocommits per example.
  // Keep the ordinary 5s hook bound and leave all product assertions unchanged.
  const a=await db.$transaction(async tx=>{
  await tx.$executeRaw`DELETE FROM xhs_limited_recovery_append`;await tx.$executeRaw`DELETE FROM xhs_limited_recovery`;
  await tx.$executeRaw`DELETE FROM xhs_request_budgets`;await tx.$executeRaw`DELETE FROM xhs_whole_creator_jobs`;await tx.$executeRaw`DELETE FROM xhs_metric_snapshots`;await tx.xhsNote.deleteMany();await tx.xhsCreator.deleteMany();
  await tx.xhsCreator.create({data:{id:'creator',profileUrl:'https://www.xiaohongshu.com/user/profile/author',displayName:'Synthetic',externalAuthorId:'author'}});
  const owner={pid:11,startIdentity:'638000000000000000',nonce:'00000000-0000-4000-8000-000000000001'};const grant={used:{detail:1},limits:{detail:5}};
  const doc:any={id:'job',creatorId:'creator',state:'paused',items:{},sourceFence:{marker,phase:'detail',noteId:'note',state:'started',owner},code:'XHS_DOWNLOAD_BLOCKED',sourceGrant:grant};doc.unknownReview={marker,owner,decision:'request-retry',originalCode:doc.code,originalGrant:grant,recordedAt:10};
  await tx.$executeRaw`INSERT INTO xhs_whole_creator_jobs(id,creator_id,state,document,updated_at) VALUES('job','creator','paused',${JSON.stringify(doc)},1)`;
  await tx.$executeRaw`UPDATE xhs_source_risk SET state='blocked',code='XHS_SOURCE_HISTORY_REVIEW_REQUIRED',owner=NULL WHERE id='source'`;
  await tx.$executeRaw`INSERT INTO xhs_request_budgets(id,used,request_limit,next_at,interval_ms) VALUES('job',6,310,0,10000),('xhs:source-total',8,312,0,10000),(${marker},1,1,0,0)`;
  const scope={jobId:'job',authorId:'author',noteId:'note',phase:'detail',originalHash:originalAttemptDigest(doc),reviewId:attemptDigest(doc.unknownReview),maxRequests:1,taskUsedCeiling:7,sharedUsedCeiling:9,expiresAt:Date.now()+60000};return createReviewedAttempt(tx,scope);
  });
  input={jobId:'job',attemptId:a.id,url:'https://www.xiaohongshu.com/explore/note?xsec_token=synthetic-access&xsec_source=pc_share',confirmUnknownRetry:true};
  live=true;api=jest.fn(async(request:any)=>({status:200,url:request.url,body:{success:true,code:0,data:{items:[{id:'note',note_card:{note_id:'note',user:{user_id:'author',nickname:'Synthetic'},type:'normal',time:1760000000000,title:'Synthetic',desc:'Synthetic body',image_list:[],interact_info:{liked_count:'0',collected_count:'2',share_count:'3',comment_count:'4'}}}]}}}));media=jest.fn();
  runtime=new XhsSubscriptionRuntime({enabled:()=>live,api,media,requirePersistentRisk:true});runtime.bindRiskStore(new XhsSourceRiskStore(db as any));(runtime as any).cookies={a1:'synthetic',web_session:'synthetic'};(runtime as any).stopCode='XHS_SOURCE_HISTORY_REVIEW_REQUIRED';
  const subs=new XhsSubscriptionService(db as any,runtime);whole=new XhsWholeCreatorService(db as any,subs,runtime,new XhsEngagementService(db as any,runtime));
  const config=new ConfigService({auth:{code:'synthetic'},platform:{url:''},feed:{updateDelayTime:0}});router=new TrpcRouter(new TrpcService({} as any,config,{} as any,{} as any),db as any,config,{} as any,{} as any,undefined,subs,runtime,undefined,whole).appRouter;caller=router.createCaller({errorMsg:null,isLocalSave:true});
 });
 afterEach(async()=>{runtime.onModuleDestroy()});afterAll(async()=>{await db.$disconnect();await rm(folder,{recursive:true,force:true})},40000);
 it('runs authenticated writable endpoint through real runtime and persists body, metrics and receipt once',async()=>{
  expect(await caller.xiaohongshu.executeWholeCreatorReviewedAttempt(input)).toMatchObject({subscribed:true,body:'saved'});
  expect(api).toHaveBeenCalledTimes(1);expect(media).not.toHaveBeenCalled();
  expect((await db.xhsNote.findFirst())?.contentHtml).toContain('Synthetic body');
  const rows=await db.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_whole_creator_jobs WHERE id='job'`;const job=JSON.parse(rows[0].document);expect(job.sourceFence.state).toBe('started');expect(job.reviewAttempt.receipt.body).toBe('saved');
  await expect(caller.xiaohongshu.executeWholeCreatorReviewedAttempt(input)).rejects.toThrow();expect(api).toHaveBeenCalledTimes(1);
 });
 it('prepares from an explicit confirmation without an inaccessible client-side marker or scope',async()=>{
  await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=json_remove(document,'$.reviewAttempt','$.unknownReview') WHERE id='job'`;
  const prepared=await caller.xiaohongshu.prepareWholeCreatorReviewedAttempt({jobId:'job',confirmUnknownRetry:true});
  expect(prepared.state).toBe('prepared');expect(api).not.toHaveBeenCalled();
  const saved=JSON.parse((await db.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_whole_creator_jobs WHERE id='job'`)[0].document);
  expect(saved.unknownReview).toMatchObject({decision:'request-retry',noteId:'note',executionAllowed:false});
  expect(saved.reviewAttempt.scope).toMatchObject({maxRequests:1,taskUsedCeiling:7,sharedUsedCeiling:9});
 });
 it('joins the product HTTP mutations and read query to the durable attempt without implicit source replay',async()=>{
  await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=json_remove(document,'$.reviewAttempt','$.unknownReview') WHERE id='job'`;
  const server=createHTTPServer({router,createContext:()=>({errorMsg:null,isLocalSave:true})}).server;
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const port=(server.address() as import('node:net').AddressInfo).port;
  const http=createTRPCProxyClient({links:[httpLink({url:`http://127.0.0.1:${port}`})]}).xiaohongshu;
  try{
    const prepared=await http.prepareWholeCreatorReviewedAttempt.mutate({jobId:'job',confirmUnknownRetry:true});
    expect(api).not.toHaveBeenCalled();
    expect((await http.wholeCreatorJobs.query({creatorId:'creator'}))[0].reviewedRecovery).toMatchObject({state:'prepared',attemptId:prepared.id});
    await http.executeWholeCreatorReviewedAttempt.mutate({...input,attemptId:prepared.id});
    const fresh=(await http.wholeCreatorJobs.query({creatorId:'creator'}))[0];
    expect(fresh.reviewedRecovery).toMatchObject({state:'checkpointed',receipt:{body:'saved'}});
    expect(fresh.sourceCheckpoint.state).toBe('unknown');
    await expect(http.executeWholeCreatorReviewedAttempt.mutate({...input,attemptId:prepared.id})).rejects.toThrow();
    expect(api).toHaveBeenCalledTimes(1);expect(media).not.toHaveBeenCalled();
  }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
 });
 it('projects only the recoverable attempt and keeps internal evidence out of the product response',async()=>{
  const view=await whole.view('job');
  expect(view.reviewedRecovery).toMatchObject({state:'prepared',noteId:'note',attemptId:input.attemptId});
  const publicText=JSON.stringify(view);
  for(const internal of ['unknownReview','reviewAttempt','lastSourceOwnerReceipt','dispatch-pending','startIdentity','originalHash','synthetic-access'])expect(publicText).not.toContain(internal);
  expect(view.sourceCheckpoint).toMatchObject({state:'unknown'});expect(view.resumable).toBe(false);
 });
 it('retains a consumed unknown after response success but transaction rollback, including restart',async()=>{
  const commit=jest.spyOn((whole as any).subscriptions,'commitReviewedRecovery');
  commit.mockImplementation(async function(this:any,...args:any[]){
    // Execute the real business write, then fail before its transaction commits.
    await XhsSubscriptionService.prototype.commitReviewedRecovery.apply(this,args as any);throw Error('synthetic pre-commit crash');
  });
  try{await expect(caller.xiaohongshu.executeWholeCreatorReviewedAttempt(input)).rejects.toThrow();}
  finally{commit.mockRestore();}
  expect(api).toHaveBeenCalledTimes(1);expect(await db.xhsNote.count()).toBe(0);expect(await db.xhsMetricSnapshot.count()).toBe(0);
  const fresh=new XhsWholeCreatorService(db as any,(whole as any).subscriptions,runtime,new XhsEngagementService(db as any,runtime));
  await fresh.onModuleInit();
  expect((await fresh.view('job')).reviewedRecovery).toMatchObject({state:'consumed'});
  await expect(fresh.executeReviewedAttempt(input)).rejects.toThrow();expect(api).toHaveBeenCalledTimes(1);
  expect((await db.$queryRaw<Array<{used:number}>>`SELECT used FROM xhs_request_budgets WHERE id='xhs:source-total'`)[0].used).toBe(9);
  expect((await db.$queryRaw<Array<{id:string}>>`SELECT id FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%'`)).toHaveLength(2);
  await fresh.onModuleDestroy();
 });
 it('recovers the durable receipt after a post-commit lost acknowledgement without another source call',async()=>{
  const transaction=db.$transaction.bind(db);let lost=false;
  const spy=jest.spyOn(db,'$transaction').mockImplementation((async(fn:any,...args:any[])=>{
    const value=await (transaction as any)(fn,...args);
    if(value?.body==='saved'&&!lost){lost=true;throw Error('synthetic committed acknowledgement lost');}
    return value;
  }) as any);
  try{await expect(caller.xiaohongshu.executeWholeCreatorReviewedAttempt(input)).rejects.toThrow();}
  finally{spy.mockRestore();}
  expect(lost).toBe(true);expect(api).toHaveBeenCalledTimes(1);expect(await db.xhsNote.count()).toBe(1);
  const fresh=new XhsWholeCreatorService(db as any,(whole as any).subscriptions,runtime,new XhsEngagementService(db as any,runtime));
  await fresh.onModuleInit();
  const view=await fresh.view('job');expect(view.reviewedRecovery).toMatchObject({state:'checkpointed',receipt:{body:'saved',media:'none',mediaCount:0}});
  expect(view.sourceCheckpoint).toMatchObject({state:'unknown'});expect(view.resumable).toBe(false);
  await expect(fresh.executeReviewedAttempt(input)).rejects.toThrow();expect(api).toHaveBeenCalledTimes(1);
  expect((await db.$queryRaw<Array<{id:string}>>`SELECT id FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%'`)).toEqual([{id:marker}]);
  await fresh.onModuleDestroy();
 });
 it('keeps legacy missing-owner blocked in the public product state and preparation rollback',async()=>{
  await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=json_remove(document,'$.sourceFence.owner','$.reviewAttempt','$.unknownReview') WHERE id='job'`;
  expect((await whole.view('job')).reviewedRecovery).toEqual({state:'blocked'});
  await expect(caller.xiaohongshu.prepareWholeCreatorReviewedAttempt({jobId:'job',confirmUnknownRetry:true})).rejects.toThrow();
  expect(api).not.toHaveBeenCalled();
  const saved=JSON.parse((await db.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_whole_creator_jobs WHERE id='job'`)[0].document);
  expect(saved.unknownReview).toBeUndefined();expect(saved.sourceFence.owner).toBeUndefined();
 });
 it('rejects invalid session and source OFF without a request',async()=>{(runtime as any).cookies=undefined;await expect(caller.xiaohongshu.executeWholeCreatorReviewedAttempt(input)).rejects.toThrow();live=false;await expect(caller.xiaohongshu.executeWholeCreatorReviewedAttempt(input)).rejects.toThrow();expect(api.mock.calls.length).toBe(0)});
 it('allows only one concurrent request',async()=>{const r=await Promise.allSettled([caller.xiaohongshu.executeWholeCreatorReviewedAttempt(input),caller.xiaohongshu.executeWholeCreatorReviewedAttempt(input)]);expect(r.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(api).toHaveBeenCalledTimes(1)});
 it('stops on source risk, persists fixed reason and does not retry',async()=>{api.mockImplementation(async(request:any)=>({status:461,url:request.url,body:{success:false,code:461}}));await expect(caller.xiaohongshu.executeWholeCreatorReviewedAttempt(input)).rejects.toThrow();await expect(caller.xiaohongshu.executeWholeCreatorReviewedAttempt(input)).rejects.toThrow();expect(api).toHaveBeenCalledTimes(1);expect(await db.xhsNote.count()).toBe(0);expect((await db.$queryRaw<Array<{code:string}>>`SELECT code FROM xhs_source_risk WHERE id='source'`)[0].code).toBe('XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED');expect((await whole.view('job')).reviewedRecovery).toMatchObject({state:'restricted',code:'XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED'})});
 it('protects both writable endpoints from read-only callers and rejects injected scope',async()=>{
  const read=router.createCaller({errorMsg:null,isLocalSave:false,isLocalXhsRead:true});
  await expect(read.xiaohongshu.executeWholeCreatorReviewedAttempt(input)).rejects.toMatchObject({code:'FORBIDDEN'});
  await expect(read.xiaohongshu.prepareWholeCreatorReviewedAttempt({jobId:'job',confirmUnknownRetry:true})).rejects.toMatchObject({code:'FORBIDDEN'});
  await expect(caller.xiaohongshu.executeWholeCreatorReviewedAttempt({...input,authorId:'other'})).rejects.toMatchObject({code:'BAD_REQUEST'});
  expect(api.mock.calls.length).toBe(0);
 });
 it('retains existing manual body and verifies metrics are persisted',async()=>{
  await db.xhsNote.create({data:{id:JSON.stringify(['xiaohongshu','note','note']),creatorId:'creator',title:'Manual',publishTime:0,kind:'image-text',status:'listed',contentHtml:'<p>manual protected</p>'}});
  expect(await caller.xiaohongshu.executeWholeCreatorReviewedAttempt(input)).toMatchObject({body:'retained'});
  expect((await db.xhsNote.findFirst())?.contentHtml).toBe('<p>manual protected</p>');expect(await db.xhsMetricSnapshot.count()).toBe(1);
 });
 it('prepares the exact reviewed server-derived scope with no source request',async()=>{
  await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=json_remove(document,'$.reviewAttempt') WHERE id='job'`;
  const a=await caller.xiaohongshu.prepareWholeCreatorReviewedAttempt({jobId:'job',confirmUnknownRetry:true});
  expect(await caller.xiaohongshu.prepareWholeCreatorReviewedAttempt({jobId:'job',confirmUnknownRetry:true})).toEqual(a);
  expect(a.state).toBe('prepared');expect(api.mock.calls.length).toBe(0);
  expect(await caller.xiaohongshu.executeWholeCreatorReviewedAttempt({...input,attemptId:a.id})).toMatchObject({body:'saved'});expect(api).toHaveBeenCalledTimes(1);
 });
 it('rejects an invalid official link before consuming any budget',async()=>{
  await expect(caller.xiaohongshu.executeWholeCreatorReviewedAttempt({...input,url:'https://example.invalid/note'})).rejects.toThrow();
  expect(api.mock.calls.length).toBe(0);expect((await db.$queryRaw<Array<{used:number}>>`SELECT used FROM xhs_request_budgets WHERE id='xhs:source-total'`)[0].used).toBe(8);
 });

 it('rejects a session generation change after a response without saving or replaying',async()=>{
  const original=api.getMockImplementation()!;api.mockImplementation(async(request:any)=>{const result=await original(request);(runtime as any).generation++;return result});
  await expect(caller.xiaohongshu.executeWholeCreatorReviewedAttempt(input)).rejects.toThrow();await expect(caller.xiaohongshu.executeWholeCreatorReviewedAttempt(input)).rejects.toThrow();expect(api).toHaveBeenCalledTimes(1);expect(await db.xhsNote.count()).toBe(0);
 });
 it('refuses legacy missing-owner at prepare and execute without source calls',async()=>{
  await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=json_remove(document,'$.sourceFence.owner') WHERE id='job'`;
  await expect(caller.xiaohongshu.prepareWholeCreatorReviewedAttempt({jobId:'job',confirmUnknownRetry:true})).rejects.toThrow();await expect(caller.xiaohongshu.executeWholeCreatorReviewedAttempt(input)).rejects.toThrow();expect(api.mock.calls.length).toBe(0);
 });
 it('does not overwrite another creator note after a business conflict',async()=>{
  await db.xhsCreator.create({data:{id:'other',profileUrl:'https://www.xiaohongshu.com/user/profile/other',displayName:'Other',externalAuthorId:'other'}});
  await db.xhsNote.create({data:{id:JSON.stringify(['xiaohongshu','note','note']),creatorId:'other',title:'Existing',publishTime:0,kind:'image-text',status:'listed',contentHtml:'<p>protected</p>'}});
  await expect(caller.xiaohongshu.executeWholeCreatorReviewedAttempt(input)).rejects.toThrow();await expect(caller.xiaohongshu.executeWholeCreatorReviewedAttempt(input)).rejects.toThrow();expect(api).toHaveBeenCalledTimes(1);expect((await db.xhsNote.findFirst())?.contentHtml).toBe('<p>protected</p>');
 });

 it('rejects direct runtime calls without the consumed dispatch permit',async()=>{
  const rows=await db.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_whole_creator_jobs WHERE id='job'`;const scope=JSON.parse(rows[0].document).reviewAttempt.scope;
  await expect(runtime.resolveReviewedNote(input.url,scope,{})).rejects.toThrow();expect(api.mock.calls.length).toBe(0);
 });

 it('does not request content from a subscription disabled after preparation',async()=>{
  await db.xhsCreator.update({where:{id:'creator'},data:{enabled:false}});
  await expect(caller.xiaohongshu.executeWholeCreatorReviewedAttempt(input)).rejects.toThrow();expect(api.mock.calls.length).toBe(0);
 });

 it.each(['disabled','author-changed'])('makes zero HTTP calls if %s after durable consumption but before transport',async change=>{
  const original=runtime.reviewedReadyCheck.bind(runtime);
  jest.spyOn(runtime,'reviewedReadyCheck').mockImplementation((()=>{
    const ready=original();let checks=0;
    return async()=>{ready();if(++checks===2)await db.xhsCreator.update({where:{id:'creator'},data:change==='disabled'?{enabled:false}:{externalAuthorId:'changed-author'}});};
  }) as any);
  await expect(caller.xiaohongshu.executeWholeCreatorReviewedAttempt(input)).rejects.toThrow();
  expect(api.mock.calls.length).toBe(0);expect(await db.xhsNote.count()).toBe(0);
  const rows=await db.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_whole_creator_jobs WHERE id='job'`;const job=JSON.parse(rows[0].document);
  expect(job.reviewAttempt.state).toBe('consumed');expect(job.sourceFence.state).toBe('started');
  expect((await db.$queryRaw<Array<{used:number}>>`SELECT used FROM xhs_request_budgets WHERE id='xhs:source-total'`)[0].used).toBe(9);
  await expect(caller.xiaohongshu.executeWholeCreatorReviewedAttempt(input)).rejects.toThrow();expect(api.mock.calls.length).toBe(0);
 });


 it.each(['armed','started','unknown'])('AUDIT: rejects an unrelated unresolved limited recovery in %s state',async state=>{
   await db.$executeRaw`INSERT INTO xhs_limited_recovery(id,note_id,author_id,owner,state,created_at,updated_at,expires_at) VALUES('single-round','another-note','another-author','old',${state},0,0,0)`;
   try{
     await expect(caller.xiaohongshu.executeWholeCreatorReviewedAttempt(input)).rejects.toThrow();
     expect(api).not.toHaveBeenCalled();
   }finally{await db.$executeRaw`DELETE FROM xhs_limited_recovery WHERE id='single-round'`;}
 });
 it('AUDIT: refuses a changed cumulative task budget before any network entry',async()=>{
   await db.$executeRaw`UPDATE xhs_request_budgets SET used=used+1 WHERE id='job'`;
   await expect(caller.xiaohongshu.executeWholeCreatorReviewedAttempt(input)).rejects.toThrow();
   expect(api).not.toHaveBeenCalled();
   expect((await whole.view('job')).reviewedRecovery?.state).toBe('prepared');
 });
 it('AUDIT: an expired attempt neither consumes nor refreshes itself',async()=>{
   const now=Date.now();jest.spyOn(Date,'now').mockReturnValue(now+901000);
   try{
     await expect(caller.xiaohongshu.executeWholeCreatorReviewedAttempt(input)).rejects.toThrow();
     await expect(caller.xiaohongshu.prepareWholeCreatorReviewedAttempt({jobId:'job',confirmUnknownRetry:true})).rejects.toThrow();
     expect(api).not.toHaveBeenCalled();
     expect((await whole.view('job')).reviewedRecovery?.state).toBe('expired');
     expect((await db.$queryRaw<Array<{used:number}>>`SELECT used FROM xhs_request_budgets WHERE id='job'`)[0].used).toBe(6);
   }finally{jest.restoreAllMocks();}
 });
 it('AUDIT: prepare rolls back its derived review when another recovery is unresolved',async()=>{
   await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=json_remove(document,'$.reviewAttempt','$.unknownReview') WHERE id='job'`;
   await db.$executeRaw`INSERT INTO xhs_limited_recovery(id,note_id,author_id,owner,state,created_at,updated_at,expires_at) VALUES('single-round','another-note','another-author','old','unknown',0,0,0)`;
   await expect(caller.xiaohongshu.prepareWholeCreatorReviewedAttempt({jobId:'job',confirmUnknownRetry:true})).rejects.toThrow();
   const saved=JSON.parse((await db.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_whole_creator_jobs WHERE id='job'`)[0].document);
   expect(saved.unknownReview).toBeUndefined();expect(saved.reviewAttempt).toBeUndefined();expect(api).not.toHaveBeenCalled();
 });
 it('AUDIT: rechecks unresolved recovery at physical transport entry after durable consumption',async()=>{
   const original=runtime.reviewedReadyCheck.bind(runtime);
   jest.spyOn(runtime,'reviewedReadyCheck').mockImplementation((()=>{
     const ready=original();let checks=0;
     return async()=>{ready();if(++checks===2)await db.$executeRaw`INSERT INTO xhs_limited_recovery(id,note_id,author_id,owner,state,created_at,updated_at,expires_at) VALUES('single-round','another-note','another-author','old','unknown',0,0,0)`;};
   }) as any);
   await expect(caller.xiaohongshu.executeWholeCreatorReviewedAttempt(input)).rejects.toThrow();
   expect(api).not.toHaveBeenCalled();
   const view=await whole.view('job');expect(view.reviewedRecovery?.state).toBe('consumed');
   expect((await db.$queryRaw<Array<{used:number}>>`SELECT used FROM xhs_request_budgets WHERE id='job'`)[0].used).toBe(7);
   await expect(caller.xiaohongshu.executeWholeCreatorReviewedAttempt(input)).rejects.toThrow();expect(api).not.toHaveBeenCalled();
 });
 it.each([true,false])('AUDIT: finished followup resolves only the exact original recovery identity: %s',async matches=>{
   await db.$executeRaw`INSERT INTO xhs_limited_recovery(id,note_id,author_id,owner,state,created_at,updated_at,expires_at) VALUES('single-round','another-note','another-author','old','unknown',0,0,0)`;
   await db.$executeRaw`INSERT INTO xhs_limited_recovery_append(id,note_id,author_id,owner,state,created_at,updated_at,expires_at) VALUES('single-round',${matches?'another-note':'wrong-note'},'another-author','followup','finished',0,0,0)`;
   if(matches){await expect(caller.xiaohongshu.executeWholeCreatorReviewedAttempt(input)).resolves.toMatchObject({body:'saved'});expect(api).toHaveBeenCalledTimes(1);}
   else{await expect(caller.xiaohongshu.executeWholeCreatorReviewedAttempt(input)).rejects.toThrow();expect(api).not.toHaveBeenCalled();}
 });
});
