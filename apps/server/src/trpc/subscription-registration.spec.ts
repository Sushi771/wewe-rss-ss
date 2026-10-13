import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import axios from 'axios';
import { TrpcModule } from './trpc.module';
import { TrpcService } from './trpc.service';
import { TrpcRouter } from './trpc.router';
import { PrismaService } from '../prisma/prisma.service';
import { SUBSCRIPTION_DISCOVERY } from '../collection/subscription-add';

describe('actual original product module registration, no platform calls', () => {
  it('registers the native adapter in TrpcModule and exposes the original account-selecting add capability', async () => {
    const get = jest
      .spyOn(axios, 'get')
      .mockRejectedValue(new Error('NO_EXTERNAL_NETWORK'));
    const post = jest
      .spyOn(axios, 'post')
      .mockRejectedValue(new Error('NO_EXTERNAL_NETWORK'));
    const app = await Test.createTestingModule({
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
      .useValue({ account: { findUnique: jest.fn().mockResolvedValue(null) } })
      .compile();
    try {
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
      await app.close();
      get.mockRestore();
      post.mockRestore();
    }
  });
});
