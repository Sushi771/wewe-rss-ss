'use strict';
const fs = require('node:fs'),
  crypto = require('node:crypto'),
  assert = require('node:assert/strict');
function acquire(file) {
  const token = Buffer.from(
    JSON.stringify({ pid: process.pid, token: crypto.randomUUID() }),
  );
  const fd = fs.openSync(file, 'wx', 0o600);
  let id;
  try {
    fs.writeFileSync(fd, token);
    fs.fsyncSync(fd);
    const s = fs.fstatSync(fd, { bigint: true });
    id = [s.dev, s.ino, s.birthtimeNs].map(String);
  } finally {
    fs.closeSync(fd);
  }
  const own = () => {
    const s = fs.lstatSync(file, { bigint: true });
    assert.deepEqual(
      [s.dev, s.ino, s.birthtimeNs].map(String),
      id,
      'LOCK_IDENTITY_CHANGED',
    );
    assert(fs.readFileSync(file).equals(token), 'LOCK_OWNER_CHANGED');
  };
  return {
    path: file,
    assertOwned: own,
    release() {
      own();
      fs.unlinkSync(file);
    },
  };
}
module.exports = { acquire };
