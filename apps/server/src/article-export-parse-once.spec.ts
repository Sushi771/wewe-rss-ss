import { load } from 'cheerio';
import { buildArticleMarkdown } from './article-export';

jest.mock('cheerio', () => {
  const original = jest.requireActual('cheerio');
  return { ...original, load: jest.fn(original.load) };
});

describe('reuse the current export DOM without retaining it', () => {
  beforeEach(() => jest.mocked(load).mockClear());
  it.each([
    ['available', '<p>Author body</p>', true],
    ['images-pending', '<p>Author body</p>', false],
    ['available', '<p>Author body</p><img src="file:///private.png">', false],
    ['available', '<p data-wewe-image-pending>Author body</p>', false],
  ])(
    'parses once and preserves media uncertainty (%s, %s)',
    async (status, body, complete) => {
      const result = await buildArticleMarkdown(
        {
          id: 'synthetic',
          title: 'Title',
          sourceUrl: null,
          metrics: null,
          publishTime: 1791210060,
          lastBodyStatus: status,
          contentHtml: `<div id="js_content">${body}</div>`,
        },
        '',
      );
      expect(load).toHaveBeenCalledTimes(1);
      expect(result.markdown).toContain('Author body');
      expect(result.mediaComplete).toBe(complete);
      expect(result.markdown).not.toContain('file:');
    },
  );
});
