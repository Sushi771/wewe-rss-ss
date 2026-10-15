'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const {
  waitForDevToolsPort,
  diagnostic,
} = require('./article-history-browser.cjs');
const valid = '9222\n/devtools/browser/1234-abcd';
const child = () => ({ exitCode: null, signalCode: null });
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
