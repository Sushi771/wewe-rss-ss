import { parseBatchInput } from './xhs-batch-input';

it('extracts and deduplicates official links without exposing short-lived query values in fingerprints', () => {
  const items = parseBatchInput(
    [
      'Synthetic https://www.xiaohongshu.com/explore/note-a?xsec_token=first&xsec_source=pc_search',
      'Synthetic https://www.xiaohongshu.com/discovery/item/note-a?xsec_token=second&xsec_source=pc_share',
      'Synthetic https://xhslink.cn/o/example',
      'Synthetic https://evil.invalid/x',
    ].join('\n'),
  );
  expect(items).toHaveLength(4);
  expect(items[1].duplicateOf).toBe(0);
  expect(items[2].url).toBe('https://xhslink.cn/o/example');
  expect(items[3].code).toBe('XHS_URL_INVALID');
  for (const item of items)
    expect(item.fingerprint).not.toMatch(/first|second|token/);
});

it('bounds the number of items and rejects empty or excessive input', () => {
  expect(() => parseBatchInput('no link')).toThrow('XHS_BATCH_INPUT_INVALID');
  expect(() =>
    parseBatchInput(Array(101).fill('https://xhslink.cn/o/a').join(' ')),
  ).toThrow('XHS_BATCH_INPUT_INVALID');
  expect(() => parseBatchInput('x'.repeat(65537))).toThrow(
    'XHS_BATCH_INPUT_INVALID',
  );
  expect(
    parseBatchInput(
      'share https://www.xiaohongshu.com/explore/note?xsec_token=synthetic) end',
    )[0].code,
  ).toBe('XHS_URL_INVALID');
});

it('preserves punctuation in a standalone URL while rejecting ambiguous share prose', () => {
  const url =
    'https://www.xiaohongshu.com/explore/note?xsec_source=pc_share&xsec_token=synthetic)';
  expect(parseBatchInput(url)[0].url).toBe(url);
  expect(parseBatchInput(`Synthetic share ${url} open`)[0].code).toBe(
    'XHS_URL_INVALID',
  );
});
