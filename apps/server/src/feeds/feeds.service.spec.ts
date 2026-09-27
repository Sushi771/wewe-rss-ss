import { Test, TestingModule } from '@nestjs/testing';
import { FeedsService } from './feeds.service';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { TrpcService } from '../trpc/trpc.service';

describe('FeedsService', () => {
  let service: FeedsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FeedsService,
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: PrismaService, useValue: {} },
        { provide: TrpcService, useValue: {} },
      ],
    }).compile();

    service = module.get<FeedsService>(FeedsService);
  });

  it('uses imported full text without requesting WeChat', async () => {
    const fetch = jest.spyOn(service, 'getHtmlByUrl');
    expect(
      await service.tryGetContent(
        'id',
        'https://mp.weixin.qq.com/s?id=1',
        '<p>本地正文</p>',
      ),
    ).toBe('<p>本地正文</p>');
    expect(fetch).not.toHaveBeenCalled();
  });
});
