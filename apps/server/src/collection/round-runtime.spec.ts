import { withFixtureMigrationConnection } from '../../test/fixture-migration-connection';
beforeAll(
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- Existing native identity fixture.
  require('../../../../scripts/local-release/writer-self.fixture.test.cjs')
    .prepareWriterSelf,
);
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { splitSqliteStatements } from '../../../../scripts/sqlite-statements.cjs';
import {
  prepareUnboundRound,
  confirmUnboundRound,
  assertUnboundDispatch,
  admitUnboundRequest,
} from './xhs-unbound-round';
import { runApprovedThreePages } from './round-runner';
import { XhsSubscriptionRuntime } from './xhs-subscription-runtime';
import { XhsWholeCreatorService } from './xhs-whole-creator.service';
import { assertLegacyXhsSourceReady } from './xhs-legacy-source-fence';
it.each(['transport', 'parse', 'storage', 'success'] as const)(
  'persists %s evidence and fences other creators without replay',
  async (failure) => {
    const previousDatabase = process.env.DATABASE_URL;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'round-runtime-'));
    let db: PrismaClient = new PrismaClient({
      datasources: {
        db: {
          url: 'file:' + path.join(root, 'fixture.db').replace(/\\/g, '/'),
        },
      },
    });
    const trace: string[] = [];
    const targets: string[] = [];
    let continueSuccessfully = false;
    try {
      await withFixtureMigrationConnection(
        'file:' + path.join(root, 'fixture.db').replace(/\\/g, '/'),
        async (migrationClient) => {
          for (const n of (
            await fs.readdir(path.resolve(__dirname, '../../prisma/migrations'))
          ).sort()) {
            if (
              !(
                await fs.stat(
                  path.resolve(__dirname, '../../prisma/migrations', n),
                )
              ).isDirectory()
            )
              continue;
            const f = path.resolve(
              __dirname,
              '../../prisma/migrations',
              n,
              'migration.sql',
            );
            try {
              for (const sql of splitSqliteStatements(
                await fs.readFile(f, 'utf8'),
              ))
                await migrationClient.$executeRawUnsafe(sql);
            } catch (e) {
              if ((e as any).code !== 'ENOENT') throw e;
            }
          }
        },
      );
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
        "UPDATE xhs_source_risk SET state='pending',owner='11111111-1111-4111-8111-111111111111',updated_at=1 WHERE id='source'",
      );
      await db.$executeRawUnsafe(
        "INSERT INTO xhs_request_budgets(id,used,request_limit,next_at,interval_ms) VALUES('xhs:source-total',2,100,0,1000)",
      );
      const plan = await db.$transaction((tx) =>
        prepareUnboundRound(tx, ['a', 'b', 'c']),
      );
      const review = await db.$transaction((tx) =>
        confirmUnboundRound(
          tx,
          ['a', 'b', 'c'],
          plan.digest,
          {
            assertQuiescent: async () => {},
            authorizePlan: async () => {},
            assertPolicyInstalled: async () => {},
            verifyBackup: async () => 'b'.repeat(64),
          },
          BigInt(Date.now()),
        ),
      );
      await db.$disconnect();
      process.env.DATABASE_URL =
        'file:' + path.join(root, 'fixture.db').replace(/\\/g, '/');
      db = new PrismaService();
      const runtime = new XhsSubscriptionRuntime({
        enabled: () => true,
        profileParser: (_raw, id) => ({
          id,
          name: id,
          profileUrl: `https://www.xiaohongshu.com/user/profile/${id}`,
        }),
        api: async (request) => {
          trace.push('transport');
          const url = new URL(request.url);
          targets.push(
            url.searchParams.get('user_id') ??
              url.searchParams.get('target_user_id') ??
              '',
          );
          const count = await db.$queryRawUnsafe<any[]>(
            "SELECT count(*) AS n FROM xhs_unbound_owner_requests WHERE outcome='started'",
          );
          expect(Number(count[0].n)).toBe(1);
          if (failure === 'transport') throw Error('SYNTHETIC_SENTINEL');
          // Synthetic transport observations only; no sockets or source requests.
          runtime.observeSourceStage('sent');
          runtime.observeSourceStage('response', 200);
          runtime.observeSourceStage('parse');
          const isList = new URL(request.url).pathname.endsWith('/user_posted');
          const authorId = new URL(request.url).searchParams.get('user_id');
          const data =
            isList && (failure === 'storage' || failure === 'success')
              ? {
                  notes: Array.from(
                    {
                      length:
                        failure === 'storage' && !continueSuccessfully ? 32 : 1,
                    },
                    (_, i) => ({
                      note_id: 'synthetic-' + authorId + '-' + i,
                      xsec_token: 'synthetic',
                      user: { user_id: authorId },
                      title: 'synthetic',
                    }),
                  ),
                  has_more: false,
                  cursor: '',
                }
              : {};
          return {
            status: 200,
            url: request.url,
            body: { success: true, data },
          };
        },
      });
      runtime.bindRiskStore({
        read: async () => undefined,
        assertUnboundRoundAdmission: async () => assertUnboundDispatch(db),
      } as any);
      await runtime.connectSession({
        a1: 'synthetic-a1',
        webSession: 'synthetic-session',
      });
      const service = new XhsWholeCreatorService(
        db as any,
        undefined as any,
        runtime,
        undefined as any,
      );
      const writer = <T>(fn: any): Promise<T> => (service as any).write(fn);
      const execution = runApprovedThreePages(
        writer,
        runtime,
        review.reviewId,
        (tx) => assertLegacyXhsSourceReady(tx as any),
      );
      if (failure === 'success') {
        await expect(execution).resolves.toMatchObject({
          pages: 3,
          sourceRequests: 6,
        });
      } else await expect(execution).rejects.toThrow();
      const expectedAttempts =
        failure === 'transport' ? 1 : failure === 'success' ? 6 : 2;
      expect(trace).toEqual(Array(expectedAttempts).fill('transport'));
      const requests = await db.$queryRawUnsafe<any[]>(
        'SELECT outcome FROM xhs_unbound_owner_requests',
      );
      expect(requests.map((r) => r.outcome)).toEqual(
        failure === 'transport'
          ? ['unknown']
          : failure === 'success'
            ? Array(6).fill('response-received')
            : ['response-received', 'unknown'],
      );
      const receipts = await db.$queryRawUnsafe<any[]>(
        'SELECT document FROM xhs_unbound_source_receipts ORDER BY rowid',
      );
      expect(JSON.parse(receipts.at(-1).document)).toMatchObject({
        stage: failure === 'success' ? 'checkpoint' : failure,
        outcome:
          failure === 'transport'
            ? 'unknown'
            : failure === 'parse'
              ? 'response-received'
              : failure === 'storage'
                ? 'local-failure'
                : 'checkpointed',
        terminal: true,
        ...(failure === 'storage' ? { localReason: 'XHS_LIST_INVALID' } : {}),
        ...(failure === 'transport'
          ? { code: 'XHS_SOURCE_TRANSPORT_BLOCKED' }
          : { status: 200 }),
      });
      if (failure !== 'transport')
        expect(JSON.parse(receipts[0].document).outcome).toBe('checkpointed');
      expect(await db.xhsNote.count()).toBe(failure === 'success' ? 3 : 0);
      const budgetsBefore = await db.$queryRawUnsafe<any[]>(
        'SELECT * FROM xhs_request_budgets ORDER BY id',
      );
      if (failure !== 'success') {
        await expect(
          db.$transaction((tx) =>
            admitUnboundRequest(tx, review.reviewId, {
              operationId: '22222222-2222-4222-8222-222222222222',
              taskId: 'new-round:' + review.reviewId,
              creatorId: 'b',
              phase: 'profile',
              target: 'profile',
            }),
          ),
        ).rejects.toThrow('ROUND_HAS_UNRESOLVED_REQUEST');
      }
      expect(
        await db.$queryRawUnsafe<any[]>(
          'SELECT * FROM xhs_request_budgets ORDER BY id',
        ),
      ).toEqual(budgetsBefore);

      await expect(
        runApprovedThreePages(writer, runtime, review.reviewId, (tx) =>
          assertLegacyXhsSourceReady(tx as any),
        ),
      ).rejects.toThrow();
      expect(trace).toEqual(Array(expectedAttempts).fill('transport'));
      if (failure === 'storage') {
        const originalRequests = await db.$queryRawUnsafe<any[]>(
          'SELECT * FROM xhs_unbound_owner_requests ORDER BY operation_id',
        );
        const continuation = {
          rootReviewId: review.reviewId,
          sessionBinding: runtime.replacementSessionForReview().binding,
        };
        const remaining = await prepareUnboundRound(
          db,
          ['a', 'b', 'c'],
          continuation,
        );
        const next = await db.$transaction((tx) =>
          confirmUnboundRound(
            tx,
            ['a', 'b', 'c'],
            remaining.digest,
            {
              assertQuiescent: async () => {},
              authorizePlan: async () => {},
              assertPolicyInstalled: async () => {},
              verifyBackup: async () => 'b'.repeat(64),
            },
            BigInt(Date.now()),
            continuation,
          ),
        );
        continueSuccessfully = true;
        await runtime.refreshAfterHistoryHandoff();
        await expect(
          runApprovedThreePages(writer, runtime, next.reviewId, (tx) =>
            assertLegacyXhsSourceReady(tx as any),
          ),
        ).resolves.toMatchObject({ pages: 2, sourceRequests: 4 });
        expect(targets).toEqual([
          'author-a',
          'author-a',
          'author-b',
          'author-b',
          'author-c',
          'author-c',
        ]);
        expect(await db.xhsNote.count()).toBe(2);
        expect(
          await db.$queryRawUnsafe(
            'SELECT * FROM xhs_unbound_owner_requests WHERE review_id=? ORDER BY operation_id',
            review.reviewId,
          ),
        ).toEqual(originalRequests);
      }
    } finally {
      await db.$disconnect();
      if (previousDatabase === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabase;
      if (!root.startsWith(path.join(os.tmpdir(), 'round-runtime-')))
        throw Error('FIXTURE_PATH_CHANGED');
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
