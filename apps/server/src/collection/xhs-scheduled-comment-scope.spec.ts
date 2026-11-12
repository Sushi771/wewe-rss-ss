import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { XhsSubscriptionRuntime } from './xhs-subscription-runtime';
import { XhsSourceRiskStore } from './xhs-source-risk-store';
import { XhsEngagementService } from './xhs-engagement.service';
import { XhsScheduledRunner } from './xhs-scheduled-runner';
import { XhsScheduledClock } from './xhs-scheduled-clock';
import {
  prepareScheduledPolicy,
  confirmScheduledPolicy,
  readScheduledCommentOmission,
} from './xhs-scheduled-review-scope';
import { scheduledTaskId } from './xhs-scheduled-admission';
import { applyFixtureMigrations } from '../../test/redbook-isolated/fixture-migrations';

// Real policy, runtime omission proof, engagement storage, runner and clock.
// Source responses, task-observation/archive ports and the protected-write host
// are synthetic. Production SQL, policy proof and the omission transaction run.
describe('scheduled comments outside the exact approved scope', () => {
  let db: PrismaClient,
    directory: string,
    runtime: XhsSubscriptionRuntime,
    engagement: XhsEngagementService;
  const creators = ['a', 'b', 'c'],
    round = '2026-11-11/14:00';
  const api = jest.fn(async (): Promise<any> => {
    throw Error('SOURCE_MUST_NOT_RUN');
  });
  const key = (id: string) =>
    JSON.stringify(['xiaohongshu', 'note', 'note-' + id]);
  let policyId: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'xhs-comment-scope-'));
    const url =
      'file:' + path.join(directory, 'fixture.sqlite').replace(/\\/g, '/');
    await applyFixtureMigrations(url);
    db = new PrismaClient({ datasources: { db: { url } } });
    api.mockClear();
    for (const id of creators) {
      await db.xhsCreator.create({
        data: {
          id,
          externalAuthorId: 'author-' + id,
          displayName: 'Synthetic',
          profileUrl: 'https://example.invalid/' + id,
          enabled: true,
        },
      });
      await db.xhsNote.create({
        data: {
          id: key(id),
          creatorId: id,
          title: 'Synthetic',
          publishTime: 1760000000,
          status: 'complete',
          kind: 'image-text',
          contentHtml: '<div id="js_content"><p>Synthetic</p></div>',
        },
      });
    }
    await db.$executeRawUnsafe(
      "INSERT INTO xhs_request_budgets(id,used,request_limit,next_at,interval_ms) VALUES('xhs:source-total',0,100,0,1000)",
    );
    runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      commentsEnabled: () => true,
      api,
      requirePersistentRisk: true,
    });
    runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    runtime.bindFullHistoryWriter((work) => db.$transaction((tx) => work(tx)));
    runtime.bindFullHistoryReader((work) => db.$transaction((tx) => work(tx)));
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    await db.$executeRawUnsafe(
      "INSERT INTO xhs_subscription_tasks VALUES('retained-old','b','blocked',?,1)",
      JSON.stringify({
        taskId: 'retained-old',
        creatorId: 'b',
        state: 'blocked',
        sourceActive: {
          phase: 'detail',
          outcome: 'started',
          targetHash: 'a'.repeat(64),
          cursorHash: 'b'.repeat(64),
          owner: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        },
      }),
    );
    const input = {
      creatorIds: creators,
      maxRequests: 30,
      phaseLimits: { profile: 3, list: 3, detail: 10, media: 10 },
    };
    await db.$transaction(async (tx) => {
      const plan = await prepareScheduledPolicy(tx, input);
      const confirmed = await confirmScheduledPolicy(
        tx,
        input,
        plan.digest,
        {
          assertQuiescent: async () => {},
          verifyBackup: async () => 'd'.repeat(64),
        },
        10n,
      );
      policyId = confirmed.policyId;
    });
    await seedRound(round);
    engagement = new XhsEngagementService(db as any, runtime);
    (engagement as any).write = (work: any) => db.$transaction(work);
  }, 20000);
  afterEach(async () => {
    runtime?.onModuleDestroy();
    await db?.$disconnect();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  async function seedRound(label: string) {
    for (const creatorId of creators) {
      await runtime.withScheduledReview(
        {
          round: label,
          creatorId,
          authorId: 'author-' + creatorId,
          phase: 'basic',
        },
        async () => {
          const taskId = scheduledTaskId(label, creatorId, 'basic');
          const document = {
            taskId,
            creatorId,
            state: 'partial',
            code: 'XHS_SCHEDULE_HISTORY_REVIEW_REQUIRED',
            schedule: { round: label, phase: 'basic' },
            noteIds: [key(creatorId)],
            items: { [key(creatorId)]: 'completed' },
            total: 1,
            completed: 1,
            skipped: 0,
            failed: 0,
            remaining: 0,
            historyExcludedIds: ['old-excluded'],
          };
          await db.$executeRawUnsafe(
            "INSERT INTO xhs_subscription_tasks VALUES(?,?,'partial',?,1)",
            taskId,
            creatorId,
            JSON.stringify(document),
          );
        },
      );
    }
  }
  async function grants() {
    return {
      reviews: await db.$queryRawUnsafe(
        'SELECT id,plan_digest,scope_json,CAST(approved_at AS TEXT) approved_at FROM xhs_unbound_owner_reviews ORDER BY id',
      ),
      requests: await db.$queryRawUnsafe(
        'SELECT * FROM xhs_unbound_owner_requests ORDER BY operation_id',
      ),
      budgets: await db.$queryRawUnsafe(
        'SELECT * FROM xhs_request_budgets ORDER BY id',
      ),
    };
  }
  it('settles an incomplete round once, preserves data and continues all authors without source work', async () => {
    const retainedBefore = await db.$queryRawUnsafe(
      "SELECT document FROM xhs_subscription_tasks WHERE id='retained-old'",
    );
    const before = await grants(),
      restore = jest.spyOn(runtime, 'restoreScheduledNoteContexts');
    const archive = jest.fn(async () => ({ incomplete: false }));
    const observed: string[] = [];
    const runner = new XhsScheduledRunner(
      { xhsCreator: { findMany: async () => creators.map((id) => ({ id })) } },
      {
        scheduleCreatorPhase: async ({ round: label, creatorId, phase }) => {
          observed.push(label + ':' + creatorId + ':' + phase);
          if (phase === 'media') return { state: 'nothing-to-archive' };
          return runtime.withScheduledReview(
            { round: label, creatorId, authorId: 'author-' + creatorId, phase },
            async () => ({ taskId: scheduledTaskId(label, creatorId, phase) }),
          );
        },
        task: async ({ taskId }) =>
          JSON.parse(
            (
              await db.$queryRawUnsafe<any[]>(
                'SELECT document FROM xhs_subscription_tasks WHERE id=?',
                taskId,
              )
            )[0].document,
          ),
        archiveScheduled: archive,
      },
      engagement,
    );
    const enqueue = jest.fn((label: string) => runner.run(label));
    const database = () => path.join(directory, 'fixture.sqlite');
    let clock = new XhsScheduledClock(database, enqueue);
    await clock.tick(Date.parse('2026-11-11T01:16:00Z'));
    await clock.tick(Date.parse('2026-11-11T06:00:00Z'));
    clock = new XhsScheduledClock(database, enqueue);
    await clock.tick(Date.parse('2026-11-11T06:01:00Z'));
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(archive).toHaveBeenCalledTimes(3);
    expect(observed).toHaveLength(6);
    const clockState = JSON.parse(
      await readFile(
        path.join(directory, '.xiaohongshu-active-schedule.json'),
        'utf8',
      ),
    );
    expect(clockState.pending).toBeUndefined();
    expect(clockState.lastSettled).toEqual({
      round,
      outcome: 'settled-incomplete',
    });
    for (const creatorId of creators) {
      const [row] = await db.$queryRawUnsafe<any[]>(
        'SELECT document FROM xhs_subscription_tasks WHERE id=?',
        scheduledTaskId(round, creatorId, 'basic'),
      );
      const doc = JSON.parse(row.document);
      expect(doc.commentCollection).toEqual({
        round,
        state: 'not-authorized',
        notCollectedNotes: 1,
      });
      expect(doc.commentSummary).toBeUndefined();
      expect(doc.scheduledArchive).toBeUndefined(); // Synthetic archive port grants no receipt.
      expect(doc.state).toBe('partial');
    }
    expect(await grants()).toEqual(before);
    expect(
      await db.$queryRawUnsafe(
        "SELECT document FROM xhs_subscription_tasks WHERE id='retained-old'",
      ),
    ).toEqual(retainedBefore);
    expect(
      await db.$queryRawUnsafe('SELECT * FROM xhs_comment_windows'),
    ).toEqual([]);
    expect(restore).not.toHaveBeenCalled();
    expect(api).not.toHaveBeenCalled();
    const next = '2026-11-11/17:30';
    await seedRound(next);
    await clock.tick(Date.parse('2026-11-11T09:30:00Z'));
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(archive).toHaveBeenCalledTimes(6);
    expect(api).not.toHaveBeenCalled();
  });
  it.each(['pending', 'failed', 'unknown', 'returned-end'])(
    'does not cover an existing %s comment outcome with an omission',
    async (kind) => {
      const window = {
        scope: 'top',
        scheduledRound: round,
        state: kind === 'pending' ? 'partial' : kind,
        ...(kind === 'pending'
          ? { pendingDispatch: { operation: 'synthetic' } }
          : {}),
      };
      const bytes = JSON.stringify(window);
      await db.$executeRawUnsafe(
        "INSERT INTO xhs_comment_windows VALUES(?,'top',?)",
        key('a'),
        bytes,
      );
      await expect(engagement.collectScheduled(round, 'a')).rejects.toThrow(
        'XHS_COMMENT_RECEIPT_UNCERTAIN',
      );
      const rows = await db.$queryRawUnsafe<any[]>(
        'SELECT document FROM xhs_comment_windows WHERE note_id=?',
        key('a'),
      );
      expect(rows[0].document).toBe(bytes);
      const [task] = await db.$queryRawUnsafe<any[]>(
        'SELECT document FROM xhs_subscription_tasks WHERE id=?',
        scheduledTaskId(round, 'a', 'basic'),
      );
      expect(JSON.parse(task.document).commentCollection).toBeUndefined();
      expect(api).not.toHaveBeenCalled();
    },
  );
  it('does not interpret a missing round review as a verified omission', async () => {
    await expect(
      runtime.scheduledCommentAuthorization({
        round: '2026-11-11/17:30',
        creatorId: 'a',
      }),
    ).rejects.toThrow('SCHEDULED_REVIEW_REQUIRED');
    expect(api).not.toHaveBeenCalled();
  });
  it.each(['session', 'task', 'risk', 'new-unknown'])(
    'fails closed on changed %s evidence before context or source use',
    async (kind) => {
      if (kind === 'session')
        await runtime.connectSession({
          a1: 'synthetic-new-a1',
          webSession: 'synthetic-new-session',
        });
      else if (kind === 'risk')
        await db.$executeRawUnsafe(
          "UPDATE xhs_source_risk SET state='blocked',code='XHS_SOURCE_AUTHENTICATION_BLOCKED' WHERE id='source'",
        );
      else if (kind === 'new-unknown') {
        const taskId = scheduledTaskId(round, 'a', 'basic');
        await db.$executeRawUnsafe(
          'UPDATE xhs_subscription_tasks SET document=json_set(document,\'$.sourceUnknowns\',json(\'[{"operationId":"new"}]\')) WHERE id=?',
          taskId,
        );
      } else if (kind === 'task')
        await db.$executeRawUnsafe(
          "UPDATE xhs_subscription_tasks SET state='completed' WHERE id=?",
          scheduledTaskId(round, 'a', 'basic'),
        );

      await expect(engagement.collectScheduled(round, 'a')).rejects.toThrow();
      expect(api).not.toHaveBeenCalled();
    },
  );
  it('retains a revoked policy and never converts it into a verified omission', async () => {
    await db.$executeRawUnsafe(
      'INSERT INTO xhs_unbound_owner_reviews VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      'synthetic-revocation',
      'f'.repeat(64),
      '{}',
      'unknown',
      '[]',
      '[]',
      '{}',
      '[]',
      JSON.stringify({
        reviewKind: 'scheduled-recurring-revocation-v1',
        policyId,
      }),
      'd'.repeat(64),
      250n,
    );
    const restore = jest.spyOn(runtime, 'restoreScheduledNoteContexts');
    await db.$executeRawUnsafe(
      "UPDATE xhs_subscription_tasks SET document=json_set(document,'$.listFinished',json('true'),'$.cursorHistory',json('[null]')) WHERE id=?",
      scheduledTaskId(round, 'a', 'basic'),
    );
    await expect(
      runtime.scheduledCommentAuthorization({ round, creatorId: 'a' }),
    ).rejects.toThrow('SCHEDULED_POLICY_UNAVAILABLE');
    await expect(engagement.collectScheduled(round, 'a')).rejects.toThrow(
      'SCHEDULED_POLICY_UNAVAILABLE',
    );
    expect(restore).not.toHaveBeenCalled();
    expect(
      await db.$queryRawUnsafe('SELECT * FROM xhs_comment_windows'),
    ).toEqual([]);
    const [row] = await db.$queryRawUnsafe<any[]>(
      'SELECT document FROM xhs_subscription_tasks WHERE id=?',
      scheduledTaskId(round, 'a', 'basic'),
    );
    expect(JSON.parse(row.document).commentCollection).toBeUndefined();
    expect(api).not.toHaveBeenCalled();
  });
  it.each(['pending', 'incomplete', 'archive'])(
    'does not settle a round stopped by %s after scope checks',
    async (stage) => {
      const called: string[] = [];
      const runner = new XhsScheduledRunner(
        {
          xhsCreator: { findMany: async () => creators.map((id) => ({ id })) },
        },
        {
          scheduleCreatorPhase: async ({ creatorId, phase }) => {
            called.push(creatorId + ':' + phase);
            return phase === 'basic'
              ? { taskId: creatorId }
              : { state: 'nothing-to-archive' };
          },
          task: async () => ({ state: 'completed', failed: 0, remaining: 0 }),
          archiveScheduled: async () => ({ incomplete: stage === 'archive' }),
        },
        {
          collectScheduled: async () => ({
            pending: stage === 'pending',
            incomplete: true,
            ...(stage === 'archive'
              ? { skipped: 'not-authorized' as const }
              : {}),
          }),
        },
      );
      const database = () => path.join(directory, 'fixture.sqlite');
      const clock = new XhsScheduledClock(database, (label) =>
        runner.run(label),
      );
      await clock.tick(Date.parse('2026-11-11T01:16:00Z'));
      await expect(
        clock.tick(Date.parse('2026-11-11T06:00:00Z')),
      ).rejects.toThrow(
        stage === 'pending'
          ? 'XHS_SCHEDULE_TASK_PENDING'
          : 'XHS_SCHEDULE_ROUND_INCOMPLETE',
      );
      const state = JSON.parse(
        await readFile(
          path.join(directory, '.xiaohongshu-active-schedule.json'),
          'utf8',
        ),
      );
      expect(state.pending.label).toBe(round);
      expect(state.lastSettled).toBeUndefined();
      expect(called).toEqual(['a:basic', 'a:media']);
      expect(api).not.toHaveBeenCalled();
    },
  );
  it.each([true, undefined, 'false', null])(
    'does not interpret malformed omission flags %s as false',
    async (flag) => {
      // An isolated read port presents changed immutable evidence; no review is
      // edited or deleted and no database trigger is disabled for this negative.
      for (const field of ['comments', 'replies']) {
        const reader = {
          $queryRawUnsafe: async (...args: any[]) => {
            const rows = await (db.$queryRawUnsafe as any)(...args);
            return rows.map((row: any) => {
              if (!row.scope_json) return row;
              const scope = JSON.parse(row.scope_json);
              scope[field] = flag;
              return {
                ...row,
                scope_json: JSON.stringify(scope),
                ...(scope.reviewKind === 'scheduled-round-review-v1'
                  ? {
                      plan_digest: createHash('sha256')
                        .update(JSON.stringify(scope))
                        .digest('hex'),
                    }
                  : {}),
              };
            });
          },
          $executeRawUnsafe: async () => {
            throw Error('READ_ONLY_TEST');
          },
        };
        await expect(
          readScheduledCommentOmission(reader as any, {
            round,
            creatorId: 'a',
            sessionBinding: (runtime as any).fullScopeSessionBinding(),
          }),
        ).rejects.toThrow('SCHEDULED_POLICY_LIMIT_INVALID');
      }
      expect(api).not.toHaveBeenCalled();
    },
  );
  it.each([0, 1])(
    'does not replace same-round summary evidence (failedNotes=%s)',
    async (failedNotes) => {
      const taskId = scheduledTaskId(round, 'a', 'basic');
      const summary = JSON.stringify({
        round,
        failedNotes,
        completedNotes: 1 - failedNotes,
      });
      await db.$executeRawUnsafe(
        "UPDATE xhs_subscription_tasks SET document=json_set(document,'$.commentSummary',json(?)) WHERE id=?",
        summary,
        taskId,
      );
      const before = await db.$queryRawUnsafe(
        'SELECT document FROM xhs_subscription_tasks WHERE id=?',
        taskId,
      );
      await expect(engagement.collectScheduled(round, 'a')).rejects.toThrow(
        'XHS_COMMENT_RECEIPT_UNCERTAIN',
      );
      expect(
        await db.$queryRawUnsafe(
          'SELECT document FROM xhs_subscription_tasks WHERE id=?',
          taskId,
        ),
      ).toEqual(before);
      expect(api).not.toHaveBeenCalled();
    },
  );
  it('preserves a prior-round summary when the current round is not collected', async () => {
    const taskId = scheduledTaskId(round, 'a', 'basic');
    const summary = {
      round: '2026-11-10/14:00',
      savedComments: 17,
      incompleteRoots: 3,
    };
    await db.$executeRawUnsafe(
      "UPDATE xhs_subscription_tasks SET document=json_set(document,'$.commentSummary',json(?)) WHERE id=?",
      JSON.stringify(summary),
      taskId,
    );
    expect(await engagement.collectScheduled(round, 'a')).toEqual({
      pending: false,
      incomplete: true,
      skipped: 'not-authorized',
    });
    const [row] = await db.$queryRawUnsafe<any[]>(
      'SELECT document FROM xhs_subscription_tasks WHERE id=?',
      taskId,
    );
    expect(JSON.parse(row.document).commentSummary).toEqual(summary);
    expect(JSON.parse(row.document).commentCollection.state).toBe(
      'not-authorized',
    );
    expect(api).not.toHaveBeenCalled();
  });
});
