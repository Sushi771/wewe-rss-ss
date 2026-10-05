import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, dirname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { ArticleDownloadController } from './article-download.controller';
import { BrowserTaskBroker } from './browser-task';
import * as download from './article-download';
import * as picker from './article-folder-picker';
import * as exporter from './article-verified-download';
import {
  config,
  binding,
  observation,
  short,
  png,
} from '../test/browser-task-fixture';

describe('original download application task HTTP handoff; synthetic content only', () => {
  let app: INestApplication,
    broker: BrowserTaskBroker,
    temporary: string,
    destination: string,
    settingsFile: string,
    settings: ConfigService;
  const post = (path: string, body: object = {}) =>
    request(app.getHttpServer())
      .post('/download/article' + path)
      .set('host', '127.0.0.1')
      .set('origin', 'http://127.0.0.1')
      .set('authorization', 'fixture-access')
      .send(body);
  const get = (path: string) =>
    request(app.getHttpServer())
      .get('/download/article' + path)
      .set('host', '127.0.0.1')
      .set('authorization', 'fixture-access');
  const originalEnv = { ...process.env };
  const issue = async () =>
    (await post('/browser-task', { url: short }).expect(200)).body;
  const ready = async (captured = observation()) => {
    const task = await issue(),
      claim = broker.claim(task.taskId, binding);
    broker.complete(task.taskId, claim.nonce, binding, captured);
    await Promise.resolve();
    return task;
  };
  beforeEach(async () => {
    delete process.env.PRIVATE_ONLINE_MODE;
    delete process.env.WEWE_ACCEPTANCE_MODE;
    temporary = await mkdtemp(join(tmpdir(), 'wewe-browser-article-http-'));
    destination = join(temporary, '中文 Obsidian');
    await mkdir(destination);
    process.env.DATABASE_URL = 'file:' + join(temporary, 'unused.sqlite');
    settingsFile = join(temporary, '.article-download-settings.json');
    await writeFile(
      settingsFile,
      JSON.stringify({ directory: destination, askEveryTime: false }),
    );
    broker = new BrowserTaskBroker(config);
    settings = new ConfigService({ auth: { code: 'fixture-access' } });
    const module = await Test.createTestingModule({
      controllers: [ArticleDownloadController],
      providers: [
        { provide: BrowserTaskBroker, useValue: broker },
        { provide: ConfigService, useValue: settings },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    jest
      .spyOn(download, 'buildArticleDownload')
      .mockRejectedValue(new Error('upstream must not run'));
    jest.spyOn(picker, 'pickArticleDirectory').mockResolvedValue(destination);
  });
  afterEach(async () => {
    await app.close();
    broker.close();
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
    await rm(temporary, { recursive: true, force: true });
  });
  it('original auth and Origin checks precede issue/status/cancel/save; the extension route is not registered', async () => {
    await post('/browser-task', { url: short })
      .unset('authorization')
      .expect(401);
    await post('/browser-task', { url: short })
      .set('origin', 'https://evil.invalid')
      .expect(403);
    await post('/browser-task', { url: short }).unset('origin').expect(403);
    const task = await issue();
    await get('/browser-task/' + task.taskId)
      .unset('authorization')
      .expect(401);
    await post('/browser-task/' + task.taskId + '/cancel')
      .set('origin', 'https://evil.invalid')
      .expect(403);
    await post('/browser-task/' + task.taskId + '/save')
      .unset('authorization')
      .expect(401);
    await request(app.getHttpServer())
      .post('/browser-task/claim')
      .send({})
      .expect(404);
    expect((await get('/browser-task/' + task.taskId)).body.state).toBe(
      'waiting',
    );
    expect(download.buildArticleDownload).not.toHaveBeenCalled();
  });
  it('article task capability never enables selected-publisher refresh', async () => {
    const response = await get('/browser-task').expect(200);
    expect(response.body).toEqual({
      available: true,
      refreshAvailable: false,
      refreshCode: 'DIRECTORY_ROUTE_UNVERIFIED',
    });
    expect(response.headers['cache-control']).toContain('no-store');
  });
  it('only internally verified results reach existing real Markdown/image saver, preserving user edits on replay', async () => {
    const task = await ready();
    const status = await get('/browser-task/' + task.taskId).expect(200);
    expect(status.body.state).toBe('ready');
    expect(Object.keys(status.body).sort()).toEqual([
      'expiresAt',
      'state',
      'taskId',
    ]);
    await post('/browser-task/' + task.taskId + '/save', {
      article: observation(),
      url: short,
    }).expect(400);
    const saved = await post('/browser-task/' + task.taskId + '/save').expect(
      200,
    );
    expect(saved.body).toMatchObject({
      saved: true,
      contentSource: 'verified-provider',
      imageCount: 1,
    });
    expect(await readFile(saved.body.markdownPath, 'utf8')).toContain(
      '末尾完整内容',
    );
    const images = await readdir(
      join(dirname(saved.body.markdownPath), 'image'),
    );
    expect(images).toHaveLength(1);
    expect(
      await readFile(
        join(dirname(saved.body.markdownPath), 'image', images[0]),
      ),
    ).toEqual(Buffer.from(png, 'base64'));
    await writeFile(saved.body.markdownPath, '# 用户编辑');
    await post('/browser-task/' + task.taskId + '/save').expect(409);
    const another = await ready();
    expect(
      (await post('/browser-task/' + another.taskId + '/save').expect(200)).body
        .alreadySaved,
    ).toBe(true);
    expect(await readFile(saved.body.markdownPath, 'utf8')).toBe('# 用户编辑');
    expect(download.buildArticleDownload).not.toHaveBeenCalled();
  });
  it('new request rechecks changed auth/session and Origin instead of saving from the original issue request', async () => {
    const task = await ready();
    settings.set('auth.code', 'rotated-access');
    await post('/browser-task/' + task.taskId + '/save').expect(401);
    await get('/browser-task/' + task.taskId)
      .set('authorization', 'rotated-access')
      .expect(410);
    settings.set('auth.code', 'fixture-access');
    await post('/browser-task/' + task.taskId + '/save')
      .set('origin', 'https://evil.invalid')
      .expect(403);
    expect((await get('/browser-task/' + task.taskId)).body.state).toBe(
      'ready',
    );
    expect(await readdir(destination)).toEqual([]);
  });
  it('directory grant failure leaves verified content retryable locally, and save reuses the actual picker grant', async () => {
    const task = await ready();
    await writeFile(
      settingsFile,
      JSON.stringify({ directory: destination, askEveryTime: true }),
    );
    await post('/browser-task/' + task.taskId + '/save').expect(409);
    expect((await get('/browser-task/' + task.taskId)).body).toMatchObject({
      state: 'ready',
      code: 'SAVE_RETRY_REQUIRED',
    });
    const picked = await post('/directory').expect(200);
    expect(picked.body.pickToken).toBeTruthy();
    await post('/browser-task/' + task.taskId + '/save', {
      pickToken: picked.body.pickToken,
    }).expect(200);
    expect((await get('/browser-task/' + task.taskId)).body.state).toBe(
      'saved',
    );
    expect(download.buildArticleDownload).not.toHaveBeenCalled();
  });
  it('a failed local exporter leaves content retryable, with no remote fallback or partial published note', async () => {
    const task = await ready();
    jest
      .spyOn(exporter, 'prepareVerifiedProviderDownload')
      .mockImplementationOnce(() => async (directory) => {
        await mkdir(join(directory, 'image'));
        await writeFile(
          join(directory, 'index.md'),
          '# synthetic incomplete stage',
        );
        throw new Error('synthetic-save-failure');
      });
    expect(
      (await post('/browser-task/' + task.taskId + '/save').expect(422)).body
        .code,
    ).toBe('LOCAL_SAVE_FAILED');
    expect((await get('/browser-task/' + task.taskId)).body).toMatchObject({
      state: 'ready',
      code: 'SAVE_RETRY_REQUIRED',
    });
    const dates = await readdir(destination);
    expect(dates).toHaveLength(1);
    expect(await readdir(join(destination, dates[0]))).toEqual([]);
    const result = await post('/browser-task/' + task.taskId + '/save').expect(
      200,
    );
    expect(await readFile(result.body.markdownPath, 'utf8')).toContain(
      '末尾完整内容',
    );
    expect(download.buildArticleDownload).not.toHaveBeenCalled();
  });
  it('default-false path failure can choose a new directory and save retained bytes without another completion, preserving user content', async () => {
    const previous = join(
      temporary,
      'x'.repeat(Math.max(1, 165 - temporary.length - 1)),
    );
    await mkdir(previous);
    const oldNote = join(previous, '用户笔记.md');
    await writeFile(oldNote, '# 原目录的用户内容');
    await writeFile(
      settingsFile,
      JSON.stringify({ directory: previous, askEveryTime: false }),
    );
    const captured = observation(),
      title = '合'.repeat(60);
    captured.html = captured.html.replace('离线新文章', title);
    captured.projection.current.review.mpInfo.title = title;
    const complete = jest.spyOn(broker, 'complete');
    const task = await ready(captured);
    expect(
      (await post('/browser-task/' + task.taskId + '/save').expect(422)).body
        .code,
    ).toBe('SAVE_PATH_TOO_LONG');
    expect((await get('/browser-task/' + task.taskId)).body).toMatchObject({
      state: 'ready',
      code: 'SAVE_RETRY_REQUIRED',
    });
    const chosen = await post('/directory').expect(200);
    expect(chosen.body).toMatchObject({
      directory: destination,
      askEveryTime: false,
      cancelled: false,
    });
    const saved = await post('/browser-task/' + task.taskId + '/save').expect(
      200,
    );
    expect(saved.body.markdownPath.startsWith(destination + sep)).toBe(true);
    expect(await readFile(saved.body.markdownPath, 'utf8')).toContain(
      '末尾完整内容',
    );
    const images = await readdir(
      join(dirname(saved.body.markdownPath), 'image'),
    );
    expect(
      await readFile(
        join(dirname(saved.body.markdownPath), 'image', images[0]),
      ),
    ).toEqual(Buffer.from(png, 'base64'));
    expect(await readFile(oldNote, 'utf8')).toBe('# 原目录的用户内容');
    await writeFile(saved.body.markdownPath, '# 新目录的用户编辑');
    await post('/browser-task/' + task.taskId + '/save').expect(409);
    expect(await readFile(saved.body.markdownPath, 'utf8')).toBe(
      '# 新目录的用户编辑',
    );
    expect(complete).toHaveBeenCalledTimes(1);
    expect(picker.pickArticleDirectory).toHaveBeenCalledTimes(1);
    expect(download.buildArticleDownload).not.toHaveBeenCalled();
  });
  it('cancellation during directory selection drops the retained body and blocks a late save', async () => {
    const task = await ready();
    let picked!: (value: string) => void, opened!: () => void;
    const pickerOpened = new Promise<void>((resolve) => {
      opened = resolve;
    });
    jest.mocked(picker.pickArticleDirectory).mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          picked = resolve;
          opened();
        }),
    );
    const selection = post('/directory').then((response) => response);
    await pickerOpened;
    try {
      expect(
        (await post('/browser-task/' + task.taskId + '/cancel').expect(200))
          .body.state,
      ).toBe('cancelled');
    } finally {
      picked(destination);
    }
    expect((await selection).status).toBe(200);
    await post('/browser-task/' + task.taskId + '/save').expect(409);
    expect((await get('/browser-task/' + task.taskId)).body.state).toBe(
      'cancelled',
    );
    expect(await readdir(destination)).toEqual([]);
    expect(download.buildArticleDownload).not.toHaveBeenCalled();
  });
  it('cancel revokes claimed transport and terminal status does not perform a save or mutate settings', async () => {
    const before = await readFile(settingsFile, 'utf8');
    const task = await issue(),
      claim = broker.claim(task.taskId, binding);
    expect(
      (await post('/browser-task/' + task.taskId + '/cancel').expect(200)).body
        .state,
    ).toBe('cancelled');
    expect(() =>
      broker.complete(task.taskId, claim.nonce, binding, observation()),
    ).toThrow('TASK_GONE');
    await post('/browser-task/' + task.taskId + '/save').expect(409);
    expect(await readFile(settingsFile, 'utf8')).toBe(before);
    expect(await readdir(destination)).toEqual([]);
  });
  it('app rejects destination/body/target substitutions, invalid URL and arbitrary publisher-list inputs', async () => {
    for (const extra of ['directory', 'mpId', 'urls', 'html', 'pairingKey'])
      await post('/browser-task', { url: short, [extra]: 'forbidden' }).expect(
        400,
      );
    await post('/browser-task', { url: 'http://127.0.0.1/private' }).expect(
      400,
    );
    await post('/browser-task', []).expect(400);
    const task = await issue();
    await post('/browser-task/' + task.taskId + '/cancel', []).expect(400);
    await post('/browser-task/' + task.taskId + '/save', []).expect(400);
    await post('/browser-task/' + task.taskId + '/cancel', {
      html: 'forbidden',
    }).expect(400);
    expect(download.buildArticleDownload).not.toHaveBeenCalled();
  });
  it('private mode cannot create or consume local article tasks', async () => {
    const task = await ready();
    process.env.PRIVATE_ONLINE_MODE = '1';
    await get('/browser-task').expect(403);
    await post('/browser-task', { url: short }).expect(403);
    await post('/browser-task/' + task.taskId + '/save').expect(403);
    expect(await readdir(destination)).toEqual([]);
  });
  it('pruned terminal metadata returns the exact missing-task HTTP contract without restarting collection or saving', async () => {
    const task = await ready();
    await post('/browser-task/' + task.taskId + '/cancel').expect(200);
    const originalSettings = await readFile(settingsFile, 'utf8');
    jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse(task.expiresAt) + 60_001);
    const result = await get('/browser-task/' + task.taskId).expect(410);
    expect(result.body.code).toBe('TASK_GONE');
    expect(await readFile(settingsFile, 'utf8')).toBe(originalSettings);
    expect(await readdir(destination)).toEqual([]);
    expect(download.buildArticleDownload).not.toHaveBeenCalled();
  });
  it('absent broker injection leaves production-style controller disabled without file or network writes', async () => {
    const m = await Test.createTestingModule({
      controllers: [ArticleDownloadController],
      providers: [{ provide: ConfigService, useValue: settings }],
    }).compile();
    const disabled = m.createNestApplication();
    await disabled.init();
    try {
      const headers = {
        host: '127.0.0.1',
        origin: 'http://127.0.0.1',
        authorization: 'fixture-access',
      };
      const status = await request(disabled.getHttpServer())
        .get('/download/article/browser-task')
        .set(headers)
        .expect(200);
      expect(status.body.available).toBe(false);
      expect(status.body.code).toBe('BROWSER_TASK_DISABLED');
      expect(
        (
          await request(disabled.getHttpServer())
            .post('/download/article/browser-task')
            .set(headers)
            .send({ url: short })
            .expect(409)
        ).body.code,
      ).toBe('BROWSER_TASK_DISABLED');
      expect(await readdir(destination)).toEqual([]);
    } finally {
      await disabled.close();
    }
  });
});
