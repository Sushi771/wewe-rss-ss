import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { PrismaClient } from '@prisma/client';
import { splitSqliteStatements } from '../../../../scripts/sqlite-statements.cjs';
import {
  mapXhsComments,
  xhsExactCount,
  xhsNoteMetrics,
  xhsProfileMetrics,
} from './xhs-engagement-contract';
import {
  readXhsComments,
  saveCommentPage,
  saveXhsMetrics,
  readXhsMetrics,
} from './xhs-engagement-store';
import { XhsEngagementService } from './xhs-engagement.service';
import { XiaohongshuService } from './xiaohongshu.service';
import { xhsMetricSelection, xhsNoteFilterSchema } from '@wewe-rss/shared';
import { xhsEngagementMarkdown } from './xhs-engagement-export';
import { RedbookPauseError } from './redbook-client';
import { XhsSubscriptionService } from './xhs-subscription.service';
import { mapRedbookDetail } from './redbook-response';

const key = (id: string) => JSON.stringify(['xiaohongshu', 'note', id]);
const rawComment = (id: string, content = 'text') => ({
  id,
  content,
  like_count: '0',
  user_info: { user_id: 'author', nickname: 'Synthetic' },
});
const page = (id: string, next: string | null) =>
  mapXhsComments({
    comments: [rawComment(id)],
    has_more: next !== null,
    cursor: next ?? '',
  });
describe('XHS metric contract: public source only, no real requests', () => {
  it.each([
    null,
    undefined,
    '',
    '1.2万',
    '1,000',
    '-1',
    '1.0',
    '01',
    true,
    NaN,
    -1,
    1.2,
    Number.MAX_SAFE_INTEGER + 1,
  ])('keeps unavailable/inexact %p unknown', (v) =>
    expect(xhsExactCount(v)).toBeNull(),
  );
  it('separates zero from missing; following is unverified and no derived sum', () => {
    expect(
      xhsNoteMetrics(
        {
          interact_info: {
            liked_count: '0',
            collected_count: '12',
            share_count: '1.2万',
          },
        },
        42,
      ).values,
    ).toEqual({ likes: 0, collects: 12, shares: null, comments: null });
    expect(
      xhsProfileMetrics({
        interactions: [
          { type: 'fans', count: '0' },
          { type: 'following', count: '12' },
        ],
      }).values,
    ).toEqual({ fans: 0, following: null });
  });
  it('rejects malformed and cycling identities instead of inventing IDs/parents', () => {
    expect(() =>
      mapXhsComments({
        comments: [{ content: 'missing id' }],
        has_more: false,
      }),
    ).toThrow('XHS_COMMENT_ID_UNVERIFIED');
    expect(() =>
      mapXhsComments({ comments: [], has_more: true, cursor: '' }),
    ).toThrow('XHS_COMMENT_CURSOR_INVALID');
    const mapped = mapXhsComments({
      comments: [
        { ...rawComment('root'), sub_comments: [rawComment('child')] },
      ],
      has_more: false,
    });
    expect(mapped.comments[1]).toMatchObject({
      rootId: 'root',
      parentId: null,
      publishedAt: null,
      likes: 0,
    });
    expect(() =>
      mapXhsComments(
        { comments: [rawComment('root')], has_more: false },
        'root',
      ),
    ).toThrow('XHS_COMMENT_RELATION_INVALID');
  });
  it('sorts null last in both directions and rejects inverted ranges', () => {
    const rows = [null, 0, 50, 50].map((n, i) => ({
      id: String(i),
      metrics: xhsNoteMetrics({ interact_info: { liked_count: n } }),
    }));
    expect(
      xhsMetricSelection(rows, { metric: 'likes', metricDirection: 'asc' }).map(
        (r) => r.id,
      ),
    ).toEqual(['1', '2', '3', '0']);
    expect(
      xhsMetricSelection(rows, {
        metric: 'likes',
        metricDirection: 'desc',
        min: 0,
        max: 50,
      }).map((r) => r.id),
    ).toEqual(['2', '3', '1']);
    expect(
      xhsNoteFilterSchema.safeParse({ metric: 'likes', min: 5, max: 1 })
        .success,
    ).toBe(false);
  });
});

describe('XHS additive migration/persistence/pagination/export on synthetic SQLite', () => {
  let root: string, db: PrismaClient, old: unknown;
  const creator = 'creator',
    note = key('note');
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'xhs-engagement-synthetic-'));
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
      if (
        !(await fs.stat(path.join(migrations, name))).isDirectory() ||
        name === '20261025090000_xhs_engagement'
      )
        continue;
      const sql = await fs.readFile(
        path.join(migrations, name, 'migration.sql'),
        'utf8',
      );
      for (const s of splitSqliteStatements(sql)
        .map((s) => s.trim())
        .filter(Boolean))
        await db.$executeRawUnsafe(s);
    }
    await db.feed.create({
      data: {
        id: 'wechat',
        mpName: 'Wechat retained',
        mpCover: '',
        mpIntro: 'private notes synthetic',
        updateTime: 1,
      },
    });
    await db.article.create({
      data: {
        id: 'wechat-article',
        mpId: 'wechat',
        title: 'handwritten',
        picUrl: '',
        publishTime: 1,
        contentHtml: '<p>preserve me</p>',
        metrics: '{"likes":9}',
      },
    });
    old = {
      feeds: await db.feed.findMany(),
      articles: await db.article.findMany(),
    };
    const sql = await fs.readFile(
      path.join(migrations, '20261025090000_xhs_engagement/migration.sql'),
      'utf8',
    );
    for (const s of splitSqliteStatements(sql)
      .map((s) => s.trim())
      .filter(Boolean))
      await db.$executeRawUnsafe(s);
    await db.$executeRawUnsafe('PRAGMA synchronous = FULL');
    await db.xhsCreator.create({
      data: {
        id: creator,
        displayName: 'Synthetic creator',
        profileUrl: 'https://www.xiaohongshu.com/user/profile/author',
        externalAuthorId: 'author',
      },
    });
    for (let i = 0; i < 25; i++) {
      const id = i === 0 ? note : key(`note-${i}`);
      await db.xhsNote.create({
        data: {
          id,
          creatorId: creator,
          title: `Synthetic ${i}`,
          publishTime: 100 + i,
          status: 'complete',
          contentHtml: '<div id="js_content"><p>body</p></div>',
        },
      });
      if (i !== 24)
        await saveXhsMetrics(
          db,
          'note',
          id,
          xhsNoteMetrics(
            { interact_info: { liked_count: i, collected_count: '0' } },
            i + 1,
          ),
        );
    }
  }, 30000);
  afterAll(async () => {
    await db?.$disconnect();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await db.$executeRaw`DELETE FROM xhs_saved_comments`;
    await db.$executeRaw`DELETE FROM xhs_comment_windows`;
  });
  it('preserves all WeChat rows; old generated Prisma client still reads/writes after migration', async () => {
    expect({
      feeds: await db.feed.findMany(),
      articles: await db.article.findMany(),
    }).toEqual(old);
    await db.article.update({
      where: { id: 'wechat-article' },
      data: { title: 'handwritten' },
    });
    expect(await db.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual([]);
  });
  it('updates exact metric snapshots while refusing older overwrite', async () => {
    await saveXhsMetrics(
      db,
      'note',
      note,
      xhsNoteMetrics({ interact_info: { liked_count: '0' } }, 200),
    );
    await saveXhsMetrics(
      db,
      'note',
      note,
      xhsNoteMetrics({ interact_info: { liked_count: 99 } }, 100),
    );
    expect((await readXhsMetrics(db, 'note')).get(note)?.values.likes).toBe(0);
  });
  it('carries existing profile/detail responses through subscription transactions without extra source calls or handwritten overwrite', async () => {
    const profileMetrics = xhsProfileMetrics(
      { interactions: [{ type: 'fans', count: '0' }] },
      300,
    );
    const detail = await mapRedbookDetail(
      {
        items: [
          {
            id: 'note',
            note_card: {
              note_id: 'note',
              user: { user_id: 'author' },
              type: 'normal',
              title: 'Fetched',
              desc: 'Fetched body',
              time: 1760000000000,
              image_list: [],
              interact_info: { liked_count: '19', share_count: '0' },
            },
          },
        ],
      },
      'author',
      'note',
    );
    const source = {
      resolve: async () => ({
        inputKind: 'profile' as const,
        author: {
          id: 'author',
          name: 'Synthetic creator',
          profileUrl: 'https://www.xiaohongshu.com/user/profile/author',
          metrics: profileMetrics,
        },
      }),
      detail: jest.fn(async () => detail),
    };
    const service = new XhsSubscriptionService(db as any, source as any);
    service.bindLocalSaver(
      async () => root,
      async () => ({ alreadySaved: false }),
    );
    const resolved = await service.resolveSubscription({
      url: 'https://www.xiaohongshu.com/user/profile/author',
    });
    await service.subscribe({ resolutionId: resolved.resolutionId });
    expect(
      (await readXhsMetrics(db, 'creator')).get(creator)?.values.fans,
    ).toBe(0);
    await db.xhsNote.update({
      where: { id: note },
      data: { status: 'listed', contentHtml: null },
    });
    const finish = async (taskId: string) => {
      for (let i = 0; i < 500; i++) {
        const task = await service.task({ taskId });
        if (task.state === 'completed') return;
        if (['failed', 'partial', 'blocked'].includes(task.state))
          throw Error(task.code);
        await new Promise((r) => setTimeout(r, 5));
      }
      throw Error('synthetic task timeout');
    };
    await finish(
      (await service.downloadNotes({ creatorId: creator, noteIds: [note] }))
        .taskId,
    );
    expect((await readXhsMetrics(db, 'note')).get(note)?.values).toMatchObject({
      likes: 19,
      shares: 0,
    });
    await db.xhsNote.update({
      where: { id: note },
      data: { contentHtml: '<div id="js_content"><p>handwritten</p></div>' },
    });
    // Wait for the original worker to release its per-creator pending entry.
    for (let i = 0; i < 100 && (service as any).pending.size; i++)
      await new Promise((r) => setTimeout(r, 5));
    await finish(
      (await service.downloadNotes({ creatorId: creator, noteIds: [note] }))
        .taskId,
    );
    expect(source.detail).toHaveBeenCalledTimes(1);
    expect(
      (await db.xhsNote.findUnique({ where: { id: note } }))?.contentHtml,
    ).toContain('handwritten');
    await db.xhsNote.update({
      where: { id: note },
      data: { contentHtml: '<div id="js_content"><p>body</p></div>' },
    });
  });
  it('filters before paging, beyond the initial 20, and selection uses same bounds', async () => {
    const cache = new XiaohongshuService(db as any);
    const result = await cache.notes(creator, {
      metric: 'likes',
      min: 21,
      max: 23,
      metricDirection: 'asc',
      limit: 2,
    });
    expect(result.total).toBe(3);
    expect(result.items.map((r) => r.metrics?.values.likes)).toEqual([21, 22]);
    const next = await cache.notes(creator, {
      metric: 'likes',
      min: 21,
      max: 23,
      metricDirection: 'asc',
      limit: 2,
      offset: 2,
    });
    expect(next.items.map((r) => r.metrics?.values.likes)).toEqual([23]);
    await expect(
      cache.export(creator, [note], { metric: 'likes', min: 21 }),
    ).rejects.toThrow();
  });
  it('commits comments and cursor together; restart resumes without duplicates or replay', async () => {
    const calls: string[] = [];
    const source = {
      comments: async (_a: string, _n: string, cursor: string) => {
        calls.push(cursor);
        return cursor === '' ? page('c1', 'next') : page('c2', null);
      },
    };
    const first = new XhsEngagementService(db as any, source as any);
    await first.collect({
      creatorId: creator,
      noteId: note,
      maxPages: 1,
      maxItems: 200,
    });
    const restart = new XhsEngagementService(db as any, source as any);
    const view = await restart.collect({
      creatorId: creator,
      noteId: note,
      maxPages: 1,
      maxItems: 200,
    });
    expect(calls).toEqual(['', 'next']);
    expect(view.totalSaved).toBe(2);
    expect(view.windows[0].state).toBe('returned-end');
    await restart.collect({
      creatorId: creator,
      noteId: note,
      maxPages: 1,
      maxItems: 200,
    });
    expect(calls).toHaveLength(2);
    await restart.collect({
      creatorId: creator,
      noteId: note,
      maxPages: 2,
      maxItems: 200,
      restart: true,
    });
    expect((await readXhsComments(db, note)).totalSaved).toBe(2);
  });
  it('stops on signature rejection and preserves saved partial results and resume cursor', async () => {
    const source = {
      comments: jest
        .fn()
        .mockResolvedValueOnce(page('one', 'next'))
        .mockRejectedValueOnce(new RedbookPauseError('signature')),
    };
    const service = new XhsEngagementService(db as any, source as any);
    const view = await service.collect({
      creatorId: creator,
      noteId: note,
      maxPages: 5,
      maxItems: 200,
    });
    expect(source.comments).toHaveBeenCalledTimes(2);
    expect(view.totalSaved).toBe(1);
    expect(view.windows[0]).toMatchObject({
      state: 'failed',
      nextCursor: 'next',
      code: 'XHS_SOURCE_SIGNATURE_BLOCKED',
    });
  });
  it('detects cursor cycles and refuses page truncation, preserving the unconsumed cursor', async () => {
    const source = {
      comments: jest
        .fn()
        .mockResolvedValueOnce(page('one', 'same'))
        .mockResolvedValueOnce(page('two', 'same')),
    };
    const service = new XhsEngagementService(db as any, source as any);
    const view = await service.collect({
      creatorId: creator,
      noteId: note,
      maxPages: 5,
      maxItems: 200,
    });
    expect(view.totalSaved).toBe(1);
    expect(view.windows[0].code).toBe('XHS_COMMENT_CURSOR_CYCLE');
    source.comments.mockResolvedValue(
      mapXhsComments({
        comments: [rawComment('a'), rawComment('b')],
        has_more: false,
      }),
    );
    const limit = await service.collect({
      creatorId: creator,
      noteId: note,
      maxPages: 5,
      maxItems: 1,
      restart: true,
    });
    expect(limit.totalSaved).toBe(1);
    expect(limit.windows[0]).toMatchObject({
      nextCursor: '',
      code: 'XHS_COMMENT_ITEM_LIMIT',
    });
  });
  it('rolls back wrong root reassignment and rejected transaction without advancing cursor', async () => {
    const window = {
      scope: 'top',
      nextCursor: 'next',
      pages: 1,
      state: 'partial' as const,
      code: null,
      collectedAt: 1,
      cursors: [''],
    };
    await db.$transaction((tx) =>
      saveCommentPage(tx, note, page('root', 'next').comments, window),
    );
    const conflicting = {
      ...page('root', null).comments[0],
      rootId: 'another',
    };
    await expect(
      db.$transaction((tx) =>
        saveCommentPage(tx, note, [conflicting], {
          ...window,
          nextCursor: null,
          pages: 2,
        }),
      ),
    ).rejects.toThrow('XHS_COMMENT_RELATION_CONFLICT');
    await expect(
      db.$transaction(async (tx) => {
        await saveCommentPage(tx, note, page('child', null).comments, window);
        throw Error('interrupt');
      }),
    ).rejects.toThrow('interrupt');
    const view = await readXhsComments(db, note);
    expect(view.totalSaved).toBe(1);
    expect(view.windows[0].nextCursor).toBe('next');
  });
  it('exports saved scope after body with escaped content, counts, timestamps and root grouping', async () => {
    const mapped = mapXhsComments({
      comments: [
        {
          ...rawComment('root', '<script>hi</script>'),
          sub_comments: [rawComment('child', 'reply')],
        },
      ],
      has_more: false,
    });
    await db.$transaction((tx) =>
      saveCommentPage(tx, note, mapped.comments, {
        scope: 'top',
        nextCursor: null,
        pages: 1,
        state: 'returned-end',
        code: null,
        collectedAt: 42,
        cursors: [''],
      }),
    );
    const cache = new XiaohongshuService(db as any);
    const view = await cache.engagement({ creatorId: creator, noteId: note });
    const md = xhsEngagementMarkdown(view);
    expect(md).toContain('保存 2 条');
    expect(md).toContain('精确回复对象未知');
    expect(md).toContain('\\<script\\>');
    expect(md).not.toContain('所有评论已');
    const prepare = await cache.prepareLocalDownload(creator, note);
    const out = path.join(root, 'export');
    await fs.mkdir(out, { recursive: true });
    await prepare(out);
    const saved = await fs.readFile(path.join(out, 'index.md'), 'utf8');
    expect(saved.indexOf('body')).toBeLessThan(saved.indexOf('## 互动快照'));
    expect(saved).toContain('## 已保存评论');
    expect(
      xhsEngagementMarkdown({
        metrics: null,
        creatorMetrics: null,
        comments: [],
        windows: [],
        totalSaved: 0,
        returned: 0,
        offset: 0,
      }),
    ).toBe('');
  });
});
