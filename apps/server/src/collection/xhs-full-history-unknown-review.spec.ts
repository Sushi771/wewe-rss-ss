import { withFixtureMigrationConnection } from '../../test/fixture-migration-connection';
import { PrismaClient } from '@prisma/client';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { splitSqliteStatements } from '../../../../scripts/sqlite-statements.cjs';
import {
  prepareFullHistoryScope,
  confirmFullHistoryScope,
  fullHistoryBudgetId,
  fullHistoryContext,
  fullHistoryNoteExcluded,
} from './xhs-full-history-scope';
import {
  prepareFullHistoryUnknownReview,
  confirmFullHistoryUnknownReview,
  assertFullHistoryReviewLineage,
} from './xhs-full-history-unknown-review';
import { admitUnboundRequest } from './xhs-unbound-round';

it('reviews unbound owner explicitly, excludes incomplete note, preserves unknown/old budgets, and blocks stale capacity or restrictions', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'xhs-full-unknown-'));
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
      await db.$executeRawUnsafe(
        "INSERT INTO xhs_whole_creator_jobs VALUES(?,?,'paused',?,1)",
        b.jobId,
        b.creatorId,
        JSON.stringify({
          id: b.jobId,
          creatorId: b.creatorId,
          state: 'paused',
          items: {},
        }),
      );
      await db.$executeRawUnsafe(
        'INSERT INTO xhs_request_budgets(id,used,request_limit,next_at,interval_ms) VALUES(?,7,30,0,1000)',
        b.jobId,
      );
    }
    await db.$executeRawUnsafe(
      "INSERT INTO xhs_request_budgets(id,used,request_limit,next_at,interval_ms) VALUES('xhs:source-total',23,100,0,1000)",
    );
    const originalInput = {
      bindings,
      sessionBinding: 'a'.repeat(64),
      maxRequests: 20,
      phaseLimits: { profile: 5, list: 5, detail: 10, media: 20 },
    };
    const originalPlan = await db.$transaction((tx) =>
      prepareFullHistoryScope(tx, originalInput),
    );
    const old = await db.$transaction((tx) =>
      confirmFullHistoryScope(
        tx,
        originalInput,
        originalPlan.digest,
        {
          assertQuiescent: async () => {},
          assertSession: () => {},
          verifyBackup: async () => 'b'.repeat(64),
        },
        1n,
      ),
    );
    const operationId = randomUUID(),
      owner = randomUUID(),
      target = 'incomplete-note:' + 'c'.repeat(64);
    for (const [phase, logical, outcome] of [
      ['profile', 'profile:1', 'response-received'],
      ['list', 'cursor:' + '0'.repeat(64), 'response-received'],
      ['detail', 'incomplete-note', 'response-received'],
      ['media', target, 'unknown'],
    ]) {
      await db.$executeRawUnsafe(
        'INSERT INTO xhs_unbound_owner_requests VALUES(?,?,?,?,?,?,?,NULL)',
        phase === 'media' ? operationId : randomUUID(),
        old.reviewId,
        bindings[0].jobId,
        'a',
        phase,
        logical,
        outcome,
      );
    }
    await db.$executeRawUnsafe(
      "UPDATE xhs_source_risk SET state='pending',owner=?,updated_at=100 WHERE id='source'",
      owner,
    );
    await db.$executeRawUnsafe(
      'UPDATE xhs_request_budgets SET used=4,next_at=999 WHERE id=?',
      fullHistoryBudgetId(old.reviewId, bindings[0].jobId),
    );
    const before = await db.$queryRawUnsafe<any[]>(
      'SELECT * FROM xhs_request_budgets ORDER BY id',
    );
    const input = {
      reviewId: old.reviewId,
      operationId,
      creatorId: 'a',
      jobId: bindings[0].jobId,
      expectedTarget: target,
      sessionBinding: 'd'.repeat(64),
    };
    const plan = await db.$transaction((tx) =>
      prepareFullHistoryUnknownReview(tx, input),
    );
    await db.$executeRawUnsafe(
      "UPDATE xhs_source_risk SET state='blocked',owner=NULL,code='XHS_SOURCE_RATE_LIMIT_BLOCKED',http_status=429 WHERE id='source'",
    );
    await expect(prepareFullHistoryUnknownReview(db, input)).rejects.toThrow(
      'UNBOUND_PENDING_REQUIRED',
    );
    await db.$executeRawUnsafe(
      "UPDATE xhs_source_risk SET state='pending',owner=?,code=NULL,http_status=NULL,updated_at=100 WHERE id='source'",
      owner,
    );
    expect(plan.ownerOperationBinding).toBe('unproved');
    expect(plan.scope.maxRequests).toBe(16);
    expect(plan.scope.phaseLimits).toEqual({
      profile: 4,
      list: 4,
      detail: 9,
      media: 19,
    });
    expect(plan.scope.exclusions.a).toContainEqual({ phase: 'media', target });
    expect(plan.scope.exclusions.a).toContainEqual({
      phase: 'detail',
      target: 'incomplete-note',
    });
    const host = {
      assertQuiescent: async () => {},
      assertSession: (binding: string) => {
        expect(binding).toBe(input.sessionBinding);
      },
      authorizePlan: async () => {},
      verifyProtectedSnapshot: async () => 'f'.repeat(64),
    };
    const confirmation = {
      ...input,
      digest: plan.digest,
      acknowledgedUnknownOwner: true as const,
      acknowledgedIncompleteNoteExclusion: true as const,
      acknowledgedDuplicateDirectoryRead: true as const,
    };
    await expect(
      db.$transaction((tx) =>
        confirmFullHistoryUnknownReview(
          tx,
          { ...confirmation, digest: '0'.repeat(64) },
          host,
          101n,
        ),
      ),
    ).rejects.toThrow('REVIEW_STATE_CHANGED');
    expect(
      (await db.$queryRawUnsafe<any[]>('SELECT state FROM xhs_source_risk'))[0]
        .state,
    ).toBe('pending');
    const next = await db.$transaction((tx) =>
      confirmFullHistoryUnknownReview(tx, confirmation, host, 101n),
    );
    const after = await db.$queryRawUnsafe<any[]>(
      'SELECT * FROM xhs_request_budgets ORDER BY id',
    );
    expect(after.filter((r) => before.some((b) => b.id === r.id))).toEqual(
      before,
    );
    expect(
      (
        await db.$queryRawUnsafe<any[]>(
          'SELECT outcome FROM xhs_unbound_owner_requests WHERE operation_id=?',
          operationId,
        )
      )[0].outcome,
    ).toBe('unknown');
    expect(
      (await db.$queryRawUnsafe<any[]>('SELECT state FROM xhs_source_risk'))[0]
        .state,
    ).toBe('clear');
    await expect(
      assertFullHistoryReviewLineage(db, old.reviewId),
    ).rejects.toThrow('FULL_REVIEW_SUPERSEDED');
    await assertFullHistoryReviewLineage(db, next.reviewId);
    await fullHistoryContext.run(
      {
        reviewId: next.reviewId,
        creatorId: 'a',
        jobId: bindings[0].jobId,
        sessionBinding: input.sessionBinding,
        authorId: 'author-a',
      },
      async () => {
        expect(
          await fullHistoryNoteExcluded(
            db,
            'a',
            JSON.stringify(['xiaohongshu', 'note', 'incomplete-note']),
          ),
        ).toBe(true);
        expect(
          await fullHistoryNoteExcluded(
            db,
            'a',
            JSON.stringify(['xiaohongshu', 'note', 'other-note']),
          ),
        ).toBe(false);
        await expect(
          db.$transaction((tx) =>
            admitUnboundRequest(tx, next.reviewId, {
              operationId: randomUUID(),
              taskId: bindings[0].jobId,
              creatorId: 'a',
              phase: 'media',
              target,
            }),
          ),
        ).rejects.toThrow('HISTORICAL_UNKNOWN_TARGET_EXCLUDED');
      },
    );
    for (let i = 0; i < 16; i++)
      await db.$executeRawUnsafe(
        "INSERT INTO xhs_unbound_owner_requests VALUES(?,?,?,?,? ,?,'not-sent',NULL)",
        randomUUID(),
        next.reviewId,
        bindings[0].jobId,
        'a',
        'detail',
        'spent-' + i,
      );
    await expect(
      assertFullHistoryReviewLineage(db, next.reviewId),
    ).rejects.toThrow('FULL_SCOPE_LIMIT_REACHED');
    await db.$executeRawUnsafe(
      "UPDATE xhs_source_risk SET state='blocked',owner=NULL,code='XHS_SOURCE_RATE_LIMIT_BLOCKED',http_status=429,updated_at=102",
    );
    await expect(
      prepareFullHistoryUnknownReview(db, {
        ...input,
        reviewId: next.reviewId,
      }),
    ).rejects.toThrow();
  } finally {
    await db.$disconnect();
    await fs.rm(folder, { recursive: true, force: true });
  }
}, 30000);
