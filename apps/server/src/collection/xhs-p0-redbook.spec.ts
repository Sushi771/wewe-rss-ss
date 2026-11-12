import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { XhsSubscriptionRuntime } from './xhs-subscription-runtime';
import { XhsSubscriptionService } from './xhs-subscription.service';
import { XhsSourceRiskStore } from './xhs-source-risk-store';
import { bindXhsSourceTotalBudget } from './xhs-source-request-policy';
import { RedbookSubscriptionAdapter } from './xhs-redbook-subscription';
import { XhsSourceParseError } from './xhs-subscription-errors';
import { XhsBatchSubscriptionService } from './xhs-batch-subscription.service';
import { XhsScheduledRunner } from './xhs-scheduled-runner';
import { scheduledTaskId } from './xhs-scheduled-admission';
import { approveSyntheticScheduledPolicy } from '../../test/fixtures/xhs-scheduled-policy';

jest.setTimeout(60000);
import { applyFixtureMigrations } from '../../test/redbook-isolated/fixture-migrations';
it('records a bound invalid full detail and continues to the next note through the real Redbook adapter', async () => {
  const folder = await fs.mkdtemp(path.join(tmpdir(), 'redbook-p0-isolated-'));
  const file = path.join(folder, 'fixture.sqlite');
  const db = new PrismaClient({
    datasources: { db: { url: 'file:' + file.replace(/\\/g, '/') } },
  });
  const globalFetch = jest
    .spyOn(global, 'fetch')
    .mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
  try {
    await applyFixtureMigrations('file:' + file.replace(/\\/g, '/'));
    const creatorId = 'parse-creator',
      author = 'parse-author';
    const keys = ['parse-a', 'parse-b'].map((n) =>
      JSON.stringify(['xiaohongshu', 'note', n]),
    );
    await db.xhsCreator.create({
      data: {
        id: creatorId,
        externalAuthorId: author,
        profileUrl: 'https://example.invalid/author',
        displayName: 'Synthetic',
      },
    });
    for (const id of keys)
      await db.xhsNote.create({
        data: {
          id,
          creatorId,
          title: 'Old',
          publishTime: 0,
          kind: 'image-text',
          status: 'listed',
        },
      });
    const task: any = {
      taskId: 'parse-task',
      creatorId,
      kind: 'list',
      state: 'queued',
      collectionStage: 'details',
      collectDetails: true,
      basicOnly: false,
      reuseCompleteCache: false,
      noteIds: keys,
      items: {},
      total: 2,
      completed: 0,
      skipped: 0,
      failed: 0,
      remaining: 2,
    };
    await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES('parse-task',${creatorId},'queued',${JSON.stringify(task)},1)`;
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,0) ON CONFLICT(id) DO UPDATE SET request_limit=100,used=0,next_at=0,interval_ms=0`;
    const api = jest.fn(async (request: any) => {
      const note = JSON.parse(request.body).source_note_id,
        owner = note === 'parse-d' ? 'second-author' : author;
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
                  user: { user_id: owner },
                  type: 'normal',
                  time: 1760000000000,
                  title: 'New',
                  desc: 'saved body',
                  image_list: note.startsWith('parse-a') ? null : [],
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
    runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    bindXhsSourceTotalBudget(db as any, runtime);
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    (runtime as any).adapter.restoreDefaultAuthorAccess(author);
    jest.spyOn(runtime, 'resolve').mockImplementation(
      async (url) =>
        ({
          inputKind: 'profile',
          author: { id: url.split('/').pop() },
        }) as any,
    );
    for (const note of ['parse-a', 'parse-b'])
      (runtime as any).adapter.tokens.set(JSON.stringify([author, note]), {
        token: 'synthetic-token',
        source: 'pc_user',
        expiresAt: Date.now() + 60000,
      });
    const service: any = new XhsSubscriptionService(db as any, runtime);
    service.write = async (_bytes: number, fn: any) => db.$transaction(fn);
    try {
      await service.run(task);
      expect(api).toHaveBeenCalledTimes(2);
      expect(task).toMatchObject({
        state: 'partial',
        failed: 1,
        completed: 1,
        remaining: 0,
        code: 'XHS_DETAIL_PARSE_FAILED',
        items: { [keys[0]]: 'failed', [keys[1]]: 'completed' },
      });
      expect(
        (await db.xhsNote.findUniqueOrThrow({ where: { id: keys[0] } }))
          .contentHtml,
      ).toBeNull();
      expect(
        (await db.xhsNote.findUniqueOrThrow({ where: { id: keys[1] } }))
          .contentHtml,
      ).toContain('saved body');
      expect(
        (
          await db.$queryRaw<
            any[]
          >`SELECT state FROM xhs_source_risk WHERE id='source'`
        )[0].state,
      ).toBe('clear');
      expect(globalFetch).not.toHaveBeenCalled();
      const second = 'second-creator',
        secondAuthor = 'second-author',
        secondKey = JSON.stringify(['xiaohongshu', 'note', 'parse-d']);
      await db.xhsCreator.create({
        data: {
          id: second,
          externalAuthorId: secondAuthor,
          profileUrl: 'https://example.invalid/second',
          displayName: 'Synthetic second',
        },
      });
      await db.xhsNote.create({
        data: {
          id: secondKey,
          creatorId: second,
          title: 'Old',
          publishTime: 0,
          kind: 'image-text',
          status: 'listed',
        },
      });
      (runtime as any).adapter.restoreDefaultAuthorAccess(secondAuthor);
      (runtime as any).adapter.tokens.set(
        JSON.stringify([secondAuthor, 'parse-d']),
        {
          token: 'synthetic-token',
          source: 'pc_user',
          expiresAt: Date.now() + 60000,
        },
      );
      const secondTask: any = {
        taskId: 'second-task',
        creatorId: second,
        kind: 'list',
        state: 'queued',
        collectionStage: 'details',
        collectDetails: true,
        basicOnly: false,
        reuseCompleteCache: false,
        noteIds: [secondKey],
        items: {},
        total: 1,
        completed: 0,
        skipped: 0,
        failed: 0,
        remaining: 1,
      };
      await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES('second-task',${second},'queued',${JSON.stringify(secondTask)},1)`;
      await service.run(secondTask);
      expect(secondTask).toMatchObject({
        state: 'completed',
        completed: 1,
        remaining: 0,
      });
      expect(api).toHaveBeenCalledTimes(3);
      const nextKeys = ['parse-a2', 'parse-c'].map((n) =>
        JSON.stringify(['xiaohongshu', 'note', n]),
      );
      for (const id of nextKeys)
        await db.xhsNote.create({
          data: {
            id,
            creatorId,
            title: 'Old',
            publishTime: 0,
            kind: 'image-text',
            status: 'listed',
          },
        });
      for (const note of ['parse-a2', 'parse-c'])
        (runtime as any).adapter.tokens.set(JSON.stringify([author, note]), {
          token: 'synthetic-token',
          source: 'pc_user',
          expiresAt: Date.now() + 60000,
        });
      const next: any = {
        taskId: 'checkpoint-task',
        creatorId,
        kind: 'list',
        state: 'queued',
        collectionStage: 'details',
        collectDetails: true,
        basicOnly: false,
        reuseCompleteCache: false,
        noteIds: nextKeys,
        items: {},
        total: 2,
        completed: 0,
        skipped: 0,
        failed: 0,
        remaining: 2,
      };
      await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES('checkpoint-task',${creatorId},'queued',${JSON.stringify(next)},1)`;
      const checkpoint = jest
        .spyOn(runtime, 'checkpointWholeSource')
        .mockRejectedValueOnce(new Error('synthetic checkpoint failure'));
      await service.run(next);
      expect(api).toHaveBeenCalledTimes(4);
      expect(next.state).toBe('blocked');
      expect(next.completed).toBe(0);
      expect(next.code).not.toBe('XHS_DETAIL_PARSE_FAILED');
      expect(
        (await db.xhsNote.findUniqueOrThrow({ where: { id: nextKeys[1] } }))
          .contentHtml,
      ).toBeNull();
      checkpoint.mockRestore();
    } finally {
      runtime.onModuleDestroy();
    }
  } finally {
    globalFetch.mockRestore();
    await db.$disconnect();
  }
});

it.each(['author', 'note', 'time', 'media403', 'media-unknown'] as const)(
  'does not downgrade %s into a single-note parse failure',
  async (mode) => {
    const raw: any = {
      items: [
        {
          id: 'note',
          note_card: {
            note_id: 'note',
            user: { user_id: 'author' },
            type: 'normal',
            time: 1760000000000,
            title: 'title',
            desc: 'body',
            image_list: [
              { url_default: 'https://sns-webpic.xhscdn.com/synthetic.png' },
            ],
          },
        },
      ],
    };
    if (mode === 'author') raw.items[0].note_card.user.user_id = 'other';
    if (mode === 'note') raw.items[0].id = 'other';
    if (mode === 'time') raw.items[0].note_card.time = null;
    const client: any = {
      getNoteById: jest.fn(async () => raw),
      getUserInfo: jest.fn(),
      getUserNotes: jest.fn(),
    };
    const media = jest.fn(async () => {
      if (mode === 'media-unknown') throw Error('synthetic transport');
      return new Response('', { status: 403 });
    });
    const adapter = new RedbookSubscriptionAdapter(client, {}, media as any);
    (adapter as any).tokens.set(JSON.stringify(['author', 'note']), {
      token: 'fixture',
      source: 'pc_user',
      expiresAt: Date.now() + 60000,
    });
    let caught: unknown;
    try {
      await adapter.detail('author', 'note');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(caught).not.toBeInstanceOf(XhsSourceParseError);
    expect(media).toHaveBeenCalledTimes(mode.startsWith('media') ? 1 : 0);
  },
);

it('does not start the next author until the current account reaches a terminal receipt', async () => {
  let firstState = 'running';
  const service = {
    scheduleCreatorPhase: jest.fn(
      async (input: { creatorId: string; phase: string }) =>
        input.phase === 'media'
          ? { state: 'nothing-to-archive' }
          : { taskId: input.creatorId },
    ),
    task: jest.fn(async (input: { taskId: string }) =>
      input.taskId === 'a'
        ? {
            state: firstState,
            failed: 0,
            remaining: firstState === 'running' ? 1 : 0,
          }
        : { state: 'completed', failed: 0, remaining: 0 },
    ),
  };
  const runner = new XhsScheduledRunner(
    { xhsCreator: { findMany: async () => [{ id: 'a' }, { id: 'b' }] } },
    service,
  );
  await expect(runner.run('2026-10-31/09:15')).rejects.toThrow(
    'XHS_SCHEDULE_TASK_PENDING',
  );
  expect(
    service.scheduleCreatorPhase.mock.calls.map(([x]) => x.creatorId),
  ).toEqual(['a']);
  firstState = 'completed';
  await runner.run('2026-10-31/09:15');
  expect(
    service.scheduleCreatorPhase.mock.calls.map(([x]) => x.creatorId),
  ).toEqual(['a', 'a', 'a', 'b', 'b']);
});
it.each(['media-blocked', 'media-running', 'unexpected-error'] as const)(
  'does not enter next account after %s',
  async (mode) => {
    const service = {
      scheduleCreatorPhase: jest.fn(
        async (input: { creatorId: string; phase: string }) => {
          if (mode === 'unexpected-error')
            throw Error('synthetic admission failure');
          return { taskId: input.phase === 'basic' ? 'basic' : 'media' };
        },
      ),
      task: jest.fn(async (input: { taskId: string }) =>
        input.taskId === 'basic'
          ? { state: 'completed', failed: 0, remaining: 0 }
          : {
              state: mode === 'media-running' ? 'running' : 'blocked',
              failed: 0,
              remaining: 1,
            },
      ),
    };
    const runner = new XhsScheduledRunner(
      { xhsCreator: { findMany: async () => [{ id: 'a' }, { id: 'b' }] } },
      service,
    );
    await expect(runner.run('2026-10-31/09:15')).rejects.toThrow();
    expect(
      service.scheduleCreatorPhase.mock.calls.every(
        ([x]) => x.creatorId === 'a',
      ),
    ).toBe(true);
  },
);
it.each([
  'comments-pending',
  'comments-incomplete',
  'archive-incomplete',
] as const)('does not enter next account after %s', async (mode) => {
  const service = {
    scheduleCreatorPhase: jest.fn(
      async (input: { creatorId: string; phase: string }) =>
        input.phase === 'media'
          ? { state: 'nothing-to-archive' }
          : { taskId: input.creatorId },
    ),
    task: jest.fn(async () => ({
      state: 'completed',
      failed: 0,
      remaining: 0,
    })),
    archiveScheduled: jest.fn(async () => ({
      incomplete: mode === 'archive-incomplete',
    })),
  };
  const engagement = {
    collectScheduled: jest.fn(async () => ({
      pending: mode === 'comments-pending',
      incomplete: mode === 'comments-incomplete',
    })),
  };
  const runner = new XhsScheduledRunner(
    { xhsCreator: { findMany: async () => [{ id: 'a' }, { id: 'b' }] } },
    service,
    engagement,
  );
  await expect(runner.run('2026-10-31/09:15')).rejects.toThrow();
  expect(
    service.scheduleCreatorPhase.mock.calls.every(([x]) => x.creatorId === 'a'),
  ).toBe(true);
  if (mode.startsWith('comments'))
    expect(service.archiveScheduled).not.toHaveBeenCalled();
});

it('starts a real subscription batch with a synthetic source and pauses an interrupted batch on restart', async () => {
  const folder = await fs.mkdtemp(
      path.join(tmpdir(), 'redbook-batch-isolated-'),
    ),
    file = path.join(folder, 'fixture.sqlite');
  const db = new PrismaClient({
    datasources: { db: { url: 'file:' + file.replace(/\\/g, '/') } },
  });
  const globalFetch = jest
    .spyOn(global, 'fetch')
    .mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
  await applyFixtureMigrations('file:' + file.replace(/\\/g, '/'));
  const api = jest.fn(async (request: any) => {
    const note = JSON.parse(request.body).source_note_id;
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
                user: { user_id: 'author-one', nickname: 'Synthetic' },
                type: 'normal',
                title: 'Synthetic',
                desc: 'Body',
                image_list: [],
                interact_info: {
                  liked_count: '0',
                  collected_count: '0',
                  share_count: '0',
                  comment_count: '0',
                },
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
    runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
    bindXhsSourceTotalBudget(db as any, runtime);
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,0)`;
    await runtime.connectSession({
      a1: 'synthetic-a1',
      webSession: 'synthetic-session',
    });
    jest.spyOn(runtime, 'list').mockResolvedValue({
      authorId: 'author-one',
      notes: [],
      nextCursor: null,
    } as any);
    const subscriptions: any = new XhsSubscriptionService(db as any, runtime);
    subscriptions.write = async (_bytes: number, fn: any) =>
      db.$transaction(fn);
    const batch: any = new XhsBatchSubscriptionService(
      db as any,
      runtime,
      subscriptions,
    );
    batch.write = async (fn: any) => db.$transaction(fn);
    await batch.onModuleInit();
    const id = '11111111-1111-4111-8111-111111111111';
    await batch.start({
      clientRequestId: id,
      text: 'https://www.xiaohongshu.com/explore/note-a?xsec_token=synthetic&xsec_source=pc_search',
    });
    await batch.lane;
    const result = await batch.status({ batchId: id });
    expect(result.state).toBe('completed');
    expect(result.items[0].state).toBe('subscribed');
    expect(await db.xhsCreator.count()).toBe(1);
    const childId = result.items[0].collectionTaskId;
    expect(childId).toBeTruthy();
    await subscriptions.lane;
    expect((await subscriptions.task({ taskId: childId })).creatorId).toBe(
      result.items[0].creatorId,
    );
    const interruptedId = '22222222-2222-4222-8222-222222222222';
    const interrupted = {
      batchId: interruptedId,
      state: 'running',
      items: [
        {
          index: 0,
          fingerprint: 'synthetic',
          kind: 'note',
          state: 'resolving',
        },
      ],
    };
    await db.$executeRaw`INSERT INTO xhs_subscription_tasks(id,creator_id,state,document,updated_at) VALUES(${`batch:${interruptedId}`},'__batch__','batch_running',${JSON.stringify(interrupted)},1)`;
    const before = api.mock.calls.length;
    const restarted: any = new XhsBatchSubscriptionService(
      db as any,
      runtime,
      subscriptions,
    );
    restarted.write = async (fn: any) => db.$transaction(fn);
    await restarted.onModuleInit();
    const recovered = await restarted.status({ batchId: interruptedId });
    expect(recovered.state).toBe('paused');
    expect(recovered.items[0].state).toBe('unknown');
    expect(api).toHaveBeenCalledTimes(before);
    expect(globalFetch).not.toHaveBeenCalled();
    await subscriptions.onModuleDestroy();
  } finally {
    runtime.onModuleDestroy();
    globalFetch.mockRestore();
    await db.$disconnect();
  }
});

it.each(['parse', 'restricted', 'unknown'] as const)(
  'runs two enabled accounts in the actual scheduled runner with %s detail outcome',
  async (mode) => {
    const folder = await fs.mkdtemp(
        path.join(tmpdir(), 'redbook-scheduler-isolated-'),
      ),
      file = path.join(folder, 'fixture.sqlite');
    const db = new PrismaClient({
      datasources: { db: { url: 'file:' + file.replace(/\\/g, '/') } },
    });
    const globalFetch = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
    await applyFixtureMigrations('file:' + file.replace(/\\/g, '/'));
    let detailRequests = 0;
    const api = jest.fn(async (request: any) => {
      const url = new URL(request.url);
      if (request.method === 'GET') {
        const author = url.searchParams.get('user_id');
        const notes =
          author === 'author-a'
            ? ['a-bad', 'a-good']
            : author === 'author-b'
              ? ['b-good']
              : [];
        return {
          status: 200,
          url: request.url,
          body: {
            success: true,
            code: 0,
            data: url.pathname.endsWith('/user_posted')
              ? {
                  notes: notes.map((note_id) => ({
                    note_id,
                    user: { user_id: author },
                    xsec_token: 'synthetic-token',
                  })),
                  has_more: false,
                  cursor: '',
                }
              : {},
          },
        };
      }
      detailRequests++;
      const note = JSON.parse(request.body).source_note_id,
        owner = note === 'b-good' ? 'author-b' : 'author-a';
      if (detailRequests === 1 && mode === 'unknown')
        throw Error('synthetic unknown transport');
      if (detailRequests === 1 && mode === 'restricted')
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
                  user: { user_id: owner },
                  type: note === 'a-bad' ? 'unsupported' : 'normal',
                  time: 1760000000000,
                  title: 'Synthetic',
                  desc: 'Body ' + note,
                  image_list: [],
                  interact_info: {
                    liked_count: '0',
                    collected_count: '0',
                    share_count: '0',
                    comment_count: '0',
                  },
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
      profileParser: (_raw, author) => ({
        id: author,
        name: 'Synthetic',
        profileUrl: `https://www.xiaohongshu.com/user/profile/${author}`,
        metrics: {
          values: { fans: 1, following: null },
          collectedAt: 2,
          contract: 'synthetic',
          evidence: 'source-only',
        },
      }),
    });
    let policy:
      | Awaited<ReturnType<typeof approveSyntheticScheduledPolicy>>
      | undefined;
    let service: any;
    try {
      for (const id of ['a', 'b'])
        await db.xhsCreator.create({
          data: {
            id,
            externalAuthorId: `author-${id}`,
            profileUrl: `https://www.xiaohongshu.com/user/profile/author-${id}`,
            displayName: id,
            enabled: true,
          },
        });
      await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,used,next_at,interval_ms) VALUES('xhs:source-total',100,0,0,1000)`;
      runtime.bindRiskStore(new XhsSourceRiskStore(db as any));
      bindXhsSourceTotalBudget(db as any, runtime);
      await runtime.connectSession({
        a1: 'synthetic-a1',
        webSession: 'synthetic-session',
      });
      policy = await approveSyntheticScheduledPolicy(db, runtime, ['a', 'b']);
      service = new XhsSubscriptionService(db as any, runtime);
      service.write = async (_bytes: number, fn: any) => db.$transaction(fn);
      const runner = new XhsScheduledRunner(db as any, {
        scheduleCreatorPhase: service.scheduleCreatorPhase.bind(service),
        task: service.task.bind(service),
      });
      const round = '2026-10-31/09:15';
      for (let i = 0; i < 8; i++) {
        try {
          await runner.run(round);
        } catch {
          /* pending or intentionally partial */
        }
        await service.lane;
      }
      const first = await service.task({
        taskId: scheduledTaskId(round, 'a', 'basic'),
      });
      const sent = api.mock.calls
        .filter(([r]: any[]) => r.method === 'POST')
        .map(([r]: any[]) => JSON.parse(r.body).source_note_id);
      if (mode === 'parse') {
        const second = await service.task({
          taskId: scheduledTaskId(round, 'b', 'basic'),
        });
        expect(first).toMatchObject({
          state: 'partial',
          failed: 1,
          completed: 1,
          remaining: 0,
          code: 'XHS_DETAIL_PARSE_FAILED',
        });
        expect(second).toMatchObject({
          state: 'completed',
          failed: 0,
          completed: 1,
          remaining: 0,
        });
        expect(sent).toEqual(['a-bad', 'a-good', 'b-good']);
      } else {
        expect(sent).toHaveLength(1);
        await expect(
          service.task({ taskId: scheduledTaskId(round, 'b', 'basic') }),
        ).rejects.toThrow();
      }
      expect(
        (
          await db.$queryRaw<
            Array<{ used: number }>
          >`SELECT used FROM xhs_request_budgets WHERE id='xhs:source-total'`
        )[0].used,
      ).toBe(api.mock.calls.length);
      expect(globalFetch).not.toHaveBeenCalled();
    } finally {
      await service?.onModuleDestroy();
      await policy?.cleanup();
      runtime.onModuleDestroy();
      globalFetch.mockRestore();
      await db.$disconnect();
    }
  },
);
