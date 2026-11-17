import {
  assertChannelRunnable,
  historyArchived,
  visibleHistory,
  taskDatabaseFor,
  withChannelExecution,
} from './channel-task-control';
import {
  prepareBatchLocalCancellation,
  confirmBatchLocalCancellation,
} from './xhs-batch-local-cancellation';
import { sqliteWrites } from './sqlite-write-coordinator';
import {
  incrementalWrite,
  assertIncrementalWriteAdmission,
  assertIncrementalTransaction,
} from './incremental-write';
import { createVerifiedSqliteBackup } from './sqlite-backup';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import { XhsSubscriptionService } from './xhs-subscription.service';
import { XhsSubscriptionError, xhsPublicCode } from './xhs-subscription-errors';

type Item = {
  position: number;
  creator_id: string;
  operation_id: string | null;
  state: string;
  outcome: string | null;
};
type Batch = { id: string; state: string };

/** Persistent orchestration; an unproved reserved operation is never sent again. */
export class XiaohongshuBatches {
  constructor(
    private readonly db: PrismaClient,
    private readonly xhs: XhsSubscriptionService,
    private readonly cancellationBackup: () => Promise<unknown> = createVerifiedSqliteBackup,
  ) {}

  /** Read-only preview: returns only a digest and the exact cancelled scope. */
  async prepareLocalCancellation(batchId: string) {
    await this.xhs.assertBatchLocalCancellationIdle();
    const plan = await this.db.$transaction((tx) =>
      prepareBatchLocalCancellation(tx, batchId),
    );
    return plan.state === 'cancelled'
      ? {
          state: plan.state,
          batchId,
          digest: plan.digest,
          position: plan.receipt.position,
          creatorId: plan.receipt.creatorId,
          operationId: plan.receipt.operationId,
          cancelledCount: plan.receipt.originalItems.length,
        }
      : {
          state: plan.state,
          batchId,
          digest: plan.digest,
          position: plan.item.position,
          creatorId: plan.item.creator_id,
          operationId: plan.item.operation_id!,
          cancelledCount: plan.snapshot.items.length,
        };
  }
  /** Explicit local cancellation; never calls stop(), advance(), run() or a source. */
  async confirmLocalCancellation(input: {
    batchId: string;
    digest: string;
    acknowledgedNotDispatched: true;
  }) {
    await this.xhs.assertBatchLocalCancellationIdle();
    let database = '',
      version = '',
      backupSha256 = '';
    const fingerprint = async (file: string) =>
      JSON.stringify(
        await Promise.all(
          [file, file + '-wal', file + '-journal'].map(async (name) => {
            try {
              const s = await stat(name, { bigint: true });
              if (!s.isFile() || !s.ino) throw new Error('identity');
              return [
                String(s.dev),
                String(s.ino),
                String(s.size),
                String(s.mtimeNs),
                String(s.ctimeNs),
              ];
            } catch (error) {
              if (
                (error as NodeJS.ErrnoException).code === 'ENOENT' &&
                name !== file
              )
                return null;
              throw new XhsSubscriptionError('XHS_BATCH_LOCAL_REVIEW_REQUIRED');
            }
          }),
        ),
      );
    const result = await sqliteWrites.protectedWrite(
      async () => {
        await this.xhs.assertBatchLocalCancellationIdle();
        const plan = await this.db.$transaction((tx) =>
          prepareBatchLocalCancellation(tx, input.batchId),
        );
        if (
          plan.digest !== input.digest ||
          input.acknowledgedNotDispatched !== true
        )
          throw new XhsSubscriptionError('XHS_BATCH_LOCAL_REVIEW_CHANGED');
        if (plan.state === 'cancelled') return;
        const rows = await this.db.$queryRawUnsafe<
          Array<{ name: string; file: string }>
        >('PRAGMA database_list');
        const main = rows.find((row) => row.name === 'main');
        if (!main?.file)
          throw new XhsSubscriptionError('XHS_BATCH_LOCAL_REVIEW_REQUIRED');
        database = await realpath(main.file);
        version = await fingerprint(database);
        const report = (await this.cancellationBackup()) as any;
        if (
          !report ||
          typeof report.source !== 'string' ||
          (await realpath(report.source)) !== database ||
          typeof report.backup !== 'string' ||
          (await realpath(report.backup)) === database ||
          !/^[a-f0-9]{64}$/.test(report.sha256 ?? '') ||
          report.integrityCheck !== 'ok' ||
          report.recoveryOrigin?.format !== 'sqlite-recovery-origin-v1' ||
          report.recoveryOrigin?.kind !== 'protected'
        )
          throw new XhsSubscriptionError('XHS_BATCH_LOCAL_REVIEW_REQUIRED');
        const digest = createHash('sha256');
        for await (const bytes of createReadStream(report.backup))
          digest.update(bytes);
        if (digest.digest('hex') !== report.sha256)
          throw new XhsSubscriptionError('XHS_BATCH_LOCAL_REVIEW_REQUIRED');
        backupSha256 = report.sha256;
      },
      () =>
        incrementalWrite(this.db, 65536, async () => {
          await assertIncrementalWriteAdmission();
          await this.xhs.assertBatchLocalCancellationIdle();
          return this.db.$transaction(async (tx) => {
            await assertIncrementalTransaction(tx);
            if (database) {
              const rows = await tx.$queryRawUnsafe<
                Array<{ name: string; file: string }>
              >('PRAGMA database_list');
              const main = rows.find((row) => row.name === 'main');
              if (
                !main?.file ||
                (await realpath(main.file)) !== database ||
                (await fingerprint(database)) !== version
              )
                throw new XhsSubscriptionError(
                  'XHS_BATCH_LOCAL_REVIEW_CHANGED',
                );
            }
            return confirmBatchLocalCancellation(
              tx,
              input,
              backupSha256,
              Date.now(),
            );
          });
        }),
    );
    const sourceStatusRefreshed =
      await this.xhs.refreshAfterBatchLocalCancellation();
    return {
      batch: await this.status(input.batchId),
      alreadyCancelled: result.alreadyCancelled,
      sourceStatusRefreshed,
    };
  }

  async create(...input: Parameters<XiaohongshuBatches['createOwned']>) {
    return withChannelExecution(
      'xiaohongshu',
      () => this.createOwned(...input),
      { kind: 'xhs-batch', id: input[0] },
      await taskDatabaseFor(this.db),
    );
  }
  private async createOwned(id: string, ids: string[]) {
    await assertChannelRunnable(
      'xiaohongshu',
      { kind: 'xhs-batch', id },
      await taskDatabaseFor(this.db),
    );
    if (
      !/^[a-f0-9-]{36}$/.test(id) ||
      !ids.length ||
      ids.length > 100 ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !id || id.length > 128)
    )
      throw new Error('XHS_BATCH_INVALID');
    await this.db.$transaction(async (tx) => {
      const previous = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM xhs_refresh_batches WHERE id=${id}`;
      if (previous.length) {
        const items = await tx.$queryRaw<
          Array<{ creator_id: string }>
        >`SELECT creator_id FROM xhs_refresh_batch_items WHERE batch_id=${id} ORDER BY position`;
        if (
          JSON.stringify(items.map((i) => i.creator_id)) !== JSON.stringify(ids)
        )
          throw new Error('XHS_BATCH_ID_CONFLICT');
        return;
      }
      for (const creatorId of ids) {
        const creator = await tx.xhsCreator.findUnique({
          where: { id: creatorId },
          select: { enabled: true },
        });
        if (!creator?.enabled) throw new Error('XHS_BATCH_CREATOR_INVALID');
      }
      await tx.$executeRaw`INSERT INTO xhs_refresh_batches(id,state,created_at) VALUES(${id},'running',${Date.now()})`;
      for (const [position, creatorId] of ids.entries())
        await tx.$executeRaw`INSERT INTO xhs_refresh_batch_items(batch_id,position,creator_id,state) VALUES(${id},${position},${creatorId},'queued')`;
    });
    return this.status(id);
  }

  async active() {
    const rows = await this.db.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM xhs_refresh_batches WHERE state IN ('running','paused')`;
    const visible = await visibleHistory(
      'xiaohongshu',
      'xhs-batch',
      rows,
      (r) => r.id,
      await taskDatabaseFor(this.db),
    );
    if (visible.length > 1) throw new Error('XHS_BATCH_CORRUPT');
    return visible.length ? this.status(visible[0].id) : null;
  }

  async status(id: string) {
    const rows = await this.db.$queryRaw<
      Batch[]
    >`SELECT id,state FROM xhs_refresh_batches WHERE id=${id}`;
    if (rows.length !== 1) throw new Error('XHS_BATCH_NOT_FOUND');
    const items = await this.db.$queryRaw<
      Item[]
    >`SELECT position,creator_id,operation_id,state,outcome FROM xhs_refresh_batch_items WHERE batch_id=${id} ORDER BY position`;
    return {
      id: rows[0].id,
      archived: await historyArchived(
        'xiaohongshu',
        'xhs-batch',
        id,
        await taskDatabaseFor(this.db),
      ),
      state: rows[0].state,
      items: items.map((i) => ({
        position: i.position,
        creatorId: i.creator_id,
        operationId: i.operation_id,
        state: i.state,
        outcome: i.outcome ? JSON.parse(i.outcome) : null,
      })),
    };
  }

  async stop(id: string) {
    const operation = await this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Batch[]
      >`SELECT id,state FROM xhs_refresh_batches WHERE id=${id}`;
      if (rows.length !== 1) throw new Error('XHS_BATCH_NOT_FOUND');
      if (rows[0].state === 'complete') return null;
      const reserved = await tx.$queryRaw<
        Item[]
      >`SELECT position,creator_id,operation_id,state,outcome FROM xhs_refresh_batch_items WHERE batch_id=${id} AND state='reserved'`;
      if (reserved.length > 1) throw new Error('XHS_BATCH_CORRUPT');
      if (rows[0].state === 'stopped') return reserved[0]?.operation_id ?? null;
      if (reserved.length) {
        const item = reserved[0];
        if (!item.operation_id) throw new Error('XHS_BATCH_CORRUPT');
        const op = item.operation_id;
        const task = await tx.$queryRaw<
          Array<{ id: string }>
        >`SELECT id FROM xhs_subscription_tasks WHERE id=${op} AND creator_id=${item.creator_id}`;
        // A task reservation is not a legacy source request. Preserve its own
        // checkpoint/fence; never manufacture a stopped legacy job for it.
        if (!task.length) {
          const changed =
            await tx.$executeRaw`UPDATE xhs_refresh_jobs SET state='stopped' WHERE creator_id=${item.creator_id} AND owner=${op} AND state='running'`;
          if (!changed) {
            const existing = await tx.$queryRaw<
              Array<{ state: string }>
            >`SELECT state FROM xhs_refresh_jobs WHERE creator_id=${item.creator_id} AND owner=${op}`;
            if (!existing.length)
              await tx.$executeRaw`INSERT INTO xhs_refresh_jobs(creator_id,generation,owner,started_at,state) SELECT ${item.creator_id},COALESCE(MAX(generation),0)+1,${op},${Date.now()},'stopped' FROM xhs_refresh_jobs WHERE creator_id=${item.creator_id}`;
            else if (!['stopped', 'complete'].includes(existing[0].state))
              throw new Error('XHS_BATCH_STOP_UNCONFIRMED');
          }
        }
      }
      await tx.$executeRaw`UPDATE xhs_refresh_batches SET state='stopped' WHERE id=${id}`;
      await tx.$executeRaw`UPDATE xhs_refresh_batch_items SET state='cancelled' WHERE batch_id=${id} AND state='queued'`;
      return reserved[0]?.operation_id ?? null;
    });
    if (operation) {
      const tasks = await this.db.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM xhs_subscription_tasks WHERE id=${operation}`;
      if (tasks.length) await this.xhs.cancelTask({ taskId: operation });
    }
    return this.status(id);
  }

  async advance(...input: Parameters<XiaohongshuBatches['advanceOwned']>) {
    return withChannelExecution(
      'xiaohongshu',
      () => this.advanceOwned(...input),
      { kind: 'xhs-batch', id: input[0] },
      await taskDatabaseFor(this.db),
    );
  }
  private async advanceOwned(id: string) {
    await assertChannelRunnable(
      'xiaohongshu',
      { kind: 'xhs-batch', id },
      await taskDatabaseFor(this.db),
    );
    const reservation = await this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Batch[]
      >`SELECT id,state FROM xhs_refresh_batches WHERE id=${id}`;
      if (rows.length !== 1) throw new Error('XHS_BATCH_NOT_FOUND');
      if (!['running', 'paused'].includes(rows[0].state)) return null;
      const existing = await tx.$queryRaw<
        Item[]
      >`SELECT position,creator_id,operation_id,state,outcome FROM xhs_refresh_batch_items WHERE batch_id=${id} AND state='reserved'`;
      if (existing.length > 1) throw new Error('XHS_BATCH_CORRUPT');
      if (existing.length) return { item: existing[0], fresh: false };
      if (rows[0].state === 'paused') return null;
      const next = await tx.$queryRaw<
        Item[]
      >`SELECT position,creator_id,operation_id,state,outcome FROM xhs_refresh_batch_items WHERE batch_id=${id} AND state='queued' ORDER BY position LIMIT 1`;
      if (!next.length) {
        await tx.$executeRaw`UPDATE xhs_refresh_batches SET state='complete' WHERE id=${id} AND state='running'`;
        return null;
      }
      return { item: next[0], fresh: true };
    });
    if (!reservation) return this.status(id);
    let { item } = reservation;
    if (reservation.fresh) {
      try {
        const started = await this.xhs.startBatchItem({
          batchId: id,
          position: item.position,
          creatorId: item.creator_id,
        });
        if ('state' in started && started.state === 'deferred')
          return this.status(id);
        item = { ...item, operation_id: started.taskId, state: 'reserved' };
      } catch (error) {
        // Inspect durable state before reporting a failure. A committed or
        // concurrent reservation is only observed, never launched again.
        const observed = await this.status(id);
        const current = observed.items.find(
          (entry) => entry.position === item.position,
        );
        if (!current || current.state !== 'queued' || current.operationId)
          return observed;
        throw new XhsSubscriptionError(
          xhsPublicCode(error, 'XHS_LOCAL_OPERATION_FAILED'),
        );
      }
    }
    if (!item.operation_id) throw new Error('XHS_BATCH_CORRUPT');
    let receipt: {
      status: 'complete' | 'partial';
      added: number;
      message: string;
      failureScope?: 'article';
      failedCount?: number;
    } | null = null;
    let legacyReceipt: string | undefined;
    const storedTask = await this.db.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM xhs_subscription_tasks WHERE id=${item.operation_id} AND creator_id=${item.creator_id}`;
    if (storedTask.length === 1) {
      try {
        const task = await this.xhs.task({ taskId: item.operation_id });
        if (
          task.creatorId !== item.creator_id ||
          task.taskId !== item.operation_id
        )
          throw new Error('XHS_BATCH_CORRUPT');
        if (task.state === 'queued' || task.state === 'running')
          return this.status(id);
        if (task.state === 'completed')
          receipt = {
            status: 'complete',
            added: task.completed,
            message: task.message,
          };
      } catch {
        return this.status(id);
      }
    } else {
      // Older reservations are never replayed. Only their exact durable receipt
      // may settle the item; absence or an incomplete receipt pauses the batch.
      const jobs = await this.db.$queryRaw<
        Array<{ state: string; outcome: string | null }>
      >`SELECT state,outcome FROM xhs_refresh_jobs WHERE creator_id=${item.creator_id} AND owner=${item.operation_id}`;
      if (
        jobs.length === 1 &&
        jobs[0].state === 'complete' &&
        jobs[0].outcome
      ) {
        try {
          const value = JSON.parse(jobs[0].outcome);
          if (
            (value.status === 'complete' || value.status === 'partial') &&
            Number.isSafeInteger(value.added) &&
            value.added >= 0 &&
            typeof value.message === 'string'
          ) {
            receipt = value;
            legacyReceipt = jobs[0].outcome;
          }
        } catch {
          /* malformed legacy receipt remains paused */
        }
      }
    }
    await this.db.$transaction(async (tx) => {
      const b = await tx.$queryRaw<
        Batch[]
      >`SELECT id,state FROM xhs_refresh_batches WHERE id=${id}`;
      if (b.length !== 1 || !['running', 'paused'].includes(b[0].state)) return;
      const current = await tx.$queryRaw<
        Item[]
      >`SELECT position,creator_id,operation_id,state,outcome FROM xhs_refresh_batch_items WHERE batch_id=${id} AND position=${item.position}`;
      if (
        current.length !== 1 ||
        current[0].state !== 'reserved' ||
        current[0].operation_id !== item.operation_id
      )
        throw new Error('XHS_BATCH_CHANGED');
      if (!receipt) {
        await tx.$executeRaw`UPDATE xhs_refresh_batches SET state='paused' WHERE id=${id} AND state IN ('running','paused')`;
        return;
      }
      const outcome = receipt;
      const accepted =
        outcome.status === 'complete' ||
        (outcome.status === 'partial' &&
          outcome.failureScope === 'article' &&
          Number.isSafeInteger(outcome.failedCount) &&
          outcome.failedCount! > 0);
      if (!accepted) {
        await tx.$executeRaw`UPDATE xhs_refresh_batches SET state='paused' WHERE id=${id} AND state IN ('running','paused')`;
        return;
      }
      const serialized = legacyReceipt ?? JSON.stringify(outcome);
      const state = outcome.status;
      if (!legacyReceipt)
        await tx.$executeRaw`INSERT INTO xhs_refresh_jobs(creator_id,generation,owner,started_at,state,outcome) SELECT ${item.creator_id},COALESCE(MAX(generation),0)+1,${item.operation_id},${Date.now()},'complete',${serialized} FROM xhs_refresh_jobs WHERE creator_id=${item.creator_id}`;
      await tx.$executeRaw`UPDATE xhs_refresh_batch_items SET state=${state},outcome=${serialized} WHERE batch_id=${id} AND position=${item.position} AND state='reserved'`;
      const remaining = await tx.$queryRaw<
        Array<{ n: bigint }>
      >`SELECT COUNT(*) n FROM xhs_refresh_batch_items WHERE batch_id=${id} AND state='queued'`;
      const nextState = Number(remaining[0].n) === 0 ? 'complete' : 'running';
      await tx.$executeRaw`UPDATE xhs_refresh_batches SET state=${nextState} WHERE id=${id} AND state IN ('running','paused')`;
    });
    return this.status(id);
  }
}
