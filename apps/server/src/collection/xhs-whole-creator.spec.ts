import { LocalArticleStore, ArticlePreparation } from '../article-local-save';
import { xhsLocalSnapshotPublisher } from './xhs-local-snapshot';
import { XhsSubscriptionService } from './xhs-subscription.service';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { PrismaClient } from '@prisma/client';
import { splitSqliteStatements } from '../../../../scripts/sqlite-statements.cjs';
import { XhsWholeCreatorService } from './xhs-whole-creator.service';
import { XhsEngagementService } from './xhs-engagement.service';
import { xhsNoteMetrics, mapXhsComments } from './xhs-engagement-contract';
import { RedbookSubscriptionAdapter } from './xhs-redbook-subscription';

const noteId = JSON.stringify(['xiaohongshu', 'note', 'note']);
describe('whole creator durable offline closure', () => {
  let db: PrismaClient, folder: string;
  beforeAll(async () => {
    folder = await fs.mkdtemp(path.join(tmpdir(), 'whole-synthetic-'));
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
      const sql = await fs.readFile(
        path.join(migrations, name, 'migration.sql'),
        'utf8',
      );
      for (const statement of splitSqliteStatements(sql))
        await db.$executeRawUnsafe(statement);
    }
    await db.xhsCreator.create({
      data: {
        id: 'creator',
        externalAuthorId: 'author',
        profileUrl: 'https://www.xiaohongshu.com/user/profile/author',
        displayName: 'Synthetic',
      },
    });
  }, 30000);
  afterAll(async () => {
    await db.$disconnect();
    await fs.rm(folder, { recursive: true, force: true });
  });
  it('reads and atomically reserves real SQLite budgets', async () => {
    const { XhsSqliteBudgetStore } = await import('./xhs-request-budget-store');
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,interval_ms) VALUES('probe',7,1000)`;
    const store = new XhsSqliteBudgetStore(db);
    expect((await store.read('probe'))!.used).toBe(0);
    expect(await store.reserve('probe', Date.now())).toBe(true);
    expect((await store.read('probe'))!.used).toBe(1);
  });
  it('does not equate top end with root reply completion; resumes with same budget and cursor', async () => {
    let budget: any,
      failReply = true;
    const replyCalls: string[] = [];
    const source: any = {
      metrics: async () => {
        await budget.admit('budget-unused');
        return xhsNoteMetrics({ interact_info: { liked_count: '0' } });
      },
      comments: async (
        _author: string,
        _note: string,
        cursor: string,
        root?: string,
      ) => {
        await budget.admit('budget-unused');
        if (root) {
          replyCalls.push(cursor);
          if (failReply && cursor === 'next')
            throw Error('synthetic interruption');
        }
        return mapXhsComments(
          {
            comments: [
              {
                id: root ? (cursor ? 'child2' : 'child1') : 'root',
                content: 'Synthetic',
                like_count: '0',
                user_info: { user_id: 'u', nickname: 'Synthetic' },
              },
            ],
            has_more: !!root && !cursor,
            cursor: root && !cursor ? 'next' : '',
          },
          root ?? null,
        );
      },
      capability: () => ({ canCollectComments: true }),
    };
    const engagement = new XhsEngagementService(db as any, source);
    const subscriptions: any = {
      refresh: async () => {
        await db.xhsNote.upsert({
          where: { id: noteId },
          update: {},
          create: {
            id: noteId,
            creatorId: 'creator',
            title: 'Synthetic',
            publishTime: 0,
            kind: 'image-text',
            status: 'complete',
            contentHtml: '<p>Synthetic</p>',
          },
        });
        return { taskId: 'list' };
      },
      task: async () => ({ state: 'completed' }),
      downloadNotes: async () => ({ taskId: 'download' }),
      confirmedLocalSaves: async () =>
        (await db.xhsNote.findMany({ where: { creatorId: 'creator' } })).map(
          (note) => ({
            noteId: note.id,
            savedAt: Date.now(),
            supplementStatus: 'new',
          }),
        ),
      cancelTask: async () => ({}),
    };
    subscriptions.confirmedLocalArchives = subscriptions.confirmedLocalSaves;
    let actualId = '';
    const runtime: any = {
      withRequestBudget: async (b: any, id: string, work: any) => {
        actualId = id;
        budget = { admit: () => b.admit(id) };
        return work();
      },
    };
    let service = new XhsWholeCreatorService(
      db as any,
      subscriptions,
      runtime,
      engagement,
    );
    const started = await service.start({
      creatorId: 'creator',
      requestLimit: 20,
      intervalMs: 1000,
    });
    async function settled() {
      for (let n = 0; n < 200; n++) {
        const v = await service.view(started.id);
        if (!['queued', 'running'].includes(v.state)) return v;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw Error('test timeout');
    }
    const paused = await settled();
    expect(paused.state).toBe('paused');
    expect(paused.items[0].top).toBeTruthy();
    expect(paused.items[0].replies).toBeUndefined();
    expect(paused.budget!.used).toBe(5);
    failReply = false;
    service = new XhsWholeCreatorService(
      db as any,
      subscriptions,
      runtime,
      engagement,
    );
    await service.onModuleInit();
    await service.resume(started.id);
    const completed = await settled();
    expect(completed.state).toBe('completed');
    expect(completed.items[0].replies).toBeTruthy();
    expect(completed.items[0].supplement).toBe('saved');
    expect(replyCalls).toEqual(['', 'next', 'next']);
    expect(completed.budget!.used).toBe(6);
    expect(actualId).toBe(started.id);
    const rows = await db.$queryRaw<
      Array<{ n: bigint }>
    >`SELECT count(*) n FROM xhs_saved_comments WHERE note_id=${noteId}`;
    expect(Number(rows[0].n)).toBe(3);
    // A new finite generation refreshes existing metrics and ended comment windows.
    subscriptions.refresh = async () => {
      await db.xhsNote.upsert({
        where: { id: noteId },
        update: {},
        create: {
          id: noteId,
          creatorId: 'creator',
          title: 'Synthetic',
          publishTime: 0,
          kind: 'image-text',
          status: 'complete',
        },
      });
      await db.xhsNote.create({
        data: {
          id: JSON.stringify(['xiaohongshu', 'note', 'new-note']),
          creatorId: 'creator',
          title: 'New synthetic',
          publishTime: 0,
          kind: 'image-text',
          status: 'complete',
        },
      });
      return { taskId: 'list2' };
    };
    const next = await service.start({
      creatorId: 'creator',
      requestLimit: 20,
      intervalMs: 1000,
    });
    async function wait(id: string) {
      for (let n = 0; n < 300; n++) {
        const value = await service.view(id);
        if (!['queued', 'running'].includes(value.state)) return value;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw Error('incremental timeout');
    }
    const increment = await wait(next.id);
    expect(increment.state).toBe('completed');
    expect(increment.items).toHaveLength(2);
    expect(increment.budget!.used).toBe(9);
    expect(replyCalls).toHaveLength(7);
    subscriptions.refresh = async () => ({ taskId: 'list3' });
    const bounded = await service.start({
      creatorId: 'creator',
      requestLimit: 2,
      intervalMs: 1000,
    });
    const exhausted = await wait(bounded.id);
    expect(exhausted.code).toBe('XHS_REQUEST_BUDGET_EXHAUSTED');
    expect(exhausted.budget!.used).toBe(2);
    await service.resume(bounded.id);
    expect((await wait(bounded.id)).budget!.used).toBe(2);
    await service.extend(bounded.id, 1);
    expect((await wait(bounded.id)).budget!.used).toBe(3);
  }, 40000);
  it('explicitly consumes cancelled state once while ordinary late saves remain fenced', async () => {
    const id = 'synthetic-cancelled';
    const job = {
      id,
      creatorId: 'creator',
      state: 'cancelled',
      updatedAt: 1,
      listEnd: true,
      items: {},
    };
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,interval_ms) VALUES(${id},7,1000)`;
    await db.$executeRaw`INSERT INTO xhs_whole_creator_jobs(id,creator_id,state,document,updated_at)
      VALUES(${id},'creator','cancelled',${JSON.stringify(job)},1)`;
    const service = new XhsWholeCreatorService(
      db as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const schedule = jest
      .spyOn(service as any, 'schedule')
      .mockImplementation(() => {});
    await expect(
      (service as any).save({ ...job, state: 'running' }),
    ).rejects.toThrow('XHS_TASK_STATE_CHANGED');
    expect((await service.view(id)).state).toBe('cancelled');
    const attempts = await Promise.allSettled([
      service.resume(id),
      service.resume(id),
    ]);
    expect(
      attempts.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(schedule).toHaveBeenCalledTimes(1);
    expect((await service.view(id)).state).toBe('queued');
    expect((await service.view(id)).budget!.limit).toBe(7);
    expect((await service.view(id)).budget!.used).toBe(0);
    schedule.mockRestore();
    await db.$executeRaw`UPDATE xhs_whole_creator_jobs SET state='cancelled' WHERE id=${id}`;
  });
  it('cancels a newly dispatched child when cancellation wins its parent checkpoint', async () => {
    const creatorId = 'spawn-cancel-creator';
    await db.xhsCreator.create({
      data: {
        id: creatorId,
        externalAuthorId: 'spawn-author',
        profileUrl: 'https://www.xiaohongshu.com/user/profile/spawn-author',
        displayName: 'Synthetic spawn',
      },
    });
    const cancelTask = jest.fn(async () => ({}));
    const subscriptions: any = {
      cancelTask,
      refresh: async () => {
        const rows = await db.$queryRaw<
          Array<{ id: string }>
        >`SELECT id FROM xhs_whole_creator_jobs WHERE creator_id=${creatorId} AND state='running'`;
        await whole.cancel(rows[0].id);
        return { taskId: 'synthetic-child' };
      },
    };
    const whole = new XhsWholeCreatorService(
      db as any,
      subscriptions,
      {
        withRequestBudget: async (_b: any, _id: string, work: any) => work(),
      } as any,
      {} as any,
    );
    const started = await whole.start({
      creatorId,
      requestLimit: 7,
      intervalMs: 1000,
    });
    await (whole as any).lane;
    expect((await whole.view(started.id)).state).toBe('cancelled');
    expect(cancelTask).toHaveBeenCalledTimes(1);
    expect(cancelTask).toHaveBeenCalledWith({ taskId: 'synthetic-child' });
    expect((await whole.view(started.id)).budget!.used).toBe(0);
  });
  it('requeues a formerly skipped video after cache completion and requires actual native body/companion receipts', async () => {
    const creatorId = 'video-creator',
      video = JSON.stringify(['xiaohongshu', 'note', 'late-video']);
    await db.xhsCreator.create({
      data: {
        id: creatorId,
        externalAuthorId: 'video-author',
        profileUrl: 'https://www.xiaohongshu.com/user/profile/video-author',
        displayName: 'Synthetic video',
      },
    });
    const source: any = {
      list: async () => ({
        authorId: 'video-author',
        notes: [
          {
            authorId: 'video-author',
            noteId: 'late-video',
            title: 'Synthetic late video',
            publishedAt: 0,
            kind: 'video',
          },
        ],
        nextCursor: null,
      }),
      metrics: async () =>
        xhsNoteMetrics({ interact_info: { liked_count: '0' } }),
      comments: async () => mapXhsComments({ comments: [], has_more: false }),
      capability: () => ({ canCollectComments: true }),
      detail: jest.fn(async () => {
        throw Error('unexpected detail');
      }),
    };
    const subscriptions = new XhsSubscriptionService(db as any, source);
    const directory = path.join(folder, 'native-video');
    await fs.mkdir(directory);
    const store = new LocalArticleStore(
      path.join(folder, 'native-preferences.json'),
      directory,
    );
    let savedResult: any;
    let saveFailure: unknown;
    let actualSaves = 0;
    subscriptions.bindLocalSaver(
      async () => directory,
      async (_creator, id, target) => {
        const prepare: ArticlePreparation = async (stage) => {
          await fs.mkdir(path.join(stage, 'image'));
          await fs.writeFile(
            path.join(stage, 'index.md'),
            '# Synthetic cached body\n\nBody preserved',
          );
          return {
            articleId: id,
            title: 'Synthetic late video',
            imageCount: 0,
            mediaComplete: true,
            exportSource: { feedId: creatorId, feedName: 'Synthetic video' },
          };
        };
        prepare.afterSave = xhsLocalSnapshotPublisher(
          id,
          'Synthetic late video',
          'Synthetic completed comments',
        );
        try {
          savedResult = await store.save(prepare, new Date(), target);
        } catch (error) {
          saveFailure = error;
          throw error;
        }
        actualSaves++;
        return savedResult;
      },
    );
    const runtime: any = {
      withRequestBudget: async (_budget: any, _id: string, work: any) => work(),
    };
    const whole = new XhsWholeCreatorService(
      db as any,
      subscriptions,
      runtime,
      new XhsEngagementService(db as any, source),
    );
    const started = await whole.start({
      creatorId,
      requestLimit: 7,
      intervalMs: 1000,
    });
    await (whole as any).lane;
    const first = await whole.view(started.id);
    expect(first.state).toBe('partial');
    expect(first.items[0].supplement).toBe('pending');
    const priorTask = first.downloadTask!;
    expect(
      await subscriptions.confirmedLocalSaves({ taskId: priorTask }),
    ).toEqual([]);
    expect(actualSaves).toBe(0);
    await whole.cancel(started.id);
    expect((await whole.view(started.id)).state).toBe('cancelled');
    // Synthetic cache completion alone is not a publication receipt.
    await db.xhsNote.update({
      where: { id: video },
      data: { status: 'complete', contentHtml: '<p>Synthetic cached body</p>' },
    });
    expect((await whole.view(started.id)).items[0].supplement).toBe('pending');
    await whole.resume(started.id);
    await (whole as any).lane;
    const completed = await whole.view(started.id);
    expect(saveFailure).toBeUndefined();
    expect(completed.state).toBe('completed');
    expect(completed.downloadTask).not.toBe(priorTask);
    expect(actualSaves).toBe(2);
    expect(completed.items[0].supplement).toBe('saved');
    expect((await fs.stat(savedResult.markdownPath)).isFile()).toBe(true);
    expect((await fs.stat(savedResult.supplement.path)).isFile()).toBe(true);
    const receipts = await subscriptions.confirmedLocalSaves({
      taskId: completed.downloadTask!,
    });
    expect(receipts).toHaveLength(1);
    expect(receipts[0].noteId).toBe(video);
    expect(completed.items[0].supplement).toBe('saved');
    expect(source.detail).not.toHaveBeenCalled();
  });
});

describe('expired access context reconstruction', () => {
  const author = {
    id: 'author',
    name: 'Synthetic',
    profileUrl: 'https://www.xiaohongshu.com/user/profile/author',
  };
  it('rebuilds through all list pages and never stores a note token as author credential', async () => {
    const client: any = {
      getUserInfo: jest.fn(async () => ({})),
      getUserNotes: jest.fn(async (_id: string, cursor: string) => ({
        notes: [
          {
            note_id: cursor ? 'target' : 'other',
            user: { user_id: 'author' },
            xsec_token: 'synthetic',
            type: 'normal',
          },
        ],
        has_more: !cursor,
        cursor: cursor ? '' : 'next',
      })),
    };
    const adapter = new RedbookSubscriptionAdapter(client, {
      profileParser: () => author,
    });
    await adapter.restoreContext('author', 'other');
    await adapter.restoreContext('author', 'target');
    expect(client.getUserNotes.mock.calls.map((c: any) => c[1])).toEqual([
      '',
      'next',
    ]);
    await adapter.restoreContext('author', 'target');
    expect(client.getUserNotes).toHaveBeenCalledTimes(2);
    adapter.clearAccessContext();
    await adapter.restoreContext('author', 'target');
    expect(client.getUserInfo).toHaveBeenCalledTimes(2);
  });
  it('stops on author mismatch before requesting a list', async () => {
    const client: any = {
      getUserInfo: async () => ({}),
      getUserNotes: jest.fn(),
    };
    const adapter = new RedbookSubscriptionAdapter(client, {
      profileParser: () => ({ ...author, id: 'other' }),
    });
    await expect(adapter.restoreContext('author', 'target')).rejects.toThrow(
      'XHS_AUTHOR_MISMATCH',
    );
    expect(client.getUserNotes).not.toHaveBeenCalled();
  });
});
