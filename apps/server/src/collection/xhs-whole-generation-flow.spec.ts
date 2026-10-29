jest.mock('./xhs-legacy-review', () => ({ ...jest.requireActual('./xhs-legacy-review'), assertLegacyDatabase: jest.fn(async () => undefined) }));
jest.mock('./xhs-dispatch-owner-observation', () => ({ observeDispatchOwner: jest.fn(() => 'dead') }));
jest.mock('./xhs-dispatch-owner', () => ({
  createDispatchOwner: () => ({ pid:22, startIdentity:'638000000000000001', nonce:'00000000-0000-4000-8000-000000000002' }),
  ownsDispatch: (v:any,e:any) => !!v && !!e && v.nonce===e.nonce && v.pid===e.pid && v.startIdentity===e.startIdentity,
}));
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { mkdtemp, rm, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { splitSqliteStatements } from '../../../../scripts/sqlite-statements.cjs';
import { XhsWholeCreatorService } from './xhs-whole-creator.service';
import { XhsSubscriptionService } from './xhs-subscription.service';
import { XhsSubscriptionRuntime } from './xhs-subscription-runtime';
import { XhsEngagementService } from './xhs-engagement.service';
import { XhsSourceRiskStore } from './xhs-source-risk-store';
import { bindXhsSourceTotalBudget } from './xhs-source-request-policy';
import { legacyBudgetDigest } from './xhs-legacy-review';
import { createWholeGeneration } from './xhs-whole-generation';
import { prepareWholeSourceFence, markWholeSourceStarted, commitWholeSourceCheckpoint } from './xhs-whole-source-fence';

const hash = (v:unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
describe('whole creator generation through real runtime, policy and SQLite', () => {
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
  },40000);
  beforeEach(async()=>{
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
  });
  afterEach(async()=>{await drain();await whole.onModuleDestroy();await subscriptions.onModuleDestroy();runtime.onModuleDestroy();jest.restoreAllMocks();});
  afterAll(async()=>{await db.$disconnect();await rm(folder,{recursive:true,force:true});},40000);
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

  it('leaves ordinary homepage resolution fenced, including after a prepared generation',async()=>{
    await expect(runtime.resolve(input.profileUrl)).rejects.toThrow();
    await (whole as any).prepareGeneration(input);
    await expect(runtime.resolve(input.profileUrl)).rejects.toThrow();
    expect(api).not.toHaveBeenCalled();expect(shortLinks).not.toHaveBeenCalled();
    expect(await currentBudget()).toEqual([{id:'job',used:6},{id:'xhs:source-total',used:8}]);
    await assertUnknownPreserved();
  });
  it('chains approved homepage, profile, directory and body with legitimate list context and cumulative counts',async()=>{
    await (whole as any).prepareGeneration(input);expect(api).not.toHaveBeenCalled();expect(shortLinks).not.toHaveBeenCalled();
    await execute();await drain();const job=await read();
    expect(job.state).toBe('completed');expect(job.listEnd).toBe(true);
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
    const before=count;await expect(execute()).rejects.toThrow();expect(api.mock.calls.length+shortLinks.mock.calls.length).toBe(before);
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
  it('explicitly resumes the same generation after a known pre-dispatch interruption and skips durable first-note successes',async()=>{
    directory(['note','second']);let interrupted=false;
    const saves=jest.fn(async(_creator:any,id:string)=>{
      // The body/metrics transaction has already committed. Turning the source off here
      // leaves a durable local save receipt and stops the next note before dispatch.
      if(id===noteKey&&!interrupted){interrupted=true;live=false;}
      return {alreadySaved:false,mediaComplete:true,supplement:{status:'new'}};
    });
    subscriptions.bindLocalSaver(async()=>folder,saves);
    await (whole as any).prepareGeneration(input);const id=(await read()).generation.id;await execute(id);await drain();
    const paused=await read();expect(paused.state).toBe('paused');expect(paused.generation.activeFence).toBeUndefined();
    expect(paused.items[noteKey].archive).toBeGreaterThan(0);expect(paused.items[noteKey].metrics).toBeGreaterThan(0);
    expect(requestedDetails()).toEqual(['note']);const beforeBudget=await currentBudget();
    live=true;await execute(id);await drain();const completed=await read();
    expect(completed.state).toBe('completed');expect(completed.generation.id).toBe(id);
    expect(requestedDetails()).toEqual(['note','second']);
    expect(saves.mock.calls.map(args=>args[1])).toEqual([noteKey,JSON.stringify(['xiaohongshu','note','second'])]);
    expect(completed.items[noteKey].archive).toBe(paused.items[noteKey].archive);expect(completed.items[noteKey].metrics).toBe(paused.items[noteKey].metrics);
    expect(shortLinks).toHaveBeenCalledTimes(2);expect(api.mock.calls.filter(([r]:any[])=>new URL(r.url).pathname.endsWith('user_posted'))).toHaveLength(2);
    const afterBudget=await currentBudget();expect(afterBudget[0].used).toBeGreaterThan(beforeBudget[0].used);expect(afterBudget[1].used).toBeGreaterThan(beforeBudget[1].used);
    await assertUnknownPreserved();
  });
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
  });
  it('creates a current-directory child instead of resuming the old blocked archive selection',async()=>{
    const freshKey=JSON.stringify(['xiaohongshu','note','fresh']);
    await db.xhsNote.update({where:{id:noteKey},data:{status:'listed',contentHtml:'<p>old partial cache must remain</p>'}});
    await db.xhsNote.create({data:{id:freshKey,creatorId:'creator',title:'Fresh',publishTime:0,kind:'image-text',status:'listed'}});
    const old={taskId:'old-archive',creatorId:'creator',kind:'download',state:'blocked',noteIds:[noteKey,freshKey],items:{},directory:folder,
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
    const current=await read();expect(current.generation.missingIds).toContain(noteKey);expect(current.archiveTask).not.toBe('old-archive');
    expect(createChild).toHaveBeenCalledWith({creatorId:'creator',noteIds:[freshKey],sameDirectoryAsTaskId:'old-archive'});
    const child=JSON.parse((await db.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_subscription_tasks WHERE id=${current.archiveTask}`)[0].document);
    expect(child.noteIds).toEqual([freshKey]);expect(child.directory).toBe(folder);expect(saves).toHaveBeenCalledTimes(1);
    await assertUnknownPreserved();
  });
  it('rebuilds the child selection when a second approved directory drops an unfinished note',async()=>{
    const doneKey=JSON.stringify(['xiaohongshu','note','a-done']),missingKey=JSON.stringify(['xiaohongshu','note','b-missing']),freshKey=JSON.stringify(['xiaohongshu','note','c-fresh']);
    directory(['a-done','b-missing','c-fresh']);let interrupted=false;
    const saves=jest.fn(async(_creator:any,id:string)=>{
      if(id===doneKey&&!interrupted){interrupted=true;live=false;}
      return {alreadySaved:false,mediaComplete:true,supplement:{status:'new'}};
    });
    subscriptions.bindLocalSaver(async()=>folder,saves);
    const createChild=jest.spyOn(subscriptions,'downloadNotes');
    await (whole as any).prepareGeneration(input);const generationId=(await read()).generation.id;
    await execute(generationId);await drain();const paused=await read();
    expect(paused.state).toBe('paused');expect(paused.generation.activeFence).toBeUndefined();expect(requestedDetails()).toEqual(['a-done']);
    expect(paused.items[doneKey].archive).toBeGreaterThan(0);expect(paused.items[doneKey].metrics).toBeGreaterThan(0);
    const oldChildRaw=(await db.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_subscription_tasks WHERE id=${paused.archiveTask}`)[0].document;
    // The omitted note retains its first-run access context, so old noteIds would
    // really dispatch it; this is not a token-absence or mocked service shortcut.
    directory(['a-done','c-fresh']);live=true;
    await execute(generationId);await drain();const current=await read();
    expect(requestedDetails()).toEqual(['a-done','c-fresh']);
    expect(current.generation.directoryIds).toEqual([doneKey,freshKey]);expect(current.generation.missingIds).toContain(missingKey);
    expect(current.items[doneKey].archive).toBe(paused.items[doneKey].archive);expect(current.items[doneKey].metrics).toBe(paused.items[doneKey].metrics);
    expect((await db.xhsNote.findUnique({where:{id:missingKey}}))?.status).toBe('listed');
    expect(await db.xhsMetricSnapshot.count({where:{ownerKind:'note',ownerId:missingKey}})).toBe(0);
    expect((await db.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_subscription_tasks WHERE id=${paused.archiveTask}`)[0].document).toBe(oldChildRaw);
    expect(createChild).toHaveBeenLastCalledWith({creatorId:'creator',noteIds:[freshKey],sameDirectoryAsTaskId:paused.archiveTask});
    expect(saves.mock.calls.map(args=>args[1])).toEqual([doneKey,freshKey]);
    await assertUnknownPreserved();
  });
});
