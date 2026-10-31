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
export function xhsMediaTaskStore(db:Tx,write:Writer,scope:{taskId:string;creatorId:string;noteId:string},gate:Gate,settle?:Gate,prepareOnly=false):XhsMediaResumeStore & {startIn:(tx:Tx,manifest:XhsMediaManifest,ordinal:number)=>Promise<void>} {
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
    const $=load(rows[0].content_html),marker=`${manifest.version}:${ordinal}`;
    const nodes=$('img').toArray().filter(node=>$(node).attr('data-xhs-media')===marker);
    if(nodes.length!==1)return null;
    const raw=$(nodes[0]).attr('src');if(!raw)return null;
    try {return hash(decodeInlineImage(raw).bytes)===receipt.sha256?raw:null;}catch{return null;}
  }
  return {
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
      if(notes.length!==1||!notes[0].content_html||notes[0].status==='complete')return bad();
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
      if(rows.length!==1||!html||rows[0].status==='complete'||!/^\s*<div\b[^>]*id=["']js_content["']/i.test(html)||!/<\/div>\s*$/i.test(html))return bad();
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
