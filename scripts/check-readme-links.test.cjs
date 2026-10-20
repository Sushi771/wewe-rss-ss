const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkTarget, check } = require('./check-readme-links.cjs');
test('README links resolve including historical fixed Git trees', () => {
  assert(check(['README.md']) > 10);
  checkTarget(
    'https://github.com/Sushi771/wewe-rss-ss/blob/33ec7c3ebc20ce55d5f81259a5dd515912b5ca65/apps/server/src/article-local-save.ts',
    'README.md',
  );
  assert.throws(() => checkTarget('docs/no-such-file.md', 'README.md'));
  assert.throws(() =>
    checkTarget('docs/offline_article_layout.md', 'README.md'),
  );
  assert.throws(() =>
    checkTarget(
      'https://github.com/Sushi771/wewe-rss-ss/blob/33ec7c3ebc20ce55d5f81259a5dd515912b5ca65/docs/INCREMENTAL_ARTICLE_EXPORT.md',
      'README.md',
    ),
  );
});
