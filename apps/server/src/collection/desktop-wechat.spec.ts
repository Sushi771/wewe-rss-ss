import axios from 'axios';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { access } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { fetchDesktopRecent20, verifyDesktopEvidence } from './desktop-wechat';

jest.mock('axios');
jest.mock('node:child_process', () => ({ spawn: jest.fn() }));
jest.mock('node:fs/promises', () => ({ access: jest.fn() }));

const get = axios.get as jest.MockedFunction<typeof axios.get>;
const start = spawn as jest.MockedFunction<typeof spawn>;
const mpId = 'MP_WXS_1234567890';
const mpName = '合成测试公众号';
const time = 1719737099;

// These are synthetic protocol/original-page fixtures. No WeChat UI, clipboard,
// public article request, or production database is used by this suite.
function card(number: number, rank = number) {
  return {
    rank,
    title: `合成文章 ${number}`,
    shortUrl: `https://mp.weixin.qq.com/s/${String(number).padStart(22, 'A')}`,
  };
}

function evidence() {
  return {
    source: 'desktop-wechat',
    protocolVersion: 2,
    account: mpName,
    mpId,
    articles: Array.from({ length: 20 }, (_, index) => card(index + 1)),
    pinnedArticles: [] as ReturnType<typeof card>[],
  };
}

function original(
  item: ReturnType<typeof card>,
  options: {
    number?: string;
    mid?: number;
    idx?: number;
    publishTime?: number;
    title?: string;
    canonical?: string;
    body?: string;
  } = {},
) {
  const biz = Buffer.from(options.number || '1234567890').toString('base64');
  return {
    data: `<meta property="og:url" content="${options.canonical ?? item.shortUrl}">
      <meta property="og:image" content="https://mmbiz.qpic.cn/fixture.jpg">
      <h1 id="activity-name">${options.title ?? item.title}</h1>
      <div id="js_content">${options.body ?? '<p>测试正文</p><img data-src="https://mmbiz.qpic.cn/image.jpg">'}</div>
      <script>var biz="${biz}";var mid="${options.mid ?? 2247480000 + item.rank}";
      var idx="${options.idx ?? 1}";var sn="abcdef";var ct=${options.publishTime ?? time - item.rank};</script>`,
  };
}

function originalsFor(data: ReturnType<typeof evidence>) {
  const all = [...data.articles, ...data.pinnedArticles];
  get.mockImplementation(async (url) => {
    const item = all.find((entry) => entry.shortUrl === url);
    if (!item) throw new Error('Unplanned mock request');
    return original(item);
  });
}

function fakeHelper() {
  const child = Object.assign(new EventEmitter(), {
    pid: 12345 as number | undefined,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: jest.fn(() => true),
  });
  start.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  return child;
}

async function waitForSpawn(count = 1) {
  for (let i = 0; i < 10 && start.mock.calls.length < count; i++)
    await Promise.resolve();
  expect(start).toHaveBeenCalledTimes(count);
}

async function completeVerification<T>(operation: Promise<T>) {
  // Attach a rejection handler before driving timers to avoid unhandled errors.
  const outcome = operation.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await jest.runAllTimersAsync();
  const result = await outcome;
  if (!result.ok) throw result.error;
  return result.value;
}

describe('desktop WeChat collector boundary (fully mocked)', () => {
  const originalProxy = process.env.WECHAT_PUBLIC_PROXY_URL;
  const originalPlatform = Object.getOwnPropertyDescriptor(
    process,
    'platform',
  )!;

  beforeEach(() => {
    jest.useFakeTimers();
    Object.defineProperty(process, 'platform', {
      ...originalPlatform,
      value: 'win32',
    });
    get.mockReset();
    start.mockReset();
    (access as jest.MockedFunction<typeof access>).mockResolvedValue(undefined);
    delete process.env.WECHAT_PUBLIC_PROXY_URL;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    Object.defineProperty(process, 'platform', originalPlatform);
    if (originalProxy === undefined) delete process.env.WECHAT_PUBLIC_PROXY_URL;
    else process.env.WECHAT_PUBLIC_PROXY_URL = originalProxy;
  });

  it('accepts exactly one live protocol-v2 JSON result before verifying originals', async () => {
    const data = evidence();
    originalsFor(data);
    const child = fakeHelper();
    const operation = fetchDesktopRecent20(mpId, mpName);
    await waitForSpawn();
    expect(get).not.toHaveBeenCalled();
    child.stdout.write(JSON.stringify(data));
    expect(get).not.toHaveBeenCalled();
    child.emit('close', 0, null);
    const result = await completeVerification(operation);
    expect(result).toHaveLength(20);
    expect(result.map((article) => article.rank)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    expect(start.mock.calls[0]).toEqual([
      'pwsh',
      expect.arrayContaining([
        '-NoProfile',
        '-NonInteractive',
        '-MpId',
        mpId,
        '-Limit',
        '20',
      ]),
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    ]);
    expect(start.mock.calls[0][1]).not.toContain('-ResumeAfterUserConsent');
    expect(get.mock.calls[0][1]).toMatchObject({
      proxy: false,
      timeout: 15000,
    });
    expect(result[0].contentHtml).toContain(
      'src="https://mmbiz.qpic.cn/image.jpg"',
    );
    expect(result[0]).not.toHaveProperty('readCount');
    expect(result[0]).not.toHaveProperty('likeCount');
  });

  it('only forwards resume consent when a caller explicitly requests it', async () => {
    const child = fakeHelper();
    const operation = fetchDesktopRecent20(mpId, mpName, {
      resumeAfterUserConsent: true,
    });
    const check = expect(operation).rejects.toThrow('USER_PAUSED');
    await waitForSpawn();
    expect(start.mock.calls[0][1]).toContain('-ResumeAfterUserConsent');
    child.stderr.write('COLLECT_FAILED: USER_PAUSED\n');
    child.emit('close', 1, null);
    await check;
    expect(get).not.toHaveBeenCalled();
  });

  it.each([0, 1])(
    'preserves only approved helper code/stage on exit %s and sends no requests',
    async (exitCode) => {
      const child = fakeHelper();
      const operation = fetchDesktopRecent20(mpId, mpName);
      const check = expect(operation).rejects.toMatchObject({
        code: 'PINNED_CARD_UNVERIFIED',
        stage: 'SCAN_PINNED',
      });
      await waitForSpawn();
      child.stdout.write(JSON.stringify(evidence()));
      child.stderr.write(
        'COLLECT_STAGE: SCAN_PINNED\r\nCOLLECT_FAILED: PINNED_CARD_UNVERIFIED\r\n',
      );
      child.stderr.write(
        'COLLECT_DIAGNOSTIC: {"rawClipboard":"private-value"}\n',
      );
      child.emit('close', exitCode, null);
      await check;
      await expect(operation).rejects.not.toThrow('private-value');
      expect(get).not.toHaveBeenCalled();
    },
  );

  it('does not forward arbitrary helper stderr or non-whitelisted symbols', async () => {
    const child = fakeHelper();
    const operation = fetchDesktopRecent20(mpId, mpName);
    const check = expect(operation).rejects.toMatchObject({
      code: 'HELPER_FAILED',
      stage: undefined,
    });
    await waitForSpawn();
    child.stderr.write(
      'COLLECT_FAILED: PRIVATE_ACCOUNT_NAME\nCOLLECT_STAGE: PRIVATE_WINDOW_TITLE\ncookie=do-not-show\n',
    );
    child.emit('close', 1, null);
    await check;
    await expect(operation).rejects.not.toThrow(/PRIVATE|cookie|do-not-show/);
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    [
      'legacy protocol',
      (data: any) => {
        delete data.protocolVersion;
      },
      'HELPER_PROTOCOL_INVALID',
    ],
    [
      'wrong source',
      (data: any) => {
        data.source = 'untrusted';
      },
      'HELPER_PROTOCOL_INVALID',
    ],
    [
      'wrong account',
      (data: any) => {
        data.mpId = 'MP_WXS_9876543210';
      },
      '账号',
    ],
    [
      'missing twentieth card',
      (data: any) => {
        data.articles.pop();
      },
      '列表不完整',
    ],
    [
      'duplicate regular link',
      (data: any) => {
        data.articles[1].shortUrl = data.articles[0].shortUrl;
      },
      '重复链接',
    ],
    [
      'unexpected rank',
      (data: any) => {
        data.articles[1].rank = 8;
      },
      '卡片',
    ],
    [
      'missing pinned evidence',
      (data: any) => {
        delete data.pinnedArticles;
      },
      '置顶',
    ],
    [
      'credential-bearing URL',
      (data: any) => {
        data.articles[0].shortUrl += '?key=secret';
      },
      '链接无效',
    ],
  ])(
    'rejects %s before making an original-page request',
    async (_name, change, reason) => {
      const data = evidence();
      change(data);
      const child = fakeHelper();
      const operation = fetchDesktopRecent20(mpId, mpName);
      const check = expect(operation).rejects.toThrow(reason);
      await waitForSpawn();
      child.stdout.write(JSON.stringify(data));
      child.emit('close', 0, null);
      await check;
      expect(get).not.toHaveBeenCalled();
    },
  );

  it('rejects stdout contamination instead of extracting a plausible JSON suffix', async () => {
    const child = fakeHelper();
    const operation = fetchDesktopRecent20(mpId, mpName);
    const check = expect(operation).rejects.toThrow('格式无效');
    await waitForSpawn();
    child.stdout.write(`DEBUG\n${JSON.stringify(evidence())}`);
    child.emit('close', 0, null);
    await check;
    expect(get).not.toHaveBeenCalled();
  });

  it('keeps legacy evidence verification separate from live helper execution', async () => {
    const data = evidence();
    originalsFor(data);
    const legacy: Partial<ReturnType<typeof evidence>> = { ...data };
    delete legacy.protocolVersion;
    const result = await completeVerification(
      verifyDesktopEvidence(mpId, mpName, JSON.stringify(legacy)),
    );
    expect(result).toHaveLength(20);
    expect(start).not.toHaveBeenCalled();
  });

  it('rejects concurrent helpers for different accounts and releases after a failure', async () => {
    const child = fakeHelper();
    const first = fetchDesktopRecent20(mpId, mpName);
    const check = expect(first).rejects.toThrow('USER_CANCELLED');
    await expect(
      fetchDesktopRecent20('MP_WXS_9876543210', '另一个号'),
    ).rejects.toMatchObject({ code: 'GLOBAL_COLLECTOR_BUSY' });
    await waitForSpawn();
    child.stderr.write('COLLECT_FAILED: USER_CANCELLED\n');
    child.emit('close', 1, null);
    await check;
    const nextChild = fakeHelper();
    const next = fetchDesktopRecent20(mpId, mpName);
    const nextCheck = expect(next).rejects.toThrow('HELPER_FAILED');
    await waitForSpawn(2);
    nextChild.emit('close', 1, null);
    await nextCheck;
    expect(get).not.toHaveBeenCalled();
  });

  it.each(['timeout', 'stdout limit', 'stderr limit'])(
    'retains the global lock after %s until the child actually closes',
    async (failure) => {
      const child = fakeHelper();
      const first = fetchDesktopRecent20(mpId, mpName);
      const check = expect(first).rejects.toMatchObject({
        code: failure === 'timeout' ? 'HELPER_TIMEOUT' : 'HELPER_OUTPUT_LIMIT',
      });
      await waitForSpawn();
      if (failure === 'timeout')
        await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
      else if (failure === 'stdout limit')
        child.stdout.write('中'.repeat(50 * 1024));
      else child.stderr.write('中'.repeat(25 * 1024));
      await check;
      expect(child.kill).toHaveBeenCalledTimes(1);
      await expect(fetchDesktopRecent20(mpId, mpName)).rejects.toMatchObject({
        code: 'GLOBAL_COLLECTOR_BUSY',
      });
      expect(get).not.toHaveBeenCalled();
      child.emit('close', null, 'SIGTERM');
    },
  );

  it('releases a failed spawn without letting its late close unlock a newer helper', async () => {
    const failedChild = fakeHelper();
    failedChild.pid = undefined;
    const first = fetchDesktopRecent20(mpId, mpName);
    const firstCheck = expect(first).rejects.toThrow('HELPER_START_FAILED');
    await waitForSpawn();
    failedChild.emit('error', new Error('private spawn diagnostic'));
    await firstCheck;
    const currentChild = fakeHelper();
    const current = fetchDesktopRecent20(mpId, mpName);
    const currentCheck = expect(current).rejects.toThrow('HELPER_FAILED');
    await waitForSpawn(2);
    failedChild.emit('close', -1, null);
    await expect(fetchDesktopRecent20(mpId, mpName)).rejects.toThrow(
      'GLOBAL_COLLECTOR_BUSY',
    );
    currentChild.emit('close', 1, null);
    await currentCheck;
    expect(get).not.toHaveBeenCalled();
  });

  it('sorts a new pinned article into the latest twenty and excludes an old pinned article', async () => {
    const data = evidence();
    data.pinnedArticles = [card(21), card(22)];
    originalsFor(data);
    get.mockImplementation(async (url) => {
      const item = [...data.articles, ...data.pinnedArticles].find(
        (entry) => entry.shortUrl === url,
      )!;
      return original(item, {
        publishTime:
          item.rank === 21
            ? time + 1
            : item.rank === 22
              ? time - 1000
              : time - item.rank,
      });
    });
    const result = await completeVerification(
      verifyDesktopEvidence(mpId, mpName, JSON.stringify(data)),
    );
    expect(result).toHaveLength(20);
    expect(result[0].shortUrl).toBe(data.pinnedArticles[0].shortUrl);
    expect(result.map((item) => item.shortUrl)).not.toContain(
      data.articles[19].shortUrl,
    );
    expect(result.map((item) => item.shortUrl)).not.toContain(
      data.pinnedArticles[1].shortUrl,
    );
    expect(get).toHaveBeenCalledTimes(22);
  });

  it('counts a pinned/regular overlap once and verifies its original only once', async () => {
    const data = evidence();
    data.pinnedArticles = [{ ...data.articles[0], title: ' 合成文章\u30001 ' }];
    originalsFor(data);
    const result = await completeVerification(
      verifyDesktopEvidence(mpId, mpName, JSON.stringify(data)),
    );
    expect(result).toHaveLength(20);
    expect(new Set(result.map((item) => item.id)).size).toBe(20);
    expect(get).toHaveBeenCalledTimes(20);
  });

  it('rejects contradictory pinned/regular titles before requesting originals', async () => {
    const data = evidence();
    data.pinnedArticles = [{ ...data.articles[0], title: '另一个标题' }];
    await expect(
      verifyDesktopEvidence(mpId, mpName, JSON.stringify(data)),
    ).rejects.toThrow('置顶与普通卡片标题不一致');
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    ['publisher mismatch', { number: '9876543210' }, '身份'],
    ['canonical mismatch', { canonical: card(99).shortUrl }, '身份'],
    ['title mismatch', { title: '别的文章' }, '标题'],
    ['invalid publication time', { publishTime: 9999999999 }, '日期'],
  ])(
    'rejects %s without returning a partial collection',
    async (_name, options, reason) => {
      const data = evidence();
      get.mockResolvedValueOnce(original(data.articles[0], options));
      await expect(
        completeVerification(
          verifyDesktopEvidence(mpId, mpName, JSON.stringify(data)),
        ),
      ).rejects.toThrow(reason);
      expect(get).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps verified identity/title/date when one original shell has no usable body', async () => {
    const data = evidence();
    originalsFor(data);
    get.mockResolvedValueOnce(original(data.articles[0], { body: '' }));
    const result = await completeVerification(
      verifyDesktopEvidence(mpId, mpName, JSON.stringify(data)),
    );
    expect(result).toHaveLength(20);
    expect(result[0]).toMatchObject({
      id: 'WX_1234567890_2247480001_1',
      title: data.articles[0].title,
      publishTime: time - 1,
      contentHtml: undefined,
      lastBodyStatus: 'unavailable',
    });
    expect(
      result.slice(1).every((item) => item.lastBodyStatus === 'available'),
    ).toBe(true);
    expect(get).toHaveBeenCalledTimes(20);
  });

  it.each([
    ['unknown time', (html: string) => html.replace(/var ct=\d+;/, '')],
    ['missing identity', (html: string) => html.replace(/var mid="\d+";/, '')],
    [
      'missing original shell',
      (html: string) => html.replace('id="js_content"', 'id="unknown"'),
    ],
    [
      'captcha over an article shell',
      (html: string) =>
        html + '<iframe src="https://captcha.gtimg.com/challenge"></iframe>',
    ],
    [
      'error over an article shell',
      (html: string) => html + '<div class="weui_msg">错误</div>',
    ],
  ])(
    'rejects %s even with matching title and short URL',
    async (_name, change) => {
      const data = evidence();
      get.mockResolvedValueOnce({
        data: change(original(data.articles[0], { body: '' }).data),
      });
      await expect(
        completeVerification(
          verifyDesktopEvidence(mpId, mpName, JSON.stringify(data)),
        ),
      ).rejects.toThrow('本次未写入文章');
      expect(get).toHaveBeenCalledTimes(1);
    },
  );

  it('does not turn a failed original request into verified missing content', async () => {
    get.mockRejectedValueOnce(new Error('request failed'));
    await expect(
      completeVerification(
        verifyDesktopEvidence(mpId, mpName, JSON.stringify(evidence())),
      ),
    ).rejects.toThrow('原文请求失败');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('rejects duplicate article identity even when short links differ', async () => {
    const data = evidence();
    get
      .mockResolvedValueOnce(original(data.articles[0]))
      .mockResolvedValueOnce(original(data.articles[1], { mid: 2247480001 }));
    await expect(
      completeVerification(
        verifyDesktopEvidence(mpId, mpName, JSON.stringify(data)),
      ),
    ).rejects.toThrow('身份');
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('rejects an out-of-order regular stream instead of hiding it by sorting', async () => {
    const data = evidence();
    get
      .mockResolvedValueOnce(original(data.articles[0]))
      .mockResolvedValueOnce(original(data.articles[1], { publishTime: time }));
    await expect(
      completeVerification(
        verifyDesktopEvidence(mpId, mpName, JSON.stringify(data)),
      ),
    ).rejects.toThrow('发布时间顺序');
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('keeps primary and secondary article identities separate in a synthetic stream', async () => {
    const data = evidence();
    originalsFor(data);
    get.mockImplementation(async (url) => {
      const item = data.articles.find((entry) => entry.shortUrl === url)!;
      return original(item, {
        mid: 2247480000,
        idx: item.rank,
        publishTime: time,
      });
    });
    const result = await completeVerification(
      verifyDesktopEvidence(mpId, mpName, JSON.stringify(data)),
    );
    expect(new Set(result.map((item) => item.id)).size).toBe(20);
    expect(result.slice(0, 2).map((item) => item.id)).toEqual([
      'WX_1234567890_2247480000_1',
      'WX_1234567890_2247480000_2',
    ]);
  });
});
