const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { identityTool } = require('./identity-tool.cjs');
const { fileHash } = require('./lib.cjs');

test('compiled identity cache rejects altered executable or receipt before execution', () => {
  const cacheRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'wewe-identity-cache-'),
  );
  try {
    const sourceHash = fileHash(path.join(__dirname, 'process-identity.cs'));
    const folder = path.join(cacheRoot, sourceHash);
    fs.mkdirSync(folder);
    const executable = path.join(folder, 'process-identity.exe');
    const receipt = path.join(folder, 'verified.json');
    fs.writeFileSync(executable, 'trusted');
    const record = { format: 1, sourceHash, sha256: fileHash(executable) };
    fs.writeFileSync(receipt, JSON.stringify(record));
    assert.equal(identityTool({ cacheRoot }), executable);
    fs.writeFileSync(executable, 'altered'); // Same length.
    assert.throws(() => identityTool({ cacheRoot }), /integrity/);
    fs.writeFileSync(executable, 'trusted');
    for (const change of [
      { format: 2 },
      { sourceHash: 'other' },
      { sha256: 'other' },
    ]) {
      fs.writeFileSync(receipt, JSON.stringify({ ...record, ...change }));
      assert.throws(() => identityTool({ cacheRoot }), /integrity/);
    }
    fs.writeFileSync(receipt, 'broken');
    assert.throws(() => identityTool({ cacheRoot }));
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test(
  'concurrent first compilation falls back without adopting an unverified executable',
  { skip: process.platform !== 'win32' },
  () => {
    const cacheRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'wewe-identity-lock-'),
    );
    try {
      const folder = path.join(
        cacheRoot,
        fileHash(path.join(__dirname, 'process-identity.cs')),
      );
      fs.mkdirSync(folder);
      fs.mkdirSync(folder + '.building');
      fs.writeFileSync(path.join(folder, 'process-identity.exe'), 'unverified');
      assert.equal(identityTool({ cacheRoot }), undefined);
      assert.equal(fs.existsSync(path.join(folder, 'verified.json')), false);
    } finally {
      fs.rmSync(cacheRoot, { recursive: true, force: true });
    }
  },
);
