import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { INestApplication, Logger } from '@nestjs/common';
import express, { json } from 'express';
import request from 'supertest';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import axios from 'axios';
import { BrowserTaskBroker } from './browser-task';
import { BrowserTaskController } from './browser-task.controller';
import { browserTaskBodyParser } from './browser-task.parser';
import { ArticleDownloadController } from './article-download.controller';
import { PrismaService } from './prisma/prisma.service';
import {
  config,
  binding,
  observation,
  short,
  png,
} from '../test/browser-task-fixture';

describe('offline browser completion → existing authorized save and image exporter', () => {
  let app: INestApplication;
  let broker: BrowserTaskBroker;
  let temporary: string;
  let destination: string;
  const environment = { ...process.env };
  const post = (stage: string, body: object) =>
    request(app.getHttpServer())
      .post('/browser-task/' + stage)
      .set('host', '127.0.0.1:11207')
      .set('origin', config.extensionOrigin)
      .set('X-WeWe-Pairing', config.pairingKey)
      .send(body);
  beforeEach(async () => {
    delete process.env.PRIVATE_ONLINE_MODE;
    delete process.env.WEWE_ACCEPTANCE_MODE;
    temporary = await mkdtemp(join(tmpdir(), 'wewe-browser-task-'));
    destination = join(temporary, 'output');
    await mkdir(destination);
    process.env.DATABASE_URL = 'file:' + join(temporary, 'unused.sqlite');
    await writeFile(
      join(temporary, '.article-download-settings.json'),
      JSON.stringify({ directory: destination, askEveryTime: false }),
    );
    broker = new BrowserTaskBroker(config);
    const module = await Test.createTestingModule({
      controllers: [BrowserTaskController, ArticleDownloadController],
      providers: [
        { provide: BrowserTaskBroker, useValue: broker },
        {
          provide: ConfigService,
          useValue: new ConfigService({ auth: { code: 'fixture-access' } }),
        },
        {
          provide: PrismaService,
          useValue: {
            article: {
              findMany: () => {
                throw new Error('DATABASE_FORBIDDEN');
              },
            },
          },
        },
      ],
    }).compile();
    app = module.createNestApplication({ bodyParser: false });
    app.use('/browser-task', browserTaskBodyParser(broker));
    app.use(json({ limit: '10mb' }));
    await app.init();
    jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
    jest.spyOn(axios, 'get').mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => {
    expect(global.fetch).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
    broker.close();
    await app.close();
    jest.restoreAllMocks();
    process.env = { ...environment };
    await rm(temporary, { recursive: true, force: true });
  });
  it('HTTP claim/complete then original internal save preserves note on repeat and writes actual image bytes', async () => {
    const task = broker.issue({ url: short });
    const claim = await post('claim', { taskId: task.taskId, binding });
    expect(claim.status).toBe(200);
    expect(
      (
        await post('complete', {
          taskId: task.taskId,
          binding,
          nonce: claim.body.nonce,
          observation: observation(),
        })
      ).body,
    ).toEqual({ accepted: true });
    const article = await task.result;
    // Original owner request is kept on the local side. Extension Origin is
    // never rewritten/passed as the authorized WeWe request.
    const req = {
      protocol: 'http',
      get: (field: string) =>
        field === 'host' ? '127.0.0.1:11207' : undefined,
      socket: { remoteAddress: '127.0.0.1' },
      headers: {
        origin: 'http://127.0.0.1:11207',
        authorization: 'fixture-access',
      },
    } as any;
    const response = () => {
      const value: any = { code: 200, data: null };
      value.status = (code: number) => {
        value.code = code;
        return value;
      };
      value.setHeader = () => value;
      value.json = (data: unknown) => {
        value.data = data;
        return value;
      };
      return value;
    };
    const first = response();
    await app
      .get(ArticleDownloadController)
      .saveVerifiedArticle(article, { url: short }, req, first);
    expect(first.data).toMatchObject({
      saved: true,
      contentSource: 'verified-provider',
      imageCount: 1,
      alreadySaved: false,
    });
    const images = await readdir(join(first.data.directory, 'image'));
    expect(
      await readFile(join(first.data.directory, 'image', images[0])),
    ).toEqual(Buffer.from(png, 'base64'));
    await writeFile(first.data.markdownPath, '用户旧笔记不得覆盖');
    const repeat = response();
    await app
      .get(ArticleDownloadController)
      .saveVerifiedArticle(article, { url: short }, req, repeat);
    expect(repeat.data.alreadySaved).toBe(true);
    expect(await readFile(first.data.markdownPath, 'utf8')).toBe(
      '用户旧笔记不得覆盖',
    );
    const unauthenticated = response();
    await app
      .get(ArticleDownloadController)
      .saveVerifiedArticle(
        article,
        { url: short },
        { ...req, headers: { origin: req.headers.origin } },
        unauthenticated,
      );
    expect(unauthenticated.code).toBe(401);
  });
  it('browser cannot issue tasks or submit ProviderArticle/HTML without a task', async () => {
    expect((await post('issue', { url: short })).status).toBe(404);
    expect(
      (await post('complete', { article: observation(), html: 'untrusted' }))
        .status,
    ).toBe(400);
    expect(await readdir(destination)).toEqual([]);
  });
  it('CORS preflight is exact and does not grant credentials', async () => {
    const valid = await request(app.getHttpServer())
      .options('/browser-task/complete')
      .set('host', '127.0.0.1:11207')
      .set('origin', config.extensionOrigin)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,x-wewe-pairing');
    expect(valid.status).toBe(204);
    expect(valid.headers['access-control-allow-credentials']).toBeUndefined();
    expect(
      (await post('claim', {}).set('origin', 'https://evil.invalid')).status,
    ).toBe(403);
    expect((await post('claim', {}).unset('X-WeWe-Pairing')).status).toBe(401);
  });
  it('actual main 10mb parser rejects a valid image payload; scoped authenticated parser accepts it', async () => {
    expect(readFileSync(join(__dirname, 'main.ts'), 'utf8')).toContain(
      "json({ limit: '10mb' })",
    );
    // A valid synthetic PNG with incompressible RGB pixels, not padding or a
    // malformed MIME claim. The actual bytes remain under the single-image cap.
    const width = 2100,
      height = 1300,
      row = width * 3 + 1;
    const pixels = randomBytes(row * height);
    for (let y = 0; y < height; y++) pixels[y * row] = 0;
    const crc = (bytes: Buffer) => {
      let value = 0xffffffff;
      for (const byte of bytes) {
        value ^= byte;
        for (let i = 0; i < 8; i++)
          value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
      }
      return (value ^ 0xffffffff) >>> 0;
    };
    const chunk = (name: string, data: Buffer) => {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(data.length);
      const content = Buffer.concat([Buffer.from(name), data]);
      const checksum = Buffer.alloc(4);
      checksum.writeUInt32BE(crc(content));
      return Buffer.concat([header, content, checksum]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const bytes = Buffer.concat([
      Buffer.from('89504e470d0a1a0a', 'hex'),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(pixels)),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    const large = observation();
    large.images[0].inline =
      'data:image/png;base64,' + bytes.toString('base64');
    const task = broker.issue({ url: short });
    const claim = await post('claim', { taskId: task.taskId, binding });
    const payload = {
      taskId: task.taskId,
      binding,
      nonce: claim.body.nonce,
      observation: large,
    };
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeGreaterThan(
      10 * 1024 * 1024,
    );
    const original = express();
    original.use(json({ limit: '10mb' }));
    original.post('/complete', (_req, res) => res.json({ accepted: true }));
    original.use((error: any, _req: any, res: any, next: any) => {
      void next; // Express identifies error middleware by its four parameters.
      res.status(error.status || 500).end();
    });
    expect(
      (await request(original).post('/complete').send(payload)).status,
    ).toBe(413);
    expect(
      (
        await request(app.getHttpServer())
          .post('/browser-task/complete')
          .set('host', '127.0.0.1:11207')
          .set('origin', config.extensionOrigin)
          .set('content-type', 'application/json')
          .send('{')
      ).status,
    ).toBe(401);
    // The HTTP boundary deliberately hides internal failures. Keep the actual
    // synthetic completion error visible here for cross-runtime CI diagnosis.
    const complete = broker.complete.bind(broker);
    let completionError: unknown;
    jest.spyOn(broker, 'complete').mockImplementation((...args) => {
      try {
        return complete(...args);
      } catch (error) {
        completionError = error;
        throw error;
      }
    });
    const completed = await post('complete', payload);
    if (completionError) throw completionError;
    expect(completed.body).toEqual({ accepted: true });
    expect((await task.result).contentHtml).toContain(large.images[0].inline);
  }, 60000);
});
