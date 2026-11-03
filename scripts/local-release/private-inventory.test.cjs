const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createVerifier } = require('./scope-inventory.cjs');

test('private fixture is accounted without opening its contents', () => {
  const root = fs.mkdtempSync(path.join(__dirname, 'fixture-'));
  const secret = path.join(root, '.env');
  fs.writeFileSync(secret, 'synthetic');
  const canonical = fs.realpathSync.native(root);
  const s = fs.lstatSync(canonical, { bigint: true });
  const io = Object.create(fs);
  io.openSync = (file, ...args) => {
    if (file === secret) throw new Error('SYNTHETIC_PRIVATE_OPEN');
    return fs.openSync(file, ...args);
  };
  try {
    const receipt = createVerifier(undefined, { io, privateAccounting: 'private-names-v1' }).scan([
      { path: canonical, identity: [s.dev, s.ino, s.birthtimeNs].map(String) },
    ]);
    assert.equal(receipt.bytes, 9);
    assert.equal(receipt.format, 'stream-dfs-private-v3');
    assert.equal(receipt.privateContentVerified, false);
    assert.equal(receipt.privateBytes, 9);
  } finally {
    fs.unlinkSync(secret);
    fs.rmdirSync(root);
  }
});

test('a replaced ordinary file is refused before reading opened bytes', () => {
  const root = fs.mkdtempSync(path.join(__dirname, 'fixture-'));
  const file = path.join(root, 'ordinary');
  fs.writeFileSync(file, 'fixture');
  const canonical = fs.realpathSync.native(root);
  const s = fs.lstatSync(canonical, { bigint: true });
  const io = Object.create(fs);
  let reads = 0;
  io.fstatSync = (fd, options) => {
    const opened = fs.fstatSync(fd, options);
    return new Proxy(opened, { get(target, key) { return key === 'ino' ? target.ino + 1n : Reflect.get(target, key, target); } });
  };
  io.readSync = (...args) => { reads++; return fs.readSync(...args); };
  try {
    assert.throws(() => createVerifier(undefined, { io, privateAccounting: 'private-names-v1' }).scan([
      { path: canonical, identity: [s.dev, s.ino, s.birthtimeNs].map(String) },
    ]), /RELEASE_SCOPE_OPENED_FILE_CHANGED/);
    assert.equal(reads, 0);
  } finally { fs.unlinkSync(file); fs.rmdirSync(root); }
});


test('git and database fixtures retain byte accounting without opening payloads', () => {
  const root = fs.mkdtempSync(path.join(__dirname, 'fixture-'));
  const git = path.join(root, '.git');
  fs.mkdirSync(git);
  const a = path.join(git, 'objects');
  const b = path.join(root, 'cache.sqlite');
  const ordinary = path.join(root, 'ordinary');
  fs.writeFileSync(a, 'abc'); fs.writeFileSync(b, 'de'); fs.writeFileSync(ordinary, 'safe');
  const canonical = fs.realpathSync.native(root), s = fs.lstatSync(canonical, { bigint: true });
  const io = Object.create(fs), opened = [];
  io.openSync = (file, ...args) => { opened.push(file); return fs.openSync(file, ...args); };
  const roots = [{ path: canonical, identity: [s.dev, s.ino, s.birthtimeNs].map(String) }];
  try {
    const first = createVerifier(undefined, { io, privateAccounting: 'private-names-v1' }).scan(roots);
    assert.equal(first.bytes, 9); assert.equal(first.privateBytes, 5); assert.equal(first.privateEntries, 2);
    assert.deepEqual(opened, [ordinary]);
    fs.writeFileSync(ordinary, 'SAFE');
    const second = createVerifier(undefined, { privateAccounting: 'private-names-v1' }).scan(roots);
    assert.notEqual(first.digest, second.digest);
  } finally { fs.unlinkSync(a); fs.unlinkSync(b); fs.unlinkSync(ordinary); fs.rmdirSync(git); fs.rmdirSync(root); }
});

