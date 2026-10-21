// Expected artifacts originate in producer memory, never from observing output.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const digest = (bytes) =>
  crypto.createHash('sha256').update(bytes).digest('hex');
const inside = (root, at) =>
  at === root ||
  (!path.relative(root, at).startsWith('..') &&
    !path.isAbsolute(path.relative(root, at)));

function createArtifacts(root, charge = () => {}) {
  root = path.resolve(root);
  const expected = new Map([[root, { kind: 'directory' }]]);
  function apply(events) {
    for (const event of events) {
      const at = path.resolve(event.path);
      if (at.length > 32768 || expected.size > 100000)
        throw Error('RELEASE_ARTIFACT_ENTRY_BUDGET');
      if (!inside(root, at)) throw Error('RELEASE_ARTIFACT_OUTSIDE_OUTPUT');
      if (event.kind === 'remove') {
        for (const key of expected.keys())
          if (inside(at, key)) expected.delete(key);
      } else {
        if (
          !['file', 'directory', 'link'].includes(event.kind) ||
          (event.kind === 'file' &&
            (!/^[a-f0-9]{64}$/.test(event.sha256 || '') ||
              !Number.isSafeInteger(event.size) ||
              event.size < 0 ||
              event.size > 768 * 1024 ** 2)) ||
          (event.kind === 'link' &&
            (!path.isAbsolute(event.target || '') ||
              !inside(root, event.target)))
        )
          throw Error('RELEASE_ARTIFACT_INTENT_INVALID');
        expected.set(at, { ...event, path: undefined });
      }
    }
  }
  function verify(at = root) {
    const seen = new Set();
    function visit(file, depth = 0) {
      if (depth > 128 || seen.size >= 100000)
        throw Error('RELEASE_ARTIFACT_ENTRY_BUDGET');
      charge({ entries: 1 });
      const wanted = expected.get(file),
        stat = fs.lstatSync(file);
      if (!wanted) throw Error('RELEASE_ARTIFACT_UNREQUESTED: ' + file);
      seen.add(file);
      if (stat.isSymbolicLink()) {
        if (
          wanted.kind !== 'link' ||
          path.resolve(fs.realpathSync.native(file)) !== wanted.target
        )
          throw Error('RELEASE_ARTIFACT_CHANGED: ' + file);
      } else if (stat.isDirectory()) {
        if (wanted.kind !== 'directory')
          throw Error('RELEASE_ARTIFACT_CHANGED: ' + file);
        const directory = fs.opendirSync(file);
        try {
          let entry;
          while ((entry = directory.readSync()))
            visit(path.join(file, entry.name), depth + 1);
        } finally {
          directory.closeSync();
        }
      } else if (
        !stat.isFile() ||
        wanted.kind !== 'file' ||
        stat.size !== wanted.size ||
        fileDigest(file, (bytes) => charge({ bytes })) !== wanted.sha256
      ) {
        throw Error('RELEASE_ARTIFACT_CHANGED: ' + file);
      }
    }
    if (fs.existsSync(at)) visit(at);
    for (const file of expected.keys())
      if (inside(at, file) && !seen.has(file))
        throw Error('RELEASE_ARTIFACT_MISSING: ' + file);
  }
  function fingerprint() {
    verify();
    const files = {},
      links = {};
    for (const [at, event] of expected) {
      const relative = path.relative(root, at).replace(/\\/g, '/');
      if (!relative || relative === 'release.json') continue;
      if (event.kind === 'file') files[relative] = event.sha256;
      if (event.kind === 'link')
        links[relative] = path.relative(root, event.target).replace(/\\/g, '/');
    }
    return { files, links };
  }
  return { apply, verify, fingerprint, expected };
}
function fileDigest(at, onBytes = () => {}) {
  if (fs.statSync(at).size > 768 * 1024 ** 2)
    throw Error('RELEASE_ARTIFACT_BYTE_BUDGET');
  const hash = crypto.createHash('sha256'),
    buffer = Buffer.alloc(65536),
    fd = fs.openSync(at, 'r');
  try {
    let n;
    while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) {
      onBytes(n);
      hash.update(buffer.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}
// Capture requested bytes/source copies BEFORE executing the operation. Output
// reads are verification only; they never supply the expected file hash.
function mutationEvents(method, args, known = new Map()) {
  const at = (v) =>
    path.resolve(
      typeof v === 'string' ? v : require('node:url').fileURLToPath(v),
    );
  const directory = (p) => ({ path: p, kind: 'directory' });
  if (method === 'mkdir') {
    const target = at(args[0]),
      rows = [directory(target)];
    if (args[1]?.recursive) {
      let parent = path.dirname(target);
      while (!fs.existsSync(parent)) {
        rows.unshift(directory(parent));
        parent = path.dirname(parent);
      }
    }
    return rows;
  }
  if (method === 'writeFile') {
    const options = args[2];
    if (options?.flag && !['w', 'wx'].includes(options.flag))
      throw Error('RELEASE_ARTIFACT_APPEND_UNSUPPORTED');
    const bytes =
      typeof args[1] === 'string'
        ? Buffer.from(
            args[1],
            typeof options === 'string' ? options : options?.encoding || 'utf8',
          )
        : args[1];
    if (!ArrayBuffer.isView(bytes))
      throw Error('RELEASE_ARTIFACT_BYTES_REQUIRED');
    return [
      {
        path: at(args[0]),
        kind: 'file',
        sha256: digest(bytes),
        size: bytes.byteLength,
      },
    ];
  }
  if (method === 'copyFile')
    return [
      {
        path: at(args[1]),
        kind: 'file',
        sha256: fileDigest(at(args[0])),
        size: fs.statSync(at(args[0])).size,
      },
    ];
  if (method === 'rename') {
    const source = at(args[0]),
      destination = at(args[1]),
      rows = [];
    if (!known.has(source))
      throw Error('RELEASE_ARTIFACT_RENAME_SOURCE_UNKNOWN');
    for (const [file, event] of known)
      if (inside(source, file))
        rows.push({
          ...event,
          path: path.join(destination, path.relative(source, file)),
        });
    return [{ path: source, kind: 'remove' }, ...rows];
  }
  if (method === 'symlink')
    return [
      {
        path: at(args[1]),
        kind: 'link',
        target: path.resolve(path.dirname(at(args[1])), args[0]),
      },
    ];
  if (['unlink', 'rm', 'rmdir'].includes(method))
    return [{ path: at(args[0]), kind: 'remove' }];
  if (method === 'cp') {
    const rows = [],
      options = args[2] || {};
    function copy(source, destination) {
      if (options.filter && !options.filter(source, destination)) return;
      if (rows.length > 100000) throw Error('RELEASE_ARTIFACT_ENTRY_BUDGET');
      const stat = fs.lstatSync(source);
      if (stat.isSymbolicLink())
        throw Error('RELEASE_ARTIFACT_COPY_LINK_UNSUPPORTED');
      if (stat.isDirectory()) {
        rows.push(directory(destination));
        for (const name of fs.readdirSync(source))
          copy(path.join(source, name), path.join(destination, name));
      } else if (stat.isFile())
        rows.push({
          path: destination,
          kind: 'file',
          sha256: fileDigest(source),
          size: stat.size,
        });
      else throw Error('RELEASE_ARTIFACT_COPY_TYPE_UNSUPPORTED');
    }
    copy(at(args[0]), at(args[1]));
    return rows;
  }
  if (
    ['chmod', 'utimes', 'lutimes', 'fsync', 'fdatasync', 'close'].includes(
      method,
    )
  )
    return [];
  throw Error('RELEASE_ARTIFACT_WRITE_UNSUPPORTED: ' + method);
}
module.exports = { createArtifacts, digest, fileDigest, mutationEvents };
