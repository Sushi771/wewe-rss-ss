const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { progressState, writeProgress } = require('./desktop-progress.cjs');
const { safeFailure, failure } = require('./desktop-dependencies.cjs');

test(
  'Windows atomic state publication tolerates a short overlapping UI read',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const { spawn } = require('node:child_process');
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'wewe-state-sharing-'),
    );
    let child;
    t.after(() => {
      child?.kill();
      assert.equal(path.dirname(directory), os.tmpdir());
      fs.rmSync(directory, { recursive: true, force: true });
    });
    const state = path.join(directory, 'desktop-start-status.json');
    const opened = path.join(directory, 'opened'),
      finish = path.join(directory, 'finish');
    const quote = (value) => "'" + value.replace(/'/g, "''") + "'";
    const source = fs.readFileSync(
      path.join(__dirname, 'desktop-progress.ps1'),
      'utf8',
    );
    const reader = source
      .slice(
        source.indexOf('function Read-StartupState'),
        source.indexOf('$sha ='),
      )
      .replace(
        'return ($reader.ReadToEnd()',
        `Set-Content -LiteralPath ${quote(opened)} -Value opened; Start-Sleep -Milliseconds 100; return ($reader.ReadToEnd()`,
      );
    const command = `$ErrorActionPreference='Stop'; $StateFile=${quote(state)}; ${reader}; (Read-StartupState).stage`;
    writeProgress(directory, 'app');
    child = spawn(
      path.join(
        process.env.SystemRoot,
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      ),
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(command, 'utf16le').toString('base64'),
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '',
      error = '';
    child.stdout.on('data', (bytes) => (output += bytes));
    child.stderr.on('data', (bytes) => (error += bytes));
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0 ? resolve() : reject(Error(error)),
      );
    });
    exited.catch(() => {});
    const deadline = Date.now() + 8000;
    while (
      !fs.existsSync(opened) &&
      Date.now() < deadline &&
      child.exitCode === null
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert(fs.existsSync(opened), 'reader failed to hold old state');
    writeProgress(directory, 'ready');
    assert.equal(JSON.parse(fs.readFileSync(state, 'utf8')).stage, 'ready');
    fs.writeFileSync(finish, 'done');
    await exited;
    assert.equal(
      output.trim(),
      'app',
      'reader keeps its complete prior snapshot',
    );
  },
);

test('progress state and atomic updates work in a Chinese path with spaces', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'WeWe 中文 启动 '));
  try {
    writeProgress(directory, 'app');
    writeProgress(directory, 'waiting', safeFailure(Error('AUTH_CODE=secret')));
    const text = fs.readFileSync(
      path.join(directory, 'desktop-start-status.json'),
      'utf8',
    );
    assert.equal(JSON.parse(text).status, 'failed');
    assert.equal(text.includes('secret'), false);
    assert.equal(fs.readdirSync(directory).length, 1);
    assert.equal(progressState('ready').backendReady, true);
    assert.throws(() => progressState('arbitrary'));
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

function fixture({
  check = false,
  joined = false,
  dependencyFailure = false,
  browserFailure = false,
} = {}) {
  const calls = [];
  const logs = [];
  const context = {
    module: { exports: {} },
    __dirname,
    performance,
    console,
    process: {
      env: { ProgramFiles: 'C:/Program Files', SystemRoot: 'C:/Windows' },
      argv: check ? ['node', 'entry', '--check'] : ['node', 'entry'],
    },
    require(name) {
      if (name === 'node:fs')
        return {
          existsSync: () => true,
          mkdirSync() {},
          appendFileSync: (_, text) => logs.push(JSON.parse(text)),
        };
      if (name === './desktop-progress.cjs')
        return {
          writeProgress: (_, stage, error) =>
            calls.push(error ? `failed:${error.code}` : stage),
          showProgress: async () => calls.push('window'),
        };
      if (name === './logon-start.cjs')
        return {
          startAtLogon: async () => {
            calls.push('start-app');
            return { status: 'already-running', releaseId: 'fixture', pid: 42 };
          },
        };
      if (name === './desktop-dependencies.cjs')
        return {
          readPin: () => ({}),
          discoverDocker: async () => ({}),
          realAdapter: () => ({}),
          ensureDependencies: async (_, __, options) => {
            calls.push('dependency');
            options.onProgress('dependencyReady');
            if (dependencyFailure) throw failure('DEPENDENCY_NOT_READY');
            return { status: 'already-running' };
          },
          withLaunchLock: async (_, action, options) => {
            if (joined) await options.onWait();
            return action();
          },
          safeFailure,
          failure,
        };
      if (name === 'node:child_process')
        return {
          spawn(exe, args, options) {
            calls.push('browser');
            assert.equal(options.windowsHide, false);
            assert.equal(options.shell, false);
            assert.equal(
              args[0],
              'http://127.0.0.1:4000/dash/tools/article-download',
            );
            assert.equal(args[1], 'http://127.0.0.1:18080/#/');
            assert(calls.indexOf('start-app') < calls.indexOf('browser'));
            const child = new EventEmitter();
            child.unref = () => {};
            queueMicrotask(() =>
              child.emit(
                browserFailure ? 'error' : 'spawn',
                Error('synthetic'),
              ),
            );
            return child;
          },
        };
      return require(name);
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, 'desktop-start.cjs'), 'utf8') +
      '\nmodule.exports.run = main;',
    context,
  );
  return { calls, logs, run: context.module.exports.run };
}
test('normal entry shows progress, checks dependency, then opens visible browser', async () => {
  const f = fixture();
  await f.run();
  assert.deepEqual(f.calls.slice(0, 2), ['waiting', 'window']);
  assert.equal(f.logs[0].pid, 42);
  assert.equal(f.logs[0].browserRequested, true);
  assert.equal(f.calls.at(-1), 'ready');
});
test('check mode has no GUI or browser side effects', async () => {
  const f = fixture({ check: true });
  await f.run();
  assert(!f.calls.includes('window'));
  assert(!f.calls.includes('browser'));
});
test('queued repeat focuses existing progress and never opens another browser', async () => {
  const f = fixture({ joined: true });
  await f.run();
  assert.equal(f.calls.filter((c) => c === 'window').length, 1);
  assert(!f.calls.includes('waiting'));
  assert(!f.calls.includes('browser'));
  assert.equal(f.logs[0].joined, true);
});
test('dependency timeout preserves a safe visible failure and never starts app/browser', async () => {
  const f = fixture({ dependencyFailure: true });
  await assert.rejects(f.run(), { code: 'DEPENDENCY_NOT_READY' });
  assert(!f.calls.includes('start-app'));
  assert(!f.calls.includes('browser'));
  assert.equal(f.calls.at(-1), 'failed:DEPENDENCY_NOT_READY');
  assert.equal(f.logs.length, 0);
});
test('browser spawn error is distinct and keeps already-ready services', async () => {
  const f = fixture({ browserFailure: true });
  await assert.rejects(f.run(), { code: 'BROWSER_FAILED' });
  assert.equal(f.calls.filter((c) => c === 'start-app').length, 1);
  assert.equal(f.calls.at(-1), 'failed:BROWSER_FAILED');
});
