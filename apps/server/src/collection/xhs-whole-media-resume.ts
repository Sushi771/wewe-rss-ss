import type { Prisma } from '@prisma/client';
import { xhsMediaTaskStore } from './xhs-media-task-store';
import { resumeXhsMedia, type XhsMediaManifest } from './xhs-native-media';
import { XhsSubscriptionRuntime } from './xhs-subscription-runtime';

type Tx = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;
type Writer = <T>(work: (tx: Tx) => Promise<T>) => Promise<T>;
type Scope = { jobId:string; creatorId:string; taskId:string; generationId?:string };

/** Internal only: the caller supplies an already authorized running whole job.
 * A missing session URL stays pending and never triggers another detail request. */
export async function resumeWholeMedia(db:Tx, write:Writer, runtime:XhsSubscriptionRuntime, scope:Scope, manifest:XhsMediaManifest) {
  const noteId=JSON.stringify(['xiaohongshu','note',manifest.noteId]);
  type Hooks = Parameters<Parameters<XhsSubscriptionRuntime['withWholeMediaAttempt']>[1]>[0];
  let hooks: Hooks | undefined;
  const required = () => { if(!hooks) throw Error('XHS_WHOLE_SOURCE_FENCE_BLOCKED'); return hooks; };
  const raw=xhsMediaTaskStore(db,write,{taskId:scope.taskId,creatorId:scope.creatorId,noteId},
    tx=>required().reserve(tx as Prisma.TransactionClient),
    tx=>required().checkpoint(tx as Prisma.TransactionClient),true);
  const store={...raw,
    begin:async (...args:Parameters<typeof raw.begin>)=>{await raw.begin(...args);required().reserved();},
    commit:async (...args:Parameters<typeof raw.commit>)=>hooks?hooks.storage(()=>raw.commit(...args)):raw.commit(...args),
    fail:async (...args:Parameters<typeof raw.fail>)=>hooks?hooks.storage(()=>raw.fail(...args)):raw.fail(...args),
  };
  return resumeXhsMedia(manifest,key=>runtime.getTransientMediaUrl(manifest.authorId,manifest.noteId,manifest.version,key),store,
    (url,request)=>required().transport(url,request),
    async (ordinal,work)=>{
      const resourceKey=manifest.images[ordinal-1]?.resourceKey;
      if(!resourceKey) throw Error('XHS_MEDIA_REVIEW_REQUIRED');
      return runtime.withWholeMediaAttempt({...scope,authorId:manifest.authorId,noteId:manifest.noteId,mediaAttempt:{taskId:scope.taskId,ordinal,resourceKey}},async current=>{
        if(hooks) throw Error('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
        hooks=current;
        current.dispatch(tx=>raw.startIn(tx,manifest,ordinal));
        try { return await work(); } finally { hooks=undefined; }
      });
    });
}
