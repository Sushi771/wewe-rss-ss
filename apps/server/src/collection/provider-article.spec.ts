import { parseWechat2RssJsonFeed } from './provider-article';

const feedId = 'MP_WXS_1234567890';
const articleUrl = (mid: number) =>
  `https://mp.weixin.qq.com/s?__biz=${Buffer.from('1234567890').toString('base64')}&mid=${mid}&idx=1`;
const item = (mid: number) => ({
  id: articleUrl(mid),
  title: `文章 ${mid}`,
  date_published: '2026-09-28T12:34:56+08:00',
  content_html:
    '<div><p>真实正文</p><script>alert(1)</script><img data-src="https://mmbiz.qpic.cn/1.jpg" onerror="bad()"></div>',
});

describe('Wechat2RSS JSON Feed candidate parser', () => {
  it('requires five distinct original identities and keeps safe body images', () => {
    const page = parseWechat2RssJsonFeed(
      { items: [1, 2, 3, 4, 5].map(item) },
      feedId,
    );
    expect(page.articles).toHaveLength(5);
    expect(new Set(page.articles.map((v) => v.id)).size).toBe(5);
    expect(page.articles[0]).toMatchObject({
      id: 'WX_1234567890_1_1',
      mpId: feedId,
      publishTime: Math.floor(Date.parse('2026-09-28T12:34:56+08:00') / 1000),
      picUrl: 'https://mmbiz.qpic.cn/1.jpg',
    });
    expect(page.articles[0].contentHtml).toContain('真实正文');
    expect(page.articles[0].contentHtml).not.toContain('<script');
    expect(page.articles[0].contentHtml).not.toContain('onerror');
  });

  it('blocks missing identity, duplicates, mismatched feed, and date without timezone', () => {
    expect(() =>
      parseWechat2RssJsonFeed(
        { items: [{ ...item(1), id: 'random' }] },
        feedId,
      ),
    ).toThrow('WECHAT2RSS_ARTICLE_IDENTITY_UNVERIFIED');
    expect(() =>
      parseWechat2RssJsonFeed({ items: [item(1), item(1)] }, feedId),
    ).toThrow('WECHAT2RSS_ARTICLE_IDENTITY_CONFLICT');
    expect(() =>
      parseWechat2RssJsonFeed({ items: [item(1)] }, 'MP_WXS_9876543210'),
    ).toThrow('WECHAT2RSS_ARTICLE_IDENTITY_CONFLICT');
    expect(() =>
      parseWechat2RssJsonFeed(
        { items: [{ ...item(1), date_published: '2026-09-28T12:34:56' }] },
        feedId,
      ),
    ).toThrow('WECHAT2RSS_ARTICLE_METADATA_INVALID');
  });

  it('drops unsafe images without claiming they were archived', () => {
    const page = parseWechat2RssJsonFeed(
      {
        items: [
          {
            ...item(1),
            content_html: '<p>正文</p><img src="http://127.0.0.1/secret">',
          },
        ],
      },
      feedId,
    );
    expect(page.imageBlocked).toBe(1);
    expect(page.articles[0].contentHtml).not.toContain('127.0.0.1');
    expect(page.articles[0].contentHtml).toContain(
      'data-wewe-image-pending="1"',
    );
  });
  it('keeps unknown source-less body images pending rather than guessing a placeholder role', () => {
    const page = parseWechat2RssJsonFeed(
      {
        items: [
          {
            ...item(1),
            content_html:
              '<p>完整文字</p><img class="rich_pages wxw-img" style="width:552px;height:228px">',
          },
        ],
      },
      feedId,
    );
    expect(page.imageBlocked).toBe(1);
    expect(page.bodyMissing).toBe(0);
    expect(page.articles[0].contentHtml).toContain('完整文字');
    expect(page.articles[0].contentHtml).toContain(
      'data-wewe-image-pending="1"',
    );
  });
});
