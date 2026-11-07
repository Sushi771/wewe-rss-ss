beforeAll(
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- Observe this synthetic test process through the supported native writer fixture.
  require('../../../../scripts/local-release/writer-self.fixture.test.cjs')
    .prepareWriterSelf,
);
import { PrismaClient } from '@prisma/client';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import axios from 'axios';
import { TrpcModule } from './trpc.module';
import { TrpcService } from './trpc.service';
import { TrpcRouter } from './trpc.router';
import { PrismaService } from '../prisma/prisma.service';
import { SUBSCRIPTION_DISCOVERY } from '../collection/subscription-add';
import { projectWriterGate } from '../collection/project-writer-boundary';

describe('actual original product module registration, no platform calls', () => {
  it('registers the native adapter in TrpcModule and exposes the original account-selecting add capability', async () => {
    const get = jest
      .spyOn(axios, 'get')
      .mockRejectedValue(new Error('NO_EXTERNAL_NETWORK'));
    const post = jest
      .spyOn(axios, 'post')
      .mockRejectedValue(new Error('NO_EXTERNAL_NETWORK'));
    const previousUrl = process.env.DATABASE_URL;
    const previousLive = process.env.XHS_SUBSCRIPTION_LIVE_ENABLED;
    const folder = await mkdtemp(
      path.join(tmpdir(), 'subscription-registration-'),
    );
    const database = path.join(folder, 'registration.sqlite');
    process.env.DATABASE_URL = 'file:' + database.replace(/\\/g, '/');
    delete process.env.XHS_SUBSCRIPTION_LIVE_ENABLED;
    const db = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
    });
    let app: TestingModule | undefined;
    let lease: { close(): void } | undefined;
    try {
      // Materialize a real isolated SQLite file before the actual native runtime
      // binds its writer. This registration-only path performs no schema writes.
      await db.$queryRawUnsafe('PRAGMA user_version');
      lease = projectWriterGate().writerForUrl(
        process.env.DATABASE_URL,
        path.join(process.cwd(), 'prisma'),
      );
      jest.spyOn(db.account, 'findUnique').mockResolvedValue(null);
      app = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            isGlobal: true,
            ignoreEnvFile: true,
            load: [
              () => ({
                platform: { url: '' },
                feed: { updateDelayTime: 0 },
                auth: { code: 'synthetic-local-access' },
              }),
            ],
          }),
          TrpcModule,
        ],
      })
        .overrideProvider(PrismaService)
        .useValue(db)
        .compile();
      expect(app.get(SUBSCRIPTION_DISCOVERY).discover).toEqual(
        expect.any(Function),
      );
      expect(app.get(TrpcService).subscriptionAddCapability()).toMatchObject({
        available: true,
        requiresAccount: true,
        code: 'NATIVE_DIRECTORY_VALIDATION',
      });
      const caller = app
        .get(TrpcRouter)
        .appRouter.createCaller({ errorMsg: null, isLocal: true } as any);
      const result = await caller.feed.addFromArticle({
        articleUrl: 'https://mp.weixin.qq.com/s/' + 'a'.repeat(22),
        accountId: '123',
      });
      expect(result).toMatchObject({
        accepted: false,
        code: 'ACCOUNT_UNAVAILABLE',
      });
      expect(get).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
    } finally {
      await app?.close();
      await db.$disconnect();
      lease?.close();
      if (previousUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousUrl;
      if (previousLive === undefined)
        delete process.env.XHS_SUBSCRIPTION_LIVE_ENABLED;
      else process.env.XHS_SUBSCRIPTION_LIVE_ENABLED = previousLive;
      await rm(folder, { recursive: true, force: true });
      get.mockRestore();
      post.mockRestore();
    }
  });
});
