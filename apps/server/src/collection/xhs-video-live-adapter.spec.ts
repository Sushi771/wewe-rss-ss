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
import { allowedRedbookMediaUrl, mapRedbookPage, mapRedbookDetail } from './redbook-response';
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
const box = (type: string, ...payload: Buffer[]) => {
  const content = Buffer.concat(payload),
    header = Buffer.alloc(8);
  header.writeUInt32BE(content.length + 8);
  header.write(type, 4, 4, 'latin1');
  return Buffer.concat([header, content]);
};
const ints = (...values: number[]) => {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => bytes.writeUInt32BE(value, i * 4));
  return bytes;
};
/** Deliberately synthetic AVC-labelled sample container. It proves sample/mdat
 * mapping and actual file publication, never successful H.264 decoding.
 */
function mp4() {
  const ftyp = box(
    'ftyp',
    Buffer.from('isom'),
    ints(0),
    Buffer.from('isomavc1'),
  );
  const sample = Buffer.from([0, 0, 0, 4, 0x65, 0x88, 0x84, 0x21]);
  const videoEntry = Buffer.alloc(78);
  videoEntry.writeUInt16BE(1, 6);
  videoEntry.writeUInt16BE(16, 24);
  videoEntry.writeUInt16BE(16, 26);
  const avcC = box(
    'avcC',
    Buffer.from([1, 66, 0, 10, 255, 225, 0, 1, 103, 1, 0, 1, 104]),
  );
  const description = box('stsd', ints(0, 1), box('avc1', videoEntry, avcC));
  const trackHeader = Buffer.alloc(84);
  trackHeader.writeUInt32BE(1, 12);
  trackHeader.writeUInt32BE(1000, 20);
  trackHeader.writeUInt32BE(16 << 16, 76);
  trackHeader.writeUInt32BE(16 << 16, 80);
  const movie = (offset: number) =>
    box(
      'moov',
      box('mvhd', ints(0, 0, 0, 1000, 1000), Buffer.alloc(80)),
      box(
        'trak',
        box('tkhd', trackHeader),
        box(
          'mdia',
          box('mdhd', ints(0, 0, 0, 1000, 1000), Buffer.alloc(4)),
          box('hdlr', ints(0, 0), Buffer.from('vide'), Buffer.alloc(12)),
          box(
            'minf',
            box(
              'stbl',
              description,
              box('stts', ints(0, 1, 1, 1000)),
              box('stsc', ints(0, 1, 1, 1, 1)),
              box('stsz', ints(0, 0, 1, sample.length)),
              box('stco', ints(0, 1, offset)),
            ),
          ),
        ),
      ),
    );
  const moov = movie(ftyp.length + movie(0).length + 8);
  return Buffer.concat([ftyp, moov, box('mdat', sample)]);
}

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
    await db.xhsMetricSnapshot.deleteMany();
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
  const raw = (url = 'https://sns-video-bd.xhscdn.com/synthetic') => ({items:[{id:'v1',note_card:{note_id:'v1',user:{user_id:author.id},type:'video',time:1760000000000,title:'Synthetic video',desc:'Video caption',image_list:[],interact_info:{liked_count:'0',collected_count:'2',share_count:'3',comment_count:'4'},video:{media:{stream:{h264:[{master_url:url}]}}}}}]});
  const media = (bytes:Buffer, declared=bytes.length, mime='video/mp4') => jest.fn(async (_url: URL, _options: any) => new Response(Uint8Array.from(bytes) as any,{status:200,headers:{'content-type':mime,'content-length':String(declared)}}));
  it('maps video detail and commits checked MP4, body, timestamp, metrics and receipt in SQLite without export',async()=>{
    const bytes=mp4(), transport=media(bytes);
    source.list=jest.fn(async()=>({authorId:author.id,nextCursor:null,notes:[{authorId:author.id,noteId:'v1',title:'Video',publishedAt:0,kind:'video' as const}]}));
    source.detail=jest.fn(async()=>mapRedbookDetail(raw(),author.id,'v1',transport));
    const receipt=await service.refreshFull({id:creatorId});
    expect(await finish(receipt.taskId)).toMatchObject({state:'completed',completed:1,total:1});
    const saved=await db.xhsNote.findUniqueOrThrow({where:{id:noteKey('v1')}});
    expect(saved).toMatchObject({kind:'video',status:'complete',publishTime:1760000000,videoMimeType:'video/mp4',videoExpectedBytes:bytes.length});
    expect(Buffer.from(saved.videoBytes!)).toEqual(bytes);expect(saved.contentHtml).toContain('Video caption');
    const metric=await db.xhsMetricSnapshot.findUniqueOrThrow({where:{ownerKind_ownerId:{ownerKind:'note',ownerId:saved.id}}});
    expect(JSON.parse(metric.document).values).toEqual({likes:0,collects:2,shares:3,comments:4});
    const prepared=await cache.prepareLocalDownload(creatorId,saved.id);
    const exported=await store.save(prepared,new Date('2026-10-09T00:00:00Z'));
    expect(exported).toMatchObject({videoCount:1,alreadySaved:false});
    const names=await fs.readdir(path.join(exported.directory,'video'));
    expect(await fs.readFile(path.join(exported.directory,'video',names[0]))).toEqual(bytes);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][1]).toMatchObject({credentials:'omit',redirect:'manual',headers:{accept:'video/mp4'}});
  },40000);
  it('rejects foreign video URLs before network access',async()=>{
    const transport=media(mp4());await expect(mapRedbookDetail(raw('https://evil.invalid/v'),author.id,'v1',transport)).rejects.toThrow('XHS_VIDEO_CACHE_UNAVAILABLE');expect(transport).not.toHaveBeenCalled();
  });
  it('rejects truncation and malformed MP4 bytes',async()=>{
    const bytes=mp4();await expect(mapRedbookDetail(raw(),author.id,'v1',media(bytes,bytes.length+1))).rejects.toThrow();
    await expect(mapRedbookDetail(raw(),author.id,'v1',media(Buffer.alloc(128)))).rejects.toThrow();
  });
  it('rolls back all video fields and metrics if the source checkpoint fails',async()=>{
    let inDetail=false;const bytes=mp4();
    source.list=jest.fn(async()=>({authorId:author.id,nextCursor:null,notes:[{authorId:author.id,noteId:'v1',title:'Video',publishedAt:0,kind:'video' as const}]}));
    source.detail=jest.fn(async()=>{inDetail=true;return mapRedbookDetail(raw(),author.id,'v1',media(bytes));});
    source.checkpointWholeSource=jest.fn(async()=>{if(inDetail)throw Error('synthetic transaction failure');});
    const receipt=await service.refreshFull({id:creatorId});
    expect((await finish(receipt.taskId)).state).toBe('blocked');
    const note=await db.xhsNote.findUniqueOrThrow({where:{id:noteKey('v1')}});
    expect(note).toMatchObject({status:'video-skipped',videoBytes:null,publishTime:0});
    expect(await db.xhsMetricSnapshot.count({where:{ownerKind:'note',ownerId:note.id}})).toBe(0);
    expect(source.detail).toHaveBeenCalledTimes(1);
  });

});
