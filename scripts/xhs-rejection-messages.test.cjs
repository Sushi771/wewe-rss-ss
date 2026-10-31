const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require(
  require.resolve('typescript', { paths: [path.resolve('apps/web')] }),
);
function load(file) {
  const mod = { exports: {} };
  new Function('exports', 'module', ts.transpileModule(fs.readFileSync(file, 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(mod.exports, mod);
  return mod.exports;
}
const {failureMessage} = load('apps/web/src/utils/operation-message.ts');
const {taskNextStep} = load('apps/web/src/utils/xiaohongshu-subscription.ts');
test('historical source pause reports review instead of a directory error and hides diagnostics',()=>{
  const message=failureMessage(new Error('XHS_SOURCE_HISTORY_REVIEW_REQUIRED https://evil.invalid/?token=secret'),'fallback');
  assert.match(message,/历史来源请求结果尚需核对/);
  assert.doesNotMatch(message,/目录|secret|evil|https:/);
});
test('unknown rejection never invents verification or exposes supplied diagnostic secrets', () => {
  const code = 'XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED';
  const message = failureMessage(new Error(code + ' captcha https://evil.invalid/?token=secret'));
  assert.match(message, /原因尚不明确/);
  assert.doesNotMatch(message, /验证码|secret|evil|https:/);
  assert.match(taskNextStep({code}), /原因尚不明确/);
});
test('new explicit verification and ambiguous historical stops have distinct safe messages', () => {
  const code = 'XHS_SOURCE_VERIFICATION_BLOCKED';
  assert.match(failureMessage(new Error(code)), /没有可确认的验证入口/);
  assert.match(taskNextStep({code}), /具体原因尚待核查/);
  assert.doesNotMatch(taskNextStep({code}), /明确提示需要验证/);
  for (const message of [failureMessage(new Error(code)), taskNextStep({code})]) {
    assert.doesNotMatch(message, /https:|自动打开|完成官方验证/);
  }
});
test('other source failures do not become captcha instructions', () => {
  assert.doesNotMatch(taskNextStep({code:'XHS_SOURCE_AUTH_BLOCKED'}), /验证码|完成官方验证/);
  assert.match(failureMessage(new Error('401 UNAUTHORIZED')), /登录/);
});
