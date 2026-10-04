import axios from 'axios';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fetchOwnerWereadLatest } from './owner-weread-latest';
import { ownerSessionCookie } from './owner-web-search';
import { ownerLatestAuthHash } from './owner-weread-session-state';
jest.mock('axios');
jest.mock('node:timers/promises', () => ({
  setTimeout: jest.fn().mockResolvedValue(undefined),
}));

describe('normal owner Tencent latest body (no HTTP)', () => {
  let dir: string;
  const c = () => ({
    mpId: 'MP_WXS_1234567890',
    name: '测试号',
    biz: 'MTIzNDU2Nzg5MA==',
    ownerVid: '123',
    sessionFile: path.join(dir, 'session'),
    stateFile: path.join(dir, 'search'),
    originalStopFiles: [path.join(dir, 'original-stop')],
    runtimeStopFile: path.join(dir, 'original-runtime'),
    wereadLatestStateFile: path.join(dir, 'native'),
  });
  const html = `<meta property="og:url" content="https://mp.weixin.qq.com/s/${'a'.repeat(22)}"><h1 id="activity-name">测试文章</h1><a id="js_name">测试号</a><div id="js_content">正文</div><script>var biz="MTIzNDU2Nzg5MA==";var mid="100";var idx="1";var sn="abcd";var ct=1700000000;</script>`;
  beforeEach(async () => {
    jest.clearAllMocks();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-native-body-'));
    await fs.writeFile(
      c().sessionFile,
      JSON.stringify({
        source: 'owner-confirmed-native-web-login',
        capturedAt: new Date().toISOString(),
        ownerVid: '123',
        cookies: [
          {
            name: 'wr_vid',
            value: '123',
            domain: '.weread.qq.com',
            path: '/',
            secure: true,
            expires: -1,
          },
          {
            name: 'wr_skey',
            value: 'private-token',
            domain: '.weread.qq.com',
            path: '/',
            secure: true,
            expires: -1,
          },
        ],
      }),
    );
    await fs.writeFile(
      c().originalStopFiles[0],
      'retained prior original stop',
    );
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const directoryGroup = (n: number) => {
    const originalId = String(n).padStart(22, 'a');
    const reviewId = `${c().mpId}_${originalId}`;
    return {
      subReviews: [
        {
          reviewId,
          review: {
            reviewId,
            type: 16,
            bookId: '',
            belongBookId: c().mpId,
            mpInfo: {
              originalId,
              title: `directory-${n}`,
              mp_name: c().name,
              time: 1700000100 - n,
            },
          },
        },
      ],
    };
  };
  const directoryHtml = (n: number) =>
    `<meta property="og:url" content="https://mp.weixin.qq.com/s/${String(n).padStart(22, 'a')}"><h1 id="activity-name">directory-${n}</h1><span id="js_name">${c().name}</span><div id="js_content">body-${n}</div><script>var biz="${c().biz}";var mid="${100 + n}";var idx="1";var sn="abcd";var ct=${1700000100 - n};</script>`;
  it('directory mode fetches the selected ten through the original body/image pipeline without requesting cover', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
      'base64',
    );
    const imageFetch = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(png, {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }),
    );
    (axios.get as jest.Mock).mockImplementation(async (url, options) => {
      if (url.endsWith('/articles'))
        return {
          status: 200,
          data: JSON.stringify({
            reviews: Array.from({ length: 20 }, (_, i) =>
              directoryGroup(i + 1),
            ),
            clearAll: 1,
            synckey: 1790000000,
          }),
        };
      const n = Number(
        options.params.reviewId.split('_').at(-1).replace(/^a+/, ''),
      );
      return {
        status: 200,
        data:
          n === 1
            ? directoryHtml(n).replace(
                'body-1</div>',
                'body-1<img data-src="https://mmbiz.qpic.cn/fixture.png"></div>',
              )
            : directoryHtml(n),
      };
    });
    const config = { ...c(), wereadDirectoryEnabled: true };
    const page = await fetchOwnerWereadLatest(config);
    expect(page.articles).toHaveLength(10);
    expect(page.articles[0].id).toBe('WX_1234567890_101_1');
    expect(page.articles[9].id).toBe('WX_1234567890_110_1');
    expect(page.upstreamCount).toBe(20);
    expect(imageFetch).toHaveBeenCalledTimes(1);
    expect(page.articles[0].contentHtml).toContain(
      `data:image/png;base64,${png.toString('base64')}`,
    );
    expect(axios.get).toHaveBeenCalledTimes(11);
    expect((axios.get as jest.Mock).mock.calls[0][1].params).toEqual({
      bookId: c().mpId,
      offset: '0',
    });
    expect(
      (axios.get as jest.Mock).mock.calls.every(
        ([url]) => !url.includes('/cover'),
      ),
    ).toBe(true);
    await expect(fetchOwnerWereadLatest(config)).rejects.toThrow();
    expect(axios.get).toHaveBeenCalledTimes(11);
  });
  it('directory pagination counts groups, never articles or response synckey', async () => {
    const first = directoryGroup(1);
    first.subReviews.push(
      directoryGroup(2).subReviews[0],
      directoryGroup(3).subReviews[0],
    );
    (axios.get as jest.Mock).mockImplementation(async (url, options) => {
      if (url.endsWith('/articles'))
        return {
          status: 200,
          data: JSON.stringify({
            reviews:
              options.params.offset === '0'
                ? [first]
                : Array.from({ length: 7 }, (_, i) => directoryGroup(i + 4)),
            clearAll: 1,
            synckey: 987654321,
          }),
        };
      const n = Number(
        options.params.reviewId.split('_').at(-1).replace(/^a+/, ''),
      );
      return { status: 200, data: directoryHtml(n) };
    });
    const page = await fetchOwnerWereadLatest({
      ...c(),
      wereadDirectoryEnabled: true,
    });
    expect(page.pages).toBe(2);
    expect(page.articles).toHaveLength(10);
    expect((axios.get as jest.Mock).mock.calls[1][1].params).toEqual({
      bookId: c().mpId,
      offset: '1',
    });
  });
  it('stops a directory verification response without reading bodies or retrying', async () => {
    (axios.get as jest.Mock).mockResolvedValue({
      status: 200,
      data: JSON.stringify({ errCode: -2041 }),
    });
    const config = { ...c(), wereadDirectoryEnabled: true };
    await expect(fetchOwnerWereadLatest(config)).rejects.toThrow();
    const state = JSON.parse(
      await fs.readFile(c().wereadLatestStateFile, 'utf8'),
    );
    expect(state.stop).toMatchObject({
      stage: 'directory-0',
      requests: 1,
      reason: '业务码 -2041',
    });
    await expect(fetchOwnerWereadLatest(config)).rejects.toThrow(
      '目录已停止：业务码 -2041',
    );
    expect(axios.get).toHaveBeenCalledTimes(1);
  });
  it('keeps a directory login timeout stopped without renewing, reading bodies or images', async () => {
    const imageFetch = jest.spyOn(global, 'fetch');
    const raw = JSON.stringify({
      errCode: -2012,
      errMsg: '登录超时',
      errLog: 'private-trace-fixture',
      info: '',
    });
    (axios.get as jest.Mock).mockResolvedValue({ status: 200, data: raw });
    const config = { ...c(), wereadDirectoryEnabled: true };
    await expect(fetchOwnerWereadLatest(config)).rejects.toThrow(
      '微信读书登录超时',
    );
    const saved = await fs.readFile(c().wereadLatestStateFile, 'utf8');
    const state = JSON.parse(saved);
    expect(state.stop).toMatchObject({
      stage: 'directory-0',
      requests: 1,
      reason: '微信读书登录超时（业务码 -2012）',
    });
    expect(state.lastSuccessAt).toBeUndefined();
    expect(saved).not.toContain('private-trace-fixture');
    expect(
      await fs.readFile(
        `${c().wereadLatestStateFile}.${state.lastAttemptAt}.directory-0.response`,
        'utf8',
      ),
    ).toBe(raw);
    await expect(fetchOwnerWereadLatest(config)).rejects.toThrow('目录已停止');
    expect(await fs.readFile(c().wereadLatestStateFile, 'utf8')).toBe(saved);
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(axios.post).not.toHaveBeenCalled();
    expect(imageFetch).not.toHaveBeenCalled();
  });
  it('reports a content business refusal at HTTP 200 and keeps its private text out of the stop', async () => {
    (axios.get as jest.Mock)
      .mockResolvedValueOnce({
        status: 200,
        data: JSON.stringify({
          reviews: Array.from({ length: 10 }, (_, i) => directoryGroup(i + 1)),
        }),
      })
      .mockResolvedValueOnce({
        status: 200,
        data: JSON.stringify({
          errcode: '-2041',
          message: 'private-upstream-token',
        }),
      });
    const config = { ...c(), wereadDirectoryEnabled: true };
    await expect(fetchOwnerWereadLatest(config)).rejects.toThrow(
      '正文（业务码 -2041）',
    );
    const text = await fs.readFile(c().wereadLatestStateFile, 'utf8');
    expect(JSON.parse(text).stop).toMatchObject({
      stage: 'content-1',
      requests: 2,
      reason: '业务码 -2041',
    });
    expect(text).not.toContain('private-upstream-token');
    expect(JSON.parse(text).lastSuccessAt).toBeUndefined();
    await expect(fetchOwnerWereadLatest(config)).rejects.toThrow(
      '正文已停止：业务码 -2041',
    );
    expect(axios.get).toHaveBeenCalledTimes(2);
  });
  it.each([
    ['<html>unexpected directory</html>', '读书响应格式无效'],
    [JSON.stringify({ reviews: [] }), '目录未返回最近10篇'],
    [JSON.stringify({ errCode: 'secret-token' }), '读书响应格式无效'],
    [JSON.stringify({ errCode: 0, code: -2041 }), '业务码 -2041'],
  ])(
    'reports an invalid directory without reading any bodies (%s)',
    async (data, reason) => {
      (axios.get as jest.Mock).mockResolvedValue({ status: 200, data });
      const config = { ...c(), wereadDirectoryEnabled: true };
      await expect(fetchOwnerWereadLatest(config)).rejects.toThrow(
        `目录（${reason}）`,
      );
      expect(
        JSON.parse(await fs.readFile(c().wereadLatestStateFile, 'utf8')).stop,
      ).toMatchObject({ stage: 'directory-0', reason, requests: 1 });
      await expect(fetchOwnerWereadLatest(config)).rejects.toThrow(
        `目录已停止：${reason}`,
      );
      expect(axios.get).toHaveBeenCalledTimes(1);
    },
  );
  it('a conflicting tenth body rejects the batch and never reaches image fetching', async () => {
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('NO_IMAGE_REQUEST_ALLOWED'));
    (axios.get as jest.Mock).mockImplementation(async (url, options) => {
      if (url.endsWith('/articles'))
        return {
          status: 200,
          data: JSON.stringify({
            reviews: Array.from({ length: 10 }, (_, i) =>
              directoryGroup(i + 1),
            ),
            clearAll: 1,
          }),
        };
      const n = Number(
        options.params.reviewId.split('_').at(-1).replace(/^a+/, ''),
      );
      return {
        status: 200,
        data:
          n === 10
            ? directoryHtml(n).replace('ct=1700000090', 'ct=1700000000')
            : directoryHtml(n),
      };
    });
    await expect(
      fetchOwnerWereadLatest({ ...c(), wereadDirectoryEnabled: true }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(
      JSON.parse(await fs.readFile(c().wereadLatestStateFile, 'utf8')).stop,
    ).toMatchObject({
      stage: 'content-10',
      reason: '正文与目录的身份、标题或发布时间冲突',
    });
  });
  it('fetches bounded cover/content, validates real identity/time, keeps original stop and cooldown', async () => {
    (axios.get as jest.Mock)
      .mockResolvedValueOnce({
        status: 200,
        data: JSON.stringify({
          name: '测试号',
          title: '测试文章',
          reviewId: 'MP_WXS_1234567890_' + 'a'.repeat(22),
        }),
      })
      .mockResolvedValueOnce({ status: 200, data: html });
    const page = await fetchOwnerWereadLatest(c());
    expect(page.coverage).toBe('recent-window');
    expect(page.articles[0]).toMatchObject({
      id: 'WX_1234567890_100_1',
      publishTime: 1700000000,
    });
    expect(page.articles[0].contentHtml).toContain('正文');
    expect(axios.get).toHaveBeenCalledTimes(2);
    expect((axios.get as jest.Mock).mock.calls.map((v) => v[0])).toEqual([
      'https://weread.qq.com/api/mp/cover',
      'https://weread.qq.com/web/mp/content',
    ]);
    expect((axios.get as jest.Mock).mock.calls[0][1]).toMatchObject({
      maxRedirects: 0,
      proxy: false,
    });
    await expect(fetchOwnerWereadLatest(c())).rejects.toThrow('冷却期');
    expect(axios.get).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(c().originalStopFiles[0], 'utf8')).toBe(
      'retained prior original stop',
    );
  });
  it('uses a same-owner cookie rotated by cover for the content request only', async () => {
    const writes = jest.spyOn(fs, 'writeFile');
    (axios.get as jest.Mock)
      .mockResolvedValueOnce({
        status: 200,
        headers: {
          'set-cookie': [
            'wr_vid=123; Domain=weread.qq.com; Path=/; Secure; HttpOnly',
            'wr_skey=rotated-fixture; Domain=weread.qq.com; Path=/; Secure; HttpOnly',
          ],
        },
        data: JSON.stringify({
          name: c().name,
          title: '测试文章',
          reviewId: c().mpId + '_abc',
        }),
      })
      .mockResolvedValueOnce({ status: 200, data: html });
    await fetchOwnerWereadLatest(c());
    expect((axios.get as jest.Mock).mock.calls[0][1].headers.Cookie).toContain(
      'wr_skey=private-token',
    );
    expect((axios.get as jest.Mock).mock.calls[1][1].headers.Cookie).toContain(
      'wr_skey=rotated-fixture',
    );
    expect(
      (axios.get as jest.Mock).mock.calls[1][1].headers.Cookie,
    ).not.toContain('wr_skey=private-token');
    expect(writes.mock.calls.some(([file]) => file === c().sessionFile)).toBe(
      false,
    );
  });
  it.each([
    'wr_skey=api-fixture; Path=/api; Secure',
    'wr_skey=api-fixture; Secure',
  ])(
    'does not leak a cover cookie outside its path (%s)',
    async (setCookie) => {
      (axios.get as jest.Mock)
        .mockResolvedValueOnce({
          status: 200,
          headers: { 'set-cookie': [setCookie] },
          data: JSON.stringify({
            name: c().name,
            title: '测试文章',
            reviewId: c().mpId + '_abc',
          }),
        })
        .mockResolvedValueOnce({ status: 200, data: html });
      await fetchOwnerWereadLatest(c());
      expect((axios.get as jest.Mock).mock.calls[1][1].headers.Cookie).toBe(
        'wr_skey=private-token; wr_vid=123',
      );
      expect(axios.get).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    'wr_vid=999; Path=/; Secure',
    'wr_vid=123; Path=/; Secure; Max-Age=0',
    'wr_skey=deleted; Path=/; Secure; Max-Age=0',
    'wr_skey=bad; Domain=qq.com; Path=/; Secure',
  ])(
    'stops before content on unsafe or deleted response credentials (%s)',
    async (setCookie) => {
      (axios.get as jest.Mock).mockResolvedValueOnce({
        status: 200,
        headers: { 'set-cookie': [setCookie] },
        data: JSON.stringify({
          name: c().name,
          title: '测试文章',
          reviewId: c().mpId + '_abc',
        }),
      });
      await expect(fetchOwnerWereadLatest(c())).rejects.toThrow();
      await expect(fetchOwnerWereadLatest(c())).rejects.toThrow();
      expect(axios.get).toHaveBeenCalledTimes(1);
      const state = JSON.parse(
        await fs.readFile(c().wereadLatestStateFile!, 'utf8'),
      );
      expect(state.stop.requests).toBe(1);
      expect(state.response).toMatchObject({
        stage: 'cover',
        httpStatus: 200,
        requests: 1,
      });
    },
  );

  it('does not mistake structurally valid Web cookies for usable body access', async () => {
    (axios.get as jest.Mock)
      .mockResolvedValueOnce({
        status: 200,
        data: JSON.stringify({
          name: c().name,
          title: '测试文章',
          reviewId: c().mpId + '_abc',
        }),
      })
      .mockResolvedValueOnce({ status: 401, data: '{"errCode":-2012}' });
    await expect(fetchOwnerWereadLatest(c())).rejects.toThrow();
    await expect(fetchOwnerWereadLatest(c())).rejects.toThrow('HTTP 401');
    expect(axios.get).toHaveBeenCalledTimes(2);
    const state = JSON.parse(
      await fs.readFile(c().wereadLatestStateFile!, 'utf8'),
    );
    expect(state.stop).toMatchObject({
      stage: 'content',
      requests: 2,
      reason: 'HTTP 401',
    });
  });
  it('retains refused response and stops before any repeated online request', async () => {
    (axios.get as jest.Mock).mockResolvedValueOnce({
      status: 401,
      data: '{"errCode":-2012}',
    });
    await expect(fetchOwnerWereadLatest(c())).rejects.toThrow('未完成');
    await expect(fetchOwnerWereadLatest(c())).rejects.toThrow('HTTP 401');
    expect(axios.get).toHaveBeenCalledTimes(1);
    const state = JSON.parse(
      await fs.readFile(c().wereadLatestStateFile!, 'utf8'),
    );
    const session = JSON.parse(await fs.readFile(c().sessionFile, 'utf8'));
    expect(state.stop).toMatchObject({
      stage: 'cover',
      requests: 1,
      sessionAuthHash: ownerLatestAuthHash(session, c().ownerVid),
    });
    expect(
      await fs.readFile(
        `${c().wereadLatestStateFile}.${state.lastAttemptAt}.cover.response`,
        'utf8',
      ),
    ).toBe('{"errCode":-2012}');
  });
  it('rejects a mismatched account before the body request', async () => {
    (axios.get as jest.Mock).mockResolvedValueOnce({
      status: 200,
      data: JSON.stringify({
        name: '别的号',
        title: '测试文章',
        reviewId: 'MP_WXS_1234567890_abc',
      }),
    });
    await expect(fetchOwnerWereadLatest(c())).rejects.toThrow('未完成');
    expect(axios.get).toHaveBeenCalledTimes(1);
  });
  it('does not attribute a historical 401 to a different unverified authentication session', async () => {
    (axios.get as jest.Mock).mockResolvedValueOnce({
      status: 401,
      data: '{"errCode":-2012}',
    });
    await expect(fetchOwnerWereadLatest(c())).rejects.toThrow('未完成');
    const originalState = await fs.readFile(c().wereadLatestStateFile, 'utf8');
    const session = JSON.parse(await fs.readFile(c().sessionFile, 'utf8'));
    session.cookies.find((v) => v.name === 'wr_skey').value = 'new-login-token';
    await fs.writeFile(c().sessionFile, JSON.stringify(session));
    await expect(fetchOwnerWereadLatest(c())).rejects.toThrow(
      '当前会话尚未核实',
    );
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(c().wereadLatestStateFile, 'utf8')).toBe(
      originalState,
    );
  });
  it('validates the current owner before reading a historical stop as its failure', async () => {
    await fs.writeFile(
      c().wereadLatestStateFile,
      JSON.stringify({
        stop: { stage: 'cover', reason: 'HTTP 401' },
      }),
    );
    const session = JSON.parse(await fs.readFile(c().sessionFile, 'utf8'));
    session.ownerVid = '999';
    session.cookies.find((v) => v.name === 'wr_vid').value = '999';
    await fs.writeFile(c().sessionFile, JSON.stringify(session));
    await expect(fetchOwnerWereadLatest(c())).rejects.toThrow(
      '会话账号或凭据无法核验',
    );
    expect(axios.get).not.toHaveBeenCalled();
  });
  it('keeps the same failed authentication stopped across auxiliary changes and session file relocation', async () => {
    (axios.get as jest.Mock).mockResolvedValueOnce({
      status: 401,
      data: '{"errCode":-2012}',
    });
    await expect(fetchOwnerWereadLatest(c())).rejects.toThrow('未完成');
    const originalState = await fs.readFile(c().wereadLatestStateFile, 'utf8');
    const session = JSON.parse(await fs.readFile(c().sessionFile, 'utf8'));
    session.capturedAt = '2025-01-01T00:00:00Z';
    session.cookies.push({
      name: 'wr_pf',
      value: 'aux-changed',
      domain: '.weread.qq.com',
      path: '/',
      secure: true,
      expires: -1,
    });
    const relocated = path.join(dir, 'relocated-session');
    await fs.writeFile(relocated, JSON.stringify(session));
    await expect(
      fetchOwnerWereadLatest({ ...c(), sessionFile: relocated }),
    ).rejects.toThrow('当前读书会话最新篇已停止：HTTP 401');
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(c().wereadLatestStateFile, 'utf8')).toBe(
      originalState,
    );
  });
  it('keeps a legacy stop blocked when an auxiliary change makes full-cookie ownership inconclusive', async () => {
    const session = JSON.parse(await fs.readFile(c().sessionFile, 'utf8'));
    const stateText = JSON.stringify({
      sessionHash: createHash('sha256')
        .update(ownerSessionCookie(session, c().ownerVid))
        .digest('hex'),
      stop: { stage: 'cover', reason: 'HTTP 401' },
    });
    await fs.writeFile(c().wereadLatestStateFile, stateText);
    session.cookies.push({
      name: 'wr_pf',
      value: 'aux-changed',
      domain: '.weread.qq.com',
      path: '/',
      secure: true,
      expires: -1,
    });
    await fs.writeFile(c().sessionFile, JSON.stringify(session));
    await expect(fetchOwnerWereadLatest(c())).rejects.toThrow(
      '当前会话尚未核实',
    );
    expect(axios.get).not.toHaveBeenCalled();
    expect(await fs.readFile(c().wereadLatestStateFile, 'utf8')).toBe(
      stateText,
    );
  });
  it('preserves an existing concurrency or interruption lock without sending requests', async () => {
    const lockFile = c().wereadLatestStateFile + '.lock';
    await fs.writeFile(lockFile, 'existing-operation');
    await expect(fetchOwnerWereadLatest(c())).rejects.toThrow(
      '更新正在进行或上次中断',
    );
    expect(axios.get).not.toHaveBeenCalled();
    expect(await fs.readFile(lockFile, 'utf8')).toBe('existing-operation');
  });
});
