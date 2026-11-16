import { XhsWholeCreatorService } from './xhs-whole-creator.service';
import { parseXhsProfile } from './xhs-profile';
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

it('preserves a first page and pauses on a restricted second request with real write admission', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'xhs-batch-real-partial-'));
  const url = 'file:' + path.join(folder, 'fixture.sqlite').replace(/\\/g, '/');
  const db = new PrismaClient({ datasources: { db: { url } } });
  let runtime: XhsSubscriptionRuntime | undefined;
  try {
    const root = path.resolve(__dirname, '../../prisma/migrations');
    await withFixtureMigrationConnection(url, async (client) => {
      for (const name of (await fs.readdir(root)).sort()) {
        if (!(await fs.stat(path.join(root, name))).isDirectory()) continue;
        for (const sql of splitSqliteStatements(await fs.readFile(path.join(root, name, 'migration.sql'), 'utf8')))
          await client.$executeRawUnsafe(sql);
      }
    });
    await db.xhsCreator.create({ data: { id: 'a', externalAuthorId: 'a', profileUrl: 'https://example.invalid/a', displayName: 'a' } });
    await db.xhsCreator.create({ data: { id: 'b', externalAuthorId: 'b', profileUrl: 'https://example.invalid/b', displayName: 'b' } });
    const oldDownload = JSON.stringify({ taskId: 'old-download', creatorId: 'a', kind: 'download', state: 'blocked', code: 'XHS_TASK_RECEIPT_UNCERTAIN', noteIds: [] });
    const oldList = JSON.stringify({ taskId: 'old-list', creatorId: 'b', kind: 'list', state: 'partial', code: 'XHS_DETAIL_OUTCOME_UNKNOWN', sourceFailures: { synthetic: { phase: 'detail', code: 'XHS_DETAIL_OUTCOME_UNKNOWN', dispatched: false, fenceReason: 'prior-started' } } });
    await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES('old-download','a','blocked',${oldDownload},1),('old-list','b','partial',${oldList},2)`;
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,0)`;
    const api = jest.fn(async (request: any) => new URL(request.url).pathname.endsWith('/user/otherinfo')
      ? { status: 200, url: request.url, body: { success: true, data: { result: { success: true, code: 0 }, basic_info: { user_id: 'a', nickname: 'synthetic', red_id: 'synthetic' }, interactions: [] } } }
      : api.mock.calls.filter(([r]: any[]) => new URL(r.url).pathname.endsWith('/user_posted')).length === 1
      ? { status: 200, url: request.url, body: { success: true, data: { notes: [{ note_id: 'note-one', user: { user_id: 'a' }, xsec_token: 'synthetic', display_title: 'synthetic' }], has_more: true, cursor: 'next' } } }
      : { status: 429, url: request.url, body: { success: false } });
    runtime = new XhsSubscriptionRuntime({ enabled: () => true, api, profileParser: parseXhsProfile });
    runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    bindXhsSourceTotalBudget(db as any, runtime);
    await runtime.connectSession({ a1: 'synthetic-a1', webSession: 'synthetic-session' });
    const service = new XhsSubscriptionService(db as any, runtime);
    new XhsWholeCreatorService(db as any, service, runtime, {} as any);
    const batch = new XiaohongshuBatches(db, service);
    const id = randomUUID(); await batch.create(id, ['a']);
    await batch.advance(id); await (service as any).lane; await batch.advance(id);
    expect(api).toHaveBeenCalledTimes(3);
    expect(api.mock.calls.filter(([request]: any[]) => new URL(request.url).pathname.endsWith('/user_posted'))).toHaveLength(2);
    const historical = await db.$queryRaw<Array<{ id: string; document: string }>>`SELECT id,document FROM xhs_subscription_tasks WHERE id IN ('old-download','old-list') ORDER BY id`;
    expect(historical).toEqual([{ id: 'old-download', document: oldDownload }, { id: 'old-list', document: oldList }]);
    expect((await batch.status(id)).state).toBe('paused');
    expect(await db.xhsNote.count({ where: { creatorId: 'a' } })).toBe(1);
    const before = api.mock.calls.length;
    await batch.advance(id); expect(api).toHaveBeenCalledTimes(before);
  } finally {
    runtime?.onModuleDestroy();
    await db.$disconnect();
    await fs.rm(folder, { recursive: true, force: true });
  }
}, 60000);
