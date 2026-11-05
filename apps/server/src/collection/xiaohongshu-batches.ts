import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { XiaohongshuService } from './xiaohongshu.service';

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
    private readonly xhs: XiaohongshuService,
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
    await this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Batch[]
      >`SELECT id,state FROM xhs_refresh_batches WHERE id=${id}`;
      if (rows.length !== 1) throw new Error('XHS_BATCH_NOT_FOUND');
      if (rows[0].state === 'complete' || rows[0].state === 'stopped') return;
      const reserved = await tx.$queryRaw<
        Item[]
      >`SELECT position,creator_id,operation_id,state,outcome FROM xhs_refresh_batch_items WHERE batch_id=${id} AND state='reserved'`;
      if (reserved.length > 1) throw new Error('XHS_BATCH_CORRUPT');
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
    });
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
      const op = randomUUID();
      const count =
        await tx.$executeRaw`UPDATE xhs_refresh_batch_items SET state='reserved',operation_id=${op} WHERE batch_id=${id} AND position=${next[0].position} AND state='queued'`;
      if (count !== 1) throw new Error('XHS_BATCH_CHANGED');
      return { item: { ...next[0], operation_id: op }, fresh: true };
    });
    if (!reservation) return this.status(id);
    const { item, fresh } = reservation;
    if (!item.operation_id) throw new Error('XHS_BATCH_CORRUPT');
    if (fresh) {
      try {
        await this.xhs.legacyRefresh(item.creator_id, item.operation_id);
      } catch {
        /* query only; never retry an unknown request */
      }
    }
    let receipt: Awaited<
      ReturnType<XiaohongshuService['refreshStatus']>
    > | null = null;
    try {
      receipt = await this.xhs.refreshStatus(
        item.creator_id,
        item.operation_id,
      );
    } catch {
      /* pause */
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
      if (!receipt || receipt.state !== 'complete') {
        await tx.$executeRaw`UPDATE xhs_refresh_batches SET state='paused' WHERE id=${id} AND state IN ('running','paused')`;
        return;
      }
      const outcome = receipt.outcome;
      const accepted =
        outcome.status === 'complete' ||
        (outcome.status === 'partial' &&
          outcome.failureScope === 'article' &&
          Number.isSafeInteger(outcome.failedCount) &&
          outcome.failedCount > 0);
      if (!accepted) {
        await tx.$executeRaw`UPDATE xhs_refresh_batches SET state='paused' WHERE id=${id} AND state IN ('running','paused')`;
        return;
      }
      const serialized = JSON.stringify(outcome);
      const state = outcome.status;
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
