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
