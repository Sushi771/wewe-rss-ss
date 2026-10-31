import { spawnSync } from 'node:child_process';
import { LocalArticleStore, ArticlePreparation } from '../article-local-save';
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
import { xhsMetricMarkdown } from './xhs-engagement-export';
import { RedbookPauseError } from './redbook-client';
import { XhsSubscriptionService } from './xhs-subscription.service';
import { mapRedbookDetail } from './redbook-response';
import { RedbookSubscriptionAdapter } from './xhs-redbook-subscription';
import { parseXhsProfile } from './xhs-profile';

// Existing archiver v8 is ESM and Jest runs CJS. Execute the actual unchanged
// offline-archive source in a normal Node child; do not fake archive output.
jest.mock('../offline-archive', () => ({
  archiveDirectory: async (folder: string, destination: string) => {
    const source = path.resolve(__dirname, '../offline-archive.ts');
    const child = spawnSync(
      process.execPath,
      [
        '-e',
        "const fs=require('fs'),ts=require('typescript'),M=require('module'),path=require('path');const file=process.argv[3];const m=new M(file);m.paths=M._nodeModulePaths(path.dirname(file));m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2021,module:ts.ModuleKind.CommonJS}}).outputText,file);m.exports.archiveDirectory(process.argv[1],process.argv[2]).catch(()=>process.exit(1));",
        folder,
        destination,
        source,
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        cwd: path.resolve(__dirname, '../..'),
      },
    );
    if (child.status !== 0) throw new Error('ACTUAL_ARCHIVE_CHILD_FAILED');
  },
}));

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
  it('records only allowlisted field presence, type and exact parse outcome', () => {
    const absent = xhsNoteMetrics({ interact_info: {} }, 1);
    expect(absent.fieldDiagnostics?.collects).toEqual({field:'collected_count',present:false,type:'absent',result:'absent',parsed:null});
    expect(xhsNoteMetrics({}).fieldDiagnostics?.collects).toMatchObject({present:null,result:'absent-container'});
    expect(xhsNoteMetrics({interact_info:'unexpected'}).fieldDiagnostics?.shares).toMatchObject({present:null,result:'invalid-container'});
    const diagnostic = xhsNoteMetrics({interact_info:{collected_count:'0',share_count:'1.2万',token:'synthetic-secret'}},2);
    expect(diagnostic.fieldDiagnostics?.collects).toMatchObject({present:true,type:'string',result:'parsed',parsed:0});
    expect(diagnostic.fieldDiagnostics?.shares).toMatchObject({present:true,type:'string',result:'invalid-format',parsed:null});
    expect(JSON.stringify(diagnostic)).not.toContain('synthetic-secret');
    expect(JSON.stringify(diagnostic)).not.toContain('1.2万');
    expect(xhsNoteMetrics({interact_info:{collected_count:null,share_count:{}}}).fieldDiagnostics).toMatchObject({collects:{result:'null',type:'null'},shares:{result:'invalid-type',type:'object'}});
    expect(xhsNoteMetrics({interact_info:{collected_count:10,share_count:'15'}}).values).toMatchObject({collects:10,shares:15});
  });
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
  let resetPromise: Promise<void> | undefined;
  afterAll(async () => {
    await resetPromise?.catch(() => undefined);
    await db?.$disconnect();
    if (root) await fs.rm(root, { recursive: true, force: true });
  }, 40000);
  beforeEach(() => {
    resetPromise = (async () => {
      await db.$executeRaw`DELETE FROM xhs_saved_comments`;
      await db.$executeRaw`DELETE FROM xhs_comment_windows`;
    })();
    return resetPromise;
  }, 40000);
  afterEach(async () => {
    // A hook deadline is not cancellation. Keep its failure, but join reset
    // before another fixture or final disconnect can use the same connection.
    await resetPromise?.catch(() => undefined);
  }, 40000);
  it('preserves previous exact fields with their timestamps and diagnoses persistence', async () => {
    const id = key('metric-diagnostic');
    await saveXhsMetrics(db,'note',id,xhsNoteMetrics({interact_info:{liked_count:4,collected_count:10,share_count:11,comment_count:5}},100));
    await saveXhsMetrics(db,'note',id,xhsNoteMetrics({interact_info:{liked_count:6,share_count:'1.2万',comment_count:7}},200));
    let saved = (await readXhsMetrics(db,'note')).get(id) as any;
    expect(saved.values).toEqual({likes:6,collects:10,shares:11,comments:7});
    expect(saved.valueCollectedAt).toEqual({likes:200,collects:100,shares:100,comments:200});
    expect(saved.fieldDiagnostics.collects).toMatchObject({result:'absent',persistence:'not-parsed'});
    expect(saved.fieldDiagnostics.shares).toMatchObject({result:'invalid-format',persistence:'not-parsed'});
    const markdown=xhsMetricMarkdown('metrics',saved,{likes:'likes',collects:'collects'});
    expect(markdown).toContain('likes：6（采集于 1970-01-01T00:00:00.200Z）');
    expect(markdown).toContain('collects：10（采集于 1970-01-01T00:00:00.100Z）');
    await saveXhsMetrics(db,'note',id,xhsNoteMetrics({interact_info:{collected_count:'12',share_count:'0'}},300));
    saved = (await readXhsMetrics(db,'note')).get(id) as any;
    expect(saved.values).toEqual({likes:6,collects:12,shares:0,comments:7});
    expect(saved.fieldDiagnostics.collects.persistence).toBe('stored');
    await saveXhsMetrics(db,'note',id,{values:{likes:null,collects:1,shares:null,comments:null},collectedAt:250,contract:'synthetic',evidence:'source-only'});
    saved = (await readXhsMetrics(db,'note')).get(id) as any;
    expect(saved.values).toEqual({likes:6,collects:12,shares:0,comments:7});
    await db.$executeRaw`UPDATE xhs_metric_snapshots SET document=json_set(document,'$.values.collects',NULL) WHERE owner_kind='note' AND owner_id=${id}`;
    saved = (await readXhsMetrics(db,'note')).get(id) as any;
    expect(saved.fieldDiagnostics.collects).toMatchObject({result:'parsed',parsed:12,persistence:'missing'});
  },40000);
  it('segments 20001 saved comments without truncation and protects edited companion pages', async () => {
    const content = '<'.repeat(40);
    await db.$executeRaw`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<20001)
      INSERT INTO xhs_saved_comments(note_id,comment_id,root_id,parent_id,document)
      SELECT ${note},'large-'||n,NULL,NULL,json_object('id','large-'||n,'rootId',NULL,'parentId',NULL,
      'content',${content},'authorId',NULL,'authorName',NULL,'likes',0,'publishedAt',NULL,'collectedAt',1)
      FROM seq`;
    const service = new XiaohongshuService(db as any);
    const parts = await (service as any).exportEngagement(creator, note);
    expect(Array.isArray(parts)).toBe(true);
    expect(
      parts.every((part: string) => Buffer.byteLength(part) < 5_000_000),
    ).toBe(true);
    const all = parts.join('');
    expect(
      new Set(
        [...all.matchAll(/评论ID：large-(\d+)/g)].map((match) => match[1]),
      ).size,
    ).toBe(20001);
    const { xhsLocalSnapshotPublisher } = await import('./xhs-local-snapshot');
    const directory = await fs.mkdtemp(path.join(root, 'large-export-'));
    const saved = { directory, markdownPath: path.join(directory, 'body.md') };
    await fs.writeFile(saved.markdownPath, 'HANDWRITTEN BODY');
    const publish = xhsLocalSnapshotPublisher(note, 'Synthetic large', parts)!;
    await publish(saved);
    const first = (await fs.readdir(directory)).sort();
    expect(first.length).toBe(parts.length + 2);
    await publish(saved);
    expect((await fs.readdir(directory)).sort()).toEqual(first);
    const part = first.find(
      (name) => name.endsWith('.md') && name !== 'body.md',
    )!;
    await fs.writeFile(path.join(directory, part), 'HANDWRITTEN COMPANION');
    await publish(saved);
    expect(await fs.readFile(path.join(directory, part), 'utf8')).toBe(
      'HANDWRITTEN COMPANION',
    );
    expect(await fs.readFile(saved.markdownPath, 'utf8')).toBe(
      'HANDWRITTEN BODY',
    );
  }, 60000);
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
  it('rejects contradictory profile identity through adapter and durable refresh, preserving the old snapshot', async () => {
    const owner = 'identity-regression';
    await db.xhsCreator.create({
      data: {
        id: owner,
        displayName: 'Synthetic identity owner',
        profileUrl: 'https://www.xiaohongshu.com/user/profile/authorA',
        externalAuthorId: 'authorA',
      },
    });
    const old = {
      values: { fans: 7, following: null },
      collectedAt: 1000,
      contract: 'independent-literal',
      evidence: 'source-only' as const,
    };
    await saveXhsMetrics(db, 'creator', owner, old);
    let raw = {
      result: { success: true, code: 0 },
      basic_info: {
        nickname: 'Synthetic profile',
        red_id: 'display-only',
        user_id: 'authorA',
      },
      interactions: [{ type: 'fans', count: '7' }],
    };
    const getUserInfo = jest.fn(async () => raw);
    const parser = jest.fn(parseXhsProfile);
    const adapter = new RedbookSubscriptionAdapter(
      {
        getUserInfo,
        getUserNotes: async () => ({}),
        getNoteById: async () => ({}),
      } as any,
      { profileParser: parser },
    );
    await adapter.resolve(
      'https://www.xiaohongshu.com/user/profile/authorA?xsec_token=synthetic-token&xsec_source=synthetic-source',
    );
    const worker = new XhsEngagementService(db as any, adapter);
    raw = {
      result: { success: true, code: 0 },
      basic_info: {
        nickname: 'Wrong profile',
        red_id: 'display-only',
        user_id: 'otherAuthor',
      },
      interactions: [{ type: 'fans', count: '321' }],
    };
    expect(() => parseXhsProfile(raw, 'authorA')).toThrow(
      'XHS_AUTHOR_MISMATCH',
    );
    await expect(worker.refreshMetrics({ creatorId: owner })).rejects.toThrow(
      'XHS_AUTHOR_MISMATCH',
    );
    expect((await readXhsMetrics(db, 'creator')).get(owner)).toEqual(old);
    expect(parser).toHaveBeenLastCalledWith(raw, 'authorA');
    expect(getUserInfo).toHaveBeenCalledTimes(2);
    raw = { ...raw, result: { success: false, code: -1 } };
    await expect(worker.refreshMetrics({ creatorId: owner })).rejects.toThrow(
      'XHS_PROFILE_SCHEMA_UNRECOGNIZED',
    );
    expect((await readXhsMetrics(db, 'creator')).get(owner)).toEqual(old);
    raw = {
      ...raw,
      result: { success: true, code: 0 },
      basic_info: { ...raw.basic_info, user_id: 'authorA' },
      interactions: [{ type: 'fans', count: '0' }],
    };
    expect((await worker.refreshMetrics({ creatorId: owner })).values).toEqual({
      fans: 0,
      following: null,
    });
    expect((await readXhsMetrics(db, 'creator')).get(owner)?.values.fans).toBe(
      0,
    );
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
    // This fixture exercises the manual saver and has no list adapter; let the
    // automatic cache task settle before using the same creator.
    await (service as any).lane;
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
      queryVersion: result.queryVersion,
    });
    expect(next.items.map((r) => r.metrics?.values.likes)).toEqual([23]);
    await saveXhsMetrics(
      db,
      'note',
      key('note-24'),
      xhsNoteMetrics({ interact_info: { liked_count: 22 } }, Date.now()),
    );
    await expect(
      cache.notes(creator, {
        metric: 'likes',
        min: 21,
        max: 23,
        limit: 2,
        offset: 2,
        queryVersion: result.queryVersion,
      }),
    ).rejects.toThrow('XHS_QUERY_STALE_RESTART');
    await db.$executeRaw`DELETE FROM xhs_metric_snapshots WHERE owner_kind='note' AND owner_id=${key('note-24')}`;
    await expect(
      cache.export(creator, [note], { metric: 'likes', min: 21 }),
    ).rejects.toThrow();
  });
  it('uses one confirmed version for exact selected ZIP IDs and actual local companion updates', async () => {
    const cache = new XiaohongshuService(db as any);
    const scope = await cache.notes(creator, {
      metric: 'likes',
      min: 21,
      max: 23,
    });
    const filter = {
      metric: 'likes' as const,
      min: 21,
      max: 23,
      queryVersion: scope.queryVersion,
    };
    const id = key('note-22');
    const output = path.join(root, 'combined-local');
    const store = new LocalArticleStore(
      path.join(root, 'combined-settings.json'),
      output,
    );
    const save = async () => {
      const prepare = await cache.prepareLocalDownload(creator, id);
      const wrapped: ArticlePreparation = async (stage) => ({
        ...(await prepare(stage)),
        exportSource: { feedId: creator, feedName: 'Synthetic creator' },
      });
      wrapped.afterSave = prepare.afterSave;
      return store.save(wrapped, new Date('2026-10-25T00:00:00Z'), output);
    };
    const commentWindow = {
      scope: 'top',
      nextCursor: null,
      pages: 1,
      state: 'returned-end' as const,
      code: null,
      collectedAt: 1000,
      cursors: [''],
    };
    await db.$transaction((tx) =>
      saveCommentPage(tx, id, page('A', null).comments, commentWindow),
    );
    const first = await save();
    await fs.appendFile(first.markdownPath, '\nUSER EDIT\n');
    await fs.appendFile(first.supplement!.path, '\nCOMPANION USER EDIT\n');
    const body = await fs.readFile(first.markdownPath),
      companion = await fs.readFile(first.supplement!.path);
    await db.$transaction((tx) =>
      saveCommentPage(tx, id, page('B', null).comments, {
        ...commentWindow,
        collectedAt: 2000,
      }),
    );
    const second = await save();
    expect(second.alreadySaved).toBe(true);
    expect(second.supplement?.path).not.toBe(first.supplement?.path);
    expect(await fs.readFile(first.markdownPath)).toEqual(body);
    expect(await fs.readFile(first.supplement!.path)).toEqual(companion);
    expect(await fs.readFile(second.supplement!.path, 'utf8')).toContain(
      '保存 2 条',
    );
    expect((await save()).supplement?.status).toBe('retained');
    const zip = await cache.export(creator, [id], filter);
    const file = path.join(root, 'combined.zip');
    await fs.writeFile(file, Buffer.from(zip.base64, 'base64'));
    const inspected = spawnSync(
      process.env.XHS_TEST_PYTHON ||
        (process.platform === 'win32' ? 'python' : 'python3'),
      [
        '-c',
        "import zipfile,sys,json;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;md=[n for n in z.namelist() if n.endswith('.md')];main=[n for n in md if len(n.split('/')[-1])==27][0];s=z.read(main).decode();print(json.dumps({'md':len(md),'canonical':s.count('https://www.xiaohongshu.com/explore/note-22'),'titles':sum(x.startswith('# ') for x in s.splitlines()),'comments':any('保存 2 条' in z.read(n).decode() for n in md)}))",
        file,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    expect(inspected.status).toBe(0);
    expect(JSON.parse(inspected.stdout)).toEqual({
      md: 2,
      canonical: 1,
      titles: 1,
      comments: true,
    });
    await saveXhsMetrics(
      db,
      'note',
      id,
      xhsNoteMetrics({ interact_info: { liked_count: 0 } }, Date.now()),
    );
    await expect(cache.export(creator, [id], filter)).rejects.toThrow(
      'XHS_QUERY_STALE_RESTART',
    );
    await saveXhsMetrics(
      db,
      'note',
      id,
      xhsNoteMetrics({ interact_info: { liked_count: 22 } }, Date.now() + 1),
    );
  }, 20000);
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
