'use strict';

// Build Server first. Standard tests need no private data and forbid HTTP.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const { spawnSync } = require('node:child_process');
const {
  TARGET_ARTICLE_ID,
  TARGET_MP_ID,
  EXPECTED_DOM_SHA256,
  ALLOWED_IMAGE_HOST,
  sha256,
  validateImageSignature,
  validateDomEvidence,
  extractAllowedImageUrls,
  defaultFetchImage,
  collectBrowserDomImages,
  publicErrorCode,
} = require('./collect-browser-dom-images-once.cjs');

const imageExamples = [
  [
    'image/png',
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
  ],
  [
    'image/jpeg',
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD9U6KKKAP/2Q==',
  ],
  ['image/gif', 'R0lGODdhAQABAIEAAP8AAAAAAAAAAAAAACwAAAAAAQABAAAIBAABBAQAOw=='],
  [
    'image/webp',
    'UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoBAAEAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=',
  ],
].map(([mimeType, base64]) => ({
  mimeType,
  bytes: Buffer.from(base64, 'base64'),
}));
const validPngBytes = imageExamples[0].bytes;
const validPngSha = sha256(validPngBytes);
const ROOT = path.resolve(__dirname, '../..');
const scriptFile = path.join(__dirname, 'collect-browser-dom-images-once.cjs');
const fixtureUrl = 'https://mmbiz.qpic.cn/synthetic-a?token=synthetic-only';
const domHtml = `<html><body>
  <script>var biz = "${Buffer.from('3895431412').toString('base64')}";
  var mid = "2247493594"; var idx = "1"; var sn = "abcdef1234567890";</script>
  <div id="js_content"><p>Synthetic fixture, not real article evidence.</p>
    <img data-src="${fixtureUrl}#first" src="https://mmbiz.qpic.cn/fallback-only" />
    <img src="${fixtureUrl}#second" />
    <img src="${fixtureUrl}" />
    <img src="https://mmbiz.qpic.cn/synthetic-b" />
    <img data-src="https://mmbiz.qpic.cn/synthetic-c" />
    <img src="https://mmbiz.qpic.cn/synthetic-d" />
  </div></body></html>`;
const fixtureHash = sha256(domHtml);
const observation = {
  kind: 'owner-confirmed-browser-dom',
  id: TARGET_ARTICLE_ID,
  sha256: fixtureHash,
};
const selection = { candidate: { id: TARGET_ARTICLE_ID } };

let originalRequest;
test.before(() => {
  originalRequest = https.request;
  https.request = () => {
    throw new Error('LIVE_HTTP_FORBIDDEN');
  };
});
test.after(() => {
  https.request = originalRequest;
});

async function withFixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-img-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'official-browser-dom.html'), domHtml);
    fs.writeFileSync(
      path.join(dir, 'official-browser-observation.json'),
      JSON.stringify(observation),
    );
    fs.writeFileSync(
      path.join(dir, 'official-original-selection.json'),
      JSON.stringify(selection),
    );
    return await fn(dir);
  } finally {
    // Verify a resolved OS temp child before recursive removal.
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function fixtureOptions(baseDir, extra = {}) {
  return { baseDir, testExpectedHash: fixtureHash, ...extra };
}
function pngResponse() {
  return {
    bytes: validPngBytes,
    sha256: validPngSha,
    mimeType: 'image/png',
    size: validPngBytes.length,
  };
}
function runCli(args) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [scriptFile, ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  });
}

test('image checks accept complete PNG, JPEG, GIF and WebP fixtures', () => {
  for (const { bytes, mimeType } of imageExamples) {
    assert.equal(validateImageSignature(bytes, mimeType), true, mimeType);
    assert.equal(validateImageSignature(bytes, 'image/unsupported'), false);
    assert.equal(
      validateImageSignature(bytes.subarray(0, -1), mimeType),
      false,
    );
  }
  assert.equal(validateImageSignature(validPngBytes, 'image/jpeg'), false);
  assert.equal(validateImageSignature(Buffer.alloc(0), 'image/png'), false);
  assert.equal(
    validateImageSignature(Buffer.from('<html>captcha</html>'), 'image/png'),
    false,
  );
});

test('image checks reject header-only and obviously truncated containers', () => {
  const cases = [
    [
      'image/png',
      Buffer.concat([
        validPngBytes.subarray(0, 33),
        validPngBytes.subarray(-12),
      ]),
    ],
    [
      'image/png',
      Buffer.concat([
        validPngBytes.subarray(0, 40),
        validPngBytes.subarray(-12),
      ]),
    ],
    ['image/jpeg', Buffer.from('ffd8ffe000104a464946ffd9', 'hex')],
    ['image/gif', Buffer.from('4749463b', 'hex')],
    [
      'image/gif',
      Buffer.concat([
        imageExamples[2].bytes.subarray(0, 25),
        Buffer.from([0x3b]),
      ]),
    ],
    ['image/webp', Buffer.from('524946460400000057454250', 'hex')],
    ['image/webp', Buffer.concat([imageExamples[3].bytes, Buffer.from([0])])],
  ];
  for (const [mimeType, bytes] of cases)
    assert.equal(validateImageSignature(bytes, mimeType), false, mimeType);
});

test('synthetic DOM requires test hash override while preserving fixed target identity', () => {
  const args = { domHtml, observation, selection };
  assert.throws(() => validateDomEvidence(args), /DOM_HASH_MISMATCH_EXPECTED/);
  const evidence = validateDomEvidence({
    ...args,
    testExpectedHash: fixtureHash,
  });
  assert.equal(evidence.articleId, TARGET_ARTICLE_ID);
  assert.equal(evidence.mpId, TARGET_MP_ID);
  assert.equal(evidence.domSha256, fixtureHash);
});

test('DOM validation rejects observation/selection/hash conflicts and access challenge', () => {
  const args = {
    domHtml,
    observation,
    selection,
    testExpectedHash: fixtureHash,
  };
  assert.throws(
    () =>
      validateDomEvidence({
        ...args,
        observation: { ...observation, id: 'WRONG' },
      }),
    /OBSERVATION_ARTICLE_ID_MISMATCH/,
  );
  assert.throws(
    () =>
      validateDomEvidence({
        ...args,
        selection: { candidate: { id: 'WRONG' } },
      }),
    /SELECTION_ARTICLE_ID_MISMATCH/,
  );
  assert.throws(
    () =>
      validateDomEvidence({
        ...args,
        observation: { ...observation, sha256: '0'.repeat(64) },
      }),
    /DOM_HASH_MISMATCH_OBSERVATION/,
  );
  const wrongDom = domHtml.replace('2247493594', '2247493595');
  const wrongHash = sha256(wrongDom);
  assert.throws(
    () =>
      validateDomEvidence({
        ...args,
        domHtml: wrongDom,
        observation: { ...observation, sha256: wrongHash },
        testExpectedHash: wrongHash,
      }),
    /IDENTITY_CONFLICT_WITH_TARGET/,
  );
  assert.throws(
    () =>
      validateDomEvidence({
        ...args,
        domHtml: '<title>安全验证</title><div id="js_content">请完成验证</div>',
      }),
    /ACCESS_CHALLENGE_DETECTED_IN_DOM/,
  );
});

test('test hash override is rejected outside Node test worker', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const code = `const script = require(${JSON.stringify(scriptFile)});
    try { script.validateDomEvidence(${JSON.stringify({ domHtml, observation, selection, testExpectedHash: fixtureHash })}); }
    catch (error) { console.log(error.message); }`;
  const result = spawnSync(process.execPath, ['-e', code], {
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), 'TEST_EVIDENCE_OVERRIDE_FORBIDDEN');
});

test('image extraction normalizes fragments and reports unsafe URLs without leakage', () => {
  const result = extractAllowedImageUrls(domHtml);
  assert.equal(result.totalOccurrences, 6);
  assert.equal(result.uniqueCount, 4);
  assert.equal(result.uniqueUrls[0], fixtureUrl);
  assert.equal(
    result.uniqueUrls.includes('https://mmbiz.qpic.cn/fallback-only'),
    false,
  );
  for (const url of result.uniqueUrls) {
    const parsed = new URL(url);
    assert.equal(parsed.hostname, ALLOWED_IMAGE_HOST);
    assert.equal(parsed.protocol, 'https:');
    assert.equal(parsed.hash, '');
  }
  for (const [url, code] of [
    ['http://mmbiz.qpic.cn/private?token=secret', 'UNALLOWED_PROTOCOL'],
    ['https://attacker.example/private?token=secret', 'UNALLOWED_HOST'],
    ['https://user:secret@mmbiz.qpic.cn/private', 'UNALLOWED_URL_COMPONENTS'],
    ['https://mmbiz.qpic.cn:8443/private', 'UNALLOWED_URL_COMPONENTS'],
    ['invalid-private-source', 'INVALID_IMAGE_URL_FORMAT'],
  ]) {
    assert.throws(
      () =>
        extractAllowedImageUrls(
          `<div id="js_content"><img src="${url}"></div>`,
        ),
      (error) => error.message === code,
    );
  }
});

test('raw image losses or changed sources fail before dry-run or one-shot execution', async () => {
  for (const droppedImage of [
    '<form><img src="https://mmbiz.qpic.cn/removed-by-form"></form>',
    `<img src="data:image/png;base64,${validPngBytes.toString('base64')}">`,
    '<img>',
  ]) {
    await withFixture(async (baseDir) => {
      const changedDom = domHtml.replace('</div>', `${droppedImage}</div>`);
      const changedHash = sha256(changedDom);
      fs.writeFileSync(
        path.join(baseDir, 'official-browser-dom.html'),
        changedDom,
      );
      fs.writeFileSync(
        path.join(baseDir, 'official-browser-observation.json'),
        JSON.stringify({ ...observation, sha256: changedHash }),
      );
      let requests = 0;
      for (const execute of [false, true]) {
        await assert.rejects(
          collectBrowserDomImages(
            fixtureOptions(baseDir, {
              testExpectedHash: changedHash,
              execute,
              fetchImage: async () => {
                requests++;
                return pngResponse();
              },
            }),
          ),
          (error) => error.message === 'RAW_IMAGE_EQUIVALENCE_FAILED',
        );
        assert.equal(requests, 0);
        assert.equal(fs.existsSync(path.join(baseDir, 'image-cache')), false);
      }
    });
  }
});

test('public error diagnostics discard URLs and uncontrolled messages', () => {
  assert.equal(
    publicErrorCode(new Error(`REDIRECT_STOPPED: ${fixtureUrl}`)),
    'REDIRECT_STOPPED',
  );
  assert.equal(
    publicErrorCode(new Error(`Unexpected token at ${fixtureUrl}`)),
    'COLLECTOR_IO_OR_CONFIGURATION_ERROR',
  );
});

test('default fetch rejects unsafe URL before HTTP with a safe code', async () => {
  await assert.rejects(
    defaultFetchImage('https://user:secret@mmbiz.qpic.cn/private'),
    (error) => error.message === 'UNALLOWED_URL_COMPONENTS',
  );
});

test('dry-run exposes counts and URL hashes with no requests or output files', async () => {
  await withFixture(async (baseDir) => {
    let requests = 0;
    const result = await collectBrowserDomImages(
      fixtureOptions(baseDir, {
        fetchImage: async () => {
          requests++;
          return pngResponse();
        },
      }),
    );
    assert.equal(result.dryRun, true);
    assert.equal(result.offline, true);
    assert.equal(result.totalOccurrences, 6);
    assert.equal(result.uniqueCount, 4);
    assert.equal(result.oneShotMarkerCreated, false);
    assert.equal(requests, 0);
    assert.equal(fs.existsSync(path.join(baseDir, 'image-cache')), false);
    assert.equal(result.imageUrlSha256[0], sha256(fixtureUrl));
    assert.equal(JSON.stringify(result).includes(fixtureUrl), false);
    assert.equal(JSON.stringify(result).includes('synthetic-only'), false);
  });
});

test('test execution requires injected offline fetcher', async () => {
  await withFixture(async (baseDir) => {
    await assert.rejects(
      collectBrowserDomImages(fixtureOptions(baseDir, { execute: true })),
      /TEST_EXECUTION_REQUIRES_OFFLINE_FETCH/,
    );
    assert.equal(fs.existsSync(path.join(baseDir, 'image-cache')), false);
  });
});

test('collection paces requests, preserves duplicate occurrences and writes private manifest', async () => {
  await withFixture(async (baseDir) => {
    const sleepCalls = [];
    const requestedUrls = [];
    const options = fixtureOptions(baseDir, {
      execute: true,
      sleep: async (ms) => sleepCalls.push(ms),
      fetchImage: async (url) => {
        requestedUrls.push(url);
        return pngResponse();
      },
    });
    const result = await collectBrowserDomImages(options);
    assert.equal(result.success, true);
    assert.equal(requestedUrls.length, 4);
    assert.deepEqual(sleepCalls, [1000, 1000, 1000]);
    assert.deepEqual(
      fs.readFileSync(path.join(result.imagesDir, `${validPngSha}.png`)),
      validPngBytes,
    );
    const manifest = JSON.parse(fs.readFileSync(result.manifestFile, 'utf8'));
    assert.equal(manifest.images.length, 4);
    assert.equal(manifest.occurrences.length, 6);
    assert.equal(manifest.images[0].url, fixtureUrl);
    assert.equal(
      manifest.occurrences[0].sha256,
      manifest.occurrences[2].sha256,
    );
    const { manifestSha256, ...withoutHash } = manifest;
    assert.equal(manifestSha256, sha256(JSON.stringify(withoutHash)));
    const marker = JSON.parse(fs.readFileSync(result.markerFile, 'utf8'));
    assert.equal(marker.status, 'completed');
    assert.equal(marker.domSha256, fixtureHash);
    assert.equal(marker.manifestSha256, manifestSha256);
    requestedUrls.length = 0;
    await assert.rejects(
      collectBrowserDomImages(options),
      /ONE_SHOT_ALREADY_RECORDED/,
    );
    assert.equal(requestedUrls.length, 0);
  });
});

test('first failure stops permanently without URLs in thrown errors or retries', async () => {
  await withFixture(async (baseDir) => {
    let requests = 0;
    const options = fixtureOptions(baseDir, {
      execute: true,
      paceMs: 0,
      fetchImage: async (url) => {
        if (++requests === 3)
          throw new Error(`REDIRECT_STOPPED: HTTP 302 ${url}`);
        return pngResponse();
      },
    });
    await assert.rejects(
      collectBrowserDomImages(options),
      (error) =>
        error.message === 'COLLECTION_PERMANENTLY_STOPPED: REDIRECT_STOPPED',
    );
    assert.equal(requests, 3);
    const marker = JSON.parse(
      fs.readFileSync(
        path.join(baseDir, 'image-cache/image-collector-marker.json'),
        'utf8',
      ),
    );
    assert.equal(marker.status, 'stopped');
    assert.equal(marker.stopReason, 'REDIRECT_STOPPED');
    assert.equal(marker.completedCount, 2);
    assert.equal(marker.failedUrl, 'https://mmbiz.qpic.cn/synthetic-c');
    await assert.rejects(
      collectBrowserDomImages(options),
      /ONE_SHOT_ALREADY_RECORDED/,
    );
    assert.equal(requests, 3);
  });
});

test('invalid injected image bytes stop before persistence', async () => {
  await withFixture(async (baseDir) => {
    await assert.rejects(
      collectBrowserDomImages(
        fixtureOptions(baseDir, {
          execute: true,
          fetchImage: async () => ({
            ...pngResponse(),
            bytes: validPngBytes.subarray(0, -12),
          }),
        }),
      ),
      /COLLECTION_PERMANENTLY_STOPPED/,
    );
    const marker = JSON.parse(
      fs.readFileSync(
        path.join(baseDir, 'image-cache/image-collector-marker.json'),
        'utf8',
      ),
    );
    assert.equal(marker.stopReason, 'INVALID_IMAGE_RESULT');
    assert.deepEqual(
      fs.readdirSync(path.join(baseDir, 'image-cache/images')),
      [],
    );
  });
});

test('existing corrupt hash-named image is preserved and prevents success', async () => {
  await withFixture(async (baseDir) => {
    const imagesDir = path.join(baseDir, 'image-cache/images');
    fs.mkdirSync(imagesDir, { recursive: true });
    const file = path.join(imagesDir, `${validPngSha}.png`);
    fs.writeFileSync(file, 'corrupt image');
    const options = fixtureOptions(baseDir, {
      execute: true,
      fetchImage: async () => pngResponse(),
    });
    await assert.rejects(
      collectBrowserDomImages(options),
      /IMAGE_CACHE_CONFLICT/,
    );
    assert.equal(fs.readFileSync(file, 'utf8'), 'corrupt image');
    await assert.rejects(
      collectBrowserDomImages(options),
      /ONE_SHOT_ALREADY_RECORDED/,
    );
  });
});

test('live CLI keeps fixed hash/identity and rejects test override flags', async () => {
  await withFixture(async (baseDir) => {
    const result = runCli(['--base-dir', baseDir, '--execute']);
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stderr), {
      success: false,
      error: 'DOM_HASH_MISMATCH_EXPECTED',
    });
    assert.equal(fs.existsSync(path.join(baseDir, 'image-cache')), false);
    const override = runCli([
      '--base-dir',
      baseDir,
      '--test-expected-hash',
      fixtureHash,
    ]);
    assert.equal(override.status, 1);
    assert.equal(JSON.parse(override.stderr).error, 'CLI_ARGUMENTS_INVALID');
  });
});

test('CLI JSON errors are sanitized when source text contains a private URL', async () => {
  await withFixture(async (baseDir) => {
    fs.writeFileSync(
      path.join(baseDir, 'official-browser-observation.json'),
      `{ broken: "${fixtureUrl}" }`,
    );
    const result = runCli(['--base-dir', baseDir]);
    assert.equal(result.status, 1);
    assert.equal(
      JSON.parse(result.stderr).error,
      'COLLECTOR_IO_OR_CONFIGURATION_ERROR',
    );
    assert.equal(result.stderr.includes('mmbiz.qpic.cn'), false);
    assert.equal(result.stderr.includes('synthetic-only'), false);
  });
});

test(
  'optional private acceptance: fixed real DOM hash, identity and 39/36 image counts',
  {
    skip: process.env.WEWE_RUN_PRIVATE_IMAGE_ACCEPTANCE !== '1',
  },
  async () => {
    const baseDir = path.join(
      ROOT,
      'private-data/single-account-update-20260930',
    );
    const html = fs.readFileSync(
      path.join(baseDir, 'official-browser-dom.html'),
      'utf8',
    );
    const observation = JSON.parse(
      fs.readFileSync(
        path.join(baseDir, 'official-browser-observation.json'),
        'utf8',
      ),
    );
    const selection = JSON.parse(
      fs.readFileSync(
        path.join(baseDir, 'official-original-selection.json'),
        'utf8',
      ),
    );
    const evidence = validateDomEvidence({
      domHtml: html,
      observation,
      selection,
    });
    const images = extractAllowedImageUrls(html);
    assert.equal(evidence.domSha256, EXPECTED_DOM_SHA256);
    assert.equal(evidence.articleId, TARGET_ARTICLE_ID);
    assert.equal(evidence.mpId, TARGET_MP_ID);
    assert.equal(images.totalOccurrences, 39);
    assert.equal(images.uniqueCount, 36);
  },
);
