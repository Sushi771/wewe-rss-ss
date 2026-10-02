'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  TARGET_BOOK_ID,
  ENDPOINT_URL,
  assertSafePath,
  buildHeaders,
  runPreflight,
  runStoryfeedDiscovery,
} = require('./discovery-eink-storyfeed.cjs');

function makeTempFixtureDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'storyfeed-test-'));
}

function removeTempFixture(dir) {
  const resolved = fs.realpathSync(dir);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('storyfeed-test-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}

function writeValidFixtureFiles(fixtureDir) {
  const sessionPath = path.join(fixtureDir, 'mobile-session.json');
  const loginResultPath = path.join(fixtureDir, 'result.json');
  const markerPath = path.join(fixtureDir, 'storyfeed-attempt.json');
  const outputDir = path.join(fixtureDir, 'storyfeed-output');
  const cacheDir = path.join(fixtureDir, 'mock-cache');

  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });

  fs.writeFileSync(
    sessionPath,
    JSON.stringify(
      {
        source: 'owner-confirmed-eink-sdk-login',
        formatVersion: 1,
        accountId: '1001',
        mobile: {
          vid: '1001',
          accessToken: 'token-xyz-secret',
        },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  fs.writeFileSync(
    loginResultPath,
    JSON.stringify(
      {
        success: true,
        status: 'ok',
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  return { sessionPath, loginResultPath, markerPath, outputDir, cacheDir };
}

function makeMockProfile() {
  return {
    authHeaders: (mobile) => ({
      'we-vid': String(mobile.vid),
      'we-token': String(mobile.accessToken),
    }),
    versionHeaders: {
      'v-app': 'eink-1.0',
    },
  };
}

test('Test 1: exact query URL structure and header propagation without unsolicited extras', () => {
  const parsedUrl = new URL(ENDPOINT_URL);
  assert.equal(parsedUrl.origin, 'https://i.weread.qq.com');
  assert.equal(parsedUrl.pathname, '/storyfeed/getCardArticles');
  assert.equal(parsedUrl.searchParams.get('channel'), '901301');
  assert.equal(parsedUrl.searchParams.get('type'), '0');
  assert.equal(parsedUrl.searchParams.get('count'), '50');
  assert.equal(parsedUrl.searchParams.has('kkOffset'), false);
  assert.equal(parsedUrl.searchParams.has('kkSearchId'), false);
  assert.equal(parsedUrl.searchParams.has('bookId'), false);

  const mockProfile = makeMockProfile();
  const headers = buildHeaders(mockProfile, {
    vid: '1001',
    accessToken: 'tokenXYZ',
  });

  assert.equal(headers['we-vid'], '1001');
  assert.equal(headers['we-token'], 'tokenXYZ');
  assert.equal(headers['v-app'], 'eink-1.0');
  assert.equal(headers['Accept'], undefined);
  assert.equal(Object.keys(headers).length, 3);
});

test('Test 2: FULL fake-fetch success with target filtering, deduplication max 5, and untrusted createTime', async (t) => {
  const fixtureDir = makeTempFixtureDir();
  t.after(() => {
    removeTempFixture(fixtureDir);
  });

  const { sessionPath, loginResultPath, markerPath, outputDir, cacheDir } =
    writeValidFixtureFiles(fixtureDir);

  const articles = [
    {
      bookId: TARGET_BOOK_ID,
      reviewId: 'rev_1',
      title: 'Article 1',
      createTime: 1727800000,
    },
    {
      bookId: TARGET_BOOK_ID,
      reviewId: 'rev_1',
      title: 'Article 1 Duplicate',
      createTime: 1727800010,
    },
    {
      bookId: TARGET_BOOK_ID,
      reviewId: 'rev_2',
      title: 'Article 2',
      createTime: 1727800020,
    },
    {
      bookId: 'OTHER_BOOK',
      reviewId: 'rev_x',
      title: 'Other Book Article',
      createTime: 1727800030,
    },
    {
      bookId: TARGET_BOOK_ID,
      reviewId: 'rev_3',
      title: 'Article 3',
      createTime: null,
    },
    {
      bookId: TARGET_BOOK_ID,
      reviewId: 'rev_4',
      title: 'Article 4',
      createTime: 1727800040,
    },
    {
      bookId: TARGET_BOOK_ID,
      reviewId: 'rev_5',
      title: 'Article 5',
      createTime: 1727800050,
    },
    {
      bookId: TARGET_BOOK_ID,
      reviewId: 'rev_6',
      title: 'Article 6 Extra',
      createTime: 1727800060,
    },
  ];

  let fetchCalls = 0;
  const fakeFetch = async (url, init) => {
    fetchCalls++;
    assert.equal(url, ENDPOINT_URL);
    assert.equal(init.headers['we-token'], 'token-xyz-secret');
    return new Response(
      JSON.stringify({
        errCode: 0,
        articles,
        hasMore: true,
        kkOffset: 50,
        kkSearchId: 'mock-search-id',
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  };

  const result = await runStoryfeedDiscovery({
    rootDir: fixtureDir,
    profile: makeMockProfile(),
    fetchFn: fakeFetch,
    paths: {
      session: sessionPath,
      loginResult: loginResultPath,
      marker: markerPath,
      outputDir,
      cache: cacheDir,
    },
  });

  assert.equal(fetchCalls, 1);
  assert.equal(result.status, 'success');
  assert.equal(result.requestCount, 1);
  assert.equal(result.targetCount, 6);
  assert.equal(result.targetArticles.length, 5);
  assert.deepEqual(
    result.targetArticles.map((a) => a.reviewId),
    ['rev_1', 'rev_2', 'rev_3', 'rev_4', 'rev_5'],
  );
  assert.equal(result.targetArticles[0].createTimePresence, true);
  assert.equal(result.targetArticles[2].createTimePresence, false);
  assert.equal(result.publicationVerified, false);
  assert.equal(result.bodyVerified, false);
  assert.equal(result.subscriptionRecovered, false);
  assert.equal(result.productionWrites, 0);

  const rawSaved = fs.readFileSync(path.join(outputDir, 'raw-response.bin'));
  assert.ok(rawSaved.length > 0);
  const summarySaved = JSON.parse(
    fs.readFileSync(path.join(outputDir, 'summary.json'), 'utf8'),
  );
  assert.equal(summarySaved.status, 'success');
  assert.equal(summarySaved.targetCount, 6);
  assert.equal(summarySaved.targetArticles.length, 5);
});

test('Test 3: FULL fake fetch loops subcases errCode -2012, -2041, HTTP 429, and bodylimit overflow stops with preserved marker and exactly 1 call', async () => {
  const subcases = [
    {
      name: 'errCode -2012 auth stop',
      responseFactory: () =>
        new Response(
          JSON.stringify({ errCode: -2012, errMsg: 'auth expired' }),
          { status: 200 },
        ),
      expectedStatus: 'auth_stop',
      expectedReason: 'ERRCODE_-2012',
    },
    {
      name: 'errCode -2041 challenge stop',
      responseFactory: () =>
        new Response(
          JSON.stringify({ errCode: -2041, errMsg: 'frequency limit hit' }),
          { status: 200 },
        ),
      expectedStatus: 'limit_stop',
      expectedReason: 'ERRCODE_-2041',
    },
    {
      name: 'HTTP 429 rate limit stop',
      responseFactory: () => new Response('Too Many Requests', { status: 429 }),
      expectedStatus: 'limit_stop',
      expectedReason: 'HTTP_429',
    },
    {
      name: 'bodylimit stream overflow stop',
      responseFactory: () => {
        let chunkSent = false;
        const stream = new ReadableStream({
          pull(controller) {
            if (!chunkSent) {
              chunkSent = true;
              controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1024));
            } else {
              controller.close();
            }
          },
        });
        return new Response(stream, { status: 200 });
      },
      expectedStatus: 'response_limit_stop',
      expectedReason: 'RESPONSE_LIMIT_EXCEEDED',
    },
  ];

  for (const sc of subcases) {
    const fixtureDir = makeTempFixtureDir();
    try {
      const { sessionPath, loginResultPath, markerPath, outputDir, cacheDir } =
        writeValidFixtureFiles(fixtureDir);

      let fetchCount = 0;
      const fakeFetch = async () => {
        fetchCount++;
        return sc.responseFactory();
      };

      const result = await runStoryfeedDiscovery({
        rootDir: fixtureDir,
        profile: makeMockProfile(),
        fetchFn: fakeFetch,
        paths: {
          session: sessionPath,
          loginResult: loginResultPath,
          marker: markerPath,
          outputDir,
          cache: cacheDir,
        },
      });

      assert.equal(
        fetchCount,
        1,
        `${sc.name} made unexpected number of requests`,
      );
      assert.equal(result.requestCount, 1, `${sc.name} requestCount mismatch`);
      assert.equal(
        result.status,
        sc.expectedStatus,
        `${sc.name} status mismatch`,
      );
      assert.equal(
        result.reason,
        sc.expectedReason,
        `${sc.name} reason mismatch`,
      );
      assert.equal(result.publicationVerified, false);
      assert.equal(result.bodyVerified, false);
      assert.equal(result.subscriptionRecovered, false);
      assert.equal(result.productionWrites, 0);

      assert.equal(
        fs.existsSync(markerPath),
        true,
        `${sc.name} failed to preserve attempt marker`,
      );
      assert.equal(
        fs.existsSync(path.join(outputDir, 'summary.json')),
        true,
        `${sc.name} failed to write summary.json`,
      );
    } finally {
      removeTempFixture(fixtureDir);
    }
  }
});

test('Test 4: marker existing stops with 0 network calls, preflight executes 0 writes with validated profile, and symlink escapes are rejected', async (t) => {
  const fixtureDir = makeTempFixtureDir();
  t.after(() => {
    removeTempFixture(fixtureDir);
  });

  const { sessionPath, loginResultPath, markerPath, outputDir, cacheDir } =
    writeValidFixtureFiles(fixtureDir);

  // Subtest 4A: Preflight passes with profile validation and writes 0 files
  const preflightRes = await runPreflight({
    rootDir: fixtureDir,
    profile: makeMockProfile(),
    paths: {
      session: sessionPath,
      loginResult: loginResultPath,
      marker: markerPath,
      outputDir,
      cache: cacheDir,
    },
  });

  assert.equal(preflightRes.status, 'preflight_ok');
  assert.equal(preflightRes.markerAbsent, true);
  assert.equal(preflightRes.credentialValid, true);
  assert.equal(preflightRes.outputDirAvailable, true);
  assert.equal(preflightRes.profileValid, true);
  assert.equal(fs.existsSync(markerPath), false);
  assert.equal(fs.existsSync(outputDir), false);

  // Subtest 4B: Existing marker immediately halts discovery with zero network requests
  fs.writeFileSync(
    markerPath,
    JSON.stringify({ attemptedAt: '2026-10-02T00:00:00Z', pid: 1234 }),
    { mode: 0o600 },
  );

  let networkCalls = 0;
  const noCallFetch = async () => {
    networkCalls++;
    return new Response('{}');
  };

  const discoveryRes = await runStoryfeedDiscovery({
    rootDir: fixtureDir,
    profile: makeMockProfile(),
    fetchFn: noCallFetch,
    paths: {
      session: sessionPath,
      loginResult: loginResultPath,
      marker: markerPath,
      outputDir,
      cache: cacheDir,
    },
  });

  assert.equal(networkCalls, 0);
  assert.equal(discoveryRes.status, 'marker_exists_stop');
  assert.equal(discoveryRes.reason, 'MARKER_EXISTS');
  assert.equal(discoveryRes.requestCount, 0);
  assert.equal(discoveryRes.productionWrites, 0);
  assert.equal(fs.existsSync(outputDir), false);

  // Subtest 4C: Path escapes and symlink boundary crossing are rejected
  const outsideDir = makeTempFixtureDir();
  t.after(() => {
    removeTempFixture(outsideDir);
  });

  assert.throws(() => {
    assertSafePath(path.join(fixtureDir, '../../outside.json'), fixtureDir);
  }, /Path escapes boundary/);

  const symlinkEscaped = path.join(fixtureDir, 'symlink-escape');
  try {
    fs.symlinkSync(outsideDir, symlinkEscaped, 'junction');
    assert.throws(() => {
      assertSafePath(path.join(symlinkEscaped, 'secret.json'), fixtureDir);
    }, /Path escapes boundary/);
  } catch (err) {
    if (err.code !== 'EPERM') {
      throw err;
    }
  }
});
