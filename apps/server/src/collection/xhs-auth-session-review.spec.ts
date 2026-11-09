import { withFixtureMigrationConnection } from '../../test/fixture-migration-connection';
import { PrismaClient } from '@prisma/client';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { splitSqliteStatements } from '../../../../scripts/sqlite-statements.cjs';
import {
  prepareUnboundRound,
  confirmUnboundRound,
  admitUnboundRequest,
  settleUnboundRequest,
} from './xhs-unbound-round';
import {
  prepareAuthSessionReview,
  confirmAuthSessionReview,
} from './xhs-auth-session-review';

it('audits replacement login without inventing authentication success; retains unknowns and budgets and stops another unknown', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'xhs-auth-review-'));
  const db = new PrismaClient({
    datasources: {
      db: {
        url: 'file:' + path.join(folder, 'fixture.sqlite').replace(/\\/g, '/'),
      },
    },
  });
  try {
    const migrations = path.resolve(__dirname, '../../prisma/migrations');
    await withFixtureMigrationConnection(
      'file:' + path.join(folder, 'fixture.sqlite').replace(/\\/g, '/'),
      async (migrationClient) => {
        for (const name of (await fs.readdir(migrations)).sort()) {
          if (!(await fs.stat(path.join(migrations, name))).isDirectory())
            continue;
          try {
            for (const sql of splitSqliteStatements(
              await fs.readFile(
                path.join(migrations, name, 'migration.sql'),
                'utf8',
              ),
            ))
              await migrationClient.$executeRawUnsafe(sql);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
      },
    );
    for (const id of ['a', 'b', 'c'])
      await db.xhsCreator.create({
        data: {
          id,
          displayName: id,
          profileUrl: 'https://www.xiaohongshu.com/user/profile/author-' + id,
          externalAuthorId: 'author-' + id,
        },
      });
    await db.$executeRawUnsafe(
      "UPDATE xhs_source_risk SET state='pending',owner=?,code=NULL,http_status=NULL,endpoint=NULL,updated_at=100000 WHERE id='source'",
      randomUUID(),
    );
    await db.$executeRawUnsafe(
      "INSERT INTO xhs_request_budgets(id,used,request_limit,next_at,interval_ms) VALUES('xhs:source-total',19,100,0,1000)",
    );
    const baseHost = {
      assertQuiescent: async () => {},
      authorizePlan: async () => {},
      assertPolicyInstalled: async () => {},
      verifyBackup: async () => 'b'.repeat(64),
    };
    const oldPlan = await prepareUnboundRound(db, ['a', 'b', 'c']);
    const oldReview = await db.$transaction((tx) =>
      confirmUnboundRound(
        tx,
        ['a', 'b', 'c'],
        oldPlan.digest,
        baseHost,
        100001n,
      ),
    );
    const oldRequest = {
      operationId: randomUUID(),
      taskId: 'old-profile',
      creatorId: 'a',
      phase: 'profile' as const,
      target: 'profile',
    };
    await db.$transaction(async (tx) => {
      await admitUnboundRequest(tx, oldReview.reviewId, oldRequest);
      await settleUnboundRequest(
        tx,
        oldReview.reviewId,
        oldRequest.operationId,
        'unknown',
      );
    });
    await db.$executeRawUnsafe(
      "UPDATE xhs_source_risk SET state='blocked',owner=NULL,code='XHS_SOURCE_AUTHENTICATION_BLOCKED',http_status=NULL,endpoint='profile',updated_at=100002 WHERE id='source'",
    );
    const binding = 'a'.repeat(64),
      host = {
        ...baseHost,
        assertReplacementSession: async (value: string) => {
          if (value !== binding) throw Error('SESSION_CHANGED');
        },
      };
    const budgets = await db.$queryRawUnsafe(
      'SELECT * FROM xhs_request_budgets ORDER BY id',
    );
    const oldRows = await db.$queryRawUnsafe(
      'SELECT * FROM xhs_unbound_owner_requests ORDER BY operation_id',
    );
    const plan = await prepareAuthSessionReview(db, ['a', 'b', 'c'], binding);
    await expect(
      db.$transaction((tx) =>
        confirmAuthSessionReview(
          tx,
          ['a', 'b', 'c'],
          binding,
          '0'.repeat(64),
          host,
          100003n,
        ),
      ),
    ).rejects.toThrow('REVIEW_STATE_CHANGED');
    await expect(
      db.$transaction((tx) =>
        confirmAuthSessionReview(
          tx,
          ['a', 'b', 'c'],
          binding,
          plan.digest,
          {
            ...host,
            assertReplacementSession: async () => {
              throw Error('SESSION_CHANGED');
            },
          },
          100003n,
        ),
      ),
    ).rejects.toThrow('SESSION_CHANGED');
    await db.$executeRawUnsafe(
      "UPDATE xhs_source_risk SET code='XHS_SOURCE_PERMISSION_BLOCKED' WHERE id='source'",
    );
    await expect(
      prepareAuthSessionReview(db, ['a', 'b', 'c'], binding),
    ).rejects.toThrow('AUTHENTICATION_REVIEW_ONLY');
    await db.$executeRawUnsafe(
      "UPDATE xhs_source_risk SET code='XHS_SOURCE_AUTHENTICATION_BLOCKED' WHERE id='source'",
    );
    const beforeReviews = await db.$queryRawUnsafe(
      'SELECT id FROM xhs_unbound_owner_reviews ORDER BY id',
    );
    let sessionChecks = 0;
    await expect(
      db.$transaction((tx) =>
        confirmAuthSessionReview(
          tx,
          ['a', 'b', 'c'],
          binding,
          plan.digest,
          {
            ...host,
            assertReplacementSession: async () => {
              if (++sessionChecks === 4)
                throw Error('SESSION_CHANGED_AFTER_WRITE');
            },
          },
          100003n,
        ),
      ),
    ).rejects.toThrow('SESSION_CHANGED_AFTER_WRITE');
    expect(
      await db.$queryRawUnsafe(
        'SELECT id FROM xhs_unbound_owner_reviews ORDER BY id',
      ),
    ).toEqual(beforeReviews);
    expect(
      await db.$queryRawUnsafe(
        "SELECT state,code FROM xhs_source_risk WHERE id='source'",
      ),
    ).toEqual([
      { state: 'blocked', code: 'XHS_SOURCE_AUTHENTICATION_BLOCKED' },
    ]);
    const result = await db.$transaction((tx) =>
      confirmAuthSessionReview(
        tx,
        ['a', 'b', 'c'],
        binding,
        plan.digest,
        host,
        100003n,
      ),
    );
    expect(result.authenticationVerified).toBe(false);
    expect(
      await db.$queryRawUnsafe('SELECT * FROM xhs_request_budgets ORDER BY id'),
    ).toEqual(budgets);
    expect(
      await db.$queryRawUnsafe(
        'SELECT * FROM xhs_unbound_owner_requests ORDER BY operation_id',
      ),
    ).toEqual(oldRows);
    const next = {
      ...oldRequest,
      operationId: randomUUID(),
      taskId: 'replacement-profile',
    };
    await db.$transaction(async (tx) => {
      await admitUnboundRequest(tx, result.reviewId, next);
      await settleUnboundRequest(
        tx,
        result.reviewId,
        next.operationId,
        'unknown',
      );
    });
    await expect(
      db.$transaction((tx) =>
        admitUnboundRequest(tx, result.reviewId, {
          ...next,
          operationId: randomUUID(),
          creatorId: 'b',
          target: 'profile',
        }),
      ),
    ).rejects.toThrow('ROUND_HAS_UNRESOLVED_REQUEST');
  } finally {
    await db.$disconnect();
    await fs.rm(folder, { recursive: true, force: true });
  }
});
