import { sourceOriginalLink } from './xhs-source-original-link';

describe('official PC share link parameters', () => {
  const base = 'https://www.xiaohongshu.com';
  const note = 'synthetic-note';
  const valid = `${base}/discovery/item/${note}?source=webshare&xhsshare=pc_web&xsec_token=synthetic-token&xsec_source=pc_share`;
  const check = (value: string) => sourceOriginalLink(value, new URL(value), note);

  it('preserves the official PC share context and the separate address-bar source', () => {
    expect(check(valid)).toBe(valid);
    const address = `${base}/explore/${note}?xsec_token=synthetic-token&xsec_source=pc_search`;
    expect(check(address)).toBe(address);
  });
  it('continues rejecting ambiguous, unverified or injected parameters', () => {
    for (const url of [
      valid + '&xhsshare=pc_web',
      valid.replace('xhsshare=pc_web', 'xhsshare=other'),
      valid + '&redirect=https://evil.invalid',
      valid.replace('xsec_source=pc_share', ''),
      valid.replace('xsec_token=synthetic-token', ''),
      valid.replace(note, 'different-note'),
    ]) expect(check(url)).toBeUndefined();
  });
});
