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
} from './xhs-unbound-round';
import { runApprovedThreePages } from './round-runner';
import { XhsSubscriptionRuntime } from './xhs-subscription-runtime';
import { XhsWholeCreatorService } from './xhs-whole-creator.service';
import { assertLegacyXhsSourceReady } from './xhs-legacy-source-fence';
it('admits a millisecond-dated review before synthetic transport and retains an unknown result', async () => {
  const previousDatabase = process.env.DATABASE_URL;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'round-runtime-'));
  let db: PrismaClient = new PrismaClient({
    datasources: {
      db: { url: 'file:' + path.join(root, 'fixture.db').replace(/\\/g, '/') },
    },
  });
  const trace: string[] = [];
  try {
    for (const n of (
      await fs.readdir(path.resolve(__dirname, '../../prisma/migrations'))
    ).sort()) {
      const f = path.resolve(
        __dirname,
        '../../prisma/migrations',
        n,
        'migration.sql',
      );
      try {
        for (const sql of splitSqliteStatements(await fs.readFile(f, 'utf8')))
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
      api: async () => {
        trace.push('transport');
        const count = await db.$queryRawUnsafe<any[]>(
          "SELECT count(*) AS n FROM xhs_unbound_owner_requests WHERE outcome='started'",
        );
        expect(Number(count[0].n)).toBe(1);
        throw Error('SYNTHETIC_SENTINEL');
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
    await expect(
      runApprovedThreePages(writer, runtime, review.reviewId, (tx) =>
        assertLegacyXhsSourceReady(tx as any),
      ),
    ).rejects.toThrow();
    expect(trace).toEqual(['transport']);
    const requests = await db.$queryRawUnsafe<any[]>(
      'SELECT outcome FROM xhs_unbound_owner_requests',
    );
    expect(requests).toEqual([{ outcome: 'unknown' }]);
    await expect(
      runApprovedThreePages(writer, runtime, review.reviewId, (tx) =>
        assertLegacyXhsSourceReady(tx as any),
      ),
    ).rejects.toThrow();
    expect(trace).toEqual(['transport']);
  } finally {
    await db.$disconnect();
    if (previousDatabase === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabase;
    if (!root.startsWith(path.join(os.tmpdir(), 'round-runtime-')))
      throw Error('FIXTURE_PATH_CHANGED');
    await fs.rm(root, { recursive: true, force: true });
  }
}, 30000);
