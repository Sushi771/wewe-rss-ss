'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { execFileSync } = require('node:child_process');
const {
  verifySourceSnapshot,
  hashCommittedBuildEnvironment,
} = require('./verify-source.cjs');
test('snapshot CRLF equivalence preserves the BOM while changed BOM or content is refused', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-source-bom-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    });
  git(['init']);
  const relative = 'apps/server/src/fixture.ts',
    original = '\uFEFFexport const value = 1;\n';
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), original);
  git(['-c', 'core.autocrlf=false', 'add', '--', relative]);
  const tree = git(['write-tree']).trim(),
    snapshot = path.join(root, 'snapshot');
  fs.mkdirSync(path.dirname(path.join(snapshot, relative)), {
    recursive: true,
  });
  const file = path.join(snapshot, relative);
  fs.writeFileSync(file, original.replace(/\n/g, '\r\n'));
  assert.equal(verifySourceSnapshot(snapshot, tree, root), 1);
  fs.writeFileSync(file, original.slice(1).replace(/\n/g, '\r\n'));
  assert.throws(() => verifySourceSnapshot(snapshot, tree, root));
  fs.writeFileSync(file, original.replace('1;', '2;').replace(/\n/g, '\r\n'));
  assert.throws(() => verifySourceSnapshot(snapshot, tree, root));
});

test('only the exact committed default environment fixture returns a digest; changed/private content cannot self-certify', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-source-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = execFileSync(
    'git',
    ['cat-file', 'blob', 'HEAD:apps/server/.env'],
    { cwd: path.resolve(__dirname, '../..'), windowsHide: true },
  );
  const file = path.join(root, 'apps/server/.env');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  const expected =
    'efdafcfb690eb12efe9a7fa2a8bcf0977b1d4d31f31096123ae42e21fe6e28d6';
  for (const commit of [
    '3a36428210f22ea1986f0a96a6066e7fdc9baf46',
    'f618e48f48ff0e3df1c646cb8a666a2461815732',
  ])
    assert.equal(
      hashCommittedBuildEnvironment(root, commit, expected),
      expected,
    );
  assert.throws(
    () => hashCommittedBuildEnvironment(root, 'a'.repeat(40), expected),
    /BINDING_REQUIRED/,
  );
  const modified = Buffer.concat([
    bytes,
    Buffer.from('PRIVATE_ADDITION=synthetic\n'),
  ]);
  fs.writeFileSync(file, modified);
  assert.throws(
    () =>
      hashCommittedBuildEnvironment(
        root,
        '3a36428210f22ea1986f0a96a6066e7fdc9baf46',
        expected,
      ),
    /FIXTURE_CHANGED/,
  );
  const forged = require('node:crypto')
    .createHash('sha256')
    .update(modified)
    .digest('hex');
  assert.throws(
    () =>
      hashCommittedBuildEnvironment(
        root,
        '3a36428210f22ea1986f0a96a6066e7fdc9baf46',
        forged,
      ),
    /BINDING_REQUIRED/,
  );
  fs.renameSync(file, path.join(path.dirname(file), '.env.local'));
  assert.throws(() =>
    hashCommittedBuildEnvironment(
      root,
      '3a36428210f22ea1986f0a96a6066e7fdc9baf46',
      expected,
    ),
  );
});
