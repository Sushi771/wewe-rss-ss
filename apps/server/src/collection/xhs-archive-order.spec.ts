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
import { xhsNoteMetrics, mapXhsComments } from './xhs-engagement-contract';
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
  beforeEach(async () => {
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
  });
  afterAll(async () => {
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
  it('resumes old replies checkpoint with the same 14/100 ledger; all full files exist before first reply failure; resume retains hand edits and refreshes supplement', async () => {
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
      failReply = true;
    const events: string[] = [],
      savedPaths = new Map<string, string>();
    const source: any = {
      detail: jest.fn(async (_a, id) => {
        events.push('detail:' + id);
        await budget();
        return candidate(id);
      }),
      metrics: async () => {
        events.push('metrics');
        await budget();
        return candidate('x').metrics;
      },
      comments: async (_a, id, _cursor, root) => {
        events.push('comments:' + id + ':' + root);
        await budget();
        if (root && failReply) throw Error('synthetic root failure');
        return mapXhsComments({ comments: [], has_more: false });
      },
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
    await db.$executeRaw`INSERT INTO xhs_request_budgets(id,request_limit,interval_ms,used) VALUES('old-job',100,1000,14)`;
    await db.$executeRaw`INSERT INTO xhs_whole_creator_jobs(id,creator_id,state,document,updated_at) VALUES('old-job','creator','paused',${JSON.stringify(job)},1)`;
    let whole = new XhsWholeCreatorService(
      db as any,
      subscriptions,
      runtime,
      new XhsEngagementService(db as any, source),
    );
    await whole.onModuleInit();
    expect(events).toEqual([]);
    expect((await whole.view('old-job')).budget!.used).toBe(14);
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
    expect(events[6]).toBe('comments:a:root');
    expect(paused.state).toBe('paused');
    expect(paused.budget!.used).toBe(18);
    expect(paused.budget!.limit).toBe(100);
    expect(paused.items.every((n) => n.archive === 'saved')).toBe(true);
    expect(paused.items.every((n) => n.supplement === 'pending')).toBe(true);
    expect(paused.items.find((n) => n.noteId === key('a'))!.engagement).toBe(
      'partial',
    );
    for (const file of savedPaths.values())
      expect(await fs.readFile(file, 'utf8')).toContain(
        'Complete synthetic text',
      );
    const protectedPath = savedPaths.get(key('a'))!;
    await fs.appendFile(protectedPath, '\nSynthetic hand edit');
    failReply = false;
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
    expect(await fs.readFile(protectedPath, 'utf8')).toContain(
      'Synthetic hand edit',
    );
    expect(complete.archiveTask).not.toBe(complete.downloadTask);
  }, 30000);
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
