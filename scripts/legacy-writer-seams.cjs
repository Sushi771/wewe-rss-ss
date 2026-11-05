const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const seams = require('./fixtures/legacy-writer-seams.json');
const installed = require('./fixtures/installed-writer-compat.json');
const sha = (source) =>
  crypto.createHash('sha256').update(source).digest('hex');
function restoreCompatible(file, source) {
  const reviewed = installed[file];
  if (!reviewed) return source;
  if (sha(source) === reviewed.beforeSha256) return source;
  assert.equal(
    sha(source),
    reviewed.afterSha256,
    'exact candidate legacy writer seam: reviewed installed compatibility source',
  );
  for (const hunk of reviewed.hunks) {
    assert.equal(
      source.split(hunk.after).length,
      2,
      'exact candidate legacy writer seam: installed compatibility hunk',
    );
    source = source.replace(hunk.after, hunk.before);
  }
  assert.equal(
    sha(source),
    reviewed.beforeSha256,
    'exact candidate legacy writer seam: restored precursor',
  );
  return source;
}
function restoreCollectionIntegration(file, source) {
  const reviewed = require('./fixtures/collection-integration-compat.json')[
    file
  ];
  if (!reviewed) return source;
  assert.equal(
    sha(source),
    reviewed.afterSha256,
    'exact reviewed collection integration source: ' + file,
  );
  for (const hunk of reviewed.hunks) {
    assert.equal(
      source.split(hunk.after).length,
      2,
      'exact reviewed collection integration hunk: ' + file,
    );
    source = source.replace(hunk.after, hunk.before);
  }
  assert.equal(
    sha(source),
    reviewed.originalSha256,
    'unchanged historical collection source pin: ' + file,
  );
  return source;
}
module.exports = function restoreLegacyWriter(file, source) {
  source = restoreCollectionIntegration(file, source);
  source = restoreCompatible(file, source);
  for (const seam of seams[file] || []) {
    assert.equal(
      source.split(seam.after).length,
      2,
      'exact candidate legacy writer seam',
    );
    source = source.replace(seam.after, seam.before);
  }
  const transaction = require('./fixtures/prisma-transaction-compat.json');
  if (file === transaction.file) {
    assert.equal(
      sha(source),
      transaction.afterSha256,
      'exact transaction-aware admission version',
    );
    assert.equal(
      source.split(transaction.after).length,
      2,
      'exact transaction-aware admission seam',
    );
    source = source.replace(transaction.after, transaction.before);
    assert.equal(
      sha(source),
      transaction.originalSha256,
      'unchanged original recovery pin',
    );
  }
  return source;
};
module.exports.restoreCompatible = restoreCompatible;
