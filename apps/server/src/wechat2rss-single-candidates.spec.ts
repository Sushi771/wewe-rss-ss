import { readWechat2RssSingleCandidates } from './wechat2rss-single-candidates';
import { wechat2RssProvider } from './collection/provider-registry';
import { parseWechat2RssJsonFeed } from './collection/provider-article';

jest.mock('./collection/provider-registry', () => ({
  wechat2RssProvider: jest.fn(),
}));

describe('single candidates use existing authorized cache independently of collection login; offline JSON Feed', () => {
  const feedId = 'MP_WXS_1234567890';
  const url =
    'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA%3D%3D&mid=2247000001&idx=1&sn=abcdef';
  it('does not let unavailable login or a login request failure block a valid cached body', async () => {
    const checkAccountStatus = jest
      .fn()
      .mockRejectedValue(new Error('WECHAT2RSS_REQUEST_FAILED'));
    const fetchArticles = jest.fn().mockResolvedValue(
      parseWechat2RssJsonFeed(
        {
          items: [
            {
              id: '',
              url,
              title: '已授权缓存',
              content_html: '<p>离线正文</p>',
              date_published: '2026-10-10T10:00:00Z',
            },
          ],
        },
        feedId,
      ),
    );
    (wechat2RssProvider as jest.Mock).mockReturnValue({
      checkAccountStatus,
      fetchArticles,
    });
    expect(await readWechat2RssSingleCandidates(feedId)).toMatchObject([
      { articleId: 'WX_1234567890_2247000001_1', title: '已授权缓存', url },
    ]);
    expect(checkAccountStatus).not.toHaveBeenCalled();
    expect(fetchArticles).toHaveBeenCalledWith(feedId);
  });
  it('a failed feed read remains a cache error rather than a fabricated account restriction', async () => {
    const fetchArticles = jest
      .fn()
      .mockRejectedValue(new Error('WECHAT2RSS_REQUEST_FAILED'));
    (wechat2RssProvider as jest.Mock).mockReturnValue({ fetchArticles });
    await expect(readWechat2RssSingleCandidates(feedId)).rejects.toMatchObject({
      diagnostic: { code: 'SINGLE_CANDIDATES_UNAVAILABLE' },
    });
  });
});
