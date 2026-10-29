import { reviewLegacyUnknown } from './xhs-legacy-review';
import { dispatchReviewedWholeSource } from './xhs-source-request-policy';
import { attemptDigest, originalAttemptDigest, createReviewedAttempt, reviewedRecoveryView } from './xhs-reviewed-attempt';
import { reviewWholeUnknown, WholeUnknownReview } from './xhs-whole-unknown-review';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { XhsSubscriptionService } from './xhs-subscription.service';
import { XhsSubscriptionRuntime } from './xhs-subscription-runtime';
import { XhsEngagementService } from './xhs-engagement.service';
import { XhsRequestBudget } from './xhs-request-budget';
import { XhsSqliteBudgetStore } from './xhs-request-budget-store';
import { XhsSubscriptionError, xhsPublicCode } from './xhs-subscription-errors';
import {
  incrementalWrite,
  assertIncrementalTransaction,
  assertIncrementalWriteAdmission,
} from './incremental-write';
import { sqliteWrites } from './sqlite-write-coordinator';
import { startupAudit, waitForStartupAudit, assertDatabaseWritesAllowed } from '../startup-audit';

type Item = {
  started?: Record<string, boolean>;
  metrics?: number;
  top?: number;
  replies?: number;
  archive?: number;
  supplement?: number;
};
type Job = {
  id: string;
  creatorId: string;
  state: string;
  updatedAt: number;
  archiveTask?: string;
  downloadTask?: string;
  listTask?: string;
  listEnd: boolean;
  profile?: number;
  items: Record<string, Item>;
  code?: string;
  lastPauseCode?: string;
  currentNote?: string;
  stage?: string;
  sourceGrant?: {
    creatorId: string;
    authorId: string;
    phases: string[];
    limits: Record<string, number>;
    used: Record<string, number>;
  };
  sourceFence?: { marker: string; phase: string; state: string };
};
/** A finite explicit run over durable existing primitives; restart never dispatches. */
@Injectable()
export class XhsWholeCreatorService implements OnModuleInit {
  private startupRecovery: Promise<void> = Promise.resolve();
  private startupRecoveryStarted = false;
  private destroyed = false;
  private running = new Set<string>();
  private lane = Promise.resolve();
  constructor(
    private readonly db: PrismaService,
    private readonly subscriptions: XhsSubscriptionService,
    private readonly runtime: XhsSubscriptionRuntime,
    private readonly engagement: XhsEngagementService,
  ) {}
  private write<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    return incrementalWrite(this.db, 2_000_000, () =>
      sqliteWrites.write(async () => {
        await assertIncrementalWriteAdmission();
        return this.db.$transaction(async (tx) => {
          await assertIncrementalTransaction(tx);
          return fn(tx);
        });
      }),
    );
  }
  async onModuleInit() {
    if (startupAudit()?.status === 'verifying') {
      this.startupRecovery = waitForStartupAudit().then(async (ok) => {
        if (!ok || this.destroyed) throw new XhsSubscriptionError('XHS_TASK_STATE_CHANGED');
        this.startupRecoveryStarted = true;
        await this.recoverInterrupted();
      });
      void this.startupRecovery.catch(() => {});
      return;
    }
    await this.recoverInterrupted();
  }
  private async readyForMutation() {
    if (this.destroyed) throw new XhsSubscriptionError('XHS_TASK_STATE_CHANGED');
    assertDatabaseWritesAllowed();
    await this.startupRecovery;
    if (this.destroyed) throw new XhsSubscriptionError('XHS_TASK_STATE_CHANGED');
    assertDatabaseWritesAllowed();
  }
  async onModuleDestroy() {
    this.destroyed = true;
    if (this.startupRecoveryStarted) await this.startupRecovery.catch(() => {});
  }
  private async recoverInterrupted() {
    await this.write(
      (tx) => tx.$executeRaw`UPDATE xhs_whole_creator_jobs
      SET state='paused', document=json_set(document,'$.state','paused','$.code','XHS_TASK_INTERRUPTED')
      WHERE state IN ('queued','running')`,
    );
  }
  private async load(
    id: string,
    db: Pick<Prisma.TransactionClient, '$queryRaw'> = this.db,
  ): Promise<Job> {
    const rows = await db.$queryRaw<Array<{ document: string }>>`
      SELECT document FROM xhs_whole_creator_jobs WHERE id=${id}`;
    if (!rows.length) throw new XhsSubscriptionError('XHS_TASK_NOT_FOUND');
    return JSON.parse(rows[0].document);
  }
  private async save(job: Job) {
    job.updatedAt = Date.now();
    const changed = await this.write(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ document: string }>
      >`SELECT document FROM xhs_whole_creator_jobs WHERE id=${job.id}`;
      if (rows.length !== 1) return 0;
      const durable = JSON.parse(rows[0].document);
      const document: Record<string, any> = { ...job, items: { ...job.items } };
      if (
        typeof durable.profile === 'number' &&
        durable.profile > (job.profile ?? 0)
      )
        document.profile = durable.profile;
      for (const [id, previous] of Object.entries(durable.items ?? {}) as Array<
        [string, Item]
      >) {
        if (
          previous.metrics &&
          previous.metrics > (document.items[id]?.metrics ?? 0)
        )
          document.items[id] = {
            ...document.items[id],
            metrics: previous.metrics,
          };
      }
      for (const key of ['sourceFence', 'sourceGrant', 'lastSourceOwnerReceipt', 'unknownReview', 'reviewAttempt']) {
        if (durable[key] !== undefined) document[key] = durable[key];
        else delete document[key];
      }
      return tx.$executeRaw`UPDATE xhs_whole_creator_jobs
      SET state=${job.state},document=${JSON.stringify(document)},updated_at=${BigInt(job.updatedAt)} WHERE id=${job.id} AND (state <> 'cancelled' OR ${job.state}='cancelled')`;
    });
    if (changed !== 1) throw new XhsSubscriptionError('XHS_TASK_STATE_CHANGED');
  }
  async start(input: {
    creatorId: string;
    requestLimit: number;
    intervalMs: number;
  }) {
    await this.readyForMutation();
    if (
      !Number.isSafeInteger(input.requestLimit) ||
      input.requestLimit < 1 ||
      input.requestLimit > 100000 ||
      !Number.isSafeInteger(input.intervalMs) ||
      input.intervalMs < 1000 ||
      input.intervalMs > 60000
    )
      throw new XhsSubscriptionError('XHS_REQUEST_POLICY_INVALID');
    const creator = await this.db.xhsCreator.findUnique({
      where: { id: input.creatorId },
    });
    if (!creator?.enabled || !creator.externalAuthorId)
      throw new XhsSubscriptionError('XHS_SUBSCRIPTION_REQUIRED');
    const job: Job = {
      id: randomUUID(),
      creatorId: input.creatorId,
      state: 'queued',
      updatedAt: Date.now(),
      listEnd: false,
      items: {},
    };
    await this.write(async (tx) => {
      // Paused unfinished jobs must be resumed, not replaced with fresh budgets.
      const pending = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM xhs_whole_creator_jobs
        WHERE creator_id=${job.creatorId} AND state NOT IN ('completed')`;
      if (pending.length) throw new XhsSubscriptionError('XHS_TASK_CONFLICT');
      await tx.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,interval_ms)
        VALUES(${job.id},${input.requestLimit},${input.intervalMs})`;
      await tx.$executeRaw`INSERT INTO xhs_whole_creator_jobs(id,creator_id,state,document,updated_at)
        VALUES(${job.id},${job.creatorId},${job.state},${JSON.stringify(job)},${BigInt(job.updatedAt)})`;
    });
    this.schedule(job.id);
    return this.view(job.id);
  }
  /** Explicitly prepare a bounded history-review grant; never schedules work. */
  async prepareHistoryGrant(input: {
    creatorId: string;
    expectedAuthorId: string;
    jobId?: string;
    requestLimit: number;
    intervalMs: number;
    phaseLimits: Record<
      'profile' | 'list' | 'detail' | 'media' | 'metrics',
      number
    >;
  }) {
    await this.readyForMutation();
    const phases = ['profile', 'list', 'detail', 'media', 'metrics'] as const;
    if (
      !input.phaseLimits ||
      Object.keys(input.phaseLimits).length !== phases.length ||
      phases.some(
        (p) => !Object.prototype.hasOwnProperty.call(input.phaseLimits, p),
      ) ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(input.expectedAuthorId) ||
      !Number.isSafeInteger(input.requestLimit) ||
      input.requestLimit < 1 ||
      input.requestLimit > 100000 ||
      !Number.isSafeInteger(input.intervalMs) ||
      input.intervalMs < 1000 ||
      input.intervalMs > 60000 ||
      phases.some(
        (p) =>
          !Number.isSafeInteger(input.phaseLimits[p]) ||
          input.phaseLimits[p] < 0 ||
          input.phaseLimits[p] > input.requestLimit,
      )
    )
      throw new XhsSubscriptionError('XHS_REQUEST_POLICY_INVALID');
    return this.write(async (tx) => {
      const risk = await tx.$queryRaw<
        Array<{ state: string; code: string }>
      >`SELECT state,code FROM xhs_source_risk WHERE id='source'`;
      if (
        risk.length !== 1 ||
        risk[0].state !== 'blocked' ||
        risk[0].code !== 'XHS_SOURCE_HISTORY_REVIEW_REQUIRED'
      )
        throw new XhsSubscriptionError('XHS_SOURCE_RISK_REVIEW_REQUIRED');
      const unresolved = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT original.id FROM xhs_limited_recovery original WHERE original.state IN ('armed','started','unknown') AND NOT EXISTS(SELECT 1 FROM xhs_limited_recovery_append followup WHERE followup.id=original.id AND followup.note_id=original.note_id AND followup.author_id=original.author_id AND followup.state='finished') LIMIT 1`;
      if (unresolved.length)
        throw new XhsSubscriptionError('XHS_SOURCE_RISK_REVIEW_REQUIRED');
      const markers = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%' LIMIT 1`;
      if (markers.length)
        throw new XhsSubscriptionError('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
      const creator = await tx.xhsCreator.findUnique({
        where: { id: input.creatorId },
      });
      if (
        !creator?.enabled ||
        creator.externalAuthorId !== input.expectedAuthorId
      )
        throw new XhsSubscriptionError('XHS_AUTHOR_MISMATCH');
      let job: Job;
      if (input.jobId) {
        const rows = await tx.$queryRaw<
          Array<{ document: string; state: string }>
        >`SELECT document,state FROM xhs_whole_creator_jobs WHERE id=${input.jobId} AND creator_id=${input.creatorId}`;
        if (rows.length !== 1 || rows[0].state !== 'paused')
          throw new XhsSubscriptionError('XHS_TASK_NOT_RESUMABLE');
        job = JSON.parse(rows[0].document) as Job;
        if (
          job.sourceFence ||
          job.sourceGrant ||
          ![
            'XHS_SOURCE_HISTORY_REVIEW_REQUIRED',
            'XHS_SOURCE_VERIFICATION_BLOCKED',
          ].includes(job.code ?? '')
        )
          throw new XhsSubscriptionError('XHS_TASK_NOT_RESUMABLE');
        const budget = await new XhsSqliteBudgetStore(tx).read(job.id);
        if (
          !budget ||
          budget.limit !== input.requestLimit ||
          budget.intervalMs !== input.intervalMs
        )
          throw new XhsSubscriptionError('XHS_REQUEST_POLICY_INVALID');
      } else {
        const pending = await tx.$queryRaw<
          Array<{ id: string }>
        >`SELECT id FROM xhs_whole_creator_jobs WHERE creator_id=${input.creatorId} AND state <> 'completed'`;
        if (pending.length) throw new XhsSubscriptionError('XHS_TASK_CONFLICT');
        job = {
          id: randomUUID(),
          creatorId: input.creatorId,
          state: 'paused',
          updatedAt: Date.now(),
          listEnd: false,
          items: {},
          code: 'XHS_SOURCE_HISTORY_REVIEW_REQUIRED',
        };
        await tx.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,interval_ms) VALUES(${job.id},${input.requestLimit},${input.intervalMs})`;
        await tx.$executeRaw`INSERT INTO xhs_whole_creator_jobs(id,creator_id,state,document,updated_at) VALUES(${job.id},${job.creatorId},'paused',${JSON.stringify(job)},${BigInt(job.updatedAt)})`;
      }
      job.sourceGrant = {
        creatorId: input.creatorId,
        authorId: input.expectedAuthorId,
        phases: [...phases],
        limits: { ...input.phaseLimits },
        used: { profile: 0, list: 0, detail: 0, media: 0, metrics: 0 },
      };
      const changed =
        await tx.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(job)},updated_at=${BigInt(Date.now())} WHERE id=${job.id} AND state='paused'`;
      if (changed !== 1)
        throw new XhsSubscriptionError('XHS_TASK_STATE_CHANGED');
      return { id: job.id, state: 'paused' as const };
    });
  }
  /** Extend only the selected stage cap; used counters and job/global budgets stay intact. */
  async extendHistoryPhase(input: {
    id: string;
    phase: 'profile' | 'list' | 'detail' | 'media' | 'metrics';
    newLimit: number;
  }) {
    await this.readyForMutation();
    if (
      !['profile', 'list', 'detail', 'media', 'metrics'].includes(
        input.phase,
      ) ||
      !Number.isSafeInteger(input.newLimit)
    )
      throw new XhsSubscriptionError('XHS_REQUEST_POLICY_INVALID');
    return this.write(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ document: string }>
      >`SELECT document FROM xhs_whole_creator_jobs WHERE id=${input.id} AND state='paused'`;
      if (rows.length !== 1)
        throw new XhsSubscriptionError('XHS_TASK_NOT_RESUMABLE');
      const job = JSON.parse(rows[0].document) as Job;
      const risk = await tx.$queryRaw<
        Array<{ state: string; code: string }>
      >`SELECT state,code FROM xhs_source_risk WHERE id='source'`;
      const creator = await tx.xhsCreator.findUnique({
        where: { id: job.creatorId },
      });
      const budget = await new XhsSqliteBudgetStore(tx).read(job.id);
      const pending = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%' LIMIT 1`;
      if (
        job.sourceFence ||
        pending.length > 0 ||
        !job.sourceGrant ||
        risk.length !== 1 ||
        risk[0].state !== 'blocked' ||
        risk[0].code !== 'XHS_SOURCE_HISTORY_REVIEW_REQUIRED' ||
        !creator?.enabled ||
        creator.externalAuthorId !== job.sourceGrant.authorId ||
        job.sourceGrant.creatorId !== job.creatorId ||
        !budget ||
        !Number.isSafeInteger(job.sourceGrant.limits[input.phase]) ||
        input.newLimit <= job.sourceGrant.limits[input.phase] ||
        input.newLimit > budget.limit
      )
        throw new XhsSubscriptionError('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
      job.sourceGrant.limits[input.phase] = input.newLimit;
      const changed =
        await tx.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(job)},updated_at=${BigInt(Date.now())} WHERE id=${input.id} AND state='paused' AND document=${rows[0].document}`;
      if (changed !== 1)
        throw new XhsSubscriptionError('XHS_TASK_STATE_CHANGED');
      return { id: job.id, state: 'paused' as const };
    });
  }
  async prepareReviewedAttempt(input:{jobId:string;confirmUnknownRetry:true;confirmLegacyUnknown?:true}) {
    await this.readyForMutation();
    if(input.confirmUnknownRetry!==true)throw new XhsSubscriptionError('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
    return this.write(async tx=>{
      const rows=await tx.$queryRaw<Array<{document:string;author:string}>>`SELECT j.document,c.external_author_id AS author FROM xhs_whole_creator_jobs j JOIN xhs_creators c ON c.id=j.creator_id WHERE j.id=${input.jobId} AND j.state='paused'`;
      if(rows.length!==1)throw new XhsSubscriptionError('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
      let job=JSON.parse(rows[0].document);const f=job.sourceFence;
      if(f&&!job.unknownReview){
        if(f.owner===undefined) await reviewLegacyUnknown(tx,input.jobId,rows[0].author,input.confirmLegacyUnknown===true);
        else await reviewWholeUnknown(tx,{jobId:input.jobId,expectedAuthorId:rows[0].author,expectedMarker:f.marker,expectedNoteId:f.noteId,decision:'request-retry'});
        const current=await tx.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_whole_creator_jobs WHERE id=${input.jobId} AND state='paused'`;
        if(current.length!==1)throw new XhsSubscriptionError('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
        job=JSON.parse(current[0].document);
      }
      const budgets=await tx.$queryRaw<Array<{id:string;used:number}>>`SELECT id,used FROM xhs_request_budgets WHERE id IN (${input.jobId},'xhs:source-total')`;
      const task=budgets.find(b=>b.id===input.jobId),shared=budgets.find(b=>b.id==='xhs:source-total');
      if(!task||!shared||!f||!job.unknownReview)throw new XhsSubscriptionError('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
      if(f?.owner===undefined&&input.confirmLegacyUnknown!==true)throw new XhsSubscriptionError('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
      const scope=job.reviewAttempt?.scope ?? {...(f.owner===undefined?{legacyProofId:job.legacyMaintenanceProof?.proofId}:{}),jobId:input.jobId,authorId:rows[0].author,noteId:f.noteId,phase:f.phase,originalHash:originalAttemptDigest(job),reviewId:attemptDigest(job.unknownReview),maxRequests:1,taskUsedCeiling:task.used+1,sharedUsedCeiling:shared.used+1,expiresAt:Date.now()+900000};
      if(scope.jobId!==input.jobId||scope.maxRequests!==1)throw new XhsSubscriptionError('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
      return createReviewedAttempt(tx,scope);
    });
  }
  async executeReviewedAttempt(input:{jobId:string;attemptId:string;url:string;confirmUnknownRetry:true}) {
    await this.readyForMutation();
    if(input.confirmUnknownRetry!==true)throw new XhsSubscriptionError('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
    const rows=await this.db.$queryRaw<Array<{document:string;creator_id:string}>>`SELECT document,creator_id FROM xhs_whole_creator_jobs WHERE id=${input.jobId} AND state='paused'`;
    if(rows.length!==1)throw new XhsSubscriptionError('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
    const job=JSON.parse(rows[0].document),a=job.reviewAttempt;
    if(!a||a.id!==input.attemptId||a.scope?.jobId!==input.jobId||attemptDigest(a.scope)!==a.id)throw new XhsSubscriptionError('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
    this.runtime.validateReviewedInput(input.url,a.scope);
    const ready=this.runtime.reviewedReadyCheck();
    try {
      return await dispatchReviewedWholeSource(this.db,a.scope,a.id,{authorId:a.scope.authorId,noteId:a.scope.noteId,phase:a.scope.phase},ready,permit=>this.runtime.resolveReviewedNote(input.url,a.scope,permit),(tx,result)=>this.subscriptions.commitReviewedRecovery(tx,rows[0].creator_id,result));
    } catch(error) {
      const code=this.runtime.reviewedFailureCode();
      if(code)await this.write(async tx=>{
        await tx.$executeRaw`UPDATE xhs_source_risk SET state='blocked',code=${code} WHERE id='source'`;
        const current=await tx.$queryRaw<Array<{document:string}>>`SELECT document FROM xhs_whole_creator_jobs WHERE id=${input.jobId} AND state='paused'`;
        if(current.length===1){
          const durable=JSON.parse(current[0].document);
          if(durable.reviewAttempt?.id===a.id&&durable.reviewAttempt.state==='consumed'){
            durable.reviewAttempt.failureCode=code;
            await tx.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(durable)} WHERE id=${input.jobId} AND state='paused' AND document=${current[0].document}`;
          }
        }
      });
      throw error;
    }
  }
  async reviewUnknown(input: WholeUnknownReview) {
    await this.readyForMutation();
    return this.write((tx) => reviewWholeUnknown(tx, input));
  }
  async resume(id: string) {
    await this.readyForMutation();
    await this.write(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ state: string; document: string }>
      >`
        SELECT state,document FROM xhs_whole_creator_jobs WHERE id=${id}`;
      if (rows.length !== 1) throw new XhsSubscriptionError('XHS_TASK_NOT_FOUND');
      if (
        this.running.has(id) ||
        !['paused', 'partial', 'failed', 'cancelled'].includes(rows[0].state)
      )
        throw new XhsSubscriptionError('XHS_TASK_NOT_RESUMABLE');
      const job = JSON.parse(rows[0].document) as Job;
      if (job.sourceFence)
        throw new XhsSubscriptionError('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
      job.state = 'queued';
      if (job.code) job.lastPauseCode = job.code;
      delete job.code;
      job.updatedAt = Date.now();
      // Explicit resume may consume cancelled state; ordinary saves may not.
      const changed = await tx.$executeRaw`UPDATE xhs_whole_creator_jobs
        SET state='queued',document=${JSON.stringify(job)},updated_at=${BigInt(job.updatedAt)}
        WHERE id=${id} AND state=${rows[0].state} AND document=${rows[0].document}`;
      if (changed !== 1)
        throw new XhsSubscriptionError('XHS_TASK_NOT_RESUMABLE');
    });
    this.schedule(id);
    return this.view(id);
  }
  async extend(id: string, additional: number) {
    await this.readyForMutation();
    if (
      !Number.isSafeInteger(additional) ||
      additional < 1 ||
      additional > 100000
    )
      throw new XhsSubscriptionError('XHS_REQUEST_POLICY_INVALID');
    const job = await this.load(id);
    if (job.sourceFence)
      throw new XhsSubscriptionError('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
    if (job.sourceGrant) {
      if (this.running.has(id))
        throw new XhsSubscriptionError('XHS_TASK_NOT_RESUMABLE');
      await this.write(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ document: string }>>`
          SELECT document FROM xhs_whole_creator_jobs WHERE id=${id} AND state='paused'`;
        if (rows.length !== 1)
          throw new XhsSubscriptionError('XHS_TASK_NOT_RESUMABLE');
        const current = JSON.parse(rows[0].document) as Job;
        const pending = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM xhs_request_budgets WHERE id LIKE 'xhs:dispatch-pending:%' LIMIT 1`;
        const risk = await tx.$queryRaw<Array<{ state: string; code: string }>>`
          SELECT state,code FROM xhs_source_risk WHERE id='source'`;
        const creator = await tx.xhsCreator.findUnique({
          where: { id: current.creatorId },
        });
        if (
          current.sourceFence ||
          pending.length ||
          !current.sourceGrant ||
          ![
            'XHS_REQUEST_BUDGET_EXHAUSTED',
            'XHS_WHOLE_PHASE_BUDGET_EXHAUSTED',
          ].includes(current.code ?? '') ||
          risk.length !== 1 ||
          risk[0].state !== 'blocked' ||
          risk[0].code !== 'XHS_SOURCE_HISTORY_REVIEW_REQUIRED' ||
          !creator?.enabled ||
          creator.externalAuthorId !== current.sourceGrant.authorId ||
          current.sourceGrant.creatorId !== current.creatorId
        )
          throw new XhsSubscriptionError('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
        const changed = await tx.$executeRaw`UPDATE xhs_request_budgets
          SET request_limit=request_limit+${additional} WHERE id=${id} AND request_limit+${additional}<=100000`;
        if (changed !== 1)
          throw new XhsSubscriptionError('XHS_REQUEST_POLICY_INVALID');
      });
      // Explicit continuation is a separate operator action after all limits are reviewed.
      return this.view(id);
    }
    if (
      this.running.has(id) ||
      job.state !== 'paused' ||
      job.code !== 'XHS_REQUEST_BUDGET_EXHAUSTED'
    )
      throw new XhsSubscriptionError('XHS_TASK_NOT_RESUMABLE');
    await this.write(
      (tx) => tx.$executeRaw`UPDATE xhs_request_budgets
      SET request_limit=request_limit+${additional} WHERE id=${id} AND request_limit+${additional}<=100000`,
    );
    return this.resume(id);
  }
  async cancel(id: string) {
    await this.readyForMutation();
    const job = await this.load(id);
    if (job.state === 'completed') return this.view(id);
    job.state = 'cancelled';
    await this.save(job);
    if (job.listTask)
      await this.subscriptions.cancelTask({ taskId: job.listTask });
    if (job.archiveTask)
      await this.subscriptions.cancelTask({ taskId: job.archiveTask });
    if (job.downloadTask && job.downloadTask !== job.archiveTask)
      await this.subscriptions.cancelTask({ taskId: job.downloadTask });
    return this.view(id);
  }
  private schedule(id: string) {
    this.running.add(id);
    this.lane = this.lane
      .then(() => this.run(id))
      .catch(() => {})
      .finally(() => this.running.delete(id));
  }
  private async checkpointChild(job: Job, taskId: string) {
    try {
      await this.save(job);
    } catch (error) {
      // A cancellation/unknown parent checkpoint must not orphan a dispatched child.
      await this.subscriptions.cancelTask({ taskId });
      throw error;
    }
  }
  private async check(job: Job, db: Prisma.TransactionClient = this.db) {
    const saved = await this.load(job.id, db);
    if (saved.state === 'cancelled')
      throw new XhsSubscriptionError('XHS_TASK_CANCELLED');
    if (!['queued', 'running'].includes(saved.state))
      throw new XhsSubscriptionError('XHS_TASK_STATE_CHANGED');
    const creator = await db.xhsCreator.findUnique({
      where: { id: job.creatorId },
    });
    if (!creator?.enabled)
      throw new XhsSubscriptionError('XHS_SUBSCRIPTION_CHANGED');
  }
  private async waitList(job: Job) {
    for (;;) {
      await this.check(job);
      const task = await this.subscriptions.task({ taskId: job.listTask! });
      if (!['queued', 'running'].includes(task.state)) {
        if (task.state !== 'completed')
          throw new XhsSubscriptionError(task.code ?? 'XHS_LIST_INCOMPLETE');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  /** Both stages use the original full-media saver and durable positive receipts. */
  private async saveStage(
    job: Job,
    notes: { id: string }[],
    phase: 'archive' | 'supplement',
  ) {
    const taskKey = phase === 'archive' ? 'archiveTask' : 'downloadTask';
    await this.check(job);
    job.stage = phase;
    delete job.currentNote;
    await this.save(job);
    const harvest = async (taskId: string) => {
      const receipts =
        phase === 'archive'
          ? await this.subscriptions.confirmedLocalArchives({ taskId })
          : await this.subscriptions.confirmedLocalSaves({ taskId });
      for (const receipt of receipts)
        if (job.items[receipt.noteId]) {
          job.items[receipt.noteId][phase] = receipt.savedAt;
          if (
            phase === 'archive' &&
            'metricsCollectedAt' in receipt &&
            Number.isSafeInteger(receipt.metricsCollectedAt) &&
            (receipt.metricsCollectedAt as number) > 0
          )
            job.items[receipt.noteId].metrics =
              receipt.metricsCollectedAt as number;
        }
      if (phase === 'supplement') {
        for (const receipt of await this.subscriptions.confirmedLocalArchives({
          taskId,
        }))
          if (job.items[receipt.noteId])
            job.items[receipt.noteId].archive = receipt.savedAt;
      }
    };
    const prior = job[taskKey]
      ? await this.subscriptions.task({ taskId: job[taskKey] })
      : undefined;
    if (prior?.state === 'completed') {
      await harvest(job[taskKey]!);
      await this.save(job);
    }
    const toSave = notes
      .filter((note) => !job.items[note.id]?.[phase])
      .map((note) => note.id);
    if (toSave.length) {
      if (!job[taskKey] || prior?.state === 'completed') {
        const task = await this.subscriptions.downloadNotes({
          creatorId: job.creatorId,
          noteIds: toSave,
          sameDirectoryAsTaskId:
            prior?.state === 'completed'
              ? job[taskKey]
              : phase === 'supplement'
                ? job.archiveTask
                : undefined,
        });
        job[taskKey] = task.taskId;
        await this.checkpointChild(job, task.taskId);
      } else if (prior && !['queued', 'running'].includes(prior.state)) {
        const next = await this.subscriptions.resumeTask({
          taskId: job[taskKey],
        });
        job[taskKey] = next.taskId;
        await this.checkpointChild(job, next.taskId);
      }
      const listing = job.listTask;
      job.listTask = job[taskKey];
      try {
        await this.waitList(job);
      } finally {
        job.listTask = listing;
        await harvest(job[taskKey]!);
        await this.save(job);
      }
      // A legacy resumed task may contain completed items without the new archive receipt.
      // Reconfirm only those files through the protected saver, in the same directory.
      if (
        phase === 'archive' &&
        prior &&
        prior.state !== 'completed' &&
        notes.some((note) => !job.items[note.id]?.archive)
      )
        await this.saveStage(job, notes, phase);
    }
  }
  private async run(id: string) {
    const job = await this.load(id);
    try {
      await this.check(job);
      job.state = 'running';
      await this.save(job);
      const store = new XhsSqliteBudgetStore(this.db);
      // Serialize admission with short cancellable waits; every retry reaches the same durable gate.
      const receipts = new Map<number, number>();
      const budget = new XhsRequestBudget({
        read: (key) => store.read(key),
        assertReady: (tx) => this.check(job, tx),
        rollback: async (key, before) => {
          const at = receipts.get(before.used + 1);
          if (at === undefined) return false;
          receipts.delete(before.used + 1);
          return this.write((tx) =>
            new XhsSqliteBudgetStore(tx).rollback(key, before, at),
          );
        },
        reserve: async (key) => {
          for (;;) {
            await this.check(job);
            if (
              await this.write(async (tx) => {
                const gate = new XhsSqliteBudgetStore(tx);
                const before = await gate.read(key),
                  at = Date.now();
                if (!(await gate.reserve(key, at))) return false;
                receipts.clear();
                receipts.set(before!.used + 1, at);
                return true;
              })
            )
              return true;
            const current = await store.read(key);
            if (!current || current.used >= current.limit) return false;
            await new Promise((resolve) =>
              setTimeout(
                resolve,
                Math.min(1000, Math.max(1, current.nextAt - Date.now())),
              ),
            );
          }
        },
      });
      const runWithBudget = () =>
        this.runtime.withRequestBudget(budget, id, async () => {
          if (!job.listEnd) {
            if (!job.listTask) {
              const task = await this.subscriptions.refresh({
                id: job.creatorId,
              });
              job.listTask = task.taskId;
              await this.checkpointChild(job, task.taskId);
            } else {
              const prior = await this.subscriptions.task({
                taskId: job.listTask,
              });
              if (!['queued', 'running', 'completed'].includes(prior.state)) {
                const next = await this.subscriptions.resumeTask({
                  taskId: job.listTask,
                });
                job.listTask = next.taskId;
                await this.checkpointChild(job, next.taskId);
              }
            }
            await this.waitList(job);
            job.listEnd = true;
            await this.save(job);
          }
          // An explicit zero detail cap is a directory-only stop, not permission
          // to launch an archive child or issue a speculative detail request.
          if (job.sourceGrant && job.sourceGrant.limits.detail === 0)
            throw new XhsSubscriptionError('XHS_WHOLE_PHASE_BUDGET_EXHAUSTED');
          const notes = await this.db.xhsNote.findMany({
            where: { creatorId: job.creatorId },
            orderBy: { id: 'asc' },
            select: { id: true },
          });
          for (const note of notes) job.items[note.id] ??= {};
          // Adopt the old download child on upgrade, preserving its directory and receipts.
          if (!job.archiveTask && job.downloadTask) {
            job.archiveTask = job.downloadTask;
            delete job.downloadTask;
          }
          // A first-note comment failure must not prevent the rest of the full archives.
          await this.saveStage(job, notes, 'archive');
          if (!job.profile) {
            await this.check(job);
            const snapshot = await this.engagement.refreshMetrics({
              creatorId: job.creatorId,
            });
            job.profile = snapshot.collectedAt;
            await this.save(job);
          }
          for (const note of notes) {
            await this.check(job);
            job.currentNote = note.id;
            const item = (job.items[note.id] ??= {});
            if (!item.metrics) {
              job.stage = 'metrics';
              await this.save(job);
              const snapshot = await this.engagement.refreshMetrics({
                creatorId: job.creatorId,
                noteId: note.id,
              });
              item.metrics = snapshot.collectedAt;
              await this.save(job);
            }
          }
          await this.saveStage(job, notes, 'supplement');
        });
      if (job.sourceGrant)
        await this.runtime.withWholeAuthorization(
          {
            jobId: job.id,
            creatorId: job.creatorId,
            authorId: job.sourceGrant.authorId,
          },
          runWithBudget,
        );
      else await runWithBudget();
      job.state = Object.values(job.items).every(
        (item) => item.archive && item.supplement && item.metrics,
      )
        ? 'completed'
        : 'partial';
      if (job.state === 'partial') job.code = 'XHS_MEDIA_OR_SUPPLEMENT_PENDING';
    } catch (error) {
      const current = await this.load(id);
      job.state = current.state === 'cancelled' ? 'cancelled' : 'paused';
      job.code = xhsPublicCode(error, 'XHS_WHOLE_CREATOR_PAUSED');
    }
    await this.save(job);
  }
  async view(id: string) {
    const job = await this.load(id),
      budget = await new XhsSqliteBudgetStore(this.db).read(id);
    const notes = await this.db.xhsNote.findMany({
      where: { creatorId: job.creatorId },
      orderBy: { id: 'asc' },
      select: { id: true, title: true },
    });
    const { sourceGrant, sourceFence, unknownReview, reviewAttempt, lastSourceOwnerReceipt, legacyMaintenanceProof, ...visibleJob } = job as Job & Record<string, any>;
    return {
      ...visibleJob,
      reviewedRecovery: reviewedRecoveryView(job),
      budget,
      sourceTotalKnown: false,
      historyGrant: sourceGrant
        ? { limits: sourceGrant.limits, used: sourceGrant.used }
        : undefined,
      sourceCheckpoint: sourceFence
        ? {
            phase: sourceFence.phase,
            state:
              job.state === 'running'
                ? ('in-progress' as const)
                : /^XHS_SOURCE_(?:AUTHENTICATION|VERIFICATION|UNKNOWN_REJECTION|PERMISSION|SIGNATURE|RATE_LIMIT)_BLOCKED$/.test(
                      job.code ?? '',
                    )
                  ? ('restricted' as const)
                  : ('unknown' as const),
          }
        : undefined,
      resumable:
        !sourceFence &&
        !this.running.has(id) &&
        ['paused', 'partial', 'failed', 'cancelled'].includes(job.state),
      items: notes.map((note) => ({
        noteId: note.id,
        title: note.title,
        ...job.items[note.id],
        archive: job.items[note.id]?.archive
          ? ('saved' as const)
          : ('pending' as const),
        engagement:
          job.items[note.id]?.metrics &&
          job.items[note.id]?.top &&
          job.items[note.id]?.replies
            ? ('returned-range-complete' as const)
            : job.items[note.id]?.metrics
              ? ('metrics-only' as const)
              : job.items[note.id]?.top || job.items[note.id]?.started
                ? ('partial' as const)
                : ('unknown' as const),
        localSave: job.items[note.id]?.supplement
          ? ('saved' as const)
          : job.code === 'XHS_TASK_RECEIPT_UNCERTAIN'
            ? ('unknown' as const)
            : ('pending' as const),
        status: job.items[note.id]?.supplement
          ? 'returned-range-complete'
          : job.currentNote === note.id && job.code
            ? 'restricted'
            : 'pending',
        reason: job.currentNote === note.id ? job.code : undefined,
        stage: job.currentNote === note.id ? job.stage : undefined,
        supplement: job.items[note.id]?.supplement ? 'saved' : 'pending',
        deletion: 'unknown',
      })),
      message:
        'Only the discovered accessible range is tracked. This run collects metrics without comment pages; previously saved comments may be incomplete. Private, deleted and unreturned content remain unknown; local supplements are separate.',
    };
  }
  async recent(creatorId: string) {
    const rows = await this.db.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM xhs_whole_creator_jobs WHERE creator_id=${creatorId} ORDER BY updated_at DESC LIMIT 20`;
    return Promise.all(rows.map((row) => this.view(row.id)));
  }
}
