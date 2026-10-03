import axios from 'axios';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fetchOwnerWereadLatest } from './owner-weread-latest';
jest.mock('axios');

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
    expect(state.stop).toMatchObject({ stage: 'cover', requests: 1 });
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
});
