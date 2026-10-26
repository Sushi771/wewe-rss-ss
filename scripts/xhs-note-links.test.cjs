const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path');
const ts = require(
  require.resolve('typescript', { paths: [path.resolve('apps/web')] }),
);
const moduleUnderTest = { exports: {} };
new Function(
  'require',
  'exports',
  'module',
  ts.transpileModule(
    fs.readFileSync('apps/web/src/utils/xhs-note-presentation.ts', 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText,
)(
  (name) => (name === 'react' ? {} : { jsx: () => {}, jsxs: () => {} }),
  moduleUnderTest.exports,
  moduleUnderTest,
);
const { verifiedOriginalUrl } = moduleUnderTest.exports;
test('fixed source codes have short natural messages and arbitrary source errors are not echoed', () => {
  const message = moduleUnderTest.exports.originalLinkMessage;
  assert.match(message('XHS_REQUEST_BUDGET_REQUIRED'), /设置来源请求额度/);
  assert.match(message('XHS_REQUEST_BUDGET_EXHAUSTED'), /已用完/);
  assert.match(message('XHS_REQUEST_RATE_PAUSED'), /间隔/);
  assert.match(message('XHS_SESSION_CHANGED'), /连接/);
  assert.match(message('XHS_SOURCE_VERIFICATION_BLOCKED'), /来源明确提示需要验证/);
  const raw = 'https://evil.invalid/?xsec_token=private';
  assert.equal(message(raw), message());
  assert(!message(raw).includes(raw));
});
test('all 266 saved identities accept only their prepared official URL and preserve returned context', () => {
  for (let i = 0; i < 266; i++) {
    const note = (i + 1).toString(16).padStart(24, '0');
    assert.equal(
      verifiedOriginalUrl(
        JSON.stringify(['xiaohongshu', 'note', note]),
        `https://www.xiaohongshu.com/explore/${note}?xsec_token=synthetic-private&xsec_source=pc_share`,
      ),
      `https://www.xiaohongshu.com/explore/${note}?xsec_token=synthetic-private&xsec_source=pc_share`,
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
    assert.equal(
      verifiedOriginalUrl(id, 'https://www.xiaohongshu.com/explore/x'),
      undefined,
      id,
    );
});

test('only the exact safe comment anchor survives original-link validation',()=>{
 const note=JSON.stringify(['xiaohongshu','note','00AbC123']),url='https://www.xiaohongshu.com/discovery/item/00AbC123?xsec_token=synthetic&xsec_source=pc_share';
 assert.equal(verifiedOriginalUrl(note,url+'#comment-section'),url+'#comment-section');
 for(const hash of ['#javascript:alert(1)','#xsec_token=synthetic','#%63omment-section','#comment-section/../bad','#other'])assert.equal(verifiedOriginalUrl(note,url+hash),undefined);
 assert.equal(verifiedOriginalUrl(note,'https://xhslink.cn/o/synthetic#comment-section'),undefined);
});
