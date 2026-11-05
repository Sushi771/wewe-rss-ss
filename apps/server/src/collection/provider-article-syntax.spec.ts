jest.mock('cheerio', () => {
  const actual = jest.requireActual('cheerio');
  return {
    ...actual,
    load: (html: string, ...args: unknown[]) => {
      if (html.includes('BODY_SYNTHETIC_SYNTAX'))
        throw new SyntaxError('synthetic');
      return actual.load(html, ...args);
    },
  };
});

import { parseWechat2RssJsonFeed } from './provider-article';

it('keeps verified identity and continues after a single body syntax failure', () => {
  const item = (mid: number, html: string) => ({
    url: `https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA%3D%3D&mid=${mid}&idx=1&sn=abcdef`,
    title: `synthetic-${mid}`,
    date_published: '2024-01-01T00:00:00Z',
    content_html: html,
  });
  const result = parseWechat2RssJsonFeed(
    { items: [item(1, 'BODY_SYNTHETIC_SYNTAX'), item(2, '<p>later body</p>')] },
    'MP_WXS_1234567890',
  );
  expect(result.bodyFailures).toEqual([
    { id: 'WX_1234567890_1_1', code: 'BODY_PARSE_FAILED' },
  ]);
  expect(result.articles[0].contentHtml).toBeNull();
  expect(result.articles[1].contentHtml).toContain('later body');
});

it('records oversized and missing bodies and continues to later articles', () => {
  const item = (mid: number, html: string) => ({
    url: `https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA%3D%3D&mid=${mid}&idx=1&sn=abcdef`,
    title: `synthetic-${mid}`,
    date_published: '2024-01-01T00:00:00Z',
    content_html: html,
  });
  const result = parseWechat2RssJsonFeed(
    {
      items: [
        item(1, 'x'.repeat(2_000_001)),
        item(2, ''),
        item(3, '<p>later</p>'),
      ],
    },
    'MP_WXS_1234567890',
  );
  expect(result.bodyFailures).toEqual([
    { id: 'WX_1234567890_1_1', code: 'BODY_TOO_LARGE' },
    { id: 'WX_1234567890_2_1', code: 'BODY_MISSING' },
  ]);
  expect(result.articles[2].contentHtml).toContain('later');
});
