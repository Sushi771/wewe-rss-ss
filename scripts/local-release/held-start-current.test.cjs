'use strict';
// Exercise the real normal-start entry with synthetic toolkit observations and
// bound local responses. No native identity query or application is executed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { startCurrent } = require('./start-current.cjs');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

async function fixture(run) {
  const temp = fs.realpathSync.native(os.tmpdir());
  const root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(temp, 'held-start-fixture-')),
  );
  const id = 'synthetic-held-release';
  const release = path.join(root, '.local-releases', id);
  const scripts = path.join(root, 'scripts/local-release');
  fs.mkdirSync(path.join(release, 'runtime'), { recursive: true });
  fs.mkdirSync(scripts, { recursive: true });
  const executable = path.join(release, 'runtime/node.exe');
  fs.writeFileSync(executable, 'synthetic, never launched');
  const manifest = {
    id,
    files: { 'runtime/node.exe': hash(fs.readFileSync(executable)) },
  };
  const manifestFile = path.join(release, 'release.json');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const database = path.join(root, 'synthetic.sqlite');
  fs.writeFileSync(database, 'synthetic, never opened');
  const pointer = path.join(root, '.local-releases/active.json');
  fs.writeFileSync(pointer, JSON.stringify({ format: 1, id }));
  const identity = {
    pid: 42,
    executable,
    commandLine: 'synthetic fixed command',
    startUtc: 'fixture-start',
  };
  const calls = { snapshots: 0, spawns: 0, urls: [] };
  const key = '__heldStartFixture_' + crypto.randomUUID().replaceAll('-', '');
  const toolkit = {
    processIdentity(action) {
      if (action === 'Snapshot') calls.snapshots++;
      return { ...identity };
    },
    waitReady: () =>
      assert.fail('ordinary RSS smoke must not run in held management'),
    loadProductionEnvironment: () =>
      assert.fail('existing instance must not be launched again'),
  };
  globalThis[key] = toolkit;
  fs.writeFileSync(
    path.join(scripts, 'switch.cjs'),
    `module.exports=globalThis[${JSON.stringify(key)}];`,
  );
  fs.writeFileSync(
    path.join(scripts, 'lib.cjs'),
    "exports.verifyRelease=p=>JSON.parse(require('node:fs').readFileSync(require('node:path').join(p,'release.json'),'utf8'));\n",
  );
  fs.writeFileSync(
    path.join(scripts, 'restart.cjs'),
    "exports.commandLine=()=> 'synthetic fixed command';\n",
  );
  const originalEnv = { ...process.env },
    originalFetch = globalThis.fetch,
    originalSpawn = cp.spawn;
  process.env.WECHAT2RSS_RECOVERY_HOLD = '1';
  delete process.env.PRIVATE_ONLINE_MODE;
  const health = {
    id,
    sha256: hash(fs.readFileSync(manifestFile)),
    database,
    httpReady: true,
    databaseReadable: true,
    readOnly: false,
  };
  globalThis.fetch = async (url, options) => {
    calls.urls.push(url);
    assert.equal(options.method, 'GET');
    return Response.json(
      url.endsWith('/startup-status')
        ? { status: 'ready', writesAllowed: true, databaseRecovery: 'ready' }
        : health,
    );
  };
  cp.spawn = () => {
    calls.spawns++;
    throw Error('FIXTURE_SPAWN_FORBIDDEN');
  };
  try {
    await run({
      root,
      release,
      database,
      pointer,
      health,
      calls,
      toolkit,
      identity,
    });
    assert.equal(calls.spawns, 0);
    assert.equal(process.env.WECHAT2RSS_RECOVERY_HOLD, '1');
    assert.equal(fs.readFileSync(database, 'utf8'), 'synthetic, never opened');
    assert(!fs.existsSync(path.join(root, '.active-release.lock')));
    assert(
      !fs.existsSync(path.join(root, '.local-releases/.build-budget.lock')),
    );
  } finally {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
    cp.spawn = originalSpawn;
    delete globalThis[key];
    assert.equal(path.dirname(root), temp);
    assert(path.basename(root).startsWith('held-start-fixture-'));
    fs.rmSync(root, { recursive: true });
  }
}

test('held normal start reuses the unique instance with bound management health and no spawn', () =>
  fixture(async (f) => {
    const result = await startCurrent(f);
    assert.equal(result.alreadyRunning, true);
    assert.equal(result.newIdentity.pid, 42);
    assert.equal(result.readiness, 'held-local-management');
    assert.equal(f.calls.snapshots, 1);
    assert.deepEqual(f.calls.urls, [
      'http://127.0.0.1:4000/_local/update-health',
      'http://127.0.0.1:4000/startup-status',
    ]);
  }));

test('held normal start refuses a changed active pointer after otherwise valid health', () =>
  fixture(async (f) => {
    const original = globalThis.fetch;
    globalThis.fetch = async (...args) => {
      if (args[0].endsWith('/startup-status'))
        fs.writeFileSync(
          f.pointer,
          JSON.stringify({ format: 1, id: 'different' }),
        );
      return original(...args);
    };
    await assert.rejects(startCurrent(f), /HELD_ACTIVE_POINTER_CHANGED/);
  }));

test('held normal start refuses PID identity changes after health', () =>
  fixture(async (f) => {
    const original = f.toolkit.processIdentity;
    f.toolkit.processIdentity = (action) => ({
      ...original(action),
      ...(action === 'Snapshot' ? { startUtc: 'different' } : {}),
    });
    await assert.rejects(startCurrent(f), /different/);
  }));

test('held normal start refuses another release health without trying another process', () =>
  fixture(async (f) => {
    f.health.id = 'different';
    await assert.rejects(startCurrent(f), /HELD_READINESS_IDENTITY_MISMATCH/);
    assert.equal(f.calls.snapshots, 0);
  }));
