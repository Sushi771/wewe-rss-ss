import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { XhsSubscriptionRuntime } from './xhs-subscription-runtime';
import { XhsSubscriptionService } from './xhs-subscription.service';
import { XhsSourceRiskStore } from './xhs-source-risk-store';
import { bindXhsSourceTotalBudget } from './xhs-source-request-policy';
import { XhsScheduledRunner } from './xhs-scheduled-runner';
import { scheduledTaskId } from './xhs-scheduled-admission';
import { taskSourceFingerprint } from './xhs-task-source-fence';
import { createHash } from 'node:crypto';

// This exercises the real runner and full-detail worker with an injected
// admission seam. Production scheduled admission currently sets basicOnly.
import { applyFixtureMigrations } from '../../test/redbook-isolated/fixture-migrations';
jest.setTimeout(60000);

it.each(['parse', 'restricted', 'unknown'] as const)(
  'serializes artificially admitted full-detail tasks for %s',
  async (mode) => {
    const root = await fs.mkdtemp(
      path.join(tmpdir(), 'xhs-full-runner-fixture-'),
    );
    const file = path.join(root, 'fixture.sqlite');
    const db = new PrismaClient({
      datasources: { db: { url: 'file:' + file.replace(/\\/g, '/') } },
    });
    const deny = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
    await applyFixtureMigrations('file:' + file.replace(/\\/g, '/'));
    const api = jest.fn(async (request: any) => {
      const note = JSON.parse(request.body).source_note_id;
      if (api.mock.calls.length === 1 && mode === 'unknown')
        throw Error('synthetic unknown');
      if (api.mock.calls.length === 1 && mode === 'restricted')
        return {
          status: 403,
          url: request.url,
          body: { success: false, code: 403 },
        };
      return {
        status: 200,
        url: request.url,
        body: {
          success: true,
          code: 0,
          data: {
            items: [
              {
                id: note,
                note_card: {
                  note_id: note,
                  user: {
                    user_id: note === 'b-good' ? 'author-b' : 'author-a',
                  },
                  type: 'normal',
                  time: 1760000000000,
                  title: 'Synthetic',
                  desc: 'Body',
                  image_list: note === 'a-bad' ? null : [],
                  interact_info: { liked_count: '0', comment_count: '0' },
                },
              },
            ],
          },
        },
      };
    });
    const runtime = new XhsSubscriptionRuntime({
      enabled: () => true,
      api,
      requirePersistentRisk: true,
    });
    try {
      for (const id of ['a', 'b'])
        await db.xhsCreator.create({
          data: {
            id,
            externalAuthorId: `author-${id}`,
            profileUrl: `https://example.invalid/${id}`,
            displayName: id,
            enabled: true,
          },
        });
      await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,0)`;
      runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
      bindXhsSourceTotalBudget(db as any, runtime);
      await runtime.connectSession({
        a1: 'synthetic-a1',
        webSession: 'synthetic-session',
      });
      jest.spyOn(runtime, 'resolve').mockImplementation(
        async (url) =>
          ({
            inputKind: 'profile',
            author: { id: url.split('/').pop() },
          }) as any,
      );
      const jobs = new Map<string, any>();
      for (const [creator, notes] of [
        ['a', ['a-bad', 'a-good']],
        ['b', ['b-good']],
      ] as const) {
        const author = `author-${creator}`;
        (runtime as any).adapter.restoreDefaultAuthorAccess(author);
        const keys = notes.map((note) =>
          JSON.stringify(['xiaohongshu', 'note', note]),
        );
        for (const [index, note] of notes.entries()) {
          (runtime as any).adapter.tokens.set(JSON.stringify([author, note]), {
            token: 'synthetic',
            source: 'pc_user',
            expiresAt: Date.now() + 60000,
          });
          await db.xhsNote.create({
            data: {
              id: keys[index],
              creatorId: creator,
              title: 'Old',
              publishTime: 0,
              kind: 'image-text',
              status: 'listed',
            },
          });
        }
        const task = {
          taskId: `full-${creator}`,
          creatorId: creator,
          kind: 'list',
          state: 'queued',
          collectionStage: 'details',
          collectDetails: true,
          basicOnly: false,
          reuseCompleteCache: false,
          noteIds: keys,
          items: {},
          total: keys.length,
          completed: 0,
          skipped: 0,
          failed: 0,
          remaining: keys.length,
        };
        jobs.set(creator, task);
        await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES(${task.taskId},${creator},'queued',${JSON.stringify(task)},1)`;
      }
      const service: any = new XhsSubscriptionService(db as any, runtime);
      service.write = async (_bytes: number, fn: any) => db.$transaction(fn);
      const admitted = new Set<string>();
      const runner = new XhsScheduledRunner(db as any, {
        scheduleCreatorPhase: async (input: any) => {
          if (input.phase === 'media') return { state: 'nothing-to-archive' };
          const job = jobs.get(input.creatorId);
          if (!admitted.has(input.creatorId)) {
            admitted.add(input.creatorId);
            await service.run(job);
          }
          return { taskId: job.taskId };
        },
        task: async (input: any) => service.task(input),
      });
      try {
        await runner.run('synthetic-round');
      } catch {
        /* partial or safely stopped */
      }
      const requests = api.mock.calls.map(
        ([request]: any[]) => JSON.parse(request.body).source_note_id,
      );
      if (mode === 'parse') {
        expect(requests).toEqual(['a-bad', 'a-good', 'b-good']);
        expect(jobs.get('a')).toMatchObject({
          state: 'partial',
          failed: 1,
          completed: 1,
          remaining: 0,
          code: 'XHS_DETAIL_PARSE_FAILED',
        });
        expect(jobs.get('b')).toMatchObject({
          state: 'completed',
          completed: 1,
        });
      } else {
        expect(requests).toEqual(['a-bad']);
        expect(admitted.has('b')).toBe(false);
      }
      expect(deny).not.toHaveBeenCalled();
      await service.onModuleDestroy();
    } finally {
      runtime.onModuleDestroy();
      deny.mockRestore();
      await db.$disconnect();
    }
  },
);

it.each(['settled-unknown', 'started-unknown'] as const)(
  'scheduled basic history %s blocks later notes after service recreation',
  async (mode) => {
    const root = await fs.mkdtemp(
        path.join(tmpdir(), 'xhs-basic-unknown-fixture-'),
      ),
      file = path.join(root, 'fixture.sqlite');
    const db = new PrismaClient({
      datasources: { db: { url: 'file:' + file.replace(/\\/g, '/') } },
    });
    const deny = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
    await applyFixtureMigrations('file:' + file.replace(/\\/g, '/'));
    const creator = 'creator',
      author = 'author',
      oldId = 'old-task',
      bad = 'bad',
      good = 'good';
    const keys = [bad, good].map((note) =>
      JSON.stringify(['xiaohongshu', 'note', note]),
    );
    const hash = (s: string) => createHash('sha256').update(s).digest('hex');
    const cursorHash = hash(''),
      fingerprint = taskSourceFingerprint(creator, 'detail', bad, cursorHash),
      marker = 'xhs:dispatch-pending:unknown:' + fingerprint;
    const previous: any = {
      taskId: oldId,
      creatorId: creator,
      state: 'blocked',
      noteIds: keys,
    };
    if (mode === 'settled-unknown')
      previous.sourceUnknowns = {
        one: {
          marker,
          fingerprint,
          targetHash: hash(bad),
          cursorHash,
          phase: 'detail',
          outcome: 'unknown',
          classification: 'request-outcome-unknown',
          taskId: oldId,
          creatorId: creator,
        },
      };
    else
      previous.sourceActive = {
        fingerprint,
        targetHash: hash(bad),
        cursorHash,
        phase: 'detail',
        outcome: 'started',
        owner: '00000000-0000-4000-8000-000000000001',
      };
    const detail = jest.fn(async () => {
      throw Error('DETAIL_MUST_NOT_SEND');
    });
    const source: any = {
      hasAuthorContext: () => true,
      resolve: async () => ({ inputKind: 'profile', author: { id: author } }),
      basicDetailWithMedia: detail,
    };
    try {
      await db.xhsCreator.create({
        data: {
          id: creator,
          externalAuthorId: author,
          profileUrl: 'https://example.invalid/a',
          displayName: 'Synthetic',
          enabled: true,
        },
      });
      for (const id of keys)
        await db.xhsNote.create({
          data: {
            id,
            creatorId: creator,
            title: 'Old',
            publishTime: 0,
            kind: 'image-text',
            status: 'listed',
          },
        });
      if (mode === 'settled-unknown')
        await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES(${marker},1,1,0,0)`;
      await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES(${oldId},${creator},'blocked',${JSON.stringify(previous)},1)`;
      for (const round of ['2026-10-31/09:15', '2026-10-31/14:00']) {
        const taskId = scheduledTaskId(round, creator, 'basic');
        const task: any = {
          taskId,
          creatorId: creator,
          kind: 'list',
          state: 'queued',
          schedule: { round, phase: 'basic' },
          collectionStage: 'details',
          collectDetails: true,
          basicOnly: true,
          reuseCompleteCache: false,
          noteIds: keys,
          items: {},
          total: 2,
          completed: 0,
          skipped: 0,
          failed: 0,
          remaining: 2,
        };
        await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES(${taskId},${creator},'queued',${JSON.stringify(task)},1)`;
        const service: any = new XhsSubscriptionService(db as any, source);
        service.write = async (_bytes: number, fn: any) => db.$transaction(fn);
        await service.run(task);
        expect(task).toMatchObject({
          state: 'blocked',
          code: 'XHS_DETAIL_OUTCOME_UNKNOWN',
          failed: 1,
          completed: 0,
          remaining: 1,
        });
        expect(detail).not.toHaveBeenCalled();
        await service.onModuleDestroy();
      }
      expect(deny).not.toHaveBeenCalled();
    } finally {
      deny.mockRestore();
      await db.$disconnect();
    }
  },
);
