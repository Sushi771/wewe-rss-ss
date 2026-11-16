import { XhsWholeCreatorService } from './xhs-whole-creator.service';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { withFixtureMigrationConnection } from '../../test/fixture-migration-connection';
import { splitSqliteStatements } from '../../../../scripts/sqlite-statements.cjs';
import { XiaohongshuBatches } from './xiaohongshu-batches';
import { XhsSubscriptionService } from './xhs-subscription.service';
import { XhsSubscriptionRuntime } from './xhs-subscription-runtime';
import { XhsSourceRiskStore } from './xhs-source-risk-store';
import { bindXhsSourceTotalBudget } from './xhs-source-request-policy';

jest.mock('./incremental-write', () => ({ incrementalWrite: (_db: unknown, _bytes: number, run: () => unknown) => run(), assertIncrementalWriteAdmission: async () => {}, assertIncrementalTransaction: async () => {}, canReuseIncrementalTransactionChecks: () => false, withIncrementalTransactionChecks: (run: () => unknown) => run() }));

describe('bound refresh batches, synthetic SQLite', () => {
  let db: PrismaClient, service: XhsSubscriptionService, batch: XiaohongshuBatches;
  let folder: string, calls: string[];
  beforeAll(async () => {
    folder = await fs.mkdtemp(path.join(os.tmpdir(), 'xhs-bound-batch-'));
    const url = 'file:' + path.join(folder, 'fixture.sqlite').replace(/\\/g, '/');
    db = new PrismaClient({ datasources: { db: { url } } });
    const root = path.resolve(__dirname, '../../prisma/migrations');
    await withFixtureMigrationConnection(url, async (client) => {
      for (const name of (await fs.readdir(root)).sort()) {
        if (!(await fs.stat(path.join(root, name))).isDirectory()) continue;
        for (const sql of splitSqliteStatements(await fs.readFile(path.join(root, name, 'migration.sql'), 'utf8')))
          await client.$executeRawUnsafe(sql);
      }
    });
    for (const id of ['a', 'b', 'c']) await db.xhsCreator.create({ data: { id, externalAuthorId: id, profileUrl: 'https://example.invalid/' + id, displayName: id } });
  }, 40000);
  beforeEach(async () => {
    for (const name of ['xhs_refresh_batch_items', 'xhs_refresh_batches', 'xhs_refresh_failures', 'xhs_refresh_jobs', 'xhs_subscription_tasks']) await db.$executeRawUnsafe(`DELETE FROM ${name}`);
    service = new XhsSubscriptionService(db as any, {} as any);
    (service as any).readyForMutation = async () => {};
    (service as any).write = (_bytes: number, fn: any) => db.$transaction(fn);
    calls = [];
    (service as any).run = async (task: any) => {
      calls.push(task.creatorId);
      task.state = 'completed'; task.message = 'synthetic';
      await (service as any).persist(task);
      (service as any).pending.delete(task.taskId);
    };
    batch = new XiaohongshuBatches(db, service);
  });
  afterAll(async () => { await db.$disconnect(); await fs.rm(folder, { recursive: true, force: true }); });
  it('runs the real batch and task into a synthetic transport', async () => {
    const api = jest.fn(async (request: any) => ({ status: 200, url: request.url, body: { success: true, data: { notes: [], has_more: false, cursor: '' } } }));
    const runtime = new XhsSubscriptionRuntime({ enabled: () => true, api });
    runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    bindXhsSourceTotalBudget(db as any, runtime);
    await runtime.connectSession({ a1: 'synthetic-a1', webSession: 'synthetic-session' });
    (runtime as any).adapter.restoreDefaultAuthorAccess('a');
    await db.$executeRaw`DELETE FROM xhs_request_budgets`;
    await db.$executeRaw`UPDATE xhs_source_risk SET state='clear',code=NULL,owner=NULL,http_status=NULL,endpoint=NULL WHERE id='source'`;
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,0)`;
    const real = new XhsSubscriptionService(db as any, runtime);
    (real as any).readyForMutation = async () => {};
    (real as any).write = (_bytes: number, fn: any) => db.$transaction(fn);
    new XhsWholeCreatorService(db as any, real, runtime, {} as any);
    const actual = new XiaohongshuBatches(db, real);
    const id = randomUUID(); await actual.create(id, ['a']);
    await actual.advance(id); await (real as any).lane; await actual.advance(id);
    expect(api).toHaveBeenCalledTimes(1);
    expect((await actual.status(id)).state).toBe('complete');
    runtime.onModuleDestroy();
  });
  it('advances three bound tasks in order once each', async () => {
    const id = randomUUID(); await batch.create(id, ['a', 'b', 'c']);
    for (let i = 0; i < 3; i++) { await batch.advance(id); await (service as any).lane; await batch.advance(id); }
    expect((await batch.status(id)).state).toBe('complete');
    expect(calls).toEqual(['a', 'b', 'c']);
    await batch.advance(id); expect(calls).toHaveLength(3);
  });
  it('rolls back item reservation if task persistence fails', async () => {
    const id = randomUUID(); await batch.create(id, ['a']);
    await db.$executeRawUnsafe("CREATE TRIGGER synthetic_batch_insert_failure BEFORE INSERT ON xhs_subscription_tasks BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END");
    await expect(batch.advance(id)).rejects.toMatchObject({ code: 'XHS_LOCAL_OPERATION_FAILED' });
    expect((await batch.status(id)).items[0]).toMatchObject({state:'queued', operationId:null});
    expect(await db.$queryRaw`SELECT id FROM xhs_subscription_tasks`).toEqual([]);
    expect(calls).toEqual([]);
    await db.$executeRawUnsafe('DROP TRIGGER synthetic_batch_insert_failure');
  });
  it('stops a bound task and keeps queued work stopped after reopening', async () => {
    const id = randomUUID(); await batch.create(id, ['a', 'b']);
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    (service as any).run = async (task: any) => { calls.push(task.creatorId); await gate; (service as any).pending.delete(task.taskId); };
    await batch.advance(id);
    const stopped = await batch.stop(id);
    expect(stopped.state).toBe('stopped');
    expect(stopped.items[1].state).toBe('cancelled');
    const stored = await db.$queryRaw<any[]>`SELECT state FROM xhs_subscription_tasks WHERE id=${stopped.items[0].operationId}`;
    expect(stored[0].state).toBe('cancelled');
    release(); await (service as any).lane;
    await new XiaohongshuBatches(db, service).advance(id);
    expect(calls).toEqual(['a']);
  });
  it('does not start another task on repeated advance while one is running', async () => {
    const id = randomUUID(); await batch.create(id, ['a']);
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    (service as any).run = async (task: any) => { calls.push(task.creatorId); await gate; task.state='completed'; task.message='synthetic'; await (service as any).persist(task); (service as any).pending.delete(task.taskId); };
    await batch.advance(id); await batch.advance(id); expect(calls).toEqual(['a']);
    release(); await (service as any).lane; await batch.advance(id); expect((await batch.status(id)).state).toBe('complete');
  });
});
