jest.mock('./sqlite-backup', () => ({ createVerifiedSqliteBackup: jest.fn() }));
import { createVerifiedSqliteBackup } from './sqlite-backup';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { splitSqliteStatements } from '../../../../scripts/sqlite-statements.cjs';
import { XhsWholeCreatorService } from './xhs-whole-creator.service';
import { XhsSubscriptionService } from './xhs-subscription.service';
import { XhsSubscriptionRuntime } from './xhs-subscription-runtime';
import { XhsSourceRiskStore } from './xhs-source-risk-store';
import { XhsEngagementService } from './xhs-engagement.service';
import { fullHistoryBudgetId } from './xhs-full-history-scope';
import {
  assertUnboundDispatch,
  unboundRoundContext,
} from './xhs-unbound-round';

it.each(['before-dispatch', 'inflight-detail'] as const)(
  'cancels the actual reviewed full-history child safely: %s',
  async (mode) => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'xhs-full-cancel-'));
    const database = path.join(folder, 'synthetic.sqlite');
    const db = new PrismaClient({
      datasources: { db: { url: 'file:' + database.replace(/\\/g, '/') } },
    });
    let releaseLane: () => void = () => {};
    let subscriptions: XhsSubscriptionService | undefined;
    let runtime: XhsSubscriptionRuntime | undefined;
    let detailStarted: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      detailStarted = resolve;
    });
    let abortObserved = false;
    const api = jest.fn(async (request: any) => {
      await assertUnboundDispatch(db);
      const operation = unboundRoundContext.getStore()!.request.operationId;
      const rows = await db.$queryRawUnsafe<any[]>(
        'SELECT outcome FROM xhs_unbound_owner_requests WHERE operation_id=?',
        operation,
      );
      expect(rows[0].outcome).toBe('started');
      const route = new URL(request.url).pathname;
      if (
        !route.endsWith('/user/otherinfo') &&
        !route.endsWith('/user_posted')
      ) {
        expect(request.signal).toBeInstanceOf(AbortSignal);
        detailStarted();
        return new Promise<never>((_resolve, reject) => {
          const abort = () => {
            abortObserved = true;
            reject(
              new DOMException('synthetic cancelled request', 'AbortError'),
            );
          };
          request.signal.addEventListener('abort', abort, { once: true });
          if (request.signal.aborted) abort();
        });
      }
      return {
        status: 200,
        url: request.url,
        body: {
          success: true,
          code: 0,
          data: route.endsWith('/user/otherinfo')
            ? {}
            : {
                notes: [
                  {
                    note_id: 'cancel-note',
                    user: { user_id: 'author-a' },
                    type: 'normal',
                    display_title: 'Synthetic',
                    xsec_token: 'synthetic',
                  },
                ],
                has_more: false,
                cursor: '',
              },
        },
      };
    });
    try {
      const migrations = path.resolve(__dirname, '../../prisma/migrations');
      for (const name of (await fs.readdir(migrations)).sort()) {
        if (!(await fs.stat(path.join(migrations, name))).isDirectory())
          continue;
        for (const sql of splitSqliteStatements(
          await fs.readFile(
            path.join(migrations, name, 'migration.sql'),
            'utf8',
          ),
        ))
          await db.$executeRawUnsafe(sql);
      }
      const bindings = ['a', 'b', 'c'].map((creatorId) => ({
        creatorId,
        jobId: randomUUID(),
      }));
      for (const binding of bindings) {
        await db.xhsCreator.create({
          data: {
            id: binding.creatorId,
            displayName: 'Synthetic',
            externalAuthorId: 'author-' + binding.creatorId,
            profileUrl:
              'https://www.xiaohongshu.com/user/profile/author-' +
              binding.creatorId,
          },
        });
        await db.$executeRawUnsafe(
          "INSERT INTO xhs_whole_creator_jobs VALUES(?,?,'paused',?,1)",
          binding.jobId,
          binding.creatorId,
          JSON.stringify({
            id: binding.jobId,
            creatorId: binding.creatorId,
            state: 'paused',
          }),
        );
        await db.$executeRawUnsafe(
          'INSERT INTO xhs_request_budgets(id,used,request_limit,next_at,interval_ms) VALUES(?,0,100,0,1000)',
          binding.jobId,
        );
      }
      await db.$executeRawUnsafe(
        "INSERT INTO xhs_request_budgets(id,used,request_limit,next_at,interval_ms) VALUES('xhs:source-total',0,100,0,1000)",
      );
      runtime = new XhsSubscriptionRuntime({
        enabled: () => true,
        api,
        requirePersistentRisk: true,
        profileParser: () => ({
          id: 'author-a',
          name: 'Synthetic',
          profileUrl: 'https://www.xiaohongshu.com/user/profile/author-a',
        }),
      });
      const risk = new XhsSourceRiskStore(db as any);
      runtime.bindRiskStore(risk);
      await runtime.connectSession({
        a1: 'synthetic',
        webSession: 'synthetic',
      });
      subscriptions = new XhsSubscriptionService(db as any, runtime);
      const whole = new XhsWholeCreatorService(
        db as any,
        subscriptions,
        runtime,
        new XhsEngagementService(db as any, runtime),
      );
      const input = {
        bindings,
        maxRequests: 30,
        phaseLimits: { profile: 3, list: 3, detail: 10, media: 10 },
      };
      const plan = await whole.prepareWholeCreatorFullHistory(input);
      (createVerifiedSqliteBackup as jest.Mock).mockResolvedValue({
        source: database,
        backup: 'synthetic-witness-only',
        sha256: 'f'.repeat(64),
        integrityCheck: 'ok',
        recoveryOrigin: {
          format: 'sqlite-recovery-origin-v1',
          kind: 'protected',
        },
      });
      const confirmed = await whole.confirmWholeCreatorFullHistory({
        ...input,
        digest: plan.digest,
        acknowledgedUnknownScope: true,
        acknowledgedDuplicateDirectoryRead: true,
      });
      const before = await db.$queryRawUnsafe<any[]>(
        'SELECT id,used FROM xhs_request_budgets ORDER BY id',
      );
      if (mode === 'before-dispatch') {
        // Hold the existing child lane, not any authorization or dispatch guard.
        (subscriptions as any).lane = new Promise<void>((resolve) => {
          releaseLane = resolve;
        });
      }
      const started = await whole.executeWholeCreatorFullHistory({
        reviewId: confirmed.reviewId,
        jobId: bindings[0].jobId,
      });
      if (mode === 'inflight-detail') await entered;
      const cancelled = await subscriptions.cancelTask({
        taskId: started.taskId,
      });
      expect(cancelled.state).toBe('cancelled');
      releaseLane();
      await (subscriptions as any).lane;
      expect((await subscriptions.task({ taskId: started.taskId })).state).toBe(
        'cancelled',
      );
      const requests = await db.$queryRawUnsafe<any[]>(
        'SELECT phase,outcome FROM xhs_unbound_owner_requests ORDER BY phase',
      );
      const after = await db.$queryRawUnsafe<any[]>(
        'SELECT id,used FROM xhs_request_budgets ORDER BY id',
      );
      if (mode === 'before-dispatch') {
        expect(api).not.toHaveBeenCalled();
        expect(requests).toEqual([]);
        expect(after).toEqual(before);
      } else {
        expect(abortObserved).toBe(true);
        expect(api).toHaveBeenCalledTimes(3);
        expect(requests).toContainEqual({
          phase: 'detail',
          outcome: 'unknown',
        });
        expect(after.find((x) => x.id === 'xhs:source-total').used).toBe(3);
        expect(after.find((x) => x.id === bindings[0].jobId).used).toBe(0);
        expect(
          after.find(
            (x) =>
              x.id ===
              fullHistoryBudgetId(confirmed.reviewId, bindings[0].jobId),
          ).used,
        ).toBe(3);
        const persistentRisk = await db.$queryRawUnsafe<
          Array<{ state: string }>
        >("SELECT state FROM xhs_source_risk WHERE id='source'");
        expect(persistentRisk).toHaveLength(1);
        expect(['pending', 'blocked']).toContain(persistentRisk[0].state);
        const beforeRestart = await db.$queryRawUnsafe<any[]>(
          'SELECT * FROM xhs_unbound_owner_requests ORDER BY operation_id',
        );
        const restarted = new XhsSubscriptionService(db as any, runtime);
        await restarted.onModuleInit();
        expect(
          await db.$queryRawUnsafe(
            'SELECT * FROM xhs_unbound_owner_requests ORDER BY operation_id',
          ),
        ).toEqual(beforeRestart);
        expect(
          await db.$queryRawUnsafe(
            'SELECT id,used FROM xhs_request_budgets ORDER BY id',
          ),
        ).toEqual(after);
        expect(api).toHaveBeenCalledTimes(3);
        await restarted.onModuleDestroy();
      }
      await expect(
        whole.executeWholeCreatorFullHistory({
          reviewId: confirmed.reviewId,
          jobId: bindings[0].jobId,
        }),
      ).rejects.toThrow();
      expect(api).toHaveBeenCalledTimes(mode === 'before-dispatch' ? 0 : 3);
    } finally {
      releaseLane();
      if (subscriptions) {
        for (const task of (subscriptions as any).pending.values())
          await subscriptions.cancelTask({ taskId: task.taskId });
        await (subscriptions as any).lane;
        await subscriptions.onModuleDestroy();
      }
      runtime?.onModuleDestroy();
      await db.$disconnect();
      await fs.rm(folder, { recursive: true, force: true });
    }
  },
  40000,
);
