import { recoveryHoldHttp } from './recovery-hold-http';
import { XhsScheduledService } from './collection/xhs-scheduled.service';
import { XhsScheduledClock } from './collection/xhs-scheduled-clock';

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
  function check(path: string, method = 'GET', options: Record<string, unknown> = {}) {
    process.env.WECHAT2RSS_RECOVERY_HOLD = '1';
    const next = jest.fn();
    const res = { status: jest.fn().mockReturnThis(), send: jest.fn(), setHeader: jest.fn() };
    const req = { method, path, protocol: 'http', get: () => '127.0.0.1:4000',
      socket: { remoteAddress: '127.0.0.1' }, headers: {}, ...options };
    recoveryHoldHttp(req as any, res as any, next);
    return { next, res };
  }
  it.each(['prepareRefreshBatchLocalCancellation','refreshBatchStatus','connectionStatus'])('lets only local GET %s reach its original guards', name => {
    const {next,res}=check('/trpc/xiaohongshu.'+name);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control','no-store');
  });
  it('allows exact same-origin local confirmation and local startup status',()=>{
    expect(check('/trpc/xiaohongshu.confirmRefreshBatchLocalCancellation','POST',
      {headers:{origin:'http://127.0.0.1:4000'}}).next).toHaveBeenCalledTimes(1);
    expect(check('/startup-status').next).toHaveBeenCalledTimes(1);
  });
  it.each([
    '/trpc/xiaohongshu.advanceRefreshBatch', '/trpc/xiaohongshu.createRefreshBatch',
    '/trpc/xiaohongshu.restoreSession', '/trpc/xiaohongshu.savedSession',
    '/trpc/xiaohongshu.sourceRequestBudget', '/trpc/feed.refreshArticles',
    '/trpc/xiaohongshu.refreshBatchStatus,xiaohongshu.advanceRefreshBatch',
    '/trpc/xiaohongshu.refreshBatchStatus%2cxiaohongshu.advanceRefreshBatch',
    '/trpc/xiaohongshu.refreshBatchStatus/', '/api/trpc/xiaohongshu.refreshBatchStatus',
    '/feeds/test?update=1', '/proxy/image', '/dash',
  ])('keeps other and mixed/encoded routes frozen: %s',path=>{
    const {next,res}=check(path);
    expect(next).not.toHaveBeenCalled();expect(res.status).toHaveBeenCalledWith(503);
  });
  it.each([
    {socket:{remoteAddress:'198.51.100.1'}}, {get:()=> 'example.com'},
    {headers:{origin:'http://example.com'}}, {headers:{origin:'null'}},
    {socket:{remoteAddress:'198.51.100.1'},headers:{'x-forwarded-for':'127.0.0.1'}},
  ])('rejects nonlocal or cross-origin status %#',options=>{
    expect(check('/trpc/xiaohongshu.refreshBatchStatus','GET',options).next).not.toHaveBeenCalled();
  });
  it.each([
    ['POST','prepareRefreshBatchLocalCancellation',{}],
    ['GET','confirmRefreshBatchLocalCancellation',{}],
    ['POST','confirmRefreshBatchLocalCancellation',{}],
    ['POST','confirmRefreshBatchLocalCancellation',{origin:'http://example.com'}],
    ['HEAD','refreshBatchStatus',{}],
  ])('rejects wrong method/origin %#',(method,name,headers)=>{
    expect(check('/trpc/xiaohongshu.'+name,method,{headers}).next).not.toHaveBeenCalled();
  });
});

it('keeps the XHS cron paused even when every scheduling opt-in is set',async()=>{
  const original={...process.env};const tick=jest.spyOn(XhsScheduledClock.prototype,'tick');
  try{
    Object.assign(process.env,{WECHAT2RSS_RECOVERY_HOLD:'1',ENABLE_SCHEDULED_UPDATES:'1',DISABLE_SCHEDULED_UPDATES:'0',XHS_SUBSCRIPTION_LIVE_ENABLED:'1'});
    await new XhsScheduledService({} as any,{} as any,{} as any).tick();
    expect(tick).not.toHaveBeenCalled();
  }finally{tick.mockRestore();process.env=original;}
});
