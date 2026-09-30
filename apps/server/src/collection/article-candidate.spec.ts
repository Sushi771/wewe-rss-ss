import { createHash } from 'node:crypto';
import {
  searchArticleCandidates,
  verifyCandidateOriginal,
} from './article-candidate';
const biz = 'MTIzNDU2Nzg5MA==';
const url = `https://mp.weixin.qq.com/s?__biz=${encodeURIComponent(biz)}&mid=100&idx=1&sn=abcd`;
const title = '自主发现文章';
const discovery = {
  source: 'owner-web-search' as const,
  capturedAt: '2026-09-30T10:05:00Z',
  page: 1,
};
const candidate = () =>
  searchArticleCandidates(
    [
      {
        doc_url: url,
        title,
        timestamp: 1700000500,
        source: { title: '测试号' },
      },
    ],
    { name: '测试号', biz },
    discovery,
  )[0];
const html = `<meta property="og:url" content="https://mp.weixin.qq.com/s/${'a'.repeat(22)}"><h1 id="activity-name">${title}</h1><div id="js_content"><p onclick="bad()">真实正文</p><img data-src="https://mmbiz.qpic.cn/a.png"></div><script>var biz="${biz}";var mid="100";var idx="1";var sn="abcd";var ct=1700000000;</script>`;
const evidence = (body = html) => ({
  source: 'official-public-original' as const,
  requestedUrl: url,
  capturedAt: '2026-09-30T08:00:00Z',
  sha256: createHash('sha256').update(body).digest('hex'),
  transport: 'verified-cache' as const,
});
describe('search candidate original verification (offline)', () => {
  it('never manufactures publishTime from an index timestamp; uses only verified original time', () => {
    const c = candidate();
    expect(c).not.toHaveProperty('publishTime');
    const verified = verifyCandidateOriginal(c, html, evidence());
    expect(verified.article.publishTime).toBe(1700000000);
    expect(verified.indexTimestamp).toBe(1700000500);
    expect(verified.original.transport).toBe('verified-cache');
    expect(verified.article.contentHtml).toContain('真实正文');
    expect(verified.article.contentHtml).not.toContain('onclick');
  });
  it.each(['biz="OTg3NjU0MzIxMA=="', 'mid="200"', 'sn="dcba"'])(
    'preserves identity/signature conflicts: %s',
    (field) => {
      // Replace the named field independently; no candidate alteration.
      const changed = html.replace(
        new RegExp(`var ${field.split('=')[0]}="[^"]+";`),
        `var ${field};`,
      );
      expect(() =>
        verifyCandidateOriginal(candidate(), changed, evidence(changed)),
      ).toThrow('identity_conflict');
    },
  );
  it('rejects changed cache bytes, title conflicts and challenge HTML', () => {
    expect(() =>
      verifyCandidateOriginal(candidate(), html + ' ', evidence()),
    ).toThrow('cache_hash_mismatch');
    const changed = html.replace(title, '另一篇');
    expect(() =>
      verifyCandidateOriginal(candidate(), changed, evidence(changed)),
    ).toThrow('identity_conflict');
    const challenge = '<title>请完成验证</title>' + html;
    expect(() =>
      verifyCandidateOriginal(candidate(), challenge, evidence(challenge)),
    ).toThrow('access_challenge');
  });
  it('cannot turn a missing original into a verified article', () => {
    const missing = html.replace('var ct=1700000000;', '');
    expect(() =>
      verifyCandidateOriginal(candidate(), missing, evidence(missing)),
    ).toThrow('invalid_original');
  });
  it('rejects duplicate search identities with conflicting signatures and filters other publishers', () => {
    const item = { doc_url: url, title, source: { title: '测试号' } };
    expect(() =>
      searchArticleCandidates(
        [item, { ...item, doc_url: url.replace('abcd', 'dcba') }],
        { name: '测试号', biz },
        discovery,
      ),
    ).toThrow('identity_conflict');
    expect(
      searchArticleCandidates(
        [{ ...item, source: { title: '别的号' } }],
        { name: '测试号', biz },
        discovery,
      ),
    ).toHaveLength(0);
  });
});
