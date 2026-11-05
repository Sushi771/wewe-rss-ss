import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { XiaohongshuBatches } from './xiaohongshu-batches';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DatabaseSync } = require('node:sqlite');

describe('XHS durable batches on an isolated SQLite database', () => {
  let db: PrismaClient;
  let batches: XiaohongshuBatches;
  let calls: string[];
  let receipt: Map<string, any>;
  let source: any;
  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'xhs-batch-fixture-'));
    const file = join(root, 'fixture.sqlite');
    const raw = new DatabaseSync(file);
    raw.exec(
      "PRAGMA foreign_keys=ON; CREATE TABLE xhs_creators(id TEXT PRIMARY KEY, enabled INTEGER NOT NULL); INSERT INTO xhs_creators VALUES ('a',1),('b',1);",
    );
    for (const name of [
      '20261105000000_xhs_refresh_ledger',
      '20261106000000_xhs_refresh_batches',
    ])
      raw.exec(
        readFileSync(
          join(__dirname, '../../prisma/migrations', name, 'migration.sql'),
          'utf8',
        ),
      );
    raw.close();
    const url = 'file:' + file.replace(/\\/g, '/');
    db = new PrismaClient({ datasources: { db: { url } } });
    calls = [];
    receipt = new Map();
    source = {
      refresh: jest.fn(async (id: string, op: string) => {
        calls.push(id);
        receipt.set(op, {
          state: 'complete',
          outcome:
            id === 'a'
              ? {
                  status: 'partial',
                  failureScope: 'article',
                  failedCount: 1,
                  added: 1,
                  message: 'synthetic',
                }
              : { status: 'complete', added: 1, message: 'synthetic' },
        });
      }),
      refreshStatus: jest.fn(
        async (_id: string, op: string) =>
          receipt.get(op) || { state: 'missing' },
      ),
    };
    batches = new XiaohongshuBatches(db, source);
  });
  afterEach(async () => {
    await db.$disconnect();
  });

  it('persists idempotent targets, processes article-only partial in order and survives reopening', async () => {
    const id = randomUUID();
    expect(
      (await batches.create(id, ['a', 'b'])).items.map((x) => x.creatorId),
    ).toEqual(['a', 'b']);
    expect((await batches.create(id, ['a', 'b'])).id).toBe(id);
    await expect(batches.create(id, ['b', 'a'])).rejects.toThrow(
      'XHS_BATCH_ID_CONFLICT',
    );
    expect((await batches.advance(id)).items[0].state).toBe('partial');
    const reopened = new XiaohongshuBatches(db, source);
    expect((await reopened.advance(id)).state).toBe('complete');
    expect(calls).toEqual(['a', 'b']);
  });

  it('never resends a reserved operation with missing receipt, and can reconcile a later committed receipt', async () => {
    const id = randomUUID();
    await batches.create(id, ['a', 'b']);
    const op = randomUUID();
    await db.$executeRaw`UPDATE xhs_refresh_batch_items SET state='reserved',operation_id=${op} WHERE batch_id=${id} AND position=0`;
    expect((await batches.advance(id)).state).toBe('paused');
    expect(calls).toEqual([]);
    receipt.set(op, {
      state: 'complete',
      outcome: { status: 'complete', added: 1, message: 'synthetic' },
    });
    expect((await batches.advance(id)).state).toBe('running');
    expect((await batches.advance(id)).state).toBe('complete');
    expect(calls).toEqual(['b']);
  });

  it('stops a reserved unsent operation atomically and cancels later creators', async () => {
    const id = randomUUID();
    await batches.create(id, ['a', 'b']);
    const op = randomUUID();
    await db.$executeRaw`UPDATE xhs_refresh_batch_items SET state='reserved',operation_id=${op} WHERE batch_id=${id} AND position=0`;
    const stopped = await batches.stop(id);
    expect(stopped.state).toBe('stopped');
    expect(stopped.items[1].state).toBe('cancelled');
    const jobs = await db.$queryRawUnsafe<any[]>(
      'SELECT state,owner FROM xhs_refresh_jobs',
    );
    expect(jobs).toEqual([
      expect.objectContaining({ state: 'stopped', owner: op }),
    ]);
    await batches.advance(id);
    expect(calls).toEqual([]);
  });

  it('pauses on pagination partial and refuses a second active batch', async () => {
    const id = randomUUID();
    await batches.create(id, ['a', 'b']);
    await expect(batches.create(randomUUID(), ['b'])).rejects.toThrow();
    source.refresh.mockImplementation(async (_id: string, op: string) =>
      receipt.set(op, {
        state: 'complete',
        outcome: { status: 'partial', added: 1, message: 'pagination' },
      }),
    );
    expect((await batches.advance(id)).state).toBe('paused');
    expect((await batches.status(id)).items[1].state).toBe('queued');
  });
});
