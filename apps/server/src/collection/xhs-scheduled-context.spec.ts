import { PrismaClient } from '@prisma/client';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { XhsSubscriptionService } from './xhs-subscription.service';
import { scheduledTaskId } from './xhs-scheduled-admission';
import { RedbookSubscriptionAdapter } from './xhs-redbook-subscription';

describe('scheduled author context on SQLite',()=>{
 let db:PrismaClient,dir:string,service:any,source:any,ready:boolean;
 const round='2026-10-31/14:00',creator='creator',author='author',taskId=scheduledTaskId(round,creator,'basic');
 const task=()=>({taskId,creatorId:creator,state:'running',schedule:{round,phase:'basic'}} as any);
 const stored=async()=>JSON.parse((await db.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_subscription_tasks WHERE id=${taskId}`)[0].document);
 beforeAll(async()=>{dir=await mkdtemp(path.join(tmpdir(),'xhs-scheduled-context-'));db=new PrismaClient({datasources:{db:{url:'file:'+path.join(dir,'test.db').replace(/\\/g,'/')}}});await db.$executeRawUnsafe('CREATE TABLE xhs_subscription_tasks(id TEXT PRIMARY KEY,creator_id TEXT,state TEXT,document TEXT,updated_at INTEGER)');},40000);
 beforeEach(async()=>{await db.$executeRaw`DELETE FROM xhs_subscription_tasks`;const t=task();await db.$executeRaw`INSERT INTO xhs_subscription_tasks VALUES(${taskId},${creator},'running',${JSON.stringify(t)},0)`;ready=false;source={hasAuthorContext:jest.fn(()=>ready),resolve:jest.fn(async()=>{ready=true;return {inputKind:'profile',author:{id:author}};})};service=new XhsSubscriptionService(db as any,source);service.write=async(_n:number,fn:any)=>db.$transaction(fn);});
 afterAll(async()=>{await db.$disconnect();await rm(dir,{recursive:true,force:true});});
 it('reuses a valid context without a request',async()=>{ready=true;await service.prepareScheduledContext(task(),author);expect(source.resolve).not.toHaveBeenCalled();expect((await stored()).scheduledContext).toBeUndefined();});
 it('claims once and persists an author-bound confirmed result',async()=>{await service.prepareScheduledContext(task(),author);expect(source.resolve).toHaveBeenCalledTimes(1);expect((await stored()).scheduledContext).toEqual({authorId:author,used:1,state:'confirmed'});await service.prepareScheduledContext(task(),author);expect(source.resolve).toHaveBeenCalledTimes(1);ready=false;await expect(service.prepareScheduledContext(task(),author)).rejects.toThrow();expect(source.resolve).toHaveBeenCalledTimes(1);});
 it('stops on failed or unknown profile and never sends a second request after restart',async()=>{source.resolve.mockRejectedValueOnce(Error('synthetic unknown'));await expect(service.prepareScheduledContext(task(),author)).rejects.toThrow();expect((await stored()).scheduledContext).toEqual({authorId:author,used:1,state:'started'});const restarted=new XhsSubscriptionService(db as any,source) as any;restarted.write=service.write;await expect(restarted.prepareScheduledContext(task(),author)).rejects.toThrow();expect(source.resolve).toHaveBeenCalledTimes(1);});
 it('does not admit a second overlapping context claim',async()=>{let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);source.resolve.mockImplementationOnce(async()=>{entered();await gate;ready=true;return {inputKind:'profile',author:{id:author}};});const first=service.prepareScheduledContext(task(),author);await started;try{await expect(service.prepareScheduledContext(task(),author)).rejects.toThrow();expect(source.resolve).toHaveBeenCalledTimes(1);}finally{release();await first;}});
 it('rebuilds an expired author using the real adapter and a synthetic profile response',async()=>{
  let now=1;const client:any={getUserInfo:jest.fn(async()=>({author:{id:author,name:'synthetic'}})),getUserNotes:jest.fn(),getNoteById:jest.fn()};
  const adapter=new RedbookSubscriptionAdapter(client,{now:()=>now,contextLifetimeMs:100,shortLinks:{resolve:async(u:string)=>new URL(u)} as any,profileParser:(raw:any)=>({id:raw.author.id,name:raw.author.name,profileUrl:'https://www.xiaohongshu.com/user/profile/'+raw.author.id} as any)});
  const actual:any=new XhsSubscriptionService(db as any,adapter);actual.write=service.write;
  await actual.prepareScheduledContext(task(),author);expect(client.getUserInfo).toHaveBeenCalledTimes(1);expect(client.getUserNotes).not.toHaveBeenCalled();expect(adapter.hasAuthorContext(author)).toBe(true);
  now=102;expect(adapter.hasAuthorContext(author)).toBe(false);await expect(actual.prepareScheduledContext(task(),author)).rejects.toThrow();expect(client.getUserInfo).toHaveBeenCalledTimes(1);
  const nextRound='2026-10-31/17:30',nextId=scheduledTaskId(nextRound,creator,'basic'),next={...task(),taskId:nextId,schedule:{round:nextRound,phase:'basic'}};await db.$executeRaw`INSERT INTO xhs_subscription_tasks VALUES(${nextId},${creator},'running',${JSON.stringify(next)},0)`;await actual.prepareScheduledContext(next,author);expect(client.getUserInfo).toHaveBeenCalledTimes(2);
 });
 it('does not start directory work if profile resolution fails',async()=>{
  source.resolve.mockRejectedValueOnce(Error('synthetic profile failure'));source.list=jest.fn();
  service.creator=async()=>({id:creator,externalAuthorId:author,enabled:true});
  service.persist=async(t:any)=>db.$executeRaw`UPDATE xhs_subscription_tasks SET state=${t.state},document=${JSON.stringify(t)} WHERE id=${t.taskId}`;
  const t={...task(),kind:'list',collectionStage:'listing',listFinished:false,selectionComplete:false};await service.run(t);
  expect(source.resolve).toHaveBeenCalledTimes(1);expect(source.list).not.toHaveBeenCalled();expect((await stored()).scheduledContext.state).toBe('started');expect(t.state).toBe('blocked');
 });
 it('rejects mismatched author and preserves the started receipt',async()=>{source.resolve.mockResolvedValueOnce({inputKind:'profile',author:{id:'other'}});await expect(service.prepareScheduledContext(task(),author)).rejects.toThrow();expect((await stored()).scheduledContext.state).toBe('started');expect(source.resolve).toHaveBeenCalledTimes(1);});
});
