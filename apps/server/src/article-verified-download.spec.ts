import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import {
  prepareVerifiedProviderDownload,
  verifiedDownloadBody,
} from './article-verified-download';
import { LocalArticleStore } from './article-local-save';
import {
  parseWereadDirectory,
  verifyWereadArticleBody,
} from './collection/weread-directory';
import { archiveProviderImages } from './collection/archive-provider-images';
import { ProviderArticle } from './collection/subscription-provider';

const short = 'https://mp.weixin.qq.com/s/abcdefghijklmnopqrstuv';
const signed =
  'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA%3D%3D&mid=2247000001&idx=1&sn=abcd';
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=';
const inline = `data:image/png;base64,${png}`;

// Exercise the real normal Web body verifier and media archive, not a new parser.
async function normalResult() {
  const mpId = 'MP_WXS_1234567890';
  const reviewId = `${mpId}_abcdefghijklmnopqrstuv`;
  const candidate = parseWereadDirectory(
    {
      reviews: [
        {
          subCount: 1,
          subReviews: [
            {
              reviewId,
              review: {
                reviewId,
                type: 16,
                belongBookId: mpId,
                mpInfo: {
                  originalId: 'abcdefghijklmnopqrstuv',
                  title: '正常正文',
                  mp_name: '测试号',
                  time: 1700000000,
                },
              },
            },
          ],
        },
      ],
    },
    { mpId, name: '测试号' },
  ).articles[0];
  const html = `<meta property="og:url" content="${short}"><h1 id="activity-name">正常正文</h1><span id="js_name">测试号</span><div id="js_content" class="rich_media_content"><p>完整正文</p><img src="${inline}"><img src="${inline}"></div><script>var biz="MTIzNDU2Nzg5MA==";var mid="2247000001";var idx="1";var sn="abcd";var ct=1700000000;</script>`;
  return (
    await archiveProviderImages(
      {
        articles: [verifyWereadArticleBody(candidate, html)],
        coverage: 'recent-window',
        upstreamCount: 1,
        bodyMissing: 0,
        imageBlocked: 0,
      },
      { stopOnFailure: true },
    )
  ).articles[0];
}

describe('normal verified provider to original local saver, no network or database', () => {
  let temporary: string;
  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'wewe-verified-completion-'));
    jest.spyOn(axios, 'get').mockRejectedValue(new Error('NO_NETWORK'));
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('NO_NETWORK'));
  });
  afterEach(async () => {
    expect(axios.get).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    jest.restoreAllMocks();
    await rm(temporary, { recursive: true, force: true });
  });

  it('saves a real verified/archived pipeline result without a database insert, with relative images and duplicate protection', async () => {
    const article = await normalResult();
    const store = new LocalArticleStore(
      join(temporary, 'settings.json'),
      join(temporary, '选择的 目录'),
    );
    const verifiedPrepare = prepareVerifiedProviderDownload(short, article);
    const prepare = async (stage: string) => ({
      ...(await verifiedPrepare(stage)),
      exportSource: { feedId: 'MP_WXS_1234567890', feedName: '测试号' },
    });
    const first = await store.save(prepare);
    expect(first.publicationDate).toBe('2023-11-15');
    expect(first.directory).toContain('2023-11-15_未分组');
    expect(first.alreadySaved).toBe(false);
    expect(first.imageCount).toBe(1); // Two real references share one byte file.
    const markdown = await readFile(first.markdownPath, 'utf8');
    expect(markdown).toContain('完整正文');
    expect(markdown).toContain(article.url);
    expect(markdown.match(/image\/image_/g)).toHaveLength(2);
    const images = await readdir(join(first.directory, 'image'));
    expect(images).toHaveLength(1);
    expect(await readFile(join(first.directory, 'image', images[0]))).toEqual(
      Buffer.from(png, 'base64'),
    );
    const second = await store.save(prepare);
    expect(second).toMatchObject({
      alreadySaved: true,
      markdownPath: first.markdownPath,
    });
    expect(await readFile(first.markdownPath, 'utf8')).toBe(markdown);
  });

  it('accepts an exact long identity and snapshots the result before asynchronous publication', async () => {
    const article = await normalResult();
    const prepare = prepareVerifiedProviderDownload(signed, article);
    const title = article.title;
    article.title = '替换标题';
    article.contentHtml = '<div id="js_content">替换正文</div>';
    article.url = signed.replace('2247000001', '2247000002');
    const result = await prepare(temporary);
    expect(result.title).toBe(title);
    expect(result.publishTime).toBe(1700000000);
    const markdown = await readFile(join(temporary, 'index.md'), 'utf8');
    expect(markdown).toContain('完整正文');
    expect(markdown).not.toContain('替换');
  });

  it.each([
    ['different short link', { shortUrl: short.replace('abcdef', 'zzzzzz') }],
    ['missing short binding', { shortUrl: null }],
    ['different stable identity', { id: 'WX_1234567890_2247000002_1' }],
    ['different publisher', { mpId: 'MP_WXS_9876543210' }],
    ['missing trusted time', { publishTime: 0 }],
    ['blank title', { title: ' ' }],
  ])(
    'rejects %s before creating directories, without fallback',
    async (_name, patch) => {
      const article = {
        ...(await normalResult()),
        ...patch,
      } as ProviderArticle;
      expect(() => prepareVerifiedProviderDownload(short, article)).toThrow(
        expect.objectContaining({
          diagnostic: { code: 'VERIFIED_ARTICLE_MISMATCH' },
        }),
      );
      expect(await readdir(temporary)).toEqual([]);
    },
  );

  it.each([
    null,
    '<div id="js_content"></div>',
    '<div id="js_verify"></div><div id="js_content">challenge</div>',
    '<div id="js_content"><img src="https://mmbiz.qpic.cn/a.jpg"></div>',
    '<div id="js_content"><img src="data:image/png;base64,YQ=="></div>',
    `<div id="js_content">${`<img src="${inline}">`.repeat(61)}</div>`,
  ])('rejects incomplete or unarchived body %s', async (contentHtml) => {
    const article = { ...(await normalResult()), contentHtml };
    expect(() => prepareVerifiedProviderDownload(short, article)).toThrow(
      expect.objectContaining({
        diagnostic: { code: 'VERIFIED_ARTICLE_UNAVAILABLE' },
      }),
    );
    expect(await readdir(temporary)).toEqual([]);
  });

  it('bounds already inlined HTML and strips active content through the existing policy', () => {
    expect(() => verifiedDownloadBody('x'.repeat(35_000_001))).toThrow();
    expect(() =>
      verifiedDownloadBody(
        `<div id="js_content">${'x'.repeat(5_000_001)}</div>`,
      ),
    ).toThrow();
    expect(() =>
      verifiedDownloadBody('<div id="js_content"><script>bad()</script></div>'),
    ).toThrow();
    expect(
      verifiedDownloadBody(
        '<div id="js_content" onclick="bad()"><p>正文</p><script>secret()</script><iframe src="http://evil.invalid"></iframe></div>',
      ),
    ).toBe('<div id="js_content"><p>正文</p></div>');
  });
});
