import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { load } from 'cheerio';
import { decodeInlineImage } from './image-fetch';
import { verifiedDownloadBody } from '../article-verified-download';
import type { XhsMediaManifest, XhsMediaResumeStore } from './xhs-native-media';

type Tx=Pick<Prisma.TransactionClient,'$queryRaw'|'$executeRaw'>;
type Writer=<T>(fn:(tx:Tx)=>Promise<T>)=>Promise<T>;
type Gate=(tx:Tx,manifest:XhsMediaManifest,ordinal:number)=>Promise<void>;
const bad=():never=>{throw Error('XHS_MEDIA_REVIEW_REQUIRED')};
const hash=(s:Buffer)=>createHash('sha256').update(s).digest('hex');

/** Local task storage only. The caller must supply the existing durable source gate;
 * without it, this store cannot reserve or send any media request. */
export function xhsMediaTaskStore(db:Tx,write:Writer,scope:{taskId:string;creatorId:string;noteId:string},gate:Gate,settle?:Gate,prepareOnly=false,options:{allowCompleteAppend?:boolean}={}):XhsMediaResumeStore & {adoptVerified:(manifest:XhsMediaManifest)=>Promise<number>; startIn:(tx:Tx,manifest:XhsMediaManifest,ordinal:number)=>Promise<void>} {
  async function read(tx:Tx,manifest:XhsMediaManifest){
    if(JSON.stringify(['xiaohongshu','note',manifest.noteId])!==scope.noteId)return bad();
    const rows=await tx.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_subscription_tasks WHERE id=${scope.taskId} AND creator_id=${scope.creatorId}`;
    if(rows.length!==1)return bad();
    const task=JSON.parse(rows[0].document),slot=task.mediaManifests?.[scope.noteId];
    const saved=slot?.manifest;
    if(!saved||saved.authorId!==manifest.authorId||saved.noteId!==manifest.noteId||saved.version!==manifest.version||!Array.isArray(saved.images)||saved.images.length!==manifest.images.length||saved.images.some((image:any,i:number)=>image.ordinal!==manifest.images[i].ordinal||image.resourceKey!==manifest.images[i].resourceKey))return bad();
    return {raw:rows[0].document,task,slot};
  }
  async function save(tx:Tx,raw:string,task:any){
    const n=await tx.$executeRaw`UPDATE xhs_subscription_tasks SET document=${JSON.stringify(task)},updated_at=${BigInt(Date.now())} WHERE id=${scope.taskId} AND creator_id=${scope.creatorId} AND document=${raw}`;
    if(n!==1)return bad();
  }
  async function verified(tx:Tx,manifest:XhsMediaManifest,ordinal:number):Promise<string|null>{
    const {slot}=await read(tx,manifest),receipt=slot.items?.[String(ordinal)];
    if(receipt?.state!=='saved'||typeof receipt.sha256!=='string'||receipt.resourceKey!==manifest.images[ordinal-1]?.resourceKey)return null;
    const rows=await tx.$queryRaw<Array<{content_html:string|null}>>`SELECT content_html FROM xhs_notes WHERE id=${scope.noteId} AND creator_id=${scope.creatorId}`;
    if(rows.length!==1||!rows[0].content_html)return null;
    const markerVersion=receipt.markerVersion??manifest.version,markerOrdinal=receipt.markerOrdinal??ordinal;
    if(!/^[a-f0-9]{64}$/.test(markerVersion)||!Number.isSafeInteger(markerOrdinal)||markerOrdinal<1||markerOrdinal>60)return null;
    const $=load(rows[0].content_html),marker=`${markerVersion}:${markerOrdinal}`;
    const nodes=$('img').toArray().filter(node=>$(node).attr('data-xhs-media')===marker);
    if(nodes.length!==1)return null;
    const raw=$(nodes[0]).attr('src');if(!raw)return null;
    try {return hash(decodeInlineImage(raw).bytes)===receipt.sha256?raw:null;}catch{return null;}
  }
  return {
    adoptVerified: async manifest => write(async tx=>{
      const current=await read(tx,manifest);
      const all=await tx.$queryRaw<Array<{id:string;document:string}>>`SELECT id,document FROM xhs_subscription_tasks WHERE creator_id=${scope.creatorId} AND id<>${scope.taskId} AND EXISTS (SELECT 1 FROM json_each(document,'$.mediaManifests') WHERE key=${scope.noteId})`;
      const notes=await tx.$queryRaw<Array<{content_html:string|null}>>`SELECT content_html FROM xhs_notes WHERE id=${scope.noteId} AND creator_id=${scope.creatorId}`;
      if(notes.length!==1||!notes[0].content_html)return 0;
      const $=load(notes[0].content_html), candidates:Array<{key:string;item:any;version:string;ordinal:number}>=[];
      let unresolved=false;
      for(const row of all){
        let prior:any;try{prior=JSON.parse(row.document).mediaManifests?.[scope.noteId];}catch{return bad();}
        const m=prior?.manifest;if(!m||m.authorId!==manifest.authorId||m.noteId!==manifest.noteId||!Array.isArray(m.images)||m.images.length>60||hash(Buffer.from(JSON.stringify([m.authorId,m.noteId,m.images])))!==m.version)continue;
        for(const im of m.images){
          if(!Number.isSafeInteger(im.ordinal)||im.ordinal<1||im.ordinal>m.images.length||m.images[im.ordinal-1]?.resourceKey!==im.resourceKey||!/^[a-f0-9]{64}$/.test(im.resourceKey??''))return bad();
          const item=prior.items?.[String(im.ordinal)];
          if(['prepared','started','unknown','restricted'].includes(item?.state))unresolved=true;
          if(item?.state==='saved'&&item.resourceKey===im.resourceKey)candidates.push({key:im.resourceKey,item,version:m.version,ordinal:im.ordinal});
        }
      }
      if(unresolved)return bad();
      // A changed source fingerprint cannot prove whether this is a new image
      // or a new signed URL for one already saved. Leave it for review.
      if($('img').length && !candidates.length && manifest.images.some(image=>image.resourceKey && current.slot.items?.[String(image.ordinal)]?.state!=='saved'))return -1;
      if(candidates.length && manifest.images.some(image=>image.resourceKey && !current.slot.items?.[String(image.ordinal)] && !candidates.some(c=>c.key===image.resourceKey)))return -1;
      let count=0;
      for(const image of manifest.images){
        if(!image.resourceKey||current.slot.items?.[String(image.ordinal)])continue;
        for(const c of candidates.filter(x=>x.key===image.resourceKey)){
          const v=c.item.markerVersion??c.version,o=c.item.markerOrdinal??c.ordinal;
          if(!/^[a-f0-9]{64}$/.test(v)||!Number.isSafeInteger(o)||o<1||o>60||!/^[a-f0-9]{64}$/.test(c.item.sha256??''))continue;
          const marker=`${v}:${o}`,nodes=$('img').toArray().filter(node=>$(node).attr('data-xhs-media')===marker);
          if(nodes.length!==1)continue;const inline=$(nodes[0]).attr('src');if(!inline)continue;
          let bytes:Buffer;try{bytes=decodeInlineImage(inline).bytes;}catch{continue;}
          if(hash(bytes)!==c.item.sha256||bytes.length!==c.item.bytes)continue;
          await gate(tx,manifest,image.ordinal);
          current.slot.items={...current.slot.items,[String(image.ordinal)]:{state:'saved',resourceKey:image.resourceKey,sha256:c.item.sha256,bytes:bytes.length,markerVersion:v,markerOrdinal:o}};
          count++;break;
        }
      }
      if(count)await save(tx,current.raw,current.task);
      return count;
    }),
    readVerifiedOrdinal:async(manifest,ordinal)=>verified(db,manifest,ordinal),
    readVerified:async(manifest,key)=>{
      for(const image of manifest.images)if(image.resourceKey===key){const value=await verified(db,manifest,image.ordinal);if(value!==null)return value;}
      return null;
    },
    attemptState:async(manifest,ordinal)=>{
      const {slot}=await read(db,manifest),state=slot.items?.[String(ordinal)]?.state;
      if(state==='saved')return (await verified(db,manifest,ordinal))!==null?'ready':'stop';
      return state==='prepared'||state==='started'||state==='unknown'||state==='restricted'?'stop':state==='refresh'?'refresh':'ready';
    },
    begin:async(manifest,ordinal)=>write(async tx=>{
      const {raw,task,slot}=await read(tx,manifest),image=manifest.images[ordinal-1];
      if(!image||image.ordinal!==ordinal||!image.resourceKey||slot.items?.[String(ordinal)])return bad();
      const notes=await tx.$queryRaw<Array<{content_html:string|null;status:string}>>`SELECT content_html,status FROM xhs_notes WHERE id=${scope.noteId} AND creator_id=${scope.creatorId}`;
      if(notes.length!==1||!notes[0].content_html||(notes[0].status==='complete'&&!options.allowCompleteAppend))return bad();
      verifiedDownloadBody(notes[0].content_html);
      await gate(tx,manifest,ordinal);
      slot.items={...slot.items,[String(ordinal)]:{state:prepareOnly?'prepared':'started',resourceKey:image.resourceKey}};
      await save(tx,raw,task);
    }),
    startIn:async(tx,manifest,ordinal)=>{
      const {raw,task,slot}=await read(tx,manifest),image=manifest.images[ordinal-1],item=slot.items?.[String(ordinal)];
      if(!prepareOnly||!image?.resourceKey||item?.state!=='prepared'||item.resourceKey!==image.resourceKey)return bad();
      item.state='started';
      await save(tx,raw,task);
    },
    commit:async(manifest,ordinal,inlineData)=>write(async tx=>{
      const {raw,task,slot}=await read(tx,manifest),image=manifest.images[ordinal-1],prior=slot.items?.[String(ordinal)];
      if(!image?.resourceKey||prior?.state==='unknown'||prior?.state==='restricted'||prior?.state==='saved')return bad();
      const bytes=decodeInlineImage(inlineData).bytes,sha256=hash(bytes);
      if(prior?.state!=='started'){
        let matched=false;
        for(const candidate of manifest.images)if(candidate.ordinal!==ordinal&&candidate.resourceKey===image.resourceKey){const previous=await verified(tx,manifest,candidate.ordinal);if(previous===inlineData){matched=true;break;}}
        if(!matched)return bad();
      }
      const rows=await tx.$queryRaw<Array<{content_html:string|null;status:string}>>`SELECT content_html,status FROM xhs_notes WHERE id=${scope.noteId} AND creator_id=${scope.creatorId}`;
      const html=rows[0]?.content_html;
      if(rows.length!==1||!html||(rows[0].status==='complete'&&!options.allowCompleteAppend)||!/^\s*<div\b[^>]*id=["']js_content["']/i.test(html)||!/<\/div>\s*$/i.test(html))return bad();
      const marker=`${manifest.version}:${ordinal}`;if(html.includes(`data-xhs-media="${marker}"`))return bad();
      const updated=html.replace(/<\/div>\s*$/i,`<img data-xhs-media="${marker}" src="${inlineData}"></div>`);
      verifiedDownloadBody(updated);
      const changed=await tx.$executeRaw`UPDATE xhs_notes SET content_html=${updated} WHERE id=${scope.noteId} AND creator_id=${scope.creatorId} AND content_html=${html}`;
      if(changed!==1)return bad();
      slot.items={...slot.items,[String(ordinal)]:{state:'saved',resourceKey:image.resourceKey,sha256,bytes:bytes.length}};
      await save(tx,raw,task);
      if (prior?.state === 'started' && settle) await settle(tx,manifest,ordinal);
    }),
    fail:async(manifest,ordinal,code)=>write(async tx=>{
      const {raw,task,slot}=await read(tx,manifest),item=slot.items?.[String(ordinal)];
      if(item?.state!=='started')return bad();
      item.state=code==='XHS_MEDIA_HTTP_404'||code==='XHS_MEDIA_HTTP_410'?'refresh':'unknown';
      item.code=item.state==='refresh'?code:'XHS_MEDIA_OUTCOME_UNKNOWN';
      await save(tx,raw,task);
      if (item.state === 'refresh' && settle) await settle(tx,manifest,ordinal);
    }),
  };
}
