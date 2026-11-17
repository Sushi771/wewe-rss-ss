// Test-only inverse for explicit reviewed deltas. Historical pins stay unchanged.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const entries = require('./fixtures/held-channel-deployment-compat.json');
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
assert.equal(
  sha(JSON.stringify(entries)),
  'bae7d12a1bbe1d8a3ee38356b988749387de177e70fbd9c4a344a3daac1973fd',
  'fixed reviewed held/channel difference inventory',
);
module.exports = function restoreHeldChannel(file, source) {
  const entry = entries[file];
  if (!entry || sha(source) === entry.beforeSha256) return source;
  assert.equal(
    sha(source),
    entry.afterSha256,
    'exact reviewed held/channel delta: ' + file,
  );
  for (const hunk of entry.hunks) {
    assert.equal(
      source.split(hunk.after).length,
      2,
      'one reviewed held/channel hunk: ' + file,
    );
    source = source.replace(hunk.after, hunk.before);
  }
  assert.equal(
    sha(source),
    entry.beforeSha256,
    'unchanged historical held/channel preimage: ' + file,
  );
  const bytes = Buffer.from(source);
  assert.equal(
    crypto
      .createHash('sha1')
      .update('blob ' + bytes.length + '\0')
      .update(bytes)
      .digest('hex'),
    entry.originalGitBlob,
    'independently pinned original Git blob: ' + file,
  );
  return source;
};
