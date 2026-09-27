import axios from 'axios';
import { WereadService } from './weread.service';

jest.mock('../collection/article-page', () => ({
  ...jest.requireActual('../collection/article-page'),
  articlePageRequest: jest.fn(() => ({
    text: () => Promise.resolve('verification required'),
  })),
}));

describe('cover publication dates', () => {
  const account = { id: 'test', token: '{}' };
  afterEach(() => jest.restoreAllMocks());

  it('does not use cover updateTime or collection time when article content is unavailable', async () => {
    jest
      .spyOn(axios, 'get')
      .mockResolvedValueOnce({
        data: {
          reviewId: 'MP_WXS_12345_short~id',
          title: '旧封面',
          updateTime: 1790479663,
        },
      })
      .mockRejectedValueOnce(new Error('Content unavailable'));
    const articles = await new WereadService({} as any).getMpArticles(
      'MP_WXS_12345',
      1,
      account,
    );
    expect(articles).toEqual([
      { id: 'short_id', title: '旧封面', picUrl: '', publishTime: null },
    ]);
  });

  it('uses the explicit publication timestamp from the content response', async () => {
    jest
      .spyOn(axios, 'get')
      .mockResolvedValueOnce({
        data: {
          reviewId: 'MP_WXS_12345_article',
          title: '文章',
          updateTime: 1790479663,
        },
      })
      .mockResolvedValueOnce({
        data: '<div id="js_content">正文</div><script>var create_time = "1787013185";</script>',
      });
    expect(
      (
        await new WereadService({} as any).getMpArticles(
          'MP_WXS_12345',
          1,
          account,
        )
      )[0].publishTime,
    ).toBe(1787013185);
  });

  it('rejects future timestamps as publication evidence', async () => {
    jest
      .spyOn(axios, 'get')
      .mockResolvedValueOnce({
        data: { reviewId: 'MP_WXS_12345_article', title: '文章' },
      })
      .mockResolvedValueOnce({ data: '<script>var ct = 9999999999;</script>' });
    expect(
      (
        await new WereadService({} as any).getMpArticles(
          'MP_WXS_12345',
          1,
          account,
        )
      )[0].publishTime,
    ).toBeNull();
  });
});
