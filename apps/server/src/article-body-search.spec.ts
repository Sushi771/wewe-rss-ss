import { PrismaClient } from '@prisma/client';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  visibleBodyText,
  prepareBodySearch,
  findBodySearchIds,
  bodySearchSummary,
  searchSnippet,
  bodySearchCoverage,
} from './article-body-search';
import { ArticleSchemas, shanghaiDayStart } from '@wewe-rss/shared';
import { TrpcRouter } from './trpc/trpc.router';
import { TrpcService } from './trpc/trpc.service';
import { splitSqliteStatements } from '../../../scripts/sqlite-statements.cjs';
describe('local body search on actual Prisma SQLite', () => {
  let p: PrismaClient, root: string;
  const day = shanghaiDayStart('2026-01-02')!;
  const ids = async (search: string, extra: any = {}) =>
    (await findBodySearchIds(p, { search, ...extra }, 100)).map((x) => x.id);
  const prepare = async () => {
    for (let n = 0; n < 100; n++) {
      if (!(await prepareBodySearch(p)).pending) return;
    }
    throw Error('index did not finish');
  };
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'wewe-search-test-'));
    p = new PrismaClient({
      datasources: {
        db: { url: 'file:' + join(root, 'test.db').replace(/\\/g, '/') },
      },
    });
    for (const dir of readdirSync(resolve(__dirname, '../prisma/migrations'))
      .filter((x) => /^\d/.test(x))
      .sort())
      for (const statement of splitSqliteStatements(
        readFileSync(
          resolve(__dirname, '../prisma/migrations', dir, 'migration.sql'),
          'utf8',
        ),
      ))
        if (statement.trim()) await p.$executeRawUnsafe(statement);
    await p.managementGroup.create({
      data: { id: 'g', name: 'group', platform: 'wechat' },
    });
    for (const id of ['a', 'b'])
      await p.feed.create({
        data: {
          id,
          mpName: id === 'a' ? '甲公众号' : '乙100%',
          mpCover: '',
          mpIntro: '',
          updateTime: 0,
          groupId: id === 'a' ? 'g' : null,
        },
      });
  });
  afterAll(async () => {
    await p?.$disconnect();
    if (root) rmSync(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await p.article.deleteMany();
  });
  const add = (
    id: string,
    body: string | null,
    title = '普通标题',
    mpId = 'a',
  ) =>
    p.article.create({
      data: {
        id,
        mpId,
        title,
        picUrl: '',
        publishTime: day,
        contentHtml: body,
      },
    });
  it('indexes visible Chinese single/double words, entities and literal punctuation; no HTML/media metadata', async () => {
    await add(
      'body',
      '<p>中文短词，100% one_two A&amp;B &lt;img src=x onerror=alert(1)&gt;</p><script>秘密脚本</script><span hidden>隐藏词</span><img alt="图属性词" src="data:image/png;base64,隐秘载荷">',
    );
    await add('title', null, '未缓存正文标题');
    await prepare();
    for (const term of ['中', '中文', '短词', '，', '100%', '_', 'A&B'])
      expect(await ids(term)).toEqual(['body']);
    for (const term of [
      '秘密脚本',
      '隐藏词',
      '图属性词',
      '隐秘载荷',
      "' OR 1=1 --",
      '%x',
    ])
      expect(await ids(term)).toEqual([]);
    expect(await ids('未缓存正文标题')).toEqual(['title']);
    expect(visibleBodyText('<p>一&amp;二</p><p>三<br>四</p>')).toBe(
      '一&二 三 四',
    );
    expect(
      searchSnippet('安全 <img onerror=alert(1)> 内容', '<img'),
    ).toMatchObject({ match: '<img' });
    expect(await bodySearchCoverage(p)).toMatchObject({
      total: 2,
      pending: 0,
      uncached: 1,
      indexed: 2,
    });
  });
  it('invalidates raw/provider body updates atomically, preserves title matches, and resumes after restart', async () => {
    await add('x', '<p>旧正文独词</p>', '稳定标题');
    await prepare();
    expect(await ids('旧正文')).toEqual(['x']);
    await p.$executeRaw`UPDATE articles SET content_html=${'<p>新正文独词</p>'} WHERE id=${'x'}`;
    expect(await ids('旧正文')).toEqual([]);
    expect(await ids('稳定标题')).toEqual(['x']);
    expect((await bodySearchCoverage(p)).pending).toBe(1);
    await p.$disconnect();
    await p.$connect();
    await prepare();
    expect(await ids('新正文')).toEqual(['x']);
    const stale = await p.articleSearchDocument.findUniqueOrThrow({
      where: { articleId: 'x' },
    });
    await p.article.update({
      where: { id: 'x' },
      data: { contentHtml: '<p>第三次</p>' },
    });
    expect(
      (
        await p.articleSearchDocument.updateMany({
          where: { articleId: 'x', generation: stale.generation },
          data: { bodyText: 'stale', pending: false },
        })
      ).count,
    ).toBe(0);
    await expect(
      p.$transaction(async (tx) => {
        await tx.article.update({
          where: { id: 'x' },
          data: { contentHtml: '回滚词' },
        });
        throw Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    await prepare();
    expect(await ids('回滚词')).toEqual([]);
    expect(await ids('第三次')).toEqual(['x']);
    await p.article.delete({ where: { id: 'x' } });
    expect(await p.articleSearchDocument.count()).toBe(0);
    expect(await ids('第三次')).toEqual([]);
  });
  it('rejects an in-flight batch after delete and recreate with the same article ID', async () => {
    await add('recreated', '<p>旧生命周期独有词</p>', '生命周期标题');
    let reached!: () => void;
    let resume!: () => void;
    const captured = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const released = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let hold = true;
    p.$use(async (params, next) => {
      const result = await next(params);
      if (
        hold &&
        params.model === 'ArticleSearchDocument' &&
        params.action === 'findMany'
      ) {
        hold = false;
        reached();
        await released;
      }
      return result;
    });
    const inFlight = prepareBodySearch(p);
    try {
      await captured;
      await p.article.delete({ where: { id: 'recreated' } });
      await p.article.upsert({
        where: { id: 'recreated' },
        update: { contentHtml: '<p>新生命周期独有词</p>' },
        create: {
          id: 'recreated',
          mpId: 'a',
          title: '生命周期标题',
          picUrl: '',
          publishTime: day,
          contentHtml: '<p>新生命周期独有词</p>',
        },
      });
      expect(
        (
          await p.articleSearchDocument.findUniqueOrThrow({
            where: { articleId: 'recreated' },
          })
        ).generation,
      ).toBe(0);
    } finally {
      resume();
    }
    expect(await inFlight).toMatchObject({ total: 1, pending: 1, indexed: 0 });
    expect(
      await p.articleSearchDocument.findUniqueOrThrow({
        where: { articleId: 'recreated' },
      }),
    ).toMatchObject({ pending: true, bodyText: '' });
    expect(await ids('旧生命周期独有词')).toEqual([]);
    await prepare();
    expect(await ids('新生命周期独有词')).toEqual(['recreated']);
    expect(await ids('旧生命周期独有词')).toEqual([]);
  });
  it('covers nested inserts, bulk nulling, raw deletes and feed cascades without a Prisma hook', async () => {
    await p.feed.update({
      where: { id: 'a' },
      data: {
        articles: {
          create: [
            {
              id: 'nested',
              title: 'nested',
              picUrl: '',
              publishTime: day,
              contentHtml: '嵌套正文',
            },
          ],
        },
      },
    });
    await prepare();
    expect(await ids('嵌套')).toEqual(['nested']);
    await p.article.updateMany({ data: { contentHtml: null } });
    expect(await ids('嵌套')).toEqual([]);
    await prepare();
    await p.$executeRaw`DELETE FROM articles WHERE id=${'nested'}`;
    expect(await p.articleSearchDocument.count()).toBe(0);
    await add('cascade', '正文', 'title', 'b');
    await prepare();
    await p.feed.delete({ where: { id: 'b' } });
    expect(await p.articleSearchDocument.count()).toBe(0);
  });
  it('keeps filters, unseen-cursor pagination, metrics and actual route summaries consistent', async () => {
    for (let i = 0; i < 8; i++)
      await add(
        'id-' + i,
        '<p>匹配正文</p>',
        i === 0 ? '标题命中' : 'ordinary',
        i % 2 ? 'a' : 'b',
      ).catch(async (e) => {
        if (i === 0) {
          await p.feed.create({
            data: {
              id: 'b',
              mpName: '乙100%',
              mpCover: '',
              mpIntro: '',
              updateTime: 0,
            },
          });
          return add('id-' + i, '<p>匹配正文</p>', 'ordinary', 'b');
        }
        throw e;
      });
    await prepare();
    const config = {
      get: (key: string) =>
        key === 'platform' ? { url: '' } : { updateDelayTime: 0 },
    } as any;
    const router = new TrpcRouter(
      new TrpcService(p as any, config, {} as any, {} as any),
      p as any,
      config,
      {} as any,
      {} as any,
    ).appRouter.createCaller({ errorMsg: null, isLocal: true });
    const input = {
      search: '匹配',
      group: 'g',
      dateStart: '2026-01-02',
      dateEnd: '2026-01-02',
      direction: 'asc' as const,
      limit: 2,
    };
    const first = await router.article.list(input);
    expect(first.items.map((x) => x.id)).toEqual(['id-1', 'id-3']);
    expect(first.nextCursor).toBe('id-5');
    expect(first.items[0].searchSnippet?.match).toBe('匹配');
    const second = await router.article.list({
      ...input,
      cursor: first.nextCursor,
    });
    expect(second.items.map((x) => x.id)).toEqual(['id-5', 'id-7']);
    expect(second.nextCursor).toBeUndefined();
    const summary = await router.article.summary(input);
    expect(summary.articles).toBe(4);
    expect(() => JSON.stringify(summary)).not.toThrow();
    expect(
      (await bodySearchSummary(p, { search: '匹配', dateStart: '2026-01-03' }))
        .articles,
    ).toBe(0);
    expect(await ids('100%')).toEqual(['id-6', 'id-4', 'id-2', 'id-0']);
    expect(await ids('匹配', { cursor: 'absent' })).toEqual([]);
  });
  it('keeps metric cursors inclusive across ties and NULL metrics', async () => {
    for (const [id, readCount] of [
      ['a', null],
      ['b', 2],
      ['c', 2],
      ['d', 0],
    ] as const) {
      await add(id, '游标正文');
      await p.article.update({ where: { id }, data: { readCount } });
    }
    await prepare();
    expect(await ids('游标', { sort: 'readCount', direction: 'asc' })).toEqual([
      'c',
      'b',
      'd',
      'a',
    ]);
    expect(await ids('游标', { sort: 'readCount', cursor: 'b' })).toEqual([
      'b',
      'd',
      'a',
    ]);
    expect(await ids('游标', { sort: 'readCount', cursor: 'a' })).toEqual([
      'a',
    ]);
  });
  it('rejects oversized/NUL input and leaves SQL/FTS syntax as literal text', () => {
    expect(
      ArticleSchemas.list.safeParse({ search: 'a'.repeat(201) }).success,
    ).toBe(false);
    expect(ArticleSchemas.list.safeParse({ search: 'a\0b' }).success).toBe(
      false,
    );
    expect(
      ArticleSchemas.list.safeParse({ search: '" OR % _ --' }).success,
    ).toBe(true);
  });
});
