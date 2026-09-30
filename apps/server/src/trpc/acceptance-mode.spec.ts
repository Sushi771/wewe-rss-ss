import { TrpcService } from './trpc.service';

describe('isolated read/export trial', () => {
  const previous = process.env.WEWE_ACCEPTANCE_MODE;
  afterEach(() => {
    if (previous === undefined) delete process.env.WEWE_ACCEPTANCE_MODE;
    else process.env.WEWE_ACCEPTANCE_MODE = previous;
  });
  function caller(errorMsg: string | null = null) {
    const service = new TrpcService(
      {} as any,
      {
        get: (key: string) =>
          key === 'platform'
            ? { url: 'https://invalid.example' }
            : { updateDelayTime: 0 },
      } as any,
      {} as any,
      {} as any,
    );
    const execute = jest.fn(() => 'done');
    const router = service.router({
      feed: service.router({
        refreshArticles: service.protectedProcedure.mutation(execute),
      }),
      article: service.router({
        exportMarkdown: service.protectedProcedure.mutation(execute),
      }),
    });
    return { call: router.createCaller({ errorMsg }), execute };
  }
  it('rejects the ordinary update before invoking any collection code', async () => {
    process.env.WEWE_ACCEPTANCE_MODE = '1';
    const { call, execute } = caller();
    await expect(call.feed.refreshArticles()).rejects.toThrow(
      '普通更新尚未接通',
    );
    expect(execute).not.toHaveBeenCalled();
  });
  it('keeps authenticated exports usable', async () => {
    process.env.WEWE_ACCEPTANCE_MODE = '1';
    const { call, execute } = caller();
    await expect(call.article.exportMarkdown()).resolves.toBe('done');
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('does not bypass the existing authentication guard for exports', async () => {
    process.env.WEWE_ACCEPTANCE_MODE = '1';
    const { call, execute } = caller('请先登录');
    await expect(call.article.exportMarkdown()).rejects.toThrow('请先登录');
    expect(execute).not.toHaveBeenCalled();
  });
  it('leaves the ordinary application update procedure unchanged', async () => {
    delete process.env.WEWE_ACCEPTANCE_MODE;
    const { call } = caller();
    await expect(call.feed.refreshArticles()).resolves.toBe('done');
  });
});
