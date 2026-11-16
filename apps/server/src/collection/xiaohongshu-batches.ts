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
  ) {}

  async create(id: string, ids: string[]) {
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
    if (rows.length > 1) throw new Error('XHS_BATCH_CORRUPT');
    return rows.length ? this.status(rows[0].id) : null;
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
      await tx.$executeRaw`UPDATE xhs_refresh_batches SET state='stopped' WHERE id=${id}`;
      await tx.$executeRaw`UPDATE xhs_refresh_batch_items SET state='cancelled' WHERE batch_id=${id} AND state='queued'`;
      return reserved[0]?.operation_id ?? null;
    });
    if (operation) {
      const tasks = await this.db.$queryRaw<Array<{ id: string }>>`SELECT id FROM xhs_subscription_tasks WHERE id=${operation}`;
      if (tasks.length) await this.xhs.cancelTask({ taskId: operation });
    }
    return this.status(id);
  }

  async advance(id: string) {
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
        const started = await this.xhs.startBatchItem({ batchId: id, position: item.position, creatorId: item.creator_id });
        if ('state' in started && started.state === 'deferred') return this.status(id);
        item = { ...item, operation_id: started.taskId, state: 'reserved' };
      } catch (error) {
        // Inspect durable state before reporting a failure. A committed or
        // concurrent reservation is only observed, never launched again.
        const observed = await this.status(id);
        const current = observed.items.find((entry) => entry.position === item.position);
        if (!current || current.state !== 'queued' || current.operationId)
          return observed;
        throw new XhsSubscriptionError(xhsPublicCode(error, 'XHS_LOCAL_OPERATION_FAILED'));
      }
    }
    if (!item.operation_id) throw new Error('XHS_BATCH_CORRUPT');
    let receipt: { status: 'complete' | 'partial'; added: number; message: string; failureScope?: 'article'; failedCount?: number } | null = null;
    let legacyReceipt: string | undefined;
    const storedTask = await this.db.$queryRaw<Array<{ id: string }>>`SELECT id FROM xhs_subscription_tasks WHERE id=${item.operation_id} AND creator_id=${item.creator_id}`;
    if (storedTask.length === 1) {
      try {
        const task = await this.xhs.task({ taskId: item.operation_id });
        if (task.creatorId !== item.creator_id || task.taskId !== item.operation_id)
          throw new Error('XHS_BATCH_CORRUPT');
        if (task.state === 'queued' || task.state === 'running') return this.status(id);
        if (task.state === 'completed') receipt = { status: 'complete', added: task.completed, message: task.message };
      } catch {
        return this.status(id);
      }
    } else {
      // Older reservations are never replayed. Only their exact durable receipt
      // may settle the item; absence or an incomplete receipt pauses the batch.
      const jobs = await this.db.$queryRaw<Array<{state:string; outcome:string | null}>>`SELECT state,outcome FROM xhs_refresh_jobs WHERE creator_id=${item.creator_id} AND owner=${item.operation_id}`;
      if (jobs.length === 1 && jobs[0].state === 'complete' && jobs[0].outcome) {
        try {
          const value = JSON.parse(jobs[0].outcome);
          if ((value.status === 'complete' || value.status === 'partial') && Number.isSafeInteger(value.added) && value.added >= 0 && typeof value.message === 'string') {
            receipt = value;
            legacyReceipt = jobs[0].outcome;
          }
        } catch { /* malformed legacy receipt remains paused */ }
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
      const accepted = outcome.status === 'complete' || (outcome.status === 'partial' && outcome.failureScope === 'article' && Number.isSafeInteger(outcome.failedCount) && outcome.failedCount! > 0);
      if (!accepted) {
        await tx.$executeRaw`UPDATE xhs_refresh_batches SET state='paused' WHERE id=${id} AND state IN ('running','paused')`;
        return;
      }
      const serialized = legacyReceipt ?? JSON.stringify(outcome);
      const state = outcome.status;
      if (!legacyReceipt) await tx.$executeRaw`INSERT INTO xhs_refresh_jobs(creator_id,generation,owner,started_at,state,outcome) SELECT ${item.creator_id},COALESCE(MAX(generation),0)+1,${item.operation_id},${Date.now()},'complete',${serialized} FROM xhs_refresh_jobs WHERE creator_id=${item.creator_id}`;
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
