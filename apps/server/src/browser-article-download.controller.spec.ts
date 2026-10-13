import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { ArticleDownloadController } from './article-download.controller';
import { BrowserTaskBroker } from './browser-task';
import { BrowserArticleTasks } from './browser-article-tasks';
import * as single from './wechat2rss-single-download';
import * as download from './article-download';
import { config, short } from '../test/browser-task-fixture';

describe('Wechat2RSS-only article policy blocks alternate browser transport', () => {
  let app: INestApplication;
  let broker: BrowserTaskBroker;
  let controller: ArticleDownloadController;
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
  beforeEach(async () => {
    broker = new BrowserTaskBroker(config);
    const module = await Test.createTestingModule({
      controllers: [ArticleDownloadController],
      providers: [
        { provide: BrowserTaskBroker, useValue: broker },
        {
          provide: ConfigService,
          useValue: new ConfigService({ auth: { code: 'fixture-access' } }),
        },
      ],
    }).compile();
    controller = module.get(ArticleDownloadController);
    app = module.createNestApplication();
    await app.init();
    jest.spyOn(broker, 'issue');
    jest
      .spyOn(single, 'prepareWechat2RssSingleDownload')
      .mockRejectedValue(new Error('SOURCE_MUST_NOT_RUN'));
    jest
      .spyOn(download, 'buildArticleDownload')
      .mockRejectedValue(new Error('ORIGINAL_MUST_NOT_RUN'));
  });
  afterEach(async () => {
    await app.close();
    broker.close();
    jest.restoreAllMocks();
  });
  it('reports disabled browser-source capability even with an enabled broker', async () => {
    expect(broker.capability().available).toBe(true);
    expect((await get('/browser-task').expect(200)).body).toMatchObject({
      available: false,
      code: 'WECHAT2RSS_ONLY',
      refreshAvailable: false,
    });
  });
  it('retains original auth and Origin guards before rejecting new source tasks or saves', async () => {
    await post('/browser-task', { url: short })
      .unset('authorization')
      .expect(401);
    await post('/browser-task', { url: short })
      .set('origin', 'https://evil.invalid')
      .expect(403);
    await post('/browser-task').unset('origin').expect(403);
    expect(
      (await post('/browser-task', { url: short }).expect(409)).body.code,
    ).toBe('WECHAT2RSS_ONLY');
    await post('/browser-task/00000000-0000-0000-0000-000000000000/save')
      .unset('authorization')
      .expect(401);
    expect(
      (
        await post(
          '/browser-task/00000000-0000-0000-0000-000000000000/save',
        ).expect(409)
      ).body.code,
    ).toBe('WECHAT2RSS_ONLY');
    expect(broker.issue).not.toHaveBeenCalled();
    expect(single.prepareWechat2RssSingleDownload).not.toHaveBeenCalled();
    expect(download.buildArticleDownload).not.toHaveBeenCalled();
  });
  it('keeps pre-existing task status and cancellation available but never saves its alternate-source body', async () => {
    const tasks = (
      controller as unknown as { browserTasks: BrowserArticleTasks }
    ).browserTasks;
    const owner = createHash('sha256').update('fixture-access').digest('hex');
    const issued = tasks.issue(short, owner);
    expect(
      (await get('/browser-task/' + issued.taskId).expect(200)).body.state,
    ).toBe('waiting');
    expect(
      (await post('/browser-task/' + issued.taskId + '/save').expect(409)).body
        .code,
    ).toBe('WECHAT2RSS_ONLY');
    expect(
      (await post('/browser-task/' + issued.taskId + '/cancel').expect(200))
        .body.state,
    ).toBe('cancelled');
    expect(download.buildArticleDownload).not.toHaveBeenCalled();
    expect(single.prepareWechat2RssSingleDownload).not.toHaveBeenCalled();
  });
  it('rejects caller supplied body or provider selection at the normal endpoint', async () => {
    await post('', {
      url: short,
      contentHtml: '<p>unproved</p>',
      source: 'wechat2rss',
    }).expect(400);
    expect(single.prepareWechat2RssSingleDownload).not.toHaveBeenCalled();
    expect(download.buildArticleDownload).not.toHaveBeenCalled();
  });
});
