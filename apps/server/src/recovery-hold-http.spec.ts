import { recoveryHoldHttp } from './recovery-hold-http';

describe('recovery hold HTTP gate', () => {
  const previous = process.env.WECHAT2RSS_RECOVERY_HOLD;
  afterEach(() => {
    if (previous === undefined) delete process.env.WECHAT2RSS_RECOVERY_HOLD;
    else process.env.WECHAT2RSS_RECOVERY_HOLD = previous;
  });
  it.each(['GET', 'POST'])('blocks %s before any route handler', (method) => {
    process.env.WECHAT2RSS_RECOVERY_HOLD = '1';
    const response = { status: jest.fn().mockReturnThis(), send: jest.fn() };
    const next = jest.fn();
    recoveryHoldHttp({ method } as any, response as any, next);
    expect(response.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });
  it('passes requests normally without hold', () => {
    delete process.env.WECHAT2RSS_RECOVERY_HOLD;
    const next = jest.fn();
    recoveryHoldHttp({} as any, {} as any, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
