import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import * as http from 'node:http';
import https from 'node:https';
import { AddressInfo } from 'node:net';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import request from 'supertest';
import { TrpcModule } from '../trpc/trpc.module';
import { TrpcRouter } from '../trpc/trpc.router';
import { PrismaService } from '../prisma/prisma.service';
import { WereadService } from '../weread/weread.service';
import { CollectionService } from './collection.service';
import { RedbookRuntime } from './redbook-runtime';
import { ArticleDownloadController } from '../article-download.controller';
import * as picker from '../article-folder-picker';
import { privateAccessGuard } from '../private-access';

// Fixed, distinct 1x1 PNG bytes. No platform response or production data is used.
const images = [
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
    'base64',
  ),
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ),
];
const authorId = 'delivery-fixture-author';
const noteId = 'delivery-fixture-note';
const profileUrl = `https://www.xiaohongshu.com/user/profile/${authorId}`;
const noteKey = JSON.stringify(['xiaohongshu', 'note', noteId]);
const mediaUrls = [
  'https://sns-webpic-qc.xhscdn.com/delivery-first',
  'https://sns-webpic-qc.xhscdn.com/delivery-second',
];
const apiList = {
  notes: [
    {
      note_id: noteId,
      user: { user_id: authorId },
      xsec_token: 'fake-note-token',
    },
  ],
  cursor: '',
  has_more: false,
};
const apiDetail = {
  items: [
    {
      id: noteId,
      note_card: {
        note_id: noteId,
        user: { user_id: authorId },
        type: 'normal',
        time: 1700000000123,
        title: 'Synthetic delivery title',
        desc: 'Synthetic whole caption\nSecond paragraph <kept as text>.',
        image_list: mediaUrls.map((url_default) => ({ url_default })),
      },
    },
  ],
};
// Independent operator reference: never copied from diagnostic sample/response.
const operatorReview = {
  authorIdentityChecked: true,
  fullTextChecked: true,
  allImagesChecked: true,
  publicationTimeChecked: true,
  allowFutureArchive: true,
  observedText: 'Synthetic whole caption\nSecond paragraph <kept as text>.',
  observedImageCount: 2,
  publishedAt: 1700000000,
};

describe('WeWe manual Redbook delivery through actual HTTP routes (synthetic loopback only)', () => {
  let root: string;
  let vault: string;
  let prisma: PrismaClient;
  let app: INestApplication;
  let server: http.Server;
  let bridge: jest.SpyInstance;
  let creatorId: string;
  let upstream: {
    method?: string;
    path: string;
    headers: http.IncomingHttpHeaders;
  }[];
  const oldEnv = { ...process.env };
  const post = (endpoint: string, body: object = {}) =>
    request(app.getHttpServer())
      .post(endpoint)
      .set('host', '127.0.0.1')
      .set('origin', 'http://127.0.0.1')
      .set('authorization', 'synthetic-delivery-access')
      .send(body);
  const query = (name: string, input?: object) =>
    request(app.getHttpServer())
      .get('/trpc/xiaohongshu.' + name)
      .query(input ? { input: JSON.stringify(input) } : {})
      .set('host', '127.0.0.1')
      .set('origin', 'http://127.0.0.1')
      .set('authorization', 'synthetic-delivery-access');
  const management = (name: string, body: object) =>
    post('/trpc/xiaohongshu.' + name, body);
  const diagnostic = (name: string, body: object = {}) =>
    post('/local/redbook/diagnostic/' + name, body);
  const saveBatch = () =>
    post('/download/article/xiaohongshu/save', {
      creatorId,
      noteIds: [noteKey],
    });
  const saveOne = () =>
    post(
      '/download/article/xiaohongshu/' + encodeURIComponent(noteKey) + '/save',
      {
        creatorId,
      },
    );

  beforeAll(async () => {
    // Erase inherited provider/credential settings without reading their values.
    for (const name of Object.keys(process.env))
      if (
        /^(AUTH_CODE|DATABASE_URL|XHS_|REDBOOK_|WEREAD|WECHAT|PRIVATE_ONLINE_|WEWE_ACCEPTANCE_MODE)/.test(
          name,
        )
      )
        delete process.env[name];
    root = await fs.mkdtemp(path.join(tmpdir(), 'redbook-delivery-fixture-'));
    vault = path.join(root, 'synthetic-vault');
    await fs.mkdir(vault);
    const url =
      'file:' + path.join(root, 'synthetic.sqlite').replace(/\\/g, '/');
    process.env.DATABASE_URL = url;
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const migrations = path.resolve(__dirname, '../../prisma/migrations');
    const folders = (await fs.readdir(migrations, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const folder of folders) {
      const sql = await fs.readFile(
        path.join(migrations, folder, 'migration.sql'),
        'utf8',
      );
      for (const statement of sql
        .split(';')
        .map((value) => value.trim())
        .filter(Boolean))
        await prisma.$executeRawUnsafe(statement);
    }
    upstream = [];
    server = http.createServer((req, res) => {
      upstream.push({
        method: req.method,
        path: req.url!,
        headers: req.headers,
      });
      const pathname = new URL(req.url!, 'http://127.0.0.1').pathname;
      if (
        pathname === '/api/sns/web/v2/user_posted' ||
        pathname === '/api/sns/web/v1/feed'
      ) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            success: true,
            code: 0,
            data: pathname.endsWith('user_posted') ? apiList : apiDetail,
          }),
        );
      } else if (
        pathname === '/delivery-first' ||
        pathname === '/delivery-second'
      ) {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(images[pathname === '/delivery-first' ? 0 : 1]);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    // Only the audited HTTPS socket seam is redirected; signing/parsing/storage
    // stay real. A separate process network guard rejects non-loopback sockets.
    bridge = jest.spyOn(https, 'request').mockImplementation(((
      url: URL,
      options: https.RequestOptions,
      callback: (response: http.IncomingMessage) => void,
    ) => {
      const allowed =
        (url.origin === 'https://edith.xiaohongshu.com' &&
          ['/api/sns/web/v2/user_posted', '/api/sns/web/v1/feed'].includes(
            url.pathname,
          )) ||
        mediaUrls.includes(url.href);
      if (!allowed) throw Error('NON_FIXTURE_HTTPS_FORBIDDEN');
      return http.request(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}${url.pathname}${url.search}`,
        options,
        callback,
      );
    }) as typeof https.request);
    jest.spyOn(picker, 'pickArticleDirectory').mockResolvedValue(vault);
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          ignoreEnvVars: true,
          load: [
            () => ({
              auth: { code: 'synthetic-delivery-access' },
              platform: { url: '' },
              feed: { updateDelayTime: 0 },
              server: { host: '127.0.0.1' },
            }),
          ],
        }),
        TrpcModule,
      ],
      controllers: [ArticleDownloadController],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(WereadService)
      .useValue({})
      .overrideProvider(CollectionService)
      .useValue({})
      .compile();
    app = module.createNestApplication();
    app.use(privateAccessGuard);
    await app.get(TrpcRouter).applyMiddleware(app);
    await app.init();
  }, 60000);

  afterAll(async () => {
    jest.useRealTimers();
    await app?.close();
    bridge?.mockRestore();
    jest.restoreAllMocks();
    server?.closeAllConnections();
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma?.$disconnect();
    process.env = oldEnv;
    if (root) {
      if (
        path.dirname(root) !== tmpdir() ||
        !path.basename(root).startsWith('redbook-delivery-fixture-')
      )
        throw Error('UNSAFE_FIXTURE_CLEANUP');
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('keeps pending input/diagnostics separate from reviewed manual refresh and preserves cached local exports across days', async () => {
    const capability = await query('capability');
    expect(capability.status).toBe(200);
    expect(capability.body.result.data).toMatchObject({
      sourceConfigured: false,
      canRefresh: false,
    });
    const added = await management('add', {
      displayName: 'Synthetic author',
      profileUrl,
    });
    expect(added.status).toBe(200);
    expect(added.body.result.data).toMatchObject({
      created: true,
      subscribed: false,
    });
    creatorId = added.body.result.data.creator.id;
    expect(added.body.result.data.creator.externalAuthorId).toBeNull();
    expect(
      (await management('refresh', { id: creatorId })).body.result.data.status,
    ).toBe('unconfigured');
    expect(await prisma.xhsNote.count()).toBe(0);
    expect(upstream).toHaveLength(0);
    const group = await management('saveGroup', { name: 'Synthetic group' });
    expect(group.status).toBe(200);
    const groupId = group.body.result.data.id;
    expect(
      (await management('moveCreators', { ids: [creatorId], groupId })).status,
    ).toBe(200);

    const opened = await diagnostic('session', {
      creatorId,
      cookies: {
        a1: 'synthetic-only-a1',
        web_session: 'synthetic-only-session',
      },
      expiresAt: Date.now() + 600000,
      confirmLocalSession: true,
    });
    expect(opened.status).toBe(201);
    expect(opened.body).toMatchObject({
      reviewed: false,
      archiveAllowed: false,
      phase: 'ready',
      listRequests: 0,
      detailRequests: 0,
      imageRequests: 0,
    });
    expect(app.get(RedbookRuntime).configured).toBe(false);
    expect(upstream).toHaveLength(0);
    for (const [action, body] of [
      ['list', {}],
      ['detail', { noteId }],
      ['images', { maxImages: 2, maxBytes: 1024 }],
    ] as const)
      expect((await diagnostic(action, body)).status).toBe(422);
    expect(upstream).toHaveLength(0);
    expect((await diagnostic('list', { confirmRequest: true })).status).toBe(
      201,
    );
    expect(upstream).toHaveLength(1);
    expect(
      (await diagnostic('detail', { confirmRequest: true, noteId })).status,
    ).toBe(201);
    expect(upstream).toHaveLength(2);
    let sample = await diagnostic('sample');
    expect(sample.body).toMatchObject({
      reviewed: false,
      archiveAllowed: false,
      images: [],
      imageRequests: 0,
    });
    expect(
      (
        await diagnostic('images', {
          confirmImages: true,
          maxImages: 2,
          maxBytes: 1024,
        })
      ).status,
    ).toBe(201);
    expect(upstream).toHaveLength(4);
    sample = await diagnostic('sample');
    expect(sample.body).toMatchObject({
      reviewed: false,
      archiveAllowed: false,
      imageRequests: 2,
    });
    expect(
      sample.body.images.map((value: { ordinal: number }) => value.ordinal),
    ).toEqual([1, 2]);
    expect(
      sample.body.images.map(
        (value: { inlineData: string }) => value.inlineData,
      ),
    ).toEqual(
      images.map(
        (bytes) => 'data:image/png;base64,' + bytes.toString('base64'),
      ),
    );
    expect(JSON.stringify(sample.body)).not.toMatch(
      /synthetic-only|fake-note-token/,
    );
    expect(await prisma.xhsNote.count()).toBe(0);
    for (const invalid of [
      {
        ...operatorReview,
        observedText: 'Incomplete independently observed caption',
      },
      { ...operatorReview, observedImageCount: 1 },
      { ...operatorReview, publishedAt: 1700000000123 },
    ])
      expect((await diagnostic('review', invalid)).status).toBe(422);
    expect(app.get(RedbookRuntime).configured).toBe(false);
    const reviewed = await diagnostic('review', operatorReview);
    expect(reviewed.status).toBe(201);
    expect(reviewed.body).toMatchObject({
      configured: true,
      platformVerified: false,
      liveValidation: 'pending',
    });
    expect((await diagnostic('status')).body.configured).toBe(false);
    expect(
      (await query('notes', { creatorId })).body.result.data.items,
    ).toEqual([]);
    expect(upstream).toHaveLength(4);
    expect(await prisma.xhsNote.count()).toBe(0);

    const refreshed = await management('refresh', { id: creatorId });
    expect(refreshed.body.result.data).toMatchObject({
      status: 'complete',
      added: 1,
    });
    expect(upstream).toHaveLength(8);
    const stored = await prisma.xhsNote.findUnique({ where: { id: noteKey } });
    expect(stored).toMatchObject({
      id: noteKey,
      creatorId,
      status: 'complete',
      publishTime: 1700000000,
    });
    const body = (await query('body', { creatorId, noteId: noteKey })).body
      .result.data;
    expect(body).toMatchObject({
      title: 'Synthetic delivery title',
      publishTime: 1700000000,
      text: operatorReview.observedText,
    });
    expect(body.images).toEqual(
      images.map(
        (bytes) => 'data:image/png;base64,' + bytes.toString('base64'),
      ),
    );
    expect(
      (await management('refresh', { id: creatorId })).body.result.data,
    ).toMatchObject({ status: 'complete', added: 0 });
    expect(upstream).toHaveLength(9);
    expect(
      upstream.filter((value) => value.path.startsWith('/api/sns/web/v1/feed')),
    ).toHaveLength(2);
    expect(
      upstream.filter((value) => value.path.startsWith('/delivery-')),
    ).toHaveLength(4);
    for (const value of upstream) {
      if (value.path.startsWith('/api/')) {
        expect(value.headers.cookie).toBe(
          'a1=synthetic-only-a1; web_session=synthetic-only-session',
        );
        expect(value.headers['x-s']).toEqual(expect.any(String));
        expect(value.headers['x-t']).toMatch(/^\d+$/);
      } else {
        expect(value.headers.cookie).toBeUndefined();
        expect(value.headers['x-s']).toBeUndefined();
      }
    }

    expect((await post('/download/article/directory')).body.directory).toBe(
      vault,
    );
    expect(picker.pickArticleDirectory).toHaveBeenCalledTimes(1);
    expect(
      (await post('/download/article/settings', { askEveryTime: false }))
        .status,
    ).toBe(200);
    // Fake Date only: socket, Prisma and backup timers still use real time.
    jest.useFakeTimers({
      now: new Date('2026-10-14T10:00:00Z'),
      doNotFake: [
        'hrtime',
        'performance',
        'nextTick',
        'queueMicrotask',
        'setImmediate',
        'clearImmediate',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
      ],
    });
    const saved = await saveBatch();
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      saved: true,
      savedCount: 1,
      alreadySavedCount: 0,
      contentSource: 'saved-xiaohongshu',
    });
    const first = await saveOne();
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      alreadySaved: true,
      status: 'skipped',
      imageCount: 2,
      publicationDate: '2023-11-15',
    });
    const directory = first.body.directory as string;
    const markdownPath = first.body.markdownPath as string;
    expect(path.relative(vault, directory).split(path.sep)).toEqual([
      '2023-11-15_Synthetic group',
      'Synthetic author',
    ]);
    const markdown = await fs.readFile(markdownPath, 'utf8');
    expect(markdown).toContain('小红书博主：Synthetic author');
    expect(markdown).toContain('分组：Synthetic group');
    expect(markdown).toContain('原文发布日期（上海时间）：2023-11-15');
    expect(markdown).toContain('Synthetic whole caption');
    expect(markdown).toContain('Second paragraph');
    const refs = Array.from(
      markdown.matchAll(/!\[[^\]]*\]\((image\/[^)]+)\)/g),
      (value) => value[1],
    );
    expect(refs).toHaveLength(2);
    expect(
      await Promise.all(
        refs.map((value) => fs.readFile(path.join(directory, value))),
      ),
    ).toEqual(images);
    const receiptNames = (
      await fs.readdir(path.join(directory, '.wewe-articles'))
    ).filter((value) => value.endsWith('.json'));
    expect(receiptNames).toHaveLength(1);
    const receiptPath = path.join(directory, '.wewe-articles', receiptNames[0]);
    const receiptBytes = await fs.readFile(receiptPath, 'utf8');
    expect(JSON.parse(receiptBytes)).toMatchObject({
      articleId: noteKey,
      complete: true,
      exportSource: {
        platform: 'xiaohongshu',
        feedId: JSON.stringify(['xiaohongshu', 'author', authorId]),
        feedName: 'Synthetic author',
        groupId: JSON.stringify(['xiaohongshu', 'group', groupId]),
        groupName: 'Synthetic group',
      },
    });
    const retainedImage = path.join(directory, refs[0]);
    const retainedStat = await fs.stat(retainedImage);
    await fs.writeFile(markdownPath, 'Handwritten body remains exact.\n');
    jest.setSystemTime(new Date('2026-10-16T10:00:00Z'));
    const repeated = await saveBatch();
    expect(repeated.status).toBe(200);
    expect(repeated.body).toMatchObject({
      saved: true,
      savedCount: 0,
      alreadySavedCount: 1,
    });
    const skipped = await saveOne();
    expect(skipped.body).toMatchObject({
      directory,
      markdownPath,
      alreadySaved: true,
      status: 'skipped',
    });
    expect(await fs.readFile(receiptPath, 'utf8')).toBe(receiptBytes);
    expect((await fs.stat(retainedImage)).mtimeMs).toBe(retainedStat.mtimeMs);
    await fs.unlink(path.join(directory, refs[1]));
    const repaired = await saveOne();
    expect(repaired.status).toBe(200);
    expect(repaired.body).toMatchObject({
      directory,
      markdownPath,
      alreadySaved: true,
      status: 'repaired',
      imageCount: 2,
    });
    expect(await fs.readFile(markdownPath, 'utf8')).toBe(
      'Handwritten body remains exact.\n',
    );
    expect(
      await Promise.all(
        refs.map((value) => fs.readFile(path.join(directory, value))),
      ),
    ).toEqual(images);
    expect((await fs.stat(retainedImage)).mtimeMs).toBe(retainedStat.mtimeMs);
    expect(await fs.readFile(receiptPath, 'utf8')).toBe(receiptBytes);
    expect(upstream).toHaveLength(9);
    expect(await prisma.xhsNote.findUnique({ where: { id: noteKey } })).toEqual(
      stored,
    );
    const sizes = await Promise.all(
      (await fs.readdir(root, { recursive: true })).map((relative) =>
        fs.stat(path.join(root, relative)),
      ),
    );
    expect(
      sizes
        .filter((stat) => stat.isFile())
        .reduce((total, stat) => total + stat.size, 0),
    ).toBeLessThan(512 * 1024 * 1024);
  }, 60000);
});
