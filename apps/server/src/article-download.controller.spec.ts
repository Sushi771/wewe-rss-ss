import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { ArticleDownloadController } from './article-download.controller';
import * as download from './article-download';
import { newSession } from './private-access';

const url = 'https://mp.weixin.qq.com/s/abcdefghijklmnopqrstuv';

async function expectCleaned(directory: string) {
  for (let i = 0; i < 50; i++) {
    try {
      await access(directory);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Temporary export was not cleaned');
}

// Jest 29 cannot load archiver 8's native ESM. The browser acceptance script tests real ZIP packaging.
jest.mock('./offline-archive', () => ({
  archiveDirectory: async (_folder: string, archive: string) => {
    const fs = await import('node:fs/promises');
    await fs.writeFile(archive, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  },
}));

describe('article download HTTP, isolated controller and no database', () => {
  let app: INestApplication;
  let folder: string;
  const config = new ConfigService({
    auth: { code: 'fixture-access' },
    feed: { originUrl: 'http://localhost' },
  });
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    delete process.env.PRIVATE_ONLINE_MODE;
    delete process.env.WEWE_ACCEPTANCE_MODE;
    const module = await Test.createTestingModule({
      controllers: [ArticleDownloadController],
      providers: [{ provide: ConfigService, useValue: config }],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    jest
      .spyOn(download, 'buildArticleDownload')
      .mockImplementation(async (_url, directory) => {
        folder = directory;
        await writeFile(
          join(directory, 'index.md'),
          '# synthetic offline article',
        );
        return { filename: '离线测试.zip', imageCount: 0 };
      });
  });
  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it('requires the existing access code and rejects cross-origin requests before fetching', async () => {
    await request(app.getHttpServer())
      .post('/download/article')
      .send({ url })
      .expect(401);
    await request(app.getHttpServer())
      .post('/download/article')
      .set('authorization', 'fixture-access')
      .set('origin', 'https://evil.invalid')
      .send({ url })
      .expect(403);
    expect(download.buildArticleDownload).not.toHaveBeenCalled();
  });

  it('returns an authenticated ZIP and cleans up its temporary directory', async () => {
    const response = await request(app.getHttpServer())
      .post('/download/article')
      .set('authorization', 'fixture-access')
      .send({ url })
      .expect(200);
    expect(response.headers['content-type']).toMatch(/application\/zip/);
    expect(response.headers['content-disposition']).toContain(
      'filename*=UTF-8',
    );
    expect(response.headers['cache-control']).toBe('private, no-store');
    // Real ZIP contents and extraction are checked by the browser acceptance script.
    // Response completion and finally cleanup can settle in adjacent event-loop turns.
    await expectCleaned(folder);
  });

  it('returns invalid-link and verification errors without returning a ZIP', async () => {
    await request(app.getHttpServer())
      .post('/download/article')
      .set('authorization', 'fixture-access')
      .send({ url: 'https://127.0.0.1/private' })
      .expect(400);
    jest
      .mocked(download.buildArticleDownload)
      .mockImplementationOnce(async (_url, directory) => {
        folder = directory;
        await writeFile(join(directory, 'partial-image.png'), 'partial');
        throw new download.ArticleDownloadError(
          '原文需要验证，未生成下载文件。',
        );
      });
    const response = await request(app.getHttpServer())
      .post('/download/article')
      .set('authorization', 'fixture-access')
      .send({ url })
      .expect(422);
    expect(response.body.message).toContain('验证');
    await expectCleaned(folder);
    await request(app.getHttpServer())
      .post('/download/article')
      .set('authorization', 'fixture-access')
      .send({ url })
      .expect(200);
  });

  it('rejects a repeated in-flight download and permits the next request after completion', async () => {
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    jest
      .mocked(download.buildArticleDownload)
      .mockImplementationOnce(async (_url, directory) => {
        folder = directory;
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        await writeFile(join(directory, 'index.md'), '# synthetic');
        return { filename: 'article.zip', imageCount: 0 };
      });
    const first = request(app.getHttpServer())
      .post('/download/article')
      .set('authorization', 'fixture-access')
      .send({ url })
      .then((response) => response);
    await waiting;
    await request(app.getHttpServer())
      .post('/download/article')
      .set('authorization', 'fixture-access')
      .send({ url })
      .expect(409);
    expect(download.buildArticleDownload).toHaveBeenCalledTimes(1);
    release();
    expect((await first).status).toBe(200);
    await expectCleaned(folder);
    await request(app.getHttpServer())
      .post('/download/article')
      .set('authorization', 'fixture-access')
      .send({ url })
      .expect(200);
  });

  it('honors the private session and offline acceptance stop', async () => {
    process.env.PRIVATE_ONLINE_MODE = '1';
    process.env.AUTH_CODE = 'synthetic-private-access-code-123456';
    await request(app.getHttpServer())
      .post('/download/article')
      .set('authorization', 'fixture-access')
      .send({ url })
      .expect(401);
    const cookie = `wewe_private_session=${newSession()}`;
    process.env.WEWE_ACCEPTANCE_MODE = '1';
    await request(app.getHttpServer())
      .post('/download/article')
      .set('Cookie', cookie)
      .send({ url })
      .expect(409);
    expect(download.buildArticleDownload).not.toHaveBeenCalled();
    delete process.env.WEWE_ACCEPTANCE_MODE;
    await request(app.getHttpServer())
      .post('/download/article')
      .set('Cookie', cookie)
      .send({ url })
      .expect(200);
  });
});
