const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const cleanEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      [
        'PATH',
        'SYSTEMROOT',
        'WINDIR',
        'TEMP',
        'TMP',
        'USERPROFILE',
        'HOME',
        'APPDATA',
        'LOCALAPPDATA',
        'PROGRAMDATA',
        'COMSPEC',
        'PATHEXT',
        'PROCESSOR_ARCHITECTURE',
        'NUMBER_OF_PROCESSORS',
      ].includes(key.toUpperCase()),
    ),
  );
test(
  'real Nest bootstrap imports local cache without a transient reader process, then replays without data loss',
  { timeout: 120000 },
  async () => {
    async function run(extra = []) {
      const result = await promisify(execFile)(
        process.execPath,
        [
          path.join(__dirname, 'local-cache-full-bootstrap.fixture.cjs'),
          ...extra,
        ],
        {
          windowsHide: true,
          env: cleanEnv(),
          timeout: 110000,
          maxBuffer: 1024 * 1024,
          cwd: path.resolve(__dirname, '../..'),
        },
      );
      const line = result.stdout
        .split(/\r?\n/)
        .find((line) => line.startsWith('{"ok":true,'));
      assert.ok(line, result.stdout + result.stderr);
      return JSON.parse(line);
    }
    const first = await run();
    const report = await run(['--reuse-root', first.fixtureRoot]);
    assert.equal(report.articles, 4);
    assert.equal(report.realWriterGate, true);
    assert.equal(report.counts.childReads, 0);
    assert.equal(report.counts.childWatchers, 1);
    assert.equal(report.counts.childSnapshots, 1);
    assert.equal(report.fullMainEntrypoint, true);
    assert.equal(report.counts.blockedChildren, 0);
    assert.equal(report.restartReplayIdentical, true);
    assert.equal(
      report.formalReleasePublication,
      false,
      'do not claim native publication from a source module test',
    );
  },
);
