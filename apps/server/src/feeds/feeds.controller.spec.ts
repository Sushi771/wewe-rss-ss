import { Test, TestingModule } from '@nestjs/testing';
import { FeedsController } from './feeds.controller';
import { FeedsService } from './feeds.service';

describe('FeedsController', () => {
  let controller: FeedsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [FeedsController],
      providers: [
        {
          provide: FeedsService,
          useValue: {
            getFeedList: jest
              .fn()
              .mockResolvedValue([{ id: 'test', name: '测试号' }]),
          },
        },
      ],
    }).compile();

    controller = module.get<FeedsController>(FeedsController);
  });

  it('returns the subscription list', async () => {
    expect(await controller.getFeedList()).toEqual([
      { id: 'test', name: '测试号' },
    ]);
  });
});
