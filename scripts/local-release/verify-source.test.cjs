'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { execFileSync } = require('node:child_process');
const { verifySourceSnapshot } = require('./verify-source.cjs');
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
