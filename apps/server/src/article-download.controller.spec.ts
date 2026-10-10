import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { INestApplication, Logger } from '@nestjs/common';
import request from 'supertest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ArticleDownloadController } from './article-download.controller';
import * as download from './article-download';
import * as single from './wechat2rss-single-download';
import * as picker from './article-folder-picker';
import { LocalArticleStore } from './article-local-save';
import { PrismaService } from './prisma/prisma.service';
import {
  ARTICLE_VERIFICATION_TTL_MS,
  articleVerificationLocation,
} from '../../../packages/shared/src/article-verification';

const url = 'https://mp.weixin.qq.com/s/abcdefghijklmnopqrstuv';
describe('local article HTTP save and native directory selection, no upstream or database', () => {
  let app: INestApplication;
  let temporary: string;
  let destination: string;
  let settingsFile: string;
  const findMany = jest.fn();
  const originalEnv = { ...process.env };
  const post = (endpoint = '', body: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .post('/download/article' + endpoint)
      .set('host', '127.0.0.1')
      .set('origin', 'http://127.0.0.1')
      .set('authorization', 'fixture-access')
      .send(body);
  beforeEach(async () => {
    findMany.mockReset().mockResolvedValue([]);
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
        { provide: PrismaService, useValue: { article: { findMany } } },
        {
          provide: ConfigService,
          useValue: new ConfigService({ auth: { code: 'fixture-access' } }),
        },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    jest
      .spyOn(single, 'prepareWechat2RssSingleDownload')
      .mockImplementation(async () => async (directory) => {
        await mkdir(join(directory, 'image'));
        await writeFile(join(directory, 'index.md'), '# 合成Wechat2RSS正文');
        return {
          articleId: 'WX_123_456_1',
          title: '中文测试',
          imageCount: 0,
          source: 'wechat2rss' as const,
        };
      });
    jest
      .spyOn(download, 'buildArticleDownload')
      .mockRejectedValue(new Error('PUBLIC_ARTICLE_FORBIDDEN'));
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
    expect(single.prepareWechat2RssSingleDownload).not.toHaveBeenCalled();
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
      '# 合成Wechat2RSS正文',
    );
    expect(single.prepareWechat2RssSingleDownload).toHaveBeenCalledWith(url);
    expect(response.body.contentSource).toBe('wechat2rss-cache');
    expect(download.buildArticleDownload).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
    expect(picker.pickArticleDirectory).not.toHaveBeenCalled();
  });
  it('cannot use a destination path from browser JSON', async () => {
    await post('', { url, directory: '/arbitrary' }).expect(400);
    await post('/settings', {
      askEveryTime: false,
      directory: '/arbitrary',
    }).expect(400);
    expect(single.prepareWechat2RssSingleDownload).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(settingsFile, 'utf8')).directory).toBe(
      destination,
    );
  });

  it('does not use a complete old SQLite body with unproved source', async () => {
    findMany.mockResolvedValue([
      { id: 'legacy', sourceUrl: url, contentHtml: '<p>旧渠道正文</p>' },
    ]);
    const response = await post('', { url }).expect(200);
    expect(response.body.contentSource).toBe('wechat2rss-cache');
    expect(await readFile(response.body.markdownPath, 'utf8')).toBe(
      '# 合成Wechat2RSS正文',
    );
    expect(findMany).not.toHaveBeenCalled();
    expect(download.buildArticleDownload).not.toHaveBeenCalled();
  });
  it('keeps a missing Wechat2RSS cache from falling back to old SQLite or the public original', async () => {
    findMany.mockResolvedValue([
      { id: 'legacy', sourceUrl: url, contentHtml: '<p>旧缓存</p>' },
    ]);
    jest.mocked(single.prepareWechat2RssSingleDownload).mockRejectedValueOnce(
      new download.ArticleDownloadError('缓存缺失，不使用其他来源。', 409, {
        code: 'WECHAT2RSS_SINGLE_CACHE_MISS',
      }),
    );
    const response = await post('', { url }).expect(409);
    expect(response.body.code).toBe('WECHAT2RSS_SINGLE_CACHE_MISS');
    expect(findMany).not.toHaveBeenCalled();
    expect(download.buildArticleDownload).not.toHaveBeenCalled();
  });
  it('returns the actual safe verification Location only in the authenticated local error response, not logs or settings', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    const location =
      '/mp/wappoc_appmsgcaptcha?action=verify&r=12345&url=' +
      encodeURIComponent(url);
    const observed = articleVerificationLocation(location, url);
    jest.mocked(single.prepareWechat2RssSingleDownload).mockRejectedValueOnce(
      new download.ArticleDownloadError(
        'official verification required',
        422,
        {
          code: 'VERIFICATION_REDIRECT',
          stage: 'article',
          upstreamStatus: 302,
          redirectKind: 'verification',
        },
        observed,
      ),
    );
    const before = await readFile(settingsFile, 'utf8');
    const response = await post('', { url }).expect(422);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.body.verification).toMatchObject({
      status: 'available',
      articleUrl: url,
      url: 'https://mp.weixin.qq.com' + location,
    });
    const remaining =
      Date.parse(response.body.verification.expiresAt) - Date.now();
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(ARTICLE_VERIFICATION_TTL_MS);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(
      /wappoc_appmsgcaptcha|12345|https/,
    );
    expect(await readFile(settingsFile, 'utf8')).toBe(before);
    expect(single.prepareWechat2RssSingleDownload).toHaveBeenCalledTimes(1);
    expect(picker.pickArticleDirectory).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    '/mp/verify?ticket=fixture-sensitive',
    'https://evil.invalid/mp/verify',
  ])(
    'withholds a missing, sensitive or unsafe Location and never substitutes a homepage: %s',
    async (location) => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      jest.mocked(single.prepareWechat2RssSingleDownload).mockRejectedValueOnce(
        new download.ArticleDownloadError(
          'verification required',
          422,
          {
            code: 'VERIFICATION_REDIRECT',
            stage: 'article',
            upstreamStatus: 302,
            redirectKind: 'verification',
          },
          articleVerificationLocation(location, url),
        ),
      );
      const response = await post('', { url }).expect(422);
      expect(response.body.verification.status).toBe('unavailable');
      expect(response.body.verification.articleUrl).toBe(url);
      expect(response.body.verification.url).toBeUndefined();
      expect(JSON.stringify(response.body)).not.toMatch(
        /fixture-sensitive|evil\.invalid|weread\.qq\.com/,
      );
      expect(single.prepareWechat2RssSingleDownload).toHaveBeenCalledTimes(1);
    },
  );

  it('does not return another article verification context or an image redirect link', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const other = url.replace('abcdef', 'zzzzzz');
    jest.mocked(single.prepareWechat2RssSingleDownload).mockRejectedValueOnce(
      new download.ArticleDownloadError(
        'verification required',
        422,
        {
          code: 'VERIFICATION_REDIRECT',
          stage: 'article',
          upstreamStatus: 302,
          redirectKind: 'verification',
        },
        articleVerificationLocation('/mp/verify', other),
      ),
    );
    const first = await post('', { url }).expect(422);
    expect(first.body.verification.reason).toBe('missing-location');
    expect(first.body.verification.url).toBeUndefined();
    jest.mocked(single.prepareWechat2RssSingleDownload).mockRejectedValueOnce(
      new download.ArticleDownloadError(
        'image verification required',
        422,
        {
          code: 'VERIFICATION_REDIRECT',
          stage: 'image',
          upstreamStatus: 302,
          redirectKind: 'verification',
        },
        articleVerificationLocation('/mp/verify', url),
      ),
    );
    const second = await post('', { url }).expect(422);
    expect(second.body.verification).toBeUndefined();
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
    expect(single.prepareWechat2RssSingleDownload).not.toHaveBeenCalled();
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
    expect(single.prepareWechat2RssSingleDownload).not.toHaveBeenCalled();
    const selection = await post('/directory').expect(200);
    await post('', { url, pickToken: selection.body.pickToken }).expect(200);
    await post('', { url, pickToken: selection.body.pickToken }).expect(409);
    expect(single.prepareWechat2RssSingleDownload).toHaveBeenCalledTimes(1);
  });
  it('serializes a pending preference write with picking, downloading and other preference writes', async () => {
    let release!: () => void;
    let entered!: () => void;
    const block = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = LocalArticleStore.prototype.setAskEveryTime;
    jest
      .spyOn(LocalArticleStore.prototype, 'setAskEveryTime')
      .mockImplementationOnce(async function (this: LocalArticleStore, value) {
        entered();
        await block;
        return original.call(this, value);
      });
    const pending = post('/settings', { askEveryTime: true }).then(
      (response) => response,
    );
    try {
      await started;
      await post('/directory').expect(409);
      await post('', { url }).expect(409);
      await post('/settings', { askEveryTime: false }).expect(409);
      expect(picker.pickArticleDirectory).not.toHaveBeenCalled();
      expect(single.prepareWechat2RssSingleDownload).not.toHaveBeenCalled();
    } finally {
      release();
      await pending;
    }
    expect((await pending).status).toBe(200);
    expect(JSON.parse(await readFile(settingsFile, 'utf8'))).toEqual({
      directory: destination,
      askEveryTime: true,
    });
    // A completed settings write releases the lock and its new policy takes effect.
    await post('', { url }).expect(409);
    const selection = await post('/directory').expect(200);
    await post('', { url, pickToken: selection.body.pickToken }).expect(200);
  });
  it('releases the preference lock after a disk failure so a later selection can recover', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest
      .spyOn(LocalArticleStore.prototype, 'setAskEveryTime')
      .mockRejectedValueOnce(
        new download.ArticleDownloadError('settings write failed', 422, {
          code: 'SAVE_SETTINGS_UNAVAILABLE',
        }),
      );
    await post('/settings', { askEveryTime: true }).expect(422);
    await post('/directory').expect(200);
    await post('/settings', { askEveryTime: false }).expect(200);
    expect(JSON.parse(await readFile(settingsFile, 'utf8'))).toEqual({
      directory: destination,
      askEveryTime: false,
    });
  });
  it('returns safe failure provenance without URL, credential or raw exception leaks', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    jest.mocked(single.prepareWechat2RssSingleDownload).mockRejectedValueOnce(
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
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(
      /request-secret|fixture-access|mp\.weixin/,
    );
    expect(JSON.stringify(response.body)).not.toMatch(
      /request-secret|fixture-access/,
    );
    expect(response.body.verification).toMatchObject({
      status: 'unavailable',
      articleUrl: url,
      reason: 'missing-location',
    });
    expect(response.body.saved).toBeUndefined();
  });
  it('does not unlock an in-flight valid save when a second request arrives', async () => {
    let release!: () => void;
    const block = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = jest
      .mocked(single.prepareWechat2RssSingleDownload)
      .getMockImplementation()!;
    jest
      .mocked(single.prepareWechat2RssSingleDownload)
      .mockImplementationOnce(async (...args) => {
        await block;
        return original(...args);
      });
    const pending = post('', { url }).then((response) => response);
    for (
      let i = 0;
      i < 30 &&
      !jest.mocked(single.prepareWechat2RssSingleDownload).mock.calls.length;
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
    expect(single.prepareWechat2RssSingleDownload).not.toHaveBeenCalled();
  });
});
