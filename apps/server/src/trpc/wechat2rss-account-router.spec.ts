import { TrpcRouter } from './trpc.router';
import { TrpcService } from './trpc.service';

describe('protected Wechat2RSS account actions', () => {
  const sessionId = 'bd792847-72c5-41ee-87e0-f80b6d08445f';
  const config = {
    get: (key: string) =>
      key === 'platform' ? { url: '' } : { updateDelayTime: 0 },
  };

  function setup() {
    const service = new TrpcService(
      {} as any,
      config as any,
      {} as any,
      {} as any,
    );
    const router = new TrpcRouter(
      service,
      {} as any,
      config as any,
      {} as any,
      {} as any,
    );
    const accounts = (router as any).wechat2RssAccounts;
    const list = jest
      .spyOn(accounts, 'list')
      .mockResolvedValue({ accounts: [] });
    const start = jest.spyOn(accounts, 'start').mockResolvedValue({
      state: 'waiting',
      sessionId,
    });
    const poll = jest.spyOn(accounts, 'poll').mockResolvedValue({
      state: 'waiting',
      sessionId,
    });
    const close = jest
      .spyOn(accounts, 'close')
      .mockReturnValue({ state: 'closed' });
    return { router, list, start, poll, close };
  }

  it('rejects unauthenticated callers before any account action', async () => {
    const { router, list, start, poll, close } = setup();
    const caller = router.appRouter.createCaller({ errorMsg: '请先登录' });
    for (const action of [
      () => caller.account.wechat2rssAccounts(),
      () => caller.account.wechat2rssLoginStart(),
      () => caller.account.wechat2rssLoginPoll({ sessionId }),
      () => caller.account.wechat2rssLoginClose({ sessionId }),
    ])
      await expect(action()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    for (const action of [list, start, poll, close])
      expect(action).not.toHaveBeenCalled();
  });

  it('keeps login lifecycle as mutations and list as a query', () => {
    const { router } = setup();
    const procedures = router.appRouter._def.procedures;
    expect(procedures['account.wechat2rssAccounts']._def.query).toBe(true);
    for (const name of [
      'wechat2rssLoginStart',
      'wechat2rssLoginPoll',
      'wechat2rssLoginClose',
    ]) {
      expect(procedures[`account.${name}`]._def.mutation).toBe(true);
      expect(procedures[`account.${name}`]._def.query).not.toBe(true);
    }
  });

  it('accepts only opaque UUID handles and calls each selected action once', async () => {
    const { router, list, start, poll, close } = setup();
    const caller = router.appRouter.createCaller({ errorMsg: null });
    for (const action of [
      () => caller.account.wechat2rssLoginPoll({ sessionId: 'not-a-session' }),
      () => caller.account.wechat2rssLoginClose({ sessionId: 'not-a-session' }),
    ])
      await expect(action()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(poll).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    await caller.account.wechat2rssAccounts();
    await caller.account.wechat2rssLoginStart();
    await caller.account.wechat2rssLoginPoll({ sessionId });
    await caller.account.wechat2rssLoginClose({ sessionId });
    for (const action of [list, start, poll, close])
      expect(action).toHaveBeenCalledTimes(1);
    expect(poll).toHaveBeenCalledWith(sessionId);
    expect(close).toHaveBeenCalledWith(sessionId);
  });
});
