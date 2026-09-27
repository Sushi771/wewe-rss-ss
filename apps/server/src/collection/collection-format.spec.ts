import {
  canonicalArticleUrl,
  parseCsv,
  parsePublishTime,
  readMetrics,
  mergeMetrics,
  csvCell,
} from './collection-format';

describe('WeChatDownload formats', () => {
  it('reads BOM, quoted multiline titles, commas, and escaped quotes', () => {
    expect(
      parseCsv('\uFEFFtitle,url\r\n"A, ""B""\nC",https://example.com\r\n'),
    ).toEqual([{ title: 'A, "B"\nC', url: 'https://example.com' }]);
    expect(() => parseCsv('title,url\n"unfinished,x')).toThrow();
    expect(() => parseCsv('title,url\na,b,c')).toThrow();
  });
  it('decodes HTML entities and distinguishes secondary articles while stripping credentials', () => {
    const url =
      'http://mp.weixin.qq.com/s?__biz=MzI4NjAxNjY4Nw==&amp;mid=2650239213&amp;idx=2&amp;sn=abc&amp;key=secret#rd';
    const parsed = canonicalArticleUrl(url);
    expect(parsed.id).toBe('WX_3286016687_2650239213_2');
    expect(parsed.mpId).toBe('MP_WXS_3286016687');
    expect(parsed.url).not.toContain('secret');
    expect(parsed.url).not.toContain('amp;');
    expect(() =>
      canonicalArticleUrl('https://evil.example/s?__biz=x'),
    ).toThrow();
  });
  it('interprets Chinese wall-clock dates in Asia/Shanghai regardless of server timezone', () => {
    expect(parsePublishTime('2024-12-06 08:35:06')).toBe(
      Date.parse('2024-12-06T00:35:06Z') / 1000,
    );
    expect(() => parsePublishTime('2024-02-30 08:35:06')).toThrow();
  });
  it('keeps zero, missing, lower bounds, and metric meanings separate', () => {
    const m = readMetrics(
      {
        read_num: '10万+',
        like_num: '0',
        share_num: '12',
        comment_count: '{}',
      },
      '2026-01-01',
    );
    expect(m.read).toMatchObject({ value: 100000, display: '10万+' });
    expect(m.like?.value).toBe(0);
    expect(m.comment).toBeUndefined();
    expect(m.favorite).toBeUndefined();
    expect(m.wow).toBeUndefined();
    expect(
      mergeMetrics(m, readMetrics({ read_num: '5' }, '2025-01-01')).read?.value,
    ).toBe(100000);
    expect(mergeMetrics(m, {}).like?.value).toBe(0);
  });
  it('protects spreadsheet formulas while keeping quoted Unicode titles', () => {
    expect(csvCell('=HYPERLINK("bad")')).toBe('"\'=HYPERLINK(""bad"")"');
    expect(csvCell('公众号')).toBe('"公众号"');
  });
});
