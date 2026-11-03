import { createHash, randomUUID } from 'node:crypto';
import { scheduledTaskId } from './xhs-scheduled-admission';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { TRPCError } from '@trpc/server';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  XHS_SUBSCRIPTION_SOURCE,
  XhsSubscriptionSource,
} from './xhs-subscription.service';
import {
  incrementalWrite,
  assertIncrementalTransaction,
  assertIncrementalWriteAdmission,
} from './incremental-write';
import { sqliteWrites } from './sqlite-write-coordinator';
import {
  readCommentWindow,
  readXhsComments,
  readXhsMetrics,
  saveCommentPage,
  saveCommentWindow,
  saveXhsMetrics,
} from './xhs-engagement-store';
import { XhsSourceParseError, XhsSubscriptionError, XhsPreDispatchError, xhsPublicCode } from './xhs-subscription-errors';
import { RedbookPauseError } from './redbook-client';

const fail = (message: string): never => {
  throw new TRPCError({ code: 'PRECONDITION_FAILED', message });
};
@Injectable()
export class XhsEngagementService {
  private active = new Set<string>();
  constructor(
    private readonly db: PrismaService,
    @Optional()
    @Inject(XHS_SUBSCRIPTION_SOURCE)
    private readonly source?: XhsSubscriptionSource,
  ) {}
  private write<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    const work = () => incrementalWrite(this.db, 2_000_000, () =>
      sqliteWrites.write(async () => {
        await assertIncrementalWriteAdmission();
        return this.db.$transaction(async (tx) => {
          await assertIncrementalTransaction(tx);
          return fn(tx);
        });
      }),
    );
    return this.source?.sourceStorage ? this.source.sourceStorage(work) : work();
  }
  private async target(creatorId: string, noteId?: string) {
    const creator = await this.db.xhsCreator.findUnique({
      where: { id: creatorId },
    });
    if (!creator) return fail('XHS_CREATOR_NOT_FOUND');
    let externalNote: string | undefined;
    if (noteId) {
      const note = await this.db.xhsNote.findFirst({
        where: { id: noteId, creatorId },
      });
      if (!note) return fail('XHS_NOTE_NOT_FOUND');
      const tuple = JSON.parse(note.id);
      if (
        !Array.isArray(tuple) ||
        tuple.length !== 3 ||
        tuple[0] !== 'xiaohongshu' ||
        tuple[1] !== 'note' ||
        typeof tuple[2] !== 'string'
      )
        return fail('XHS_NOTE_ID_INVALID');
      externalNote = tuple[2];
    }
    return { creator, externalNote };
  }
  async view(input: {
    creatorId: string;
    noteId: string;
    offset?: number;
    limit?: number;
  }) {
    await this.target(input.creatorId, input.noteId);
    return this.db.$transaction(async (tx) => {
      const [metrics, creatorMetrics, comments] = await Promise.all([
        readXhsMetrics(tx, 'note'),
        readXhsMetrics(tx, 'creator'),
        readXhsComments(tx, input.noteId, input.offset, input.limit),
      ]);
      return {
        metrics: metrics.get(input.noteId) ?? null,
        creatorMetrics: creatorMetrics.get(input.creatorId) ?? null,
        ...comments,
      };
    });
  }
  async refreshMetrics(input: { creatorId: string; noteId?: string }) {
    const { creator, externalNote } = await this.target(
      input.creatorId,
      input.noteId,
    );
    if (!creator.enabled || !creator.externalAuthorId || !this.source?.metrics)
      return fail('XHS_SOURCE_UNAVAILABLE');
    const source = this.source;
    const authorId = creator.externalAuthorId;
    const lock = input.noteId ?? input.creatorId;
    if (this.active.has(lock)) return fail('XHS_ENGAGEMENT_BUSY');
    this.active.add(lock);
    try {
      const work = async () => {
        const snapshot = await source!.metrics!(authorId!, externalNote);
        await this.write(async (tx) => {
          const current = await tx.xhsCreator.findUnique({
            where: { id: creator.id },
          });
          if (
            !current?.enabled ||
            current.externalAuthorId !== creator.externalAuthorId
          )
            return fail('XHS_SUBSCRIPTION_CHANGED');
          await saveXhsMetrics(
            tx,
            input.noteId ? 'note' : 'creator',
            input.noteId ?? creator.id,
            snapshot,
          );
          await this.source?.checkpointWholeSource?.(tx, snapshot.collectedAt);
        });
        return snapshot;
      };
      return source!.withCheckpointGroup
        ? await source!.withCheckpointGroup(
            externalNote ? 'metrics' : 'profile',
            authorId!,
            externalNote,
            work,
          )
        : await work();
    } finally {
      this.active.delete(lock);
    }
  }
  /** Reuse per-note windows; deterministic round identity prevents duplicate pages on tick retries. */
  async collectScheduled(round:string, creatorId:string):Promise<{pending:boolean;incomplete:boolean}> {
    const basicId=scheduledTaskId(round,creatorId,'basic');
    const rows=await this.db.$queryRaw<Array<{state:string;document:string}>>`SELECT state,document FROM xhs_subscription_tasks WHERE id=${basicId} AND creator_id=${creatorId}`;
    if(rows.length!==1)return {pending:false,incomplete:true};
    let basic:any;try{basic=JSON.parse(rows[0].document);}catch{return {pending:false,incomplete:true};}
    const itemPartial=rows[0].state==='partial' && ['XHS_DETAIL_PARSE_FAILED','XHS_DETAIL_OUTCOME_UNKNOWN','XHS_LOCAL_PRE_DISPATCH_FAILED'].includes(basic.code) && basic.remaining===0;
    const historyPartial=rows[0].state==='partial' && basic.code==='XHS_SCHEDULE_HISTORY_REVIEW_REQUIRED' && !basic.failed;
    if(basic.creatorId!==creatorId||basic.taskId!==basicId||basic.schedule?.round!==round||basic.schedule?.phase!=='basic'||!Array.isArray(basic.noteIds)||!['completed','partial'].includes(rows[0].state)|| (rows[0].state==='partial'&&!itemPartial&&!historyPartial))return {pending:false,incomplete:true};
    const excluded=new Set(Array.isArray(basic.historyExcludedIds)?basic.historyExcludedIds:[]);
    const ids=[...new Set<string>(basic.noteIds.filter((id:any)=>typeof id==='string' && !excluded.has(id) && (!itemPartial || basic.items?.[id]==='completed')))];
    const work=async()=>{
    let pending=false,incomplete=false;
    // After a restart, rehydrate only the previously checkpointed list pages.
    // The original task fence binds every page and rejects an unknown replay.
    if(this.source?.hasNoteContext && this.source.restoreScheduledNoteContexts && ids.length){
      const creator=await this.db.xhsCreator.findUnique({where:{id:creatorId}});
      let missing=false;
      if(creator?.externalAuthorId)for(const note of ids){
        let external:string;try{const tuple=JSON.parse(note);if(!Array.isArray(tuple)||typeof tuple[2]!=='string')continue;external=tuple[2];}catch{continue;}
        if(this.source.hasNoteContext(creator.externalAuthorId,external))continue;
        const top=await readCommentWindow(this.db,note,'top');
        const roots=await this.db.$queryRaw<Array<{comment_id:string}>>`SELECT comment_id FROM xhs_saved_comments WHERE note_id=${note} AND root_id IS NULL`;
        const windows=[top];for(const root of roots)windows.push(await readCommentWindow(this.db,note,`root:${root.comment_id}`));
        if(windows.some(window=>!window.pendingDispatch&&(window.scheduledRound!==round||!['returned-end','failed'].includes(window.state)))){missing=true;break;}
      }
      if(missing && basic.listFinished===true && Array.isArray(basic.cursorHistory) && basic.cursorHistory.length>0){
        try{await this.source.restoreScheduledNoteContexts(creator!.externalAuthorId!,basic.cursorHistory);}catch(error){if(error instanceof XhsSubscriptionError && error.code==='XHS_REQUEST_RATE_PAUSED')pending=true;else incomplete=true;}
      }
    }
    for(const noteId of ids){
      try {
        const result=await this.collect({creatorId,noteId,maxPages:5,maxItems:200,scheduledRound:round});
        const top=result.windows.find(w=>w.scope==='top');
        if(!top||top.state==='failed')incomplete=true;else if(top.state==='partial')pending=true;
        const roots=await this.db.$queryRaw<Array<{comment_id:string}>>`SELECT comment_id FROM xhs_saved_comments WHERE note_id=${noteId} AND root_id IS NULL ORDER BY comment_id`;
        for(const root of roots){
          try {
            const replies=await this.collect({creatorId,noteId,rootId:root.comment_id,maxPages:5,maxItems:200,scheduledRound:round});
            const window=replies.windows.find(w=>w.scope===`root:${root.comment_id}`);
            if(!window||window.state==='failed')incomplete=true;else if(window.state==='partial')pending=true;
          } catch { incomplete=true; }
        }
      } catch { incomplete=true; }
    }
    await this.write(async tx=>{
      const rows=await tx.$queryRaw<Array<{state:string;document:string}>>`SELECT state,document FROM xhs_subscription_tasks WHERE id=${basicId} AND creator_id=${creatorId}`;
      if(rows.length!==1)return fail('XHS_COMMENT_RECEIPT_UNCERTAIN');
      const doc=JSON.parse(rows[0].document);
      if(doc.taskId!==basicId||doc.creatorId!==creatorId||doc.state!==rows[0].state||doc.schedule?.round!==round||JSON.stringify(doc.noteIds)!==JSON.stringify(basic.noteIds)||JSON.stringify(doc.historyExcludedIds??[])!==JSON.stringify(basic.historyExcludedIds??[]))return fail('XHS_COMMENT_RECEIPT_UNCERTAIN');
      const summary={round,eligibleNotes:ids.length,completedNotes:0,pendingNotes:0,failedNotes:0,unknownNotes:0,savedComments:0,savedReplies:0,discoveredRoots:0,completedRoots:0,incompleteRoots:0};
      for(let offset=0;offset<ids.length;offset+=100){
        const batch=ids.slice(offset,offset+100);
        const comments=await tx.$queryRaw<Array<{note_id:string;comment_id:string;root_id:string|null}>>`SELECT note_id,comment_id,root_id FROM xhs_saved_comments WHERE note_id IN (${Prisma.join(batch)}) ORDER BY note_id,comment_id`;
        const rows=await tx.$queryRaw<Array<{note_id:string;scope:string;document:string}>>`SELECT note_id,scope,document FROM xhs_comment_windows WHERE note_id IN (${Prisma.join(batch)})`;
        const commentByNote=new Map<string,Array<{comment_id:string;root_id:string|null}>>(),windowsByNote=new Map<string,Map<string,any>>();
        for(const comment of comments){const list=commentByNote.get(comment.note_id)??[];list.push(comment);commentByNote.set(comment.note_id,list);}
        for(const row of rows){let value:any;try{value=JSON.parse(row.document);}catch{return fail('XHS_COMMENT_RECEIPT_UNCERTAIN');}const windows=windowsByNote.get(row.note_id)??new Map<string,any>();windows.set(row.scope,value);windowsByNote.set(row.note_id,windows);}
        for(const noteId of batch){
          const list=commentByNote.get(noteId)??[],roots=list.filter(c=>c.root_id===null),windows=windowsByNote.get(noteId)??new Map<string,any>();
          summary.savedComments+=roots.length;summary.savedReplies+=list.length-roots.length;summary.discoveredRoots+=roots.length;
          const relevant=[windows.get('top'),...roots.map(root=>windows.get(`root:${root.comment_id}`))];
          for(const root of roots){const window=windows.get(`root:${root.comment_id}`);if(window?.scheduledRound===round&&window.state==='returned-end'&&!window.pendingDispatch)summary.completedRoots++;else summary.incompleteRoots++;}
          if(relevant.some(window=>!!window?.pendingDispatch))summary.unknownNotes++;
          else if(relevant.some(window=>window?.scheduledRound===round&&window.state==='failed'))summary.failedNotes++;
          else if(relevant.some(window=>!window||window.scheduledRound!==round||window.state!=='returned-end'))summary.pendingNotes++;
          else summary.completedNotes++;
        }
      }
      doc.commentSummary=summary;
      if(await tx.$executeRaw`UPDATE xhs_subscription_tasks SET document=${JSON.stringify(doc)} WHERE id=${basicId} AND document=${rows[0].document}`!==1)return fail('XHS_COMMENT_RECEIPT_UNCERTAIN');
    });
    return {pending,incomplete};
    };
    return this.source?.withTaskScope ? this.source.withTaskScope({taskId:basicId,creatorId},work) : work();
  }

  /** One explicit, finite request window. No background replay on restart. */
  async collect(input: {
    creatorId: string;
    noteId: string;
    rootId?: string;
    maxPages: number;
    maxItems: number;
    restart?: boolean;
    scheduledRound?: string;
  }) {
    if (
      !Number.isInteger(input.maxPages) ||
      input.maxPages < 1 ||
      input.maxPages > 5 ||
      !Number.isInteger(input.maxItems) ||
      input.maxItems < 1 ||
      input.maxItems > 200
    )
      return fail('XHS_COMMENT_LIMIT_INVALID');
    if(input.scheduledRound !== undefined && !/^\d{4}-\d{2}-\d{2}\/(09:15|14:00|17:30)$/.test(input.scheduledRound)) return fail('XHS_COMMENT_LIMIT_INVALID');
    const { creator, externalNote } = await this.target(
      input.creatorId,
      input.noteId,
    );
    if (!creator.enabled || !creator.externalAuthorId || !this.source?.comments)
      return fail('XHS_SOURCE_UNAVAILABLE');
    const sourceComments = this.source.comments.bind(this.source);
    const authorId = creator.externalAuthorId;
    if (
      this.source.capability &&
      this.source.capability().canCollectComments !== true
    )
      return fail('XHS_COMMENT_COLLECTION_DISABLED');
    // A settled window can be observed after restart without rebuilding a
    // session that will not be used or repeating a completed source request.
    if(input.scheduledRound){
      const existing=await readCommentWindow(this.db,input.noteId,input.rootId?`root:${input.rootId}`:'top');
      if(existing.scheduledRound===input.scheduledRound && ['returned-end','failed'].includes(existing.state))
        return this.view({creatorId:input.creatorId,noteId:input.noteId});
    }
    // Known local precondition: do not persist a dispatch that never began.
    if (this.source.hasNoteContext && !this.source.hasNoteContext(creator.externalAuthorId, externalNote!)) return fail('XHS_ACCESS_CONTEXT_EXPIRED');
    if (!input.scheduledRound && this.source.withTaskScope) {
      const existing=await readCommentWindow(this.db,input.noteId,input.rootId?`root:${input.rootId}`:'top');
      if(existing.pendingDispatch)return fail('XHS_COMMENT_RECEIPT_UNCERTAIN');
    }
    if (this.active.has(input.noteId)) return fail('XHS_ENGAGEMENT_BUSY');
    this.active.add(input.noteId);
    let manualTaskId:string|undefined,manualState:'completed'|'partial'|'failed'='failed';
    try {
      const work=async()=>{
      if (input.rootId) {
        const roots = await this.db.$queryRaw<
          Array<{ root_id: string | null }>
        >`
          SELECT root_id FROM xhs_saved_comments WHERE note_id=${input.noteId} AND comment_id=${input.rootId}`;
        if (roots.length !== 1 || roots[0].root_id !== null)
          return fail('XHS_COMMENT_ROOT_INVALID');
      }
      const scope = input.rootId ? `root:${input.rootId}` : 'top';
      let window = await readCommentWindow(this.db, input.noteId, scope);
      if (window.pendingDispatch) return fail('XHS_COMMENT_RECEIPT_UNCERTAIN');
      let durableWindow = window;
      if (input.scheduledRound && window.scheduledRound === input.scheduledRound && window.state === 'failed')
        return this.view({ creatorId: input.creatorId, noteId: input.noteId });
      if (input.scheduledRound && window.scheduledRound !== input.scheduledRound) {
        window = window.state === 'returned-end'
          ? { scope, nextCursor:'', pages:0, state:'partial', code:null, collectedAt:0, cursors:[], scheduledRound:input.scheduledRound }
          : { ...window, scheduledRound:input.scheduledRound };
      }
      if (input.restart)
        window = {
          scope,
          nextCursor: '',
          pages: 0,
          state: 'partial',
          code: null,
          collectedAt: 0,
          cursors: [],
        };
      let received = 0;
      for (
        let page = 0;
        page < input.maxPages && window.nextCursor !== null;
        page++
      ) {
        const cursor = window.nextCursor;
        const fingerprint = createHash('sha256').update(JSON.stringify([creator.id,input.noteId,scope,cursor])).digest('hex');
        const starting = { ...window, pendingDispatch: { fingerprint, state: 'started' as const } };
        await this.write(async (tx) => {
          const saved = await readCommentWindow(tx, input.noteId, scope);
          if (saved.pendingDispatch || JSON.stringify(saved) !== JSON.stringify(durableWindow)) return fail('XHS_COMMENT_RECEIPT_UNCERTAIN');
          await saveCommentWindow(tx, input.noteId, starting);
        });
        window = starting;
        let responseReceived = false;
        try {
          const result = await sourceComments(
            authorId,
            externalNote!,
            cursor,
            input.rootId,
          );
          responseReceived = true;
          if (
            result.nextCursor !== null &&
            (result.nextCursor === cursor ||
              window.cursors.includes(result.nextCursor))
          )
            throw Error('XHS_COMMENT_CURSOR_CYCLE');
          if (received + result.comments.length > input.maxItems) {
            window = {
              ...window,
              pendingDispatch: undefined,
              state: 'partial',
              code: 'XHS_COMMENT_ITEM_LIMIT',
              collectedAt: Date.now(),
            };
            await this.write((tx) =>
              saveCommentWindow(tx, input.noteId, window),
            );
            durableWindow = window;
            break;
          }
          const next = {
            ...window,
            pendingDispatch: undefined,
            nextCursor: result.nextCursor,
            pages: window.pages + 1,
            cursors: [...window.cursors, cursor],
            state:
              result.nextCursor === null
                ? ('returned-end' as const)
                : ('partial' as const),
            code: null,
            collectedAt: Date.now(),
          };
          if (next.cursors.length > 1000)
            throw Error('XHS_COMMENT_CURSOR_HISTORY_LIMIT');
          await this.write(async (tx) => {
            const current = await tx.xhsCreator.findUnique({
              where: { id: creator.id },
            });
            if (
              !current?.enabled ||
              current.externalAuthorId !== creator.externalAuthorId
            )
              return fail('XHS_SUBSCRIPTION_CHANGED');
            await saveCommentPage(tx, input.noteId, result.comments, next);
          });
          window = next;
          durableWindow = next;
          received += result.comments.length;
        } catch (error) {
          // Local persistence failure may have committed. Never label a newer
          // durable cursor failed or replay it automatically.
          const durable = await readCommentWindow(this.db, input.noteId, scope);
          if (durable.pages > window.pages)
            return fail('XHS_COMMENT_RECEIPT_UNCERTAIN');
          const code =
            error instanceof RedbookPauseError
              ? `XHS_SOURCE_${error.reason.toUpperCase()}_BLOCKED`
              : error instanceof Error &&
                  /^XHS_COMMENT_[A-Z_]+$/.test(error.message)
                ? error.message
                : xhsPublicCode(error, 'XHS_COMMENT_FETCH_FAILED');
          window = {
            ...window,
            ...(responseReceived || error instanceof XhsSourceParseError || error instanceof XhsPreDispatchError || (error instanceof RedbookPauseError && [401,403,406,429,461,471].includes(error.httpStatus ?? 0)) || (error instanceof XhsSubscriptionError && ['XHS_ACCESS_CONTEXT_EXPIRED','XHS_REQUEST_BUDGET_REQUIRED','XHS_REQUEST_BUDGET_EXHAUSTED','XHS_REQUEST_RATE_PAUSED','XHS_SESSION_REQUIRED'].includes(error.code)) ? { pendingDispatch: undefined } : {}),
            state: 'failed',
            code,
            collectedAt: Date.now(),
          };
          await this.write((tx) => saveCommentWindow(tx, input.noteId, window));
          break;
        }
      }
      const result=await this.view({ creatorId: input.creatorId, noteId: input.noteId });
      const resultWindow=result.windows.find(w=>w.scope===scope);
      manualState=resultWindow?.state==='returned-end'?'completed':resultWindow?.state==='partial'?'partial':'failed';
      return result;
      };
      if(!input.scheduledRound && this.source.withTaskScope){
        manualTaskId=randomUUID();
        const task={taskId:manualTaskId,creatorId:creator.id,kind:'list',state:'running',commentManual:true,noteIds:[input.noteId],items:{},total:1,completed:0,skipped:0,failed:0,remaining:1,message:'评论读取中'};
        await this.write(tx=>tx.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES(${manualTaskId},${creator.id},'running',${JSON.stringify(task)},${BigInt(Date.now())})`);
        return await this.source.withTaskScope({taskId:manualTaskId,creatorId:creator.id},work);
      }
      return await work();
    } finally {
      let finalizationFailed=false;
      if(manualTaskId){
        const id=manualTaskId;
        try { await this.write(async tx=>{
          const rows=await tx.$queryRaw<Array<{document:string;state:string}>>`SELECT document,state FROM xhs_subscription_tasks WHERE id=${id} AND creator_id=${creator.id}`;
          if(rows.length!==1||rows[0].state!=='running')return fail('XHS_COMMENT_RECEIPT_UNCERTAIN');
          const task=JSON.parse(rows[0].document);if(task.taskId!==id||task.commentManual!==true)return fail('XHS_COMMENT_RECEIPT_UNCERTAIN');
          task.state=task.sourceActive||task.sourceUnknowns?.length?'blocked':manualState;
          task.completed=task.state==='completed'?1:0;task.failed=task.state==='failed'?1:0;task.remaining=task.state==='completed'||task.state==='failed'?0:1;
          if(task.state==='completed'||task.state==='failed')task.items[input.noteId]=task.state;
          task.message=task.state==='completed'?'评论窗口已读取':task.state==='partial'?'评论窗口未完成':'评论读取未完成';
          if(await tx.$executeRaw`UPDATE xhs_subscription_tasks SET state=${task.state},document=${JSON.stringify(task)},updated_at=${BigInt(Date.now())} WHERE id=${id} AND state='running' AND document=${rows[0].document}`!==1)return fail('XHS_COMMENT_RECEIPT_UNCERTAIN');
        }); } catch { finalizationFailed=true; }
      }
      this.active.delete(input.noteId);
      if(finalizationFailed) return fail('XHS_COMMENT_RECEIPT_UNCERTAIN');
    }
  }
}
