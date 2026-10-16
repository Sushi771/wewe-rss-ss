'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const {
  waitForDevToolsPort,
  diagnostic,
  createBrowserTrace,
} = require('./article-history-browser.cjs');
const valid = '9222\n/devtools/browser/1234-abcd';
const child = () => ({ exitCode: null, signalCode: null });

test('synthetic diagnostics bound stderr/events and never retain private strings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-trace-unit-'));
  try {
    let milliseconds = 0;
    const trace = createBrowserTrace({
      enabled: true,
      directory: root,
      now: () => milliseconds++,
    });
    for (let i = 0; i < 240; i++)
      trace.record('cdp-send', {
        method: 'Runtime.evaluate',
        bytes: i,
        url: 'secret-url',
        token: 'secret-token',
      });
    trace.record('secret-event', { method: 'secret-method' });
    trace.stderr(
      Buffer.from(
        'DevTools listening on ws://private:secret-token/path\n' +
          'secret-token '.repeat(5000) +
          '\nFATAL Permission denied Resource temporarily unavailable',
      ),
    );
    trace.finish(
      'failure',
      Object.assign(Error('secret-token private SQL'), {
        code: 'STARTUP_EXHAUSTED',
        resourceCode: 'EBUSY',
        attempts: 120,
      }),
    );
    trace.finish('success');
    const files = fs.readdirSync(root);
    assert.equal(files.length, 1);
    const bytes = fs.readFileSync(path.join(root, files[0]));
    assert.ok(bytes.length <= 32768);
    assert.ok(!bytes.toString().includes('secret'));
    assert.ok(!bytes.toString().includes('private'));
    const result = JSON.parse(bytes);
    assert.equal(result.events.length, 128);
    assert.ok(result.droppedEvents > 0);
    assert.equal(result.stderr.truncated, true);
    assert.equal(result.stderr.sampledBytes, 16384);
    assert.ok(result.stderr.classifications.includes('DEVTOOLS_LISTENING'));
    assert.ok(result.stderr.classifications.includes('RESOURCE_LIMIT'));
    assert.ok(result.stderr.classifications.includes('PERMISSION'));
    assert.equal(result.failure.attempts, 120);
    assert.equal(result.failure.resourceCode, 'EBUSY');
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('synthetic diagnostics are opt-in, directory-count bounded and non-fatal on write failure', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-trace-limit-'));
  try {
    createBrowserTrace({ directory: path.join(root, 'disabled') }).finish(
      'failure',
      Error('private'),
    );
    assert.equal(fs.existsSync(path.join(root, 'disabled')), false);
    const blocked = path.join(root, 'blocked');
    fs.writeFileSync(blocked, 'owned fixture');
    assert.doesNotThrow(() =>
      createBrowserTrace({ enabled: true, directory: blocked }).finish(
        'failure',
        Error('private'),
      ),
    );
    const full = path.join(root, 'full');
    fs.mkdirSync(full);
    for (let i = 0; i < 64; i++)
      fs.writeFileSync(path.join(full, `${i}.json`), '{}');
    createBrowserTrace({ enabled: true, directory: full }).finish('success');
    assert.equal(fs.readdirSync(full).length, 64);
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('startup observation retains polling reason without increasing attempts or budget', async () => {
  let elapsed = 0;
  const observations = [];
  await assert.rejects(
    waitForDevToolsPort('unused', child(), {
      now: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms;
      },
      timeoutMs: 250,
      readFile: () => {
        throw Object.assign(Error('private'), { code: 'EBUSY' });
      },
      observe: (value) => observations.push(value),
    }),
    (error) => error.code === 'STARTUP_EXHAUSTED' && error.attempts === 3,
  );
  assert.equal(elapsed, 250);
  assert.deepEqual(
    observations.map((value) => value.portState),
    ['busy', 'busy', 'busy', 'exhausted'],
  );
  assert.equal(observations[3].code, 'EBUSY');
});

// Execute the exact CLI with mocked owned resources and explicit clock ticks.
// No browser starts, ports, profiles or external requests are created here.
async function deadlineFixture(
  stage,
  { childStalls = false, profile = 'ok', diagnostics = false } = {},
) {
  const source = fs.readFileSync(
    path.join(__dirname, 'article-history-browser.cjs'),
    'utf8',
  );
  const timers = new Map();
  let sequence = 0;
  const calls = {
    kill: 0,
    remove: 0,
    close: 0,
    socket: 0,
    exits: [],
    stderr: '',
    artifacts: [],
    stderrDestroyed: 0,
  };
  const ownedChild = Object.assign(new EventEmitter(), {
    stderr: Object.assign(new EventEmitter(), {
      destroy() {
        calls.stderrDestroyed++;
      },
    }),
    exitCode: null,
    signalCode: null,
    kill() {
      calls.kill++;
      if (!childStalls) this.exitCode = 0;
    },
  });
  const server = {
    listen(_port, _host, ready) {
      ready();
    },
    address: () => ({ port: 12345 }),
    closeAllConnections() {},
    close() {
      calls.close++;
    },
  };
  const modules = {
    'node:fs': {
      mkdirSync() {},
      lstatSync: () => ({
        isDirectory: () => true,
        isSymbolicLink: () => false,
      }),
      readdirSync: () => [],
      writeFileSync(_file, value) {
        calls.artifacts.push(JSON.parse(value));
      },
      existsSync: (file) => file === '/owned/mock-browser',
      mkdtempSync: () => '/owned/mock-profile',
      readFileSync: () => {
        if (stage === 'startup')
          throw Object.assign(Error('private'), { code: 'ENOENT' });
        return '12345\n/devtools/browser/owned-fixture\n';
      },
      promises: {
        rm: () => {
          calls.remove++;
          return profile === 'stall'
            ? new Promise(() => {})
            : profile === 'fail'
              ? Promise.reject(
                  Object.assign(Error('private token/path'), { code: 'EPERM' }),
                )
              : Promise.resolve();
        },
      },
    },
    'node:path': path,
    'node:os': {
      homedir: () => '/owned/home',
      tmpdir: () => '/owned/temp',
      freemem: () => 1024,
    },
    'node:http': { createServer: () => server },
    'node:child_process': { spawn: () => ownedChild },
  };
  const cliModule = { exports: {} };
  const cliRequire = (name) => {
    assert.ok(name in modules);
    return modules[name];
  };
  cliRequire.main = cliModule;
  const stdin = (async function* () {
    yield JSON.stringify({ root: '/owned/root', pages: [] });
  })();
  stdin.destroy = () => {};
  const cliProcess = {
    stdin,
    pid: 42,
    env: {
      ARTICLE_HISTORY_CHROME: '/owned/mock-browser',
      ...(diagnostics
        ? {
            GITHUB_ACTIONS: 'true',
            ARTICLE_HISTORY_SYNTHETIC_DIAGNOSTICS: '1',
            RUNNER_TEMP: '/owned/temp',
            ARTICLE_HISTORY_DIAGNOSTICS_DIR: path.resolve(
              '/owned/temp',
              'article-history-diagnostics',
            ),
          }
        : {}),
    },
    stdout: {
      write() {
        if (stage !== 'cleanup') assert.fail('must not publish success');
      },
    },
    stderr: {
      write(text) {
        calls.stderr += text;
      },
    },
    exit(code) {
      calls.exits.push({
        code,
        kill: calls.kill,
        remove: calls.remove,
        close: calls.close,
      });
    },
  };
  class Socket {
    constructor() {
      if (['cdp', 'cleanup'].includes(stage))
        queueMicrotask(() => this.onopen());
    }
    close() {
      calls.socket++;
    }
    send(raw) {
      // Most cases stall the first CDP command. The cleanup case completes
      // normal work, then the operation deadline arrives during profile removal.
      if (stage === 'cleanup') {
        const { id } = JSON.parse(raw);
        queueMicrotask(() =>
          this.onmessage({ data: JSON.stringify({ id, result: {} }) }),
        );
      }
    }
  }
  vm.runInNewContext(
    source,
    {
      require: cliRequire,
      module: cliModule,
      exports: cliModule.exports,
      process: cliProcess,
      Buffer,
      performance,
      AbortController,
      WebSocket: Socket,
      fetch: () =>
        stage === 'connect'
          ? new Promise(() => {})
          : Promise.resolve({
              json: async () => ({
                webSocketDebuggerUrl: 'ws://127.0.0.1/mock',
              }),
            }),
      setTimeout(callback, ms) {
        const id = ++sequence;
        timers.set(id, { callback, ms });
        return id;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    },
    { timeout: 3000 },
  );
  const settle = () => new Promise(setImmediate);
  const fire = (ms) => {
    const entry = [...timers].find(([, timer]) => timer.ms === ms);
    assert.ok(entry, `expected bounded ${ms}ms timer`);
    timers.delete(entry[0]);
    entry[1].callback();
  };
  await settle();
  if (diagnostics)
    ownedChild.stderr.emit(
      'data',
      Buffer.from('DevTools listening on ws://private/secret-token'),
    );
  fire(170000);
  await settle();
  if (childStalls) {
    fire(3000);
    await settle();
  }
  if (profile === 'stall') {
    fire(2000);
    await settle();
  }
  assert.deepEqual(calls.exits, [{ code: 1, kill: 1, remove: 1, close: 1 }]);
  assert.equal(
    [...timers.values()].some((timer) => [6000, 10000].includes(timer.ms)),
    false,
  );
  const result = JSON.parse(calls.stderr);
  assert.equal(result.code, 'BROWSER_DEADLINE');
  assert.equal(
    result.phase,
    stage === 'cleanup'
      ? 'remote-check'
      : stage === 'socket'
        ? 'connect'
        : stage,
  );
  assert.equal(result.cleanup.childExited, !childStalls);
  assert.equal(result.cleanup.profileRemoved, profile === 'ok');
  assert.ok(!calls.stderr.includes('private'));
  if (['socket', 'cdp'].includes(stage)) assert.equal(calls.socket, 1);
  if (diagnostics) {
    assert.equal(calls.stderrDestroyed, 1);
    assert.equal(calls.artifacts.length, 1);
    const artifact = calls.artifacts[0];
    assert.equal(artifact.failure.code, 'BROWSER_DEADLINE');
    assert.ok(artifact.events.some((row) => row.event === 'http-start'));
    assert.ok(artifact.events.some((row) => row.event === 'cleanup-end'));
    assert.ok(artifact.stderr.classifications.includes('DEVTOOLS_LISTENING'));
    assert.ok(!JSON.stringify(artifact).includes('secret-token'));
  }
}

for (const stage of ['startup', 'connect', 'socket', 'cdp'])
  test(`hard deadline cleans owned resources before exit during ${stage}`, () =>
    deadlineFixture(stage));
test('hard deadline bounds stalled child and profile cleanup independently', () =>
  deadlineFixture('connect', { childStalls: true, profile: 'stall' }));
test('hard deadline reports profile cleanup failure without private error text', () =>
  deadlineFixture('connect', { profile: 'fail' }));
test('hard deadline still reports failure if it arrives during normal cleanup', () =>
  deadlineFixture('cleanup', { profile: 'stall' }));
test('hard deadline writes bounded synthetic diagnostics and releases inherited stderr', () =>
  deadlineFixture('connect', { diagnostics: true }));
function clock() {
  let elapsed = 0;
  return {
    now: () => elapsed,
    sleep: async (ms) => {
      elapsed += ms;
    },
  };
}

for (const code of ['ENOENT', 'EBUSY', 'EPERM'])
  test(`bounded startup retries one ${code} then succeeds, repeatedly`, async () => {
    for (let round = 0; round < 20; round++) {
      let reads = 0;
      const port = await waitForDevToolsPort('unused', child(), {
        ...clock(),
        readFile: () => {
          if (++reads === 1)
            throw Object.assign(Error('private path/token must not escape'), {
              code,
            });
          return valid;
        },
      });
      assert.equal(port, 9222);
      assert.equal(reads, 2);
    }
  });

test('incomplete startup file is retried; complete invalid ports never are', async () => {
  let reads = 0;
  const contents = [
    '',
    '9222',
    '9222\n',
    '9222\n/devtools/bro',
    '9222\n/devtools/browser/',
    valid,
  ];
  assert.equal(
    await waitForDevToolsPort('unused', child(), {
      ...clock(),
      readFile: () => contents[reads++],
    }),
    9222,
  );
  assert.equal(reads, 6);
  for (const raw of [
    '0\n/devtools/browser/id',
    '65536\n/devtools/browser/id',
    'NaN\n/devtools/browser/id',
    '9222\nhttps://private.invalid/token',
    'x'.repeat(1025),
  ]) {
    reads = 0;
    await assert.rejects(
      waitForDevToolsPort('unused', child(), {
        ...clock(),
        readFile: () => {
          reads++;
          return raw;
        },
      }),
      { code: 'INVALID_PORT_FILE' },
    );
    assert.equal(reads, 1);
  }
});

test('persistent busy and incomplete files exhaust original attempts/deadline', async () => {
  for (const busy of [true, false]) {
    let reads = 0;
    await assert.rejects(
      waitForDevToolsPort('unused', child(), {
        ...clock(),
        readFile: () => {
          reads++;
          if (busy) throw Object.assign(Error('private'), { code: 'EBUSY' });
          return '';
        },
      }),
      (error) => error.code === 'STARTUP_EXHAUSTED' && error.attempts === 120,
    );
    assert.equal(reads, 120);
  }
  let reads = 0;
  await assert.rejects(
    waitForDevToolsPort('unused', child(), {
      ...clock(),
      timeoutMs: 250,
      readFile: () => {
        reads++;
        return '';
      },
    }),
    { code: 'STARTUP_EXHAUSTED' },
  );
  assert.equal(reads, 3);
});

test('unknown errors, child exit and spawn failures fail immediately', async () => {
  for (const code of ['EIO', 'EACCES', 'UNRECOGNIZED']) {
    let reads = 0;
    await assert.rejects(
      waitForDevToolsPort('unused', child(), {
        ...clock(),
        readFile: () => {
          reads++;
          throw Object.assign(Error('secret'), { code });
        },
      }),
      { code },
    );
    assert.equal(reads, 1);
  }
  await assert.rejects(
    waitForDevToolsPort(
      'unused',
      { exitCode: 1 },
      { readFile: () => assert.fail('must not read') },
    ),
    { code: 'BROWSER_EXITED' },
  );
  await assert.rejects(
    waitForDevToolsPort('unused', child(), {
      spawnError: () => Object.assign(Error('secret'), { code: 'ENOENT' }),
      readFile: () => assert.fail('must not read'),
    }),
    { code: 'ENOENT' },
  );
});

test('browser failure diagnostics omit private messages, arbitrary names and fields', () => {
  const error = Object.assign(Error('private SQL/path/token'), {
    name: 'PRIVATE_TYPE',
    code: 'PRIVATE_CODE',
    detail: 'secret',
  });
  assert.deepEqual(diagnostic(error, 'private-stage'), {
    format: 'article-history-browser-error-v1',
    phase: 'input',
    errorType: 'UnknownError',
    code: 'UNCLASSIFIED',
  });
});

test(
  'real offline browser survives injected one-shot startup contention in six consecutive runs',
  {
    timeout: 150000,
    skip: process.env.ARTICLE_HISTORY_BROWSER_REQUIRED !== '1',
  },
  () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'history-browser-reliability-'),
    );
    try {
      fs.writeFileSync(
        path.join(root, 'reader.html'),
        '<!doctype html><title>synthetic offline reader</title><p>test</p>',
      );
      for (let round = 0; round < 6; round++) {
        const count = path.join(root, `reads-${round}.txt`);
        const preload = path.join(root, `inject-${round}.cjs`);
        const code = ['EBUSY', 'EPERM', 'ENOENT'][round % 3];
        fs.writeFileSync(
          preload,
          `const fs=require('node:fs');const read=fs.readFileSync;let n=0;fs.readFileSync=function(file,...args){if(String(file).endsWith('DevToolsActivePort')){fs.appendFileSync(${JSON.stringify(count)},'read\\n');if(++n===1)throw Object.assign(Error('private diagnostic must stay private'),{code:${JSON.stringify(code)}});}return read.call(this,file,...args)};`,
        );
        const result = spawnSync(
          process.execPath,
          [
            '--require',
            preload,
            path.join(__dirname, 'article-history-browser.cjs'),
          ],
          {
            input: JSON.stringify({ root, pages: ['reader.html'] }),
            encoding: 'utf8',
            windowsHide: true,
            timeout: 22000,
          },
        );
        assert.equal(result.status, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).decoded, true);
        assert.equal(JSON.parse(result.stdout).remoteRequests, 0);
        assert.ok(fs.readFileSync(count, 'utf8').split('read').length - 1 >= 2);
      }
    } finally {
      // Retain this bounded diagnostic fixture in OS temp; no file deletion here.
      assert.ok(
        fs
          .readdirSync(root)
          .reduce(
            (sum, name) => sum + fs.statSync(path.join(root, name)).size,
            0,
          ) < 32768,
      );
    }
  },
);
