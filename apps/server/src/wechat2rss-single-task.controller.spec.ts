import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArticleDownloadController } from './article-download.controller';
import { TrpcService } from './trpc/trpc.service';
import { ArticleDownloadError } from './article-download';
import * as single from './wechat2rss-single-download';
import * as picker from './article-folder-picker';
import * as candidates from './wechat2rss-single-candidates';

describe('single download HTTP task receipts; isolated queue, no network or database', () => {
  let app: INestApplication,
    root: string,
    directory: string,
    consumer: { runDue(): Promise<void> };
  let ready: boolean;
  const batchId = '12345678-1234-1234-1234-123456789012';
  const url = 'https://mp.weixin.qq.com/s/abcdefghijklmnopqrstuv';
  const environment = { ...process.env };
  const queue = {
    registerSubscriptionConsumer: jest.fn(),
    wakeSubscriptionConsumer: jest.fn(),
    addSingleDownloadBatch: jest.fn(),
    subscriptionBatchList: jest.fn(),
    stopSubscriptionBatch: jest.fn(),
    resumeSubscriptionBatch: jest.fn(),
  };
  const post = (
    suffix: string,
    body: Record<string, unknown> = {},
    owner = 'synthetic-owner',
  ) =>
    request(app.getHttpServer())
      .post('/download/article' + suffix)
      .set('host', '127.0.0.1')
      .set('origin', 'http://127.0.0.1')
      .set('authorization', owner)
      .send(body);
  const get = (suffix: string, owner = 'synthetic-owner') =>
    request(app.getHttpServer())
      .get('/download/article' + suffix)
      .set('host', '127.0.0.1')
      .set('authorization', owner);
  beforeEach(async () => {
    delete process.env.PRIVATE_ONLINE_MODE;
    delete process.env.WEWE_ACCEPTANCE_MODE;
    root = await mkdtemp(join(tmpdir(), 'wewe-single-http-task-'));
    directory = join(root, 'Vault');
    await mkdir(directory);
    const database = join(root, 'synthetic.sqlite');
    await writeFile(database, '');
    process.env.DATABASE_URL = 'file:' + database;
    await writeFile(
      join(root, '.article-download-settings.json'),
      JSON.stringify({ directory, askEveryTime: false }),
    );
    ready = false;
    Object.values(queue).forEach((mock) => mock.mockReset());
    queue.registerSubscriptionConsumer.mockImplementation((c) => {
      consumer = c;
    });
    queue.addSingleDownloadBatch.mockResolvedValue({ batchId });
    queue.subscriptionBatchList.mockResolvedValue([
      {
        batchId,
        state: 'completed',
        items: [
          {
            state: 'succeeded',
            feedId: 'MP_WXS_1234567890',
            articleUrlHash: createHash('sha256').update(url).digest('hex'),
          },
        ],
      },
    ]);
    jest
      .spyOn(single, 'prepareWechat2RssSingleDownload')
      .mockImplementation(async () => {
        if (!ready)
          throw new ArticleDownloadError('缓存尚未就绪。', 409, {
            code: 'WECHAT2RSS_SINGLE_SHORT_UNAVAILABLE',
          });
        return async (temporary) => {
          await mkdir(join(temporary, 'image'));
          await writeFile(join(temporary, 'index.md'), '# 合成精确正文');
          return {
            articleId: 'WX_1234567890_2247000001_1',
            title: '合成',
            imageCount: 0,
            source: 'wechat2rss' as const,
          };
        };
      });
    jest.spyOn(picker, 'pickArticleDirectory').mockResolvedValue(directory);
    jest.spyOn(candidates, 'readWechat2RssSingleCandidates').mockResolvedValue([
      {
        articleId: 'WX_1234567890_2247000001_1',
        title: '明确选择缓存',
        publishTime: 1800000000,
        url: 'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA%3D%3D&mid=2247000001&idx=1&sn=abcdef',
      },
    ]);
    const module = await Test.createTestingModule({
      controllers: [ArticleDownloadController],
      providers: [
        {
          provide: ConfigService,
          useValue: new ConfigService({ auth: { code: '' } }),
        },
        { provide: TrpcService, useValue: queue },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
    process.env = { ...environment };
    await rm(root, { recursive: true, force: true });
  });
  it('cache hit saves immediately without adding a subscription', async () => {
    ready = true;
    const r = await post('', { url }).expect(200);
    expect(r.body.contentSource).toBe('wechat2rss-cache');
    expect(queue.addSingleDownloadBatch).not.toHaveBeenCalled();
    expect(await readFile(r.body.markdownPath, 'utf8')).toBe('# 合成精确正文');
  });
  it('candidate recovery exposes only title/date/identity and rejects URL, feed, directory and foreign-owner selection', async () => {
    const pending = await post('', { url }).expect(202);
    const id = pending.body.task.taskId;
    await consumer.runDue();
    await get('/single-task/' + id)
      .expect(200)
      .expect((r) => expect(r.body.state).toBe('failed'));
    const choices = await get('/single-task/' + id + '/candidates').expect(200);
    expect(choices.body.articles[0]).toEqual({
      articleId: 'WX_1234567890_2247000001_1',
      title: '明确选择缓存',
      publishTime: 1800000000,
    });
    await get('/single-task/' + id + '/candidates', 'foreign-owner').expect(
      404,
    );
    await post('/single-task/' + id + '/select', {
      articleId: choices.body.articles[0].articleId,
      directory,
    }).expect(400);
    await post('/single-task/' + id + '/select', {
      articleId: choices.body.articles[0].articleId,
      feedId: 'MP_WXS_9999999999',
    }).expect(400);
    await post('/single-task/' + id + '/select', { url }).expect(400);
    ready = true;
    await post('/single-task/' + id + '/select', {
      articleId: choices.body.articles[0].articleId,
    }).expect(202);
    await consumer.runDue();
    const saved = await get('/single-task/' + id).expect(200);
    expect(saved.body).toMatchObject({
      state: 'saved',
      destination: directory,
      selectedArticle: { articleId: choices.body.articles[0].articleId },
    });
    expect(await readFile(saved.body.markdownPath, 'utf8')).toBe(
      '# 合成精确正文',
    );
    expect(queue.addSingleDownloadBatch).toHaveBeenCalledTimes(1);
    expect(queue.resumeSubscriptionBatch).not.toHaveBeenCalled();
  });
  it('one click persists a pending task, shared consumer saves it and status reads remain local', async () => {
    const r = await post('', { url }).expect(202);
    const id = r.body.task.taskId;
    expect(r.body).toMatchObject({ pending: true, task: { state: 'waiting' } });
    expect(queue.addSingleDownloadBatch).not.toHaveBeenCalled();
    const duplicate = await post('', { url }).expect(202);
    expect(duplicate.body.task.taskId).toBe(id);
    ready = true;
    await consumer.runDue();
    const result = await get('/single-task/' + id).expect(200);
    expect(result.body).toMatchObject({
      state: 'saved',
      saved: true,
      contentSource: 'wechat2rss-cache',
    });
    expect(queue.addSingleDownloadBatch).toHaveBeenCalledTimes(1);
    expect(await readFile(result.body.markdownPath, 'utf8')).toBe(
      '# 合成精确正文',
    );
    await get('/single-tasks').expect(200);
    expect(queue.addSingleDownloadBatch).toHaveBeenCalledTimes(1);
  });
  it('owner scopes, malformed actions, cancellation and local/private access remain enforced', async () => {
    const r = await post('', { url }).expect(202);
    const id = r.body.task.taskId;
    expect(
      (await get('/single-tasks', 'different-owner').expect(200)).body.tasks,
    ).toEqual([]);
    await get('/single-task/' + id, 'different-owner').expect(404);
    await post('/single-task/' + id + '/cancel', {
      directory: '/arbitrary',
    }).expect(400);
    await post('/single-task/' + id + '/cancel').expect(200);
    await consumer.runDue();
    expect(queue.addSingleDownloadBatch).not.toHaveBeenCalled();
    await post('/single-task/' + id + '/resume')
      .set('origin', 'https://evil.invalid')
      .expect(403);
    process.env.PRIVATE_ONLINE_MODE = '1';
    await get('/single-tasks').expect(403);
  });
});
