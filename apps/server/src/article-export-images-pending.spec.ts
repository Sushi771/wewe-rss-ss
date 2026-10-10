import { buildArticleMarkdown } from './article-export';

describe('partial text cache export boundary', () => {
  it.each([
    {
      lastBodyStatus: 'images-pending',
      contentHtml: '<div id="js_content">已核文字</div>',
    },
    {
      lastBodyStatus: 'available',
      contentHtml:
        '<div id="js_content" data-wewe-image-pending="1">已核文字</div>',
    },
  ])(
    'does not represent missing source bytes as a complete offline export',
    async (partial) => {
      const fetcher = jest.fn();
      await expect(
        buildArticleMarkdown(
          {
            id: 'WX_1234567890_1_1',
            title: '合成文章',
            sourceUrl:
              'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA==&mid=1&idx=1',
            metrics: null,
            publishTime: 1700000000,
            ...partial,
          },
          '',
          undefined,
          fetcher,
        ),
      ).rejects.toThrow('图片待补');
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
});
