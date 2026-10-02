'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  TAGS_URL,
  FEED_ENDPOINT,
  MAX_BYTES,
  deriveFeedParameters,
  parseTags,
  parseFeed,
  runPreflight,
  runStage,
} = require('./probe-subscribed-mp-once.cjs');

function fixture(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subscribed-mp-test-'));
  t.after(() => {
    const real = fs.realpathSync(rootDir);
    assert.equal(path.dirname(real), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(real).startsWith('subscribed-mp-test-'));
    fs.rmSync(real, { recursive: true, force: true });
  });
  const paths = Object.fromEntries(
    Object.keys(require('./probe-subscribed-mp-once.cjs').PATHS).map((key) => [
      key,
      path.join(rootDir, key),
    ]),
  );
  fs.writeFileSync(
    paths.session,
    JSON.stringify({
      source: 'owner-confirmed-eink-sdk-login',
      formatVersion: 1,
      accountId: '1001',
      mobile: { vid: 1001, accessToken: 'test-private-token' },
    }),
  );
  fs.writeFileSync(
    paths.loginResult,
    JSON.stringify({ success: true, productionUnchanged: true }),
  );
  fs.mkdirSync(paths.cache);
  return {
    rootDir,
    paths,
    approvedOnline: true,
    profile: {
      authHeaders: (mobile) => ({
        'we-vid': String(mobile.vid),
        'we-access-token': mobile.accessToken,
      }),
      versionHeaders: { 'User-Agent': 'offline-test-profile' },
    },
  };
}
const schema = (nested) => `weread://webView?url=${encodeURIComponent(nested)}`;
const tags = (
  nested = 'https://reader.example.test/page?id=server+id&type=2&channel=901399',
) => ({
  items: [
    { id: 5, tag: 'other' },
    { id: 103, tag: '微信订阅', schema: schema(nested) },
  ],
});
const response = (body, status = 200) =>
  new Response(JSON.stringify(body), { status });

test('schema follows one Uri.decode, raw nested query, last duplicate key, and official defaults', () => {
  assert.deepEqual(
    deriveFeedParameters(
      schema('https://reader.test/p?id=a+b&type=1&type=2&channel=103'),
    ),
    { id: 'a+b', type: 2, channel: 103, count: 20 },
  );
  assert.deepEqual(
    deriveFeedParameters(schema('https://reader.test/p?id=a%2Bb')),
    { id: 'a%2Bb', type: 0, channel: 901301, count: 20 },
  );
  assert.deepEqual(deriveFeedParameters('weread://webView?url='), {
    id: '0',
    type: 0,
    channel: 901301,
    count: 20,
  });
  assert.throws(
    () => deriveFeedParameters('https://untrusted.test/?id=manual'),
    /invalid_tag_schema/,
  );
  assert.throws(
    () => deriveFeedParameters(schema('https://reader.test/?type=%31')),
    /invalid_schema_integer/,
  );
  assert.equal(parseTags({ items: [] }).tag103, null);
});

test('preflight is zero-network and creates no stage markers or output', async (t) => {
  const options = fixture(t);
  const result = await runPreflight(options);
  assert.equal(result.requests, 0);
  assert.equal(result.tagsReady, true);
  assert.equal(result.feedReady, false);
  for (const name of ['tagsMarker', 'feedMarker', 'tagsOutput', 'feedOutput']) {
    assert.equal(fs.existsSync(options.paths[name]), false);
  }
});

test('missing tag103 prevents feed and preserves a single tags attempt', async (t) => {
  const options = fixture(t);
  let requests = 0;
  options.fetchFn = async (url) => {
    requests++;
    assert.equal(url, TAGS_URL);
    return response({ items: [] });
  };
  const found = await runStage('tags', options);
  assert.equal(found.status, 'tags_missing_stop');
  const stopped = await runStage('feed', options);
  assert.equal(stopped.requests, 0);
  assert.equal(requests, 1);
  assert.equal(fs.existsSync(options.paths.feedMarker), false);
});

test('explicit stages derive only saved tag103 params, target at most five, and never follow schema host', async (t) => {
  const options = fixture(t);
  let requests = 0;
  options.fetchFn = async (url, init) => {
    requests++;
    assert.equal(init.redirect, 'error');
    assert.equal(init.method, 'GET');
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(
      fs.existsSync(
        requests === 1 ? options.paths.tagsMarker : options.paths.feedMarker,
      ),
      true,
    );
    if (requests === 1) {
      assert.equal(url, TAGS_URL);
      return response(tags());
    }
    const parsed = new URL(url);
    assert.equal(parsed.origin + parsed.pathname, FEED_ENDPOINT);
    assert.deepEqual(Object.fromEntries(parsed.searchParams), {
      id: 'server+id',
      type: '2',
      channel: '901399',
      count: '20',
    });
    return response({
      articles: Array.from({ length: 7 }, (_, i) => ({
        author: 'example',
        pic_url: '',
        reviewId: `MP_WXS_3895431412_${i}`,
        title: `candidate ${i}`,
      })),
      hasMore: true,
      kkOffset: 7,
      kkSearchId: 'server-cursor',
    });
  };
  const tagResult = await runStage('tags', options);
  assert.equal(tagResult.status, 'success');
  assert.equal(JSON.stringify(tagResult).includes('server+id'), false);
  const feedResult = await runStage('feed', options);
  assert.equal(feedResult.status, 'success');
  assert.equal(feedResult.targetPrefixCandidateCount, 7);
  assert.equal(feedResult.first5.length, 5);
  assert.equal(feedResult.publicationVerified, false);
  assert.equal(feedResult.bodyVerified, false);
  assert.equal(feedResult.subscriptionRecovered, false);
  assert.equal(feedResult.productionWrites, 0);
  assert.equal(
    fs.existsSync(path.join(options.paths.feedOutput, 'request-params.json')),
    true,
  );
  assert.equal((await runStage('tags', options)).requests, 0);
  assert.equal((await runStage('feed', options)).requests, 0);
  assert.equal(requests, 2);
});

test('authentication, challenge, rate limit and invalid JSON each stop after one request', async (t) => {
  const cases = [
    [401, { errCode: -2012 }, 'auth_stop'],
    [403, {}, 'auth_stop'],
    [429, {}, 'limit_stop'],
    [200, { errCode: -2041 }, 'limit_stop'],
    [200, { message: '请完成验证' }, 'limit_stop'],
    [200, { items: 'invalid' }, 'shape_stop'],
  ];
  for (const [status, body, expected] of cases) {
    const options = fixture(t);
    let requests = 0;
    options.fetchFn = async () => {
      requests++;
      return response(body, status);
    };
    const result = await runStage('tags', options);
    assert.equal(result.status, expected);
    assert.equal(result.requests, 1);
    assert.equal((await runStage('tags', options)).requests, 0);
    assert.equal(requests, 1);
    assert.equal(
      fs.existsSync(path.join(options.paths.tagsOutput, 'raw-response.bin')),
      true,
    );
  }
});

test('saved raw tampering or different session cannot authorize feed', async (t) => {
  const options = fixture(t);
  options.fetchFn = async () => response(tags());
  await runStage('tags', options);
  const original = fs.readFileSync(
    path.join(options.paths.tagsOutput, 'raw-response.bin'),
  );
  fs.writeFileSync(
    path.join(options.paths.tagsOutput, 'raw-response.bin'),
    JSON.stringify(tags('https://other.test/?id=manual')),
  );
  let requests = 0;
  options.fetchFn = async () => {
    requests++;
    throw Error('forbidden');
  };
  assert.equal((await runStage('feed', options)).requests, 0);
  fs.writeFileSync(
    path.join(options.paths.tagsOutput, 'raw-response.bin'),
    original,
  );
  const changedSession = JSON.parse(
    fs.readFileSync(options.paths.session, 'utf8'),
  );
  changedSession.mobile.accessToken = 'different-private-token';
  fs.writeFileSync(options.paths.session, JSON.stringify(changedSession));
  assert.equal((await runStage('feed', options)).requests, 0);
  assert.equal(requests, 0);
  assert.equal(fs.existsSync(options.paths.feedMarker), false);
});

test('2MiB body bound and transport failure retain one attempt without retries', async (t) => {
  for (const oversized of [true, false]) {
    const options = fixture(t);
    let requests = 0;
    options.fetchFn = async () => {
      requests++;
      if (!oversized) throw Error('private transport detail must not escape');
      return new Response(Buffer.alloc(MAX_BYTES + 1));
    };
    const result = await runStage('tags', options);
    assert.equal(
      result.status,
      oversized ? 'response_limit_stop' : 'transport_stop',
    );
    assert.equal(result.responseBodyComplete, false);
    assert.equal(result.requests, 1);
    assert.equal((await runStage('tags', options)).requests, 0);
    assert.equal(requests, 1);
    assert.equal(
      JSON.stringify(result).includes('private transport detail'),
      false,
    );
  }
});

test('prefix candidate deduplication never supplies bookId, source URL or publication time', () => {
  const article = {
    reviewId: 'MP_WXS_3895431412_sample',
    title: ' candidate ',
    author: 'owner',
    pic_url: '',
  };
  const result = parseFeed({
    articles: [article, article, { ...article, reviewId: 'MP_WXS_999_sample' }],
    hasMore: false,
  });
  assert.equal(result.total, 3);
  assert.equal(result.targetPrefixCandidateCount, 1);
  assert.deepEqual(result.first5, [
    { reviewId: article.reviewId, title: 'candidate' },
  ]);
  assert.throws(
    () => parseFeed({ articles: [null], hasMore: false }),
    /invalid_candidate_shape/,
  );
});

test('saved numeric hasMore wire values normalize only exact 0 and 1', () => {
  assert.equal(parseFeed({ articles: [], hasMore: 0 }).hasMore, false);
  assert.equal(parseFeed({ articles: [], hasMore: 1 }).hasMore, true);
  assert.throws(
    () => parseFeed({ articles: [], hasMore: 2 }),
    /invalid_feed_shape/,
  );
  assert.throws(
    () => parseFeed({ articles: [], hasMore: '0' }),
    /invalid_feed_shape/,
  );
});
