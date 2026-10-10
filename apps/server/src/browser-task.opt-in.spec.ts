import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { json } from 'express';
import request from 'supertest';
import {
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  rm,
  mkdir,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { load } from 'cheerio';
import { AppModule } from './app.module';
import { PrismaService } from './prisma/prisma.service';
import { CollectionService } from './collection/collection.service';
import { WereadService } from './weread/weread.service';
import { FeedsService } from './feeds/feeds.service';
import * as picker from './article-folder-picker';
import { LocalArticleStore } from './article-local-save';
import { BrowserTaskBroker } from './browser-task';
import { ArticleDownloadController } from './article-download.controller';
import {
  readBrowserTaskOptIn,
  browserTaskApplication,
  mountBrowserTaskTransport,
} from './browser-task.opt-in';
import {
  binding,
  config,
  observation,
  short,
  largeSyntheticPng,
} from '../test/browser-task-fixture';

// This integration saves Markdown/images through the real local exporter;
// the unrelated ZIP exporter imports an ESM-only package under Jest CJS.
jest.mock('./offline-archive', () => ({ archiveDirectory: jest.fn() }));

describe('legacy opt-in transport with Wechat2RSS-only save policy, synthetic offline only', () => {
  const previous = { ...process.env };
  let directory: string,
    file: string,
    destination: string,
    app: NestExpressApplication | undefined;
  const originalUrl =
    'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA%3D%3D&mid=2247000001&idx=1&sn=abcd';
  const sample = observation();
  const $ = load(sample.html);
  const approval = () => ({
    version: 1,
    approved: true,
    approvedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    localOrigin: 'http://127.0.0.1:4000',
    extensionOrigin: config.extensionOrigin,
    pairingKey: config.pairingKey,
    article: {
      originalUrl,
      title: $('#activity-name').text(),
      publisher: $('#js_name').text(),
      publishTime: 1700000000,
      imageCount: 1,
      confirmedComplete: true,
    },
  });
  const env = () => ({
    WEWE_BROWSER_TASK_OPT_IN: '1',
    WEWE_BROWSER_TASK_OPT_IN_FILE: file,
  });
  const post = (path: string, body: object) =>
    request(app!.getHttpServer())
      .post(path)
      .set('host', '127.0.0.1:4000')
      .set(
        'origin',
        path.startsWith('/browser-task/')
          ? config.extensionOrigin
          : 'http://127.0.0.1:4000',
      )
      .set('Authorization', 'offline-auth')
      .set('X-WeWe-Pairing', config.pairingKey)
      .send(body);
  beforeEach(async () => {
    delete process.env.PRIVATE_ONLINE_MODE;
    delete process.env.WEWE_ACCEPTANCE_MODE;
    process.env.ENABLE_SCHEDULED_UPDATES = '0';
    process.env.DISABLE_SCHEDULED_UPDATES = '1';
    directory = await mkdtemp(join(tmpdir(), 'wewe-explicit-opt-in-'));
    file = join(directory, 'approval.json');
    destination = join(directory, 'notes');
    await mkdir(destination);
    process.env.DATABASE_URL = 'file:' + join(directory, 'unused.sqlite');
    await writeFile(
      join(directory, '.article-download-settings.json'),
      JSON.stringify({ directory: destination, askEveryTime: false }),
    );
    await writeFile(file, JSON.stringify(approval()), { mode: 0o600 });
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
    jest.restoreAllMocks();
    process.env = { ...previous };
    await rm(directory, { recursive: true, force: true });
  });
  async function application(enabled = true) {
    const opted = enabled ? readBrowserTaskOptIn(env()) : undefined;
    const module = await Test.createTestingModule({
      imports: [browserTaskApplication(opted)],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(WereadService)
      .useValue({})
      .overrideProvider(CollectionService)
      .useValue({})
      .overrideProvider(FeedsService)
      .useValue({})
      .overrideProvider(ConfigService)
      .useValue({
        get: (key: string) =>
          key === 'auth.code'
            ? 'offline-auth'
            : key === 'platform'
              ? { url: '' }
              : key === 'feed'
                ? { updateDelayTime: 0 }
                : key === 'server'
                  ? { host: '127.0.0.1', port: 4000, isProd: false }
                  : {},
      })
      .compile();
    app = module.createNestApplication<NestExpressApplication>({
      bodyParser: !opted,
    });
    mountBrowserTaskTransport(app, { host: '127.0.0.1', port: 4000 }, opted);
    app.use(json({ limit: '10mb' }));
    app.enableCors();
    await app.init();
  }
  // Seed an already-issued legacy task internally; the public issue route stays
  // disabled. This verifies status/cancel and transport retained during upgrades.
  function legacyTask() {
    const controller = app!.get(ArticleDownloadController) as any;
    const owner = controller.taskOwner({
      headers: { authorization: 'offline-auth' },
    });
    return controller.browserTasks.issue(originalUrl, owner, destination)
      .taskId;
  }
  it('leaves original module and no receiving route as default, never creates consumption state', async () => {
    expect(
      readBrowserTaskOptIn({ ...env(), WEWE_BROWSER_TASK_OPT_IN: '0' }),
    ).toBeUndefined();
    expect(browserTaskApplication()).toBe(AppModule);
    await application(false);
    expect((await post('/browser-task/claim', {})).status).toBe(404);
    expect(existsSync(file + '.consumed')).toBe(false);
  });
  it('rejects wrong ports, unapproved records and invalid/long-lived leases', async () => {
    for (const patch of [
      { localOrigin: 'http://127.0.0.1:4001' },
      { approved: false },
      { expiresAt: new Date(Date.now() + 3600000).toISOString() },
      { unexpected: 'not accepted' },
    ]) {
      await writeFile(file, JSON.stringify({ ...approval(), ...patch }));
      expect(() => readBrowserTaskOptIn(env())).toThrow(
        'BROWSER_TASK_OPT_IN_INVALID',
      );
    }
    expect(() =>
      readBrowserTaskOptIn({ ...env(), PRIVATE_ONLINE_MODE: '1' }),
    ).toThrow();
    expect(() =>
      readBrowserTaskOptIn({
        ...env(),
        WEWE_BROWSER_TASK_OPT_IN_FILE: 'relative.json',
      }),
    ).toThrow();
  });
  it('defaults off for expired/consumed approval and atomically consumes before a task can be replayed across restart', async () => {
    const expired = approval();
    expired.approvedAt = new Date(Date.now() - 600000).toISOString();
    expired.expiresAt = new Date(Date.now() - 1).toISOString();
    await writeFile(file, JSON.stringify(expired));
    expect(readBrowserTaskOptIn(env())).toBeUndefined();
    await writeFile(file, JSON.stringify(approval()));
    const first = new BrowserTaskBroker(readBrowserTaskOptIn(env()));
    const concurrent = new BrowserTaskBroker(readBrowserTaskOptIn(env()));
    expect(() => first.issue({ url: short }, destination)).toThrow(
      'TARGET_MISMATCH',
    );
    expect(existsSync(file + '.consumed')).toBe(false);
    first.issue({ url: originalUrl }, destination);
    expect(() => concurrent.issue({ url: originalUrl }, destination)).toThrow(
      'MANUAL_SCOPE_CONSUMED',
    );
    expect(readBrowserTaskOptIn(env())).toBeUndefined();
    first.close();
    concurrent.close();
  });
  it('shares the configured broker with the original controller and isolates preflight/parser authentication before generic CORS', async () => {
    await application();
    const capability = await request(app!.getHttpServer())
      .get('/download/article/browser-task')
      .set('host', '127.0.0.1:4000')
      .set('Authorization', 'offline-auth');
    expect(capability.body.available).toBe(false);
    expect(capability.body.code).toBe('WECHAT2RSS_ONLY');
    expect(capability.body.refreshAvailable).toBe(false);
    const preflight = () =>
      request(app!.getHttpServer())
        .options('/browser-task/claim')
        .set('host', '127.0.0.1:4000')
        .set('access-control-request-method', 'POST')
        .set('access-control-request-headers', 'content-type,x-wewe-pairing');
    const allowed = await preflight().set('origin', config.extensionOrigin);
    expect(allowed.status).toBe(204);
    expect(allowed.headers['access-control-allow-origin']).toBe(
      config.extensionOrigin,
    );
    const denied = await preflight().set('origin', 'https://unrelated.invalid');
    expect(denied.status).toBe(403);
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    const unpaired = await request(app!.getHttpServer())
      .post('/browser-task/complete')
      .set('host', '127.0.0.1:4000')
      .set('origin', config.extensionOrigin)
      .set('content-type', 'application/json')
      .send('{');
    expect(unpaired.status).toBe(401);
    expect(
      (await post('/browser-task/claim', {}).set('host', '127.0.0.1:4001'))
        .status,
    ).toBe(403);
  });
  it('even an approved opt-in cannot issue or save another-source article through the public routes', async () => {
    await application();
    expect(
      (
        await post('/download/article/browser-task', { url: originalUrl }).set(
          'Authorization',
          'wrong',
        )
      ).status,
    ).toBe(401);
    const issued = await post('/download/article/browser-task', {
      url: originalUrl,
    });
    expect(issued.status).toBe(409);
    expect(issued.body.code).toBe('WECHAT2RSS_ONLY');
    expect(existsSync(file + '.consumed')).toBe(false);
    const taskId = legacyTask();
    const claim = await post('/browser-task/claim', { taskId, binding });
    expect(claim.status).toBe(200);
    expect(
      (
        await post('/browser-task/complete', {
          taskId,
          binding,
          nonce: claim.body.nonce,
          observation: {
            pageUrl: binding.pageUrl,
            html: sample.html.replace(short, originalUrl),
            images: sample.images,
            omittedEmptyImageNodes: 0,
          },
        })
      ).body,
    ).toEqual({ accepted: true });
    const status = await request(app!.getHttpServer())
      .get('/download/article/browser-task/' + taskId)
      .set('host', '127.0.0.1:4000')
      .set('Authorization', 'offline-auth');
    expect(status.body.state).toBe('ready');
    const saved = await post(
      '/download/article/browser-task/' + taskId + '/save',
      {},
    );
    expect(saved.status).toBe(409);
    expect(saved.body.code).toBe('WECHAT2RSS_ONLY');
    expect(await readdir(destination)).toEqual([]);
  });
  it('cancelled original task cannot complete or save and stale lease cannot grant a new claim', async () => {
    await application();
    const taskId = legacyTask();
    const claim = await post('/browser-task/claim', { taskId, binding });
    expect(
      (await post('/download/article/browser-task/' + taskId + '/cancel', {}))
        .body.state,
    ).toBe('cancelled');
    expect(
      (
        await post('/browser-task/complete', {
          taskId,
          binding,
          nonce: claim.body.nonce,
          observation: {},
        })
      ).status,
    ).toBe(410);
    expect(
      (await post('/download/article/browser-task/' + taskId + '/save', {}))
        .status,
    ).toBe(409);
    expect(await readdir(destination)).toEqual([]);
    const leased = new BrowserTaskBroker({
      ...config,
      expiresAt: Date.now() - 1,
    });
    expect(leased.capability()).toMatchObject({
      available: false,
      code: 'OPT_IN_EXPIRED',
    });
  });

  it('real opt-in AppModule parser accepts valid >10MiB image transport without enabling global large bodies', async () => {
    await application();
    const taskId = legacyTask();
    const claim = await post('/browser-task/claim', { taskId, binding });
    const large = {
      pageUrl: binding.pageUrl,
      html: sample.html.replace(short, originalUrl),
      images: [
        {
          index: 0,
          inline:
            'data:image/png;base64,' + largeSyntheticPng().toString('base64'),
        },
      ],
      omittedEmptyImageNodes: 0,
    };
    const payload = {
      taskId,
      binding,
      nonce: claim.body.nonce,
      observation: large,
    };
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeGreaterThan(
      10 * 1024 * 1024,
    );
    expect((await post('/download/article/browser-task', payload)).status).toBe(
      413,
    );
    expect((await post('/browser-task/complete', payload)).body).toEqual({
      accepted: true,
    });
    expect(await readdir(destination)).toEqual([]);
  }, 60000);

  it('legacy tasks cannot write either destination after directory changes', async () => {
    await application();
    const taskId = legacyTask();
    const other = join(directory, 'other-notes');
    await mkdir(other);
    const note = join(destination, 'existing.md');
    await writeFile(note, 'existing user note');
    const before = await readFile(note);
    jest.spyOn(picker, 'pickArticleDirectory').mockResolvedValueOnce(other);
    expect((await post('/download/article/directory', {})).body.directory).toBe(
      other,
    );
    const saved = await post(
      '/download/article/browser-task/' + taskId + '/save',
      {},
    );
    expect(saved.status).toBe(409);
    expect(saved.body.code).toBe('WECHAT2RSS_ONLY');
    expect(await readFile(note)).toEqual(before);
    expect(await readdir(destination)).toEqual(['existing.md']);
    expect(await readdir(other)).toEqual([]);
  });
  it('asking-policy preferences and pick tokens never reenable browser-source issue or save', async () => {
    await application();
    await post('/download/article/settings', { askEveryTime: true });
    const save = jest.spyOn(LocalArticleStore.prototype, 'save');
    const pick = jest.spyOn(picker, 'pickArticleDirectory');
    for (const body of [
      { url: originalUrl },
      { url: originalUrl, pickToken: 'invalid' },
    ]) {
      const denied = await post('/download/article/browser-task', body);
      expect(denied.status).toBe(409);
      expect(denied.body.code).toBe('WECHAT2RSS_ONLY');
      expect(existsSync(file + '.consumed')).toBe(false);
    }
    const denied = await post('/download/article/browser-task/legacy/save', {
      directoryPickConfirmed: true,
    });
    expect(denied.status).toBe(409);
    expect(denied.body.code).toBe('WECHAT2RSS_ONLY');
    expect(save).not.toHaveBeenCalled();
    expect(pick).not.toHaveBeenCalled();
    expect(await readdir(destination)).toEqual([]);
  });
});
