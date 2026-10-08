import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { requestDownloadResource } from '../article-download';
import {
  nativeAccountIndexFile,
  NativeWereadAccount,
} from './owner-weread-account';
import { resolveWereadPublisherOriginal } from './weread-public-original';

jest.mock('../article-download', () => ({
  ...jest.requireActual('../article-download'),
  requestDownloadResource: jest.fn(),
}));
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const biz = Buffer.from('1234567890').toString('base64');
const url = `https://mp.weixin.qq.com/s?__biz=${encodeURIComponent(biz)}&mid=101&idx=1&sn=abcdef1234`;
const short = 'https://mp.weixin.qq.com/s/' + 'a'.repeat(22);
const html = `<meta property="og:url" content="${url}"><script>var biz="${biz}";var mid="101";var idx="1";var sn="abcdef1234";var ct="1700000100";</script><h1 id="activity-name">合成文章</h1><span id="js_name">合成公众号</span><div id="js_content">真实结构合成正文</div>`;

describe('publisher URL to reviewed public original (offline)', () => {
  let dir: string, configFile: string, account: NativeWereadAccount;
  const run = (articleUrl = url) =>
    resolveWereadPublisherOriginal({
      url: articleUrl,
      account,
      trigger: 'local-manual',
      configFile,
    });
  const stateFile = () =>
    path.join(dir, `candidate-public-original-${hash(url).slice(0, 24)}.json`);
  beforeEach(async () => {
    jest.clearAllMocks();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-public-candidate-'));
    configFile = path.join(dir, 'config.json');
    await fs.writeFile(configFile, JSON.stringify({ feeds: {} }));
    account = {
      id: '123',
      name: '合成账号',
      status: 1,
      token: JSON.stringify({ wr_vid: '123', wr_skey: 'synthetic-key' }),
    };
    const session = JSON.stringify({
      source: 'owner-confirmed-native-web-login',
      capturedAt: new Date().toISOString(),
      ownerVid: '123',
      cookies: [
        {
          name: 'wr_vid',
          value: '123',
          domain: 'weread.qq.com',
          path: '/',
          secure: true,
          expires: -1,
        },
        {
          name: 'wr_skey',
          value: 'synthetic-key',
          domain: 'weread.qq.com',
          path: '/',
          secure: true,
          expires: -1,
        },
      ],
    });
    const sessionFile = path.join(
      dir,
      `native-session-${hash(session).slice(0, 24)}.json`,
    );
    await fs.writeFile(sessionFile, session);
    await fs.writeFile(
      nativeAccountIndexFile(configFile, account.id),
      JSON.stringify({ sessionFile }),
    );
    (requestDownloadResource as jest.Mock).mockReset().mockResolvedValue({
      status: 200,
      type: 'text/html',
      bytes: Buffer.from(html),
    });
  });
  afterEach(async () => {
    if (
      path.dirname(dir) !== os.tmpdir() ||
      !path.basename(dir).startsWith('wewe-public-candidate-')
    )
      throw new Error('TEST_PATH_INVALID');
    await fs.rm(dir, { recursive: true, force: true });
  });
  it('fetches a new URL without prebinding or known-hash whitelist and keeps raw HTML server-only', async () => {
    const result = await run();
    expect(result.status).toBe('reviewed-original');
    if (result.status !== 'reviewed-original')
      throw new Error('expected reviewed original');
    expect(result.html).toBe(html);
    expect(result.candidate).toMatchObject({
      mpId: 'MP_WXS_1234567890',
      name: '合成公众号',
      bookIdStatus: 'candidate',
    });
    expect(JSON.stringify(result)).not.toContain('<script>');
    expect(requestDownloadResource).toHaveBeenCalledWith(url, 10 * 1024 * 1024);
    expect(requestDownloadResource).toHaveBeenCalledTimes(1);
    expect((await run()).status).toBe('reviewed-original');
    expect(requestDownloadResource).toHaveBeenCalledTimes(1);
  });
  it('resolves a short URL by its actual HTTP200 original response, without guessing publisher identity', async () => {
    const result = await run(short);
    expect(result.status).toBe('reviewed-original');
    expect(requestDownloadResource).toHaveBeenCalledWith(
      short,
      10 * 1024 * 1024,
    );
  });
  it.each([
    'http://mp.weixin.qq.com/s/aaaaaaaaaaaaaaaaaaaaaa',
    'https://evil.example/s/aaaaaaaaaaaaaaaaaaaaaa',
    'https://mp.weixin.qq.com@evil.example/s/aaaaaaaaaaaaaaaaaaaaaa',
  ])('refuses unsafe URL %s before transport', async (input) => {
    expect(await run(input)).toMatchObject({
      status: 'blocked',
      code: 'INVALID_ARTICLE_URL',
    });
    expect(requestDownloadResource).not.toHaveBeenCalled();
  });
  it('rejects disabled/stopped selected accounts before fetching the original', async () => {
    account.status = 0;
    await expect(run()).rejects.toMatchObject({ code: 'ACCOUNT_NOT_READY' });
    account.status = 1;
    const stop = path.join(dir, 'old-stop.json');
    await fs.writeFile(
      stop,
      JSON.stringify({
        stop: { stage: 'directory-0', reason: '业务码 -2041' },
      }),
    );
    await fs.writeFile(
      configFile,
      JSON.stringify({
        feeds: {
          MP_WXS_1234567890: { ownerVid: '123', wereadLatestStateFile: stop },
        },
      }),
    );
    await expect(run()).rejects.toMatchObject({ code: 'RETAINED_STOP' });
    expect(requestDownloadResource).not.toHaveBeenCalled();
  });
  it('retains a real safe 302 verification Location only for this result and never follows or repeats', async () => {
    const observed = {
      status: 'available',
      articleUrl: url,
      url: 'https://mp.weixin.qq.com/mp/verify?action=check',
    };
    (requestDownloadResource as jest.Mock).mockResolvedValue({
      status: 302,
      type: 'text/html',
      bytes: Buffer.from('synthetic redirect'),
      redirectKind: 'verification',
      officialVerification: observed,
    });
    const result = await run();
    expect(result).toMatchObject({
      status: 'verification-required',
      code: 'PUBLIC_ORIGINAL_REDIRECT',
      upstreamStatus: 302,
    });
    if (result.status === 'reviewed-original')
      throw new Error('unexpected success');
    expect(result.officialVerification).toEqual(observed);
    expect(JSON.stringify(result)).not.toContain('/mp/verify');
    expect(await fs.readFile(stateFile(), 'utf8')).not.toContain('/mp/verify');
    expect(await run()).toMatchObject({
      status: 'verification-required',
      code: 'RETAINED_PUBLIC_STOP',
    });
    expect(requestDownloadResource).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403, 429])(
    'retains HTTP%s without binding success or a repeat',
    async (status) => {
      (requestDownloadResource as jest.Mock).mockResolvedValue({
        status,
        type: 'text/html',
        bytes: Buffer.from('denied'),
      });
      expect(await run()).toMatchObject({
        status: 'blocked',
        code: 'PUBLIC_ORIGINAL_HTTP',
        upstreamStatus: status,
      });
      expect(await run()).toMatchObject({
        status: 'blocked',
        code: 'RETAINED_PUBLIC_STOP',
      });
      expect(requestDownloadResource).toHaveBeenCalledTimes(1);
    },
  );
  it('keeps a 200 challenge pending and rejects an identity mismatch', async () => {
    (requestDownloadResource as jest.Mock).mockResolvedValue({
      status: 200,
      type: 'text/html',
      bytes: Buffer.from('<div id="js_verify">verification</div>'),
    });
    expect(await run()).toMatchObject({
      status: 'verification-required',
      code: 'PUBLIC_ORIGINAL_VERIFICATION_PAGE',
    });
    const other = url.replace('mid=101', 'mid=102');
    (requestDownloadResource as jest.Mock).mockResolvedValue({
      status: 200,
      type: 'text/html',
      bytes: Buffer.from(html),
    });
    expect(await run(other)).toMatchObject({
      status: 'blocked',
      code: 'PUBLIC_IDENTITY_CONFLICT',
    });
  });
  it('damaged/absent cache response cannot grant a fresh fetch', async () => {
    await run();
    await fs.unlink(stateFile() + '.response');
    expect(await run()).toMatchObject({
      status: 'blocked',
      code: 'CACHE_INVALID',
    });
    expect(requestDownloadResource).toHaveBeenCalledTimes(1);
  });
});
