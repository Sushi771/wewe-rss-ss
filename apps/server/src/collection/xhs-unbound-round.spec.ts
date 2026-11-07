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
  reviewedUnboundMarkers,
} from './xhs-unbound-round';
import { reserveRoundBudgetRisk, finishRoundRisk } from './round-budget-risk';
import { saveRoundPage } from './save-round-page';

it('retains historical unknown and budgets, saves one page per approved account, and stops globally on a new unknown', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'xhs-unbound-round-'));
  const db = new PrismaClient({
    datasources: {
      db: {
        url: 'file:' + path.join(folder, 'fixture.sqlite').replace(/\\/g, '/'),
      },
    },
  });
  try {
    const migrations = path.resolve(__dirname, '../../prisma/migrations');
    for (const name of (await fs.readdir(migrations)).sort()) {
      if (!(await fs.stat(path.join(migrations, name))).isDirectory()) continue;
      const file = path.join(migrations, name, 'migration.sql');
      try {
        for (const sql of splitSqliteStatements(
          await fs.readFile(file, 'utf8'),
        ))
          await db.$executeRawUnsafe(sql);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    for (const id of ['a', 'b', 'c'])
      await db.xhsCreator.create({
        data: {
          id,
          displayName: id,
          profileUrl: 'https://www.xiaohongshu.com/user/profile/author-' + id,
          externalAuthorId: 'author-' + id,
        },
      });
    const owner = randomUUID();
    await db.$executeRaw`UPDATE xhs_source_risk SET state='pending',owner=${owner},code=NULL,http_status=NULL,endpoint=NULL,updated_at=100000 WHERE id='source'`;
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,used,request_limit,next_at,interval_ms) VALUES('xhs:source-total',19,100,0,1000),('xhs:dispatch-pending:old',1,1,0,0)`;
    const plan = await db.$transaction((tx) =>
      prepareUnboundRound(tx, ['a', 'b', 'c']),
    );
    const host = {
      assertQuiescent: async () => {},
      authorizePlan: async () => {},
      assertPolicyInstalled: async () => {},
      verifyBackup: async () => 'b'.repeat(64),
    };
    await expect(
      db.$transaction((tx) =>
        confirmUnboundRound(tx, ['a', 'b', 'c'], 'a'.repeat(64), host, 100001n),
      ),
    ).rejects.toThrow('REVIEW_STATE_CHANGED');
    const review = await db.$transaction((tx) =>
      confirmUnboundRound(tx, ['a', 'b', 'c'], plan.digest, host, 100001n),
    );
    expect(await reviewedUnboundMarkers(db, review.reviewId)).toEqual([
      'xhs:dispatch-pending:old',
    ]);
    for (const creatorId of ['a', 'b', 'c']) {
      const r = {
        operationId: randomUUID(),
        taskId: 'new-' + creatorId,
        creatorId,
        phase: 'list' as const,
        target: 'page:1',
      };
      const riskOwner = await db.$transaction(async (tx) => {
        await admitUnboundRequest(tx, review.reviewId, r);
        return reserveRoundBudgetRisk(
          tx,
          review.reviewId,
          r,
          1000000 + 1000 * creatorId.charCodeAt(0),
        );
      });
      const page = {
        authorId: 'author-' + creatorId,
        notes: [
          {
            authorId: 'author-' + creatorId,
            noteId: 'note-' + creatorId,
            title: 'Synthetic',
            publishedAt: 1,
            kind: 'image-text',
          },
        ],
      };
      await db.$transaction(async (tx) => {
        expect(
          (await saveRoundPage(tx, creatorId, page.authorId, page)).added,
        ).toBe(1);
        await settleUnboundRequest(
          tx,
          review.reviewId,
          r.operationId,
          'response-received',
          ['note-' + creatorId],
        );
        await finishRoundRisk(tx, riskOwner, 'response-received');
      });
      await expect(
        db.$transaction((tx) =>
          admitUnboundRequest(tx, review.reviewId, {
            ...r,
            operationId: randomUUID(),
            target: 'page:2',
          }),
        ),
      ).rejects.toThrow('LIST_PAGE_LIMIT');
    }
    expect(await db.xhsNote.count()).toBe(3);
    const old = await db.$queryRaw<
      any[]
    >`SELECT used FROM xhs_request_budgets WHERE id='xhs:dispatch-pending:old'`;
    expect(Number(old[0].used)).toBe(1);
    const r = {
      operationId: randomUUID(),
      taskId: 'new-a',
      creatorId: 'a',
      phase: 'detail' as const,
      target: 'note-a',
    };
    const riskOwner = await db.$transaction(async (tx) => {
      await admitUnboundRequest(tx, review.reviewId, r);
      return reserveRoundBudgetRisk(tx, review.reviewId, r, 2000000);
    });
    await db.$transaction(async (tx) => {
      await settleUnboundRequest(tx, review.reviewId, r.operationId, 'unknown');
      await finishRoundRisk(tx, riskOwner, 'unknown');
    });
    await expect(
      db.$transaction((tx) =>
        admitUnboundRequest(tx, review.reviewId, {
          ...r,
          creatorId: 'b',
          operationId: randomUUID(),
        }),
      ),
    ).rejects.toThrow('ROUND_HAS_UNRESOLVED_REQUEST');
    const archived = await db.$queryRaw<
      any[]
    >`SELECT original_risk_json,original_outcome FROM xhs_unbound_owner_reviews`;
    expect(JSON.parse(archived[0].original_risk_json).owner).toBe(owner);
    expect(archived[0].original_outcome).toBe('unknown');
  } finally {
    await db.$disconnect();
    await fs.rm(folder, { recursive: true, force: true });
  }
}, 60000);
