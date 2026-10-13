import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import {
  prepareConfirmedDomDownload,
  ConfirmedDomArticle,
} from './article-manual-dom';
import { LocalArticleStore } from './article-local-save';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=';
const originalUrl =
  'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA==&mid=2247000001&idx=1&sn=abcd&chksm=abcd#rd';
const confirmation: ConfirmedDomArticle = {
  pageUrl: 'https://weread.qq.com/web/mp/reader/fixture',
  originalUrl,
  title: '人工确认的当前文章',
  publisher: '测试号',
  publishTime: 1700000000,
  imageCount: 1,
  confirmedComplete: true,
};
const observation = {
  pageUrl: confirmation.pageUrl,
  html: `<meta property="og:url" content="${originalUrl}"><h1 id="activity-name">${confirmation.title}</h1><span id="js_name">测试号</span><script>var biz="MTIzNDU2Nzg5MA==";var mid="2247000001";var idx="1";var ct="1700000000";</script><div id="js_content"><p>当前文章全部正文</p><img src="wewe-image:0"></div>`,
  images: [{ index: 0, inline: 'data:image/png;base64,' + png }],
  omittedEmptyImageNodes: 2,
};

describe('one manually confirmed DOM article to original local saver, offline', () => {
  let temporary: string;
  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'wewe-manual-dom-'));
    jest.spyOn(axios, 'get').mockRejectedValue(new Error('NO_NETWORK'));
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('NO_NETWORK'));
  });
  afterEach(async () => {
    expect(axios.get).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    jest.restoreAllMocks();
    await rm(temporary, { recursive: true, force: true });
  });
  it('reuses the existing Markdown/image saver with genuine long identity and no short/directory claims', async () => {
    const store = new LocalArticleStore(
      join(temporary, 'settings.json'),
      join(temporary, 'vault'),
    );
    const prepare = prepareConfirmedDomDownload(confirmation, observation);
    const first = await store.save(prepare);
    expect(first.imageCount).toBe(1);
    const markdown = await readFile(first.markdownPath, 'utf8');
    expect(markdown).toContain('当前文章全部正文');
    const files = await readdir(join(first.directory, 'image'));
    expect(files).toHaveLength(1);
    expect(await readFile(join(first.directory, 'image', files[0]))).toEqual(
      Buffer.from(png, 'base64'),
    );
    expect((await store.save(prepare)).alreadySaved).toBe(true);
  });
  it.each([
    { ...confirmation, confirmedComplete: false },
    { ...confirmation, imageCount: 2 },
    {
      ...confirmation,
      originalUrl: originalUrl.replace('2247000001', '2247000002'),
    },
    {
      ...confirmation,
      originalUrl: 'https://mp.weixin.qq.com/s/abcdefghijklmnopqrstuv',
    },
    { ...confirmation, publishTime: 1700000001 },
    { ...confirmation, title: '其他文章' },
    { ...confirmation, publisher: '其他号' },
    { ...confirmation, pageUrl: confirmation.pageUrl + 'other' },
  ])(
    'rejects missing manual scope or mismatched identity before creating files',
    async (expected) => {
      expect(() =>
        prepareConfirmedDomDownload(
          expected as ConfirmedDomArticle,
          observation,
        ),
      ).toThrow();
      expect(await readdir(temporary)).toEqual([]);
    },
  );
  it('rejects candidate-only flags, placeholders and missing original bytes', () => {
    for (const raw of [
      { ...observation, candidateOnly: true },
      { ...observation, images: [] },
      {
        ...observation,
        images: [{ index: 0, inline: 'data:image/png;base64,YQ==' }],
      },
    ])
      expect(() => prepareConfirmedDomDownload(confirmation, raw)).toThrow();
  });
});
