// Test-only inverse to retain the exact pre-existing deployment baselines.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const entries = require('./fixtures/managed-wechat-local-cache-compat.json');
const activeEntries = require('./fixtures/managed-wechat-active-compat.json');
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
assert.equal(
  sha(JSON.stringify(activeEntries)),
  '3fba13d7ee213742e67b15ad659f2155c8b1fb58837c657139279997ca85cee1',
);
assert.equal(
  sha(JSON.stringify(entries)),
  '132bf5f959fa889f297fcd8fadde09073364b4e25cd99ecda1ded01965088136',
);

function restore(entries, file, source, label) {
  const entry = entries[file];
  if (!entry || sha(source) === entry.beforeSha256) return source;
  assert.equal(
    sha(source),
    entry.afterSha256,
    'exact reviewed ' + label + ' delta: ' + file,
  );
  for (const { before, after } of entry.hunks) {
    assert.equal(
      source.split(after).length,
      2,
      'one reviewed ' + label + ' hunk: ' + file,
    );
    source = source.replace(after, before);
  }
  assert.equal(
    sha(source),
    entry.beforeSha256,
    'original ' + label + ' preimage: ' + file,
  );
  return source;
}

const restoreActive = (file, source) =>
  restore(activeEntries, file, source, 'active-refresh');
const restoreLocalCache = (file, source) =>
  restore(entries, file, source, 'local-cache');
module.exports = (file, source) =>
  restoreLocalCache(file, restoreActive(file, source));
module.exports.restoreActive = restoreActive;
module.exports.restoreLocalCache = restoreLocalCache;
