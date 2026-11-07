jest.mock('./sqlite-backup', () => ({ createVerifiedSqliteBackup: jest.fn() }));
import { createVerifiedSqliteBackup } from './sqlite-backup';
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
import { fullHistoryContext } from './xhs-full-history-scope';
import { assertUnboundDispatch } from './xhs-unbound-round';

it.each([false, true, 'rate-limited'])(
  'real narrow service excludes historical notes and continues after known local failure=%s',
  async (knownFailure) => {
    (createVerifiedSqliteBackup as jest.Mock).mockReset();
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'xhs-full-scope-'));
    const db = new PrismaClient({
      datasources: {
        db: {
          url:
            'file:' + path.join(folder, 'fixture.sqlite').replace(/\\/g, '/'),
        },
      },
    });
    try {
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
            await db.$executeRawUnsafe(sql);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
      }
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
      const targetHash = createHash('sha256')
        .update('hashed-old')
        .digest('hex');
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
      const oldId = 'unbound-' + 'a'.repeat(64),
        oldOperation = randomUUID();
      const oldScope = {
        reviewKind: 'whole-history-scope-v1',
        bindings,
        sessionBinding: 'a'.repeat(64),
        maxRequests: 100,
        phaseLimits: { profile: 10, list: 20, detail: 80, media: 80 },
        exclusions: {
          a: [],
          b: [
            { phase: 'detail', target: '*' },
            ...['product-note-0', 'product-note-1', 'product-note-2'].map(
              (target) => ({ phase: 'detail', target }),
            ),
          ],
          c: [],
        },
      };
      await db.$executeRawUnsafe(
        'INSERT INTO xhs_unbound_owner_reviews VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        oldId,
        'a'.repeat(64),
        '{}',
        'unknown',
        '[]',
        '[]',
        JSON.stringify({ a: 'author-a', b: 'author-b', c: 'author-c' }),
        '[]',
        JSON.stringify(oldScope),
        'f'.repeat(64),
        1,
      );
      for (const b of bindings)
        await db.$executeRawUnsafe(
          'INSERT INTO xhs_request_budgets(id,used,request_limit,next_at,interval_ms) VALUES(?,3,100,0,1000)',
          'xhs:full:' + oldId.slice(8) + ':' + b.jobId,
        );
      await db.$executeRawUnsafe(
        "INSERT INTO xhs_unbound_owner_requests VALUES(?,?,?,?,?,?,'unknown',NULL)",
        oldOperation,
        oldId,
        bindings[1].jobId,
        'b',
        'detail',
        'product-note-0',
      );
      const originalBudgets = await db.$queryRawUnsafe<any[]>(
        'SELECT * FROM xhs_request_budgets ORDER BY id',
      );
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
        if (knownFailure === 'rate-limited' && route.endsWith('/feed'))
          return {
            status: 429,
            url: request.url,
            body: { success: false, code: 300012, data: {} },
          };
        const data = route.endsWith('/user/otherinfo')
          ? {}
          : route.endsWith('/user_posted')
            ? {
                notes: Array.from({ length: 23 }, (_, i) => ({
                  note_id: 'product-note-' + i,
                  user: { user_id: 'author-b' },
                  type: 'normal',
                  display_title: 'Synthetic',
                  xsec_token: 'synthetic',
                })),
                has_more: false,
                cursor: '',
              }
            : {
                items: [
                  {
                    id: JSON.parse(request.body).source_note_id,
                    note_card: {
                      note_id: JSON.parse(request.body).source_note_id,
                      user: { user_id: 'author-b' },
                      type: 'normal',
                      time: 1760000000000,
                      title: 'Product',
                      desc:
                        knownFailure &&
                        JSON.parse(request.body).source_note_id ===
                          'product-note-7'
                          ? { malformed: 'synthetic confirmed response' }
                          : 'Synthetic full product body',
                      image_list: [],
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
          id: 'author-b',
          name: 'A',
          profileUrl: 'https://www.xiaohongshu.com/user/profile/author-b',
        }),
        requirePersistentRisk: true,
      });
      const riskStore = new XhsSourceRiskStore(db as any);
      const assertion = jest.spyOn(riskStore, 'assertUnboundRoundAdmission');
      runtime.bindRiskStore(riskStore);
      await runtime.connectSession({
        a1: 'synthetic',
        webSession: 'synthetic',
      });
      const subscriptions = new XhsSubscriptionService(db as any, runtime);
      const whole = new XhsWholeCreatorService(
        db as any,
        subscriptions,
        runtime,
        new XhsEngagementService(db as any, runtime),
      );
      try {
        const input = {
          reviewId: oldId,
          creatorId: 'b',
          jobId: bindings[1].jobId,
        };
        await db.$executeRawUnsafe(
          "UPDATE xhs_whole_creator_jobs SET state='running' WHERE id=?",
          bindings[0].jobId,
        );
        await expect(
          whole.confirmFullHistoryNarrowReview({
            ...input,
            digest: '0'.repeat(64),
            acknowledgedUnknownExclusions: true,
            acknowledgedDuplicateDirectoryRead: true,
          }),
        ).rejects.toThrow();
        expect(createVerifiedSqliteBackup).not.toHaveBeenCalled();
        await db.$executeRawUnsafe(
          "UPDATE xhs_whole_creator_jobs SET state='completed' WHERE id=?",
          bindings[0].jobId,
        );
        let releaseSession!: () => void;
        let enteredSession!: () => void;
        const heldSession = new Promise<void>((resolve) => {
          releaseSession = resolve;
        });
        const sessionEntered = new Promise<void>((resolve) => {
          enteredSession = resolve;
        });
        // Real runtime activity counter, synthetic suspended operation (no transport).
        const activeSession = fullHistoryContext.run(
          {
            reviewId: oldId,
            jobId: bindings[1].jobId,
            creatorId: 'b',
            authorId: 'author-b',
            sessionBinding: runtime.fullScopeSessionBinding(),
          },
          () =>
            (runtime as any).withSession(async () => {
              enteredSession();
              await heldSession;
            }),
        );
        await sessionEntered;
        expect(runtime.hasActiveSourceSessions()).toBe(true);
        try {
          await expect(
            whole.confirmFullHistoryNarrowReview({
              ...input,
              digest: '0'.repeat(64),
              acknowledgedUnknownExclusions: true,
              acknowledgedDuplicateDirectoryRead: true,
            }),
          ).rejects.toThrow('XHS_REQUEST_POLICY_INVALID');
          expect(createVerifiedSqliteBackup).not.toHaveBeenCalled();
        } finally {
          releaseSession();
          await activeSession;
        }
        expect(runtime.hasActiveSourceSessions()).toBe(false);
        const plan = await whole.prepareFullHistoryNarrowReview(input);
        (createVerifiedSqliteBackup as jest.Mock).mockResolvedValue({
          source: path.join(folder, 'fixture.sqlite'),
          backup: 'synthetic-invalid-witness',
          sha256: 'invalid',
          integrityCheck: 'ok',
          recoveryOrigin: {
            format: 'sqlite-recovery-origin-v1',
            kind: 'protected',
          },
        });
        const auditBefore = await db.$queryRawUnsafe<any[]>(
          'SELECT * FROM xhs_unbound_owner_reviews ORDER BY id',
        );
        const budgetsBefore = await db.$queryRawUnsafe<any[]>(
          'SELECT * FROM xhs_request_budgets ORDER BY id',
        );
        await expect(
          whole.confirmFullHistoryNarrowReview({
            ...input,
            digest: plan.digest,
            acknowledgedUnknownExclusions: true,
            acknowledgedDuplicateDirectoryRead: true,
          }),
        ).rejects.toThrow();
        expect(
          await db.$queryRawUnsafe(
            'SELECT * FROM xhs_unbound_owner_reviews ORDER BY id',
          ),
        ).toEqual(auditBefore);
        expect(
          await db.$queryRawUnsafe(
            'SELECT * FROM xhs_request_budgets ORDER BY id',
          ),
        ).toEqual(budgetsBefore);
        (createVerifiedSqliteBackup as jest.Mock).mockResolvedValue({
          source: path.join(folder, 'fixture.sqlite'),
          backup: 'synthetic-witness-only',
          sha256: 'f'.repeat(64),
          integrityCheck: 'ok',
          recoveryOrigin: {
            format: 'sqlite-recovery-origin-v1',
            kind: 'protected',
          },
        });
        const confirmation2 = await whole.confirmFullHistoryNarrowReview({
          ...input,
          digest: plan.digest,
          acknowledgedUnknownExclusions: true,
          acknowledgedDuplicateDirectoryRead: true,
        });
        const started = await whole.executeWholeCreatorFullHistory({
          reviewId: confirmation2.reviewId,
          jobId: bindings[1].jobId,
        });
        let task = await subscriptions.task({ taskId: started.taskId });
        for (
          let i = 0;
          i < 9000 && ['queued', 'running'].includes(task.state);
          i++
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          task = await subscriptions.task({ taskId: started.taskId });
        }
        if (knownFailure === 'rate-limited') {
          expect(task.state).toBe('blocked');
          expect(task.code).toBe('XHS_SOURCE_RATE_LIMIT_BLOCKED');
          expect(
            api.mock.calls.filter((c) =>
              new URL(c[0].url).pathname.endsWith('/feed'),
            ),
          ).toHaveLength(1);
          expect(
            (
              await db.$queryRawUnsafe<any[]>(
                "SELECT state,code FROM xhs_source_risk WHERE id='source'",
              )
            )[0],
          ).toEqual({
            state: 'blocked',
            code: 'XHS_SOURCE_RATE_LIMIT_BLOCKED',
          });
          const budget = await db.$queryRawUnsafe<any[]>(
            'SELECT used FROM xhs_request_budgets WHERE id=?',
            'xhs:full:' +
              confirmation2.reviewId.slice(8) +
              ':' +
              bindings[1].jobId,
          );
          expect(budget[0].used).toBe(3);
          const receipts = await db.$queryRawUnsafe<any[]>(
            "SELECT logical_target,outcome FROM xhs_unbound_owner_requests WHERE review_id=? AND phase='detail'",
            confirmation2.reviewId,
          );
          expect(receipts).toEqual([
            { logical_target: 'product-note-3', outcome: 'response-received' },
          ]);
          expect(
            await db.xhsNote.count({
              where: { creatorId: 'b', status: 'complete' },
            }),
          ).toBe(0);
          return;
        }
        expect(task).toMatchObject({
          state: 'partial',
          completed: knownFailure ? 19 : 20,
          failed: knownFailure ? 4 : 3,
          total: 23,
          remaining: 0,
          code: knownFailure
            ? 'XHS_DETAIL_PARSE_FAILED'
            : 'XHS_SOURCE_HISTORY_REVIEW_REQUIRED',
        });
        expect(
          await db.xhsNote.count({
            where: { creatorId: 'b', status: 'complete' },
          }),
        ).toBe(knownFailure ? 19 : 20);
        const cached = await db.xhsNote.findUnique({
          where: {
            id: JSON.stringify(['xiaohongshu', 'note', 'product-note-3']),
          },
        });
        expect(cached?.contentHtml).toContain('Synthetic full product body');

        const finalNote = await db.xhsNote.findUnique({
          where: {
            id: JSON.stringify(['xiaohongshu', 'note', 'product-note-22']),
          },
        });
        expect(finalNote?.status).toBe('complete');
        if (knownFailure) {
          const failedNote = await db.xhsNote.findUnique({
            where: {
              id: JSON.stringify(['xiaohongshu', 'note', 'product-note-7']),
            },
          });
          expect(failedNote?.status).not.toBe('complete');
          const receipt = await db.$queryRawUnsafe<any[]>(
            "SELECT outcome FROM xhs_unbound_owner_requests WHERE review_id=? AND phase='detail' AND logical_target='product-note-7'",
            confirmation2.reviewId,
          );
          expect(receipt).toEqual([{ outcome: 'response-received' }]);
        }
        const newBudget = await db.$queryRawUnsafe<any[]>(
          'SELECT used FROM xhs_request_budgets WHERE id=?',
          'xhs:full:' +
            confirmation2.reviewId.slice(8) +
            ':' +
            bindings[1].jobId,
        );
        expect(newBudget[0].used).toBe(22);
        expect(assertion).toHaveBeenCalled();
        expect(
          api.mock.calls.filter((c) =>
            new URL(c[0].url).pathname.endsWith('/feed'),
          ),
        ).toHaveLength(20);
        expect(
          api.mock.calls
            .filter((c) => new URL(c[0].url).pathname.endsWith('/feed'))
            .every(
              (c) =>
                ![
                  'product-note-0',
                  'product-note-1',
                  'product-note-2',
                ].includes(JSON.parse(c[0].body).source_note_id),
            ),
        ).toBe(true);
        await expect(
          whole.executeWholeCreatorFullHistory({
            reviewId: confirmation2.reviewId,
            jobId: bindings[1].jobId,
          }),
        ).rejects.toThrow();
        const after = await db.$queryRawUnsafe<any[]>(
          'SELECT * FROM xhs_request_budgets ORDER BY id',
        );
        expect(
          after.filter(
            (r) =>
              originalBudgets.some((b) => b.id === r.id) &&
              r.id !== 'xhs:source-total',
          ),
        ).toEqual(originalBudgets.filter((r) => r.id !== 'xhs:source-total'));
        expect(
          (
            await db.$queryRawUnsafe<any[]>(
              'SELECT outcome FROM xhs_unbound_owner_requests WHERE operation_id=?',
              oldOperation,
            )
          )[0].outcome,
        ).toBe('unknown');
      } finally {
        await (subscriptions as any).lane;
        await subscriptions.onModuleDestroy();
        runtime.onModuleDestroy();
      }
    } finally {
      await db.$disconnect();
      await fs.rm(folder, { recursive: true, force: true });
    }
  },
  120000,
);
