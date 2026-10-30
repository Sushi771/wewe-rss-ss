import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { PrismaClient } from '@prisma/client';
import { splitSqliteStatements } from '../../../../scripts/sqlite-statements.cjs';
import {
  XhsSubscriptionService,
  XhsSubscriptionSource,
  subscriptionUrl,
} from './xhs-subscription.service';
import { XiaohongshuService } from './xiaohongshu.service';
import { XhsNormalizedCandidate } from './xiaohongshu-contract';
import { LocalArticleStore } from '../article-local-save';
import { RedbookSubscriptionAdapter } from './xhs-redbook-subscription';
import { xhsNoteFilterSchema } from '@wewe-rss/shared';
import { allowedRedbookMediaUrl, mapRedbookPage } from './redbook-response';
import { TrpcService } from '../trpc/trpc.service';
import { TrpcRouter } from '../trpc/trpc.router';
import { ConfigService } from '@nestjs/config';
import { XhsSubscriptionError } from './xhs-subscription-errors';
import { XhsSubscriptionRuntime } from './xhs-subscription-runtime';
import { bindXhsSourceTotalBudget } from './xhs-source-request-policy';
import { createHash } from 'node:crypto';
import { createHTTPServer } from '@trpc/server/adapters/standalone';
import { createRequire } from 'node:module';
const { createTRPCProxyClient, httpLink } = createRequire(
  path.resolve(__dirname, '../../../web/package.json'),
)('@trpc/client');
import {
  preferredRecoveredTask,
  mayResumeTask,
  watchSubscriptionTask,
} from '../../../web/src/utils/xiaohongshu-subscription';

const author = {
  id: 'synthetic-author',
  name: '合成作者',
  profileUrl: 'https://www.xiaohongshu.com/user/profile/synthetic-author',
};
const noteKey = (id: string) => JSON.stringify(['xiaohongshu', 'note', id]);
const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=';
const detail = (noteId = 'note-a'): XhsNormalizedCandidate => ({
  authorId: author.id,
  noteId,
  kind: 'image-text',
  title: '合成笔记',
  text: '检索正文测试',
  textStatus: 'full',
  publishedAt: 1760000000,
  expectedImageCount: 1,
  images: [{ ordinal: 1, inlineData: png }],
});
describe('isolated subscription workflow with synthetic SQLite and actual local saver', () => {
  let root: string,
    db: PrismaClient,
    service: XhsSubscriptionService,
    cache: XiaohongshuService,
    source: XhsSubscriptionSource,
    store: LocalArticleStore;
  let creatorId: string;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'xhs-subscription-test-'));
    db = new PrismaClient({
      datasources: {
        db: {
          url:
            'file:' + path.join(root, 'synthetic.sqlite').replace(/\\/g, '/'),
        },
      },
    });
    const migrations = path.resolve(__dirname, '../../prisma/migrations');
    for (const name of (await fs.readdir(migrations)).sort()) {
      if (!(await fs.stat(path.join(migrations, name))).isDirectory()) continue;
      const sql = await fs.readFile(
        path.join(migrations, name, 'migration.sql'),
        'utf8',
      );
      for (const statement of splitSqliteStatements(sql)
        .map((s) => s.trim())
        .filter(Boolean))
        await db.$executeRawUnsafe(statement);
    }
    await db.$executeRawUnsafe('PRAGMA synchronous = FULL');
    cache = new XiaohongshuService(db as any);
    store = new LocalArticleStore(path.join(root, 'settings.json'), root);
  }, 30000);
  beforeEach(async () => {
    // Previous terminal visibility does not imply its worker/finally has released the fixture lock.
    if (service) await (service as any).lane;
    await db.$executeRawUnsafe('DELETE FROM xhs_subscription_tasks');
    await db.xhsNote.deleteMany();
    await db.xhsCreator.deleteMany();
    source = {
      resolve: jest.fn(async (url) => ({
        inputKind: url.includes('/user/profile/')
          ? ('profile' as const)
          : ('note' as const),
        author,
      })),
      list: jest.fn(async () => ({
        authorId: author.id,
        nextCursor: null,
        notes: [
          {
            authorId: author.id,
            noteId: 'note-a',
            title: '合成列表',
            publishedAt: 0,
            kind: 'image-text' as const,
          },
        ],
      })),
      detail: jest.fn(async () => detail()),
    };
    service = new XhsSubscriptionService(db as any, source);
    service.bindLocalSaver(
      async () => root,
      async (creator, noteId, directory) => {
        const prepare = await cache.prepareLocalDownload(creator.id, noteId);
        return store.save(
          async (stage) => ({
            ...(await prepare(stage)),
            exportSource: { feedId: creator.id, feedName: creator.displayName },
          }),
          new Date(),
          directory,
        );
      },
    );
    creatorId = 'synthetic-creator';
    await db.xhsCreator.create({ data: { id: creatorId, externalAuthorId: author.id, profileUrl: author.profileUrl, displayName: author.name, enabled: true } });
  });
  afterAll(async () => {
    if (service) await (service as any).lane;
    await db?.$disconnect(); /* synthetic files retained in temp for diagnosis */
  });
  const finish = async (taskId: string) => {
    for (let i = 0; i < 2000; i++) {
      const t = await service.task({ taskId });
      if (!['queued', 'running'].includes(t.state)) return t;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('SYNTHETIC_TASK_TIMEOUT');
  };
  const settled = async (taskId: string) => {
    for (let i = 0; i < 500; i++) {
      const task = await service.task({ taskId });
      if (task.resumable) return task;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw Error('SYNTHETIC_SETTLEMENT_TIMEOUT');
  };
  it('caches every discovered image detail without a directory or export', async () => {
    let page = 0;
    source.list = jest.fn(async () => ({ authorId: author.id, nextCursor: ++page === 1 ? 'p2' : null, notes: [{authorId: author.id, noteId: `n${page}`, title: `n${page}`, publishedAt: 0, kind: 'image-text' as const}] }));
    source.detail = jest.fn(async (_a, id) => ({...detail(id), metrics: { collectedAt: 1700000000000, values: {likes: 0, collects: 12, comments: null, shares: 4}, contract: 'synthetic', evidence: 'verified-response' as const } }));
    const result = await service.refreshFull({id: creatorId});
    const done = await finish(result.taskId);
    expect(done).toMatchObject({state:'completed', collectionStage:'details', total:2, completed:2, failed:0});
    expect(source.detail).toHaveBeenCalledTimes(2);
    const notes = await db.xhsNote.findMany({where:{creatorId}, orderBy:{id:'asc'}});
    expect(notes).toHaveLength(2);
    expect(notes.every(n => n.status === 'complete' && n.publishTime === 1760000000 && n.contentHtml?.includes('data:image/png;base64,'))).toBe(true);
    const metrics = await db.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_metric_snapshots WHERE owner_kind='note'`;
    expect(metrics).toHaveLength(2);
    expect(JSON.parse(metrics[0].document).values).toEqual({likes: 0, collects: 12, comments: null, shares: 4});
  });
  it('automatically queues a collection when a subscription is confirmed', async () => {
    const resolution = await service.resolveSubscription({url:author.profileUrl});
    const result = await service.subscribe({resolutionId: resolution.resolutionId});
    if (!('collection' in result)) throw Error(result.collectionError);
    expect((await finish(result.collection.taskId)).state).toBe('completed');
  });
  it('does not claim an unsupported video was cached', async () => {
    source.list = jest.fn(async () => ({ authorId: author.id, nextCursor:null, notes:[{authorId:author.id,noteId:'video',title:'video',publishedAt:0,kind:'video' as const}]}));
    source.detail = jest.fn(async () => { throw new XhsSubscriptionError('XHS_VIDEO_CACHE_UNAVAILABLE'); });
    const result = await service.refreshFull({id:creatorId});
    const done = await finish(result.taskId);
    expect(done.state).toBe('blocked');
    expect(done.completed).toBe(0);
    expect(done.code).toBe('XHS_VIDEO_SOURCE_UNVERIFIED');
  });
  it('re-enumerates for an explicit resume and preserves completed detail receipts', async () => {
    source.list = jest.fn(async () => ({authorId:author.id, nextCursor:null, notes:['a','b'].map(noteId => ({authorId:author.id,noteId,title:noteId,publishedAt:0,kind:'image-text' as const}))}));
    let fail = true;
    source.detail = jest.fn(async (_author,id) => {
      if (id === 'b' && fail) { fail = false; throw new XhsSubscriptionError('XHS_SOURCE_TRANSPORT_BLOCKED'); }
      return detail(id);
    });
    const first = await service.refreshFull({id:creatorId});
    expect((await finish(first.taskId)).state).toBe('partial');
    await settled(first.taskId);
    const next = await service.resumeTask({taskId:first.taskId});
    expect((await finish(next.taskId))).toMatchObject({state:'completed', completed:2, total:2});
    expect((source.detail as jest.Mock).mock.calls.map(c => c[1])).toEqual(['a','b','b']);
    expect(source.list).toHaveBeenCalledTimes(2);
  });

  it('stops following notes when a video source response cannot be verified', async () => {
    source.list = jest.fn(async () => ({authorId:author.id, nextCursor:null, notes:[
      {authorId:author.id,noteId:'video',title:'video',publishedAt:0,kind:'video' as const},
      {authorId:author.id,noteId:'image',title:'image',publishedAt:0,kind:'image-text' as const}]}));
    source.detail = jest.fn(async (_author,id) => { if (id === 'video') throw new XhsSubscriptionError('XHS_VIDEO_CACHE_UNAVAILABLE'); return detail(id); });
    const result = await service.refreshFull({id:creatorId});
    const task = await finish(result.taskId);
    expect(task).toMatchObject({state:'blocked',total:2,completed:0,failed:1,code:'XHS_VIDEO_SOURCE_UNVERIFIED'});
    expect((await db.xhsNote.findUnique({where:{id:noteKey('image')}}))?.status).toBe('listed');
    expect((await db.xhsNote.findUnique({where:{id:noteKey('video')}}))?.status).toBe('video-skipped');
  });

  it.each([['recent',30],['all',35]] as const)('limits detail to %s scope without inventing an end cursor', async (scope, count) => {
    source.list = jest.fn(async () => ({authorId:author.id,nextCursor:null,notes:Array.from({length:35},(_,i)=>({authorId:author.id,noteId:`scope${i}`,title:`scope${i}`,publishedAt:0,kind:'image-text' as const}))}));
    source.detail = jest.fn(async (_author,id)=>detail(id));
    const result = await service.refreshFull({id:creatorId, scope});
    expect(await finish(result.taskId)).toMatchObject({state:'completed',collectionScope:scope,total:count,completed:count});
    expect(source.detail).toHaveBeenCalledTimes(count);
  }, 40000);
  it('selects only frozen cached note IDs without a picker', async () => {
    for (const n of ['selected','other']) await db.xhsNote.create({data:{id:noteKey(n),creatorId,title:n,publishTime:0,kind:'image-text',status:'listed'}});
    source.list = jest.fn(async () => ({authorId:author.id,nextCursor:null,notes:['other','selected'].map(noteId=>({authorId:author.id,noteId,title:noteId,publishedAt:0,kind:'image-text' as const}))}));
    source.detail = jest.fn(async (_author,id)=>detail(id));
    const result = await service.refreshFull({id:creatorId,scope:'selected',noteIds:[noteKey('selected')]});
    expect(await finish(result.taskId)).toMatchObject({state:'completed',collectionScope:'selected',total:1,completed:1});
    expect((source.detail as jest.Mock).mock.calls.map(c=>c[1])).toEqual(['selected']);
  });

  it('stops a recent run after 30 returned entries without claiming supplier end', async () => {
    source.list = jest.fn(async () => ({authorId:author.id,nextCursor:'more',notes:Array.from({length:31},(_,i)=>({authorId:author.id,noteId:`p${i}`,title:`p${i}`,publishedAt:0,kind:'image-text' as const}))}));
    source.detail = jest.fn(async (_author,id)=>detail(id));
    const result=await service.refreshFull({id:creatorId});
    expect(await finish(result.taskId)).toMatchObject({state:'completed',collectionScope:'recent',total:30,completed:30});
    expect(source.list).toHaveBeenCalledTimes(1);
    const rows=await db.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_subscription_tasks WHERE id=${result.taskId}`;
    expect(JSON.parse(rows[0].document).listFinished).toBe(false);
  },40000);

  it('uses the actual runtime and source rate policy to cache a subscribed note', async () => {
    const api = jest.fn(async (request:any) => {
      const endpoint = new URL(request.url).pathname;
      const data = endpoint.endsWith('otherinfo') ? { author } : endpoint.endsWith('user_posted')
        ? { notes:[{note_id:'runtime-note',user:{user_id:author.id},xsec_token:'synthetic',type:'normal',display_title:'Synthetic'}],has_more:false,cursor:'' }
        : {items:[{id:'runtime-note',note_card:{note_id:'runtime-note',user:{user_id:author.id},type:'normal',time:1760000000000,title:'Synthetic',desc:'Actual source body',image_list:[],interact_info:{liked_count:'0',collected_count:'2',share_count:'3',comment_count:'4'}}}]};
      return {status:200,url:request.url,body:{success:true,code:0,data}};
    });
    const runtime = new XhsSubscriptionRuntime({enabled:()=>true,api,profileParser:()=>author});
    bindXhsSourceTotalBudget(db as any,runtime);
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,interval_ms,next_at) VALUES('xhs:source-total',1,1,1000,0) ON CONFLICT(id) DO UPDATE SET request_limit=1,used=1,interval_ms=1000,next_at=0`;
    await runtime.connectSession({a1:'synthetic',webSession:'synthetic'});
    const real = new XhsSubscriptionService(db as any,runtime);
    try {
      const resolved=await real.resolveSubscription({url:author.profileUrl});
      const result=await real.subscribe({resolutionId:resolved.resolutionId});
      if (!('collection' in result)) throw Error(result.collectionError);
      let state = await real.task({taskId:result.collection.taskId});
      for (let i=0;i<1000 && ['queued','running'].includes(state.state);i++) { await new Promise(r=>setTimeout(r,20)); state=await real.task({taskId:result.collection.taskId}); }
      expect(state).toMatchObject({state:'completed',collectionScope:'recent',total:1,completed:1});
      expect((await db.xhsNote.findUnique({where:{id:noteKey('runtime-note')}}))?.contentHtml).toContain('Actual source body');
      const snapshot=await db.xhsMetricSnapshot.findUnique({where:{ownerKind_ownerId:{ownerKind:'note',ownerId:noteKey('runtime-note')}}});
      expect(JSON.parse(snapshot!.document).values).toEqual({likes:0,collects:2,shares:3,comments:4});
      expect(api).toHaveBeenCalledTimes(3);
    } finally {await (real as any).lane; await real.onModuleDestroy();runtime.onModuleDestroy();}
  },40000);

  it.each([true,false])('waits for the parent batch and dispatches only on confirmation: %s', async allowed => {
    let release!:(allowed:boolean)=>void;
    const gate = new Promise<boolean>(resolve => { release = resolve; });
    const result = await service.refreshFull({id:creatorId},gate);
    await new Promise(resolve=>setImmediate(resolve));
    expect(source.list).not.toHaveBeenCalled();
    release(allowed);
    const task=await finish(result.taskId);
    expect(task.state).toBe(allowed?'completed':'cancelled');
    expect(source.list).toHaveBeenCalledTimes(allowed?1:0);
  });

  it('refreshes an existing complete cache body while preserving an earlier exported file',async()=>{
    await db.xhsNote.create({data:{id:noteKey('note-a'),creatorId,title:'Old',publishTime:1700000000,kind:'image-text',status:'complete',contentHtml:'<div id="js_content"><p>OLD_SYNTHETIC_BODY</p></div>'}});
    const prepared=await cache.prepareLocalDownload(creatorId,noteKey('note-a'));
    const exported=await store.save(prepared,new Date('2026-10-09T00:00:00Z'));
    const before=await fs.readFile(exported.markdownPath,'utf8');
    source.detail=jest.fn(async()=>({...detail(),text:'NEW_SYNTHETIC_BODY'}));
    const receipt=await service.refreshFull({id:creatorId});expect((await finish(receipt.taskId)).state).toBe('completed');
    const saved=await db.xhsNote.findUniqueOrThrow({where:{id:noteKey('note-a')}});
    expect(saved.contentHtml).toContain('NEW_SYNTHETIC_BODY');expect(saved.contentHtml).not.toContain('OLD_SYNTHETIC_BODY');
    expect(await fs.readFile(exported.markdownPath,'utf8')).toBe(before);
  },30000);

});
