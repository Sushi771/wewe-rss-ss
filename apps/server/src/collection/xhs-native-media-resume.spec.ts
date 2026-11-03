import { extractXhsMediaManifest, resumeXhsMedia, XhsMediaResumeStore } from './xhs-native-media';
import { mapRedbookBasicDetail } from './redbook-response';
const url = (id: string) => `https://sns-webpic.xhscdn.com/${id}?token=synthetic-secret`;
const detail = (images: unknown[]) => ({items:[{id:'n',note_card:{note_id:'n',user:{user_id:'a'},type:'normal',time:1760000000000,title:'t',desc:'body',image_list:images}}]});
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=', 'base64');
function memory() {
 const saved = new Map<number,string>(), status = new Map<number,'ready'|'refresh'|'stop'>();
 const store: XhsMediaResumeStore = {
  readVerifiedOrdinal: async (_m, n) => saved.get(n) ?? null,
  readVerified: async (m, key) => { const prior=m.images.find(x=>x.resourceKey===key && saved.has(x.ordinal));return prior ? saved.get(prior.ordinal)! : null; },
  attemptState: async (_m,n) => status.get(n) ?? 'ready',
  begin: async (_m,n) => { status.set(n,'stop'); },
  commit: async (_m,n,data) => { saved.set(n,data); status.set(n,'ready'); },
  fail: async (_m,n,code) => { status.set(n,code==='XHS_MEDIA_HTTP_404' || code==='XHS_MEDIA_HTTP_410' ? 'refresh':'stop'); },
 };
 return {store,saved,status};
}
const ok = () => new Response(png,{status:200,headers:{'content-type':'image/png'}});
test('manifest retains order and exact secret-bearing address only in memory, basic survives invalid media',()=>{
 const raw=detail([{url_default:url('one')},{url_default:'https://evil.invalid/?token=synthetic-secret'},{url_default:url('one')}]);
 const {manifest,getUrl}=extractXhsMediaManifest(raw,'a','n');
 expect(manifest.images.map(i=>i.ordinal)).toEqual([1,2,3]);expect(manifest.images[0].resourceKey).toBe(manifest.images[2].resourceKey);expect(manifest.images[1].resourceKey).toBeNull();
 expect(JSON.stringify(manifest)).not.toMatch(/synthetic-secret|xhscdn/);expect(getUrl(manifest.images[0].resourceKey!)).toBe(url('one'));
 expect(mapRedbookBasicDetail(raw,'a','n').text).toBe('body');expect(()=>extractXhsMediaManifest(raw,'other','n')).toThrow();
});
test('partial failure preserves successful resources, avoids duplicate requests, and needs controlled refresh',async()=>{
 const {manifest,getUrl}=extractXhsMediaManifest(detail([{url_default:url('one')},{url_default:url('one')},{url_default:url('missing')},{url_default:url('three')}]),'a','n');
 const mem=memory(); const transport=jest.fn(async (u:URL)=>u.pathname==='/missing'?new Response(null,{status:404}):ok());
 expect(await resumeXhsMedia(manifest,getUrl,mem.store,transport)).toEqual({saved:3,pending:1,needsDetailRefresh:true});
 expect([...mem.saved.keys()]).toEqual([1,2,4]); expect(transport).toHaveBeenCalledTimes(3);
 await resumeXhsMedia(manifest,getUrl,mem.store,transport); expect(transport).toHaveBeenCalledTimes(3);
});
test('crash or restriction pauses and never resends an unresolved request',async()=>{
 const {manifest,getUrl}=extractXhsMediaManifest(detail([{url_default:url('one')},{url_default:url('two')}]),'a','n');
 const mem=memory();const transport=jest.fn(async()=>ok());const commit=mem.store.commit;mem.store.commit=async (...args)=>{if(args[1]===2) throw Error('simulated crash');await commit(...args)};
 await expect(resumeXhsMedia(manifest,getUrl,mem.store,transport)).rejects.toThrow('simulated crash');
 await expect(resumeXhsMedia(manifest,getUrl,mem.store,transport)).rejects.toThrow('XHS_MEDIA_REVIEW_REQUIRED');expect(transport).toHaveBeenCalledTimes(2);
 const restricted=memory();const denied=jest.fn(async()=>new Response(null,{status:403}));
 await expect(resumeXhsMedia(manifest,getUrl,restricted.store,denied)).rejects.toThrow('XHS_MEDIA_HTTP_403');
 await expect(resumeXhsMedia(manifest,getUrl,restricted.store,denied)).rejects.toThrow('XHS_MEDIA_REVIEW_REQUIRED');expect(denied).toHaveBeenCalledTimes(1);
});
test('lost in-memory signed URLs and changed signatures do not trigger a request or unsafe reuse',async()=>{
 const first=extractXhsMediaManifest(detail([{url_default:url('one')}]),'a','n');const mem=memory();const transport=jest.fn(async()=>ok());
 expect(await resumeXhsMedia(first.manifest,()=>undefined,mem.store,transport)).toMatchObject({pending:1,needsDetailRefresh:true});expect(transport).not.toHaveBeenCalled();
 const second=extractXhsMediaManifest(detail([{url_default:url('one')+'-new'}]),'a','n');expect(second.manifest.version).not.toBe(first.manifest.version);
 await expect(resumeXhsMedia(first.manifest,second.getUrl,mem.store,transport)).resolves.toMatchObject({needsDetailRefresh:true});expect(transport).not.toHaveBeenCalled();
});


test('a later stopped duplicate blocks reuse and all subsequent network requests',async()=>{
 const {manifest,getUrl}=extractXhsMediaManifest(detail([{url_default:url('one')},{url_default:url('one')},{url_default:url('three')}]),'a','n');
 const mem=memory();mem.saved.set(1,`data:image/png;base64,${png.toString('base64')}`);mem.status.set(2,'stop');
 const transport=jest.fn(async()=>ok());await expect(resumeXhsMedia(manifest,getUrl,mem.store,transport)).rejects.toThrow('XHS_MEDIA_REVIEW_REQUIRED');
 expect(mem.saved.has(2)).toBe(false);expect(transport).not.toHaveBeenCalled();
});
test('duplicate expired URLs are not retried within or across runs',async()=>{
 const {manifest,getUrl}=extractXhsMediaManifest(detail([{url_default:url('missing')},{url_default:url('missing')}]),'a','n');
 const mem=memory();const transport=jest.fn(async()=>new Response(null,{status:404}));
 expect(await resumeXhsMedia(manifest,getUrl,mem.store,transport)).toMatchObject({pending:2,needsDetailRefresh:true});
 await resumeXhsMedia(manifest,getUrl,mem.store,transport);expect(transport).toHaveBeenCalledTimes(1);
});
test('stored and new images share the 20 MB note limit',async()=>{
 const {manifest,getUrl}=extractXhsMediaManifest(detail([{url_default:url('one')},{url_default:url('two')},{url_default:url('three')}]),'a','n');
 const mem=memory(); const image=`data:image/png;base64,${Buffer.concat([png.subarray(0,-12),Buffer.alloc(9_999_000),png.subarray(-12)]).toString('base64')}`;
 mem.saved.set(1,image);mem.saved.set(2,image);
 const transport=jest.fn(async()=>new Response(Buffer.concat([png,Buffer.alloc(2000)]),{status:200,headers:{'content-type':'image/png'}}));
 await expect(resumeXhsMedia(manifest,getUrl,mem.store,transport)).rejects.toThrow('XHS_MEDIA_SIZE_REJECTED');
 expect(mem.saved.has(3)).toBe(false);
});
