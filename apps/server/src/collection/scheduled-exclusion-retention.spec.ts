import { PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  prepareScheduledPolicy,
  confirmScheduledPolicy,
  prepareScheduledTaskReview,
  assertScheduledRoundAdmission,
} from './xhs-scheduled-review-scope';
import {
  FULL_HISTORY_KIND,
  fullHistoryContext,
} from './xhs-full-history-scope';
import { scheduledTaskId } from './xhs-scheduled-admission';

// All rows, approvals and protected-snapshot witnesses below are synthetic.
// Exercise real SQLite and production review/dispatch validation, never source I/O.
describe('scheduled retention of formally narrowed unknown exclusions', () => {
  let db: PrismaClient, dir: string;
  const ids = ['creator-a', 'creator-b', 'creator-c'];
  const bindings = ids.map((creatorId) => ({
    creatorId,
    jobId: 'job-' + creatorId,
  }));
  const authors = Object.fromEntries(ids.map((id) => [id, 'author-' + id]));
  const rootId = 'unbound-' + 'a'.repeat(64),
    narrowId = 'unbound-' + 'b'.repeat(64);
  const hashedNote = createHash('sha256').update('old-third').digest('hex');
  const exclusions = [
    { phase: 'detail', target: 'old-first' },
    { phase: 'detail', target: 'old-second' },
    { phase: 'detail', target: 'sha256:' + hashedNote },
  ];
  const input = {
    creatorIds: ids,
    maxRequests: 30,
    phaseLimits: { profile: 3, list: 3, detail: 23, media: 23 },
  };
  async function insertReview(id: string, scope: any, approval: number) {
    await db.$executeRawUnsafe(
      'INSERT INTO xhs_unbound_owner_reviews VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      id,
      'c'.repeat(64),
      '{}',
      'unknown',
      '[]',
      '[]',
      JSON.stringify(authors),
      '[]',
      JSON.stringify(scope),
      'd'.repeat(64),
      approval,
    );
  }
  const saved = () =>
    Promise.all([
      db.$queryRawUnsafe('SELECT * FROM xhs_unbound_owner_reviews ORDER BY id'),
      db.$queryRawUnsafe('SELECT * FROM xhs_request_budgets ORDER BY id'),
      db.$queryRawUnsafe(
        'SELECT * FROM xhs_unbound_owner_requests ORDER BY operation_id',
      ),
      db.$queryRawUnsafe(
        'SELECT document FROM xhs_whole_creator_jobs ORDER BY id',
      ),
    ]);
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'scheduled-exclusion-'));
    db = new PrismaClient({
      datasources: {
        db: { url: 'file:' + path.join(dir, 's.sqlite').replace(/\\/g, '/') },
      },
    });
    for (const sql of [
      'CREATE TABLE xhs_unbound_owner_reviews(id TEXT PRIMARY KEY,plan_digest TEXT,original_risk_json TEXT,original_outcome TEXT,old_task_ids_json TEXT,old_job_ids_json TEXT,creator_bindings_json TEXT,budget_snapshot_json TEXT,scope_json TEXT,backup_sha256 TEXT,approved_at INTEGER)',
      'CREATE TABLE xhs_unbound_owner_requests(operation_id TEXT PRIMARY KEY,review_id TEXT,task_id TEXT,creator_id TEXT,phase TEXT,logical_target TEXT,outcome TEXT,listed_note_ids_json TEXT)',
      'CREATE TABLE xhs_creators(id TEXT PRIMARY KEY,external_author_id TEXT,enabled INTEGER)',
      'CREATE TABLE xhs_whole_creator_jobs(id TEXT PRIMARY KEY,creator_id TEXT,state TEXT,document TEXT)',
      'CREATE TABLE xhs_subscription_tasks(id TEXT PRIMARY KEY,creator_id TEXT,state TEXT,document TEXT)',
      'CREATE TABLE xhs_request_budgets(id TEXT PRIMARY KEY,used INTEGER,request_limit INTEGER,next_at INTEGER,interval_ms INTEGER)',
      'CREATE TABLE xhs_source_risk(id TEXT PRIMARY KEY,state TEXT,code TEXT,owner TEXT,http_status INTEGER,endpoint TEXT)',
    ])
      await db.$executeRawUnsafe(sql);
  });
  beforeEach(async () => {
    for (const table of [
      'xhs_unbound_owner_reviews',
      'xhs_unbound_owner_requests',
      'xhs_creators',
      'xhs_whole_creator_jobs',
      'xhs_subscription_tasks',
      'xhs_request_budgets',
      'xhs_source_risk',
    ])
      await db.$executeRawUnsafe('DELETE FROM ' + table);
    for (const id of ids)
      await db.$executeRawUnsafe(
        'INSERT INTO xhs_creators VALUES(?,?,1)',
        id,
        authors[id],
      );
    await db.$executeRawUnsafe(
      "INSERT INTO xhs_source_risk VALUES('source','clear',NULL,NULL,NULL,NULL)",
    );
    await db.$executeRawUnsafe(
      "INSERT INTO xhs_request_budgets VALUES('xhs:source-total',17,300,0,1000)",
    );
    const scope = {
      reviewKind: FULL_HISTORY_KIND,
      bindings,
      maxRequests: 1,
      phaseLimits: { profile: 1, list: 1, detail: 1, media: 1 },
      exclusions: { [ids[1]]: [{ phase: 'detail', target: '*' }] },
    };
    await insertReview(rootId, scope, 1);
    await insertReview(
      narrowId,
      {
        ...scope,
        authorizationRootReviewId: rootId,
        lineageReviewIds: [rootId],
        narrowedCreatorId: ids[1],
        narrowing: 'parent-receipt-marker-phase-identity',
        exclusions: { [ids[1]]: exclusions },
      },
      2,
    );
    // Historical authorization is exhausted; its exclusions still remain evidence.
    await db.$executeRawUnsafe(
      'INSERT INTO xhs_unbound_owner_requests VALUES(?,?,?,?,?,?,?,?)',
      randomUUID(),
      rootId,
      bindings[1].jobId,
      ids[1],
      'detail',
      'old-first',
      'response-received',
      null,
    );
    await db.$executeRawUnsafe(
      'INSERT INTO xhs_whole_creator_jobs VALUES(?,?,?,?)',
      bindings[1].jobId,
      ids[1],
      'paused',
      JSON.stringify({
        sourceFence: {
          phase: 'detail',
          state: 'started',
          noteId: 'old-first',
          marker: 'synthetic-old-marker',
        },
        sourceUnknowns: [
          { phase: 'detail', outcome: 'unknown', targetHash: hashedNote },
        ],
      }),
    );
  });
  afterAll(async () => {
    await db.$disconnect();
    await rm(dir, { recursive: true, force: true });
  });
  async function approvedTask() {
    const plan = await prepareScheduledPolicy(db, input);
    await confirmScheduledPolicy(
      db,
      input,
      plan.digest,
      {
        assertQuiescent: async () => {},
        verifyBackup: async () => 'e'.repeat(64),
      },
      10n,
    );
    const round = '2026-11-01/09:15';
    const taskId = scheduledTaskId(round, ids[1], 'basic');
    const context = await prepareScheduledTaskReview(
      db,
      {
        round,
        creatorId: ids[1],
        authorId: authors[ids[1]],
        taskId,
        phase: 'basic',
        sessionBinding: 'f'.repeat(64),
      },
      11n,
    );
    expect(context).toBeDefined();
    await db.$executeRawUnsafe(
      'INSERT INTO xhs_subscription_tasks VALUES(?,?,?,?)',
      taskId,
      ids[1],
      'running',
      JSON.stringify({
        taskId,
        creatorId: ids[1],
        schedule: { round, phase: 'basic' },
      }),
    );
    await db.$executeRawUnsafe(
      'INSERT INTO xhs_unbound_owner_requests VALUES(?,?,?,?,?,?,?,?)',
      randomUUID(),
      context!.reviewId,
      taskId,
      ids[1],
      'list',
      'cursor:' + '0'.repeat(64),
      'response-received',
      JSON.stringify(['old-first', 'old-second', 'old-third', 'new-note']),
    );
    const [review] = await db.$queryRawUnsafe<any[]>(
      'SELECT * FROM xhs_unbound_owner_reviews WHERE id=?',
      context!.reviewId,
    );
    const admit = (target: string) =>
      fullHistoryContext.run(context!, () =>
        assertScheduledRoundAdmission(db, context!.reviewId, review, {
          operationId: randomUUID(),
          taskId,
          creatorId: ids[1],
          phase: 'detail',
          target,
        }),
      );
    return { admit, context: context!, review };
  }
  it('retains all three proved exclusions without wildcard or old-budget renewal and changes no original evidence', async () => {
    const before = await saved();
    const plan = await prepareScheduledPolicy(db, input);
    expect(plan.scope.exclusions[ids[1]]).toHaveLength(3);
    expect(plan.scope.exclusions[ids[1]]).toEqual(
      expect.arrayContaining(exclusions),
    );
    expect(plan.scope.retainedHistoryEvidence).toHaveLength(2);
    expect(await saved()).toEqual(before);
    const { admit } = await approvedTask();
    for (const target of ['old-first', 'old-second', 'old-third'])
      await expect(admit(target)).rejects.toThrow(
        'HISTORICAL_UNKNOWN_TARGET_EXCLUDED',
      );
    await expect(admit('new-note')).resolves.toBeUndefined();
  });
  it('retains formally approved exclusions even after the raw source fields disappear', async () => {
    await db.$executeRawUnsafe(
      "UPDATE xhs_whole_creator_jobs SET document='{}'",
    );
    expect(
      (await prepareScheduledPolicy(db, input)).scope.exclusions[ids[1]],
    ).toEqual(exclusions);
  });
  it('rejects a mismatched creator identity rather than trusting the historical scope', async () => {
    await db.$executeRawUnsafe(
      'UPDATE xhs_creators SET external_author_id=? WHERE id=?',
      'different-author',
      ids[1],
    );
    await expect(prepareScheduledPolicy(db, input)).rejects.toThrow(
      'SCHEDULED_CREATOR_BINDING_CHANGED',
    );
  });
  it('rejects a missing lineage parent without changing reviews or budgets', async () => {
    await db.$executeRawUnsafe(
      'DELETE FROM xhs_unbound_owner_reviews WHERE id=?',
      rootId,
    );
    const before = await saved();
    await expect(prepareScheduledPolicy(db, input)).rejects.toThrow(
      'FULL_REVIEW_LINEAGE_INVALID',
    );
    expect(await saved()).toEqual(before);
  });
  it('keeps new raw unknowns fenced even when the attempted target is otherwise allowed', async () => {
    const { admit } = await approvedTask();
    await db.$executeRawUnsafe(
      'INSERT INTO xhs_unbound_owner_requests VALUES(?,?,?,?,?,?,?,?)',
      randomUUID(),
      'unrelated-review',
      'unrelated-task',
      ids[1],
      'detail',
      'new-unknown',
      'unknown',
      null,
    );
    const before = await saved();
    await expect(admit('new-note')).rejects.toThrow(
      'SCHEDULED_NEW_UNKNOWN_REVIEW_REQUIRED',
    );
    expect(await saved()).toEqual(before);
  });
  it('does not obtain extra scheduled request capacity from a later full-history review', async () => {
    const { admit, context, review } = await approvedTask();
    const approved = JSON.parse(review.scope_json);
    const [narrow] = await db.$queryRawUnsafe<any[]>(
      'SELECT scope_json FROM xhs_unbound_owner_reviews WHERE id=?',
      narrowId,
    );
    await insertReview(
      'unbound-' + 'c'.repeat(64),
      {
        ...JSON.parse(narrow.scope_json),
        lineageReviewIds: [rootId, narrowId],
        maxRequests: 100000,
      },
      20,
    );
    // The current task already has one list receipt; exhaust its own 30 cap.
    for (let i = 0; i < 29; i++)
      await db.$executeRawUnsafe(
        'INSERT INTO xhs_unbound_owner_requests VALUES(?,?,?,?,?,?,?,?)',
        randomUUID(),
        context.reviewId,
        context.jobId,
        ids[1],
        'profile',
        'profile:' + (i + 1),
        'response-received',
        null,
      );
    await expect(admit('new-note')).rejects.toThrow(
      'SCHEDULED_ROUND_LIMIT_REACHED',
    );
    const [budget] = await db.$queryRawUnsafe<any[]>(
      'SELECT used,request_limit FROM xhs_request_budgets WHERE id=?',
      context.budgetId,
    );
    expect(budget).toEqual({ used: 0, request_limit: approved.maxRequests });
    expect(approved.maxRequests).toBe(30);
  });
});
