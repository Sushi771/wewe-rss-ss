import { PrismaClient } from '@prisma/client';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { extractXhsMediaManifest, resumeXhsMedia } from './xhs-native-media';
import { xhsMediaTaskStore } from './xhs-media-task-store';

describe('media task storage with synthetic SQLite and synthetic gate',()=>{
  let db:PrismaClient,dir:string;
  const id=JSON.stringify(['xiaohongshu','note','synthetic']);
  const raw={items:[{id:'synthetic',note_card:{note_id:'synthetic',user:{user_id:'author'},type:'normal',time:1760000000000,title:'Synthetic',desc:'Keep this original text',image_list:[{url_default:'https://sns-webpic.xhscdn.com/a.png'},{url_default:'https://sns-webpic.xhscdn.com/b.png'}]}}]};
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=','base64');
  beforeAll(async()=>{dir=await mkdtemp(path.join(tmpdir(),'xhs-media-task-'));db=new PrismaClient({datasources:{db:{url:'file:'+path.join(dir,'fixture.db').replace(/\\/g,'/')}}});
    await db.$executeRawUnsafe('CREATE TABLE xhs_subscription_tasks(id TEXT PRIMARY KEY,creator_id TEXT,document TEXT,updated_at INTEGER)');
    await db.$executeRawUnsafe('CREATE TABLE xhs_notes(id TEXT PRIMARY KEY,creator_id TEXT,content_html TEXT,status TEXT)');
    await db.$executeRawUnsafe('CREATE TABLE gate(id TEXT PRIMARY KEY,used INTEGER,blocked INTEGER)');
  },40000);
  beforeEach(async()=>{await db.$executeRaw`DELETE FROM xhs_subscription_tasks`;await db.$executeRaw`DELETE FROM xhs_notes`;await db.$executeRaw`DELETE FROM gate`;
    const {manifest}=extractXhsMediaManifest(raw,'author','synthetic');
    const reordered={authorId:manifest.authorId,noteId:manifest.noteId,version:manifest.version,images:manifest.images};
    await db.$executeRaw`INSERT INTO xhs_subscription_tasks VALUES('task','creator',${JSON.stringify({mediaManifests:{[id]:{state:'pending',manifest:reordered}}})},0)`;
    await db.$executeRaw`INSERT INTO xhs_notes VALUES(${id},'creator','<div id="js_content"><p>Keep this original text</p></div>','listed')`;
    await db.$executeRaw`INSERT INTO gate VALUES('source',0,0)`;
  },40000);
  afterAll(async()=>{await db.$disconnect();await rm(dir,{recursive:true,force:true});},40000);
  const writer:any=(fn:any)=>db.$transaction(fn);
  const gate:any=async(tx:any)=>{const n=await tx.$executeRaw`UPDATE gate SET used=used+1 WHERE id='source' AND blocked=0`;if(n!==1)throw Error('blocked');};
  const store=()=>xhsMediaTaskStore(db as any,writer,{taskId:'task',creatorId:'creator',noteId:id},gate);
  it('retains the first verified image when the next commit fails and restart never resends unknown',async()=>{
    const source=extractXhsMediaManifest(raw,'author','synthetic'),s=store(),commit=s.commit;
    s.commit=async(m,n,data)=>{if(n===2)throw Error('synthetic commit failure');return commit(m,n,data);};
    const transport=jest.fn(async()=>new Response(png,{status:200,headers:{'content-type':'image/png'}}));
    await expect(resumeXhsMedia(source.manifest,source.getUrl,s,transport)).rejects.toThrow('synthetic commit failure');
    expect(transport).toHaveBeenCalledTimes(2);expect(await store().readVerifiedOrdinal(source.manifest,1)).not.toBeNull();
    const noNetwork=jest.fn(async()=>new Response(png,{status:200,headers:{'content-type':'image/png'}}));
    await expect(resumeXhsMedia(source.manifest,source.getUrl,store(),noNetwork)).rejects.toThrow();
    expect(noNetwork).not.toHaveBeenCalled();
    const rows=await db.$queryRaw<Array<{content_html:string}>>`SELECT content_html FROM xhs_notes WHERE id=${id}`;
    expect(rows[0].content_html).toContain('Keep this original text');expect(rows[0].content_html).toContain('data-xhs-media');
  },40000);
  it('serializes competing reservations so a resource dispatches at most once',async()=>{
    const source=extractXhsMediaManifest({...raw,items:[{...raw.items[0],note_card:{...raw.items[0].note_card,image_list:[raw.items[0].note_card.image_list[0]]}}]},'author','synthetic');
    await db.$executeRaw`UPDATE xhs_subscription_tasks SET document=${JSON.stringify({mediaManifests:{[id]:{state:'pending',manifest:source.manifest}}})} WHERE id='task'`;
    let release!:()=>void,enter!:()=>void;const entered=new Promise<void>(r=>enter=r),wait=new Promise<void>(r=>release=r);
    const transport=jest.fn(async()=>{enter();await wait;return new Response(png,{status:200,headers:{'content-type':'image/png'}});});
    const first=resumeXhsMedia(source.manifest,source.getUrl,store(),transport);await entered;
    try {await expect(resumeXhsMedia(source.manifest,source.getUrl,store(),transport)).rejects.toThrow();} finally {release();}
    await first;expect(transport).toHaveBeenCalledTimes(1);
  },40000);
  it('rolls back item admission when the source gate denies it',async()=>{
    const source=extractXhsMediaManifest(raw,'author','synthetic');await db.$executeRaw`UPDATE gate SET blocked=1 WHERE id='source'`;
    const transport=jest.fn(async()=>new Response(png,{status:200,headers:{'content-type':'image/png'}}));
    await expect(resumeXhsMedia(source.manifest,source.getUrl,store(),transport)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
    const rows=await db.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_subscription_tasks WHERE id='task'`;
    expect(JSON.parse(rows[0].document).mediaManifests[id].items).toBeUndefined();
    expect((await db.$queryRaw<Array<{used:number}>>`SELECT used FROM gate WHERE id='source'`)[0].used).toBe(0);
  },40000);
});
