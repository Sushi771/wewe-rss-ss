import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { splitSqliteStatements } from '../../../../scripts/sqlite-statements.cjs';
import { XhsSourceRiskStore } from './xhs-source-risk-store';
import { XhsSubscriptionRuntime } from './xhs-subscription-runtime';
import { XhsRequestBudget } from './xhs-request-budget';
import { XhsSubscriptionError } from './xhs-subscription-errors';
import { XhsMediaError } from './xhs-media-error';
import { downloadRedbookMedia } from './redbook-response';
import { bindXhsSourceTotalBudget } from './xhs-source-request-policy';
import { XhsSubscriptionService } from './xhs-subscription.service';
import { XhsEngagementService } from './xhs-engagement.service';
import { XhsScheduledRunner } from './xhs-scheduled-runner';
import { extractXhsMediaManifest } from './xhs-native-media';
import { scheduledTaskId } from './xhs-scheduled-admission';
import { RedbookPauseError } from './redbook-client';

describe('durable synthetic source risk fence', () => {
  let db: PrismaClient, folder: string;
  beforeAll(async () => {
    folder = await fs.mkdtemp(path.join(os.tmpdir(), 'xhs-risk-synthetic-'));
    db = new PrismaClient({
      datasources: {
        db: {
          url: 'file:' + path.join(folder, 'risk.sqlite').replace(/\\/g, '/'),
        },
      },
    });
    const migrations = path.resolve(__dirname, '../../prisma/migrations');
    for (const name of (await fs.readdir(migrations)).sort()) {
      if (!(await fs.stat(path.join(migrations, name))).isDirectory()) continue;
      for (const sql of splitSqliteStatements(
        await fs.readFile(path.join(migrations, name, 'migration.sql'), 'utf8'),
      ))
        await db.$executeRawUnsafe(sql);
    }
  }, 40000);
  afterEach(async () => {
    await db.$executeRaw`UPDATE xhs_source_risk SET state='clear',code=NULL,owner=NULL,http_status=NULL,endpoint=NULL,updated_at=0 WHERE id='source'`;
    const scoped=await db.$queryRaw<Array<{id:string}>>`SELECT id FROM xhs_creators WHERE id='creator-a'`;
    if(scoped.length){await db.$executeRaw`DELETE FROM xhs_request_budgets WHERE id='xhs:source-total' OR id LIKE 'xhs:dispatch-pending:unknown:%'`;await db.$executeRaw`DELETE FROM xhs_subscription_tasks WHERE id IN ('task-a','task-a2','task-b','task-c','task-d')`;await db.$executeRaw`DELETE FROM xhs_creators WHERE id IN ('creator-a','creator-b','creator-c','creator-d')`;}
    const mediaScoped=await db.$queryRaw<Array<{id:string}>>`SELECT id FROM xhs_creators WHERE id='media-creator-a'`;
    if(mediaScoped.length){await db.$executeRaw`DELETE FROM xhs_request_budgets WHERE id='xhs:source-total' OR id LIKE 'xhs:dispatch-pending:unknown:%'`;await db.$executeRaw`DELETE FROM xhs_subscription_tasks WHERE creator_id IN ('media-creator-a','media-creator-b')`;await db.$executeRaw`DELETE FROM xhs_notes WHERE creator_id IN ('media-creator-a','media-creator-b')`;await db.$executeRaw`DELETE FROM xhs_creators WHERE id IN ('media-creator-a','media-creator-b')`;}
    const parseScoped=await db.$queryRaw<Array<{id:string}>>`SELECT id FROM xhs_creators WHERE id='parse-creator'`;
    if(parseScoped.length){await db.$executeRaw`DELETE FROM xhs_request_budgets WHERE id='xhs:source-total' OR id LIKE 'xhs:dispatch-pending:unknown:%'`;await db.$executeRaw`DELETE FROM xhs_metric_snapshots WHERE owner_id IN (${JSON.stringify(['xiaohongshu','note','parse-a'])},${JSON.stringify(['xiaohongshu','note','parse-b'])})`;await db.$executeRaw`DELETE FROM xhs_subscription_tasks WHERE creator_id='parse-creator'`;await db.$executeRaw`DELETE FROM xhs_notes WHERE creator_id='parse-creator'`;await db.$executeRaw`DELETE FROM xhs_creators WHERE id='parse-creator'`;}
  });
  afterAll(async () => {
    await db.$disconnect();
    await fs.rm(folder, { recursive: true, force: true });
  }, 40000);

  it.each(['parse','transport','budget'] as const)('keeps source risk conservative for %s list failures',async(mode)=>{
    const api=jest.fn(async(request:any):Promise<any>=>{if(mode==='transport')throw Error('synthetic-private-transport');return {status:200,url:request.url,body:{success:true,code:0,data:{notes:'synthetic-private-body',has_more:false,cursor:''}}};});
    const runtime=new XhsSubscriptionRuntime({enabled:()=>true,api,requirePersistentRisk:true});runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    if(mode==='budget')runtime.bindSourceAdmission(async()=>{throw new XhsSubscriptionError('XHS_REQUEST_BUDGET_EXHAUSTED');});
    await runtime.connectSession({a1:'synthetic-a1',webSession:'synthetic-session'});(runtime as any).adapter.restoreDefaultAuthorAccess('synthetic-author');
    const expected=mode==='parse'?'XHS_LIST_PARSE_FAILED':mode==='transport'?'transport':'XHS_REQUEST_BUDGET_EXHAUSTED';
    await expect(runtime.list('synthetic-author',null)).rejects.toThrow(expected);
    const rows=await db.$queryRaw<Array<{state:string;code:string|null;http_status:number|null;endpoint:string|null}>>`SELECT state,code,http_status,endpoint FROM xhs_source_risk WHERE id='source'`;
    expect(rows[0]).toMatchObject(mode==='budget'||mode==='parse'?{state:'clear',code:null}:{state:'blocked',code:'XHS_SOURCE_RISK_REVIEW_REQUIRED',http_status:null,endpoint:null});
    expect(JSON.stringify(rows)).not.toContain('synthetic-private');expect(api).toHaveBeenCalledTimes(mode==='budget'?0:1);
    if(mode==='parse'){
      api.mockImplementationOnce(async(request:any)=>({status:200,url:request.url,body:{success:true,code:0,data:{notes:[],has_more:false,cursor:''}}}));
      (runtime as any).adapter.restoreDefaultAuthorAccess('other-author');await expect(runtime.list('other-author',null)).resolves.toMatchObject({authorId:'other-author',notes:[]});expect(api).toHaveBeenCalledTimes(2);
    }
    runtime.onModuleDestroy();
  },20000);
  it('keeps missing list author identity unknown and blocks subsequent dispatch',async()=>{
    const api=jest.fn(async(request:any)=>({status:200,url:request.url,body:{success:true,code:0,data:{notes:[{note_id:'note',user:{},xsec_token:'synthetic'}],has_more:false,cursor:''}}}));
    const runtime=new XhsSubscriptionRuntime({enabled:()=>true,api,requirePersistentRisk:true});runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    await runtime.connectSession({a1:'synthetic-a1',webSession:'synthetic-session'});(runtime as any).adapter.restoreDefaultAuthorAccess('synthetic-author');
    await expect(runtime.list('synthetic-author',null)).rejects.not.toMatchObject({code:'XHS_LIST_PARSE_FAILED'});
    const rows=await db.$queryRaw<Array<{state:string;code:string}>>`SELECT state,code FROM xhs_source_risk WHERE id='source'`;
    expect(rows[0]).toMatchObject({state:'blocked',code:'XHS_SOURCE_RISK_REVIEW_REQUIRED'});await expect(runtime.list('synthetic-author',null)).rejects.toThrow();expect(api).toHaveBeenCalledTimes(1);runtime.onModuleDestroy();
  },20000);
  it('keeps a 200 HTML media response unknown and blocks a second account dispatch',async()=>{
    const media=jest.fn(async()=>new Response('<html>verification</html>',{status:200,headers:{'content-type':'image/png'}}));
    const runtime=new XhsSubscriptionRuntime({enabled:()=>true,media,requirePersistentRisk:true});runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    await runtime.connectSession({a1:'synthetic-a1',webSession:'synthetic-session'});
    const run=()=>runtime.withScheduledMediaSession(transport=>downloadRedbookMedia(new URL('https://sns-webpic.xhscdn.com/synthetic.png'),1000000,transport));
    await expect(run()).rejects.toThrow('XHS_MEDIA_RESPONSE_INVALID');const rows=await db.$queryRaw<Array<{state:string;code:string}>>`SELECT state,code FROM xhs_source_risk WHERE id='source'`;
    expect(rows[0]).toMatchObject({state:'blocked',code:'XHS_SOURCE_RISK_REVIEW_REQUIRED'});await expect(run()).rejects.toThrow();expect(media).toHaveBeenCalledTimes(1);expect(JSON.stringify(rows)).not.toContain('verification');runtime.onModuleDestroy();
  },20000);
  it.each(['parse','unknown'] as const)('keeps a %s detail incomplete and saves the next detail using the real runtime',async(mode)=>{
    const creatorId='parse-creator',author='parse-author',keys=['parse-a','parse-b'].map(n=>JSON.stringify(['xiaohongshu','note',n]));
    await db.xhsCreator.create({data:{id:creatorId,externalAuthorId:author,profileUrl:'https://example.invalid/parse-author',displayName:'Synthetic'}});
    for(const id of keys)await db.xhsNote.create({data:{id,creatorId,title:'Old',publishTime:0,kind:'image-text',status:'listed'}});
    const task:any={taskId:'parse-task',creatorId,kind:'list',state:'queued',collectionStage:'details',collectDetails:true,basicOnly:true,reuseCompleteCache:false,noteIds:keys,items:{},total:2,completed:0,skipped:0,failed:0,remaining:2};
    await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES('parse-task',${creatorId},'queued',${JSON.stringify(task)},1)`;
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,0) ON CONFLICT(id) DO UPDATE SET request_limit=100,used=0,next_at=0,interval_ms=0`;
    const api=jest.fn(async(request:any)=>{const note=JSON.parse(request.body).source_note_id;if(note==='parse-a'&&mode==='unknown')throw Error('synthetic detail connection lost');return {status:200,url:request.url,body:{success:true,code:0,data:{items:[{id:note,note_card:{note_id:note,user:{user_id:author},type:note==='parse-a'?'unrecognized':'normal',time:1760000000000,title:'New',desc:'saved body',image_list:[],interact_info:{liked_count:'0',comment_count:'0'}}}]}}};});
    const runtime=new XhsSubscriptionRuntime({enabled:()=>true,api,requirePersistentRisk:true});runtime.bindRiskStore(new XhsSourceRiskStore(db as any));bindXhsSourceTotalBudget(db as any,runtime);await runtime.connectSession({a1:'synthetic-a1',webSession:'synthetic-session'});
    for(const note of ['parse-a','parse-b'])(runtime as any).adapter.tokens.set(JSON.stringify([author,note]),{token:'synthetic-token',source:'pc_user',expiresAt:Date.now()+60000});
    const service:any=new XhsSubscriptionService(db as any,runtime);service.write=async(_bytes:number,fn:any)=>db.$transaction(fn);await service.run(task);
    expect(api).toHaveBeenCalledTimes(2);expect(task).toMatchObject({state:'partial',failed:1,completed:1,code:mode==='parse'?'XHS_DETAIL_PARSE_FAILED':'XHS_DETAIL_OUTCOME_UNKNOWN',items:{[keys[0]]:'failed',[keys[1]]:'completed'},basicResults:{[keys[0]]:'missing'}});
    const notes=await db.xhsNote.findMany({where:{creatorId},orderBy:{id:'asc'}});expect(notes[0].contentHtml).toBeNull();expect(notes[1].contentHtml).toContain('saved body');const risk=await db.$queryRaw<any[]>`SELECT state FROM xhs_source_risk WHERE id='source'`;expect(risk[0].state).toBe('clear');
    const metrics=await db.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_metric_snapshots WHERE owner_kind='note' AND owner_id=${keys[1]}`;expect(JSON.parse(metrics[0].document).values).toMatchObject({likes:0,comments:0,collects:null,shares:null});
    if(mode==='unknown'){const next={...task,taskId:'parse-task-2',state:'queued',noteIds:[keys[0]],items:{},basicResults:{},total:1,completed:0,skipped:0,failed:0,remaining:1,code:undefined};await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES('parse-task-2',${creatorId},'queued',${JSON.stringify(next)},1)`;await service.run(next);expect(next).toMatchObject({state:'partial',failed:1,code:'XHS_DETAIL_OUTCOME_UNKNOWN'});expect(api).toHaveBeenCalledTimes(2);}
    runtime.onModuleDestroy();
  },40000);
  it('isolates a durable unknown list request across accounts and never replays it after restart',async()=>{
    const people=[['task-a','creator-a','author-a'],['task-b','creator-b','author-b'],['task-c','creator-c','author-c'],['task-d','creator-d','author-d']];
    for(const [taskId,creatorId,authorId] of people){await db.xhsCreator.create({data:{id:creatorId,externalAuthorId:authorId,profileUrl:`https://example.invalid/${authorId}`,displayName:'Synthetic'}});const doc=JSON.stringify({taskId,creatorId,state:'running',noteIds:[]});await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES(${taskId},${creatorId},'running',${doc},1)`;}
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,0) ON CONFLICT(id) DO UPDATE SET request_limit=100,used=0,next_at=0,interval_ms=0`;
    const api=jest.fn(async(request:any):Promise<any>=>{const author=new URL(request.url).searchParams.get('user_id');if(author==='author-a')throw Error('synthetic transport lost');if(author==='author-c')return {status:461,url:request.url,body:{}};return {status:200,url:request.url,body:{success:true,code:0,data:{notes:[],has_more:false,cursor:''}}};});
    const connect=async()=>{const runtime=new XhsSubscriptionRuntime({enabled:()=>true,api,requirePersistentRisk:true});runtime.bindRiskStore(new XhsSourceRiskStore(db as any));bindXhsSourceTotalBudget(db as any,runtime);await runtime.connectSession({a1:'synthetic-a1',webSession:'synthetic-session'});for(const [, ,author] of people)(runtime as any).adapter.restoreDefaultAuthorAccess(author);return runtime;};
    const call=(runtime:XhsSubscriptionRuntime,i:number)=>runtime.withTaskScope({taskId:people[i][0],creatorId:people[i][1]},()=>runtime.list(people[i][2],null));
    let runtime=await connect();await expect(call(runtime,0)).rejects.toThrow();expect(api).toHaveBeenCalledTimes(1);
    const risk=await db.$queryRaw<any[]>`SELECT state,code FROM xhs_source_risk WHERE id='source'`;expect(risk[0]).toMatchObject({state:'clear',code:null});
    const saved=await db.$queryRaw<any[]>`SELECT document FROM xhs_subscription_tasks WHERE id='task-a'`;const item=JSON.parse(saved[0].document).sourceUnknowns[0];expect(item.outcome).toBe('unknown');expect(item.marker).toMatch(/^xhs:dispatch-pending:unknown:[a-f0-9]{64}$/);expect(saved[0].document).not.toContain('synthetic transport');
    const service:any=new XhsSubscriptionService(db as any,runtime);service.write=async(_bytes:number,fn:any)=>db.$transaction(fn);await service.persist({taskId:'task-a',creatorId:'creator-a',state:'running',noteIds:[]});
    const afterStale=await db.$queryRaw<any[]>`SELECT document FROM xhs_subscription_tasks WHERE id='task-a'`;const savedTask=JSON.parse(afterStale[0].document);expect(savedTask.sourceUnknowns).toEqual([item]);expect(service.view({...savedTask,kind:'list',state:'blocked',total:1,completed:0,skipped:0}).resumable).toBe(false);
    runtime.onModuleDestroy();runtime=await connect();await expect(call(runtime,0)).rejects.toThrow();expect(api).toHaveBeenCalledTimes(1);
    const resumed=JSON.stringify({taskId:'task-a2',creatorId:'creator-a',state:'running',noteIds:[]});await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES('task-a2','creator-a','running',${resumed},1)`;
    await expect(runtime.withTaskScope({taskId:'task-a2',creatorId:'creator-a'},()=>runtime.list('author-a',null))).rejects.toThrow();expect(api).toHaveBeenCalledTimes(1);
    await expect(call(runtime,1)).resolves.toMatchObject({authorId:'author-b',notes:[]});expect(api).toHaveBeenCalledTimes(2);
    await expect(call(runtime,2)).rejects.toThrow();const after=await db.$queryRaw<any[]>`SELECT state,code,http_status FROM xhs_source_risk WHERE id='source'`;expect(after[0]).toMatchObject({state:'blocked',code:'XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED',http_status:461});
    await expect(call(runtime,3)).rejects.toThrow();expect(api).toHaveBeenCalledTimes(3);runtime.onModuleDestroy();
  },40000);
  it.each(['comments','replies','parse'] as const)('isolates a scheduled %s failure and continues another creator without replay',async(mode)=>{
    const round='2026-11-01/09:15',records:Array<{creator:string;author:string;note:string;key:string;task:string}>=[];
    try {
      for(const label of ['a','b','c','d']){
        const creator=`comment-creator-${label}`,author=`comment-author-${label}`,note=`comment-note-${label}`,key=JSON.stringify(['xiaohongshu','note',note]),task=scheduledTaskId(round,creator,'basic');
        await db.xhsCreator.create({data:{id:creator,externalAuthorId:author,profileUrl:`https://example.invalid/${author}`,displayName:'Synthetic'}});
        await db.xhsNote.create({data:{id:key,creatorId:creator,title:'Synthetic',publishTime:1,kind:'image-text',status:'complete'}});
        const doc={taskId:task,creatorId:creator,state:'completed',schedule:{round,phase:'basic'},noteIds:[key],failed:0};
        await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES(${task},${creator},'completed',${JSON.stringify(doc)},1)`;
        records.push({creator,author,note,key,task});
      }
      await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,0) ON CONFLICT(id) DO UPDATE SET request_limit=100,used=0,next_at=0,interval_ms=0`;
      const api=jest.fn(async(request:any):Promise<any>=>{const url=new URL(request.url),note=url.searchParams.get('note_id'),sub=url.pathname.endsWith('/sub/page');if(note===records[0].note&&(mode==='comments'||(mode==='replies'&&sub)))throw Error('synthetic lost');if(note===records[0].note&&mode==='parse')return {status:200,url:request.url,body:{success:true,code:0,data:{comments:[{id:null}],has_more:false,cursor:''}}};if(note===records[2].note)return {status:461,url:request.url,body:{}};const comments=note===records[0].note?[{id:'root',content:'text',like_count:'0',user_info:{user_id:'synthetic',nickname:'Synthetic'}}]:[];return {status:200,url:request.url,body:{success:true,code:0,data:{comments,has_more:false,cursor:''}}};});
      const connect=async()=>{const runtime=new XhsSubscriptionRuntime({enabled:()=>true,commentsEnabled:()=>true,api,requirePersistentRisk:true});runtime.bindRiskStore(new XhsSourceRiskStore(db as any));bindXhsSourceTotalBudget(db as any,runtime);await runtime.connectSession({a1:'synthetic-a1',webSession:'synthetic-session'});for(const r of records)(runtime as any).adapter.tokens.set(JSON.stringify([r.author,r.note]),{token:'synthetic-token',source:'pc_user',expiresAt:Date.now()+60000});return runtime;};
      let runtime=await connect(),svc:any=new XhsEngagementService(db as any,runtime);svc.write=async(fn:any)=>db.$transaction(fn);
      expect(await svc.collectScheduled(round,records[0].creator)).toMatchObject({incomplete:true});const firstCalls=mode==='replies'?2:1;expect(api).toHaveBeenCalledTimes(firstCalls);
      const firstTask=await db.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_subscription_tasks WHERE id=${records[0].task}`;expect(JSON.parse(firstTask[0].document).commentSummary).toMatchObject(mode==='parse'?{failedNotes:1,unknownNotes:0}:{failedNotes:0,unknownNotes:1});
      let risk=await db.$queryRaw<any[]>`SELECT state,code FROM xhs_source_risk WHERE id='source'`;expect(risk[0]).toMatchObject({state:'clear',code:null});
      runtime.onModuleDestroy();runtime=await connect();svc=new XhsEngagementService(db as any,runtime);svc.write=async(fn:any)=>db.$transaction(fn);
      expect(await svc.collectScheduled(round,records[0].creator)).toMatchObject({incomplete:true});expect(api).toHaveBeenCalledTimes(firstCalls);
      expect(await svc.collectScheduled(round,records[1].creator)).toEqual({pending:false,incomplete:false});expect(api).toHaveBeenCalledTimes(firstCalls+1);
      const used=await db.$queryRaw<Array<{used:number}>>`SELECT used FROM xhs_request_budgets WHERE id='xhs:source-total'`;expect(used[0].used).toBe(firstCalls+1);
      const otherRuntime=await connect(),otherSvc:any=new XhsEngagementService(db as any,otherRuntime);otherSvc.write=async(fn:any)=>db.$transaction(fn);
      expect(await svc.collectScheduled(round,records[2].creator)).toMatchObject({incomplete:true});risk=await db.$queryRaw<any[]>`SELECT state,code,http_status FROM xhs_source_risk WHERE id='source'`;expect(risk[0]).toMatchObject({state:'blocked',code:'XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED',http_status:461});expect(api).toHaveBeenCalledTimes(firstCalls+2);
      expect(await otherSvc.collectScheduled(round,records[3].creator)).toMatchObject({incomplete:true});expect(api).toHaveBeenCalledTimes(firstCalls+2);
      const neverSent=await db.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_comment_windows WHERE note_id=${records[3].key} AND scope='top'`;expect(neverSent.length).toBe(1);expect(JSON.parse(neverSent[0].document).pendingDispatch).toBeUndefined();otherRuntime.onModuleDestroy();runtime.onModuleDestroy();
    } finally {
      await db.$executeRaw`DELETE FROM xhs_request_budgets WHERE id='xhs:source-total' OR id LIKE 'xhs:dispatch-pending:unknown:%'`;
      for(const r of records){await db.$executeRaw`DELETE FROM xhs_subscription_tasks WHERE id=${r.task}`;await db.xhsNote.deleteMany({where:{creatorId:r.creator}});await db.xhsCreator.deleteMany({where:{id:r.creator}});}
    }
  },40000);
  it('resumes context rehydration after a known pre-dispatch busy page without repeating confirmed pages',async()=>{
    const runtime=new XhsSubscriptionRuntime({enabled:()=>true,api:jest.fn(),requirePersistentRisk:true});runtime.bindRiskStore(new XhsSourceRiskStore(db as any));bindXhsSourceTotalBudget(db as any,runtime);await runtime.connectSession({a1:'synthetic',webSession:'synthetic'});
    const cursors:(string|null)[]=[];let busy=true;
    (runtime as any).adapter.list=jest.fn(async(_author:string,cursor:string|null)=>{cursors.push(cursor);if(cursor==='second'&&busy){busy=false;throw new XhsSubscriptionError('XHS_REQUEST_RATE_PAUSED');}return {notes:[],nextCursor:null};});
    const work=()=>runtime.withTaskScope({taskId:'synthetic-rebuild',creatorId:'synthetic'},()=>runtime.restoreScheduledNoteContexts('author',[null,'second']));
    await expect(work()).rejects.toMatchObject({code:'XHS_REQUEST_RATE_PAUSED'});await expect(work()).resolves.toBeUndefined();
    expect(cursors).toEqual([null,'second','second']);runtime.onModuleDestroy();
  },40000);
  it.each(['success','unknown'])('rehydrates only checkpointed list pages after restart, with %s protected from replay',async(mode)=>{
    const creator='rehydrate-creator',author='rehydrate-author',note='rehydrate-note',key=JSON.stringify(['xiaohongshu','note',note]),round='2026-11-01/14:00',taskId=scheduledTaskId(round,creator,'basic');
    try {
      await db.xhsCreator.create({data:{id:creator,externalAuthorId:author,profileUrl:'https://example.invalid/rehydrate',displayName:'Synthetic'}});
      await db.xhsNote.create({data:{id:key,creatorId:creator,title:'Synthetic',publishTime:1,kind:'image-text',status:'complete'}});
      const doc={taskId,creatorId:creator,state:'completed',schedule:{round,phase:'basic'},noteIds:[key],failed:0,listFinished:true,cursorHistory:[null]};
      await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES(${taskId},${creator},'completed',${JSON.stringify(doc)},1)`;
      const window={scope:'top',nextCursor:'next',pages:1,state:'partial',code:null,collectedAt:1,cursors:[''],scheduledRound:round};
      await db.$executeRaw`INSERT INTO xhs_comment_windows(note_id,scope,document) VALUES(${key},'top',${JSON.stringify(window)})`;
      await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,0) ON CONFLICT(id) DO UPDATE SET request_limit=100,used=0,next_at=0,interval_ms=0`;
      const api=jest.fn(async(request:any):Promise<any>=>{const url=new URL(request.url);if(url.pathname.endsWith('/user_posted')){if(mode==='unknown')throw Error('synthetic lost');return {status:200,url:request.url,body:{success:true,code:0,data:{notes:[{note_id:note,user:{user_id:author},xsec_token:'synthetic-token'}],has_more:false,cursor:''}}};}return {status:200,url:request.url,body:{success:true,code:0,data:{comments:[],has_more:false,cursor:''}}};});
      const connect=async()=>{const runtime=new XhsSubscriptionRuntime({enabled:()=>true,commentsEnabled:()=>true,api,requirePersistentRisk:true});runtime.bindRiskStore(new XhsSourceRiskStore(db as any));bindXhsSourceTotalBudget(db as any,runtime);await runtime.connectSession({a1:'synthetic-a1',webSession:'synthetic-session'});const svc:any=new XhsEngagementService(db as any,runtime);svc.write=async(fn:any)=>db.$transaction(fn);return {runtime,svc};};
      let {runtime,svc}=await connect();const result=await svc.collectScheduled(round,creator);
      expect(result.incomplete).toBe(mode==='unknown');expect(api).toHaveBeenCalledTimes(mode==='unknown'?1:2);runtime.onModuleDestroy();
      ({runtime,svc}=await connect());const again=await svc.collectScheduled(round,creator);expect(again.incomplete).toBe(mode==='unknown');expect(api).toHaveBeenCalledTimes(mode==='unknown'?1:2);
      if(mode==='success'){await expect(runtime.withTaskScope({taskId,creatorId:creator},()=>runtime.restoreScheduledNoteContexts(author,['not-checkpointed']))).rejects.toThrow();expect(api).toHaveBeenCalledTimes(2);}
      const used=await db.$queryRaw<Array<{used:number}>>`SELECT used FROM xhs_request_budgets WHERE id='xhs:source-total'`;expect(used[0].used).toBe(mode==='unknown'?1:2);runtime.onModuleDestroy();
    } finally {await db.$executeRaw`DELETE FROM xhs_request_budgets WHERE id='xhs:source-total' OR id LIKE 'xhs:dispatch-pending:unknown:%'`;await db.$executeRaw`DELETE FROM xhs_subscription_tasks WHERE id=${taskId}`;await db.xhsNote.deleteMany({where:{creatorId:creator}});await db.xhsCreator.deleteMany({where:{id:creator}});}
  },40000);
  it('isolates a manual comment unknown and permits another creator without replay',async()=>{
    const records:Array<{creator:string;author:string;note:string;key:string}>=[];
    try {
      for(const label of ['a','b']){const creator=`manual-creator-${label}`,author=`manual-author-${label}`,note=`manual-note-${label}`,key=JSON.stringify(['xiaohongshu','note',note]);await db.xhsCreator.create({data:{id:creator,externalAuthorId:author,profileUrl:`https://example.invalid/${author}`,displayName:'Synthetic'}});await db.xhsNote.create({data:{id:key,creatorId:creator,title:'Synthetic',publishTime:1,kind:'image-text',status:'complete'}});records.push({creator,author,note,key});}
      await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,0) ON CONFLICT(id) DO UPDATE SET request_limit=100,used=0,next_at=0,interval_ms=0`;
      const api=jest.fn(async(request:any):Promise<any>=>{const note=new URL(request.url).searchParams.get('note_id');if(note===records[0].note)throw Error('synthetic lost');return {status:200,url:request.url,body:{success:true,code:0,data:{comments:[],has_more:false,cursor:''}}};});
      const runtime=new XhsSubscriptionRuntime({enabled:()=>true,commentsEnabled:()=>true,api,requirePersistentRisk:true});runtime.bindRiskStore(new XhsSourceRiskStore(db as any));bindXhsSourceTotalBudget(db as any,runtime);await runtime.connectSession({a1:'synthetic-a1',webSession:'synthetic-session'});
      for(const r of records)(runtime as any).adapter.tokens.set(JSON.stringify([r.author,r.note]),{token:'synthetic-token',source:'pc_user',expiresAt:Date.now()+60000});
      const svc:any=new XhsEngagementService(db as any,runtime);svc.write=async(fn:any)=>db.$transaction(fn);
      const request=(r:typeof records[number])=>({creatorId:r.creator,noteId:r.key,maxPages:1,maxItems:200});
      expect((await svc.collect(request(records[0]))).windows[0].state).toBe('failed');expect(api).toHaveBeenCalledTimes(1);
      const risk=await db.$queryRaw<any[]>`SELECT state,code FROM xhs_source_risk WHERE id='source'`;expect(risk[0]).toMatchObject({state:'clear',code:null});
      await expect(svc.collect(request(records[0]))).rejects.toThrow('XHS_COMMENT_RECEIPT_UNCERTAIN');expect(api).toHaveBeenCalledTimes(1);
      expect((await svc.collect(request(records[1]))).windows[0].state).toBe('returned-end');expect(api).toHaveBeenCalledTimes(2);runtime.onModuleDestroy();
    } finally {await db.$executeRaw`DELETE FROM xhs_request_budgets WHERE id='xhs:source-total' OR id LIKE 'xhs:dispatch-pending:unknown:%'`;for(const r of records){await db.$executeRaw`DELETE FROM xhs_subscription_tasks WHERE creator_id=${r.creator}`;await db.xhsNote.deleteMany({where:{creatorId:r.creator}});await db.xhsCreator.deleteMany({where:{id:r.creator}});}}
  },40000);
  it('runs scheduled comments and replies for two creators through the real runtime and SQLite',async()=>{
    const round='2026-11-01/14:00',records:Array<{creator:string;author:string;note:string;key:string;task:string}>=[];
    try {
      for(const label of ['a','b']){
        const creator=`integration-creator-${label}`,author=`integration-author-${label}`,note=`integration-note-${label}`,key=JSON.stringify(['xiaohongshu','note',note]),task=scheduledTaskId(round,creator,'basic');
        await db.xhsCreator.create({data:{id:creator,externalAuthorId:author,profileUrl:`https://example.invalid/${author}`,displayName:'Synthetic'}});
        await db.xhsNote.create({data:{id:key,creatorId:creator,title:'Synthetic',publishTime:1,kind:'image-text',status:'complete'}});
        const doc={taskId:task,creatorId:creator,state:'completed',schedule:{round,phase:'basic'},noteIds:[key],failed:0};
        await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES(${task},${creator},'completed',${JSON.stringify(doc)},1)`;records.push({creator,author,note,key,task});
      }
      await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,0) ON CONFLICT(id) DO UPDATE SET request_limit=100,used=0,next_at=0,interval_ms=0`;
      const api=jest.fn(async(request:any)=>{const u=new URL(request.url),reply=u.pathname.endsWith('/sub/page'),item={id:reply?'reply':'root',content:'synthetic',like_count:'0',user_info:{user_id:'synthetic',nickname:'Synthetic'}};return {status:200,url:request.url,body:{success:true,code:0,data:{comments:[item],has_more:false,cursor:''}}};});
      const runtime=new XhsSubscriptionRuntime({enabled:()=>true,commentsEnabled:()=>true,api,requirePersistentRisk:true});runtime.bindRiskStore(new XhsSourceRiskStore(db as any));bindXhsSourceTotalBudget(db as any,runtime);await runtime.connectSession({a1:'synthetic-a1',webSession:'synthetic-session'});
      for(const r of records)(runtime as any).adapter.tokens.set(JSON.stringify([r.author,r.note]),{token:'synthetic-token',source:'pc_user',expiresAt:Date.now()+60000});
      const engagement:any=new XhsEngagementService(db as any,runtime);engagement.write=async(fn:any)=>db.$transaction(fn);
      const service={scheduleCreatorPhase:async(input:{creatorId:string;phase:'basic'|'media'})=>input.phase==='basic'?{taskId:records.find(r=>r.creator===input.creatorId)!.task}:{state:'nothing-to-archive'},task:async()=>({state:'completed',failed:0,remaining:0})};
      const runner=new XhsScheduledRunner(db as any,service,engagement);await runner.run(round);expect(api).toHaveBeenCalledTimes(4);await runner.run(round);expect(api).toHaveBeenCalledTimes(4);
      for(const r of records){const view=await engagement.view({creatorId:r.creator,noteId:r.key});expect(view.totalSaved).toBe(2);expect(view.comments.find((c:any)=>c.id==='reply')?.rootId).toBe('root');}
      runtime.onModuleDestroy();
    } finally {await db.$executeRaw`DELETE FROM xhs_request_budgets WHERE id='xhs:source-total' OR id LIKE 'xhs:dispatch-pending:unknown:%'`;for(const r of records){await db.$executeRaw`DELETE FROM xhs_subscription_tasks WHERE id=${r.task}`;await db.xhsNote.deleteMany({where:{creatorId:r.creator}});await db.xhsCreator.deleteMany({where:{id:r.creator}});}}
  },40000);
  it('does not isolate a received but untrusted API response as a transport unknown',async()=>{
    for(const [taskId,creatorId,author] of [['task-a','creator-a','author-a'],['task-b','creator-b','author-b']]){await db.xhsCreator.create({data:{id:creatorId,externalAuthorId:author,profileUrl:`https://example.invalid/${author}`,displayName:'Synthetic'}});const doc=JSON.stringify({taskId,creatorId,state:'running',noteIds:[]});await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES(${taskId},${creatorId},'running',${doc},1)`;}
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,0) ON CONFLICT(id) DO UPDATE SET request_limit=100,used=0,next_at=0,interval_ms=0`;
    const api=jest.fn(async()=>{throw new RedbookPauseError('response');});const runtime=new XhsSubscriptionRuntime({enabled:()=>true,api,requirePersistentRisk:true});runtime.bindRiskStore(new XhsSourceRiskStore(db as any));bindXhsSourceTotalBudget(db as any,runtime);await runtime.connectSession({a1:'synthetic-a1',webSession:'synthetic-session'});
    for(const author of ['author-a','author-b'])(runtime as any).adapter.restoreDefaultAuthorAccess(author);
    await expect(runtime.withTaskScope({taskId:'task-a',creatorId:'creator-a'},()=>runtime.list('author-a',null))).rejects.toThrow('response');
    const risk=await db.$queryRaw<any[]>`SELECT state,code FROM xhs_source_risk WHERE id='source'`;expect(risk[0]).toMatchObject({state:'blocked',code:'XHS_SOURCE_RISK_REVIEW_REQUIRED'});expect(await db.$queryRaw`SELECT id FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:unknown:%'`).toHaveLength(0);
    await expect(runtime.withTaskScope({taskId:'task-b',creatorId:'creator-b'},()=>runtime.list('author-b',null))).rejects.toThrow();expect(api).toHaveBeenCalledTimes(1);runtime.onModuleDestroy();
  },40000);
  it.each(['preheaders','stream','html','typed-html','typed-461','receipt-failure'] as const)('handles media %s uncertainty with the correct scope',async(mode)=>{
    const round='2026-11-01/09:15',records:Array<any>=[];
    for(const label of ['a','b']){
      const creatorId=`media-creator-${label}`,author=`media-author-${label}`,note=`media-note-${label}`,noteKey=JSON.stringify(['xiaohongshu','note',note]);
      await db.xhsCreator.create({data:{id:creatorId,externalAuthorId:author,profileUrl:`https://example.invalid/${author}`,displayName:'Synthetic'}});
      await db.xhsNote.create({data:{id:noteKey,creatorId,title:'Synthetic',publishTime:1,kind:'image-text',status:'listed',contentHtml:'<div id="js_content"><p>body</p></div>'}});
      const media=extractXhsMediaManifest({items:[{id:note,note_card:{note_id:note,user:{user_id:author},type:'normal',image_list:[{url_default:`https://sns-webpic.xhscdn.com/${label}.png`}]}}]},author,note);
      const basicId=scheduledTaskId(round,creatorId,'basic'),taskId=scheduledTaskId(round,creatorId,'media');
      const basic={taskId:basicId,creatorId,state:'completed',schedule:{round,phase:'basic'},noteIds:[noteKey],mediaManifests:{[noteKey]:{state:'pending',manifest:media.manifest}}};
      const task:any={taskId,creatorId,kind:'list',state:'running',schedule:{round,phase:'media'},noteIds:[noteKey],items:{},total:1,completed:0,skipped:0,failed:0,remaining:1};
      await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES(${basicId},${creatorId},'completed',${JSON.stringify(basic)},1)`;
      await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES(${taskId},${creatorId},'running',${JSON.stringify(task)},1)`;
      records.push({creatorId,author,note,noteKey,basicId,task,media});
    }
    const first=records[0],extraNote='media-note-a2',extraKey=JSON.stringify(['xiaohongshu','note',extraNote]);
    await db.xhsNote.create({data:{id:extraKey,creatorId:first.creatorId,title:'Synthetic',publishTime:1,kind:'image-text',status:'listed',contentHtml:'<div id="js_content"><p>second</p></div>'}});
    first.extra={note:extraNote,media:extractXhsMediaManifest({items:[{id:extraNote,note_card:{note_id:extraNote,user:{user_id:first.author},type:'normal',image_list:[{url_default:'https://sns-webpic.xhscdn.com/a2.png'}]}}]},first.author,extraNote)};
    const basicRows=await db.$queryRaw<any[]>`SELECT document FROM xhs_subscription_tasks WHERE id=${first.basicId}`;const firstBasic=JSON.parse(basicRows[0].document);firstBasic.noteIds.push(extraKey);firstBasic.mediaManifests[extraKey]={state:'pending',manifest:first.extra.media.manifest};await db.$executeRaw`UPDATE xhs_subscription_tasks SET document=${JSON.stringify(firstBasic)} WHERE id=${first.basicId}`;
    first.task.noteIds.push(extraKey);first.task.total=2;first.task.remaining=2;await db.$executeRaw`UPDATE xhs_subscription_tasks SET document=${JSON.stringify(first.task)} WHERE id=${first.task.taskId}`;
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,0) ON CONFLICT(id) DO UPDATE SET request_limit=100,used=0,next_at=0,interval_ms=0`;
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=','base64');
    const media=jest.fn(async(url:URL)=>{if(url.pathname==='/a.png'){if(mode==='preheaders'||mode==='receipt-failure')throw new XhsMediaError('XHS_MEDIA_TRANSPORT_FAILED');if(mode==='typed-html')throw new XhsMediaError('XHS_MEDIA_TYPE_REJECTED');if(mode==='typed-461')throw new XhsMediaError('XHS_MEDIA_HTTP_461');if(mode==='html')return new Response('<html>verification</html>',{status:200,headers:{'content-type':'image/png'}});return new Response(new ReadableStream({start(c){c.error(Error('synthetic stream loss'));}}),{status:200,headers:{'content-type':'image/png'}});}return new Response(png,{status:200,headers:{'content-type':'image/png'}});});
    const connect=async()=>{const runtime=new XhsSubscriptionRuntime({enabled:()=>true,media,requirePersistentRisk:true});runtime.bindRiskStore(new XhsSourceRiskStore(db as any));bindXhsSourceTotalBudget(db as any,runtime);await runtime.connectSession({a1:'synthetic-a1',webSession:'synthetic-session'});for(const r of records){(runtime as any).transientMedia.set(JSON.stringify([r.author,r.note]),{generation:(runtime as any).generation,expiresAt:Date.now()+60000,version:r.media.manifest.version,getUrl:r.media.getUrl});if(r.extra)(runtime as any).transientMedia.set(JSON.stringify([r.author,r.extra.note]),{generation:(runtime as any).generation,expiresAt:Date.now()+60000,version:r.extra.media.manifest.version,getUrl:r.extra.media.getUrl});}const service:any=new XhsSubscriptionService(db as any,runtime);service.write=async(_bytes:number,fn:any)=>db.$transaction(fn);return {runtime,service};};
    let {runtime,service}=await connect();
    if(mode==='receipt-failure'){let writes=0;service.write=async(_bytes:number,fn:any)=>{if(++writes===3)throw Error('synthetic receipt storage failure');return db.$transaction(fn);};}
    const run=(r:any)=>runtime.withTaskScope({taskId:r.task.taskId,creatorId:r.creatorId},()=>service.runScheduledMedia(r.task,{id:r.creatorId,externalAuthorId:r.author}));
    const restricted=mode==='html'||mode==='typed-html'||mode==='typed-461';
    if(restricted||mode==='receipt-failure'){const code=mode==='html'?'XHS_MEDIA_RESPONSE_INVALID':mode==='typed-html'?'XHS_MEDIA_TYPE_REJECTED':mode==='typed-461'?'XHS_MEDIA_HTTP_461':'XHS_SOURCE_RISK_UNAVAILABLE';await expect(run(records[0])).rejects.toThrow(code);expect(media).toHaveBeenCalledTimes(1);}else {await run(records[0]);expect(records[0].task.state).toBe('partial');expect(records[0].task.scheduledMediaResults[records[0].noteKey]).toBe('needs-review');expect(records[0].task.items[extraKey]).toBe('completed');expect(media).toHaveBeenCalledTimes(2);}
    const risk=await db.$queryRaw<any[]>`SELECT state,code,http_status FROM xhs_source_risk WHERE id='source'`;expect(risk[0].state).toBe(restricted?'blocked':'clear');if(mode==='typed-461')expect(risk[0]).toMatchObject({code:'XHS_SOURCE_RISK_REVIEW_REQUIRED',http_status:461});
    const basic=await db.$queryRaw<any[]>`SELECT document FROM xhs_subscription_tasks WHERE id=${records[0].basicId}`;expect(JSON.parse(basic[0].document).mediaManifests[records[0].noteKey].items['1'].state).toBe(mode==='receipt-failure'?'started':'unknown');
    if(restricted||mode==='receipt-failure'){await expect(run(records[1])).rejects.toThrow();expect(media).toHaveBeenCalledTimes(1);runtime.onModuleDestroy();return;}
    runtime.onModuleDestroy();({runtime,service}=await connect());await run(records[1]);expect(records[1].task.state).toBe('completed');expect(media).toHaveBeenCalledTimes(3);
    const nextRound='2026-11-01/14:00',nextBasic=scheduledTaskId(nextRound,first.creatorId,'basic'),nextId=scheduledTaskId(nextRound,first.creatorId,'media');const nextBasicDoc={taskId:nextBasic,creatorId:first.creatorId,state:'completed',schedule:{round:nextRound,phase:'basic'},noteIds:[first.noteKey],mediaManifests:{[first.noteKey]:{state:'pending',manifest:first.media.manifest}}};const next:any={taskId:nextId,creatorId:first.creatorId,kind:'list',state:'running',schedule:{round:nextRound,phase:'media'},noteIds:[first.noteKey],items:{},total:1,completed:0,skipped:0,failed:0,remaining:1};
    await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES(${nextBasic},${first.creatorId},'completed',${JSON.stringify(nextBasicDoc)},1)`;await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES(${nextId},${first.creatorId},'running',${JSON.stringify(next)},1)`;
    await runtime.withTaskScope({taskId:nextId,creatorId:first.creatorId},()=>service.runScheduledMedia(next,{id:first.creatorId,externalAuthorId:first.author}));expect(next.state).toBe('partial');expect(next.scheduledMediaResults[first.noteKey]).toBe('needs-review');expect(media).toHaveBeenCalledTimes(3);runtime.onModuleDestroy();
  },40000);
  it('persists the actual fixed 461 classification and prevents restore, reconnect and restart dispatch', async () => {
    let enabled = true;
    const api = jest.fn(async (request: any) => ({
      status: 461,
      url: request.url,
      body: {},
    }));
    const storage = {
      status: jest.fn(async () => ({ stored: true })),
      load: jest.fn(async () => ({
        a1: 'synthetic-a1',
        web_session: 'synthetic-session',
      })),
      store: jest.fn(async () => {}),
      disconnect: jest.fn(async () => {}),
    };
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => enabled,
      api,
      vault: storage,
      requirePersistentRisk: true,
    });
    runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    await expect(
      runtime.resolve(
        'https://www.xiaohongshu.com/explore/synthetic-note?xsec_token=synthetic&xsec_source=app_share',
      ),
    ).rejects.toThrow('unknown_rejection');
    const rows = await db.$queryRaw<
      Array<{
        state: string;
        code: string;
        http_status: number;
        endpoint: string;
        owner: string | null;
      }>
    >`SELECT state,code,http_status,endpoint,owner FROM xhs_source_risk WHERE id='source'`;
    expect(rows[0]).toMatchObject({
      state: 'blocked',
      code: 'XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED',
      http_status: 461,
      endpoint: 'detail',
      owner: null,
    });
    expect(JSON.stringify(rows)).not.toContain('synthetic-session');
    enabled = false;
    expect(await runtime.connectionStatus()).toMatchObject({
      liveEnabled: false,
      sessionPresent: true,
      riskCode: 'XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED',
    });
    expect(storage.status).not.toHaveBeenCalled();
    enabled = true;
    await runtime.restoreSession();
    await runtime.disconnectSession();
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    await expect(
      runtime.resolve(
        'https://www.xiaohongshu.com/user/profile/synthetic-author',
      ),
    ).rejects.toThrow('XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED');
    runtime.onModuleDestroy();
    let restartedEnabled = false;
    const restarted = new XhsSubscriptionRuntime({
      enabled: () => restartedEnabled,
      api,
      requirePersistentRisk: true,
    });
    restarted.bindRiskStore(new XhsSourceRiskStore(db as any));
    expect(await restarted.connectionStatus()).toMatchObject({
      liveEnabled: false,
      sessionPresent: false,
      riskCode: 'XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED',
    });
    restartedEnabled = true;
    await restarted.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    await expect(
      restarted.resolve(
        'https://www.xiaohongshu.com/user/profile/synthetic-author',
      ),
    ).rejects.toThrow('XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED');
    expect(api).toHaveBeenCalledTimes(1);
    restarted.onModuleDestroy();
  }, 40000);

  it('keeps a durable pending fence across instances and failed completion', async () => {
    const first = new XhsSourceRiskStore(db as any),
      second = new XhsSourceRiskStore(db as any);
    const owner = await first.begin();
    await expect(second.begin()).rejects.toThrow(
      'XHS_SOURCE_RISK_REVIEW_REQUIRED',
    );
    await expect(
      first.finish('00000000-0000-0000-0000-000000000000'),
    ).rejects.toThrow('XHS_SOURCE_RISK_UNAVAILABLE');
    const transaction = jest
      .spyOn(db, '$transaction')
      .mockRejectedValueOnce(Error('synthetic commit failure') as never);
    try {
      await expect(first.finish(owner)).rejects.toThrow(
        'XHS_SOURCE_RISK_UNAVAILABLE',
      );
    } finally {
      transaction.mockRestore();
    }
    expect(await second.read()).toBe('XHS_SOURCE_RISK_REVIEW_REQUIRED');
    await expect(second.begin()).rejects.toThrow(
      'XHS_SOURCE_RISK_REVIEW_REQUIRED',
    );
  }, 40000);

  it('fails closed when persistent risk cannot be read or reserved', async () => {
    const store = new XhsSourceRiskStore({
      $queryRaw: jest.fn().mockRejectedValue(Error('synthetic')),
    } as any);
    await expect(store.read()).rejects.toThrow('XHS_SOURCE_RISK_UNAVAILABLE');
    await expect(store.begin()).rejects.toThrow('XHS_SOURCE_RISK_UNAVAILABLE');
  });

  it('clears only a successful pending operation and retains normal budget exhaustion without dispatch', async () => {
    const api = jest.fn(async (request: any) => ({
      status: 200,
      url: request.url,
      body: { success: true, code: 0, data: {} },
    }));
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      requirePersistentRisk: true,
      profileParser: () => ({
        id: 'author',
        name: 'Synthetic',
        profileUrl: 'https://www.xiaohongshu.com/user/profile/author',
      }),
    });
    const risk = new XhsSourceRiskStore(db as any);
    runtime.bindRiskStore(risk);
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    const profile = 'https://www.xiaohongshu.com/user/profile/author';
    await runtime.resolve(profile);
    expect(await risk.read()).toBeUndefined();
    const budget = new XhsRequestBudget({
      read: async (id) => ({ id, used: 1, limit: 1, nextAt: 0, intervalMs: 0 }),
      reserve: async () => false,
    });
    await expect(
      runtime.withRequestBudget(budget, 'synthetic', () =>
        runtime.resolve(profile),
      ),
    ).rejects.toThrow('XHS_REQUEST_RATE_PAUSED');
    expect(await risk.read()).toBeUndefined();
    expect(api).toHaveBeenCalledTimes(1);
    await runtime.resolve(profile);
    expect(api).toHaveBeenCalledTimes(2);
    expect(await risk.read()).toBeUndefined();
    runtime.onModuleDestroy();
  }, 40000);

  it.each([false, true])(
    'distinguishes local cancellation before dispatch from cancellation after dispatch (dispatched=%s)',
    async (dispatched) => {
      let used = 0;
      const api = jest.fn(async () => {
        throw new XhsSubscriptionError('XHS_TASK_CANCELLED');
      });
      const runtime = new XhsSubscriptionRuntime({
        enabled: () => true,
        api,
        requirePersistentRisk: true,
      });
      const risk = new XhsSourceRiskStore(db as any);
      runtime.bindRiskStore(risk);
      await runtime.connectSession({
        a1: 'synthetic-a1',
        webSession: 'synthetic-session',
      });
      const budget = new XhsRequestBudget({
        read: async (id) => ({ id, used, limit: 2, nextAt: 0, intervalMs: 0 }),
        reserve: async () => {
          used++;
          return true;
        },
        rollback: async () => {
          used--;
          return true;
        },
        assertReady: async () => {
          if (!dispatched) throw new XhsSubscriptionError('XHS_TASK_CANCELLED');
        },
      });
      const operation = runtime.withRequestBudget(budget, 'synthetic', () =>
        runtime.resolve('https://www.xiaohongshu.com/user/profile/author'),
      );
      if (dispatched) await expect(operation).rejects.toThrow();
      else await expect(operation).rejects.toThrow('XHS_TASK_CANCELLED');
      expect(api).toHaveBeenCalledTimes(dispatched ? 1 : 0);
      expect(used).toBe(dispatched ? 1 : 0);
      expect(await risk.read()).toBe(
        dispatched ? 'XHS_SOURCE_RISK_REVIEW_REQUIRED' : undefined,
      );
      runtime.onModuleDestroy();
    },
    40000,
  );

  it('does not dispatch if a required risk reservation cannot be persisted', async () => {
    const api = jest.fn();
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      requirePersistentRisk: true,
    });
    runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    const transaction = jest
      .spyOn(db, '$transaction')
      .mockRejectedValueOnce(Error('synthetic write failure') as never);
    try {
      await expect(
        runtime.resolve('https://www.xiaohongshu.com/user/profile/author'),
      ).rejects.toThrow('XHS_SOURCE_RISK_UNAVAILABLE');
    } finally {
      transaction.mockRestore();
    }
    expect(api).not.toHaveBeenCalled();
    expect((await runtime.connectionStatus()).riskCode).toBe(
      'XHS_SOURCE_RISK_UNAVAILABLE',
    );
    runtime.onModuleDestroy();
  }, 40000);

  it('does not replay an uncertain risk completion after a successful source response', async () => {
    const api = jest.fn(async (request: any) => ({
      status: 200,
      url: request.url,
      body: { success: true, code: 0, data: {} },
    }));
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      requirePersistentRisk: true,
      profileParser: () => ({
        id: 'author',
        name: 'Synthetic',
        profileUrl: 'https://www.xiaohongshu.com/user/profile/author',
      }),
    });
    const risk = new XhsSourceRiskStore(db as any);
    runtime.bindRiskStore(risk);
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    const finish = jest
      .spyOn(risk, 'finish')
      .mockRejectedValueOnce(Error('synthetic unknown commit'));
    try {
      await expect(
        runtime.resolve('https://www.xiaohongshu.com/user/profile/author'),
      ).rejects.toThrow('XHS_SOURCE_RISK_UNAVAILABLE');
      expect(finish).toHaveBeenCalledTimes(1);
      expect(api).toHaveBeenCalledTimes(1);
      await expect(
        runtime.resolve('https://www.xiaohongshu.com/user/profile/author'),
      ).rejects.toThrow('XHS_SOURCE_RISK_UNAVAILABLE');
      expect(api).toHaveBeenCalledTimes(1);
    } finally {
      finish.mockRestore();
    }
    expect(await risk.read()).toBe('XHS_SOURCE_RISK_REVIEW_REQUIRED');
    runtime.onModuleDestroy();
  }, 40000);

  it('rejects a concurrent caller without poisoning the still-active owner', async () => {
    let release!: (value: any) => void;
    const api = jest.fn(
      (request: any) =>
        new Promise<{ status: number; url: string; body: unknown }>(
          (resolve) => {
            release = () =>
              resolve({
                status: 200,
                url: request.url,
                body: { success: true, code: 0, data: {} },
              });
          },
        ),
    );
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      requirePersistentRisk: true,
      profileParser: () => ({
        id: 'author',
        name: 'Synthetic',
        profileUrl: 'https://www.xiaohongshu.com/user/profile/author',
      }),
    });
    const risk = new XhsSourceRiskStore(db as any);
    runtime.bindRiskStore(risk);
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    const url = 'https://www.xiaohongshu.com/user/profile/author';
    const first = runtime.resolve(url);
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    await expect(runtime.resolve(url)).rejects.toThrow(
      'XHS_SOURCE_RISK_REVIEW_REQUIRED',
    );
    expect(api).toHaveBeenCalledTimes(1);
    release(undefined);
    await expect(first).resolves.toMatchObject({ author: { id: 'author' } });
    expect(await risk.read()).toBeUndefined();
    runtime.onModuleDestroy();
  }, 40000);

  it.each([
    ['XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED', 'blocked'],
    ['XHS_REQUEST_BUDGET_EXHAUSTED', 'clear'],
  ] as const)(
    'migrates partial only for an explicit source rejection (%s)',
    async (code, state) => {
      const legacy = new PrismaClient({
        datasources: {
          db: {
            url:
              'file:' +
              path.join(folder, `partial-${state}.sqlite`).replace(/\\/g, '/'),
          },
        },
      });
      try {
        await legacy.$executeRawUnsafe(
          'CREATE TABLE xhs_whole_creator_jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL, document TEXT NOT NULL)',
        );
        await legacy.$executeRawUnsafe(
          'CREATE TABLE xhs_subscription_tasks (id TEXT PRIMARY KEY, state TEXT NOT NULL, document TEXT NOT NULL)',
        );
        const old = JSON.stringify({ code });
        await legacy.$executeRaw`INSERT INTO xhs_subscription_tasks(id,state,document) VALUES('legacy','partial',${old})`;
        const migration = await fs.readFile(
          path.resolve(
            __dirname,
            '../../prisma/migrations/20261027100000_xhs_source_risk/migration.sql',
          ),
          'utf8',
        );
        for (const sql of splitSqliteStatements(migration))
          await legacy.$executeRawUnsafe(sql);
        const rows = await legacy.$queryRaw<
          Array<{ state: string; code: string | null }>
        >`SELECT state,code FROM xhs_source_risk WHERE id='source'`;
        expect(rows[0]).toEqual({
          state,
          code:
            state === 'blocked' ? 'XHS_SOURCE_HISTORY_REVIEW_REQUIRED' : null,
        });
        const saved = await legacy.$queryRaw<
          Array<{ document: string }>
        >`SELECT document FROM xhs_subscription_tasks WHERE id='legacy'`;
        expect(saved[0].document).toBe(old);
      } finally {
        await legacy.$disconnect();
      }
    },
    40000,
  );

  it.each([
    ['whole', 'XHS_SOURCE_VERIFICATION_BLOCKED', 'blocked'],
    ['subscription', 'XHS_SOURCE_VERIFICATION_BLOCKED', 'blocked'],
    ['whole', 'XHS_TASK_CANCELLED', 'clear'],
    ['subscription', 'XHS_TASK_CANCELLED', 'clear'],
  ] as const)(
    'migrates cancelled %s with %s only when it records a source rejection',
    async (kind, code, state) => {
      const legacy = new PrismaClient({
        datasources: {
          db: {
            url:
              'file:' +
              path
                .join(folder, `cancel-${kind}-${state}.sqlite`)
                .replace(/\\/g, '/'),
          },
        },
      });
      try {
        await legacy.$executeRawUnsafe(
          'CREATE TABLE xhs_whole_creator_jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL, document TEXT NOT NULL)',
        );
        await legacy.$executeRawUnsafe(
          'CREATE TABLE xhs_subscription_tasks (id TEXT PRIMARY KEY, state TEXT NOT NULL, document TEXT NOT NULL)',
        );
        const old = JSON.stringify({ code, stage: 'replies' });
        if (kind === 'whole')
          await legacy.$executeRaw`INSERT INTO xhs_whole_creator_jobs(id,state,document) VALUES('legacy','cancelled',${old})`;
        else
          await legacy.$executeRaw`INSERT INTO xhs_subscription_tasks(id,state,document) VALUES('legacy','cancelled',${old})`;
        const migration = await fs.readFile(
          path.resolve(
            __dirname,
            '../../prisma/migrations/20261027100000_xhs_source_risk/migration.sql',
          ),
          'utf8',
        );
        for (const sql of splitSqliteStatements(migration))
          await legacy.$executeRawUnsafe(sql);
        const rows = await legacy.$queryRaw<
          Array<{ state: string; code: string | null }>
        >`SELECT state,code FROM xhs_source_risk WHERE id='source'`;
        expect(rows[0]).toEqual({
          state,
          code:
            state === 'blocked' ? 'XHS_SOURCE_HISTORY_REVIEW_REQUIRED' : null,
        });
        const saved =
          kind === 'whole'
            ? await legacy.$queryRaw<
                Array<{ document: string }>
              >`SELECT document FROM xhs_whole_creator_jobs WHERE id='legacy'`
            : await legacy.$queryRaw<
                Array<{ document: string }>
              >`SELECT document FROM xhs_subscription_tasks WHERE id='legacy'`;
        expect(saved[0].document).toBe(old);
      } finally {
        await legacy.$disconnect();
      }
    },
    40000,
  );

  it.each(['whole', 'subscription'] as const)(
    'migrates a legacy %s source stop to unknown review without asserting verification or clearing history',
    async (kind) => {
      const legacy = new PrismaClient({
        datasources: {
          db: {
            url:
              'file:' +
              path.join(folder, `legacy-${kind}.sqlite`).replace(/\\/g, '/'),
          },
        },
      });
      try {
        await legacy.$executeRawUnsafe(
          'CREATE TABLE xhs_whole_creator_jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL, document TEXT NOT NULL)',
        );
        await legacy.$executeRawUnsafe(
          'CREATE TABLE xhs_subscription_tasks (id TEXT PRIMARY KEY, state TEXT NOT NULL, document TEXT NOT NULL)',
        );
        const old = JSON.stringify({
          code: 'XHS_SOURCE_VERIFICATION_BLOCKED',
          stage: 'replies',
        });
        if (kind === 'whole')
          await legacy.$executeRaw`INSERT INTO xhs_whole_creator_jobs(id,state,document) VALUES('legacy','paused',${old})`;
        else
          await legacy.$executeRaw`INSERT INTO xhs_subscription_tasks(id,state,document) VALUES('legacy','blocked',${old})`;
        const migration = await fs.readFile(
          path.resolve(
            __dirname,
            '../../prisma/migrations/20261027100000_xhs_source_risk/migration.sql',
          ),
          'utf8',
        );
        for (const sql of splitSqliteStatements(migration))
          await legacy.$executeRawUnsafe(sql);
        const rows = await legacy.$queryRaw<
          Array<{
            state: string;
            code: string;
            http_status: number | null;
            endpoint: string | null;
          }>
        >`SELECT state,code,http_status,endpoint FROM xhs_source_risk WHERE id='source'`;
        expect(rows[0]).toEqual({
          state: 'blocked',
          code: 'XHS_SOURCE_HISTORY_REVIEW_REQUIRED',
          http_status: null,
          endpoint: null,
        });
        const jobs =
          kind === 'whole'
            ? await legacy.$queryRaw<
                Array<{ document: string }>
              >`SELECT document FROM xhs_whole_creator_jobs WHERE id='legacy'`
            : await legacy.$queryRaw<
                Array<{ document: string }>
              >`SELECT document FROM xhs_subscription_tasks WHERE id='legacy'`;
        expect(jobs[0].document).toBe(old);
        const api = jest.fn();
        const runtime = new XhsSubscriptionRuntime({
          enabled: () => true,
          api,
          requirePersistentRisk: true,
        });
        runtime.bindRiskStore(new XhsSourceRiskStore(legacy as any));
        await runtime.connectSession({
          a1: 'synthetic-a1',
          webSession: 'synthetic-session',
        });
        await expect(
          runtime.resolve('https://www.xiaohongshu.com/user/profile/author'),
        ).rejects.toThrow('XHS_SOURCE_HISTORY_REVIEW_REQUIRED');
        expect(api).not.toHaveBeenCalled();
        runtime.onModuleDestroy();
      } finally {
        await legacy.$disconnect();
      }
    },
    40000,
  );
});
