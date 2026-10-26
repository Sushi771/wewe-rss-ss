const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
function load(file) {
  const mod = { exports: {} };
  new Function('exports', 'module', ts.transpileModule(fs.readFileSync(file, 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(mod.exports, mod);
  return mod.exports;
}
const {failureMessage} = load('apps/web/src/utils/operation-message.ts');
const {taskNextStep} = load('apps/web/src/utils/xiaohongshu-subscription.ts');
test('unknown rejection never invents verification or exposes supplied diagnostic secrets', () => {
  const code = 'XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED';
  const message = failureMessage(new Error(code + ' captcha https://evil.invalid/?token=secret'));
  assert.match(message, /原因尚不明确/);
  assert.doesNotMatch(message, /验证码|secret|evil|https:/);
  assert.match(taskNextStep({code}), /原因尚不明确/);
});
test('explicit verification acknowledges no confirmed entry without directing automatic navigation', () => {
  const code = 'XHS_SOURCE_VERIFICATION_BLOCKED';
  for (const message of [failureMessage(new Error(code)), taskNextStep({code})]) {
    assert.match(message, /没有可确认的验证入口/);
    assert.doesNotMatch(message, /https:|自动打开|完成官方验证/);
  }
});
test('other source failures do not become captcha instructions', () => {
  assert.doesNotMatch(taskNextStep({code:'XHS_SOURCE_AUTH_BLOCKED'}), /验证码|完成官方验证/);
  assert.match(failureMessage(new Error('401 UNAUTHORIZED')), /登录/);
});
