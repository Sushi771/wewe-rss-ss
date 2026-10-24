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
    for (let i = 0; i < 500; i++) {
      const t = await service.task({ taskId });
      if (!['queued', 'running'].includes(t.state)) return t;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('SYNTHETIC_TASK_TIMEOUT');
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
  it('marks a bounded list window partial and does not dispatch a fourth page', async () => {
    (source.list as jest.Mock).mockImplementation(async (_id, cursor) => ({
      authorId: author.id,
      nextCursor: (cursor ?? '') + 'x',
      notes: [],
    }));
    expect(
      await finish((await service.refresh({ id: creatorId })).taskId),
    ).toMatchObject({ state: 'partial', code: 'XHS_LIST_WINDOW_LIMIT' });
    expect(source.list).toHaveBeenCalledTimes(3);
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
    expect(allowedRedbookMediaUrl('http://sns-webpic-qc.xhscdn.com/synthetic.jpg').href).toBe('https://sns-webpic-qc.xhscdn.com/synthetic.jpg');
    expect(() => allowedRedbookMediaUrl('http://127.0.0.1/synthetic.jpg')).toThrow();
    expect(() => allowedRedbookMediaUrl('http://sns-webpic-qc.xhscdn.com:80/synthetic.jpg')).toThrow();
  });
  it('requires verified profile and performs zero media/detail calls during profile/list actions', async () => {
    const client = {
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
    const profile = jest.fn(async () => author),
      media = jest.fn();
    const adapter = new RedbookSubscriptionAdapter(client, profile, media);
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
      new RedbookSubscriptionAdapter(client, async () => ({
        ...author,
        id: 'foreign',
      })).resolve(author.profileUrl),
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
