import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { PrismaClient } from '@prisma/client';
import { splitSqliteStatements } from '../../../../scripts/sqlite-statements.cjs';
import {
  XhsSubscriptionService,
  XhsSubscriptionSource,
  subscriptionUrl,
} from './xhs-subscription.service';
import { XiaohongshuService } from './xiaohongshu.service';
import { XhsNormalizedCandidate } from './xiaohongshu-contract';
import { LocalArticleStore } from '../article-local-save';
import { RedbookSubscriptionAdapter } from './xhs-redbook-subscription';
import { xhsNoteFilterSchema } from '@wewe-rss/shared';
import { allowedRedbookMediaUrl } from './redbook-response';
import { TrpcService } from '../trpc/trpc.service';
import { TrpcRouter } from '../trpc/trpc.router';
import { ConfigService } from '@nestjs/config';
import { XhsSubscriptionError } from './xhs-subscription-errors';

const author = {
  id: 'synthetic-author',
  name: '合成作者',
  profileUrl: 'https://www.xiaohongshu.com/user/profile/synthetic-author',
};
const noteKey = (id: string) => JSON.stringify(['xiaohongshu', 'note', id]);
const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=';
const detail = (noteId = 'note-a'): XhsNormalizedCandidate => ({
  authorId: author.id,
  noteId,
  kind: 'image-text',
  title: '合成笔记',
  text: '检索正文测试',
  textStatus: 'full',
  publishedAt: 1760000000,
  expectedImageCount: 1,
  images: [{ ordinal: 1, inlineData: png }],
});
describe('isolated subscription workflow with synthetic SQLite and actual local saver', () => {
  let root: string,
    db: PrismaClient,
    service: XhsSubscriptionService,
    cache: XiaohongshuService,
    source: XhsSubscriptionSource,
    store: LocalArticleStore;
  let creatorId: string;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'xhs-subscription-test-'));
    db = new PrismaClient({
      datasources: {
        db: {
          url:
            'file:' + path.join(root, 'synthetic.sqlite').replace(/\\/g, '/'),
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
      for (const statement of splitSqliteStatements(sql)
        .map((s) => s.trim())
        .filter(Boolean))
        await db.$executeRawUnsafe(statement);
    }
    await db.$executeRawUnsafe('PRAGMA synchronous = FULL');
    cache = new XiaohongshuService(db as any);
    store = new LocalArticleStore(path.join(root, 'settings.json'), root);
  }, 30000);
  beforeEach(async () => {
    await db.$executeRawUnsafe('DELETE FROM xhs_subscription_tasks');
    await db.xhsNote.deleteMany();
    await db.xhsCreator.deleteMany();
    source = {
      resolve: jest.fn(async (url) => ({
        inputKind: url.includes('/user/profile/')
          ? ('profile' as const)
          : ('note' as const),
        author,
      })),
      list: jest.fn(async () => ({
        authorId: author.id,
        nextCursor: null,
        notes: [
          {
            authorId: author.id,
            noteId: 'note-a',
            title: '合成列表',
            publishedAt: 0,
            kind: 'image-text' as const,
          },
        ],
      })),
      detail: jest.fn(async () => detail()),
    };
    service = new XhsSubscriptionService(db as any, source);
    service.bindLocalSaver(
      async () => root,
      async (creator, noteId, directory) => {
        const prepare = await cache.prepareLocalDownload(creator.id, noteId);
        return store.save(
          async (stage) => ({
            ...(await prepare(stage)),
            exportSource: { feedId: creator.id, feedName: creator.displayName },
          }),
          new Date(),
          directory,
        );
      },
    );
    const resolution = await service.resolveSubscription({
      url: author.profileUrl,
    });
    creatorId = (
      await service.subscribe({ resolutionId: resolution.resolutionId })
    ).creatorId;
  });
  afterAll(async () => {
    await db?.$disconnect(); /* synthetic files retained in temp for diagnosis */
  });
  const finish = async (taskId: string) => {
    for (let i = 0; i < 2000; i++) {
      const t = await service.task({ taskId });
      if (!['queued', 'running'].includes(t.state)) return t;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('SYNTHETIC_TASK_TIMEOUT');
  };
  const settled = async (taskId: string) => {
    for (let i = 0; i < 500; i++) {
      const task = await service.task({ taskId });
      if (task.resumable) return task;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw Error('SYNTHETIC_SETTLEMENT_TIMEOUT');
  };
  it('resolves without creating/listing; confirmation is idempotent and validates group', async () => {
    const r = await service.resolveSubscription({
      url: 'https://www.xiaohongshu.com/explore/note-a?xsec_token=synthetic',
    });
    expect(r).toMatchObject({
      inputKind: 'note',
      existingCreatorId: creatorId,
      author,
    });
    expect(await db.xhsCreator.count()).toBe(1);
    expect(source.list).not.toHaveBeenCalled();
    expect(source.detail).not.toHaveBeenCalled();
    await expect(
      service.subscribe({
        resolutionId: r.resolutionId,
        groupId: 'wrong-platform',
      }),
    ).rejects.toThrow('XHS_GROUP_INVALID');
    expect(await service.subscribe({ resolutionId: r.resolutionId })).toEqual({
      creatorId,
      created: false,
      subscribed: true,
    });
    await expect(
      service.subscribe({ resolutionId: 'expired' }),
    ).rejects.toThrow('XHS_RESOLUTION_EXPIRED');
  });
  it('exposes the agreed task API through protected routes and gates local writes', async () => {
    const config = new ConfigService({
      auth: { code: 'synthetic-auth' },
      platform: { url: '' },
      feed: { updateDelayTime: 0 },
    });
    const router = new TrpcRouter(
      new TrpcService(db as any, config, {} as any, {} as any),
      db as any,
      config,
      {} as any,
      {} as any,
      cache,
      service,
    ).appRouter;
    await expect(
      router
        .createCaller({ errorMsg: 'synthetic unauthorized' })
        .xiaohongshu.resolveSubscription({ url: author.profileUrl }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const api = router.createCaller({ errorMsg: null, isLocalSave: true });
    const { taskId } = await api.xiaohongshu.refresh({ id: creatorId });
    await finish(taskId);
    expect(await api.xiaohongshu.task({ taskId })).toMatchObject({
      kind: 'list',
      state: 'completed',
    });
    expect(
      (await api.xiaohongshu.notes({ creatorId, search: '合成' })).items,
    ).toHaveLength(1);
    await expect(
      router
        .createCaller({ errorMsg: null, isLocal: true, isLocalSave: false })
        .xiaohongshu.downloadNotes({ creatorId, noteIds: [noteKey('note-a')] }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(source.detail).not.toHaveBeenCalled();
  });
  it('updates metadata only, then separately downloads actual body/image bytes and skips duplicates', async () => {
    expect(
      await finish((await service.refresh({ id: creatorId })).taskId),
    ).toMatchObject({ state: 'completed', total: 1, completed: 1 });
    expect(source.detail).not.toHaveBeenCalled();
    expect(
      await db.xhsNote.findUnique({ where: { id: noteKey('note-a') } }),
    ).toMatchObject({ status: 'listed', contentHtml: null, publishTime: 0 });
    const request = { creatorId, noteIds: [noteKey('note-a')] };
    expect(
      await finish((await service.downloadNotes(request)).taskId),
    ).toMatchObject({ state: 'completed', completed: 1, remaining: 0 });
    const saved = await db.xhsNote.findUniqueOrThrow({
      where: { id: noteKey('note-a') },
    });
    expect(saved.status).toBe('complete');
    expect(saved.contentHtml).toContain('data:image/png;base64,');
    expect(
      await finish((await service.downloadNotes(request)).taskId),
    ).toMatchObject({ state: 'completed', skipped: 1 });
    expect(source.detail).toHaveBeenCalledTimes(1);
    await finish((await service.refresh({ id: creatorId })).taskId);
    expect(await db.xhsNote.findUnique({ where: { id: saved.id } })).toEqual(
      saved,
    );
    const files = await fs.readdir(root, { recursive: true });
    expect(files.some((f) => String(f).endsWith('.md'))).toBe(true);
    expect(files.some((f) => /\.png$/.test(String(f)))).toBe(true);
  }, 30000);
  it('rejects another creator selection before details or saving', async () => {
    await finish((await service.refresh({ id: creatorId })).taskId);
    await expect(
      service.downloadNotes({ creatorId, noteIds: ['foreign'] }),
    ).rejects.toThrow('XHS_SELECTION_INVALID');
    expect(source.detail).not.toHaveBeenCalled();
  });
  it('stops after one failed detail instead of dispatching the rest of a batch', async () => {
    (source.list as jest.Mock).mockResolvedValue({
      authorId: author.id,
      nextCursor: null,
      notes: ['note-a', 'note-b'].map((noteId) => ({
        noteId,
        authorId: author.id,
        title: '',
        publishedAt: 0,
        kind: 'image-text',
      })),
    });
    await finish((await service.refresh({ id: creatorId })).taskId);
    (source.detail as jest.Mock).mockRejectedValue(
      new Error('synthetic authentication stop'),
    );
    const task = await finish(
      (
        await service.downloadNotes({
          creatorId,
          noteIds: [noteKey('note-a'), noteKey('note-b')],
        })
      ).taskId,
    );
    expect(task).toMatchObject({
      state: 'blocked',
      total: 2,
      failed: 1,
      remaining: 1,
    });
    expect(source.detail).toHaveBeenCalledTimes(1);
    expect(task).not.toHaveProperty('noteIds');
    expect(task).not.toHaveProperty('items');
  });
  it('enumerates the fourth page and incrementally deduplicates a repeated full scan', async () => {
    (source.list as jest.Mock).mockImplementation(async (_id, cursor) => {
      const page = cursor === null ? 0 : Number(cursor.slice(1));
      return {
        authorId: author.id,
        nextCursor: page === 3 ? null : `c${page + 1}`,
        notes: [
          {
            authorId: author.id,
            noteId: `page-${page}`,
            title: 'synthetic',
            publishedAt: 0,
            kind: 'image-text',
          },
        ],
      };
    });
    expect(
      await finish((await service.refresh({ id: creatorId })).taskId),
    ).toMatchObject({ state: 'completed', total: 4, completed: 4 });
    expect(source.list).toHaveBeenCalledTimes(4);
    expect(
      await finish((await service.refresh({ id: creatorId })).taskId),
    ).toMatchObject({ state: 'completed', total: 4, skipped: 4 });
    expect(await db.xhsNote.count()).toBe(4);
  });
  it('preserves platform group membership when confirming subscription', async () => {
    await db.managementGroup.create({
      data: {
        id: 'synthetic-xhs-group',
        name: '合成分组',
        platform: 'xiaohongshu',
      },
    });
    const resolution = await service.resolveSubscription({
      url: author.profileUrl,
    });
    await service.subscribe({
      resolutionId: resolution.resolutionId,
      groupId: 'synthetic-xhs-group',
    });
    expect(
      (await cache.list({ groupId: 'synthetic-xhs-group' })).items.map(
        (c) => c.id,
      ),
    ).toEqual([creatorId]);
    await service.subscribe({ resolutionId: resolution.resolutionId });
    expect(
      await db.xhsCreator.findUnique({ where: { id: creatorId } }),
    ).toMatchObject({ groupId: 'synthetic-xhs-group' });
  });
  it('processes a selection across 100-item boundaries without a total selection ceiling', async () => {
    const ids = Array.from({ length: 205 }, (_, i) => noteKey(`bulk-${i}`));
    await db.$transaction(async (tx) => {
      for (const id of ids)
        await tx.xhsNote.create({
          data: {
            id,
            creatorId,
            title: 'synthetic cached',
            status: 'complete',
            kind: 'image-text',
            contentHtml: '<div id="js_content"><p>synthetic</p></div>',
            publishTime: 1760000000,
          },
        });
    });
    const save = jest.fn(async () => ({ alreadySaved: false }));
    service.bindLocalSaver(async () => root, save);
    const task = await finish(
      (await service.downloadNotes({ creatorId, noteIds: ids })).taskId,
    );
    expect(task).toMatchObject({
      state: 'completed',
      total: 205,
      completed: 205,
      remaining: 0,
    });
    expect(save).toHaveBeenCalledTimes(205);
    expect(source.detail).not.toHaveBeenCalled();
    expect(task).not.toHaveProperty('directory');
    expect(task).not.toHaveProperty('cursor');
  }, 60000);
  it('resumes a cancelled list from its committed page without replaying or losing prior metadata', async () => {
    let startedSecond = false;
    (source.list as jest.Mock).mockImplementation(
      async (_id, cursor, signal: AbortSignal) => {
        if (cursor === null)
          return {
            authorId: author.id,
            nextCursor: 'c1',
            notes: [
              {
                authorId: author.id,
                noteId: 'one',
                title: 'one',
                kind: 'image-text',
                publishedAt: 0,
              },
            ],
          };
        startedSecond = true;
        return new Promise((_resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => reject(Error('synthetic abort')),
            { once: true },
          ),
        );
      },
    );
    const first = await service.refresh({ id: creatorId });
    while (!startedSecond) await new Promise((r) => setTimeout(r, 5));
    await service.cancelTask(first);
    expect(await settled(first.taskId)).toMatchObject({
      state: 'cancelled',
      completed: 1,
    });
    (source.list as jest.Mock).mockImplementation(async (_id, cursor) => {
      expect(cursor).toBe('c1');
      return {
        authorId: author.id,
        nextCursor: null,
        notes: [
          {
            authorId: author.id,
            noteId: 'two',
            title: 'two',
            kind: 'image-text',
            publishedAt: 0,
          },
        ],
      };
    });
    const resumed = await service.resumeTask(first);
    expect(resumed.taskId).not.toBe(first.taskId);
    expect(await finish(resumed.taskId)).toMatchObject({
      state: 'completed',
      completed: 2,
      total: 2,
    });
    expect(await db.xhsNote.count()).toBe(2);
    expect(await service.task(first)).toMatchObject({ state: 'cancelled' });
  });
  it('keeps cancellation terminal when creator validation finishes after cancellation', async () => {
    const original = (service as any).creator.bind(service);
    let calls = 0,
      release!: () => void;
    const validation = jest
      .spyOn(service as any, 'creator')
      .mockImplementation(async (id: unknown) => {
        const creator = await original(id);
        if (calls++ === 1)
          await new Promise<void>((resolve) => (release = resolve));
        return creator;
      });
    const task = await service.refresh({ id: creatorId });
    while (!release) await new Promise((r) => setTimeout(r, 5));
    await service.cancelTask(task);
    release();
    expect(await settled(task.taskId)).toMatchObject({
      state: 'cancelled',
      completed: 0,
    });
    expect(source.list).not.toHaveBeenCalled();
    validation.mockRestore();
  });
  it('stops repeated cursors with earlier page/checkpoint data intact', async () => {
    (source.list as jest.Mock).mockImplementation(async (_id, cursor) => ({
      authorId: author.id,
      nextCursor: 'same',
      notes: [
        {
          authorId: author.id,
          noteId: cursor === null ? 'one' : 'two',
          title: '',
          kind: 'image-text',
          publishedAt: 0,
        },
      ],
    }));
    expect(
      await finish((await service.refresh({ id: creatorId })).taskId),
    ).toMatchObject({
      state: 'blocked',
      code: 'XHS_CURSOR_CYCLE',
      total: 1,
      completed: 1,
    });
    expect(await db.xhsNote.count()).toBe(1);
    expect(source.list).toHaveBeenCalledTimes(2);
  });
  it('blocks a duplicate-only page even when the supplier keeps changing cursors', async () => {
    (source.list as jest.Mock).mockImplementation(async (_id, cursor) => ({
      authorId: author.id,
      nextCursor: cursor === null ? 'c1' : 'c2',
      notes: [
        {
          authorId: author.id,
          noteId: 'same-note',
          title: '',
          kind: 'image-text',
          publishedAt: 0,
        },
      ],
    }));
    expect(
      await finish((await service.refresh({ id: creatorId })).taskId),
    ).toMatchObject({
      state: 'blocked',
      code: 'XHS_LIST_NO_PROGRESS',
      total: 1,
    });
    expect(source.list).toHaveBeenCalledTimes(2);
    expect(await db.xhsNote.count()).toBe(1);
  });
  it('resumes only unfinished downloads, preserves saved content, and blocks changed destinations', async () => {
    (source.list as jest.Mock).mockResolvedValue({
      authorId: author.id,
      nextCursor: null,
      notes: ['one', 'two'].map((noteId) => ({
        authorId: author.id,
        noteId,
        title: '',
        kind: 'image-text',
        publishedAt: 0,
      })),
    });
    await finish((await service.refresh({ id: creatorId })).taskId);
    let allowSecond = false;
    (source.detail as jest.Mock).mockImplementation(async (_author, noteId) => {
      if (noteId === 'two' && !allowSecond)
        throw new XhsSubscriptionError('XHS_ACCESS_CONTEXT_EXPIRED');
      return detail(noteId);
    });
    const save = jest.fn(async () => ({ alreadySaved: false }));
    service.bindLocalSaver(async () => root, save);
    const first = await service.downloadNotes({
      creatorId,
      noteIds: [noteKey('one'), noteKey('two')],
    });
    expect(await finish(first.taskId)).toMatchObject({
      state: 'partial',
      completed: 1,
      failed: 1,
      code: 'XHS_ACCESS_CONTEXT_EXPIRED',
    });
    await settled(first.taskId);
    const old = await db.xhsNote.findUniqueOrThrow({
      where: { id: noteKey('one') },
    });
    service.bindLocalSaver(async () => path.join(root, 'changed'), save);
    await expect(service.resumeTask(first)).rejects.toThrow(
      'XHS_RESUME_DIRECTORY_CHANGED',
    );
    service.bindLocalSaver(async () => root, save);
    allowSecond = true;
    expect(
      await finish((await service.resumeTask(first)).taskId),
    ).toMatchObject({
      state: 'completed',
      completed: 2,
      failed: 0,
      remaining: 0,
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect(source.detail).toHaveBeenCalledTimes(3);
    expect(
      await db.xhsNote.findUnique({ where: { id: noteKey('one') } }),
    ).toEqual(old);
  });
  it('cancels during an in-flight list without committing the returned page', async () => {
    let release!: (v: any) => void;
    (source.list as jest.Mock).mockImplementation(
      () => new Promise((r) => (release = r)),
    );
    const { taskId } = await service.refresh({ id: creatorId });
    while (!release) await new Promise((r) => setTimeout(r, 5));
    expect(await service.cancelTask({ taskId })).toMatchObject({
      state: 'cancelled',
    });
    release({ authorId: author.id, notes: [], nextCursor: null });
    await new Promise((r) => setTimeout(r, 20));
    expect(await db.xhsNote.count()).toBe(0);
    expect(await service.task({ taskId })).toMatchObject({
      state: 'cancelled',
    });
  });
  it('recovers interrupted state as blocked without dispatching requests', async () => {
    const document = {
      taskId: 'restart',
      creatorId,
      state: 'running',
      kind: 'download',
      total: 2,
      completed: 1,
      skipped: 0,
      failed: 0,
      remaining: 1,
      noteIds: ['synthetic'],
      items: {},
      message: '',
    };
    await db.$executeRaw`INSERT INTO xhs_subscription_tasks VALUES ('restart', ${creatorId}, 'running', ${JSON.stringify(document)}, 1)`;
    await service.onModuleInit();
    expect(await service.task({ taskId: 'restart' })).toMatchObject({
      state: 'blocked',
      code: 'XHS_TASK_INTERRUPTED',
      completed: 1,
      remaining: 1,
    });
    expect(source.detail).not.toHaveBeenCalled();
  });
  it('keeps cancellation terminal if an in-flight detail subsequently rejects', async () => {
    await finish((await service.refresh({ id: creatorId })).taskId);
    let rejectDetail!: (error: Error) => void;
    (source.detail as jest.Mock).mockImplementation(
      () => new Promise((_resolve, reject) => (rejectDetail = reject)),
    );
    const { taskId } = await service.downloadNotes({
      creatorId,
      noteIds: [noteKey('note-a')],
    });
    while (!rejectDetail) await new Promise((r) => setTimeout(r, 5));
    await service.cancelTask({ taskId });
    rejectDetail(new Error('synthetic late transport failure'));
    await new Promise((r) => setTimeout(r, 30));
    expect(await service.task({ taskId })).toMatchObject({
      state: 'cancelled',
      failed: 0,
      remaining: 1,
    });
    expect(
      await db.xhsNote.findUnique({ where: { id: noteKey('note-a') } }),
    ).toMatchObject({ status: 'listed', contentHtml: null });
  });
  it('filters cached title/body and Shanghai dates without inventing unknown dates', async () => {
    await finish((await service.refresh({ id: creatorId })).taskId);
    expect(
      (await cache.notes(creatorId, { creatorId, dateStart: '2025-01-01' }))
        .items,
    ).toHaveLength(0);
    await finish(
      (await service.downloadNotes({ creatorId, noteIds: [noteKey('note-a')] }))
        .taskId,
    );
    expect(
      (
        await cache.notes(creatorId, {
          creatorId,
          search: '检索正文',
          dateStart: '2025-10-09',
          dateEnd: '2025-10-09',
        })
      ).items,
    ).toHaveLength(1);
    expect(
      (await cache.notes(creatorId, { creatorId, search: 'unmatched' })).items,
    ).toHaveLength(0);
    expect(
      xhsNoteFilterSchema.safeParse({ creatorId, dateStart: '2025-02-30' })
        .success,
    ).toBe(false);
    expect(
      xhsNoteFilterSchema.safeParse({
        creatorId,
        dateStart: '2025-10-10',
        dateEnd: '2025-10-09',
      }).success,
    ).toBe(false);
  });
  it('rolls back a mismatched author page without downgrading old complete content', async () => {
    await finish((await service.refresh({ id: creatorId })).taskId);
    await finish(
      (await service.downloadNotes({ creatorId, noteIds: [noteKey('note-a')] }))
        .taskId,
    );
    const old = await db.xhsNote.findMany();
    (source.list as jest.Mock).mockResolvedValue({
      authorId: author.id,
      nextCursor: null,
      notes: [
        {
          noteId: 'first',
          authorId: author.id,
          title: '',
          publishedAt: 0,
          kind: 'image-text',
        },
        {
          noteId: 'foreign',
          authorId: 'foreign',
          title: '',
          publishedAt: 0,
          kind: 'image-text',
        },
      ],
    });
    expect(
      await finish((await service.refresh({ id: creatorId })).taskId),
    ).toMatchObject({ state: 'blocked', total: 0, completed: 0 });
    expect(await db.xhsNote.findMany()).toEqual(old);
  });
});

describe('Redbook split adapter', () => {
  it('upgrades allowlisted CDN images to HTTPS and rejects non-CDN sources', () => {
    expect(
      allowedRedbookMediaUrl('http://sns-webpic-qc.xhscdn.com/synthetic.jpg')
        .href,
    ).toBe('https://sns-webpic-qc.xhscdn.com/synthetic.jpg');
    expect(() =>
      allowedRedbookMediaUrl('http://127.0.0.1/synthetic.jpg'),
    ).toThrow();
    expect(() =>
      allowedRedbookMediaUrl(
        'http://sns-webpic-qc.xhscdn.com:80/synthetic.jpg',
      ),
    ).toThrow();
  });
  it('requires verified profile and performs zero media/detail calls during profile/list actions', async () => {
    const client = {
      getUserInfo: jest.fn(async () => ({
        schema: 'synthetic-reviewed',
        author,
      })),
      getUserNotes: jest.fn(async () => ({
        notes: [
          {
            note_id: 'note-a',
            user: { user_id: author.id },
            xsec_token: 'synthetic-secret',
            display_title: '列表',
          },
        ],
        has_more: false,
        cursor: '',
      })),
      getNoteById: jest.fn(),
    };
    const profile = jest.fn((raw: any, expected: string) => {
        if (raw.schema !== 'synthetic-reviewed' || raw.author.id !== expected)
          throw Error('synthetic invalid schema');
        return raw.author;
      }),
      media = jest.fn();
    const adapter = new RedbookSubscriptionAdapter(
      client,
      { profileParser: profile },
      media,
    );
    expect(await adapter.resolve(author.profileUrl)).toEqual({
      inputKind: 'profile',
      author,
    });
    expect(await adapter.list(author.id, null)).toMatchObject({
      notes: [{ noteId: 'note-a', title: '列表', publishedAt: 0 }],
    });
    expect(JSON.stringify(await adapter.list(author.id, null))).not.toContain(
      'synthetic-secret',
    );
    expect(client.getNoteById).not.toHaveBeenCalled();
    expect(media).not.toHaveBeenCalled();
    await expect(
      new RedbookSubscriptionAdapter(client, {
        profileParser: () => ({
          ...author,
          id: 'foreign',
        }),
      }).resolve(author.profileUrl),
    ).rejects.toThrow('XHS_AUTHOR_MISMATCH');
  });
  it.each([
    'http://www.xiaohongshu.com/explore/a',
    'https://evil.test/explore/a',
    'https://www.xiaohongshu.com@evil.test/explore/a',
    'https://www.xiaohongshu.com/explore/a#token',
  ])('rejects noncanonical links: %s', (url) =>
    expect(() => subscriptionUrl(url)).toThrow(),
  );
});
