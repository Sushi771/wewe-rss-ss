import { Injectable, OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  incrementalWrite,
  assertIncrementalWriteAdmission,
  assertIncrementalTransaction,
} from './incremental-write';
import { sqliteWrites } from './sqlite-write-coordinator';
import { XhsSubscriptionError, xhsPublicCode } from './xhs-subscription-errors';
import { XhsSubscriptionRuntime } from './xhs-subscription-runtime';
import { XhsSubscriptionService } from './xhs-subscription.service';
import { resolveXhsSubscriptionWithBudget } from './xhs-source-request-policy';
import { parseBatchInput } from './xhs-batch-input';

type Item = {
  index: number;
  fingerprint: string;
  kind: 'note' | 'author' | 'short' | 'invalid';
  state:
    | 'queued'
    | 'needs_context'
    | 'resolving'
    | 'unknown'
    | 'subscribed'
    | 'duplicate'
    | 'failed';
  code?: string;
  authorId?: string;
  creatorId?: string;
  duplicateOf?: number;
  collectionTaskId?: string;
  collectionError?: string;
};
type Batch = {
  batchId: string;
  state: 'queued' | 'running' | 'paused' | 'cancelled' | 'completed';
  items: Item[];
  groupId?: string;
};
type Tx = Prisma.TransactionClient;
const fail = (code: string): never => {
  throw new XhsSubscriptionError(code);
};
const prefix = 'batch:';

@Injectable()
export class XhsBatchSubscriptionService implements OnModuleInit {
  private readonly active = new Map<
    string,
    { cancelled: boolean; urls: Map<string, string> }
  >();
  private lane: Promise<void> = Promise.resolve();
  private initializationFailed = false;
  constructor(
    private readonly db: PrismaService,
    private readonly runtime: XhsSubscriptionRuntime,
    private readonly subscriptions: XhsSubscriptionService,
  ) {}

  private write<T>(fn: (tx: Tx) => Promise<T>) {
    return incrementalWrite(this.db, 65536, () =>
      sqliteWrites.write(async () => {
        await assertIncrementalWriteAdmission();
        return this.db.$transaction(async (tx) => {
          await assertIncrementalTransaction(tx);
          return fn(tx);
        });
      }),
    );
  }
  private async read(tx: Pick<Tx, '$queryRaw'>, id: string): Promise<Batch> {
    const rows = await tx.$queryRaw<
      Array<{ document: string }>
    >`SELECT document FROM xhs_subscription_tasks WHERE id=${prefix + id} AND creator_id='__batch__'`;
    if (rows.length !== 1) return fail('XHS_TASK_NOT_FOUND');
    return JSON.parse(rows[0].document) as Batch;
  }
  private async save(tx: Tx, batch: Batch) {
    const count =
      await tx.$executeRaw`UPDATE xhs_subscription_tasks SET state=${'batch_' + batch.state},document=${JSON.stringify(batch)},updated_at=${BigInt(Date.now())} WHERE id=${prefix + batch.batchId} AND creator_id='__batch__'`;
    if (count !== 1) fail('XHS_TASK_STATE_CHANGED');
  }
  async onModuleInit() {
    try {
      const pending = await this.db.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM xhs_subscription_tasks WHERE creator_id='__batch__' AND (state IN ('batch_queued','batch_running') OR (state IN ('batch_paused','batch_cancelled') AND EXISTS(SELECT 1 FROM json_each(document,'$.items') WHERE json_extract(value,'$.state') IN ('queued','resolving'))))`;
      for (const row of pending) {
        if (!row.id.startsWith(prefix))
          return fail('XHS_TASK_RECEIPT_UNCERTAIN');
        await this.write(async (tx) => {
          const batch = await this.read(tx, row.id.slice(prefix.length));
          let changed = false;
          for (const item of batch.items) {
            if (item.state === 'resolving') {
              item.state = 'unknown';
              item.code = 'XHS_TASK_RECEIPT_UNCERTAIN';
              changed = true;
            } else if (item.state === 'queued') {
              item.state = 'needs_context';
              changed = true;
            }
          }
          if (batch.state === 'queued' || batch.state === 'running') {
            batch.state = 'paused';
            changed = true;
          }
          if (changed) await this.save(tx, batch);
        });
      }
    } catch {
      this.initializationFailed = true;
    }
  }
  async status(input: { batchId: string }) {
    return this.read(this.db, input.batchId);
  }
  async start(input: {
    clientRequestId: string;
    text: string;
    groupId?: string;
  }) {
    if (this.initializationFailed) return fail('XHS_TASK_RECEIPT_UNCERTAIN');
    const parsed = parseBatchInput(input.text);
    const id = input.clientRequestId;
    const result = await this.write(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ document: string }>
      >`SELECT document FROM xhs_subscription_tasks WHERE id=${prefix + id}`;
      if (rows.length) {
        const old = JSON.parse(rows[0].document) as Batch;
        if (
          old.groupId !== input.groupId ||
          JSON.stringify(old.items.map((x) => x.fingerprint)) !==
            JSON.stringify(parsed.map((x) => x.fingerprint))
        )
          fail('XHS_TASK_CONFLICT');
        return { batch: old, created: false };
      }
      if (
        input.groupId &&
        !(await tx.managementGroup.findFirst({
          where: { id: input.groupId, platform: 'xiaohongshu' },
        }))
      )
        fail('XHS_GROUP_INVALID');
      const batch: Batch = {
        batchId: id,
        state: 'queued',
        ...(input.groupId ? { groupId: input.groupId } : {}),
        items: parsed.map((x) => ({
          index: x.index,
          fingerprint: x.fingerprint,
          kind: x.kind,
          state: x.code
            ? 'failed'
            : x.duplicateOf !== undefined
              ? 'duplicate'
              : 'queued',
          ...(x.code ? { code: x.code } : {}),
          ...(x.duplicateOf !== undefined
            ? { duplicateOf: x.duplicateOf }
            : {}),
        })),
      };
      await tx.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES(${prefix + id},'__batch__','batch_queued',${JSON.stringify(batch)},${BigInt(Date.now())})`;
      return { batch, created: true };
    });
    if (result.created)
      this.schedule(
        id,
        new Map(
          parsed.filter((x) => x.url).map((x) => [x.fingerprint, x.url!]),
        ),
      );
    return result.batch;
  }
  async resume(input: { batchId: string; text: string }) {
    if (this.initializationFailed) return fail('XHS_TASK_RECEIPT_UNCERTAIN');
    const parsed = parseBatchInput(input.text);
    const urls = new Map(
      parsed.filter((x) => x.url).map((x) => [x.fingerprint, x.url!]),
    );
    if (this.active.has(input.batchId)) return fail('XHS_TASK_CONFLICT');
    const batch = await this.write(async (tx) => {
      const b = await this.read(tx, input.batchId);
      if (!['paused', 'cancelled'].includes(b.state))
        return fail('XHS_TASK_NOT_RESUMABLE');
      for (const item of b.items)
        if (item.state === 'needs_context' && urls.has(item.fingerprint)) {
          item.state = 'queued';
          delete item.code;
        }
      if (!b.items.some((x) => x.state === 'queued'))
        return fail('XHS_ACCESS_CONTEXT_UNAVAILABLE');
      b.state = 'queued';
      await this.save(tx, b);
      return b;
    });
    this.schedule(input.batchId, urls);
    return batch;
  }
  async cancel(input: { batchId: string }) {
    const running = this.active.get(input.batchId);
    if (running) running.cancelled = true;
    return this.write(async (tx) => {
      const b = await this.read(tx, input.batchId);
      if (b.state === 'completed') return b;
      b.state = 'cancelled';
      for (const item of b.items)
        if (item.state === 'queued') item.state = 'needs_context';
      await this.save(tx, b);
      return b;
    });
  }
  private schedule(id: string, urls: Map<string, string>) {
    let release!: (mayCollect: boolean) => void;
    const whenSettled = new Promise<boolean>(resolve => { release = resolve; });
    const active = { cancelled: false, urls, whenSettled, release };
    this.active.set(id, active);
    const work = this.lane
      .then(() => this.run(id, active))
      .catch(async () => {
        await this.write(async (tx) => {
          const batch = await this.read(tx, id);
          if (!['queued', 'running'].includes(batch.state)) return;
          for (const item of batch.items) {
            if (item.state === 'resolving') {
              item.state = 'unknown';
              item.code = 'XHS_TASK_RECEIPT_UNCERTAIN';
            } else if (item.state === 'queued') item.state = 'needs_context';
          }
          batch.state = 'paused';
          await this.save(tx, batch);
        });
      })
      .finally(async () => {
        let mayCollect = false;
        try { mayCollect = !active.cancelled && (await this.read(this.db, id)).state === 'completed'; }
        catch { /* uncertain batch state cannot authorize a child */ }
        finally {
          active.release(mayCollect);
          active.urls.clear();
          this.active.delete(id);
        }
      });
    this.lane = work.catch(() => undefined);
  }
  private async assertReady(id: string, index: number, tx?: Tx) {
    const batch = await this.read(tx ?? this.db, id);
    if (batch.state !== 'running' || batch.items[index]?.state !== 'resolving')
      fail('XHS_TASK_CANCELLED');
  }
  private async run(
    id: string,
    active: { cancelled: boolean; urls: Map<string, string>; whenSettled: Promise<boolean> },
  ) {
    await this.write(async (tx) => {
      const b = await this.read(tx, id);
      if (b.state === 'queued') {
        b.state = 'running';
        await this.save(tx, b);
      }
    });
    for (;;) {
      if (active.cancelled) return;
      const batch = await this.read(this.db, id);
      if (batch.state !== 'running') return;
      const item = batch.items.find((x) => x.state === 'queued');
      if (!item) {
        await this.write(async (tx) => {
          const b = await this.read(tx, id);
          if (b.state === 'running') {
            b.state = b.items.some((x) =>
              ['needs_context', 'unknown'].includes(x.state),
            )
              ? 'paused'
              : 'completed';
            await this.save(tx, b);
          }
        });
        return;
      }
      const url = active.urls.get(item.fingerprint);
      if (!url) {
        await this.write(async (tx) => {
          const b = await this.read(tx, id);
          if (b.state === 'running') {
            b.items[item.index].state = 'needs_context';
            await this.save(tx, b);
          }
        });
        continue;
      }
      const old = await this.db.$queryRaw<
        Array<{ note_id: string; state: string }>
      >`SELECT note_id,state FROM xhs_limited_recovery WHERE state IN ('started','unknown')`;
      const parsed = new URL(url);
      if (
        old.length &&
        (parsed.hostname !== 'www.xiaohongshu.com' ||
          ((parsed.pathname.includes('/item/') ||
            parsed.pathname.startsWith('/explore/')) &&
            parsed.pathname.split('/').filter(Boolean).pop() ===
              old[0].note_id))
      ) {
        await this.write(async (tx) => {
          const b = await this.read(tx, id);
          if (b.state === 'running') {
            b.items[item.index].state = 'needs_context';
            b.items[item.index].code = 'XHS_TASK_RECEIPT_UNCERTAIN';
            b.state = 'paused';
            await this.save(tx, b);
          }
        });
        return;
      }
      const claimed = await this.write(async (tx) => {
        const b = await this.read(tx, id);
        if (b.state !== 'running') return fail('XHS_TASK_CANCELLED');
        const rows = await tx.$queryRaw<
          Array<{ document: string }>
        >`SELECT document FROM xhs_subscription_tasks WHERE creator_id='__batch__' AND id<>${prefix + id}`;
        const allPrior = [
          ...b.items.filter((x) => x.index !== item.index),
          ...rows.flatMap((row) => (JSON.parse(row.document) as Batch).items),
        ];
        const uncertainLinks = allPrior.filter(
          (x) =>
            x.state === 'unknown' && (x.kind === 'note' || x.kind === 'short'),
        );
        if (
          (item.kind === 'short' && uncertainLinks.length) ||
          (item.kind === 'note' &&
            uncertainLinks.some((x) => x.kind === 'short'))
        ) {
          Object.assign(b.items[item.index], {
            state: 'needs_context',
            code: 'XHS_TASK_RECEIPT_UNCERTAIN',
          });
          b.state = 'paused';
          await this.save(tx, b);
          return false;
        }
        const prior = allPrior.filter(
          (x) => x.fingerprint === item.fingerprint,
        );
        const success = prior.find(
          (x) =>
            ['subscribed', 'duplicate'].includes(x.state) &&
            x.creatorId &&
            x.authorId,
        );
        if (success) {
          delete b.items[item.index].code;
          Object.assign(b.items[item.index], {
            state: 'duplicate',
            creatorId: success.creatorId,
            authorId: success.authorId,
          });
          await this.save(tx, b);
          return false;
        }
        if (
          prior.some((x) => x.state === 'unknown' || x.state === 'resolving')
        ) {
          const uncertain = prior.some((x) => x.state === 'unknown');
          Object.assign(b.items[item.index], {
            state: uncertain ? 'unknown' : 'needs_context',
            code: uncertain
              ? 'XHS_TASK_RECEIPT_UNCERTAIN'
              : 'XHS_TASK_CONFLICT',
          });
          b.state = 'paused';
          await this.save(tx, b);
          return false;
        }
        b.items[item.index].state = 'resolving';
        await this.save(tx, b);
        return true;
      });
      if (!claimed) continue;
      let dispatched = false;
      let inFlight = false;
      let resolutionComplete = false;
      try {
        const result = await this.runtime.withBatchDispatch(
          {
            assertReady: (tx) => this.assertReady(id, item.index, tx),
            isCancelled: () => active.cancelled,
            onDispatch: () => {
              dispatched = true;
              inFlight = true;
            },
            onReceipt: () => {
              inFlight = false;
            },
          },
          () =>
            resolveXhsSubscriptionWithBudget(
              this.db,
              this.runtime,
              this.subscriptions,
              { url, fixedErrors: true },
            ),
        );
        resolutionComplete = true;
        const current = await this.read(this.db, id);
        const duplicate = current.items.find(
          (x) => x.state === 'subscribed' && x.authorId === result.author.id,
        );
        if (duplicate) {
          await this.write(async (tx) => {
            const b = await this.read(tx, id);
            if (b.state !== 'running') return fail('XHS_TASK_CANCELLED');
            delete b.items[item.index].code;
            Object.assign(b.items[item.index], {
              state: 'duplicate',
              authorId: result.author.id,
              creatorId: duplicate.creatorId,
              duplicateOf: duplicate.index,
            });
            await this.save(tx, b);
          });
        } else {
          const subscribed = await this.subscriptions.subscribe(
            { resolutionId: result.resolutionId, groupId: batch.groupId },
            async (tx, creatorId, authorId) => {
              const b = await this.read(tx, id);
              if (
                b.state !== 'running' ||
                b.items[item.index].state !== 'resolving'
              )
                return fail('XHS_TASK_CANCELLED');
              delete b.items[item.index].code;
              Object.assign(b.items[item.index], {
                state: 'subscribed',
                creatorId,
                authorId,
              });
              await this.save(tx, b);
            },
            active.whenSettled,
          );
          await this.write(async tx => {
            const b = await this.read(tx, id), current = b.items[item.index];
            if (current.state !== 'subscribed' || current.creatorId !== subscribed.creatorId)
              return fail('XHS_TASK_STATE_CHANGED');
            if ('collection' in subscribed) current.collectionTaskId = subscribed.collection.taskId;
            else current.collectionError = subscribed.collectionError;
            await this.save(tx, b);
          });
        }
        active.urls.delete(item.fingerprint);
      } catch (error) {
        const code = xhsPublicCode(error, 'XHS_RESOLUTION_BLOCKED');
        const refusal =
          /^XHS_SOURCE_(?:AUTHENTICATION|VERIFICATION|UNKNOWN_REJECTION|PERMISSION|SIGNATURE|RATE_LIMIT)_BLOCKED$/.test(
            code,
          );
        const uncertain =
          inFlight ||
          resolutionComplete ||
          (dispatched && code === 'XHS_TASK_CANCELLED');
        await this.write(async (tx) => {
          const b = await this.read(tx, id);
          const target = b.items[item.index];
          if (target.state === 'resolving') {
            target.state = refusal
              ? 'failed'
              : uncertain
                ? 'unknown'
                : 'needs_context';
            target.code = refusal
              ? code
              : uncertain
                ? 'XHS_TASK_RECEIPT_UNCERTAIN'
                : code;
          }
          if (b.state === 'running') b.state = 'paused';
          await this.save(tx, b);
        });
        return;
      }
    }
  }
}
