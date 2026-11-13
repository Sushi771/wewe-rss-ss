const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const ts = require(
  require.resolve('typescript', {
    paths: [path.resolve(__dirname, '../../apps/server')],
  }),
);
const fixture = path.join(__dirname, 'local-cache-full-bootstrap.fixture.cjs');
const source = fs.readFileSync(fixture, 'utf8');
const ast = ts.createSourceFile(
  fixture,
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
const found = {};
function visit(node) {
  if (
    ts.isVariableDeclaration(node) &&
    ['reuse', 'root', 'db'].includes(node.name.getText(ast)) &&
    !found[node.name.getText(ast)]
  )
    found[node.name.getText(ast)] = node;
  ts.forEachChild(node, visit);
}
visit(ast);
assert(found.reuse && found.root && found.db);
const block = source.slice(
  found.reuse.parent.parent.getStart(ast),
  found.db.parent.parent.getStart(ast),
);
const expression = found.root.initializer.getText(ast);
const canonicalCall = "fs.realpathSync.native(require('node:os').tmpdir())";

test('actual fresh root initializer resolves Windows short TEMP before allocation', () => {
  assert(expression.includes(canonicalCall));
  const short = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp';
  const long = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp';
  const fakeFs = {
    realpathSync: {
      native(p) {
        assert.equal(p, short);
        return long;
      },
    },
    mkdtempSync(prefix) {
      assert.equal(path.win32.dirname(prefix), long);
      return prefix + 'owned';
    },
  };
  const run = (value) =>
    new Function(
      'fs',
      'path',
      'require',
      'reuse',
      'process',
      'return (' + value + ')',
    )(fakeFs, path.win32, () => ({ tmpdir: () => short }), false, {});
  assert.ok(run(expression).startsWith(long));
  assert.throws(() =>
    run(expression.replace(canonicalCall, "require('node:os').tmpdir()")),
  );
});

test(
  'real TEMP directory identity, DOS alias and foreign/link/marker refusals',
  { skip: process.platform !== 'win32', timeout: 45000 },
  (t) => {
    const systemTemp = fs.realpathSync.native(os.tmpdir());
    const temp = fs.mkdtempSync(path.join(systemTemp, 'wewe-temp-alias-'));
    const foreign = fs.mkdtempSync(path.join(systemTemp, 'wewe-temp-foreign-'));
    const links = [];
    try {
      const ps = [
        "$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';",
        "Add-Type -TypeDefinition @'",
        'using System;using System.Text;using System.Runtime.InteropServices;public static class TempShortPath { [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern uint GetShortPathName(string p,StringBuilder b,uint n);}',
        "'@",
        '$b=[Text.StringBuilder]::new(32768);',
        "$n=[TempShortPath]::GetShortPathName('" +
          temp.replace(/'/g, "''") +
          "',$b,32768);",
        "if(!$n){throw 'SHORT_PATH_UNAVAILABLE'};[Console]::Out.Write($b.ToString())",
      ].join('\n');
      const alias = cp
        .execFileSync(
          path.join(
            process.env.SystemRoot,
            'System32/WindowsPowerShell/v1.0/powershell.exe',
          ),
          [
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            Buffer.from(ps, 'utf16le').toString('base64'),
          ],
          { encoding: 'utf8', windowsHide: true, timeout: 15000 },
        )
        .trim();
      const identity = (p) => {
        const st = fs.statSync(p, { bigint: true });
        return [st.dev, st.ino];
      };
      assert.equal(fs.realpathSync.native(alias), temp);
      assert.deepEqual(identity(alias), identity(temp));
      assert.deepEqual(identity(os.tmpdir()), identity(systemTemp));
      assert.notDeepEqual(identity(foreign), identity(temp));
      const distinct = alias.toLowerCase() !== temp.toLowerCase();
      t.diagnostic(
        'actual DOS alias distinct=' + distinct + '; same dev/ino verified',
      );
      const run = (text, reused) =>
        new Function(
          'fs',
          'path',
          'assert',
          'require',
          'process',
          'crypto',
          '__filename',
          text + '\nreturn root;',
        )(
          fs,
          path,
          assert,
          (id) => {
            assert.equal(id, 'node:os');
            return { tmpdir: () => alias };
          },
          {
            argv: [
              'node',
              fixture,
              ...(reused ? ['--reuse-root', reused] : []),
            ],
          },
          crypto,
          fixture,
        );
      const root = run(block);
      assert.equal(path.dirname(root), temp);
      assert.equal(run(block, root), root);
      if (distinct)
        assert.throws(() =>
          run(block.replace(canonicalCall, "require('node:os').tmpdir()")),
        );
      const other = fs.mkdtempSync(path.join(foreign, 'wewe-full-bootstrap-'));
      const marker = path.join(root, 'synthetic-fixture.json');
      fs.copyFileSync(marker, path.join(other, 'synthetic-fixture.json'));
      assert.throws(() => run(block, other));
      for (const [link, target] of [
        [path.join(temp, 'wewe-full-bootstrap-link'), root],
        [path.join(root, 'nested-link'), other],
      ]) {
        fs.symlinkSync(target, link, 'junction');
        links.push(link);
        assert.throws(() =>
          run(block, link.endsWith('nested-link') ? root : link),
        );
        fs.unlinkSync(link);
        links.pop();
      }
      const original = fs.readFileSync(marker);
      fs.writeFileSync(marker, '{}');
      assert.throws(() => run(block, root));
      fs.writeFileSync(marker, original);
      const hardlink = path.join(other, 'marker-hardlink');
      fs.linkSync(marker, hardlink);
      assert.throws(() => run(block, root));
      fs.unlinkSync(hardlink);
    } finally {
      for (const link of links)
        if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
      for (const owned of [temp, foreign]) {
        assert.equal(path.dirname(fs.realpathSync.native(owned)), systemTemp);
        assert.ok(path.basename(owned).startsWith('wewe-temp-'));
        assert.ok(!fs.lstatSync(owned).isSymbolicLink());
        fs.rmSync(owned, { recursive: true });
      }
    }
  },
);
