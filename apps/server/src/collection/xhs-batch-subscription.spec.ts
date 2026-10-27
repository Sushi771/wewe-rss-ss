import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { splitSqliteStatements } from '../../../../scripts/sqlite-statements.cjs';
import { XhsBatchSubscriptionService } from './xhs-batch-subscription.service';
import { XhsSubscriptionService } from './xhs-subscription.service';
import { XhsSubscriptionRuntime } from './xhs-subscription-runtime';
import { XhsSourceRiskStore } from './xhs-source-risk-store';
import { bindXhsSourceTotalBudget } from './xhs-source-request-policy';
import { ConfigService } from '@nestjs/config';
import { TrpcRouter } from '../trpc/trpc.router';
import { TrpcService } from '../trpc/trpc.service';
import { createHTTPServer } from '@trpc/server/adapters/standalone';
import { createTRPCProxyClient, httpLink } from '@trpc/client';

describe('batch subscription with synthetic SQLite and transport', () => {
  let folder: string, db: PrismaClient;
  beforeAll(async () => {
    folder = await fs.mkdtemp(path.join(os.tmpdir(), 'xhs-batch-synthetic-'));
    db = new PrismaClient({
      datasources: {
        db: {
          url: 'file:' + path.join(folder, 'test.sqlite').replace(/\\/g, '/'),
        },
      },
    });
    const root = path.resolve(__dirname, '../../prisma/migrations');
    for (const name of (await fs.readdir(root)).sort()) {
      if (!(await fs.stat(path.join(root, name))).isDirectory()) continue;
      for (const sql of splitSqliteStatements(
        await fs.readFile(path.join(root, name, 'migration.sql'), 'utf8'),
      ))
        await db.$executeRawUnsafe(sql);
    }
  }, 40000);
  beforeEach(async () => {
    await db.$executeRaw`DELETE FROM xhs_subscription_tasks`;
    await db.$executeRaw`DELETE FROM xhs_limited_recovery`;
    await db.$executeRaw`DELETE FROM xhs_request_budgets`;
    await db.$executeRaw`UPDATE xhs_source_risk SET state='clear',code=NULL,owner=NULL,http_status=NULL,endpoint=NULL WHERE id='source'`;
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,interval_ms) VALUES('xhs:source-total',20,0,1000)`;
  }, 40000);
  afterAll(async () => {
    await db.$disconnect();
    await fs.rm(folder, { recursive: true, force: true });
  }, 40000);
  const link = (id: string) =>
    `https://www.xiaohongshu.com/explore/${id}?xsec_token=synthetic-secret&xsec_source=pc_search`;
  const id = '11111111-1111-4111-8111-111111111111';
  async function setup(
    transport?: (request: any) => Promise<any>,
    shortLinks?: any,
  ) {
    const api = jest.fn(
      transport ??
        (async (request: any) => {
          const note = JSON.parse(request.body).source_note_id;
          return {
            status: 200,
            url: request.url,
            body: {
              success: true,
              code: 0,
              data: {
                items: [
                  {
                    id: note,
                    note_card: {
                      note_id: note,
                      user: { user_id: 'same-author', nickname: 'Synthetic' },
                      type: 'normal',
                      title: 'Synthetic',
                      desc: 'Synthetic body',
                      interact_info: {
                        liked_count: '1',
                        collected_count: '2',
                        share_count: '3',
                        comment_count: '4',
                      },
                      image_list: [],
                    },
                  },
                ],
              },
            },
          };
        }),
    );
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      shortLinks,
    });
    runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    bindXhsSourceTotalBudget(db as any, runtime);
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    const subscriptions = new XhsSubscriptionService(db as any, runtime);
    const service = new XhsBatchSubscriptionService(
      db as any,
      runtime,
      subscriptions,
    );
    await service.onModuleInit();
    return { api, runtime, service, subscriptions };
  }
  it('commits one author and persistent receipts, deduplicates URLs and never stores access context', async () => {
    const { api, runtime, service } = await setup();
    const text = [link('note-a'), link('note-a'), link('note-b')].join('\n');
    await service.start({ clientRequestId: id, text });
    await (service as any).lane;
    const result = await service.status({ batchId: id });
    expect(result.state).toBe('completed');
    expect(result.items.map((x) => x.state)).toEqual([
      'subscribed',
      'duplicate',
      'duplicate',
    ]);
    expect(result.items[0].creatorId).toBe(result.items[2].creatorId);
    expect(api).toHaveBeenCalledTimes(2);
    const rows = await db.$queryRaw<
      Array<{ document: string }>
    >`SELECT document FROM xhs_subscription_tasks WHERE id=${'batch:' + id}`;
    expect(rows[0].document).not.toContain('synthetic-secret');
    await service.start({ clientRequestId: id, text });
    expect(api).toHaveBeenCalledTimes(2);
    const second = '33333333-3333-4333-8333-333333333333';
    await service.start({
      clientRequestId: second,
      text: link('note-a').replace('synthetic-secret', 'new-context'),
    });
    await (service as any).lane;
    expect((await service.status({ batchId: second })).items[0].state).toBe(
      'duplicate',
    );
    expect(api).toHaveBeenCalledTimes(2);
    runtime.onModuleDestroy();
  }, 40000);
  it('retains an uncertain in-flight item after cancellation and never replays it on resume', async () => {
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>((r) => (entered = r)),
      gate = new Promise<void>((r) => (release = r));
    const { api, runtime, service } = await setup(async (request) => {
      entered();
      await gate;
      const note = JSON.parse(request.body).source_note_id;
      return {
        status: 200,
        url: request.url,
        body: {
          success: true,
          code: 0,
          data: {
            items: [
              {
                id: note,
                note_card: {
                  note_id: note,
                  user: { user_id: 'same-author', nickname: 'Synthetic' },
                  type: 'normal',
                  title: 'Synthetic',
                  desc: 'Body',
                  interact_info: { liked_count: '1' },
                  image_list: [],
                },
              },
            ],
          },
        },
      };
    });
    await service.start({
      clientRequestId: id,
      text: [link('note-c'), link('note-d')].join('\n'),
    });
    await started;
    await service.cancel({ batchId: id });
    release();
    await (service as any).lane;
    const first = await service.status({ batchId: id });
    expect(first.state).toBe('cancelled');
    expect(first.items[0].state).toBe('unknown');
    expect(first.items[1].state).toBe('needs_context');
    expect(api).toHaveBeenCalledTimes(1);
    await service.resume({ batchId: id, text: link('note-d') });
    await (service as any).lane;
    const later = await service.status({ batchId: id });
    expect(later.items[0].state).toBe('unknown');
    expect(later.items[1].state).toBe('subscribed');
    expect(later.items[1].code).toBeUndefined();
    expect(api).toHaveBeenCalledTimes(2);
    const repeated = '44444444-4444-4444-8444-444444444444';
    await service.start({ clientRequestId: repeated, text: link('note-c') });
    await (service as any).lane;
    expect((await service.status({ batchId: repeated })).items[0].state).toBe(
      'unknown',
    );
    expect(api).toHaveBeenCalledTimes(2);
    runtime.onModuleDestroy();
  }, 40000);
  it('checks persisted cancellation at the final dispatch boundary and refunds unused budget', async () => {
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>((r) => (entered = r)),
      gate = new Promise<void>((r) => (release = r));
    const { api, runtime, service } = await setup();
    const original = (runtime as any).sourceDispatch;
    (runtime as any).sourceDispatch = async (...args: any[]) => {
      entered();
      await gate;
      return original(...args);
    };
    await service.start({ clientRequestId: id, text: link('note-e') });
    await started;
    await service.cancel({ batchId: id });
    release();
    await (service as any).lane;
    expect(api).not.toHaveBeenCalled();
    const rows = await db.$queryRaw<
      Array<{ used: bigint }>
    >`SELECT used FROM xhs_request_budgets WHERE id='xhs:source-total'`;
    expect(Number(rows[0].used)).toBe(0);
    const batch = await service.status({ batchId: id });
    expect(batch.state).toBe('cancelled');
    expect(batch.items[0].state).toBe('needs_context');
    runtime.onModuleDestroy();
  }, 40000);
  it('marks interrupted work uncertain and requires new context for undispatched items', async () => {
    const doc = {
      batchId: id,
      state: 'running',
      items: [
        { index: 0, fingerprint: 'a', state: 'resolving' },
        { index: 1, fingerprint: 'b', state: 'queued' },
      ],
    };
    await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES(${'batch:' + id},'__batch__','batch_running',${JSON.stringify(doc)},0)`;
    const { api, runtime, service } = await setup();
    const batch = await service.status({ batchId: id });
    expect(batch.state).toBe('paused');
    expect(batch.items.map((x) => x.state)).toEqual([
      'unknown',
      'needs_context',
    ]);
    expect(api).not.toHaveBeenCalled();
    runtime.onModuleDestroy();
  }, 40000);
  it('marks an interrupted cancelled in-flight request unknown on restart', async () => {
    const doc = {
      batchId: id,
      state: 'cancelled',
      items: [{ index: 0, fingerprint: 'a', kind: 'note', state: 'resolving' }],
    };
    await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES(${'batch:' + id},'__batch__','batch_cancelled',${JSON.stringify(doc)},0)`;
    const { api, runtime, service } = await setup();
    const batch = await service.status({ batchId: id });
    expect(batch.state).toBe('cancelled');
    expect(batch.items[0].state).toBe('unknown');
    expect(api).not.toHaveBeenCalled();
    runtime.onModuleDestroy();
  }, 40000);
  it('stops the batch on an explicit platform refusal without dispatching later items', async () => {
    const { api, runtime, service } = await setup(async (request) => ({
      status: 461,
      url: request.url,
      body: {},
    }));
    await service.start({
      clientRequestId: id,
      text: [link('note-f'), link('note-g')].join('\n'),
    });
    await (service as any).lane;
    const batch = await service.status({ batchId: id });
    expect(batch.state).toBe('paused');
    expect(batch.items[0].state).toBe('failed');
    expect(batch.items[0].code).toBe('XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED');
    expect(batch.items[1].state).toBe('queued');
    expect(api).toHaveBeenCalledTimes(1);
    runtime.onModuleDestroy();
  }, 40000);
  it('retains an existing unknown single-note receipt and blocks matching direct or opaque short links', async () => {
    await db.$executeRaw`INSERT INTO xhs_limited_recovery(id,note_id,author_id,owner,state,created_at,updated_at,expires_at) VALUES('single-round','note-h','author','owner','unknown',0,0,0)`;
    const { api, runtime, service } = await setup();
    await service.start({ clientRequestId: id, text: link('note-h') });
    await (service as any).lane;
    expect((await service.status({ batchId: id })).state).toBe('paused');
    const second = '22222222-2222-4222-8222-222222222222';
    await service.start({
      clientRequestId: second,
      text: 'https://xhslink.cn/o/synthetic',
    });
    await (service as any).lane;
    expect((await service.status({ batchId: second })).state).toBe('paused');
    expect(api).not.toHaveBeenCalled();
    const claim = await db.$queryRaw<
      Array<{ state: string }>
    >`SELECT state FROM xhs_limited_recovery WHERE id='single-round'`;
    expect(claim[0].state).toBe('unknown');
    runtime.onModuleDestroy();
  }, 40000);
  it('pauses on exhausted budget without a source dispatch or increment', async () => {
    await db.$executeRaw`UPDATE xhs_request_budgets SET used=request_limit WHERE id='xhs:source-total'`;
    const { api, runtime, service } = await setup();
    await service.start({ clientRequestId: id, text: link('note-i') });
    await (service as any).lane;
    const batch = await service.status({ batchId: id });
    expect(batch.state).toBe('paused');
    expect(batch.items[0].state).toBe('needs_context');
    expect(batch.items[0].code).toBe('XHS_REQUEST_BUDGET_EXHAUSTED');
    expect(api).not.toHaveBeenCalled();
    const rows = await db.$queryRaw<
      Array<{ used: bigint }>
    >`SELECT used FROM xhs_request_budgets WHERE id='xhs:source-total'`;
    expect(Number(rows[0].used)).toBe(20);
    runtime.onModuleDestroy();
  }, 40000);
  it('keeps a completed redirect known when the subsequent detail request exceeds the shared budget', async () => {
    await db.$executeRaw`UPDATE xhs_request_budgets SET request_limit=1 WHERE id='xhs:source-total'`;
    const short = jest.fn(async (url: URL) => ({
      status: 302,
      url: url.href,
      location: link('note-after-redirect'),
    }));
    const { api, runtime, service } = await setup(undefined, short);
    await service.start({
      clientRequestId: id,
      text: 'https://xhslink.cn/o/synthetic',
    });
    await (service as any).lane;
    const batch = await service.status({ batchId: id });
    expect(batch.state).toBe('paused');
    expect(batch.items[0].state).toBe('needs_context');
    expect(batch.items[0].code).toBe('XHS_REQUEST_BUDGET_EXHAUSTED');
    expect(short).toHaveBeenCalledTimes(1);
    expect(api).not.toHaveBeenCalled();
    const rows = await db.$queryRaw<
      Array<{ used: bigint }>
    >`SELECT used FROM xhs_request_budgets WHERE id='xhs:source-total'`;
    expect(Number(rows[0].used)).toBe(1);
    runtime.onModuleDestroy();
  }, 40000);
  it('rolls back creator changes if its receipt transaction fails', async () => {
    const { api, runtime, service, subscriptions } = await setup();
    const before = await db.$queryRaw<
      Array<{ id: string; display_name: string }>
    >`SELECT id,display_name FROM xhs_creators ORDER BY id`;
    const original = subscriptions.subscribe.bind(subscriptions);
    jest
      .spyOn(subscriptions, 'subscribe')
      .mockImplementation((input, receipt) =>
        original(input, async (tx, creatorId, authorId) => {
          await receipt!(tx, creatorId, authorId);
          throw new Error('synthetic rollback');
        }),
      );
    await service.start({ clientRequestId: id, text: link('note-j') });
    await (service as any).lane;
    expect(api).toHaveBeenCalledTimes(1);
    expect((await service.status({ batchId: id })).items[0].state).toBe(
      'unknown',
    );
    expect(
      await db.$queryRaw`SELECT id,display_name FROM xhs_creators ORDER BY id`,
    ).toEqual(before);
    runtime.onModuleDestroy();
  }, 40000);
  it('does not dispatch a note while an opaque prior short-link result is unknown', async () => {
    const prior = '55555555-5555-4555-8555-555555555555';
    const doc = {
      batchId: prior,
      state: 'paused',
      items: [
        { index: 0, fingerprint: 'synthetic', kind: 'short', state: 'unknown' },
      ],
    };
    await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES(${'batch:' + prior},'__batch__','batch_paused',${JSON.stringify(doc)},0)`;
    const { api, runtime, service } = await setup();
    await service.start({ clientRequestId: id, text: link('note-k') });
    await (service as any).lane;
    const result = await service.status({ batchId: id });
    expect(result.state).toBe('paused');
    expect(result.items[0].code).toBe('XHS_TASK_RECEIPT_UNCERTAIN');
    expect(api).not.toHaveBeenCalled();
    runtime.onModuleDestroy();
  }, 40000);
  it('recovers separate interrupted batches in bounded separate write transactions', async () => {
    const { api, runtime, service } = await setup();
    const ids = [id, '66666666-6666-4666-8666-666666666666'];
    for (const batchId of ids) {
      const doc = {
        batchId,
        state: 'running',
        items: [
          { index: 0, fingerprint: 'a', kind: 'note', state: 'resolving' },
        ],
      };
      await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES(${'batch:' + batchId},'__batch__','batch_running',${JSON.stringify(doc)},0)`;
    }
    const writes = jest.spyOn(service as any, 'write');
    await service.onModuleInit();
    expect(writes).toHaveBeenCalledTimes(2);
    for (const batchId of ids)
      expect((await service.status({ batchId })).items[0].state).toBe(
        'unknown',
      );
    expect(api).not.toHaveBeenCalled();
    runtime.onModuleDestroy();
  }, 40000);
  it('does not replay when final dispatch completion is uncertain after transport entry', async () => {
    const { api, runtime, service } = await setup();
    (runtime as any).sourceDispatch = async (operation: any, ready: any) => {
      await ready();
      await operation();
      throw new Error('synthetic lost dispatch receipt');
    };
    await service.start({ clientRequestId: id, text: link('note-l') });
    await (service as any).lane;
    const result = await service.status({ batchId: id });
    expect(result.state).toBe('paused');
    expect(result.items[0].state).toBe('unknown');
    expect(api).toHaveBeenCalledTimes(1);
    runtime.onModuleDestroy();
  }, 40000);
  it('joins the actual protected HTTP contract, runtime and durable subscription receipt', async () => {
    const { api, runtime, service, subscriptions } = await setup();
    const config = new ConfigService({
      auth: { code: 'synthetic' },
      platform: { url: '' },
      feed: { updateDelayTime: 0 },
    });
    const router = new TrpcRouter(
      new TrpcService(db as any, config, {} as any, {} as any),
      db as any,
      config,
      {} as any,
      {} as any,
      undefined,
      subscriptions,
      runtime,
      undefined,
      undefined,
      service,
    ).appRouter;
    const server = createHTTPServer({
      router,
      createContext: () => ({
        errorMsg: null,
        isLocalSave: true,
        isLocalXhsRead: true,
      }),
    }).server;
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const port = (server.address() as import('node:net').AddressInfo).port;
      const client = createTRPCProxyClient<typeof router>({
        links: [httpLink({ url: `http://127.0.0.1:${port}` })],
      }).xiaohongshu;
      const started = await client.startSubscriptionBatch.mutate({
        clientRequestId: id,
        text: link('note-http'),
      });
      expect(started.batchId).toBe(id);
      await (service as any).lane;
      const receipt = await client.subscriptionBatch.query({ batchId: id });
      expect(receipt.state).toBe('completed');
      expect(receipt.items[0].state).toBe('subscribed');
      expect(receipt.items[0].creatorId).toBeTruthy();
      expect(api).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(receipt)).not.toContain('synthetic-secret');
      const rows = await db.$queryRaw<
        Array<{ document: string }>
      >`SELECT document FROM xhs_subscription_tasks WHERE id=${'batch:' + id}`;
      expect(rows[0].document).not.toContain('synthetic-secret');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      runtime.onModuleDestroy();
    }
  }, 40000);
});
