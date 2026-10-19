import {
  cachedArticleMediaAnalysis,
  cachedArticleMediaAnalysisStats,
} from './cached-article-media-analysis';
import { cachedMediaUnconfirmed } from './article-export';
import { prepareCachedArticleLocalExport } from './cached-article-local-export';

describe('bounded content-derived media analysis reuse', () => {
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=';
  it.each([
    '',
    '<div id="js_content"><p>text</p></div>',
    '<div id="js_content"><img></div>',
    '<div id="js_content"><img src="data:image/png;base64,broken"></div>',
    '<div id="js_content"><img src="https://mmbiz.qpic.cn/synthetic.png"></div>',
    `<div id="js_content"><img src="data:image/png;base64,${png}" data-src="https://invalid.example/ignored"></div>`,
    '<div id="js_content"><p data-wewe-image-pending="1">pending</p></div>',
  ])('preserves the existing uncertainty predicate for %s', (contentHtml) => {
    for (const lastBodyStatus of [null, 'available', 'images-pending']) {
      const article = { contentHtml, lastBodyStatus };
      expect(cachedArticleMediaAnalysis(article).unconfirmed).toBe(
        cachedMediaUnconfirmed(article),
      );
    }
  });
  it('reuses pure facts only for identical content and status, and detects newly added media', () => {
    const article = {
      contentHtml: '<div id="js_content">unique-cache-test</div>',
      lastBodyStatus: 'available',
    };
    const first = cachedArticleMediaAnalysis(article);
    expect(cachedArticleMediaAnalysis({ ...article })).toBe(first);
    const changed = cachedArticleMediaAnalysis({
      ...article,
      contentHtml: article.contentHtml.replace(
        '</div>',
        '<img src="https://mmbiz.qpic.cn/new.png"></div>',
      ),
    });
    expect(changed).not.toBe(first);
    expect(changed.sourcePrefixes).toHaveLength(1);
    expect(
      cachedArticleMediaAnalysis({
        ...article,
        lastBodyStatus: 'images-pending',
      }).unconfirmed,
    ).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(changed.sourcePrefixes)).toBe(true);
  });
  it('does not keep oversized bodies and remains within entry and logical-byte budgets', () => {
    const large = {
      contentHtml: '<div id="js_content">' + 'x'.repeat(8000001) + '</div>',
      lastBodyStatus: null,
    };
    expect(cachedArticleMediaAnalysis(large)).not.toBe(
      cachedArticleMediaAnalysis(large),
    );
    for (let i = 0; i < 550; i++)
      cachedArticleMediaAnalysis({
        contentHtml: `<div id="js_content">bounded-${i}</div>`,
        lastBodyStatus: null,
      });
    const stats = cachedArticleMediaAnalysisStats();
    expect(stats.entries).toBeLessThanOrEqual(stats.maxEntries);
    expect(stats.bytes).toBeLessThanOrEqual(stats.maxBytes);
  });
  it('does not cache a media-source set exceeding the byte budget', () => {
    const contentHtml =
      '<div id="js_content">' +
      Array.from(
        { length: 7000 },
        (_, n) => `<img src="https://mmbiz.qpic.cn/budget-${n}.png">`,
      ).join('') +
      '</div>';
    const article = { contentHtml, lastBodyStatus: null };
    const first = cachedArticleMediaAnalysis(article);
    expect(first.sourcePrefixes).toHaveLength(7000);
    expect(cachedArticleMediaAnalysis(article)).not.toBe(first);
    expect(cachedArticleMediaAnalysisStats().bytes).toBeLessThanOrEqual(
      cachedArticleMediaAnalysisStats().maxBytes,
    );
  });
  it('constructs a preparation without running any media analysis', () => {
    const before = cachedArticleMediaAnalysisStats().entries;
    const prepare = prepareCachedArticleLocalExport({
      id: 'lazy',
      title: 'lazy',
      sourceUrl: null,
      publishTime: 1,
      metrics: null,
      lastBodyStatus: 'available',
      contentHtml: '<div id="js_content">lazy-never-analyzed<img></div>',
    });
    expect(cachedArticleMediaAnalysisStats().entries).toBe(before);
    expect(prepare.identity!.mediaComplete).toBe(false);
    expect(prepare.identity!.mediaStatus).toBe('unconfirmed');
  });
});
