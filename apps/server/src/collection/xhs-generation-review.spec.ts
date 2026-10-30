// Only native process identity observations are replaced. SQLite admission, CAS,
// proof validation, history validation and every persistent write remain real.
jest.mock('./xhs-dispatch-owner-observation', () => ({ observeDispatchOwner: jest.fn(() => 'dead') }));
jest.mock('./xhs-dispatch-owner', () => ({ ...jest.requireActual('./xhs-dispatch-owner'), ownsDispatch: jest.fn(() => false) }));
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { PrismaClient } from '@prisma/client';
import { observeDispatchOwner } from './xhs-dispatch-owner-observation';
import { ownsDispatch } from './xhs-dispatch-owner';
import { legacyBudgetDigest } from './xhs-legacy-review';
import { generationMatches, activeWholeFence } from './xhs-whole-generation';
import { generationReviewMarkers, reviewGenerationUnknown } from './xhs-generation-review';

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
describe('explicit review appends generation unknown without deleting markers or refunding counts', () => {
  let db: PrismaClient, root: string;
  const oldMarker = 'xhs:dispatch-pending:whole:00000000-0000-4000-8000-000000000001';
  const marker = 'xhs:dispatch-pending:whole:00000000-0000-4000-8000-000000000002';
  const nextMarker = 'xhs:dispatch-pending:whole:00000000-0000-4000-8000-000000000003';
  const owner = { pid: 12345, startIdentity: '638000000000000001', nonce: '00000000-0000-4000-8000-000000000004' };
  const input = { jobId: 'job', generationId: '00000000-0000-4000-8000-000000000010', confirmUnknown: true as const };
  const read = async () => JSON.parse((await db.$queryRaw<Array<{ document: string }>>`SELECT document FROM xhs_whole_creator_jobs WHERE id='job'`)[0].document);
  const write = (job: any) => db.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(job)} WHERE id='job'`;
  const budgets = () => db.$queryRaw<Array<{ id: string; used: number; request_limit: number; next_at: bigint; interval_ms: number }>>`SELECT id,used,request_limit,next_at,interval_ms FROM xhs_request_budgets ORDER BY id`;
  const review = (now = 2000) => db.$transaction(tx => reviewGenerationUnknown(tx, input, now));
  function receipt(job: any) {
    job.generation.activeFence.receipt = { phase:'detail',stage:'checkpoint',outcome:'unknown',code:'XHS_SESSION_CHANGED',status:200,
      settled:true,marker,generationId:input.generationId,owner:{...owner},sequence:2,events:[{stage:'response',status:200},{stage:'checkpoint'}] };
  }
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'xhs-generation-review-'));
    db = new PrismaClient({ datasources:{db:{url:'file:'+path.join(root,'fixture.db').replace(/\\/g,'/')}} });
    await db.$executeRawUnsafe('CREATE TABLE xhs_creators(id TEXT PRIMARY KEY,external_author_id TEXT,enabled INTEGER)');
    await db.$executeRawUnsafe('CREATE TABLE xhs_whole_creator_jobs(id TEXT PRIMARY KEY,creator_id TEXT,state TEXT,document TEXT,updated_at INTEGER)');
    await db.$executeRawUnsafe('CREATE TABLE xhs_subscription_tasks(id TEXT PRIMARY KEY,state TEXT)');
    await db.$executeRawUnsafe('CREATE TABLE xhs_request_budgets(id TEXT PRIMARY KEY,used INTEGER,request_limit INTEGER,next_at INTEGER,interval_ms INTEGER)');
    await db.$executeRawUnsafe('CREATE TABLE xhs_source_risk(id TEXT PRIMARY KEY,state TEXT,code TEXT)');
    await db.$executeRawUnsafe('CREATE TABLE xhs_limited_recovery(id TEXT,note_id TEXT,author_id TEXT,state TEXT)');
    await db.$executeRawUnsafe('CREATE TABLE xhs_limited_recovery_append(id TEXT,note_id TEXT,author_id TEXT,state TEXT)');
    await db.$executeRawUnsafe("INSERT INTO xhs_creators VALUES('creator','author',1)");
  });
  beforeEach(async () => {
    (observeDispatchOwner as jest.Mock).mockReset().mockReturnValue('dead');
    (ownsDispatch as unknown as jest.Mock).mockReset().mockReturnValue(false);
    await db.$executeRaw`DELETE FROM xhs_whole_creator_jobs`;await db.$executeRaw`DELETE FROM xhs_request_budgets`;
    await db.$executeRaw`DELETE FROM xhs_source_risk`;await db.$executeRaw`DELETE FROM xhs_subscription_tasks`;
    await db.$executeRaw`DELETE FROM xhs_limited_recovery`;await db.$executeRaw`DELETE FROM xhs_limited_recovery_append`;
    await db.$executeRaw`UPDATE xhs_creators SET enabled=1,external_author_id='author'`;
    await db.$executeRawUnsafe("INSERT INTO xhs_source_risk VALUES('source','blocked','XHS_SOURCE_HISTORY_REVIEW_REQUIRED')");
    await db.$executeRawUnsafe("INSERT INTO xhs_request_budgets VALUES('job',7,310,10000,10000),('xhs:source-total',9,312,10000,10000)");
    await db.$executeRaw`INSERT INTO xhs_request_budgets VALUES(${oldMarker},1,1,10000,0),(${marker},1,1,20000,0)`;
    const originBudgets = [{id:'job',used:6,request_limit:310,next_at:0,interval_ms:10000},{id:'xhs:source-total',used:8,request_limit:312,next_at:0,interval_ms:10000}];
    const original: any = { id:'job',creatorId:'creator',code:'XHS_DOWNLOAD_BLOCKED',sourceFence:{marker:oldMarker,state:'started',phase:'detail',noteId:'note'},
      sourceGrant:{creatorId:'creator',authorId:'author',phases:['profile','list','detail','media','metrics'],limits:{profile:2,list:3,detail:5,media:300,metrics:0},used:{profile:2,list:2,detail:1,media:1,metrics:0}} };
    const proof: any = { boundaryVersion:'project-start-dispatch-v2',oldOwner:null,oldResult:'unknown',allowsRetry:false,claim:'no-local-project-writer-at-observation',
      lockIdentity:hash('lock'),lockNonce:'synthetic',holder:{pid:123},snapshot:{observed:true},scope:{jobId:'job',authorId:'author',noteId:'note',databaseIdentity:hash('db'),projectIdentity:hash('project'),
      unknownDigest:hash({fence:original.sourceFence,code:original.code}),budgetDigest:legacyBudgetDigest(original,originBudgets,'job')} };
    proof.proofId=hash({scope:proof.scope,lockIdentity:proof.lockIdentity,lockNonce:proof.lockNonce,holder:proof.holder,snapshot:proof.snapshot});
    const generation: any = { id:input.generationId,state:'paused',profileUrl:'https://xhslink.cn/o/Synthetic',createdAt:1000,
      phaseLimits:{profile:4,list:5,detail:8,media:300,metrics:8},origin:{fence:original.sourceFence,code:original.code,grant:original.sourceGrant,proofId:proof.proofId,budgets:originBudgets.map(b=>({...b,next_at:String(b.next_at)}))} };
    generation.originDigest=hash({id:generation.id,profileUrl:generation.profileUrl,createdAt:generation.createdAt,phaseLimits:generation.phaseLimits,origin:generation.origin});
    generation.activeFence={owner:{...owner},marker,state:'started',phase:'detail',noteId:'note'};
    const job={...original,state:'paused',code:'XHS_SESSION_CHANGED',legacyMaintenanceProof:proof,generation,
      sourceGrant:{...original.sourceGrant,limits:{...generation.phaseLimits},used:{...original.sourceGrant.used,detail:2}}};
    expect(generationMatches(job)).toBe(true);
    await db.$executeRaw`INSERT INTO xhs_whole_creator_jobs VALUES('job','creator','paused',${JSON.stringify(job)},1000)`;
  });
  afterAll(async()=>{await db.$disconnect();await fs.rm(root,{recursive:true,force:true});});

  it('appends the exact unknown fence and floors, while keeping the job paused and every marker/count unchanged',async()=>{
    const before=await read(), counts=await budgets();
    expect(await review()).toEqual({state:'reviewed',generationId:input.generationId});const job=await read();
    expect(job.state).toBe('paused');expect(job.generation.state).toBe('paused');expect(job.generation.activeFence).toBeUndefined();
    expect(job.generation.reviews).toHaveLength(1);expect(job.generation.reviews[0]).toMatchObject({fence:before.generation.activeFence,reviewedAt:2000,decision:'request-retry',budgetFloors:{taskUsed:7,sharedUsed:9,phaseUsed:before.sourceGrant.used}});
    expect(job.sourceFence).toEqual(before.sourceFence);expect(job.sourceGrant).toEqual(before.sourceGrant);expect(job.legacyMaintenanceProof).toEqual(before.legacyMaintenanceProof);
    expect(job.code).toBe(before.code);expect(await budgets()).toEqual(counts);expect(generationReviewMarkers(job)).toEqual([marker]);expect(activeWholeFence(job)).toBeUndefined();
  });
  it.each(['alive','unknown'])('refuses a %s owner without a trustworthy settled receipt',async state=>{
    (observeDispatchOwner as jest.Mock).mockReturnValue(state);const before=await read();await expect(review()).rejects.toThrow('XHS_WHOLE_SOURCE_FENCE_BLOCKED');expect(await read()).toEqual(before);
  });
  it('accepts a bound settled receipt only when the native ownership predicate proves the current owner',async()=>{
    (observeDispatchOwner as jest.Mock).mockReturnValue('alive');(ownsDispatch as unknown as jest.Mock).mockReturnValue(true);
    const job=await read();receipt(job);await write(job);await review();
    expect((await read()).generation.reviews[0].fence.receipt).toEqual(job.generation.activeFence.receipt);expect(await budgets()).toEqual(expect.arrayContaining([expect.objectContaining({id:'job',used:7}),expect.objectContaining({id:'xhs:source-total',used:9})]));
  });
  it('does not trust a settled receipt from another live process',async()=>{
    (observeDispatchOwner as jest.Mock).mockReturnValue('alive');const job=await read();receipt(job);await write(job);await expect(review()).rejects.toThrow();
  });
  it.each(['marker','generationId','owner','phase','stage','outcome','status','code','extra','events-extra','events-stage','events-status','events-limit','sequence'])('rejects an invalid receipt %s binding or unsafe field',async change=>{
    (ownsDispatch as unknown as jest.Mock).mockReturnValue(true);const job=await read();receipt(job);const r=job.generation.activeFence.receipt;
    if(change==='owner')r.owner={...owner,nonce:'00000000-0000-4000-8000-000000000099'};
    else if(change==='status')r.status=600;
    else if(change==='extra')r.url='https://example.invalid/private';
    else if(change==='events-extra')r.events=[{stage:'response',body:'private'}];
    else if(change==='events-stage')r.events=[{stage:'untrusted'}];
    else if(change==='events-status')r.events=[{stage:'response',status:600}];
    else if(change==='events-limit')r.events=Array.from({length:13},()=>({stage:'response',status:200}));
    else if(change==='sequence')r.sequence=-1;
    else r[change]='untrusted';
    await write(job);await expect(review()).rejects.toThrow('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
  });
  it('does not turn an in-progress receipt into settlement for a live owner',async()=>{
    (observeDispatchOwner as jest.Mock).mockReturnValue('alive');(ownsDispatch as unknown as jest.Mock).mockReturnValue(true);
    const job=await read();receipt(job);job.generation.activeFence.receipt.settled=false;await write(job);await expect(review()).rejects.toThrow();
  });
  it('reviews a prepared unknown only after owner exit and preserves its original prepared state',async()=>{
    const job=await read();job.generation.activeFence.state='prepared';await write(job);const counts=await budgets();
    await review();const reviewed=await read();expect(reviewed.generation.activeFence).toBeUndefined();
    expect(reviewed.generation.reviews[0].fence).toEqual(job.generation.activeFence);
    expect(reviewed.generation.reviews[0].fence.state).toBe('prepared');expect(generationReviewMarkers(reviewed)).toEqual([marker]);
    expect(await budgets()).toEqual(counts);expect(reviewed.sourceFence).toEqual(job.sourceFence);
  });
  it('refuses every known restricted response status despite a stale history-only risk row and dead owner',async()=>{
    const before=await read();
    for(const status of [401,403,406,429,461,471]){
      const job=JSON.parse(JSON.stringify(before));receipt(job);job.generation.activeFence.receipt.status=status;await write(job);
      await expect(review()).rejects.toThrow('XHS_WHOLE_SOURCE_FENCE_BLOCKED');expect((await read()).generation.reviews).toBeUndefined();
      // A later summary must not erase the earlier restricted response event.
      job.generation.activeFence.receipt.status=200;job.generation.activeFence.receipt.events=[{stage:'response',status}];await write(job);
      await expect(review()).rejects.toThrow('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
    }
  });
  it('refuses all six persisted source restriction codes despite a stale history-only risk row and settled owner receipt',async()=>{
    (observeDispatchOwner as jest.Mock).mockReturnValue('alive');(ownsDispatch as unknown as jest.Mock).mockReturnValue(true);
    const before=await read();
    for(const category of ['AUTHENTICATION','VERIFICATION','UNKNOWN_REJECTION','PERMISSION','SIGNATURE','RATE_LIMIT']){
      const job=JSON.parse(JSON.stringify(before));receipt(job);job.generation.activeFence.receipt.code='XHS_SOURCE_'+category+'_BLOCKED';await write(job);
      await expect(review()).rejects.toThrow('XHS_WHOLE_SOURCE_FENCE_BLOCKED');expect((await read()).generation.reviews).toBeUndefined();
    }
  });
  it('requires confirmation and takes all marker identity from durable state',async()=>{
    await expect(db.$transaction(tx=>reviewGenerationUnknown(tx,{...input,confirmUnknown:false} as any,2000))).rejects.toThrow();
    await expect(db.$transaction(tx=>reviewGenerationUnknown(tx,{...input,marker} as any,2000))).rejects.toThrow();
    await expect(db.$transaction(tx=>reviewGenerationUnknown(tx,{...input,generationId:'00000000-0000-4000-8000-000000000099'},2000))).rejects.toThrow();
  });
  it.each(['queued','running'])('refuses any %s whole job or subscription child',async state=>{
    await db.$executeRaw`INSERT INTO xhs_whole_creator_jobs VALUES('other','creator',${state},'{}',0)`;await expect(review()).rejects.toThrow();
    await db.$executeRaw`DELETE FROM xhs_whole_creator_jobs WHERE id='other'`;
    await db.$executeRaw`INSERT INTO xhs_subscription_tasks VALUES('child',${state})`;await expect(review()).rejects.toThrow();
  });
  it('refuses real risk restrictions, disabled or changed author, and unresolved recovery',async()=>{
    await db.$executeRaw`UPDATE xhs_source_risk SET code='XHS_SOURCE_VERIFICATION_BLOCKED'`;await expect(review()).rejects.toThrow();
    await db.$executeRaw`UPDATE xhs_source_risk SET code='XHS_SOURCE_HISTORY_REVIEW_REQUIRED'`;
    await db.$executeRaw`UPDATE xhs_creators SET enabled=0`;await expect(review()).rejects.toThrow();await db.$executeRaw`UPDATE xhs_creators SET enabled=1,external_author_id='other'`;await expect(review()).rejects.toThrow();
    await db.$executeRaw`UPDATE xhs_creators SET external_author_id='author'`;
    await db.$executeRawUnsafe("INSERT INTO xhs_limited_recovery VALUES('unresolved','note','author','unknown')");await expect(review()).rejects.toThrow();
  });
  it('rejects unrelated pending markers and either missing retained marker',async()=>{
    await db.$executeRaw`INSERT INTO xhs_request_budgets VALUES(${nextMarker},1,1,0,0)`;await expect(review()).rejects.toThrow();await db.$executeRaw`DELETE FROM xhs_request_budgets WHERE id=${nextMarker}`;
    await db.$executeRaw`DELETE FROM xhs_request_budgets WHERE id=${oldMarker}`;await expect(review()).rejects.toThrow();await db.$executeRaw`INSERT INTO xhs_request_budgets VALUES(${oldMarker},1,1,0,0)`;
    await db.$executeRaw`DELETE FROM xhs_request_budgets WHERE id=${marker}`;await expect(review()).rejects.toThrow();
  });
  it('rejects duplicate review and preserves all prior history while reviewing a later distinct unknown',async()=>{
    await review();const first=await read();await expect(review()).rejects.toThrow();
    first.generation.activeFence={...first.generation.reviews[0].fence,marker:nextMarker};first.sourceGrant.used.detail++;
    await write(first);await db.$executeRaw`INSERT INTO xhs_request_budgets VALUES(${nextMarker},1,1,0,0)`;await db.$executeRaw`UPDATE xhs_request_budgets SET used=used+1 WHERE id IN ('job','xhs:source-total')`;
    await review(3000);const second=await read();expect(second.generation.reviews).toHaveLength(2);expect(second.generation.reviews[0]).toEqual(first.generation.reviews[0]);
    expect(generationReviewMarkers(second)).toEqual([marker,nextMarker]);expect(second.generation.reviews[1].budgetFloors).toMatchObject({taskUsed:8,sharedUsed:10});
  });
  it('rejects history mutation, review count refunds and reusing a reviewed marker as current for a late callback',async()=>{
    await review();const reviewed=await read();const changed=JSON.parse(JSON.stringify(reviewed));changed.generation.reviews[0].fence.state='failed';
    expect(()=>generationReviewMarkers(changed)).toThrow();
    const late=JSON.parse(JSON.stringify(reviewed));late.generation.activeFence=late.generation.reviews[0].fence;expect(()=>generationReviewMarkers(late)).toThrow();
    reviewed.generation.activeFence={...reviewed.generation.reviews[0].fence,marker:nextMarker};await write(reviewed);
    await db.$executeRaw`INSERT INTO xhs_request_budgets VALUES(${nextMarker},1,1,0,0)`;await db.$executeRaw`UPDATE xhs_request_budgets SET used=6 WHERE id='job'`;
    await expect(review(3000)).rejects.toThrow();
  });
  it('rolls back review and active-fence movement on a storage interruption without refunding any count',async()=>{
    const before=await read(), counts=await budgets();
    await expect(db.$transaction(async tx=>{await reviewGenerationUnknown(tx,input,2000);throw Error('synthetic storage rollback');})).rejects.toThrow('synthetic storage rollback');
    expect(await read()).toEqual(before);expect(await budgets()).toEqual(counts);
  });
  it('serializes concurrent reviews so one original unknown can be appended only once',async()=>{
    const outcomes=await Promise.allSettled([review(),review()]);expect(outcomes.filter(v=>v.status==='fulfilled')).toHaveLength(1);expect((await read()).generation.reviews).toHaveLength(1);
  });
});
