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
import { readCommentWindow, saveCommentWindow } from './xhs-engagement-store';
import {
  incrementalWrite,
  assertIncrementalTransaction,
  assertIncrementalWriteAdmission,
} from './incremental-write';
import { sqliteWrites } from './sqlite-write-coordinator';

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
  currentNote?: string;
  stage?: string;
};
/** A finite explicit run over durable existing primitives; restart never dispatches. */
@Injectable()
export class XhsWholeCreatorService implements OnModuleInit {
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
    const document = JSON.stringify(job);
    const changed = await this.write(
      (tx) => tx.$executeRaw`UPDATE xhs_whole_creator_jobs
      SET state=${job.state},document=${document},updated_at=${BigInt(job.updatedAt)} WHERE id=${job.id} AND (state <> 'cancelled' OR ${job.state}='cancelled')`,
    );
    if (changed !== 1) throw new XhsSubscriptionError('XHS_TASK_STATE_CHANGED');
  }
  async start(input: {
    creatorId: string;
    requestLimit: number;
    intervalMs: number;
  }) {
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
  async resume(id: string) {
    const job = await this.load(id);
    if (
      this.running.has(id) ||
      !['paused', 'partial', 'failed', 'cancelled'].includes(job.state)
    )
      throw new XhsSubscriptionError('XHS_TASK_NOT_RESUMABLE');
    const previous = job.state;
    job.state = 'queued';
    delete job.code;
    job.updatedAt = Date.now();
    // Explicit resume may consume cancelled state; ordinary saves may not.
    const changed = await this.write(
      (tx) => tx.$executeRaw`UPDATE xhs_whole_creator_jobs
      SET state='queued',document=${JSON.stringify(job)},updated_at=${BigInt(job.updatedAt)}
      WHERE id=${id} AND state=${previous}`,
    );
    if (changed !== 1) throw new XhsSubscriptionError('XHS_TASK_NOT_RESUMABLE');
    this.schedule(id);
    return this.view(id);
  }
  async extend(id: string, additional: number) {
    if (
      !Number.isSafeInteger(additional) ||
      additional < 1 ||
      additional > 100000
    )
      throw new XhsSubscriptionError('XHS_REQUEST_POLICY_INVALID');
    const job = await this.load(id);
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
  private async comments(job: Job, noteId: string, rootId?: string) {
    const scope = rootId ? `root:${rootId}` : 'top';
    const item = job.items[noteId];
    item.started ??= {};
    if (!item.started[scope]) {
      item.started[scope] = true;
      // Generation reset and durable work marker must commit together.
      await this.write(async (tx) => {
        await saveCommentWindow(tx, noteId, {
          scope,
          nextCursor: '',
          pages: 0,
          state: 'partial',
          code: null,
          collectedAt: 0,
          cursors: [],
        });
        const changed =
          await tx.$executeRaw`UPDATE xhs_whole_creator_jobs SET document=${JSON.stringify(job)} WHERE id=${job.id} AND state='running'`;
        if (changed !== 1)
          throw new XhsSubscriptionError('XHS_TASK_STATE_CHANGED');
      });
    }
    for (;;) {
      await this.check(job);
      const before = await readCommentWindow(this.db, noteId, scope);
      if (before.nextCursor === null && before.state === 'returned-end') return;
      const result = await this.engagement.collect({
        creatorId: job.creatorId,
        noteId,
        rootId,
        maxPages: 1,
        maxItems: 200,
      });
      const after = result.windows.find((w) => w.scope === scope);
      if (!after || after.state === 'failed' || after.pages <= before.pages)
        throw new XhsSubscriptionError(
          after?.code ?? 'XHS_COMMENT_NO_PROGRESS',
        );
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
        if (job.items[receipt.noteId])
          job.items[receipt.noteId][phase] = receipt.savedAt;
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
      await this.runtime.withRequestBudget(budget, id, async () => {
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
          if (!item.top) {
            job.stage = 'comments';
            await this.save(job);
            await this.comments(job, note.id);
            item.top = Date.now();
            await this.save(job);
          }
          if (!item.replies) {
            job.stage = 'replies';
            await this.save(job);
            const roots = await this.db.$queryRaw<
              Array<{ comment_id: string }>
            >`SELECT comment_id FROM xhs_saved_comments WHERE note_id=${note.id} AND root_id IS NULL ORDER BY comment_id`;
            for (const root of roots)
              await this.comments(job, note.id, root.comment_id);
            item.replies = Date.now();
            await this.save(job);
          }
        }
        await this.saveStage(job, notes, 'supplement');
      });
      job.state = Object.values(job.items).every(
        (item) =>
          item.archive &&
          item.supplement &&
          item.metrics &&
          item.top &&
          item.replies,
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
    return {
      ...job,
      budget,
      sourceTotalKnown: false,
      resumable:
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
            : job.items[note.id]?.metrics ||
                job.items[note.id]?.top ||
                job.items[note.id]?.started
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
        'Only the discovered accessible range is tracked. Private, deleted and unreturned content remain unknown; local supplements are separate.',
    };
  }
  async recent(creatorId: string) {
    const rows = await this.db.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM xhs_whole_creator_jobs WHERE creator_id=${creatorId} ORDER BY updated_at DESC LIMIT 20`;
    return Promise.all(rows.map((row) => this.view(row.id)));
  }
}
