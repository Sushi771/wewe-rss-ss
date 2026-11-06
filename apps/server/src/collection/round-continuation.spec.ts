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
import { reserveRoundBudgetRisk, finishRoundRisk } from './round-budget-risk';
const host = {
  assertQuiescent: async () => {},
  authorizePlan: async () => {},
  assertPolicyInstalled: async () => {},
  verifyBackup: async () => 'b'.repeat(64),
};
it('derives only unattempted creators, preserves old unknown/budgets, rejects replay and a second continuation, and stops a new unknown', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'remaining-round-'));
  const db = new PrismaClient({
    datasources: {
      db: {
        url: 'file:' + path.join(folder, 'fixture.db').replace(/\\/g, '/'),
      },
    },
  });
  try {
    const migrations = path.resolve(__dirname, '../../prisma/migrations');
    for (const name of (await fs.readdir(migrations)).sort()) {
      try {
        for (const sql of splitSqliteStatements(
          await fs.readFile(
            path.join(migrations, name, 'migration.sql'),
            'utf8',
          ),
        ))
          await db.$executeRawUnsafe(sql);
      } catch (e) {
        if ((e as any).code !== 'ENOENT') throw e;
      }
    }
    for (const id of ['a', 'b', 'c'])
      await db.xhsCreator.create({
        data: {
          id,
          displayName: id,
          externalAuthorId: 'author-' + id,
          profileUrl: 'https://www.xiaohongshu.com/user/profile/author-' + id,
        },
      });
    await db.$executeRawUnsafe(
      "UPDATE xhs_source_risk SET state='pending',owner=?,updated_at=1 WHERE id='source'",
      randomUUID(),
    );
    await db.$executeRawUnsafe(
      "INSERT INTO xhs_request_budgets(id,used,request_limit,next_at,interval_ms) VALUES('xhs:source-total',19,100,0,1000)",
    );
    const p = await prepareUnboundRound(db, ['a', 'b', 'c']);
    const root = await db.$transaction((tx) =>
      confirmUnboundRound(
        tx,
        ['a', 'b', 'c'],
        p.digest,
        host,
        BigInt(Date.now()),
      ),
    );
    const request = (creatorId: string, phase: 'profile' | 'list') => ({
      operationId: randomUUID(),
      taskId: 'new-round:' + root.reviewId,
      creatorId,
      phase,
      target: phase === 'profile' ? 'profile' : 'page:1',
    });
    for (const phase of ['profile', 'list'] as const) {
      const r = request('a', phase);
      const owner = await db.$transaction(async (tx) => {
        await admitUnboundRequest(tx, root.reviewId, r);
        return reserveRoundBudgetRisk(
          tx,
          root.reviewId,
          r,
          Date.now() + (phase === 'list' ? 2000 : 0),
        );
      });
      await db.$transaction(async (tx) => {
        await settleUnboundRequest(
          tx,
          root.reviewId,
          r.operationId,
          phase === 'profile' ? 'response-received' : 'unknown',
        );
        await finishRoundRisk(
          tx,
          owner,
          phase === 'profile' ? 'response-received' : 'unknown',
        );
      });
    }
    const original = await db.$queryRawUnsafe<any[]>(
      'SELECT * FROM xhs_unbound_owner_requests ORDER BY operation_id',
    );
    const budgets = await db.$queryRawUnsafe<any[]>(
      'SELECT * FROM xhs_request_budgets ORDER BY id',
    );
    const continuation = {
      rootReviewId: root.reviewId,
      sessionBinding: 'a'.repeat(64),
    };
    const plan = await prepareUnboundRound(db, ['a', 'b', 'c'], continuation);
    expect(plan.scope.creatorIds).toEqual(['b', 'c']);
    await expect(
      db.$transaction((tx) =>
        confirmUnboundRound(
          tx,
          ['a', 'b', 'c'],
          '0'.repeat(64),
          host,
          BigInt(Date.now()),
          continuation,
        ),
      ),
    ).rejects.toThrow('REVIEW_STATE_CHANGED');
    for (const code of [
      'AUTHENTICATION',
      'VERIFICATION',
      'RATE_LIMIT',
      'PERMISSION',
      'SIGNATURE',
    ]) {
      await db.$executeRawUnsafe(
        "UPDATE xhs_source_risk SET state='blocked',code=? WHERE id='source'",
        'XHS_SOURCE_' + code + '_BLOCKED',
      );
      await expect(
        prepareUnboundRound(db, ['a', 'b', 'c'], continuation),
      ).rejects.toThrow('UNBOUND_PENDING_REQUIRED');
      await db.$executeRawUnsafe(
        "UPDATE xhs_source_risk SET state='pending',code=NULL WHERE id='source'",
      );
    }
    const confirmed = await db.$transaction((tx) =>
      confirmUnboundRound(
        tx,
        ['a', 'b', 'c'],
        plan.digest,
        host,
        BigInt(Date.now() + 3000),
        continuation,
      ),
    );
    expect(
      await db.$queryRawUnsafe('SELECT * FROM xhs_request_budgets ORDER BY id'),
    ).toEqual(budgets);
    expect(
      await db.$queryRawUnsafe(
        'SELECT * FROM xhs_unbound_owner_requests ORDER BY operation_id',
      ),
    ).toEqual(original);
    await expect(
      prepareUnboundRound(db, ['a', 'b', 'c'], continuation),
    ).rejects.toThrow('CONTINUATION_ALREADY_REVIEWED');
    await expect(
      db.$transaction((tx) =>
        admitUnboundRequest(tx, confirmed.reviewId, request('a', 'profile')),
      ),
    ).rejects.toThrow('REMAINING_SCOPE_EXCEEDED');
    const next = request('b', 'profile');
    await db.$transaction(async (tx) => {
      await admitUnboundRequest(tx, confirmed.reviewId, next);
      await reserveRoundBudgetRisk(
        tx,
        confirmed.reviewId,
        next,
        Date.now() + 4000,
      );
    });
    await db.$transaction((tx) =>
      settleUnboundRequest(tx, confirmed.reviewId, next.operationId, 'unknown'),
    );
    await expect(
      db.$transaction((tx) =>
        admitUnboundRequest(tx, confirmed.reviewId, request('c', 'profile')),
      ),
    ).rejects.toThrow('ROUND_HAS_UNRESOLVED_REQUEST');
    expect(
      await db.$queryRawUnsafe(
        'SELECT * FROM xhs_unbound_owner_requests WHERE review_id=? ORDER BY operation_id',
        root.reviewId,
      ),
    ).toEqual(original);
  } finally {
    await db.$disconnect();
    if (!folder.startsWith(path.join(os.tmpdir(), 'remaining-round-')))
      throw Error('FIXTURE_PATH_CHANGED');
    await fs.rm(folder, { recursive: true, force: true });
  }
}, 30000);
