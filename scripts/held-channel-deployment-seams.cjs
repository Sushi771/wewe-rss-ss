// Test-only inverse for explicit reviewed deltas. Historical pins stay unchanged.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const entries = require('./fixtures/held-channel-deployment-compat.json');
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
assert.equal(
  sha(JSON.stringify(entries)),
  '8cce5c1b672969e432f2783a4020b40d4c692ae6d354d9a752106cb317863692',
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
