import axios from 'axios';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  fetchLiveOwnerArticles,
  readOwnerSearchConfig,
} from './owner-search-update';
import { fetchOwnerSearchPage } from './owner-web-search';
import { searchArticleCandidates } from './article-candidate';
jest.mock('axios');
jest.mock('./owner-web-search', () => ({
  ...jest.requireActual('./owner-web-search'),
  fetchOwnerSearchPage: jest.fn(),
}));

describe('live owner update transport (no real HTTP)', () => {
  let dir: string;
  let previousConfig: string | undefined;
  const biz = 'MTIzNDU2Nzg5MA==';
  const raw = `https://mp.weixin.qq.com/s?__biz=${encodeURIComponent(biz)}&mid=100&idx=1&sn=abcd&scene=27`;
  const candidates = () =>
    searchArticleCandidates(
      [{ doc_url: raw, title: '测试文章', source: { title: '测试号' } }],
      { name: '测试号', biz },
      {
        source: 'owner-web-search',
        capturedAt: new Date().toISOString(),
        page: 1,
      },
    );
  const config = () => ({
    mpId: 'MP_WXS_1234567890',
    name: '测试号',
    biz,
    ownerVid: '123',
    sessionFile: path.join(dir, 'session'),
    stateFile: path.join(dir, 'search-state'),
    originalStopFiles: [path.join(dir, 'prior-stop')],
    runtimeStopFile: path.join(dir, 'runtime-stop'),
  });
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-live-'));
    jest.clearAllMocks();
    previousConfig = process.env.OWNER_SEARCH_CONFIG_FILE;
  });
  afterEach(async () => {
    if (previousConfig === undefined)
      delete process.env.OWNER_SEARCH_CONFIG_FILE;
    else process.env.OWNER_SEARCH_CONFIG_FILE = previousConfig;
    await fs.rm(dir, { recursive: true, force: true });
  });
  it('honors saved original stop before searching; does not delete evidence', async () => {
    const evidence = JSON.stringify({
      httpStatus: 302,
      stopFurtherOriginalRequests: true,
    });
    await fs.writeFile(config().originalStopFiles[0], evidence);
    await expect(fetchLiveOwnerArticles(config())).rejects.toThrow(
      '本次未发联网请求',
    );
    expect(fetchOwnerSearchPage).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
    expect(await fs.readFile(config().originalStopFiles[0], 'utf8')).toBe(
      evidence,
    );
  });
  it('uses exact source URL, no Cookie; verifies identity/time/body', async () => {
    (fetchOwnerSearchPage as jest.Mock).mockResolvedValue({
      candidates: candidates(),
      pages: 1,
    });
    (axios.get as jest.Mock).mockResolvedValue({
      status: 200,
      data: `<meta property="og:url" content="https://mp.weixin.qq.com/s/${'a'.repeat(22)}"><h1 id="activity-name">测试文章</h1><div id="js_content">正文</div><script>var biz="${biz}";var mid="100";var idx="1";var sn="abcd";var ct=1700000000;</script>`,
    });
    const page = await fetchLiveOwnerArticles(config());
    expect(fetchOwnerSearchPage).toHaveBeenCalledWith(
      expect.objectContaining({ maxPages: 2 }),
    );
    expect(axios.get).toHaveBeenCalledWith(
      raw,
      expect.objectContaining({ maxRedirects: 0, proxy: false }),
    );
    expect(
      (axios.get as jest.Mock).mock.calls[0][1].headers.Cookie,
    ).toBeUndefined();
    expect(page.articles[0]).toMatchObject({
      id: 'WX_1234567890_100_1',
      publishTime: 1700000000,
    });
    expect(page.articles[0].contentHtml).toContain('正文');
  });
  it('302 stops the batch, persists stop across restart and never falls back to cached body', async () => {
    (fetchOwnerSearchPage as jest.Mock).mockResolvedValue({
      candidates: [...candidates(), ...candidates()],
      pages: 1,
    });
    (axios.get as jest.Mock).mockResolvedValue({ status: 302, data: '' });
    await expect(fetchLiveOwnerArticles(config())).rejects.toThrow('HTTP 302');
    await expect(fetchLiveOwnerArticles(config())).rejects.toThrow(
      '本次未发联网请求',
    );
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(await fs.readFile(config().runtimeStopFile, 'utf8'))
        .stopFurtherOriginalRequests,
    ).toBe(true);
  });

  it('accepts an explicit private page budget and passes it to discovery', async () => {
    const file = path.join(dir, 'config.json');
    const c = { ...config(), searchMaxPages: 5 };
    await fs.writeFile(file, JSON.stringify({ feeds: { [c.mpId]: c } }));
    process.env.OWNER_SEARCH_CONFIG_FILE = file;
    const loaded = await readOwnerSearchConfig(c.mpId);
    (fetchOwnerSearchPage as jest.Mock).mockResolvedValue({
      candidates: [],
      pages: 3,
    });
    await fetchLiveOwnerArticles(loaded);
    expect(fetchOwnerSearchPage).toHaveBeenCalledWith(
      expect.objectContaining({ maxPages: 5 }),
    );
    expect(axios.get).not.toHaveBeenCalled();
  });

  it.each([0, 6, '5', 1.5, null])(
    'rejects invalid private page budget %s before discovery',
    async (searchMaxPages) => {
      const file = path.join(dir, 'config.json');
      const c = { ...config(), searchMaxPages };
      await fs.writeFile(file, JSON.stringify({ feeds: { [c.mpId]: c } }));
      process.env.OWNER_SEARCH_CONFIG_FILE = file;
      await expect(readOwnerSearchConfig(c.mpId)).rejects.toThrow('配置无效');
      expect(fetchOwnerSearchPage).not.toHaveBeenCalled();
      expect(axios.get).not.toHaveBeenCalled();
    },
  );
});
