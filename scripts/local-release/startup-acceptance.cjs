const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { hash, fileHash } = require('./lib.cjs');
const root = path.resolve(__dirname, '../..');
function context(release) {
  release = fs.realpathSync(release);
  const key = hash(
    release +
      fileHash(path.join(release, 'release.json')) +
      fileHash(__filename) +
      fileHash(path.join(__dirname, 'restart.cjs')) +
      fileHash(path.join(__dirname, 'switch.cjs')),
  );
  const file = path.join(
    root,
    '.local-releases/.startup-acceptance',
    hash(release) + '.json',
  );
  return { key, file };
}
function accepted(release) {
  const { key, file } = context(release);
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
function recordAcceptance(release) {
  const { key, file } = context(release);
  fs.mkdirSync(path.dirname(file), { recursive: true });
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
