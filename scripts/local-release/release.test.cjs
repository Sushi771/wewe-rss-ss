const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const {
  fingerprint,
  verifyRelease,
  writeJson,
  cleanEnvironment,
  run,
} = require('./lib.cjs');
const testRoot = path.resolve(
  __dirname,
  '../../output/playwright/local-release-tests',
  randomUUID(),
);
fs.mkdirSync(testRoot, { recursive: true });

function fixture() {
  const folder = path.join(testRoot, randomUUID());
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'runtime.cjs'), '// fixture\n');
  writeJson(path.join(folder, 'release.json'), {
    format: 1,
    platform: process.platform,
    arch: process.arch,
    ...fingerprint(folder),
  });
  return folder;
}

test('完整产物通过，内容篡改与新增可执行文件均拒绝', () => {
  const valid = fixture();
  assert.equal(verifyRelease(valid).format, 1);
  fs.appendFileSync(path.join(valid, 'runtime.cjs'), '// changed');
  assert.throws(() => verifyRelease(valid), /完整性/);
  const extra = fixture();
  fs.writeFileSync(path.join(extra, 'injected.cjs'), '// extra');
  assert.throws(() => verifyRelease(extra), /完整性/);
});

test('目录链接逃逸不能通过产物校验', () => {
  const folder = fixture();
  fs.symlinkSync(
    testRoot,
    path.join(folder, 'escape'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.throws(() => verifyRelease(folder), /目录外/);
});

test('显式移除父进程中的引擎及 Node 注入配置', () => {
  const keys = [
    'PRISMA_QUERY_ENGINE_LIBRARY',
    'PRISMA_SCHEMA_ENGINE_BINARY',
    'NODE_OPTIONS',
    'NODE_PATH',
    'DATABASE_URL',
  ];
  const previous = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  try {
    for (const key of keys) process.env[key] = 'untrusted';
    const clean = cleanEnvironment({ DATABASE_URL: 'file:explicit.db' });
    for (const key of keys.slice(0, -1)) assert.equal(clean[key], undefined);
    assert.equal(clean.DATABASE_URL, 'file:explicit.db');
  } finally {
    for (const key of keys)
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
  }
});

test('隔离 guard 在真正发包/启动进程前拦截网络与子进程', () => {
  const report = path.join(testRoot, 'guard.json');
  const script = path.join(testRoot, 'guard-test.cjs');
  fs.writeFileSync(
    script,
    `
    const assert = require('node:assert/strict');
    require(${JSON.stringify(path.join(__dirname, 'offline-guard.cjs'))});
    for (const action of [
      () => require('node:net').connect(1, '127.0.0.1'),
      () => require('node:tls').connect(443, 'example.invalid'),
      () => require('node:dns').lookup('example.invalid', () => {}),
      () => fetch('https://example.invalid'),
      () => require('node:child_process').spawn('does-not-exist'),
    ]) assert.throws(action, /REHEARSAL_EXTERNAL_OPERATION_BLOCKED/);
    const listener = require('node:net').createServer();
    listener.listen(0, '127.0.0.1');
    listener.on('listening', () => listener.close());
  `,
  );
  run(process.execPath, [script], {
    env: { ...cleanEnvironment(), REHEARSAL_GUARD_REPORT: report },
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(report)), {
    installed: true,
    blockedNetwork: 4,
    blockedChildren: 1,
  });
});
