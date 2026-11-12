import { PrismaClient } from '@prisma/client';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { splitSqliteStatements } from '../../../../scripts/sqlite-statements.cjs';
import {
  prepareScheduledPolicy,
  confirmScheduledPolicy,
  prepareScheduledTaskReview,
  assertScheduledRoundAdmission,
} from './xhs-scheduled-review-scope';
import { scheduledTaskId } from './xhs-scheduled-admission';
import { fullHistoryContext } from './xhs-full-history-scope';
import { admitUnboundRequest } from './xhs-unbound-round';
import { XhsScheduledRunner } from './xhs-scheduled-runner';

it('reads real millisecond INTEGER approvals and orders 9/10 numerically through the actual recurring review path', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xhs-policy-clock-'));
  const db = new PrismaClient({
    datasources: {
      db: {
        url:
          'file:' +
          path.join(dir, 'synthetic.sqlite').replace(/\\/g, '/') +
          '?connection_limit=1',
      },
    },
  });
  try {
    const migrations = path.resolve(__dirname, '../../prisma/migrations');
    for (const name of (await fs.readdir(migrations)).sort()) {
      if (!(await fs.stat(path.join(migrations, name))).isDirectory()) continue;
      for (const sql of splitSqliteStatements(
        await fs.readFile(path.join(migrations, name, 'migration.sql'), 'utf8'),
      ))
        await db.$executeRawUnsafe(sql);
    }
    const creatorIds = ['clock-a', 'clock-b', 'clock-c'];
    for (const id of creatorIds)
      await db.xhsCreator.create({
        data: {
          id,
          externalAuthorId: 'author-' + id,
          displayName: 'Synthetic',
          profileUrl: 'https://example.invalid/' + id,
        },
      });
    await db.$executeRawUnsafe(
      "INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,1000)",
    );
    let expectedPolicy: string | undefined;
    const now = BigInt(Date.now());
    expect(now).toBeGreaterThan(2147483647n);
    for (const [index, approvalTime] of [9n, 10n, now].entries()) {
      const input = {
        creatorIds,
        maxRequests: 20 + index,
        phaseLimits: { profile: 3, list: 3, detail: 10, media: 10 },
      };
      const confirmed = await db.$transaction(async (tx) => {
        const plan = await prepareScheduledPolicy(tx, input);
        return confirmScheduledPolicy(
          tx,
          input,
          plan.digest,
          {
            assertQuiescent: async () => {
              const active = await tx.$queryRawUnsafe<any[]>(
                "SELECT id FROM xhs_subscription_tasks WHERE state IN ('queued','running') UNION ALL SELECT id FROM xhs_whole_creator_jobs WHERE state IN ('queued','running')",
              );
              expect(active).toEqual([]);
            },
            // Synthetic metadata witness only; no production backup or permission.
            verifyBackup: async (digest) => {
              expect(digest).toBe(plan.digest);
              return createHash('sha256').update(digest).digest('hex');
            },
          },
          approvalTime,
        );
      });
      expectedPolicy = confirmed.policyId;
      const round = '2026-11-0' + (index + 1) + '/09:15';
      const review = await db.$transaction((tx) =>
        prepareScheduledTaskReview(
          tx,
          {
            round,
            creatorId: creatorIds[0],
            authorId: 'author-' + creatorIds[0],
            phase: 'basic',
            taskId: scheduledTaskId(round, creatorIds[0], 'basic'),
            sessionBinding: 'a'.repeat(64),
          },
          approvalTime + 1n,
        ),
      );
      expect(review).toBeDefined();
      const rows = await db.$queryRawUnsafe<Array<{ scope_json: string }>>(
        'SELECT scope_json FROM xhs_unbound_owner_reviews WHERE id=?',
        review!.reviewId,
      );
      expect(JSON.parse(rows[0].scope_json)).toMatchObject({
        policyId: expectedPolicy,
        maxRequests: 20 + index,
      });
      if (index === 2) {
        const observedInput = {
          round,
          creatorId: creatorIds[0],
          authorId: 'author-' + creatorIds[0],
          phase: 'basic' as const,
          taskId: review!.jobId,
          sessionBinding: 'b'.repeat(64),
        };
        const beforeObservation = async () => ({
          budgets: await db.$queryRawUnsafe(
            'SELECT id,used,next_at FROM xhs_request_budgets ORDER BY id',
          ),
          reviews: await db.$queryRawUnsafe(
            'SELECT id,scope_json FROM xhs_unbound_owner_reviews ORDER BY id',
          ),
          requests: await db.$queryRawUnsafe(
            'SELECT operation_id,outcome FROM xhs_unbound_owner_requests ORDER BY operation_id',
          ),
        });
        const baselineObservation = await beforeObservation();
        const terminal = {
          taskId: review!.jobId,
          creatorId: creatorIds[0],
          schedule: { round, phase: 'basic' },
          state: 'completed',
          failed: 0,
        };
        await db.$executeRawUnsafe(
          "INSERT INTO xhs_subscription_tasks VALUES(?,?,'completed',?,1)",
          review!.jobId,
          creatorIds[0],
          JSON.stringify(terminal),
        );
        // A new runtime session may observe a settled task, never receive work.
        await expect(
          db.$transaction((tx) =>
            prepareScheduledTaskReview(tx, observedInput, approvalTime + 2n),
          ),
        ).resolves.toBeUndefined();
        const historyPartial = {
          ...terminal,
          state: 'partial',
          code: 'XHS_SCHEDULE_HISTORY_REVIEW_REQUIRED',
          remaining: 0,
          completed: 2,
          total: 2,
          historyExcludedIds: [JSON.stringify(['xiaohongshu', 'note', 'old'])],
          sourceActive: false,
          sourceUnknowns: [],
        };
        const replaceTask = async (doc: any) =>
          db.$executeRawUnsafe(
            'UPDATE xhs_subscription_tasks SET state=?,document=? WHERE id=?',
            doc.state,
            JSON.stringify(doc),
            review!.jobId,
          );
        await replaceTask(historyPartial);
        const savedHistory = await db.$queryRawUnsafe(
          'SELECT * FROM xhs_subscription_tasks ORDER BY id',
        );
        const observedPhases: string[] = [];
        const runner = new XhsScheduledRunner(
          {
            xhsCreator: {
              findMany: async () => creatorIds.map((id) => ({ id })),
            },
          },
          {
            scheduleCreatorPhase: async ({ creatorId, phase }) => {
              observedPhases.push(creatorId + ':' + phase);
              if (creatorId === creatorIds[0] && phase === 'basic') {
                await expect(
                  db.$transaction((tx) =>
                    prepareScheduledTaskReview(
                      tx,
                      observedInput,
                      approvalTime + 2n,
                    ),
                  ),
                ).resolves.toBeUndefined();
                return { taskId: review!.jobId };
              }
              return phase === 'basic'
                ? { taskId: creatorId }
                : { state: 'nothing-to-archive' };
            },
            task: async ({ taskId }) =>
              taskId === review!.jobId
                ? historyPartial
                : { state: 'completed', failed: 0, remaining: 0 },
          },
        );
        // Repeated clock observations reach media and every later creator, while
        // retaining the excluded task and incomplete result without new grants.
        for (let tick = 0; tick < 2; tick++) {
          await expect(runner.run(round)).rejects.toThrow(
            'XHS_SCHEDULE_ROUND_INCOMPLETE',
          );
          expect(observedPhases.splice(0)).toEqual(
            creatorIds.flatMap((id) => [id + ':basic', id + ':media']),
          );
          expect(await beforeObservation()).toEqual(baselineObservation);
          expect(
            await db.$queryRawUnsafe(
              'SELECT * FROM xhs_subscription_tasks ORDER BY id',
            ),
          ).toEqual(savedHistory);
        }
        const mediaId = scheduledTaskId(round, creatorIds[0], 'media');
        await db.$executeRawUnsafe(
          "INSERT INTO xhs_subscription_tasks VALUES(?,?,'partial',?,1)",
          mediaId,
          creatorIds[0],
          JSON.stringify({
            ...historyPartial,
            taskId: mediaId,
            schedule: { round, phase: 'media' },
          }),
        );
        await expect(
          db.$transaction((tx) =>
            prepareScheduledTaskReview(
              tx,
              {
                ...observedInput,
                phase: 'media',
                taskId: mediaId,
              },
              approvalTime + 2n,
            ),
          ),
        ).rejects.toThrow('SCHEDULED_TASK_BINDING_CHANGED');
        const mediaInput = {
          ...observedInput,
          phase: 'media' as const,
          taskId: mediaId,
          // Match the existing round session; observation must not mint a grant.
          sessionBinding: 'a'.repeat(64),
        };
        const replaceMedia = async (doc: any) =>
          db.$executeRawUnsafe(
            'UPDATE xhs_subscription_tasks SET state=?,document=? WHERE id=?',
            doc.state,
            JSON.stringify(doc),
            mediaId,
          );
        for (const code of [
          'XHS_MEDIA_REVIEW_REQUIRED',
          'XHS_MEDIA_NEEDS_DETAIL_REFRESH',
        ]) {
          const mediaIds = Array.from({ length: 131 }, (_, i) =>
            JSON.stringify(['xiaohongshu', 'note', 'synthetic-' + i]),
          );
          const mediaPartial = {
            taskId: mediaId,
            creatorId: creatorIds[0],
            schedule: { round, phase: 'media', batch: 0 },
            state: 'partial',
            code,
            total: 131,
            completed: 0,
            skipped: 131,
            failed: 0,
            remaining: 0,
            noteIds: mediaIds,
            items: Object.fromEntries(mediaIds.map((id) => [id, 'skipped'])),
            scheduledMediaResults: Object.fromEntries(
              mediaIds.map((id) => [
                id,
                code === 'XHS_MEDIA_REVIEW_REQUIRED'
                  ? 'needs-review'
                  : 'needs-detail-refresh',
              ]),
            ),
          };
          await replaceMedia(mediaPartial);
          await expect(
            db.$transaction((tx) =>
              prepareScheduledTaskReview(tx, mediaInput, approvalTime + 2n),
            ),
          ).resolves.toBeUndefined();
          // A settled observation from another instance is read-only; it does
          // not rebind the round or authorize the next creator's source work.
          await expect(
            db.$transaction((tx) =>
              prepareScheduledTaskReview(
                tx,
                { ...mediaInput, sessionBinding: 'b'.repeat(64) },
                approvalTime + 2n,
              ),
            ),
          ).resolves.toBeUndefined();
          await expect(
            db.$transaction((tx) =>
              prepareScheduledTaskReview(
                tx,
                {
                  ...observedInput,
                  creatorId: creatorIds[1],
                  authorId: 'author-' + creatorIds[1],
                  taskId: scheduledTaskId(round, creatorIds[1], 'basic'),
                },
                approvalTime + 2n,
              ),
            ),
          ).rejects.toThrow('SCHEDULED_ROUND_SESSION_CHANGED');
          await db.$executeRawUnsafe(
            "UPDATE xhs_subscription_tasks SET state='completed' WHERE id=?",
            mediaId,
          );
          await expect(
            db.$transaction((tx) =>
              prepareScheduledTaskReview(tx, mediaInput, approvalTime + 2n),
            ),
          ).rejects.toThrow('SCHEDULED_TASK_BINDING_CHANGED');
          await replaceMedia(mediaPartial);
          const mixed = {
            ...mediaPartial,
            completed: 1,
            skipped: 130,
            items: { ...mediaPartial.items, [mediaIds[0]]: 'completed' },
            scheduledMediaResults: {
              ...mediaPartial.scheduledMediaResults,
              [mediaIds[0]]: 'complete',
              [mediaIds[1]]: 'needs-detail-refresh',
            },
          };
          await replaceMedia(mixed);
          await expect(
            db.$transaction((tx) =>
              prepareScheduledTaskReview(tx, mediaInput, approvalTime + 2n),
            ),
          ).resolves.toBeUndefined();
          await replaceMedia(mediaPartial);
          for (const outcome of ['started', 'unknown']) {
            const operationId = randomUUID();
            await db.$executeRawUnsafe(
              'INSERT INTO xhs_unbound_owner_requests VALUES(?,?,?,?,?,?,?,NULL)',
              operationId,
              review!.reviewId,
              mediaId,
              creatorIds[0],
              'media',
              'synthetic:' + 'c'.repeat(64),
              outcome,
            );
            await expect(
              db.$transaction((tx) =>
                prepareScheduledTaskReview(tx, mediaInput, approvalTime + 2n),
              ),
            ).rejects.toThrow('SCHEDULED_NEW_UNKNOWN_REVIEW_REQUIRED');
            await db.$executeRawUnsafe(
              'DELETE FROM xhs_unbound_owner_requests WHERE operation_id=?',
              operationId,
            );
          }
          const unchangedTasks = await db.$queryRawUnsafe(
            'SELECT * FROM xhs_subscription_tasks ORDER BY id',
          );
          const phases: string[] = [];
          const mediaRunner = new XhsScheduledRunner(
            {
              xhsCreator: {
                findMany: async () => creatorIds.map((id) => ({ id })),
              },
            },
            {
              scheduleCreatorPhase: async ({ creatorId, phase, batch }) => {
                phases.push(creatorId + ':' + phase + ':' + (batch ?? 0));
                if (
                  creatorId === creatorIds[0] &&
                  (phase === 'basic' || batch === 0)
                ) {
                  await db.$transaction((tx) =>
                    prepareScheduledTaskReview(
                      tx,
                      phase === 'basic' ? observedInput : mediaInput,
                      approvalTime + 2n,
                    ),
                  );
                  return {
                    taskId: phase === 'basic' ? review!.jobId : mediaId,
                  };
                }
                return phase === 'basic'
                  ? { taskId: creatorId }
                  : { state: 'nothing-to-archive' };
              },
              task: async ({ taskId }) =>
                taskId === review!.jobId
                  ? historyPartial
                  : taskId === mediaId
                    ? mediaPartial
                    : { state: 'completed', failed: 0, remaining: 0 },
            },
          );
          for (let tick = 0; tick < 2; tick++) {
            await expect(mediaRunner.run(round)).rejects.toThrow(
              'XHS_SCHEDULE_ROUND_INCOMPLETE',
            );
            expect(phases.splice(0)).toEqual([
              creatorIds[0] + ':basic:0',
              creatorIds[0] + ':media:0',
              creatorIds[0] + ':media:1',
              ...creatorIds
                .slice(1)
                .flatMap((id) => [id + ':basic:0', id + ':media:0']),
            ]);
            expect(await beforeObservation()).toEqual(baselineObservation);
            expect(
              await db.$queryRawUnsafe(
                'SELECT * FROM xhs_subscription_tasks ORDER BY id',
              ),
            ).toEqual(unchangedTasks);
          }
          for (const [change, expected] of [
            [{ scheduledMediaResults: {} }, 'SCHEDULED_TASK_BINDING_CHANGED'],
            [{ scheduledMediaResults: [] }, 'SCHEDULED_TASK_BINDING_CHANGED'],
            [
              {
                scheduledMediaResults: {
                  ...mediaPartial.scheduledMediaResults,
                  [mediaIds[0]]: 'unknown',
                },
              },
              'SCHEDULED_TASK_BINDING_CHANGED',
            ],
            [
              {
                scheduledMediaResults: {
                  ...mediaPartial.scheduledMediaResults,
                  [mediaIds[0]]: 'failed',
                },
              },
              'SCHEDULED_TASK_BINDING_CHANGED',
            ],
            [
              { items: { ...mediaPartial.items, [mediaIds[0]]: 'pending' } },
              'SCHEDULED_TASK_BINDING_CHANGED',
            ],
            [{ total: 132 }, 'SCHEDULED_TASK_BINDING_CHANGED'],
            [{ completed: 1 }, 'SCHEDULED_TASK_BINDING_CHANGED'],
            [{ skipped: 130 }, 'SCHEDULED_TASK_BINDING_CHANGED'],
            [{ noteIds: [] }, 'SCHEDULED_TASK_BINDING_CHANGED'],
            [
              { noteIds: [...mediaIds.slice(0, 130), mediaIds[0]] },
              'SCHEDULED_TASK_BINDING_CHANGED',
            ],
            [
              {
                code:
                  code === 'XHS_MEDIA_REVIEW_REQUIRED'
                    ? 'XHS_MEDIA_NEEDS_DETAIL_REFRESH'
                    : 'XHS_MEDIA_REVIEW_REQUIRED',
              },
              'SCHEDULED_TASK_BINDING_CHANGED',
            ],
            [{ taskId: 'wrong-task' }, 'SCHEDULED_TASK_BINDING_CHANGED'],
            [{ creatorId: creatorIds[1] }, 'SCHEDULED_TASK_BINDING_CHANGED'],
            [
              { schedule: { round: 'wrong-round', phase: 'media' } },
              'SCHEDULED_TASK_BINDING_CHANGED',
            ],
            [
              { sourceFence: { operationId: 'new' } },
              'SCHEDULED_NEW_UNKNOWN_REVIEW_REQUIRED',
            ],
            [{ remaining: 1 }, 'SCHEDULED_TASK_BINDING_CHANGED'],
            [{ failed: 1 }, 'SCHEDULED_TASK_BINDING_CHANGED'],
            [
              { code: 'XHS_MEDIA_OUTCOME_UNKNOWN' },
              'SCHEDULED_TASK_BINDING_CHANGED',
            ],
            [
              { schedule: { round, phase: 'basic' } },
              'SCHEDULED_TASK_BINDING_CHANGED',
            ],
            [
              { schedule: { round, phase: 'media', batch: 1 } },
              'SCHEDULED_TASK_BINDING_CHANGED',
            ],
            [
              { sourceActive: { phase: 'media', noteId: 'new' } },
              'SCHEDULED_NEW_UNKNOWN_REVIEW_REQUIRED',
            ],
            [
              { sourceUnknowns: [{ operationId: 'new' }] },
              'SCHEDULED_NEW_UNKNOWN_REVIEW_REQUIRED',
            ],
          ] as const) {
            await replaceMedia({ ...mediaPartial, ...change });
            await expect(
              db.$transaction((tx) =>
                prepareScheduledTaskReview(tx, mediaInput, approvalTime + 2n),
              ),
            ).rejects.toThrow(expected);
            expect(await beforeObservation()).toEqual(baselineObservation);
          }
        }
        await db.$executeRawUnsafe(
          'DELETE FROM xhs_subscription_tasks WHERE id=?',
          mediaId,
        );
        for (const [changed, code] of [
          [
            { ...historyPartial, remaining: 1 },
            'SCHEDULED_TASK_BINDING_CHANGED',
          ],
          [{ ...historyPartial, failed: 1 }, 'SCHEDULED_TASK_BINDING_CHANGED'],
          [
            { ...historyPartial, historyExcludedIds: [] },
            'SCHEDULED_TASK_BINDING_CHANGED',
          ],
          [
            { ...historyPartial, historyExcludedIds: [null] },
            'SCHEDULED_TASK_BINDING_CHANGED',
          ],
          [
            { ...historyPartial, code: 'XHS_DETAIL_OUTCOME_UNKNOWN' },
            'SCHEDULED_TASK_BINDING_CHANGED',
          ],
          [
            { ...historyPartial, schedule: { round, phase: 'media' } },
            'SCHEDULED_TASK_BINDING_CHANGED',
          ],
          [
            {
              ...historyPartial,
              sourceActive: { phase: 'detail', noteId: 'new' },
            },
            'SCHEDULED_NEW_UNKNOWN_REVIEW_REQUIRED',
          ],
          [
            { ...historyPartial, sourceUnknowns: [{ operationId: 'new' }] },
            'SCHEDULED_NEW_UNKNOWN_REVIEW_REQUIRED',
          ],
        ] as const) {
          await replaceTask(changed);
          await expect(
            db.$transaction((tx) =>
              prepareScheduledTaskReview(tx, observedInput, approvalTime + 2n),
            ),
          ).rejects.toThrow(code);
          expect(await beforeObservation()).toEqual(baselineObservation);
        }
        for (const [caseIndex, changed] of [
          {
            ...terminal,
            sourceUnknowns: [{ operationId: 'synthetic-unknown' }],
          },
          { ...terminal, schedule: { round: 'wrong-round', phase: 'basic' } },
          {
            ...terminal,
            state: 'partial',
            failed: 1,
            remaining: 0,
            code: 'XHS_DETAIL_OUTCOME_UNKNOWN',
          },
        ].entries()) {
          await db.$executeRawUnsafe(
            'UPDATE xhs_subscription_tasks SET state=?,document=? WHERE id=?',
            changed.state,
            JSON.stringify(changed),
            review!.jobId,
          );
          await expect(
            db.$transaction((tx) =>
              prepareScheduledTaskReview(tx, observedInput, approvalTime + 2n),
            ),
          ).rejects.toThrow(
            caseIndex === 0
              ? 'SCHEDULED_NEW_UNKNOWN_REVIEW_REQUIRED'
              : 'SCHEDULED_TASK_BINDING_CHANGED',
          );
        }
        expect(await beforeObservation()).toEqual(baselineObservation);
        await db.$executeRawUnsafe(
          'DELETE FROM xhs_subscription_tasks WHERE id=?',
          review!.jobId,
        );
        const request = {
          operationId: randomUUID(),
          taskId: review!.jobId,
          creatorId: creatorIds[0],
          phase: 'profile' as const,
          target: 'profile',
        };
        await expect(
          db.$transaction((tx) =>
            assertScheduledRoundAdmission(
              tx,
              'unbound-' + '0'.repeat(64),
              { id: review!.reviewId, scope_json: rows[0].scope_json },
              request,
            ),
          ),
        ).rejects.toThrow('SCHEDULED_REVIEW_REQUIRED');
        await db.$executeRawUnsafe(
          "INSERT INTO xhs_subscription_tasks VALUES(?,?,'running',?,1)",
          review!.jobId,
          creatorIds[0],
          JSON.stringify({
            taskId: review!.jobId,
            creatorId: creatorIds[0],
            schedule: { round, phase: 'basic' },
          }),
        );
        await fullHistoryContext.run(review!, () =>
          db.$transaction((tx) =>
            admitUnboundRequest(tx, review!.reviewId, request),
          ),
        );
        expect(
          await db.$queryRawUnsafe(
            'SELECT review_id,phase,outcome FROM xhs_unbound_owner_requests WHERE operation_id=?',
            request.operationId,
          ),
        ).toEqual([
          { review_id: review!.reviewId, phase: 'profile', outcome: 'started' },
        ]);
      }
    }
  } finally {
    await db.$disconnect();
    await fs.rm(dir, { recursive: true, force: true });
  }
}, 40000);
