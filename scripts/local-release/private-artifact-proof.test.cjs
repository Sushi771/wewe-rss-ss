const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifyManifest } = require('./private-artifact-proof.cjs');
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
function fixture(run) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(__dirname, 'manifest-')));
  const file = path.join(root, 'runtime.cjs'), manifestPath = path.join(root, 'release.json');
  fs.writeFileSync(file, 'ordinary fixture');
  const manifest = { format: 1, id: 'synthetic', files: { 'runtime.cjs': sha('ordinary fixture') }, links: {} };
  const save = () => { const raw = JSON.stringify(manifest); fs.writeFileSync(manifestPath, raw); return sha(raw); };
  try { run({ root, file, manifest, save }); }
  finally { fs.unlinkSync(file); fs.unlinkSync(manifestPath); fs.rmdirSync(root); }
}
test('verified ordinary manifest checks its byte hash', () => fixture((f) => {
  assert.equal(verifyManifest(f.root, f.save()), 'synthetic');
  fs.writeFileSync(f.file, 'changed');
  assert.throws(() => verifyManifest(f.root, f.save()), /HASH_MISMATCH/);
}));
test('private paths and traversal fail before file lookup', () => fixture((f) => {
  f.manifest.files = { '.env': 'a'.repeat(64) };
  assert.throws(() => verifyManifest(f.root, f.save()), /PRIVATE_CONFLICT/);
  f.manifest.files = { '../escape': 'a'.repeat(64) };
  assert.throws(() => verifyManifest(f.root, f.save()), /PATH_INVALID/);
}));
test('unreviewed formats and escaping link entries fail closed', () => fixture((f) => {
  f.manifest.format = 2;
  assert.throws(() => verifyManifest(f.root, f.save()), /FORMAT_UNSUPPORTED/);
  f.manifest.format = 1; f.manifest.links = { link: '../runtime.cjs' };
  assert.throws(() => verifyManifest(f.root, f.save()), /PATH_INVALID/);
}));
