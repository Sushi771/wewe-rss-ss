import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { PrismaClient } from '@prisma/client';
import { splitSqliteStatements } from '../../../../scripts/sqlite-statements.cjs';
import { XhsSubscriptionService } from './xhs-subscription.service';
import { XiaohongshuService } from './xiaohongshu.service';
import { XhsWholeCreatorService } from './xhs-whole-creator.service';
import { XhsEngagementService } from './xhs-engagement.service';
import { saveXhsMetrics, saveCommentPage } from './xhs-engagement-store';
import { xhsNoteMetrics } from './xhs-engagement-contract';
import { LocalArticleStore } from '../article-local-save';

const key = (id: string) => JSON.stringify(['xiaohongshu', 'note', id]);
const candidate = (id: string) => ({
  authorId: 'author',
  noteId: id,
  kind: 'image-text' as const,
  title: 'Synthetic ' + id,
  text: 'Complete synthetic text',
  textStatus: 'full' as const,
  publishedAt: 1760000000,
  expectedImageCount: 0,
  images: [],
  metrics: xhsNoteMetrics({
    interact_info: {
      liked_count: '0',
      collected_count: '2',
      share_count: '3',
      comment_count: '4',
    },
  }),
});
describe('complete archive before interaction, independent query (synthetic only)', () => {
  // Jest timeouts do not cancel the test body. Keep its promise so teardown
  // cannot reset the shared fixture while that body can still schedule work.
  let testBody: Promise<unknown> = Promise.resolve();
  let setupPromise: Promise<void> = Promise.resolve();
  let fixtureReady = true;
  let cleanupPromise: Promise<void> | undefined;
  const track = (fn: (...args: any[]) => unknown) => (...args: any[]) => {
    testBody = Promise.resolve().then(() => fn(...args));
    return testBody;
  };
  const it = Object.assign(
    (name: any, fn: any, timeout?: number) => globalThis.it(name, track(fn), timeout),
    { each: (rows: any) => (name: any, fn: any, timeout?: number) => globalThis.it.each(rows)(name, track(fn), timeout) },
  ) as jest.It;

  let db: PrismaClient, folder: string;
  beforeAll(async () => {
    folder = await fs.mkdtemp(path.join(tmpdir(), 'xhs-order-synthetic-'));
    db = new PrismaClient({
      datasources: {
        db: {
          url:
            'file:' + path.join(folder, 'synthetic.sqlite').replace(/\\/g, '/'),
        },
      },
    });
    const migrations = path.resolve(__dirname, '../../prisma/migrations');
    for (const name of (await fs.readdir(migrations)).sort()) {
      if (!(await fs.stat(path.join(migrations, name))).isDirectory()) continue;
      for (const sql of splitSqliteStatements(
        await fs.readFile(path.join(migrations, name, 'migration.sql'), 'utf8'),
      ))
        await db.$executeRawUnsafe(sql);
    }
  }, 30000);
  beforeEach(() => {
    if (!fixtureReady) throw new Error("Previous test cleanup is still running");
    fixtureReady=false; cleanupPromise=undefined; testBody=Promise.resolve();
    setupPromise=(async () => {
    await db.$executeRaw`DELETE FROM xhs_whole_creator_jobs`;
    await db.$executeRaw`DELETE FROM xhs_request_budgets`;
    await db.$executeRaw`DELETE FROM xhs_metric_snapshots`;
    await db.xhsNote.deleteMany();
    await db.xhsCreator.deleteMany();
    await db.xhsCreator.create({
      data: {
        id: 'creator',
        externalAuthorId: 'author',
        profileUrl: 'https://www.xiaohongshu.com/user/profile/author',
        displayName: 'Synthetic',
      },
    });
    })(); return setupPromise;
  });
  afterEach(async () => {
    cleanupPromise ??= (async () => { await setupPromise.catch(() => {}); await testBody.catch(() => {}); fixtureReady=true; })();
    await cleanupPromise;
  });
  afterAll(async () => {
    if (!fixtureReady) throw new Error("Test fixture still in use");
    await db.$disconnect();
    await fs.rm(folder, { recursive: true, force: true });
  });
  async function seed(id: string, complete = false) {
    return db.xhsNote.create({
      data: {
        id: key(id),
        creatorId: 'creator',
        title: 'Title only ' + id,
        publishTime: 1760000000,
        status: complete ? 'complete' : 'listed',
        kind: 'image-text',
        contentHtml: complete
          ? '<div id="js_content"><p>Synthetic full text</p></div>'
          : null,
      },
    });
  }
  it('keeps directory-only entries normal and engagement independent across archive/metrics four combinations', async () => {
    for (const id of ['a', 'b', 'c', 'd', 'e'])
      await seed(id, ['a', 'b'].includes(id));
    for (const id of ['a', 'c'])
      await saveXhsMetrics(db, 'note', key(id), candidate(id).metrics);
    const api = new XiaohongshuService(db as any);
    const directory = path.join(folder, 'four-combinations');
    await fs.mkdir(directory);
    const store = new LocalArticleStore(
      path.join(folder, 'combination-settings.json'),
      directory,
    );
    const subscriptions = new XhsSubscriptionService(db as any, {} as any);
    subscriptions.bindLocalSaver(
      async () => directory,
      async (creator, id, target) =>
        store.save(
          await api.prepareLocalDownload(creator.id, id),
          new Date(),
          target,
        ),
    );
    const task = await subscriptions.downloadNotes({
      creatorId: 'creator',
      noteIds: [key('a'), key('b')],
    });
    await (subscriptions as any).lane;
    expect(
      (await subscriptions.confirmedLocalArchives(task))
        .map((r) => r.noteId)
        .sort(),
    ).toEqual([key('a'), key('b')]);
    expect(
      (await subscriptions.confirmedLocalSaves(task)).map((r) => r.noteId),
    ).toEqual([key('a')]);
    const notes = await api.notes('creator');
    expect(notes.items.filter((n) => n.status === 'listed')).toHaveLength(3);
    expect(notes.items.filter((n) => n.status === 'complete')).toHaveLength(2);
    for (const id of ['a', 'c'])
      expect(
        (await api.engagement({ creatorId: 'creator', noteId: key(id) }))
          .metrics!.values,
      ).toEqual({ likes: 0, collects: 2, shares: 3, comments: 4 });
    for (const id of ['b', 'd'])
      expect(
        (await api.engagement({ creatorId: 'creator', noteId: key(id) }))
          .metrics,
      ).toBeNull();
    await expect(
      api.engagement({ creatorId: 'other', noteId: key('a') }),
    ).rejects.toThrow('XHS_NOTE_NOT_FOUND');
    await expect(
      api.prepareLocalDownload('creator', key('c')),
    ).rejects.toThrow();
  });
  it('resumes an old replies checkpoint with its existing budget; archives precede metrics, old comments and hand edits survive a metrics interruption', async () => {
    for (const id of ['a', 'b', 'c']) await seed(id);
    await saveCommentPage(
      db,
      key('a'),
      [
        {
          id: 'root',
          rootId: null,
          parentId: null,
          content: 'Synthetic root',
          authorId: null,
          authorName: null,
          likes: null,
          publishedAt: null,
          collectedAt: 1,
        },
      ],
      {
        scope: 'top',
        nextCursor: null,
        pages: 1,
        state: 'returned-end',
        code: null,
        collectedAt: 1,
        cursors: [''],
      },
    );
    let budget: any,
      failMetric = true,
      metricCalls = 0;
    const events: string[] = [],
      savedPaths = new Map<string, string>();
    const source: any = {
      detail: jest.fn(async (_a, id) => {
        events.push('detail:' + id);
        await budget();
        return { ...candidate(id), metrics: undefined };
      }),
      metrics: async () => {
        events.push('metrics');
        if (failMetric && ++metricCalls === 2)
          throw Error('synthetic metrics interruption');
        await budget();
        return candidate('x').metrics;
      },
      comments: jest.fn(),
      capability: () => ({ canCollectComments: true }),
    };
    const subscriptions = new XhsSubscriptionService(db as any, source);
    const api = new XiaohongshuService(db as any);
    const directory = path.join(folder, 'native');
    await fs.mkdir(directory);
    const store = new LocalArticleStore(
      path.join(folder, 'settings.json'),
      directory,
    );
    subscriptions.bindLocalSaver(
      async () => directory,
      async (creator, id, target) => {
        const result = await store.save(
          await api.prepareLocalDownload(creator.id, id),
          new Date(),
          target,
        );
        savedPaths.set(id, result.markdownPath);
        events.push('saved:' + JSON.parse(id)[2]);
        return result;
      },
    );
    const runtime: any = {
      withRequestBudget: async (b, id, work) => {
        expect(id).toBe('old-job');
        budget = () => b.admit(id);
        return work();
      },
    };
    const job = {
      id: 'old-job',
      creatorId: 'creator',
      state: 'paused',
      stage: 'replies',
      currentNote: key('a'),
      code: 'XHS_COMMENT_FETCH_FAILED',
      updatedAt: 1,
      listEnd: true,
      profile: 1,
      items: { [key('a')]: { metrics: 1, top: 1 } },
    };
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,interval_ms,used) VALUES('old-job',60,1000,7)`;
    await db.$executeRaw`INSERT INTO xhs_whole_creator_jobs(id,creator_id,state,document,updated_at) VALUES('old-job','creator','paused',${JSON.stringify(job)},1)`;
    let whole = new XhsWholeCreatorService(
      db as any,
      subscriptions,
      runtime,
      new XhsEngagementService(db as any, source),
    );
    await whole.onModuleInit();
    expect(events).toEqual([]);
    expect((await whole.view('old-job')).budget!.used).toBe(7);
    await whole.resume('old-job');
    await (whole as any).lane;
    const paused = await whole.view('old-job');
    expect(events.slice(0, 6)).toEqual([
      'detail:a',
      'saved:a',
      'detail:b',
      'saved:b',
      'detail:c',
      'saved:c',
    ]);
    expect(events.slice(6)).toEqual(['metrics', 'metrics']);
    expect(source.comments).not.toHaveBeenCalled();
    expect(paused.state).toBe('paused');
    expect(paused.budget!.used).toBe(11);
    expect(paused.budget!.limit).toBe(60);
    expect(paused.items.every((n) => n.archive === 'saved')).toBe(true);
    expect(paused.items.every((n) => n.supplement === 'pending')).toBe(true);
    expect(paused.items.find((n) => n.noteId === key('a'))!.engagement).toBe(
      'metrics-only',
    );
    for (const file of savedPaths.values())
      expect(await fs.readFile(file, 'utf8')).toContain(
        'Complete synthetic text',
      );
    const protectedPath = savedPaths.get(key('a'))!;
    await fs.appendFile(protectedPath, '\nSynthetic hand edit');
    failMetric = false;
    whole = new XhsWholeCreatorService(
      db as any,
      subscriptions,
      runtime,
      new XhsEngagementService(db as any, source),
    );
    const before = events.length;
    await whole.onModuleInit();
    expect(events).toHaveLength(before);
    await whole.resume('old-job');
    await (whole as any).lane;
    const complete = await whole.view('old-job');
    expect(complete.state).toBe('completed');
    expect(
      complete.items.every(
        (n) => n.archive === 'saved' && n.supplement === 'saved',
      ),
    ).toBe(true);
    expect(source.detail).toHaveBeenCalledTimes(3);
    expect(source.comments).not.toHaveBeenCalled();
    expect(complete.budget!.used).toBe(12);
    expect(complete.budget!.limit).toBe(60);
    expect(
      (await api.engagement({ creatorId: 'creator', noteId: key('a') }))
        .comments,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'root', content: 'Synthetic root' }),
      ]),
    );
    expect(await fs.readFile(protectedPath, 'utf8')).toContain(
      'Synthetic hand edit',
    );
    expect(complete.archiveTask).not.toBe(complete.downloadTask);
  }, 30000);
  it('reuses only this archive task detail metrics and refreshes missing metrics', async () => {
    await seed('with-metrics');
    await seed('without-metrics');
    await seed('existing', true);
    await saveXhsMetrics(
      db,
      'note',
      key('existing'),
      xhsNoteMetrics({ interact_info: { liked_count: '99' } }, 1),
    );
    let budget: any;
    const detail = jest.fn(async (_author, id) => {
      await budget();
      const n = candidate(id);
      return id === 'without-metrics' ? { ...n, metrics: undefined } : n;
    });
    const metrics = jest.fn(async (_author, id) => {
      await budget();
      return candidate(id).metrics;
    });
    const source: any = { detail, metrics };
    const subscriptions = new XhsSubscriptionService(db as any, source);
    subscriptions.bindLocalSaver(
      async () => folder,
      async () => ({
        alreadySaved: false,
        mediaComplete: true,
        supplement: { status: 'new' },
      }),
    );
    const runtime: any = {
      withRequestBudget: async (b, id, work) => {
        budget = () => b.admit(id);
        return work();
      },
    };
    const job = {
      id: 'reuse-job',
      creatorId: 'creator',
      state: 'paused',
      updatedAt: 1,
      listEnd: true,
      profile: 1,
      items: {},
    };
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,interval_ms,used) VALUES('reuse-job',20,0,0)`;
    await db.$executeRaw`INSERT INTO xhs_whole_creator_jobs(id,creator_id,state,document,updated_at) VALUES('reuse-job','creator','paused',${JSON.stringify(job)},1)`;
    const whole = new XhsWholeCreatorService(
      db as any,
      subscriptions,
      runtime,
      new XhsEngagementService(db as any, source),
    );
    await whole.resume('reuse-job');
    await (whole as any).lane;
    const completed = await whole.view('reuse-job');
    expect(completed.state).toBe('completed');
    expect(detail).toHaveBeenCalledTimes(2);
    expect(metrics).toHaveBeenCalledTimes(2);
    expect(metrics).toHaveBeenCalledWith('author', 'without-metrics');
    expect(metrics).toHaveBeenCalledWith('author', 'existing');
    expect(completed.budget!.used).toBe(4);
    const snapshot = await db.$queryRaw<
      Array<{ document: string }>
    >`SELECT document FROM xhs_metric_snapshots WHERE owner_id=${key('with-metrics')}`;
    expect(JSON.parse(snapshot[0].document).values).toEqual({
      likes: 0,
      collects: 2,
      shares: 3,
      comments: 4,
    });
    const receipts = await subscriptions.confirmedLocalArchives({
      taskId: completed.archiveTask!,
    });
    expect(
      receipts.find((r) => r.noteId === key('with-metrics'))
        ?.metricsCollectedAt,
    ).toBeGreaterThan(0);
    expect(
      receipts.find((r) => r.noteId === key('without-metrics'))
        ?.metricsCollectedAt,
    ).toBeUndefined();
    // A stale in-memory checkpoint after a lost acknowledgement cannot erase a committed detail receipt.
    const rows = await db.$queryRaw<
      Array<{ document: string }>
    >`SELECT document FROM xhs_subscription_tasks WHERE id=${completed.archiveTask!}`;
    const stale = JSON.parse(rows[0].document);
    delete stale.detailMetrics;
    await db.$transaction((tx) => (subscriptions as any).persistIn(tx, stale));
    const preserved = await subscriptions.confirmedLocalArchives({
      taskId: completed.archiveTask!,
    });
    expect(
      preserved.find((r) => r.noteId === key('with-metrics'))
        ?.metricsCollectedAt,
    ).toBeGreaterThan(0);
  }, 40000);
  it('retains a detail receipt across a saver failure and resumes without another detail request', async () => {
    await seed('interrupted');
    const source: any = {
      detail: jest.fn(async (_author, id) => candidate(id)),
    };
    let fail = true;
    const subscriptions = new XhsSubscriptionService(db as any, source);
    subscriptions.bindLocalSaver(
      async () => folder,
      async () => {
        if (fail) throw Error('synthetic save failure');
        return {
          alreadySaved: false,
          mediaComplete: true,
          supplement: { status: 'new' },
        };
      },
    );
    const first = await subscriptions.downloadNotes({
      creatorId: 'creator',
      noteIds: [key('interrupted')],
    });
    await (subscriptions as any).lane;
    expect((await subscriptions.task(first)).state).not.toBe('completed');
    const rows = await db.$queryRaw<
      Array<{ document: string }>
    >`SELECT document FROM xhs_subscription_tasks WHERE id=${first.taskId}`;
    expect(
      JSON.parse(rows[0].document).detailMetrics[key('interrupted')],
    ).toBeGreaterThan(0);
    expect(source.detail).toHaveBeenCalledTimes(1);
    fail = false;
    const second = await subscriptions.resumeTask(first);
    await (subscriptions as any).lane;
    expect((await subscriptions.task(second)).state).toBe('completed');
    expect(source.detail).toHaveBeenCalledTimes(1);
    const receipts = await subscriptions.confirmedLocalArchives(second);
    expect(receipts[0].metricsCollectedAt).toBeGreaterThan(0);
  }, 40000);
  it('confirms a real native archive with no metrics/comments even when there is no companion', async () => {
    await seed('no-interaction', true);
    const api = new XiaohongshuService(db as any);
    const directory = path.join(folder, 'no-interaction');
    await fs.mkdir(directory);
    const store = new LocalArticleStore(
      path.join(folder, 'no-interaction-settings.json'),
      directory,
    );
    const subscriptions = new XhsSubscriptionService(db as any, {} as any);
    let result: any;
    subscriptions.bindLocalSaver(
      async () => directory,
      async (creator, id, target) => {
        result = await store.save(
          await api.prepareLocalDownload(creator.id, id),
          new Date(),
          target,
        );
        return result;
      },
    );
    const task = await subscriptions.downloadNotes({
      creatorId: 'creator',
      noteIds: [key('no-interaction')],
    });
    await (subscriptions as any).lane;
    expect((await subscriptions.task(task)).state).toBe('completed');
    expect(await fs.readFile(result.markdownPath, 'utf8')).toContain(
      'Synthetic full text',
    );
    expect(result.supplement).toBeUndefined();
    expect(await subscriptions.confirmedLocalSaves(task)).toEqual([]);
    expect(await subscriptions.confirmedLocalArchives(task)).toHaveLength(1);
    expect(
      (
        await api.engagement({
          creatorId: 'creator',
          noteId: key('no-interaction'),
        })
      ).metrics,
    ).toBeNull();
  });
  it('does not archive an empty body or mark incomplete media as a successful directory save', async () => {
    await seed('empty');
    const source: any = {
      detail: async () => ({
        ...candidate('empty'),
        text: '',
        expectedImageCount: 1,
      }),
    };
    const subscriptions = new XhsSubscriptionService(db as any, source);
    const save = jest.fn();
    subscriptions.bindLocalSaver(async () => folder, save);
    const task = await subscriptions.downloadNotes({
      creatorId: 'creator',
      noteIds: [key('empty')],
    });
    await (subscriptions as any).lane;
    expect((await subscriptions.task(task)).state).toBe('blocked');
    expect(await subscriptions.confirmedLocalSaves(task)).toEqual([]);
    expect(await subscriptions.confirmedLocalArchives(task)).toEqual([]);
    expect(save).not.toHaveBeenCalled();
    expect(
      (await db.xhsNote.findUniqueOrThrow({ where: { id: key('empty') } }))
        .status,
    ).toBe('listed');
  });
});
