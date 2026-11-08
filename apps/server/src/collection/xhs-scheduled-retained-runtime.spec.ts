import { PrismaClient } from '@prisma/client';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { XhsSubscriptionRuntime } from './xhs-subscription-runtime';
import { XhsSubscriptionService } from './xhs-subscription.service';
import { XhsSourceRiskStore } from './xhs-source-risk-store';
import { assertLegacyXhsSourceReady } from './xhs-legacy-source-fence';
import {
  prepareScheduledPolicy,
  confirmScheduledPolicy,
} from './xhs-scheduled-review-scope';
import { scheduledTaskId } from './xhs-scheduled-admission';
import { applyFixtureMigrations } from '../../test/redbook-isolated/fixture-migrations';

// Production migrations, policy review, enqueue, async lane and runtime dispatch.
// Only the protected-write host and external responses are synthetic. No real I/O.
jest.setTimeout(60000);
it.each([false, true])(
  'retained sourceActive across the complete scheduled lane (new unknown=%s)',
  async (changed) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'xhs-retained-scheduled-'));
    const db = new PrismaClient({
      datasources: {
        db: {
          url: 'file:' + path.join(dir, 'fixture.sqlite').replace(/\\/g, '/'),
        },
      },
    });
    const deny = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(Error('NETWORK_FORBIDDEN'));
    const api = jest.fn(async (request: any) => {
      const u = new URL(request.url);
      return {
        status: 200,
        url: request.url,
        body: {
          success: true,
          code: 0,
          data: u.pathname.includes('otherinfo')
            ? { syntheticProfile: true }
            : { notes: [], cursor: '', has_more: false },
        },
      };
    });
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      profileParser: (_raw, id) => ({
        id,
        name: 'Synthetic',
        profileUrl: 'https://www.xiaohongshu.com/user/profile/' + id,
      }),
      requirePersistentRisk: true,
    });
    let service: any;
    try {
      await applyFixtureMigrations(db);
      const ids = ['a', 'b', 'c'];
      for (const id of ids)
        await db.xhsCreator.create({
          data: {
            id,
            externalAuthorId: 'author-' + id,
            displayName: 'Synthetic',
            profileUrl: 'https://www.xiaohongshu.com/user/profile/author-' + id,
            enabled: true,
          },
        });
      await db.$executeRawUnsafe(
        "INSERT INTO xhs_request_budgets(id,used,request_limit,next_at,interval_ms) VALUES('xhs:source-total',0,100,0,1000),('xhs:dispatch-pending:synthetic-old',1,1,0,1000)",
      );
      const old = {
        taskId: 'old-synthetic-task',
        creatorId: 'b',
        state: 'blocked',
        code: 'XHS_SOURCE_TRANSPORT_BLOCKED',
        sourceActive: {
          phase: 'detail',
          outcome: 'started',
          targetHash: 'a'.repeat(64),
          cursorHash: 'b'.repeat(64),
          owner: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        },
      };
      const oldBytes = JSON.stringify(old);
      await db.$executeRawUnsafe(
        "INSERT INTO xhs_subscription_tasks VALUES('old-synthetic-task','b','blocked',?,1)",
        oldBytes,
      );
      runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
      runtime.bindFullHistoryWriter((work) =>
        db.$transaction((tx) => work(tx)),
      );
      runtime.bindFullHistoryReader((work) =>
        db.$transaction((tx) => work(tx)),
      );
      runtime.bindFullHistoryLegacyGuard(() => assertLegacyXhsSourceReady(db));
      await runtime.connectSession({
        a1: 'synthetic-a1',
        webSession: 'synthetic-session',
      });
      const policyInput = {
        creatorIds: ids,
        maxRequests: 20,
        phaseLimits: { profile: 3, list: 3, detail: 10, media: 10 },
      };
      await db.$transaction(async (tx) => {
        const plan = await prepareScheduledPolicy(tx, policyInput);
        await confirmScheduledPolicy(
          tx,
          policyInput,
          plan.digest,
          {
            assertQuiescent: async () => {},
            verifyBackup: async () => 'd'.repeat(64),
          },
          10n,
        );
      });
      service = new XhsSubscriptionService(db as any, runtime);
      service.write = async (_bytes: number, work: any) =>
        db.$transaction(work);
      const round = '2026-11-08/14:00';
      if (changed) {
        let release!: () => void;
        service.lane = new Promise<void>((resolve) => {
          release = resolve;
        });
        await service.scheduleCreatorPhase({
          round,
          creatorId: 'a',
          phase: 'basic',
        });
        await db.$executeRawUnsafe(
          'UPDATE xhs_subscription_tasks SET document=? WHERE id=?',
          JSON.stringify({
            ...old,
            sourceActive: { ...old.sourceActive, targetHash: 'e'.repeat(64) },
          }),
          old.taskId,
        );
        release();
        await service.lane;
        expect(api).not.toHaveBeenCalled();
        const t = await service.task({
          taskId: scheduledTaskId(round, 'a', 'basic'),
        });
        expect(t.state).toBe('blocked');
      } else {
        for (const creatorId of ids) {
          await service.scheduleCreatorPhase({
            round,
            creatorId,
            phase: 'basic',
          });
          await service.lane;
          expect(
            await service.task({
              taskId: scheduledTaskId(round, creatorId, 'basic'),
            }),
          ).toMatchObject({ state: 'completed' });
        }
        expect(api).toHaveBeenCalledTimes(6);
        const before = api.mock.calls.length;
        await service.scheduleCreatorPhase({
          round,
          creatorId: 'a',
          phase: 'basic',
        });
        await service.lane;
        expect(api).toHaveBeenCalledTimes(before);
        const retained = await db.$queryRawUnsafe<any[]>(
          'SELECT document FROM xhs_subscription_tasks WHERE id=?',
          old.taskId,
        );
        expect(retained[0].document).toBe(oldBytes);
        const ledger = await db.$queryRawUnsafe<any[]>(
          'SELECT phase,outcome FROM xhs_unbound_owner_requests',
        );
        expect(ledger).toHaveLength(6);
        expect(ledger.every((r) => r.outcome === 'response-received')).toBe(
          true,
        );
      }
      expect(deny).not.toHaveBeenCalled();
    } finally {
      await service?.onModuleDestroy();
      runtime.onModuleDestroy();
      deny.mockRestore();
      await db.$disconnect();
    }
  },
);
