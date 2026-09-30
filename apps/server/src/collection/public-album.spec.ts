import axios from 'axios';
import {
  fetchPublicAlbums,
  resolvePublicArticle,
  publicArticleRequestUrl,
} from './public-album';
import { PublicAlbumProvider } from './providers/public-album';

jest.mock('axios');

const get = axios.get as jest.MockedFunction<typeof axios.get>;
const mpId = 'MP_WXS_3895431412';
const albumA = '2527940920407949313';
const albumB = '3588220544052641807';

// Synthetic articles model the live getalbum_resp structure. In particular,
// idx=2 is a regression fixture, NOT evidence of a real secondary article.
function article(mid: string, idx = '1', number = '3895431412') {
  const biz = Buffer.from(number).toString('base64');
  return {
    title: `合成测试文章 ${mid}/${idx}`,
    create_time: '1719737099',
    msgid: mid,
    itemidx: idx,
    url: `http://mp.weixin.qq.com/s?__biz=${biz}&amp;mid=${mid}&amp;idx=${idx}&amp;sn=fixture&amp;key=discard-me#rd`,
    cover_img_1_1: 'https://mmbiz.qpic.cn/fixture/300',
    key: 'discard-me',
    user_read_status: '0',
  };
}

function page(
  articles: ReturnType<typeof article>[],
  more: '0' | '1',
  total?: string,
) {
  return {
    data: {
      base_resp: { ret: 0 },
      getalbum_resp: {
        article_list: articles,
        verify_status: '0',
        continue_flag: more,
        base_info: total
          ? { title: '测试合集', article_count: total, read_count: '28586' }
          : { is_first_screen: '0' },
      },
    },
  };
}

describe('public album collection (synthetic pagination regression)', () => {
  const originalProxy = process.env.WECHAT_PUBLIC_PROXY_URL;

  beforeEach(() => {
    get.mockReset();
    delete process.env.WECHAT_PUBLIC_PROXY_URL;
    jest.useFakeTimers({ advanceTimers: true });
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalProxy === undefined) delete process.env.WECHAT_PUBLIC_PROXY_URL;
    else process.env.WECHAT_PUBLIC_PROXY_URL = originalProxy;
  });
  it('maps official album fields through the selected-albums Provider contract', async () => {
    get.mockResolvedValueOnce(page([article('2247483929')], '0', '1'));
    const provider = new PublicAlbumProvider(mpId, [albumA]);
    expect(provider.id).toBe('public-album');
    expect(await provider.fetchArticles(mpId)).toMatchObject({
      coverage: 'selected-albums',
      pages: 1,
      upstreamCount: 1,
      bodyMissing: 1,
      articles: [{ contentHtml: null, mpId }],
    });
    await expect(provider.fetchArticles('MP_WXS_12345')).rejects.toThrow(
      '绑定不一致',
    );
    expect(get).toHaveBeenCalledTimes(1);
  });
  it('accepts the observed singleton terminal-page shape without losing the last article', async () => {
    get.mockResolvedValueOnce(page([article('2247483929')], '1', '2'));
    const last = page([], '0');
    get.mockResolvedValueOnce({
      data: {
        ...last.data,
        getalbum_resp: {
          ...last.data.getalbum_resp,
          article_list: article('2247483923'),
        },
      },
    });
    const result = await fetchPublicAlbums(mpId, [albumA]);
    expect(result.pages).toBe(2);
    expect(result.articles.map((row) => row.id)).toEqual([
      'WX_3895431412_2247483929_1',
      'WX_3895431412_2247483923_1',
    ]);
  });
  it.each([{}, { title: 'invalid' }, { ...article('2247483923'), msgid: 123 }])(
    'rejects malformed singleton article objects',
    async (articleList) => {
      const invalid = page([], '0');
      get.mockResolvedValueOnce({
        data: {
          ...invalid.data,
          getalbum_resp: {
            ...invalid.data.getalbum_resp,
            article_list: articleList,
          },
        },
      });
      await expect(fetchPublicAlbums(mpId, [albumA])).rejects.toThrow(
        '无效列表',
      );
      expect(get).toHaveBeenCalledTimes(1);
    },
  );
  it('retains the real chksm signature while discarding session or tracking parameters', () => {
    const raw = article('2247483929').url.replace(
      '#rd',
      '&amp;chksm=0123456789abcdef#rd',
    );
    const url = new URL(publicArticleRequestUrl(raw));
    expect(url.protocol).toBe('https:');
    expect(url.searchParams.get('chksm')).toBe('0123456789abcdef');
    expect(url.searchParams.has('key')).toBe(false);
    expect(() =>
      publicArticleRequestUrl(raw.replace('0123456789abcdef', 'invalid')),
    ).toThrow('签名无效');
  });

  it('follows both cursor fields and keeps a secondary item separate from its primary', async () => {
    get
      .mockResolvedValueOnce(page([article('2247483929')], '1', '3'))
      .mockResolvedValueOnce(
        page([article('2247483929', '2'), article('2247483867')], '0'),
      );

    const result = await fetchPublicAlbums(mpId, [albumA]);
    expect(result.pages).toBe(2);
    expect(result.albums).toEqual([
      { id: albumA, title: '测试合集', pages: 2, articles: 3 },
    ]);
    expect(result.articles.map((item) => item.id)).toEqual([
      'WX_3895431412_2247483929_1',
      'WX_3895431412_2247483929_2',
      'WX_3895431412_2247483867_1',
    ]);
    expect(get.mock.calls[0][1]).toMatchObject({
      params: {
        action: 'getalbum',
        __biz: 'Mzg5NTQzMTQxMg==',
        album_id: albumA,
        count: 10,
        f: 'json',
      },
      proxy: false,
      maxRedirects: 0,
    });
    expect(get.mock.calls[1][1]?.params).toMatchObject({
      begin_msgid: '2247483929',
      begin_itemidx: '1',
    });
    expect(result.articles[0].publishTime).toBe(1719737099);
    expect(result.articles[0]).not.toHaveProperty('readCount');
    expect(result.articles[0]).not.toHaveProperty('likeCount');
    expect(JSON.stringify(result.articles)).not.toContain('discard-me');
    expect(JSON.stringify(result.articles)).not.toContain('28586');
  });

  it('deduplicates shared articles across albums and duplicate album IDs', async () => {
    get
      .mockResolvedValueOnce(page([article('2247483929')], '0', '1'))
      .mockResolvedValueOnce(
        page([article('2247483929'), article('2247483867')], '0', '2'),
      );
    const result = await fetchPublicAlbums(mpId, [albumA, albumA, albumB]);
    expect(get).toHaveBeenCalledTimes(2);
    expect(result.articles).toHaveLength(2);
    expect(result.albums.map((album) => album.articles)).toEqual([1, 2]);
  });

  it('aborts a repeating cursor instead of looping forever', async () => {
    get.mockResolvedValue(page([article('2247483929')], '1', '2'));
    await expect(fetchPublicAlbums(mpId, [albumA])).rejects.toThrow('重复分页');
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('rejects an HTML verification page even when HTTP succeeded', async () => {
    get.mockResolvedValue({ data: '<html>环境异常，请完成验证</html>' });
    await expect(fetchPublicAlbums(mpId, [albumA])).rejects.toThrow('验证页');
  });

  it('rejects another account after a valid first page without returning partial articles', async () => {
    get
      .mockResolvedValueOnce(page([article('2247483929')], '1', '2'))
      .mockResolvedValueOnce(
        page([article('2247483867', '1', '3286016687')], '0'),
      );
    await expect(fetchPublicAlbums(mpId, [albumA])).rejects.toThrow('身份');
  });

  it('rejects a mismatched link index rather than collapsing a secondary article', async () => {
    const item = { ...article('2247483929', '2'), itemidx: '1' };
    get.mockResolvedValue(page([item], '0', '1'));
    await expect(fetchPublicAlbums(mpId, [albumA])).rejects.toThrow('不一致');
  });

  it('rejects a terminal empty page that contradicts the announced album count', async () => {
    get
      .mockResolvedValueOnce(page([article('2247483929')], '1', '2'))
      .mockResolvedValueOnce(page([], '0'));
    await expect(fetchPublicAlbums(mpId, [albumA])).rejects.toThrow();
  });

  it('rejects a missing response status instead of coercing null to success', async () => {
    const response = page([article('2247483929')], '0', '1');
    get.mockResolvedValue({
      data: { ...response.data, base_resp: { ret: null } },
    });
    await expect(fetchPublicAlbums(mpId, [albumA])).rejects.toThrow();
  });

  it('rejects a business verification state before using article rows', async () => {
    const response = page([article('2247483929')], '0', '1');
    get.mockResolvedValue({
      data: {
        ...response.data,
        getalbum_resp: { ...response.data.getalbum_resp, verify_status: '1' },
      },
    });
    await expect(fetchPublicAlbums(mpId, [albumA])).rejects.toThrow('验证页');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty page claiming more data', async () => {
    get.mockResolvedValue(page([], '1', '2'));
    await expect(fetchPublicAlbums(mpId, [albumA])).rejects.toThrow('分页状态');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('does not expose raw request errors that may contain sensitive response details', async () => {
    get.mockRejectedValue(new Error('request failed key=discard-me'));
    await expect(fetchPublicAlbums(mpId, [albumA])).rejects.toThrow(
      '公开合集请求失败，本次未写入',
    );
  });

  it('only accepts the explicitly configured loopback HTTP proxy', async () => {
    process.env.WECHAT_PUBLIC_PROXY_URL = 'http://127.0.0.1:7890';
    get.mockResolvedValue(page([article('2247483929')], '0', '1'));
    await fetchPublicAlbums(mpId, [albumA]);
    expect(get.mock.calls[0][1]?.proxy).toEqual({
      protocol: 'http',
      host: '127.0.0.1',
      port: 7890,
    });
    get.mockClear();
    process.env.WECHAT_PUBLIC_PROXY_URL = 'http://someone:secret@example.com';
    await expect(fetchPublicAlbums(mpId, [albumA])).rejects.toThrow('本机');
    expect(get).not.toHaveBeenCalled();
  });

  describe('short-link identity verification', () => {
    const shortId = 'K_oKauPpwhSyavBWQXFMKw';
    const canonical = `https://mp.weixin.qq.com/s/${shortId}`;
    function originalPage(
      canonicalUrl = canonical,
      accountNumber = '3895431412',
    ) {
      return `<html><head><meta property="og:url" content="${canonicalUrl}"></head>
        <body><div id="js_content">合成正文</div><script>
        var biz = "${Buffer.from(accountNumber).toString('base64')}" || "";
        var mid = "2247493540" || "";
        var idx = "1" || "";
        var sn = "abcdef0123456789" || "";
        var ct = "1719737099";
        var key = "never-return-this";
        </script></body></html>`;
    }

    it('requires matching canonical short URL and account before returning a clean identity', async () => {
      process.env.WECHAT_PUBLIC_PROXY_URL = 'http://127.0.0.1:7890';
      get.mockResolvedValue({ data: originalPage() });
      const identity = await resolvePublicArticle(shortId, mpId);
      expect(identity).toMatchObject({
        id: 'WX_3895431412_2247493540_1',
        mpId,
        canonical,
        publishTime: 1719737099,
      });
      expect(new URL(identity.url).searchParams.get('idx')).toBe('1');
      expect(JSON.stringify(identity)).not.toContain('never-return-this');
      expect(get.mock.calls[0][0]).toBe(canonical);
      expect(get.mock.calls[0][1]?.proxy).toEqual({
        protocol: 'http',
        host: '127.0.0.1',
        port: 7890,
      });
    });

    it('rejects a redirected or mismatched canonical article even if its account matches', async () => {
      get.mockResolvedValue({
        data: originalPage('https://mp.weixin.qq.com/s/ACwzUugl4sDvt9nG0d5YvQ'),
      });
      await expect(resolvePublicArticle(shortId, mpId)).rejects.toThrow(
        '无法核验旧文章',
      );
    });

    it('rejects another account even when the canonical short URL matches', async () => {
      get.mockResolvedValue({ data: originalPage(canonical, '3286016687') });
      await expect(resolvePublicArticle(shortId, mpId)).rejects.toThrow(
        '无法核验旧文章',
      );
    });

    it('rejects verification HTML without an article body', async () => {
      get.mockResolvedValue({
        data: originalPage().replace(
          '<div id="js_content">合成正文</div>',
          '<div>环境异常，请完成验证</div>',
        ),
      });
      await expect(resolvePublicArticle(shortId, mpId)).rejects.toThrow(
        '无法核验旧文章',
      );
    });

    it('does not fetch invalid IDs or propagate sensitive axios error details', async () => {
      await expect(
        resolvePublicArticle('https://unrelated.example/path', mpId),
      ).rejects.toThrow('不是可验证的微信短链');
      expect(get).not.toHaveBeenCalled();
      get.mockRejectedValue(new Error('Authorization: never-return-this'));
      await expect(resolvePublicArticle(shortId, mpId)).rejects.toThrow(
        `无法核验旧文章 ${shortId} 的原文身份，本次未写入，避免创建重复文章`,
      );
    });

    it('does not contact a credential-bearing or external proxy', async () => {
      process.env.WECHAT_PUBLIC_PROXY_URL =
        'http://user:never-return-this@unrelated.example';
      await expect(resolvePublicArticle(shortId, mpId)).rejects.toThrow(
        '无法核验旧文章',
      );
      expect(get).not.toHaveBeenCalled();
    });
  });
});
