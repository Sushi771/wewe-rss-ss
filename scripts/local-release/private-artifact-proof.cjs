// Prototype: reject private manifest members before opening any member bytes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isPrivatePath } = require('./scope-inventory.cjs');
const same = (a, b) => ['dev', 'ino', 'birthtimeNs', 'size', 'mtimeNs', 'ctimeNs', 'nlink'].every((k) => a[k] === b[k]);
function readPinned(file, max, expected, capture = false, charge = () => {}) {
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(max))
    throw new Error('RELEASE_SCOPE_ARTIFACT_INVALID');
  const fd = fs.openSync(file, 'r');
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !same(before, opened)) throw new Error('RELEASE_SCOPE_ARTIFACT_CHANGED');
    const h = crypto.createHash('sha256'), buffer = Buffer.alloc(65536), chunks = [];
    let count = 0, n;
    while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) {
      count += n;
      if (count > max) throw new Error('RELEASE_SCOPE_ARTIFACT_INVALID');
      charge(n);
      h.update(buffer.subarray(0, n));
      if (capture) chunks.push(Buffer.from(buffer.subarray(0, n)));
    }
    if (!same(before, fs.fstatSync(fd, { bigint: true })) || !same(before, fs.lstatSync(file, { bigint: true })))
      throw new Error('RELEASE_SCOPE_ARTIFACT_CHANGED');
    if (h.digest('hex') !== expected)
      throw new Error('RELEASE_SCOPE_ARTIFACT_HASH_MISMATCH');
    return capture ? Buffer.concat(chunks) : undefined;
  } finally { fs.closeSync(fd); }
}
function verifyManifest(folder, manifestSha, charge = () => {}) {
  if (!/^[a-f0-9]{64}$/.test(manifestSha || '')) throw new Error('RELEASE_SCOPE_MANIFEST_PROOF_REQUIRED');
  const root = fs.realpathSync.native(folder);
  if (root !== folder || isPrivatePath(root)) throw new Error('RELEASE_SCOPE_ARTIFACT_PRIVATE_CONFLICT');
  const manifest = JSON.parse(readPinned(path.join(root, 'release.json'), 8 * 1024 * 1024, manifestSha, true, charge));
  if (manifest.format !== 1 || !manifest.files || Array.isArray(manifest.files) || typeof manifest.files !== 'object' ||
      !manifest.links || Array.isArray(manifest.links) || typeof manifest.links !== 'object')
    throw new Error('RELEASE_SCOPE_MANIFEST_FORMAT_UNSUPPORTED');
  const entries = Object.entries(manifest.files);
  if (!entries.length || entries.length > 100000) throw new Error('RELEASE_SCOPE_MANIFEST_FORMAT_UNSUPPORTED');
  const seen = new Set();
  for (const [relative, digest] of entries) {
    if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.startsWith('/') ||
        relative.split('/').some((p) => !p || p === '.' || p === '..' || p.includes(':') || /[. ]$/.test(p)) ||
        !/^[a-f0-9]{64}$/.test(digest || '') || seen.has(relative.toLowerCase()))
      throw new Error('RELEASE_SCOPE_ARTIFACT_PATH_INVALID');
    seen.add(relative.toLowerCase());
    if (isPrivatePath(relative)) throw new Error('RELEASE_SCOPE_ARTIFACT_PRIVATE_CONFLICT');
    let current = root;
    for (const part of relative.split('/')) {
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('RELEASE_SCOPE_ARTIFACT_LINK_UNSUPPORTED');
    }
    if (fs.realpathSync.native(current) !== current) throw new Error('RELEASE_SCOPE_ARTIFACT_CHANGED');
    readPinned(current, 1024 ** 3, digest, false, charge);
  }
  for (const [relative, expected] of Object.entries(manifest.links)) {
    if (typeof relative !== 'string' || typeof expected !== 'string' ||
        [relative, expected].some((s) => !s || s.includes('\\') || s.startsWith('/') ||
          s.split('/').some((p) => !p || p === '.' || p === '..' || p.includes(':') || /[. ]$/.test(p))) ||
        seen.has(relative.toLowerCase()) || isPrivatePath(relative) || isPrivatePath(expected))
      throw new Error('RELEASE_SCOPE_ARTIFACT_PATH_INVALID');
    seen.add(relative.toLowerCase());
    const parts = relative.split('/'); let current = root;
    for (let i = 0; i < parts.length - 1; i++) {
      current = path.join(current, parts[i]);
      if (!fs.lstatSync(current).isDirectory() || fs.lstatSync(current).isSymbolicLink())
        throw new Error('RELEASE_SCOPE_ARTIFACT_LINK_UNSUPPORTED');
    }
    const link = path.join(current, parts[parts.length - 1]);
    const before = fs.lstatSync(link, { bigint: true });
    if (!before.isSymbolicLink()) throw new Error('RELEASE_SCOPE_ARTIFACT_LINK_CHANGED');
    const target = fs.realpathSync.native(link);
    if (target !== path.join(root, ...expected.split('/')) || !same(before, fs.lstatSync(link, { bigint: true })))
      throw new Error('RELEASE_SCOPE_ARTIFACT_LINK_CHANGED');
  }
  return manifest.id;
}
function verifyControl(spec, charge = () => {}) {
  if (!spec || isPrivatePath(spec.path || '') || fs.realpathSync.native(spec.path) !== spec.path)
    throw new Error('RELEASE_SCOPE_ARTIFACT_PRIVATE_CONFLICT');
  const key = () => {
    const s = fs.lstatSync(spec.path, { bigint: true });
    return [s.dev, s.ino, s.birthtimeNs].map(String);
  };
  if (JSON.stringify(key()) !== JSON.stringify(spec.identity))
    throw new Error('RELEASE_SCOPE_ARTIFACT_CHANGED');
  readPinned(spec.path, 65536, spec.sha256, false, charge);
  if (JSON.stringify(key()) !== JSON.stringify(spec.identity))
    throw new Error('RELEASE_SCOPE_ARTIFACT_CHANGED');
}
module.exports = { verifyManifest, verifyControl };
