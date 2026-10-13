import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  Body,
  Controller,
  INestApplication,
  Logger,
  Post,
  Request,
  Response,
} from '@nestjs/common';
import { Request as Req, Response as Res } from 'express';
import request from 'supertest';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import axios from 'axios';
import { ArticleDownloadController } from './article-download.controller';
import { LocalArticleStore } from './article-local-save';
import * as picker from './article-folder-picker';
import { PrismaService } from './prisma/prisma.service';
import { ProviderArticle } from './collection/subscription-provider';
import { canonicalArticleUrl } from './collection/collection-format';

const short = 'https://mp.weixin.qq.com/s/abcdefghijklmnopqrstuv';
const canonical = canonicalArticleUrl(
  'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA%3D%3D&mid=2247000001&idx=1&sn=abcd',
);
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=';
const provider = (): ProviderArticle => ({
  id: canonical.id,
  mpId: canonical.mpId,
  url: canonical.url,
  shortUrl: short,
  title: '已核验正文',
  publishTime: 1700000000,
  contentHtml: `<div id="js_content"><p>完整正文</p><img src="data:image/png;base64,${png}"></div>`,
  picUrl: '',
});

describe('internal Provider completion cannot bypass Wechat2RSS-only saving', () => {
  let app: INestApplication;
  let temporary: string;
  let destination: string;
  let result: ProviderArticle;
  const findMany = jest.fn();
  const originalEnv = { ...process.env };
  const post = (
    path = '/test-only/normal-completion',
    body: Record<string, unknown> = { url: short },
  ) =>
    request(app.getHttpServer())
      .post(path)
      .set('host', '127.0.0.1')
      .set('origin', 'http://127.0.0.1')
      .set('authorization', 'fixture-access')
      .send(body);

  beforeEach(async () => {
    result = provider();
    findMany.mockReset();
    delete process.env.PRIVATE_ONLINE_MODE;
    delete process.env.WEWE_ACCEPTANCE_MODE;
    temporary = await mkdtemp(join(tmpdir(), 'wewe-completion-http-'));
    destination = join(temporary, '指定目录');
    await mkdir(destination);
    process.env.DATABASE_URL = 'file:' + join(temporary, 'unused.sqlite');
    await writeFile(
      join(temporary, '.article-download-settings.json'),
      JSON.stringify({ directory: destination, askEveryTime: false }),
    );
    // Only this spec installs a route for the internal normal-flow call.
    @Controller('test-only')
    class CompletionHarness {
      @Post('normal-completion')
      complete(
        @Body() body: { url?: unknown; pickToken?: unknown },
        @Request() req: Req,
        @Response() res: Res,
      ) {
        return app
          .get(ArticleDownloadController)
          .saveVerifiedArticle(result, body, req, res);
      }
    }
    const module = await Test.createTestingModule({
      controllers: [ArticleDownloadController, CompletionHarness],
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
    jest.spyOn(axios, 'get').mockRejectedValue(new Error('NO_UPSTREAM'));
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('NO_UPSTREAM'));
    jest.spyOn(picker, 'pickArticleDirectory').mockResolvedValue(destination);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => {
    expect(axios.get).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
    await app.close();
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
    await rm(temporary, { recursive: true, force: true });
  });

  it('refuses even well-formed other-source bytes without database access or file publication', async () => {
    const first = await post();
    expect(first.status).toBe(409);
    expect(first.body).toMatchObject({ code: 'WECHAT2RSS_ONLY' });
    expect((await post()).body).toMatchObject({ code: 'WECHAT2RSS_ONLY' });
    expect(await readdir(destination)).toEqual([]);
  });

  it('retains auth, origin, host and acceptance-mode gates before any file publication', async () => {
    expect((await post().unset('authorization')).status).toBe(401);
    expect(
      (await post().set('origin', 'https://mp.weixin.qq.com')).status,
    ).toBe(403);
    expect((await post().set('host', 'evil.invalid')).status).toBe(403);
    process.env.WEWE_ACCEPTANCE_MODE = '1';
    expect((await post()).status).toBe(409);
    expect(await readdir(destination)).toEqual([]);
  });

  it('does not expose the internal method or accept HTML/provider/path via the existing JSON endpoint', async () => {
    expect((await post('/download/article/verified')).status).toBe(404);
    const external = await request(app.getHttpServer())
      .post('/download/article')
      .set('host', '127.0.0.1')
      .set('origin', 'http://127.0.0.1')
      .set('authorization', 'fixture-access')
      .send({ url: short, article: result, directory: destination });
    expect(external.status).toBe(400);
    expect(await readdir(destination)).toEqual([]);
  });

  it('a native directory grant never authorizes another-source Provider completion', async () => {
    await post('/download/article/settings', { askEveryTime: true } as any);
    expect((await post()).status).toBe(409);
    const picked = await post('/download/article/directory');
    expect(picked.status).toBe(200);
    expect(
      (
        await post('/test-only/normal-completion', {
          url: short,
          pickToken: picked.body.pickToken,
        } as any)
      ).status,
    ).toBe(409);
    expect(
      (
        await post('/test-only/normal-completion', {
          url: short,
          pickToken: picked.body.pickToken,
        } as any)
      ).status,
    ).toBe(409);
    expect(await readdir(destination)).toEqual([]);
  });

  it.each([
    ['wrong target', { shortUrl: short.replace('abcdef', 'zzzzzz') }],
    ['missing result', null],
    [
      'remote image',
      {
        contentHtml:
          '<div id="js_content"><img src="https://mmbiz.qpic.cn/a.jpg"></div>',
      },
    ],
  ])(
    'fails %s without fallback and releases the original lock',
    async (_name, patch) => {
      result =
        patch === null
          ? (null as unknown as ProviderArticle)
          : { ...provider(), ...patch };
      const failed = await post();
      expect(failed.status).toBe(409);
      expect(failed.body.code).toBe('WECHAT2RSS_ONLY');
      expect(failed.body.saved).toBeUndefined();
      expect(await readdir(destination)).toEqual([]);
      expect(
        (
          await post('/download/article/settings', {
            askEveryTime: false,
          } as any)
        ).status,
      ).toBe(200);
    },
  );

  it('rejecting a Provider never enters the save lock or blocks later settings operations', async () => {
    const save = jest.spyOn(LocalArticleStore.prototype, 'save');
    expect((await post()).status).toBe(409);
    expect(save).not.toHaveBeenCalled();
    expect(
      (await post('/download/article/settings', { askEveryTime: true })).status,
    ).toBe(200);
    expect((await post('/download/article/directory')).status).toBe(200);
    expect((await post()).status).toBe(409);
    expect(await readdir(destination)).toEqual([]);
  });
});
