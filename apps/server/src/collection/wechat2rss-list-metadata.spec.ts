import { parseWechat2RssListMetadata } from './wechat2rss-list-metadata';
describe('strict Wechat2RSS schedule metadata', () => {
  it('retains independent timestamps and boolean paused', () => {
    expect(
      parseWechat2RssListMetadata({
        check_time: '2026-10-11T16:01:02+08:00',
        next_update_time: '2026-10-12T00:00:00Z',
        paused: true,
      }),
    ).toEqual({
      checkTime: '2026-10-11T08:01:02.000Z',
      nextUpdateTime: '2026-10-12T00:00:00.000Z',
      paused: true,
    });
  });
  it('unknown/Go zero values are unknown, never false or complete', () => {
    expect(
      parseWechat2RssListMetadata({ check_time: '0001-01-01T00:00:00Z' }),
    ).toEqual({
      checkTime: null,
      nextUpdateTime: null,
      paused: null,
    });
  });
  it.each([
    { paused: 'false' },
    { paused: 0 },
    { check_time: 1791710000 },
    { check_time: '2026-02-30T00:00:00Z' },
    { next_update_time: '2026-10-11 16:00:00' },
    { check_time: '2026-10-11T24:00:00Z' },
    { check_time: '2026-10-11T12:00:00+99:00' },
  ])('rejects coerced or impossible values %p', (row) => {
    expect(() => parseWechat2RssListMetadata(row)).toThrow(
      'WECHAT2RSS_LIST_METADATA_INVALID',
    );
  });
});
