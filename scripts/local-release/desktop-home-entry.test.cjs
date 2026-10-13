const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const dependencies = require('./desktop-dependencies.cjs');

const home = 'http://127.0.0.1:4000/dash/feeds';
const backend = 'http://127.0.0.1:18080/#/';
function fixture({
  edge = true,
  env = {},
  status = 'already-running',
  report,
  wait,
} = {}) {
  const opened = [];
  const logs = [];
  const module = { exports: {} };
  const settings = {
    ProgramFiles: 'C:/Program Files',
    SystemRoot: 'C:/Windows',
    ...env,
  };
  const original = { ...settings };
  const browser = {
    selected: 'http://127.0.0.1:4000/dash/tools/article-download',
  };
  const context = {
    module,
    __dirname,
    performance,
    console,
    process: { env: settings, argv: ['node', 'entry', '--reuse-only'] },
    require(name) {
      if (name === 'node:fs')
        return {
          existsSync: () => edge,
          mkdirSync() {},
          appendFileSync: (_, text) => logs.push(JSON.parse(text)),
        };
      if (name === 'node:child_process')
        return {
          spawn(executable, args, options) {
            opened.push({ executable, args: Array.from(args), options });
            if (args.includes(home)) browser.selected = home;
            const child = new EventEmitter();
            child.unref = () => {};
            queueMicrotask(() => child.emit('spawn'));
            return child;
          },
        };
      if (name === './desktop-progress.cjs')
        return { writeProgress() {}, async showProgress() {} };
      if (name === './switch.cjs')
        return { processIdentity: () => ({ pid: 42 }) };
      if (name === './logon-start.cjs')
        return {
          async startAtLogon() {
            if (wait) await wait;
            return { status, releaseId: 'fixture', pid: 42 };
          },
        };
      if (name === './desktop-dependencies.cjs')
        return {
          ...dependencies,
          readPin: () => ({}),
          discoverDocker: async () => ({}),
          realAdapter: () => ({}),
          ensureDependencies: async () => ({ status: 'already-running' }),
          withLaunchLock: report
            ? (_, action, options) =>
                dependencies.withLaunchLock(
                  path.join(report, 'launch.lock'),
                  action,
                  {
                    ...options,
                    sleep: () => new Promise((r) => setTimeout(r, 5)),
                  },
                )
            : async (_, action) => action(),
        };
      return require(name);
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, 'desktop-start.cjs'), 'utf8') +
      '\nmodule.exports.run = main;',
    context,
  );
  return { ...module.exports, opened, logs, browser, settings, original };
}

for (const edge of [true, false]) {
  test(`explicit homepage and backend URLs in ${edge ? 'Edge' : 'Explorer fallback'}`, async () => {
    const f = fixture({
      edge,
      env: {
        SERVER_ORIGIN_URL: 'https://configured.example',
        ENABLE_SCHEDULED_UPDATES: '0',
        DISABLE_SCHEDULED_UPDATES: '1',
      },
    });
    assert.equal(f.url, home);
    assert.equal(f.backendUrl, backend);
    await f.openBrowser();
    assert.deepEqual(
      f.opened.flatMap((c) => c.args),
      [home, backend],
    );
    assert.equal(
      f.browser.selected,
      home,
      'restored tools page receives an explicit home URL',
    );
    assert.deepEqual(
      f.settings,
      f.original,
      'private runtime config is preserved',
    );
    for (const call of f.opened) {
      assert.equal(call.options.shell, false);
      assert.equal(call.options.windowsHide, false);
      assert(
        !call.args.some((arg) => arg.startsWith('--')),
        'no global browser/session flags',
      );
    }
  });
}
for (const status of ['started', 'already-running']) {
  test(`${status} service opens both pages from a previous tools page`, async () => {
    const f = fixture({ status });
    if (status === 'started') f.settings.ProgramFiles = 'C:/Program Files';
    await f.run();
    assert.deepEqual(f.opened[0].args, [home, backend]);
    assert.equal(f.browser.selected, home);
    assert.equal(f.logs[0].status, status);
    assert.equal(f.logs[0].browserRequested, true);
  });
}
test('three overlapping desktop clicks open one pair; a later click navigates home again', async () => {
  const report = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-home-entry-'));
  try {
    let release;
    const wait = new Promise((resolve) => {
      release = resolve;
    });
    const first = fixture({ report, wait });
    const second = fixture({ report });
    const third = fixture({ report });
    const owner = first.run();
    const joined = [second.run(), third.run()];
    await new Promise((resolve) => setTimeout(resolve, 30));
    release();
    await Promise.all([owner, ...joined]);
    assert.equal(first.opened.length, 1);
    assert.equal(second.opened.length + third.opened.length, 0);
    assert.equal(second.logs[0].joined, true);
    assert.equal(third.logs[0].joined, true);
    first.browser.selected =
      'http://127.0.0.1:4000/dash/tools/article-download';
    await first.run();
    assert.equal(first.browser.selected, home);
    assert.deepEqual(first.opened[1].args, [home, backend]);
  } finally {
    // The generated directory is directly beneath the OS temporary directory.
    assert.equal(path.dirname(report), os.tmpdir());
    fs.rmSync(report, { recursive: true });
  }
});
test('both maintained desktop entry points share the URL-opening launcher', () => {
  const root = path.resolve(__dirname, '../..');
  for (const file of [
    path.join(__dirname, 'launch-desktop.vbs'),
    path.join(root, '启动WeWe-RSS.bat'),
  ])
    assert.match(fs.readFileSync(file, 'utf8'), /desktop-start\.cjs/);
  const app = fs.readFileSync(path.join(root, 'apps/web/src/App.tsx'), 'utf8');
  assert.match(app, /path="\/feeds\/:id\?" element={<Feeds \/>}/);
  assert.match(app, /path="\/tools\/article-download"/);
});
