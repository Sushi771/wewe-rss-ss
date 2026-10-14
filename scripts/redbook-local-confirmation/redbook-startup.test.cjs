'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { spawn } = require('node:child_process');
const base = __dirname;
async function fault(injection, missingArtifact = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redbook-startup-test-'));
  const artifact = path.join(dir, 'artifact');
  fs.mkdirSync(path.join(artifact, 'server-dist/apps/server/src'), {
    recursive: true,
  });
  if (!missingArtifact)
    fs.writeFileSync(
      path.join(artifact, 'server-dist/apps/server/src/main.js'),
      '',
    );
  let source = fs.readFileSync(
    path.join(base, 'redbook-pair-launch.cjs'),
    'utf8',
  );
  source = source.replace(
    "require('./redbook-pair-gateway.cjs')",
    () =>
      `require(${JSON.stringify(path.join(base, 'redbook-pair-gateway.cjs'))})`,
  );
  source = source.replace("require('node:os').tmpdir()", () =>
    JSON.stringify(dir),
  );
  source = source.replace(
    /async function main\(\)\s*\{/,
    (m) => m + '\n' + injection + '\n',
  );
  const fixture = path.join(dir, 'launch.cjs');
  fs.writeFileSync(fixture, source);
  const child = spawn(process.execPath, [fixture, artifact], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (c) => (stdout += c));
  child.stderr.on('data', (c) => (stderr += c));
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(Error('FAULT_DID_NOT_FAIL_FAST'));
    }, 5000);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
  // All paths here were created below this unique temporary directory by this test.
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}
test('startup exception fails immediately with a fixed code and no raw secret', async () => {
  const r = await fault(
    "throw Object.assign(Error('synthetic-secret-must-not-appear'),{code:'MODULE_NOT_FOUND'});",
  );
  assert.equal(r.code, 1);
  assert.match(r.stdout, /"status":"startup_rejected"/);
  assert.match(r.stdout, /"code":"MODULE_NOT_FOUND"/);
  assert.doesNotMatch(r.stdout + r.stderr, /synthetic-secret-must-not-appear/);
  assert.equal(r.stderr, '');
});
test('unhandled asynchronous bootstrap rejection cannot become an opaque ready timeout', async () => {
  const r = await fault(
    "void Promise.reject(Error('synthetic-secret-must-not-appear'));await new Promise(()=>{});",
  );
  assert.equal(r.code, 1);
  assert.match(r.stdout, /"status":"startup_rejected"/);
  assert.match(r.stdout, /"code":"BOOTSTRAP_ERROR"/);
  assert.doesNotMatch(r.stdout + r.stderr, /synthetic-secret-must-not-appear/);
  assert.equal(r.stderr, '');
});

test('actual readiness timeout expression accepts fractional remaining time and expired budget', () => {
  const source = fs.readFileSync(
    path.join(base, 'redbook-pair-launch.cjs'),
    'utf8',
  );
  const start = source.indexOf('AbortSignal.timeout(');
  assert.ok(start >= 0);
  let end = start + 'AbortSignal.timeout'.length,
    depth = 0;
  do {
    const ch = source[end++];
    if (ch === '(') depth++;
    if (ch === ')') depth--;
  } while (depth > 0);
  const expression = source.slice(start, end);
  for (const now of [32999.5, 33500.5, 35001]) {
    const signal = require('node:vm').runInNewContext(expression, {
      AbortSignal,
      Math,
      startupBegan: 0,
      performance: { now: () => now },
    });
    assert.equal(signal.aborted, false);
  }
});

test('missing compiled artifact is reported before a pipe-close timeout or any port bind', async () => {
  const r = await fault('', true);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /"phase":"ARTIFACT_CHECK"/);
  assert.match(r.stdout, /"status":"startup_rejected"/);
  assert.doesNotMatch(r.stdout, /"phase":"PORT_CHECK"/);
});
