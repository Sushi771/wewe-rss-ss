const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const {
  ensureDependencies,
  validateContainer,
  withLaunchLock,
  safeFailure,
  failure,
} = require('./desktop-dependencies.cjs');
const pin = { id: 'a'.repeat(64), image: `sha256:${'b'.repeat(64)}` };
const root = path.resolve('fixture');
test('desktop entry preserves approved daily schedule before app startup', async () => {
  const source = fs.readFileSync(
    path.join(__dirname, 'desktop-start.cjs'),
    'utf8',
  );
  const env = {
    ENABLE_SCHEDULED_UPDATES: '1',
    DISABLE_SCHEDULED_UPDATES: '0',
    WECHAT2RSS_DAILY_CATCHUP: '1',
  };
  const original = { ...env };
  let starts = 0;
  const module = { exports: {} };
  const dependencies = {
    readPin: () => pin,
    discoverDocker: async () => ({}),
    realAdapter: () => ({}),
    ensureDependencies: async () => ({ status: 'already-running' }),
    withLaunchLock: async (_, action) => action(),
    safeFailure,
    failure,
  };
  const context = vm.createContext({
    module,
    __dirname,
    performance,
    console,
    process: { env, argv: ['node', 'desktop-start.cjs', '--check'] },
    require: (name) => {
      if (name === 'node:fs') return { mkdirSync() {}, appendFileSync() {} };
      if (name === './desktop-dependencies.cjs') return dependencies;
      if (name === './logon-start.cjs')
        return {
          startAtLogon: async () => {
            assert.deepEqual(env, original);
            starts++;
            return { status: 'started', releaseId: 'fixture', pid: 1 };
          },
        };
      if (name === 'node:child_process')
        return { spawn: () => assert.fail('check must not open a browser') };
      return require(name);
    },
  });
  vm.runInContext(source + '\nmodule.exports.runFixture = main;', context);
  await module.exports.runFixture();
  assert.equal(starts, 1);
  assert.deepEqual(env, original);
});
function container(running = true) {
  return {
    ...pin,
    name: '/wewe-rss-ss-wechat2rss-1',
    project: 'wewe-rss-ss',
    service: 'wechat2rss',
    state: { Running: running, Status: running ? 'running' : 'exited' },
    ports: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '18080' }] },
    mounts: [
      {
        Source: path.join(root, '.wechat2rss-data'),
        Destination: '/wechat2rss',
        Type: 'bind',
        RW: true,
      },
    ],
  };
}
function fixture(overrides = {}) {
  let time = 0;
  let c = container();
  const calls = [];
  const a = {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
    engineReady: async () => {
      calls.push('engine');
      return true;
    },
    desktopRunning: async () => false,
    launchDesktop: async () => {
      calls.push('desktop');
    },
    inspect: async () => {
      calls.push('inspect');
      return c;
    },
    portBusy: async () => false,
    start: async (id) => {
      calls.push(`start:${id}`);
      c = container();
    },
    healthy: async () => {
      calls.push('health');
      return true;
    },
    ...overrides,
  };
  return {
    a,
    calls,
    setContainer: (next) => {
      c = next;
    },
  };
}
const options = { projectRoot: root };
test('healthy existing service is reused without Desktop/container launch', async () => {
  const f = fixture();
  assert.deepEqual(await ensureDependencies(f.a, pin, options), {
    status: 'already-running',
  });
  assert.deepEqual(f.calls, ['engine', 'inspect', 'health', 'inspect']);
});
test('cold engine starts original Desktop once, waits, then starts only pinned stopped ID', async () => {
  let attempts = 0;
  const f = fixture({ engineReady: async () => ++attempts >= 4 });
  f.setContainer(container(false));
  assert.deepEqual(await ensureDependencies(f.a, pin, options), {
    status: 'started',
  });
  assert.equal(f.calls.filter((c) => c === 'desktop').length, 1);
  assert.equal(f.calls.filter((c) => c.startsWith('start:')).length, 1);
  assert.ok(f.calls.indexOf(`start:${pin.id}`) < f.calls.indexOf('health'));
});
test('Desktop already starting is waited for without another Desktop process', async () => {
  let tries = 0;
  const f = fixture({
    engineReady: async () => ++tries > 2,
    desktopRunning: async () => true,
  });
  await ensureDependencies(f.a, pin, options);
  assert.equal(f.calls.includes('desktop'), false);
});
test('engine timeout is bounded and never inspects or starts container', async () => {
  const f = fixture({ engineReady: async () => false });
  await assert.rejects(ensureDependencies(f.a, pin, options), {
    code: 'DOCKER_NOT_READY',
  });
  assert.equal(f.a.now(), 120000);
  assert.deepEqual(f.calls, ['desktop']);
});
test('health timeout cannot pass readiness and remains bounded', async () => {
  const f = fixture({ healthy: async () => false });
  await assert.rejects(ensureDependencies(f.a, pin, options), {
    code: 'DEPENDENCY_NOT_READY',
  });
  assert.equal(f.a.now(), 60000);
});
test('stopped container with occupied port is refused without start/kill', async () => {
  const f = fixture({ portBusy: async () => true });
  f.setContainer(container(false));
  await assert.rejects(ensureDependencies(f.a, pin, options), {
    code: 'DEPENDENCY_PORT_BUSY',
  });
  assert.deepEqual(f.calls, ['engine', 'inspect']);
});
for (const kind of [
  'identity',
  'image',
  'name',
  'project',
  'service',
  'public-port',
  'extra-binding',
  'mount',
  'readonly',
  'volume',
]) {
  test(`refuses changed ${kind} without using replacement instance`, () => {
    const c = container();
    if (kind === 'identity') c.id = 'c'.repeat(64);
    if (kind === 'image') c.image = `sha256:${'c'.repeat(64)}`;
    if (kind === 'name') c.name = '/other';
    if (kind === 'project') c.project = 'other';
    if (kind === 'service') c.service = 'other';
    if (kind === 'public-port') c.ports['8080/tcp'][0].HostIp = '0.0.0.0';
    if (kind === 'extra-binding')
      c.ports['8080/tcp'].push({ HostIp: '::', HostPort: '18080' });
    if (kind === 'mount') c.mounts[0].Source = path.resolve('other');
    if (kind === 'readonly') c.mounts[0].RW = false;
    if (kind === 'volume') c.mounts[0].Type = 'volume';
    assert.throws(() => validateContainer(c, pin, root), {
      code: 'CONTAINER_MISMATCH',
    });
  });
}
test('paused, restarting and dead containers are not auto-repaired', () => {
  for (const field of ['Paused', 'Restarting', 'Dead']) {
    const c = container();
    c.state[field] = true;
    assert.throws(() => validateContainer(c, pin, root), {
      code: 'CONTAINER_UNAVAILABLE',
    });
  }
});
test('container dies after HTTP readiness: dependency gate still fails', async () => {
  let n = 0;
  const f = fixture({ inspect: async () => container(++n === 1) });
  await assert.rejects(ensureDependencies(f.a, pin, options), {
    code: 'DEPENDENCY_NOT_READY',
  });
});
test('reuse-only never starts stopped container or unavailable engine', async () => {
  for (const engine of [true, false]) {
    const f = fixture({ engineReady: async () => engine });
    f.setContainer(container(false));
    await assert.rejects(
      ensureDependencies(f.a, pin, { ...options, reuseOnly: true }),
    );
    assert.equal(
      f.calls.some((c) => c === 'desktop' || c.startsWith('start:')),
      false,
    );
  }
});
test('dependency failure does not reach application startup', async () => {
  const f = fixture({
    start: async () => {
      throw failure('CONTAINER_START_FAILED');
    },
  });
  f.setContainer(container(false));
  let appStarted = false;
  await assert.rejects(
    (async () => {
      await ensureDependencies(f.a, pin, options);
      appStarted = true;
    })(),
  );
  assert.equal(appStarted, false);
});
test('untrusted errors containing credentials are never copied to logs or UI', () => {
  const e = new Error('LIC_CODE=secret RSS_TOKEN=secret access_token=secret');
  e.code = 'UNKNOWN';
  assert.deepEqual(safeFailure(e), safeFailure(null));
  assert.equal(JSON.stringify(safeFailure(e)).includes('secret'), false);
  assert.equal(
    safeFailure(failure('DOCKER_NOT_READY')).code,
    'DOCKER_NOT_READY',
  );
});
test('double-click locks serialize actions and release lock after errors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-launch-lock-'));
  const file = path.join(dir, 'launch.lock');
  try {
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const order = [];
    const first = withLaunchLock(file, async () => {
      order.push('first');
      await gate;
      order.push('end');
    });
    const second = withLaunchLock(file, async () => {
      order.push('second');
    });
    release();
    await Promise.all([first, second]);
    assert.deepEqual(order, ['first', 'end', 'second']);
    await assert.rejects(
      withLaunchLock(file, async () => {
        throw Error('test');
      }),
    );
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
test('stale lock is bounded and never deleted automatically', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-launch-stale-'));
  const file = path.join(dir, 'launch.lock');
  let clock = 0;
  fs.writeFileSync(file, 'original');
  try {
    await assert.rejects(
      withLaunchLock(file, async () => assert.fail(), {
        timeout: 1000,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      }),
      { code: 'LAUNCH_BUSY' },
    );
    assert.equal(fs.readFileSync(file, 'utf8'), 'original');
    assert.equal(clock, 1000);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
