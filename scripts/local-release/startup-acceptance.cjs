const fs = require('./lib.cjs').hostEffects.fs;
const path = require('node:path');
const crypto = require('node:crypto');
const { hash, fileHash } = require('./lib.cjs');
const root = path.resolve(__dirname, '../..');
function context(release, { receiptRoot } = {}) {
  release = fs.realpathSync(release);
  const key = hash(
    release +
      fileHash(path.join(release, 'release.json')) +
      fileHash(__filename) +
      fileHash(path.join(__dirname, 'restart.cjs')) +
      fileHash(path.join(__dirname, 'switch.cjs')),
  );
  const file = path.join(
    receiptRoot || root,
    receiptRoot ? '.startup-acceptance' : '.local-releases/.startup-acceptance',
    hash(release) + '.json',
  );
  return { key, file };
}
function accepted(release, options) {
  const { key, file } = context(release, options);
  try {
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (
      receipt.format === 1 &&
      receipt.key === key &&
      receipt.rssItems === 20 &&
      receipt.privateMode === (process.env.PRIVATE_ONLINE_MODE === '1')
    );
  } catch {
    return false;
  }
}
function recordAcceptance(release, options = {}) {
  const scope = require('./release-scope.cjs');
  scope.assertWritableSession(['restart', 'switch']);
  if (scope.session() && !options.receiptRoot)
    throw new Error('RELEASE_SCOPE_ACCEPTANCE_AUDIT_REQUIRED');
  if (options.receiptRoot)
    scope.requireSession().assertOwnedDirectory(options.receiptRoot);
  const { key, file } = context(release, options);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (options.receiptRoot)
    scope.requireSession().assertOwnedDirectory(path.dirname(file));
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(
      temporary,
      JSON.stringify({
        format: 1,
        key,
        rssItems: 20,
        privateMode: process.env.PRIVATE_ONLINE_MODE === '1',
      }),
      { flag: 'wx' },
    );
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
module.exports = { accepted, recordAcceptance };
