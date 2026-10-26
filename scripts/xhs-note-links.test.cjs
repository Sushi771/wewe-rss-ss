const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path');
const ts = require(
  require.resolve('typescript', { paths: [path.resolve('apps/web')] }),
);
const moduleUnderTest = { exports: {} };
new Function(
  'exports',
  'module',
  ts.transpileModule(
    fs.readFileSync('apps/web/src/utils/xhs-note-presentation.ts', 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS } },
  ).outputText,
)(moduleUnderTest.exports, moduleUnderTest);
const { xhsOriginalNoteUrl } = moduleUnderTest.exports;
test('all 266 directory identities link independently of cache and never include source tokens', () => {
  for (let i = 0; i < 266; i++) {
    const note = (i + 1).toString(16).padStart(24, '0');
    assert.equal(
      xhsOriginalNoteUrl(JSON.stringify(['xiaohongshu', 'note', note])),
      `https://www.xiaohongshu.com/explore/${note}`,
    );
  }
});
test('malformed identities, protocols, empty links and injection never become hrefs', () => {
  for (const id of [
    '',
    'javascript:alert(1)',
    'https://evil.invalid',
    '["xiaohongshu","note","a/b"]',
    '["xiaohongshu","note","?xsec_token=secret"]',
    '["xiaohongshu","note",null]',
    '["xiaohongshu","note","x",1]',
    '["xiaohongshu", "note", "x"]',
    '["other","note","x"]',
    '["xiaohongshu","note","<img>"]',
  ])
    assert.equal(xhsOriginalNoteUrl(id), undefined, id);
});
