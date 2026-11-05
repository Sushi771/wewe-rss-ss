const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { fingerprint } = require('./lib.cjs');
test('legacy resume refuses cumulative test quota before inspecting or spawning', () => {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync.native(os.tmpdir()), 'wewe-resume-budget-'),
  );
  try {
    const legacy = path.join(root, 'legacy'),
      audit = path.join(root, 'managed/old');
    fs.mkdirSync(legacy);
    fs.mkdirSync(audit, { recursive: true });
    fs.writeFileSync(
      path.join(legacy, 'runtime.cjs'),
      'throw new Error("must not spawn")',
    );
    fs.writeFileSync(
      path.join(legacy, 'release.json'),
      JSON.stringify({
        format: 1,
        platform: process.platform,
        arch: process.arch,
        schemaCompatibility: 'legacy-additive',
        sourceCommit: '9755d166e398f77baf52317f63ef36024037881d',
        ...fingerprint(legacy),
      }),
    );
    const database = path.join(audit, 'rehearsal.db');
    fs.writeFileSync(database, 'owned retained fixture');
    fs.writeFileSync(
      database + '.rehearsal.json',
      JSON.stringify({ database }),
    );
    const child = spawnSync(
      process.execPath,
      [
        path.join(__dirname, 'resume-legacy.cjs'),
        '--legacy',
        legacy,
        '--audit',
        audit,
        '--real-copy',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          WEWE_TEST_OUTPUT_ROOT: path.join(root, 'managed'),
          SQLITE_TEST_MAX_BYTES: '1',
        },
        windowsHide: true,
      },
    );
    assert.equal(child.status, 1);
    assert.match(child.stderr, /SPACE_BUDGET_EXCEEDED/);
    assert.equal(fs.readFileSync(database, 'utf8'), 'owned retained fixture');
    assert(!fs.existsSync(path.join(root, 'managed/.test-run.lock')));
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});
