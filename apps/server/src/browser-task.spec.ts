import {
  BrowserTaskBroker,
  verifyBrowserTaskObservation,
} from './browser-task';
import { canonicalArticleUrl } from './collection/collection-format';

import {
  config,
  binding,
  observation,
  short,
} from '../test/browser-task-fixture';

describe('short-lived official article task', () => {
  const brokers: BrowserTaskBroker[] = [];
  const broker = () => {
    const instance = new BrowserTaskBroker(config);
    brokers.push(instance);
    return instance;
  };
  afterEach(() => {
    brokers.forEach((b) => b.close());
    brokers.length = 0;
    jest.useRealTimers();
  });
  it('disabled / unverified route cannot issue tasks', () => {
    expect(() => new BrowserTaskBroker().issue({ url: short })).toThrow(
      'BROWSER_TASK_DISABLED',
    );
    expect(() =>
      new BrowserTaskBroker({ ...config, routeVerified: false }).issue({
        url: short,
      }),
    ).toThrow('LIVE_ROUTE_UNVERIFIED');
  });
  it('new unknown short link maps through current official chapter, without DB/cache/hash prerequisite', async () => {
    const b = broker();
    const task = b.issue({ url: short });
    const claim = b.claim(task.taskId, binding);
    expect(
      b.complete(task.taskId, claim.nonce, binding, observation()),
    ).toEqual({ accepted: true });
    const article = await task.result;
    expect(article).toMatchObject({
      id: 'WX_1234567890_2247000001_1',
      mpId: 'MP_WXS_1234567890',
      shortUrl: short,
      publishTime: 1700000000,
    });
    expect(article.contentHtml).toContain('data:image/png;base64,');
    expect(() =>
      b.complete(task.taskId, claim.nonce, binding, observation()),
    ).toThrow('TASK_GONE');
  });
  it.each(['nonce', 'tab', 'window', 'path', 'cross-task'])(
    'rejects %s substitution without resolving rightful task',
    async (kind) => {
      const b = broker();
      const task = b.issue({ url: short });
      const claim = b.claim(task.taskId, binding);
      const modified = { ...binding };
      if (kind === 'tab') modified.tabId = 5;
      if (kind === 'window') modified.windowId = 3;
      if (kind === 'path') modified.pageUrl += '2';
      const another = kind === 'cross-task' ? b.issue({ url: short }) : null;
      if (another) b.claim(another.taskId, binding);
      expect(() =>
        b.complete(
          another?.taskId || task.taskId,
          kind === 'nonce' ? 'other' : claim.nonce,
          modified,
          observation(),
        ),
      ).toThrow('TASK_BINDING');
      expect(
        b.complete(task.taskId, claim.nonce, binding, observation()),
      ).toEqual({ accepted: true });
      await task.result;
    },
  );
  it('expiration and restart revoke tasks', async () => {
    jest.useFakeTimers();
    const b = broker();
    const task = b.issue({ url: short });
    b.claim(task.taskId, binding);
    jest.advanceTimersByTime(300001);
    await expect(task.result).rejects.toThrow('TASK_CANCELLED');
    expect(() => b.claim(task.taskId, binding)).toThrow('TASK_GONE');
    expect(() => broker().claim(task.taskId, binding)).toThrow('TASK_GONE');
  });
  it('only the evidenced official MP reader route may claim a task', () => {
    const b = broker();
    const task = b.issue({ url: short });
    for (const path of [
      '/web/reader/fixture',
      '/web/mp/reader/',
      '/web/mp/reader/fixture/extra',
      '/web/mp/other/fixture',
    ])
      expect(() =>
        b.claim(task.taskId, {
          ...binding,
          pageUrl: 'https://weread.qq.com' + path,
        }),
      ).toThrow('SOURCE_BINDING');
    expect(b.claim(task.taskId, binding).nonce).toHaveLength(43);
  });
  it('bad complete consumes task without allowing retry', async () => {
    const b = broker();
    const task = b.issue({ url: short });
    const claim = b.claim(task.taskId, binding);
    const bad = observation();
    bad.images[0].inline = 'data:image/png;base64,AAAA';
    expect(() => b.complete(task.taskId, claim.nonce, binding, bad)).toThrow();
    await expect(task.result).rejects.toThrow('OBSERVATION_REJECTED');
    expect(() => b.claim(task.taskId, binding)).toThrow('TASK_GONE');
  });
  it.each([
    'publisher',
    'time',
    'body',
    'canonical',
    'missing-image',
    'remote-image',
    'extra-secret',
    'metadata-js',
  ])('rejects %s observations', (kind) => {
    const bad = observation();
    if (kind === 'publisher')
      bad.projection.current.review.belongBookId = 'MP_WXS_9876543210';
    if (kind === 'time')
      bad.html = bad.html.replace('var ct="1700000000";', '');
    if (kind === 'body') bad.html = bad.html.replace('<p>末尾完整内容</p>', '');
    if (kind === 'canonical') bad.html = bad.html.replace(short, '');
    if (kind === 'missing-image') bad.images = [];
    if (kind === 'remote-image')
      bad.images[0].inline = 'http://127.0.0.1/private';
    if (kind === 'extra-secret') (bad as any).ticket = 'forbidden';
    if (kind === 'metadata-js')
      bad.html = bad.html.replace('var ct="1700000000";', 'var ct=steal();');
    expect(() => verifyBrowserTaskObservation({ url: short }, bad)).toThrow();
  });
  it('requested different short/canonical URL cannot use this page', () => {
    expect(() =>
      verifyBrowserTaskObservation(
        {
          url: short.replace(
            'abcdefghijklmnopqrstuv',
            '1234567890123456789012',
          ),
        },
        observation(),
      ),
    ).toThrow('TARGET_MISMATCH');
    const url = canonicalArticleUrl(
      'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA%3D%3D&mid=2247000002&idx=1&sn=abcd',
    ).url;
    expect(() => verifyBrowserTaskObservation({ url }, observation())).toThrow(
      'TARGET_MISMATCH',
    );
  });
  it('pairing, exact Origin/Host, content type and loopback are enforced', () => {
    const b = broker();
    const req = {
      socket: { remoteAddress: '127.0.0.1' },
      headers: {
        host: '127.0.0.1:11207',
        origin: config.extensionOrigin,
        'x-wewe-pairing': config.pairingKey,
        'content-type': 'application/json',
      },
    };
    expect(b.authorize(req)).toEqual(config.extensionOrigin);
    for (const [key, value] of [
      ['host', '127.0.0.1:4000'],
      ['origin', 'https://weread.qq.com'],
      ['x-wewe-pairing', 'x'.repeat(43)],
      ['content-type', 'text/plain'],
    ])
      expect(() =>
        b.authorize({ ...req, headers: { ...req.headers, [key]: value } }),
      ).toThrow();
    expect(() =>
      b.authorize({ ...req, socket: { remoteAddress: '192.168.1.2' } }),
    ).toThrow('LOCAL_ORIGIN');
  });
});
