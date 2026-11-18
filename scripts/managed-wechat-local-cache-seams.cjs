// Test-only inverse to retain the exact pre-existing deployment baselines.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const entries = require('./fixtures/managed-wechat-local-cache-compat.json');
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
assert.equal(
  sha(JSON.stringify(entries)),
  '132bf5f959fa889f297fcd8fadde09073364b4e25cd99ecda1ded01965088136',
);

module.exports = function restoreManagedWechatLocalCache(file, source) {
  const entry = entries[file];
  if (!entry || sha(source) === entry.beforeSha256) return source;
  assert.equal(
    sha(source),
    entry.afterSha256,
    'exact reviewed local-cache delta: ' + file,
  );
  for (const { before, after } of entry.hunks) {
    assert.equal(
      source.split(after).length,
      2,
      'one reviewed local-cache hunk: ' + file,
    );
    source = source.replace(after, before);
  }
  assert.equal(
    sha(source),
    entry.beforeSha256,
    'original local-cache preimage: ' + file,
  );
  return source;
};
