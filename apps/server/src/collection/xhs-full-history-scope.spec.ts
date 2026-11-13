import { withFixtureMigrationConnection } from '../../test/fixture-migration-connection';
import { XhsWholeCreatorService } from './xhs-whole-creator.service';
import { XhsSubscriptionService } from './xhs-subscription.service';
import { XhsSubscriptionRuntime } from './xhs-subscription-runtime';
import { XhsEngagementService } from './xhs-engagement.service';
import { XhsSourceRiskStore } from './xhs-source-risk-store';
import { PrismaClient } from '@prisma/client';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { splitSqliteStatements } from '../../../../scripts/sqlite-statements.cjs';
import {
  prepareFullHistoryScope,
  confirmFullHistoryScope,
  fullHistoryContext,
  dispatchFullHistoryRequest,
} from './xhs-full-history-scope';
import {
  admitUnboundRequest,
  settleUnboundRequest,
  assertUnboundDispatch,
} from './xhs-unbound-round';

it('binds all three existing jobs, preserves unknown and budgets, supports full pages, blocks unknown replay and wrong job', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'xhs-full-scope-'));
  const db = new PrismaClient({
    datasources: {
      db: {
        url: 'file:' + path.join(folder, 'fixture.sqlite').replace(/\\/g, '/'),
      },
    },
  });
  try {
    await withFixtureMigrationConnection(
      'file:' + path.join(folder, 'fixture.sqlite').replace(/\\/g, '/'),
      async (migrationClient) => {
        for (const name of (
          await fs.readdir(path.resolve(__dirname, '../../prisma/migrations'))
        ).sort()) {
          if (
            !(
              await fs.stat(
                path.resolve(__dirname, '../../prisma/migrations', name),
              )
            ).isDirectory()
          )
            continue;
          try {
            for (const sql of splitSqliteStatements(
              await fs.readFile(
                path.resolve(
                  __dirname,
                  '../../prisma/migrations',
                  name,
                  'migration.sql',
                ),
                'utf8',
              ),
            ))
              await migrationClient.$executeRawUnsafe(sql);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
          }
        }
      },
    );
    const bindings = ['a', 'b', 'c'].map((creatorId) => ({
      creatorId,
      jobId: randomUUID(),
    }));
    for (const b of bindings) {
      await db.xhsCreator.create({
        data: {
          id: b.creatorId,
          displayName: b.creatorId,
          profileUrl:
            'https://www.xiaohongshu.com/user/profile/author-' + b.creatorId,
          externalAuthorId: 'author-' + b.creatorId,
        },
      });
      const doc = {
        id: b.jobId,
        creatorId: b.creatorId,
        state: 'paused',
        sourceFence:
          b.creatorId === 'b'
            ? {
                marker: 'xhs:dispatch-pending:old',
                phase: 'detail',
                noteId: 'old-note',
                state: 'started',
              }
            : undefined,
      };
      await db.$executeRawUnsafe(
        "INSERT INTO xhs_whole_creator_jobs VALUES(?,?,'paused',?,1)",
        b.jobId,
        b.creatorId,
        JSON.stringify(doc),
      );
      await db.$executeRawUnsafe(
        'INSERT INTO xhs_request_budgets(id,used,request_limit,next_at,interval_ms) VALUES(?,7,100,0,1000)',
        b.jobId,
      );
    }
    await db.$executeRawUnsafe(
      "INSERT INTO xhs_request_budgets(id,used,request_limit,next_at,interval_ms) VALUES('xhs:source-total',19,100,0,1000),('xhs:dispatch-pending:old',1,1,0,0)",
    );
    const targetHash = createHash('sha256').update('hashed-old').digest('hex');
    await db.$executeRawUnsafe(
      "INSERT INTO xhs_subscription_tasks VALUES('historic','a','partial',?,1)",
      JSON.stringify({
        sourceUnknowns: [
          {
            phase: 'detail',
            targetHash,
            outcome: 'unknown',
            classification: 'request-outcome-unknown',
          },
        ],
      }),
    );
    const input = {
      bindings,
      sessionBinding: 'a'.repeat(64),
      maxRequests: 80,
      phaseLimits: { profile: 10, list: 10, detail: 30, media: 40 },
    };
    const before = await db.$queryRawUnsafe(
      'SELECT * FROM xhs_request_budgets ORDER BY id',
    );
    const plan = await db.$transaction((tx) =>
      prepareFullHistoryScope(tx, input),
    );
    expect(plan.scope.exclusions.a).toContainEqual({
      phase: 'detail',
      target: 'sha256:' + targetHash,
    });
    expect(plan.scope.exclusions.b).toContainEqual({
      phase: 'detail',
      target: 'old-note',
    });
    const host = {
      assertQuiescent: async () => {},
      assertSession: () => {},
      verifyBackup: async () => 'b'.repeat(64),
    };
    await expect(
      db.$transaction((tx) =>
        confirmFullHistoryScope(tx, input, 'f'.repeat(64), host, 2n),
      ),
    ).rejects.toThrow('REVIEW_STATE_CHANGED');
    const confirmed = await db.$transaction((tx) =>
      confirmFullHistoryScope(tx, input, plan.digest, host, 2n),
    );
    expect(
      await db.$queryRawUnsafe(
        "SELECT * FROM xhs_request_budgets WHERE id NOT LIKE 'xhs:full:%' ORDER BY id",
      ),
    ).toEqual(before);
    const context = {
      reviewId: confirmed.reviewId,
      creatorId: 'a',
      jobId: bindings[0].jobId,
      authorId: 'author-a',
      sessionBinding: input.sessionBinding,
    };
    await fullHistoryContext.run(context, async () => {
      const wrong = {
        operationId: randomUUID(),
        taskId: bindings[1].jobId,
        creatorId: 'a',
        phase: 'profile' as const,
        target: 'profile',
      };
      await expect(
        db.$transaction((tx) =>
          admitUnboundRequest(tx, confirmed.reviewId, wrong),
        ),
      ).rejects.toThrow('FULL_SCOPE_CONTEXT_REQUIRED');
      const page = {
        operationId: randomUUID(),
        taskId: context.jobId,
        creatorId: 'a',
        phase: 'list' as const,
        target: 'cursor:' + '0'.repeat(64),
      };
      await db.$transaction((tx) =>
        admitUnboundRequest(tx, confirmed.reviewId, page),
      );
      await expect(
        db.$transaction((tx) =>
          settleUnboundRequest(
            tx,
            confirmed.reviewId,
            page.operationId,
            'response-received',
            Array.from({ length: 61 }, (_, i) => 'note' + i),
          ),
        ),
      ).rejects.toThrow('LIST_RESULT_SCOPE_INVALID');
      await db.$transaction((tx) =>
        settleUnboundRequest(
          tx,
          confirmed.reviewId,
          page.operationId,
          'response-received',
          Array.from({ length: 32 }, (_, i) => 'note' + i),
        ),
      );
      await expect(
        db.$transaction((tx) =>
          admitUnboundRequest(tx, confirmed.reviewId, {
            ...page,
            operationId: randomUUID(),
          }),
        ),
      ).rejects.toThrow('FULL_SCOPE_TARGET_ALREADY_ATTEMPTED');
      await expect(
        db.$transaction((tx) =>
          admitUnboundRequest(tx, confirmed.reviewId, {
            ...page,
            operationId: randomUUID(),
            phase: 'detail',
            target: 'hashed-old',
          }),
        ),
      ).rejects.toThrow('HISTORICAL_UNKNOWN_TARGET_EXCLUDED');
      for (let i = 0; i < 2; i++) {
        const profile = {
          operationId: randomUUID(),
          taskId: context.jobId,
          creatorId: 'a',
          phase: 'profile' as const,
          target: 'profile',
        };
        await db.$transaction((tx) =>
          admitUnboundRequest(tx, confirmed.reviewId, profile),
        );
        await db.$transaction((tx) =>
          settleUnboundRequest(
            tx,
            confirmed.reviewId,
            profile.operationId,
            'response-received',
          ),
        );
      }
      let sent = 0;
      await dispatchFullHistoryRequest(
        (fn) => db.$transaction((tx) => fn(tx)),
        {
          operationId: randomUUID(),
          taskId: context.jobId,
          creatorId: 'a',
          phase: 'detail',
          target: 'note0',
        },
        {
          ready: () => {},
          send: async () => {
            await assertUnboundDispatch(db);
            sent++;
            return { status: 200 };
          },
          response: (v) => v,
          notSent: () => false,
        },
      );
      expect(sent).toBe(1);
      const shared = await db.$queryRawUnsafe<any[]>(
        "SELECT used FROM xhs_request_budgets WHERE id='xhs:source-total'",
      );
      expect(shared[0].used).toBe(20);
      const job = await db.$queryRawUnsafe<any[]>(
        'SELECT used FROM xhs_request_budgets WHERE id=?',
        context.jobId,
      );
      expect(job[0].used).toBe(7);
    });

    // Real product execution, synthetic transports and isolated SQLite only.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
      'base64',
    );
    const api = jest.fn(async (request: any) => {
      // A source call can observe only a committed, exact started request.
      await assertUnboundDispatch(db);
      const pending = await db.$queryRawUnsafe<any[]>(
        'SELECT outcome FROM xhs_unbound_owner_requests WHERE operation_id=?',
        (await import('./xhs-unbound-round')).unboundRoundContext.getStore()!
          .request.operationId,
      );
      expect(pending[0].outcome).toBe('started');
      const route = new URL(request.url).pathname;
      const data = route.endsWith('/user/otherinfo')
        ? {}
        : route.endsWith('/user_posted')
          ? {
              notes: [
                {
                  note_id: 'product-note',
                  user: { user_id: 'author-a' },
                  type: 'normal',
                  display_title: 'Product',
                  xsec_token: 'synthetic-access',
                },
              ],
              has_more: false,
              cursor: '',
            }
          : {
              items: [
                {
                  id: 'product-note',
                  note_card: {
                    note_id: 'product-note',
                    user: { user_id: 'author-a' },
                    type: 'normal',
                    time: 1760000000000,
                    title: 'Product',
                    desc: 'Synthetic full product body',
                    image_list: [
                      {
                        url_default:
                          'https://sns-webpic-qc.xhscdn.com/product.png',
                      },
                    ],
                    interact_info: {
                      liked_count: '1',
                      collected_count: '2',
                      share_count: '3',
                      comment_count: '4',
                    },
                  },
                },
              ],
            };
      return {
        status: 200,
        url: request.url,
        body: { success: true, code: 0, data },
      };
    });
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      media: async () =>
        new Response(new Uint8Array(png), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
      profileParser: () => ({
        id: 'author-a',
        name: 'A',
        profileUrl: 'https://www.xiaohongshu.com/user/profile/author-a',
      }),
      requirePersistentRisk: true,
    });
    const riskStore = new XhsSourceRiskStore(db as any);
    const assertion = jest.spyOn(riskStore, 'assertUnboundRoundAdmission');
    runtime.bindRiskStore(riskStore);
    await runtime.connectSession({ a1: 'synthetic', webSession: 'synthetic' });
    const subscriptions = new XhsSubscriptionService(db as any, runtime);
    const whole = new XhsWholeCreatorService(
      db as any,
      subscriptions,
      runtime,
      new XhsEngagementService(db as any, runtime),
    );
    try {
      const plan2 = await whole.prepareWholeCreatorFullHistory({
        bindings,
        maxRequests: 80,
        phaseLimits: input.phaseLimits,
      });
      expect(() => JSON.stringify(plan2)).not.toThrow();
      const confirmation2 = await db.$transaction((tx) =>
        confirmFullHistoryScope(
          tx,
          { ...input, sessionBinding: runtime.fullScopeSessionBinding() },
          plan2.digest,
          host,
          3n,
        ),
      );
      const started = await whole.executeWholeCreatorFullHistory({
        reviewId: confirmation2.reviewId,
        jobId: bindings[0].jobId,
      });
      let task = await subscriptions.task({ taskId: started.taskId });
      for (
        let i = 0;
        i < 1400 && ['queued', 'running'].includes(task.state);
        i++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        task = await subscriptions.task({ taskId: started.taskId });
      }
      if (task.code)
        throw new Error(
          JSON.stringify(
            {
              task,
              apiPaths: api.mock.calls.map((c) => new URL(c[0].url).pathname),
              requests: await db.$queryRawUnsafe(
                'SELECT phase,logical_target,outcome FROM xhs_unbound_owner_requests',
              ),
              risk: await db.$queryRawUnsafe('SELECT * FROM xhs_source_risk'),
            },
            (_, v) => (typeof v === 'bigint' ? String(v) : v),
          ),
        );
      expect(task).toMatchObject({
        state: 'completed',
        completed: 1,
        total: 1,
      });
      const cached = await db.xhsNote.findUnique({
        where: { id: JSON.stringify(['xiaohongshu', 'note', 'product-note']) },
      });
      expect(cached?.contentHtml).toContain('Synthetic full product body');
      expect(cached?.contentHtml).toContain('data:image/png;base64,');
      expect(assertion).toHaveBeenCalled();
      expect(api).toHaveBeenCalledTimes(3);
      await fullHistoryContext.run(
        {
          reviewId: confirmation2.reviewId,
          creatorId: 'a',
          jobId: bindings[0].jobId,
          authorId: 'author-a',
          sessionBinding: runtime.fullScopeSessionBinding(),
        },
        async () => {
          const response = await (runtime as any).guardTransport(
            async () => new Response('', { status: 429 }),
            'media',
            undefined,
            { phase: 'media', target: 'product-note:' + 'f'.repeat(64) },
          );
          expect(response.status).toBe(429);
          expect(await riskStore.read()).toBe('XHS_SOURCE_RATE_LIMIT_BLOCKED');
          let extraSent = false;
          await expect(
            (runtime as any).guardTransport(
              async () => {
                extraSent = true;
                return new Response('');
              },
              'media',
              undefined,
              { phase: 'media', target: 'product-note:' + 'e'.repeat(64) },
            ),
          ).rejects.toThrow('XHS_SOURCE_RATE_LIMIT_BLOCKED');
          expect(extraSent).toBe(false);
        },
      );

      const original = await db.$queryRawUnsafe<any[]>(
        'SELECT document FROM xhs_whole_creator_jobs WHERE id=?',
        bindings[1].jobId,
      );
      expect(JSON.parse(original[0].document).sourceFence.noteId).toBe(
        'old-note',
      );
    } finally {
      await (subscriptions as any).lane;
      await subscriptions.onModuleDestroy();
      runtime.onModuleDestroy();
    }

    // Independent unknown-response counterexample; reset only synthetic fixture risk.
    await db.$executeRawUnsafe(
      "UPDATE xhs_source_risk SET state='clear',owner=NULL,code=NULL,http_status=NULL,endpoint=NULL",
    );
    await db.$executeRawUnsafe(
      "UPDATE xhs_request_budgets SET next_at=0 WHERE id='xhs:source-total'",
    );
    await fullHistoryContext.run(
      {
        reviewId: confirmed.reviewId,
        creatorId: 'b',
        jobId: bindings[1].jobId,
        authorId: 'author-b',
        sessionBinding: input.sessionBinding,
      },
      async () => {
        const request = {
          operationId: randomUUID(),
          taskId: bindings[1].jobId,
          creatorId: 'b',
          phase: 'profile' as const,
          target: 'profile',
        };
        await expect(
          dispatchFullHistoryRequest(
            (fn) => db.$transaction((tx) => fn(tx)),
            request,
            {
              ready: () => {},
              send: async () => {
                throw Error('synthetic network unknown');
              },
              response: () => ({}),
              notSent: () => false,
            },
          ),
        ).rejects.toThrow('synthetic network unknown');
        const unknown = await db.$queryRawUnsafe<any[]>(
          'SELECT outcome FROM xhs_unbound_owner_requests WHERE operation_id=?',
          request.operationId,
        );
        expect(unknown[0].outcome).toBe('unknown');
        const risk = await db.$queryRawUnsafe<any[]>(
          "SELECT state FROM xhs_source_risk WHERE id='source'",
        );
        expect(risk[0].state).toBe('pending');
        let sent = false;
        await expect(
          dispatchFullHistoryRequest(
            (fn) => db.$transaction((tx) => fn(tx)),
            { ...request, operationId: randomUUID(), target: 'profile' },
            {
              ready: () => {},
              send: async () => {
                sent = true;
              },
              response: () => ({}),
              notSent: () => false,
            },
          ),
        ).rejects.toThrow('FULL_SCOPE_PROFILE_UNKNOWN');
        expect(sent).toBe(false);
      },
    );
  } finally {
    await db.$disconnect();
    await fs.rm(folder, { recursive: true, force: true });
  }
}, 40000);
