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
import { createHash } from 'node:crypto';
import request from 'supertest';
import { TrpcModule } from '../trpc/trpc.module';
import { TrpcRouter } from '../trpc/trpc.router';
import { PrismaService } from '../prisma/prisma.service';
import { WereadService } from '../weread/weread.service';
import { CollectionService } from './collection.service';
import { RedbookRuntime } from './redbook-runtime';
import { XiaohongshuService } from './xiaohongshu.service';
import { LocalArticleStore } from '../article-local-save';
import { REDBOOK_RESPONSE_CONTRACT } from './redbook-response';
import { privateAccessGuard } from '../private-access';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
  'base64',
);
const author = 'synthetic-author',
  note = 'synthetic-note';
const profile = `https://www.xiaohongshu.com/user/profile/${author}`;
const image = 'https://sns-webpic-qc.xhscdn.com/synthetic-image';
const list = {
  notes: [
    { note_id: note, user: { user_id: author }, xsec_token: 'synthetic-token' },
  ],
  cursor: '',
  has_more: false,
};
const detail = {
  items: [
    {
      id: note,
      note_card: {
        note_id: note,
        user: { user_id: author },
        type: 'normal',
        time: 1700000000123,
        title: 'Synthetic title',
        desc: 'Synthetic whole caption',
        image_list: [{ url_default: image }],
      },
    },
  ],
};
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const handoff = () => ({
  cookies: { a1: 'synthetic-a1', web_session: 'synthetic-session' },
  expiresAt: Date.now() + 60000,
  bindings: [
    {
      creatorId: 'local',
      authorId: author,
      profileUrl: profile,
      review: {
        contract: REDBOOK_RESPONSE_CONTRACT,
        reviewedAt: Date.now(),
        authorIdentityChecked: true,
        fullTextChecked: true,
        allImagesChecked: true,
        publicationTimeChecked: true,
        noteId: note,
        publishedAt: 1700000000,
        textSha256: sha(detail.items[0].note_card.desc),
        imageUrlSha256s: [sha(image)],
        list,
        detail,
      },
    },
  ],
});

describe('actual Nest Redbook provider → private handoff → original refresh HTTP → SQLite (synthetic loopback)', () => {
  let root: string,
    prisma: PrismaClient,
    app: INestApplication,
    server: http.Server,
    bridge: jest.SpyInstance;
  let upstreamStatus: number, requests: { path: string; cookie?: string }[];
  const oldEnv = { ...process.env };
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'redbook-nest-fixture-'));
    const url =
      'file:' + path.join(root, 'synthetic.sqlite').replace(/\\/g, '/');
    process.env.DATABASE_URL = url;
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const migrations = path.resolve(__dirname, '../../prisma/migrations');
    for (const folder of (await fs.readdir(migrations, { withFileTypes: true }))
      .filter((f) => f.isDirectory())
      .map((f) => f.name)
      .sort()) {
      const sql = await fs.readFile(
        path.join(migrations, folder, 'migration.sql'),
        'utf8',
      );
      for (const statement of sql
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean))
        await prisma.$executeRawUnsafe(statement);
    }
  }, 60000);
  beforeEach(async () => {
    process.env = {
      ...oldEnv,
      DATABASE_URL:
        'file:' + path.join(root, 'synthetic.sqlite').replace(/\\/g, '/'),
    };
    delete process.env.PRIVATE_ONLINE_MODE;
    delete process.env.WEWE_ACCEPTANCE_MODE;
    await prisma.xhsNote.deleteMany();
    await prisma.xhsCreator.deleteMany();
    await fs.rm(path.join(root, '.redbook-state'), {
      recursive: true,
      force: true,
    });
    await prisma.xhsCreator.create({
      data: {
        id: 'local',
        displayName: 'Synthetic author',
        profileUrl: profile,
      },
    });
    requests = [];
    upstreamStatus = 200;
    server = http.createServer((req, res) => {
      requests.push({ path: req.url!, cookie: req.headers.cookie });
      if (req.url!.startsWith('/api/')) {
        res.writeHead(upstreamStatus, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            success: upstreamStatus === 200,
            code: 0,
            data: req.url!.startsWith('/api/sns/web/v2/') ? list : detail,
          }),
        );
      } else {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(png);
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    // Spec-only socket redirection. No production URL/host configuration is added.
    bridge = jest
      .spyOn(https, 'request')
      .mockImplementation(((
        url: URL,
        options: https.RequestOptions,
        callback: (res: http.IncomingMessage) => void,
      ) =>
        http.request(
          `http://127.0.0.1:${(server.address() as AddressInfo).port}${url.pathname}${url.search}`,
          options,
          callback,
        )) as typeof https.request);
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          ignoreEnvVars: true,
          load: [
            () => ({
              auth: { code: 'synthetic-local-access' },
              platform: { url: '' },
              feed: { updateDelayTime: 0 },
              server: { host: '127.0.0.1' },
            }),
          ],
        }),
        TrpcModule,
      ],
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
  });
  afterEach(async () => {
    await app?.close();
    bridge?.mockRestore();
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    process.env = oldEnv;
    if (
      path.dirname(root) !== tmpdir() ||
      !path.basename(root).startsWith('redbook-nest-fixture-')
    )
      throw Error('UNSAFE_FIXTURE_CLEANUP');
    await fs.rm(root, { recursive: true, force: true });
  });
  const post = (endpoint: string, body: unknown) =>
    request(app.getHttpServer())
      .post(endpoint)
      .set('host', '127.0.0.1')
      .set('origin', 'http://127.0.0.1')
      .set('authorization', 'synthetic-local-access')
      .send(body as object);
  const refresh = () => post('/trpc/xiaohongshu.refresh', { id: 'local' });
  it('defaults closed, installs without networking, then original HTTP refresh archives PNG and dedupes detail/media', async () => {
    expect((await refresh()).body.result.data.status).toBe('unconfigured');
    const installed = await post('/local/redbook/session', handoff());
    expect(installed.status).toBe(201);
    expect(installed.body).toMatchObject({
      configured: true,
      platformVerified: false,
      liveValidation: 'pending',
    });
    expect(requests).toHaveLength(0);
    expect((await refresh()).body.result.data).toMatchObject({
      status: 'complete',
      added: 1,
    });
    expect(requests).toHaveLength(3);
    expect(requests[2].cookie).toBeUndefined();
    const stored = await prisma.xhsNote.findUnique({
      where: { id: JSON.stringify(['xiaohongshu', 'note', note]) },
    });
    expect(stored?.contentHtml).toContain(png.toString('base64'));
    expect(stored?.publishTime).toBe(1700000000);
    expect((await refresh()).body.result.data).toMatchObject({
      status: 'complete',
      added: 0,
    });
    expect(requests).toHaveLength(4);
    const service = app.get(XiaohongshuService);
    const saver = new LocalArticleStore(
      path.join(root, 'settings.json'),
      path.join(root, 'vault'),
    );
    const prepare = () =>
      service.prepareLocalDownload(
        'local',
        JSON.stringify(['xiaohongshu', 'note', note]),
      );
    const saved = await saver.save(await prepare());
    await fs.writeFile(saved.markdownPath, 'Handwritten body');
    expect(
      (await saver.save(await prepare(), new Date('2026-10-14'))).status,
    ).toBe('skipped');
    const images = await fs.readdir(path.join(saved.directory, 'image'));
    await fs.unlink(path.join(saved.directory, 'image', images[0]));
    expect((await saver.save(await prepare())).status).toBe('repaired');
    expect(await fs.readFile(saved.markdownPath, 'utf8')).toBe(
      'Handwritten body',
    );
    expect(
      await fs.readFile(path.join(saved.directory, 'image', images[0])),
    ).toEqual(png);
  }, 30000);
  it('requires existing auth and same-origin loopback, rejects caller transport targets', async () => {
    expect(
      (await post('/local/redbook/session', handoff()).unset('authorization'))
        .status,
    ).toBe(401);
    expect(
      (
        await post('/local/redbook/session', handoff()).set(
          'origin',
          'https://evil.test',
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await post('/local/redbook/session', {
          ...handoff(),
          baseUrl: 'http://127.0.0.1',
        })
      ).status,
    ).toBe(422);
    expect(requests).toHaveLength(0);
    expect(app.get(RedbookRuntime).configured).toBe(false);
  });
  it.each([
    'evil@localhost',
    'localhost/ignored',
    'localhost?ignored',
    'localhost#ignored',
    '127.0.0.1\\@localhost',
    'localhost:65536',
    'localhost:00080',
  ])('rejects malformed local Host %s before enabling', async (host) => {
    expect(
      (
        await post('/local/redbook/session', handoff())
          .set('host', host)
          .set('origin', 'http://localhost')
      ).status,
    ).toBe(403);
    expect(app.get(RedbookRuntime).configured).toBe(false);
    expect(requests).toHaveLength(0);
  });
  it.each([
    'forwarded',
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-proto',
    'x-forwarded-port',
    'x-forwarded-path',
    'x-forwarded-prefix',
    'via',
  ])('rejects forwarding header %s before enabling', async (name) => {
    expect(
      (await post('/local/redbook/session', handoff()).set(name, 'synthetic'))
        .status,
    ).toBe(403);
    expect(requests).toHaveLength(0);
  });
  it('refuses author identity already owned by a different local creator without networking', async () => {
    await prisma.xhsCreator.create({
      data: {
        id: 'legacy-owner',
        displayName: 'Legacy',
        profileUrl: 'https://www.xiaohongshu.com/legacy-profile',
        externalAuthorId: author,
      },
    });
    expect((await post('/local/redbook/session', handoff())).status).toBe(422);
    expect(app.get(RedbookRuntime).configured).toBe(false);
    expect(requests).toHaveLength(0);
  });
  it('allows direct-local existing-password handoff in private mode but rejects proxy forwarding', async () => {
    process.env.PRIVATE_ONLINE_MODE = '1';
    process.env.AUTH_CODE = 'synthetic-local-access';
    expect(
      (
        await post('/local/redbook/session', handoff()).set(
          'x-forwarded-for',
          '203.0.113.1',
        )
      ).status,
    ).toBe(403);
    expect((await post('/local/redbook/session', handoff())).status).toBe(201);
    expect(app.get(RedbookRuntime).configured).toBe(true);
    expect(requests).toHaveLength(0);
    expect(
      (await post('/trpc/xiaohongshu.refresh', { id: 'local' })).status,
    ).toBe(401);
  });
  it('revoke cancels a handoff still awaiting author lookup', async () => {
    const creator = await prisma.xhsCreator.findUnique({
      where: { id: 'local' },
    });
    let release!: (value: typeof creator) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const lookup = jest
      .spyOn(prisma.xhsCreator, 'findUnique')
      .mockImplementation((() => {
        entered();
        return new Promise((resolve) => {
          release = resolve;
        });
      }) as any);
    try {
      const runtime = app.get(RedbookRuntime);
      const installing = runtime.install(handoff());
      await started;
      await runtime.revoke();
      release(creator);
      await expect(installing).rejects.toThrow('REDBOOK_HANDOFF_CANCELLED');
      expect(runtime.configured).toBe(false);
      expect(requests).toHaveLength(0);
    } finally {
      lookup.mockRestore();
    }
  });
  it.each(['revoke', 'expiry'])(
    'multi-author %s cancels the active second author during final SQLite commit',
    async (mode) => {
      const value = handoff();
      const second = structuredClone(value.bindings[0]);
      second.creatorId = 'second';
      second.authorId = 'synthetic-second';
      second.profileUrl = `https://www.xiaohongshu.com/user/profile/${second.authorId}`;
      second.review.list.notes[0].user.user_id = second.authorId;
      second.review.detail.items[0].note_card.user.user_id = second.authorId;
      value.bindings.push(second);
      if (mode === 'expiry') value.expiresAt = Date.now() + 1000;
      await prisma.xhsCreator.create({
        data: {
          id: second.creatorId,
          displayName: 'Second',
          profileUrl: second.profileUrl,
        },
      });
      const runtime = app.get(RedbookRuntime);
      await runtime.install(value);
      server.removeAllListeners('request');
      server.on('request', (req, res) => {
        requests.push({ path: req.url!, cookie: req.headers.cookie });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            success: true,
            data: { notes: [], cursor: '', has_more: false },
          }),
        );
      });
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const scan = runtime.scan(
        (await prisma.xhsCreator.findUnique({ where: { id: 'second' } }))!,
        async () => {
          entered();
          await pending;
          await prisma.$transaction((tx) =>
            tx.xhsCreator.update({
              where: { id: 'second' },
              data: { lastStatus: 'complete' },
            }),
          );
          return {
            status: 'complete',
            added: 0,
            message: 'Synthetic committed page',
          };
        },
      );
      await started;
      if (mode === 'revoke') await runtime.revoke();
      else await new Promise((resolve) => setTimeout(resolve, 1100));
      release();
      expect((await scan).status).toBe('paused');
      expect(runtime.configured).toBe(false);
      expect(requests).toHaveLength(1);
    },
    30000,
  );
  it.each(['expired', 'cookie', 'reference', 'author', 'attestation'])(
    'rejects %s handoff before enabling',
    async (kind) => {
      const value = handoff();
      if (kind === 'expired') value.expiresAt = Date.now() - 1;
      if (kind === 'cookie') value.cookies.a1 = 'secret\r\nInjected';
      if (kind === 'reference')
        value.bindings[0].review.textSha256 = '0'.repeat(64);
      if (kind === 'author') value.bindings[0].authorId = 'other';
      if (kind === 'attestation')
        value.bindings[0].review.fullTextChecked = false;
      const rejected = await post('/local/redbook/session', value);
      expect(rejected.status).toBe(422);
      expect(JSON.stringify(rejected.body)).not.toContain('synthetic-session');
      expect(requests).toHaveLength(0);
      expect(app.get(RedbookRuntime).configured).toBe(false);
    },
  );
  it('revokes/expirs session without enabling automatic restart', async () => {
    const value = handoff();
    value.expiresAt = Date.now() + 100;
    await post('/local/redbook/session', value);
    await new Promise((resolve) => setTimeout(resolve, 130));
    expect(app.get(RedbookRuntime).configured).toBe(false);
    expect((await refresh()).body.result.data.status).toBe('unconfigured');
    expect(requests).toHaveLength(0);
    await post('/local/redbook/session', handoff());
    expect((await post('/local/redbook/revoke', {})).body.revoked).toBe(true);
    expect(app.get(RedbookRuntime).status().bindingCount).toBe(0);
  });
  it('406 task pause survives session replacement and a new runtime; no HTML/fallback/other creator dispatch', async () => {
    await post('/local/redbook/session', handoff());
    upstreamStatus = 406;
    expect((await refresh()).body.result.data.status).toBe('paused');
    expect(requests).toHaveLength(1);
    await post('/local/redbook/revoke', {});
    await post('/local/redbook/session', handoff());
    expect((await refresh()).body.result.data.status).toBe('paused');
    expect(requests).toHaveLength(1);
    expect(
      (await post('/local/redbook/resume-operator', { creatorId: 'local' }))
        .status,
    ).toBe(409);
    const restarted = new RedbookRuntime(prisma as any);
    expect(restarted.configured).toBe(false);
    await restarted.install(handoff());
    expect(
      (
        await restarted.scan(
          (await prisma.xhsCreator.findUnique({ where: { id: 'local' } }))!,
          async () => {
            throw Error('UNEXPECTED_COMMIT');
          },
        )
      ).status,
    ).toBe('paused');
    expect(requests).toHaveLength(1);
    await restarted.onModuleDestroy();
  });

  const diagnostic = () =>
    post('/local/redbook/diagnostic/session', {
      creatorId: 'local',
      cookies: handoff().cookies,
      expiresAt: Date.now() + 60000,
      confirmLocalSession: true,
    });
  const diagnosticPost = (action: string, body: object = {}) =>
    post('/local/redbook/diagnostic/' + action, body);
  const diagnosticPair = async () => {
    expect((await diagnostic()).status).toBe(201);
    expect(
      (await diagnosticPost('list', { confirmRequest: true })).status,
    ).toBe(201);
    expect(
      (await diagnosticPost('detail', { confirmRequest: true, noteId: note }))
        .status,
    ).toBe(201);
  };
  const diagnosticReview = () => ({
    authorIdentityChecked: true,
    fullTextChecked: true,
    allImagesChecked: true,
    publicationTimeChecked: true,
    allowFutureArchive: true,
    observedText: detail.items[0].note_card.desc,
    observedImageCount: 1,
    publishedAt: 1700000000,
  });
  it('diagnostic first check needs no prior reviewed sample, makes no automatic request or archive, and exposes no cookies', async () => {
    const response = await diagnostic();
    expect(response.status).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({
      reviewed: false,
      archiveAllowed: false,
      phase: 'ready',
      listRequests: 0,
      detailRequests: 0,
    });
    expect(requests).toHaveLength(0);
    expect(app.get(RedbookRuntime).configured).toBe(false);
    expect(
      (await prisma.xhsCreator.findUnique({ where: { id: 'local' } }))
        ?.externalAuthorId,
    ).toBeNull();
    expect(await prisma.xhsNote.count()).toBe(0);
    expect(JSON.stringify(response.body)).not.toContain('synthetic-session');
    expect((await post('/local/redbook/session', handoff())).status).toBe(422);
    expect((await refresh()).body.result.data.status).toBe('unconfigured');
  });
  it('diagnostic list and selected detail each have one manual debit; images stay off and sample remains pending', async () => {
    await diagnostic();
    expect((await diagnosticPost('list', {})).status).toBe(422);
    expect(requests).toHaveLength(0);
    await diagnosticPost('list', { confirmRequest: true });
    expect(
      (await diagnosticPost('list', { confirmRequest: true })).status,
    ).toBe(422);
    expect(
      (
        await diagnosticPost('detail', {
          confirmRequest: true,
          noteId: 'outside-list',
        })
      ).status,
    ).toBe(422);
    expect(requests).toHaveLength(1);
    await diagnosticPost('detail', { confirmRequest: true, noteId: note });
    expect(
      (await diagnosticPost('detail', { confirmRequest: true, noteId: note }))
        .status,
    ).toBe(422);
    const sample = await diagnosticPost('sample');
    expect(sample.body).toMatchObject({
      reviewed: false,
      archiveAllowed: false,
      phase: 'sample-ready',
      images: [],
      listRequests: 1,
      detailRequests: 1,
      imageRequests: 0,
    });
    expect(JSON.stringify(sample.body)).not.toContain('synthetic-token');
    expect(requests).toHaveLength(2);
    expect(await prisma.xhsNote.count()).toBe(0);
  });
  it('diagnostic follows no next cursor even with more pages and rejects missing cursor without completion', async () => {
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      requests.push({ path: req.url! });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          code: 0,
          data: { ...list, has_more: true, cursor: 'next-page' },
        }),
      );
    });
    await diagnostic();
    const response = await diagnosticPost('list', { confirmRequest: true });
    expect(response.body.phase).toBe('listed');
    expect(requests).toHaveLength(1);
    await diagnosticPost('list', { confirmRequest: true });
    expect(requests).toHaveLength(1);
    await diagnosticPost('discard');
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      requests.push({ path: req.url! });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          code: 0,
          data: { ...list, has_more: true, cursor: '' },
        }),
      );
    });
    await diagnostic();
    expect(
      (await diagnosticPost('list', { confirmRequest: true })).body.diagnostic
        .phase,
    ).toBe('paused');
    expect((await diagnosticPost('sample')).body.archiveAllowed).toBe(false);
    expect(await prisma.xhsNote.count()).toBe(0);
  });
  it('diagnostic images require separate consent and respect the bounded budget, omit credentials, and never archive', async () => {
    await diagnosticPair();
    for (const body of [
      { maxImages: 1, maxBytes: 1000000 },
      { confirmImages: true, maxImages: 3, maxBytes: 1000000 },
      { confirmImages: true, maxImages: 1, maxBytes: 1000001 },
    ])
      expect((await diagnosticPost('images', body)).status).toBe(422);
    expect(requests).toHaveLength(2);
    expect(
      (
        await diagnosticPost('images', {
          confirmImages: true,
          maxImages: 1,
          maxBytes: 1024,
        })
      ).status,
    ).toBe(201);
    expect(requests).toHaveLength(3);
    expect(requests[2].cookie).toBeUndefined();
    const sample = (await diagnosticPost('sample')).body;
    expect(sample.images).toHaveLength(1);
    expect(sample.images[0].bytes).toBe(png.length);
    expect(
      (
        await diagnosticPost('images', {
          confirmImages: true,
          maxImages: 1,
          maxBytes: 1024,
        })
      ).status,
    ).toBe(422);
    expect(requests).toHaveLength(3);
    expect(await prisma.xhsNote.count()).toBe(0);
  });
  it('diagnostic restriction pauses the shared queue across revoke/new sessions with no resign, HTML, or endpoint fallback', async () => {
    upstreamStatus = 406;
    await diagnostic();
    expect(
      (await diagnosticPost('list', { confirmRequest: true })).status,
    ).toBe(422);
    expect((await diagnosticPost('status')).body.phase).toBe('paused');
    expect((await diagnosticPost('status')).body.configured).toBe(false);
    expect((app.get(RedbookRuntime) as any).diagnostic.cookies).toEqual({});
    expect(
      (await diagnosticPost('list', { confirmRequest: true })).status,
    ).toBe(422);
    await diagnosticPost('discard');
    expect((await diagnostic()).status).toBe(422);
    await post('/local/redbook/session', handoff());
    await refresh();
    expect(requests).toHaveLength(1);
    expect(requests[0].path).toContain('/api/sns/web/v2/user_posted');
    expect(await prisma.xhsNote.count()).toBe(0);
  });
  it('diagnostic review requires independent references and four explicit attestations, then enables only later manual refresh', async () => {
    await diagnosticPair();
    expect((await diagnosticPost('review', {})).status).toBe(422);
    expect(
      (
        await diagnosticPost('review', {
          ...diagnosticReview(),
          observedText: 'different',
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await diagnosticPost('review', {
          ...diagnosticReview(),
          allImagesChecked: false,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await diagnosticPost('review', {
          ...diagnosticReview(),
          observedImageCount: 2,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await diagnosticPost('review', {
          ...diagnosticReview(),
          publishedAt: 1700000000123,
        })
      ).status,
    ).toBe(422);
    expect(requests).toHaveLength(2);
    expect(app.get(RedbookRuntime).configured).toBe(false);
    const response = await diagnosticPost('review', diagnosticReview());
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      configured: true,
      platformVerified: false,
      liveValidation: 'pending',
    });
    expect(requests).toHaveLength(2);
    expect(await prisma.xhsNote.count()).toBe(0);
    expect((await diagnosticPost('status')).body.configured).toBe(false);
    expect((await refresh()).body.result.data.added).toBe(1);
    expect(await prisma.xhsNote.count()).toBe(1);
  });
  it('diagnostic revoke aborts an in-flight list and clears secrets/sample without subsequent requests', async () => {
    let seen!: () => void;
    const started = new Promise<void>((resolve) => {
      seen = resolve;
    });
    server.removeAllListeners('request');
    server.on('request', (req) => {
      requests.push({ path: req.url! });
      seen();
    });
    await diagnostic();
    const pending = diagnosticPost('list', { confirmRequest: true }).then(
      (value) => value,
    );
    await started;
    expect((await diagnosticPost('discard')).status).toBe(201);
    expect((await pending).status).toBe(422);
    expect((await diagnosticPost('sample')).status).toBe(422);
    expect(requests).toHaveLength(1);
    expect((await diagnostic()).status).toBe(422);
    expect(await prisma.xhsNote.count()).toBe(0);
  });
  it('authorized diagnostic retention accepts 24 hours, never renews on reads, and clears credentials at absolute expiry', async () => {
    const deadline = Date.now() + 24 * 3600000;
    expect(
      (
        await post('/local/redbook/diagnostic/session', {
          creatorId: 'local',
          cookies: handoff().cookies,
          expiresAt: deadline,
          confirmLocalSession: true,
        })
      ).status,
    ).toBe(201);
    const runtime = app.get(RedbookRuntime);
    expect(runtime.diagnosticStatus().expiresAt).toBe(deadline);
    await diagnosticPost('list', { confirmRequest: true });
    expect(runtime.diagnosticStatus().expiresAt).toBe(deadline);
    const retained = (runtime as any).diagnostic;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(deadline);
    try {
      expect(runtime.diagnosticStatus().configured).toBe(false);
      expect(retained.cookies).toEqual({});
      expect(retained.abort.signal.aborted).toBe(true);
    } finally {
      clock.mockRestore();
    }
    expect(requests).toHaveLength(1);
  });
  it('review of a long diagnostic session preserves the independent two-hour formal-session cap', async () => {
    expect(
      (
        await post('/local/redbook/diagnostic/session', {
          creatorId: 'local',
          cookies: handoff().cookies,
          expiresAt: Date.now() + 24 * 3600000,
          confirmLocalSession: true,
        })
      ).status,
    ).toBe(201);
    await diagnosticPost('list', { confirmRequest: true });
    await diagnosticPost('detail', { confirmRequest: true, noteId: note });
    const response = await diagnosticPost('review', diagnosticReview());
    expect(response.status).toBe(201);
    expect(response.body.expiresAt).toBeLessThanOrEqual(
      Date.now() + 2 * 3600000,
    );
    expect(await prisma.xhsNote.count()).toBe(0);
  });
  it('diagnostic TTL expires without requests and all diagnostic routes enforce the direct-local gate', async () => {
    expect(
      (
        await post('/local/redbook/diagnostic/session', {
          creatorId: 'local',
          cookies: handoff().cookies,
          expiresAt: Date.now() + 24 * 3600000 + 10000,
          confirmLocalSession: true,
        })
      ).status,
    ).toBe(422);
    const installed = await post('/local/redbook/diagnostic/session', {
      creatorId: 'local',
      cookies: handoff().cookies,
      expiresAt: Date.now() + 40,
      confirmLocalSession: true,
    });
    expect(installed.status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(
      (await diagnosticPost('list', { confirmRequest: true })).status,
    ).toBe(422);
    for (const action of [
      'status',
      'session',
      'list',
      'detail',
      'images',
      'sample',
      'review',
      'discard',
    ]) {
      expect(
        (
          await request(app.getHttpServer())
            .post('/local/redbook/diagnostic/' + action)
            .set('host', 'evil@localhost')
            .set('origin', 'http://localhost')
            .set('authorization', 'synthetic-local-access')
            .send({})
        ).status,
      ).toBe(403);
      expect(
        (
          await request(app.getHttpServer())
            .post('/local/redbook/diagnostic/' + action)
            .set('host', 'localhost')
            .set('origin', 'http://localhost')
            .set('authorization', 'synthetic-local-access')
            .set('x-forwarded-path', '/')
            .send({})
        ).status,
      ).toBe(403);
    }
    expect(requests).toHaveLength(0);
  });

  it('diagnostic media overrun stops before accepting image bytes or retrying', async () => {
    await diagnosticPair();
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      requests.push({ path: req.url!, cookie: req.headers.cookie });
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-length': '2000',
      });
      res.end(Buffer.alloc(2000));
    });
    const response = await diagnosticPost('images', {
      confirmImages: true,
      maxImages: 2,
      maxBytes: 1024,
    });
    expect(response.status).toBe(422);
    expect(response.body.diagnostic).toMatchObject({
      phase: 'paused',
      imageRequests: 1,
    });
    expect(requests).toHaveLength(3);
    expect((await diagnosticPost('sample')).body.images).toHaveLength(0);
    expect(await prisma.xhsNote.count()).toBe(0);
    await diagnosticPost('images', {
      confirmImages: true,
      maxImages: 2,
      maxBytes: 1024,
    });
    expect(requests).toHaveLength(3);
  });
});
