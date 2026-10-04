import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { INestApplication, Logger } from '@nestjs/common';
import request from 'supertest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ArticleDownloadController } from './article-download.controller';
import * as download from './article-download';
import * as picker from './article-folder-picker';

const url = 'https://mp.weixin.qq.com/s/abcdefghijklmnopqrstuv';
describe('local article HTTP save and native directory selection, no upstream or database', () => {
  let app: INestApplication;
  let temporary: string;
  let destination: string;
  let settingsFile: string;
  const originalEnv = { ...process.env };
  const post = (endpoint = '', body: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .post('/download/article' + endpoint)
      .set('host', '127.0.0.1')
      .set('origin', 'http://127.0.0.1')
      .set('authorization', 'fixture-access')
      .send(body);
  beforeEach(async () => {
    delete process.env.PRIVATE_ONLINE_MODE;
    delete process.env.WEWE_ACCEPTANCE_MODE;
    temporary = await mkdtemp(join(tmpdir(), 'wewe-save-http-'));
    destination = join(temporary, '中文 Obsidian Vault');
    await mkdir(destination);
    process.env.DATABASE_URL = 'file:' + join(temporary, 'unused.sqlite');
    settingsFile = join(temporary, '.article-download-settings.json');
    await writeFile(
      settingsFile,
      JSON.stringify({ directory: destination, askEveryTime: false }),
    );
    const module = await Test.createTestingModule({
      controllers: [ArticleDownloadController],
      providers: [
        {
          provide: ConfigService,
          useValue: new ConfigService({ auth: { code: 'fixture-access' } }),
        },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    jest
      .spyOn(download, 'buildArticleDownload')
      .mockImplementation(async (_url, directory) => {
        await mkdir(join(directory, 'image'));
        await writeFile(join(directory, 'index.md'), '# 合成正文');
        return {
          filename: 'unused.zip',
          articleId: 'WX_123_456_1',
          title: '中文测试',
          imageCount: 0,
        };
      });
    jest.spyOn(picker, 'pickArticleDirectory').mockResolvedValue(destination);
  });
  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
    await rm(temporary, { recursive: true, force: true });
  });

  it('requires existing auth, loopback host and matching Origin before fetching or launching a picker', async () => {
    await request(app.getHttpServer())
      .post('/download/article')
      .send({ url })
      .expect(401);
    await post('', { url }).set('origin', 'https://evil.invalid').expect(403);
    await post('/directory')
      .set('host', 'attacker.invalid')
      .set('origin', 'http://attacker.invalid')
      .expect(403);
    await post('/directory').unset('origin').expect(403);
    expect(download.buildArticleDownload).not.toHaveBeenCalled();
    expect(picker.pickArticleDirectory).not.toHaveBeenCalled();
  });
  it('returns saved paths as JSON with real Markdown, no ZIP or download response', async () => {
    const response = await post('', { url }).expect(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers['content-disposition']).toBeUndefined();
    expect(response.body).toMatchObject({
      saved: true,
      alreadySaved: false,
      imageCount: 0,
    });
    expect(await readFile(response.body.markdownPath, 'utf8')).toBe(
      '# 合成正文',
    );
    expect(download.buildArticleDownload).toHaveBeenCalledWith(
      url,
      expect.any(String),
      undefined,
      { imageDirectory: 'image', markdownOnly: true },
    );
    expect(picker.pickArticleDirectory).not.toHaveBeenCalled();
  });
  it('cannot use a destination path from browser JSON', async () => {
    await post('', { url, directory: '/arbitrary' }).expect(400);
    await post('/settings', {
      askEveryTime: false,
      directory: '/arbitrary',
    }).expect(400);
    expect(download.buildArticleDownload).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(settingsFile, 'utf8')).directory).toBe(
      destination,
    );
  });
  it('cancels directory selection without changing settings or starting a download', async () => {
    jest.mocked(picker.pickArticleDirectory).mockResolvedValueOnce(null);
    expect((await post('/directory').expect(200)).body).toEqual({
      cancelled: true,
    });
    expect(JSON.parse(await readFile(settingsFile, 'utf8'))).toEqual({
      directory: destination,
      askEveryTime: false,
    });
    expect(download.buildArticleDownload).not.toHaveBeenCalled();
  });
  it('remembers a chosen path and disabling per-download prompting without resetting it', async () => {
    const other = join(temporary, '另一个 文件夹');
    await mkdir(other);
    jest.mocked(picker.pickArticleDirectory).mockResolvedValueOnce(other);
    expect((await post('/directory').expect(200)).body.directory).toBe(other);
    await post('/settings', { askEveryTime: true }).expect(200);
    await post('/settings', { askEveryTime: false }).expect(200);
    expect(JSON.parse(await readFile(settingsFile, 'utf8'))).toEqual({
      directory: other,
      askEveryTime: false,
    });
    await post('', { url }).expect(200);
    expect(picker.pickArticleDirectory).toHaveBeenCalledTimes(1);
  });
  it('requires and consumes a fresh native selection when asking every time', async () => {
    await post('/settings', { askEveryTime: true }).expect(200);
    await post('', { url }).expect(409);
    expect(download.buildArticleDownload).not.toHaveBeenCalled();
    const selection = await post('/directory').expect(200);
    await post('', { url, pickToken: selection.body.pickToken }).expect(200);
    await post('', { url, pickToken: selection.body.pickToken }).expect(409);
    expect(download.buildArticleDownload).toHaveBeenCalledTimes(1);
  });
  it('returns safe failure provenance without URL, credential or raw exception leaks', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    jest.mocked(download.buildArticleDownload).mockRejectedValueOnce(
      new download.ArticleDownloadError(
        '原文要求验证（HTTP 302），未完成保存。',
        422,
        {
          code: 'VERIFICATION_REDIRECT',
          stage: 'article',
          upstreamStatus: 302,
          redirectKind: 'verification',
        },
      ),
    );
    const response = await post('', {
      url: url + '?key=request-secret',
    }).expect(422);
    expect(response.body.code).toBe('VERIFICATION_REDIRECT');
    expect(response.body.upstreamStatus).toBe(302);
    expect(
      JSON.stringify(warn.mock.calls) + JSON.stringify(response.body),
    ).not.toMatch(/request-secret|fixture-access|mp\.weixin/);
    expect(response.body.saved).toBeUndefined();
  });
  it('does not unlock an in-flight valid save when a second request arrives', async () => {
    let release!: () => void;
    const block = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = jest
      .mocked(download.buildArticleDownload)
      .getMockImplementation()!;
    jest
      .mocked(download.buildArticleDownload)
      .mockImplementationOnce(async (...args) => {
        await block;
        return original(...args);
      });
    const pending = post('', { url }).then((response) => response);
    for (
      let i = 0;
      i < 30 && !jest.mocked(download.buildArticleDownload).mock.calls.length;
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    await post('', { url: 'invalid' }).expect(409);
    release();
    expect((await pending).status).toBe(200);
  });
  it('keeps acceptance mode and remote/private deployments from saving local files', async () => {
    process.env.WEWE_ACCEPTANCE_MODE = '1';
    await post('', { url }).expect(409);
    process.env.PRIVATE_ONLINE_MODE = '1';
    await post('', { url }).expect(403);
    expect(download.buildArticleDownload).not.toHaveBeenCalled();
  });
});
