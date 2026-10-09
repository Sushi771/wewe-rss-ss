import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { INestApplication, Logger } from '@nestjs/common';
import request from 'supertest';
import * as fs from 'node:fs/promises';
import { promises as mutableFs } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import axios from 'axios';
import { ArticleDownloadController } from './article-download.controller';
import { XiaohongshuService } from './collection/xiaohongshu.service';
import { PrismaService } from './prisma/prisma.service';
import * as picker from './article-folder-picker';
import { LocalArticleStore } from './article-local-save';
import { XHS_SINGLE_SOURCE, XhsSingleSource } from './xhs-single-download';
import { XhsNormalizedCandidate } from './collection/xiaohongshu-contract';
import { createHash } from 'node:crypto';

// Synthetic AVC-labelled sample container shared in meaning with the video
// contract fixture; it verifies HTTP/file transport, never successful decoding.
const mp4 = Buffer.from(
  'AAAAGGZ0eXBpc29tAAAAAGlzb21hdmMxAAACC21vb3YAAABsbXZoZAAAAAAAAAAAAAAAAAAAA+gAAAPoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGXdHJhawAAAFx0a2hkAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAPoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAEAAAAAABM21kaWEAAAAgbWRoZAAAAAAAAAAAAAAAAAAAA+gAAAPoAAAAAAAAACBoZGxyAAAAAAAAAAB2aWRlAAAAAAAAAAAAAAAAAAAA621pbmYAAADjc3RibAAAAHtzdHNkAAAAAAAAAAEAAABrYXZjMQAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAQABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABVhdmNDAUIACv/hAAFnAQABaAAAABhzdHRzAAAAAAAAAAEAAAABAAAD6AAAABxzdHNjAAAAAAAAAAEAAAABAAAAAQAAAAEAAAAYc3RzegAAAAAAAAAAAAAAAQAAAAgAAAAUc3RjbwAAAAAAAAABAAACKwAAABBtZGF0AAAABGWIhCE=',
  'base64',
);

const url =
  'https://www.xiaohongshu.com/explore/note-a?xsec_token=private-fixture';
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=';
const note = (): XhsNormalizedCandidate => ({
  authorId: 'verified-author',
  noteId: 'verified-note',
  kind: 'image-text',
  publishedAt: 1700000000,
  title: '完整笔记',
  text: '完整正文\n第二段 <保留文本>',
  textStatus: 'full',
  expectedImageCount: 1,
  images: [{ ordinal: 1, inlineData: 'data:image/png;base64,' + png }],
});
const cached = (id: string, creatorId = 'creator-a') => ({
  id,
  creatorId,
  title: id,
  publishTime: 1700000000,
  status: 'complete',
  kind: null,
  videoBytes: null,
  videoMimeType: null,
  videoExpectedBytes: null,
  videoSha256: null,
  contentHtml:
    '<div id="js_content"><p>缓存完整正文</p><img src="data:image/png;base64,' +
    png +
    '"></div>',
});
const batchPath = '/download/article/xiaohongshu/save';
const singlePath = '/download/article/xiaohongshu/single';

describe('XHS single tool and bounded cache batch use original local publication', () => {
  let app: INestApplication;
  let temporary: string;
  let destination: string;
  let sourceResult: Awaited<ReturnType<XhsSingleSource['read']>>;
  const sourceRead = jest.fn();
  const findFirst = jest.fn();
  const originalEnv = { ...process.env };
  const post = (path: string, body: object = {}) =>
    request(app.getHttpServer())
      .post(path)
      .set('host', '127.0.0.1')
      .set('origin', 'http://127.0.0.1')
      .set('authorization', 'fixture-access')
      .send(body);
  const get = (path: string) =>
    request(app.getHttpServer())
      .get(path)
      .set('host', '127.0.0.1')
      .set('authorization', 'fixture-access');
  const batch = (ids = ['note-a', 'note-b', 'note-c'], pickToken?: string) =>
    post(batchPath, {
      creatorId: 'creator-a',
      noteIds: ids,
      ...(pickToken ? { pickToken } : {}),
    });
  const files = async () => {
    const days = await fs.readdir(destination);
    return (
      await Promise.all(
        days.map(async (day) => {
          const directory = join(destination, day);
          return (await fs.readdir(directory)).map((entry) =>
            join(directory, entry),
          );
        }),
      )
    ).flat();
  };
  const boot = async (withSource = true, videoEvidenceSupported = false) => {
    const module = await Test.createTestingModule({
      controllers: [ArticleDownloadController],
      providers: [
        XiaohongshuService,
        {
          provide: ConfigService,
          useValue: new ConfigService({ auth: { code: 'fixture-access' } }),
        },
        {
          provide: PrismaService,
          useValue: {
            xhsNote: { findFirst },
            xhsCreator: {
              findUnique: async ({ where }: { where: { id: string } }) =>
                where.id === 'creator-a'
                  ? { id: 'creator-a', externalAuthorId: 'verified-author' }
                  : null,
            },
          },
        },
        ...(withSource
          ? [
              {
                provide: XHS_SINGLE_SOURCE,
                useValue: { read: sourceRead, videoEvidenceSupported },
              },
            ]
          : []),
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  };
  beforeEach(async () => {
    delete process.env.PRIVATE_ONLINE_MODE;
    delete process.env.WEWE_ACCEPTANCE_MODE;
    temporary = await fs.mkdtemp(join(tmpdir(), 'wewe-xhs-single-http-'));
    destination = join(temporary, 'output');
    await fs.mkdir(destination);
    process.env.DATABASE_URL = 'file:' + join(temporary, 'unused.sqlite');
    await fs.writeFile(
      join(temporary, '.article-download-settings.json'),
      JSON.stringify({ directory: destination, askEveryTime: false }),
    );
    sourceResult = { requestedUrl: url, evidenceVerified: true, note: note() };
    sourceRead.mockReset().mockImplementation(async () => sourceResult);
    findFirst
      .mockReset()
      .mockImplementation(async ({ where }) =>
        ['note-a', 'note-b', 'note-c'].includes(where.id) &&
        where.creatorId === 'creator-a'
          ? cached(where.id)
          : null,
      );
    jest.spyOn(axios, 'get').mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
    jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
    jest.spyOn(picker, 'pickArticleDirectory').mockResolvedValue(destination);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    await boot();
  });
  afterEach(async () => {
    expect(axios.get).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    await app.close();
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
    // Only the exact mkdtemp fixture is removed; no product database/directory.
    if (
      dirname(temporary) !== tmpdir() ||
      !temporary.split(/[\\/]/).pop()!.startsWith('wewe-xhs-single-http-')
    )
      throw new Error('UNSAFE_FIXTURE_CLEANUP');
    await fs.rm(temporary, { recursive: true, force: true });
  });

  it('saves internal video bytes through authenticated HTTP and reports container evidence without decoding', async () => {
    await app.close();
    await boot(true, true);
    sourceResult.note.kind = 'video';
    const sha256 = createHash('sha256').update(mp4).digest('hex');
    sourceResult.video = {
      bytes: mp4,
      expectedBytes: mp4.length,
      sha256,
      mimeType: 'video/mp4',
      complete: true,
    };
    expect((await get(singlePath)).body.videoAvailable).toBe(true);
    const saved = await post(singlePath, { url });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      saved: true,
      videoCount: 1,
      videoArchived: true,
      videoDecoded: false,
      videoVerification: 'container-and-bytes',
    });
    const folder = dirname(saved.body.markdownPath);
    const filename = 'video_' + sha256 + '.mp4';
    expect(await fs.readFile(join(folder, 'video', filename))).toEqual(mp4);
    const markdown = await fs.readFile(saved.body.markdownPath, 'utf8');
    expect(markdown).toContain('(video/' + filename + ')');
    expect(markdown).not.toContain('private-fixture');
    const marker = JSON.parse(
      await fs.readFile(join(folder, '.wewe-article.json'), 'utf8'),
    );
    expect(marker.videos).toEqual([{ filename, bytes: mp4.length, sha256 }]);
    await fs.appendFile(saved.body.markdownPath, '\nuser note kept\n');
    const repeated = await post(singlePath, { url });
    expect(repeated.body).toMatchObject({
      alreadySaved: true,
      videoCount: 1,
      videoDecoded: false,
    });
    expect(repeated.body.markdownPath).toBe(saved.body.markdownPath);
    expect(await fs.readFile(saved.body.markdownPath, 'utf8')).toContain(
      'user note kept',
    );
  });

  it('saves selected subscribed video cache through the original batch route and preserves repeated files', async () => {
    const id = JSON.stringify(['xiaohongshu', 'note', 'cached-video']);
    const sha256 = createHash('sha256').update(mp4).digest('hex');
    findFirst.mockImplementation(async ({ where }) =>
      where.id === id && where.creatorId === 'creator-a'
        ? {
            ...cached(id),
            kind: 'video',
            videoBytes: mp4,
            videoExpectedBytes: mp4.length,
            videoMimeType: 'video/mp4',
            videoSha256: sha256,
          }
        : null,
    );
    const first = await batch([id]);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      saved: true,
      savedCount: 1,
      alreadySavedCount: 0,
      videoCount: 1,
      videoDecoded: false,
      videoVerification: 'container-and-bytes',
    });
    const [folder] = await files();
    const markdownPath = join(folder, '正文.md');
    const filename = 'video_' + sha256 + '.mp4';
    expect(await fs.readFile(join(folder, 'video', filename))).toEqual(mp4);
    expect(await fs.readFile(markdownPath, 'utf8')).toContain(
      '(video/' + filename + ')',
    );
    const marker = JSON.parse(
      await fs.readFile(join(folder, '.wewe-article.json'), 'utf8'),
    );
    expect(marker.videos).toEqual([{ filename, bytes: mp4.length, sha256 }]);
    expect(marker.images).toHaveLength(1);
    await fs.appendFile(markdownPath, '\nuser subscribed video note kept\n');
    const repeated = await batch([id]);
    expect(repeated.status).toBe(200);
    expect(repeated.body).toMatchObject({
      savedCount: 0,
      alreadySavedCount: 1,
      videoCount: 1,
      videoDecoded: false,
    });
    expect(await files()).toEqual([folder]);
    expect(await fs.readFile(markdownPath, 'utf8')).toContain(
      'user subscribed video note kept',
    );
    expect(sourceRead).not.toHaveBeenCalled();
    const oneCached = await post(
      '/download/article/xiaohongshu/' + encodeURIComponent(id) + '/save',
      { creatorId: 'creator-a' },
    );
    expect(oneCached.status).toBe(200);
    expect(oneCached.body).toMatchObject({
      alreadySaved: true,
      videoCount: 1,
      videoDecoded: false,
      videoVerification: 'container-and-bytes',
      contentSource: 'saved-xiaohongshu',
    });
    expect(await files()).toEqual([folder]);
  });

  it('rejects damaged subscribed video bytes or mixed creator selections before any batch publication', async () => {
    const id = JSON.stringify(['xiaohongshu', 'note', 'cached-video']);
    const sha256 = createHash('sha256').update(mp4).digest('hex');
    findFirst.mockImplementation(async ({ where }) =>
      where.id === id && where.creatorId === 'creator-a'
        ? {
            ...cached(id),
            kind: 'video',
            videoBytes: mp4,
            videoExpectedBytes: mp4.length,
            videoMimeType: 'video/mp4',
            videoSha256: '0'.repeat(64),
          }
        : null,
    );
    expect((await batch([id])).status).toBe(422);
    expect(await files()).toEqual([]);
    findFirst.mockImplementation(async ({ where }) =>
      where.id === id && where.creatorId === 'creator-a'
        ? {
            ...cached(id),
            kind: 'video',
            videoBytes: mp4,
            videoExpectedBytes: mp4.length,
            videoMimeType: 'video/mp4',
            videoSha256: sha256,
          }
        : null,
    );
    expect((await batch([id, 'other-creator-note'])).status).toBe(422);
    expect(await files()).toEqual([]);
    expect(sourceRead).not.toHaveBeenCalled();
  });

  it('refuses mismatched declared video bytes without publishing a note or accepting uploaded media', async () => {
    sourceResult.note.kind = 'video';
    sourceResult.video = {
      bytes: mp4,
      expectedBytes: mp4.length + 1,
      sha256: createHash('sha256').update(mp4).digest('hex'),
      mimeType: 'video/mp4',
      complete: true,
    };
    expect((await post(singlePath, { url })).status).toBe(422);
    expect(await files()).toEqual([]);
    expect(
      (await post(singlePath, { url, video: mp4.toString('base64') })).status,
    ).toBe(400);
    expect(await files()).toEqual([]);
  });

  it('prevalidates every creator-bound cached identity before any batch files', async () => {
    findFirst.mockImplementation(async ({ where }) =>
      where.id === 'note-a' ? cached('note-a') : null,
    );
    expect((await batch(['note-a', 'other-creators-note'])).status).toBe(422);
    expect(findFirst.mock.calls.map(([arg]) => arg.where)).toEqual([
      { id: 'note-a', creatorId: 'creator-a', status: 'complete' },
      { id: 'other-creators-note', creatorId: 'creator-a', status: 'complete' },
    ]);
    expect(await fs.readdir(destination)).toEqual([]);
    expect(sourceRead).not.toHaveBeenCalled();
  });

  it('preserves first complete Markdown/PNG on second disk failure and never writes third', async () => {
    const originalCopy = fs.copyFile;
    let copies = 0;
    jest.spyOn(mutableFs, 'copyFile').mockImplementation(async (...args) => {
      if (++copies === 2)
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      await originalCopy(...args);
    });
    const result = await batch();
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({
      code: 'XHS_BATCH_SAVE_INCOMPLETE',
      savedCount: 1,
      alreadySavedCount: 0,
    });
    const folders = await files();
    expect(folders).toHaveLength(1);
    expect(await fs.readFile(join(folders[0], '正文.md'), 'utf8')).toContain(
      '缓存完整正文',
    );
    const images = await fs.readdir(join(folders[0], 'image'));
    expect(await fs.readFile(join(folders[0], 'image', images[0]))).toEqual(
      Buffer.from(png, 'base64'),
    );
    expect(copies).toBe(2);
  });

  it('uses one native grant for the whole batch, deduplicates IDs and preserves repeats', async () => {
    await post('/download/article/settings', { askEveryTime: true });
    expect((await batch()).status).toBe(409);
    const selected = await post('/download/article/directory');
    expect(
      (await batch(['note-a', 'note-a', 'note-b'], selected.body.pickToken))
        .body,
    ).toMatchObject({ saved: true, savedCount: 2, alreadySavedCount: 0 });
    expect((await batch(['note-a'], selected.body.pickToken)).status).toBe(409);
    const again = await post('/download/article/directory');
    expect(
      (await batch(['note-a', 'note-b'], again.body.pickToken)).body,
    ).toMatchObject({ savedCount: 0, alreadySavedCount: 2 });
    expect(await files()).toHaveLength(2);
    expect(picker.pickArticleDirectory).toHaveBeenCalledTimes(2);
  });

  it('cancelled picker revokes old grant and does not change directory or save', async () => {
    await post('/download/article/settings', { askEveryTime: true });
    const first = await post('/download/article/directory');
    jest.mocked(picker.pickArticleDirectory).mockResolvedValueOnce(null);
    expect((await post('/download/article/directory')).body).toEqual({
      cancelled: true,
    });
    expect((await batch(['note-a'], first.body.pickToken)).status).toBe(409);
    expect((await get('/download/article/settings')).body).toEqual({
      directory: destination,
      askEveryTime: true,
    });
    expect(await fs.readdir(destination)).toEqual([]);
  });

  it('holds global operation lock throughout prevalidation and file saving', async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    findFirst.mockImplementationOnce(async () => {
      entered();
      await pause;
      return cached('note-a');
    });
    const pending = batch(['note-a']).then((result) => result);
    await started;
    expect(
      (await post('/download/article/settings', { askEveryTime: true })).status,
    ).toBe(409);
    expect((await post('/download/article/directory')).status).toBe(409);
    expect((await batch(['note-b'])).status).toBe(409);
    expect((await post(singlePath, { url })).status).toBe(409);
    release();
    expect((await pending).status).toBe(200);
    expect(picker.pickArticleDirectory).not.toHaveBeenCalled();
  });

  it('picker and settings persistence exclude batch and single operations', async () => {
    let release!: (directory: string) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    jest.mocked(picker.pickArticleDirectory).mockImplementationOnce(() => {
      entered();
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    });
    const pending = post('/download/article/directory').then(
      (result) => result,
    );
    await started;
    expect((await batch()).status).toBe(409);
    expect((await post(singlePath, { url })).status).toBe(409);
    release(destination);
    await pending;
    const originalPersist = LocalArticleStore.prototype.setAskEveryTime;
    let releaseSetting!: () => void;
    let settingEntered!: () => void;
    const startedSetting = new Promise<void>((resolve) => {
      settingEntered = resolve;
    });
    const pause = new Promise<void>((resolve) => {
      releaseSetting = resolve;
    });
    jest
      .spyOn(LocalArticleStore.prototype, 'setAskEveryTime')
      .mockImplementationOnce(async function (this: LocalArticleStore, value) {
        settingEntered();
        await pause;
        return originalPersist.call(this, value);
      });
    const settings = post('/download/article/settings', {
      askEveryTime: true,
    }).then((result) => result);
    await startedSetting;
    expect((await batch()).status).toBe(409);
    expect((await post('/download/article/directory')).status).toBe(409);
    releaseSetting();
    expect((await settings).status).toBe(200);
  });

  it('retains authentication/local-origin/host/private-mode/acceptance gates on both new routes', async () => {
    for (const [path, body] of [
      [batchPath, { creatorId: 'creator-a', noteIds: ['note-a'] }],
      [singlePath, { url }],
    ] as const) {
      expect((await post(path, body).unset('authorization')).status).toBe(401);
      expect((await post(path, body).unset('origin')).status).toBe(403);
      expect((await post(path, body).set('host', 'evil.invalid')).status).toBe(
        403,
      );
      expect(
        (await post(path, body).set('origin', 'https://evil.invalid')).status,
      ).toBe(403);
      process.env.WEWE_ACCEPTANCE_MODE = '1';
      expect((await post(path, body)).status).toBe(409);
      delete process.env.WEWE_ACCEPTANCE_MODE;
      process.env.PRIVATE_ONLINE_MODE = '1';
      expect((await post(path, body)).status).toBe(403);
      delete process.env.PRIVATE_ONLINE_MODE;
    }
    expect(sourceRead).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
    expect(await fs.readdir(destination)).toEqual([]);
  });

  it('rejects caller paths/HTML and malformed or overlarge batches before lookup', async () => {
    for (const body of [
      { creatorId: 'creator-a', noteIds: [] },
      {
        creatorId: 'creator-a',
        noteIds: Array.from({ length: 101 }, () => 'note-a'),
      },
      { creatorId: 'creator-a', noteIds: ['note-a'], directory: destination },
      {
        creatorId: 'creator-a',
        noteIds: ['note-a'],
        contentHtml: cached('note-a').contentHtml,
      },
    ])
      expect((await post(batchPath, body)).status).toBe(400);
    expect((await post(singlePath, { url, note: note() })).status).toBe(400);
    expect(
      (
        await post('/download/article/settings', {
          directory: destination,
          askEveryTime: false,
        })
      ).status,
    ).toBe(400);
    expect(findFirst).not.toHaveBeenCalled();
    expect(sourceRead).not.toHaveBeenCalled();
  });

  it('default single capability is unavailable without subscribing, source access or any files', async () => {
    await app.close();
    await boot(false);
    expect((await get(singlePath)).body).toMatchObject({
      available: false,
      videoAvailable: false,
    });
    expect((await post(singlePath, { url })).body.code).toBe(
      'XHS_SINGLE_SOURCE_UNCONFIGURED',
    );
    expect(sourceRead).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
    expect(await fs.readdir(destination)).toEqual([]);
  });

  it('saves a verified standalone full note using real Markdown/PNG and stable identity repeat protection', async () => {
    const result = await post(singlePath, { url });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      saved: true,
      alreadySaved: false,
      imageCount: 1,
      videoArchived: false,
    });
    const markdown = await fs.readFile(result.body.markdownPath, 'utf8');
    expect(markdown).toContain('完整正文');
    expect(markdown).toContain('image/image_');
    expect(markdown).not.toContain('private-fixture');
    expect(markdown).not.toContain('mp.weixin.qq.com');
    const images = await fs.readdir(join(result.body.directory, 'image'));
    expect(
      await fs.readFile(join(result.body.directory, 'image', images[0])),
    ).toEqual(Buffer.from(png, 'base64'));
    expect((await post(singlePath, { url })).body).toMatchObject({
      alreadySaved: true,
      markdownPath: result.body.markdownPath,
    });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('consumes standalone grant once, requires fresh selection and blocks source before grant', async () => {
    await post('/download/article/settings', { askEveryTime: true });
    expect((await post(singlePath, { url })).status).toBe(409);
    expect(sourceRead).not.toHaveBeenCalled();
    const selected = await post('/download/article/directory');
    expect(
      (await post(singlePath, { url, pickToken: selected.body.pickToken }))
        .status,
    ).toBe(200);
    expect(
      (await post(singlePath, { url, pickToken: selected.body.pickToken }))
        .status,
    ).toBe(409);
    expect(sourceRead).toHaveBeenCalledTimes(1);
  });

  it('rejects shortlinks, outside URLs, incomplete/mismatched evidence and video without saving', async () => {
    for (const invalid of [
      'https://xhslink.com/a',
      'https://evil.invalid/explore/a',
      'http://www.xiaohongshu.com/explore/a',
    ])
      expect((await post(singlePath, { url: invalid })).status).toBe(400);
    expect(sourceRead).not.toHaveBeenCalled();
    for (const mutate of [
      () => {
        sourceResult.evidenceVerified = false;
      },
      () => {
        sourceResult.requestedUrl = url + 'other';
      },
      () => {
        sourceResult.note.textStatus = 'summary';
      },
      () => {
        sourceResult.note.expectedImageCount = 2;
      },
      () => {
        sourceResult.note.images[0].ordinal = 2;
      },
      () => {
        sourceResult.note.images[0].inlineData =
          'https://cdn.invalid/image.png';
      },
      () => {
        sourceResult.note.kind = 'video';
      },
    ]) {
      sourceResult = {
        requestedUrl: url,
        evidenceVerified: true,
        note: note(),
      };
      mutate();
      const result = await post(singlePath, { url });
      expect(result.status).toBe(422);
    }
    expect(await fs.readdir(destination)).toEqual([]);
  });
});
