const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { startCurrent } = require('./start-current.cjs');
test('rehearsal rejects production port before start', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-start-'));
  try {
    await assert.rejects(
      startCurrent({
        root: d,
        release: d,
        database: d,
        rehearsal: {
          root: d,
          port: 4000,
          obsidianRoot: d,
          guardReport: path.join(d, 'guard'),
        },
      }),
      /NORMAL_START_REHEARSAL_INVALID/,
    );
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
