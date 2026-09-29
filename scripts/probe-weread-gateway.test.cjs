const assert = require('node:assert/strict');
const test = require('node:test');
const { run, parsePrivateKey } = require('./probe-weread-gateway.cjs');

const key = 'wrk-test-only';
const json = (value) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

test('no key sends zero requests', async () => {
  let requests = 0;
  const lines = [];
  const code = await run({
    mode: 'chapters',
    env: {},
    loadPrivateKey: async () => null,
    fetchImpl: async () => {
      requests++;
      throw new Error('must not run');
    },
    log: (line) => lines.push(JSON.parse(line)),
  });
  assert.equal(code, 2);
  assert.equal(requests, 0);
  assert.equal(lines[0].kind, 'skipped');
});

test('an empty private key file sends zero requests', async () => {
  assert.equal(parsePrivateKey('WEREAD_API_KEY=\n'), null);
  let requests = 0;
  const code = await run({
    mode: 'chapters',
    env: {},
    loadPrivateKey: async () => parsePrivateKey('WEREAD_API_KEY=\n'),
    fetchImpl: async () => {
      requests++;
      throw new Error('must not run');
    },
    log: () => {},
  });
  assert.equal(code, 2);
  assert.equal(requests, 0);
});

test('a business error stops after the first request without exposing its message', async () => {
  let requests = 0;
  const lines = [];
  const code = await run({
    mode: 'chapters',
    env: { WEREAD_API_KEY: key },
    fetchImpl: async () => {
      requests++;
      return json({ errcode: -2041, errmsg: 'private-gateway-detail' });
    },
    log: (line) => lines.push(line),
  });
  assert.equal(code, 1);
  assert.equal(requests, 1);
  assert.match(lines[0], /business-error/);
  assert.equal(JSON.parse(lines[0]).errorCode, -2041);
  assert.doesNotMatch(lines.join(''), /private-gateway-detail|wrk-test-only/);
});

test('five distinct ordinary chapters stop before the book identity request', async () => {
  const calls = [];
  const lines = [];
  const chapters = Array.from({ length: 5 }, (_, index) => ({
    chapterUid: index + 100,
    title: `普通章节 ${index + 1}`,
    isMPChapter: 0,
  }));
  const code = await run({
    mode: 'chapters',
    env: { WEREAD_API_KEY: key },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body.api_name);
      return json({ bookId: body.bookId, chapters });
    },
    log: (line) => lines.push(JSON.parse(line)),
  });
  assert.equal(code, 1);
  assert.deepEqual(calls, ['/book/chapterinfo']);
  assert.equal(lines[0].distinctTitledUidCount, 5);
  assert.equal(lines[0].isMPChapterOneCount, 0);
  assert.match(lines[1].reason, /fewer-than-five-distinct-mp-chapters/);
});

test('five distinct chapter candidates permit only one book identity request', async () => {
  const calls = [];
  const lines = [];
  const chapters = Array.from({ length: 5 }, (_, index) => ({
    chapterUid: index + 100,
    title: `标题 ${index + 1}`,
    updateTime: 1780000000,
    isMPChapter: 1,
  }));
  const code = await run({
    mode: 'chapters',
    env: { WEREAD_API_KEY: key },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body.api_name);
      assert.equal(body.bookId, 'MP_WXS_3895431412');
      assert.equal(body.skill_version, '1.0.4');
      assert.equal(options.redirect, 'manual');
      return body.api_name === '/book/chapterinfo'
        ? json({ bookId: body.bookId, chapters })
        : json({ bookId: body.bookId, title: '妈妈部落畅聊阁' });
    },
    log: (line) => lines.push(JSON.parse(line)),
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, ['/book/chapterinfo', '/book/info']);
  assert.equal(lines[0].distinctTitledUidCount, 5);
  assert.equal(lines[0].chapters[0].updateTime, '2026-05-28');
  assert.equal(lines[1].articlePublicationTimesVerified, false);
  assert.doesNotMatch(JSON.stringify(lines), /wrk-test-only|"chapterUid":100/);
});

test('chapter and book identity labels redact embedded URLs and token-shaped text', async () => {
  const lines = [];
  const chapters = Array.from({ length: 5 }, (_, index) => ({
    chapterUid: index + 100,
    title:
      index === 0
        ? '标题 wrk-hidden-secret https://private.example/?key=secret'
        : `标题 ${index}`,
    isMPChapter: 1,
  }));
  const code = await run({
    mode: 'chapters',
    env: { WEREAD_API_KEY: key },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      return body.api_name === '/book/chapterinfo'
        ? json({ bookId: body.bookId, chapters })
        : json({
            bookId: body.bookId,
            title: '妈妈部落畅聊阁',
            author: '作者 wrk-hidden-secret',
            category: '分类 https://private.example/?key=secret',
            publisher: '出版者 wrk-hidden-secret',
          });
    },
    log: (line) => lines.push(JSON.parse(line)),
  });
  assert.equal(code, 0);
  assert.equal(lines[0].chapters[0].title.includes('[redacted-token]'), true);
  assert.equal(lines[1].author.includes('[redacted-token]'), true);
  assert.doesNotMatch(
    JSON.stringify(lines),
    /private\.example|key=secret|wrk-hidden-secret/,
  );
});

test('search mode sends one scoped request and prints bounded, cautious evidence', async () => {
  const calls = [];
  const lines = [];
  const books = Array.from({ length: 23 }, (_, index) => ({
    bookInfo: {
      bookId: `MP_TEST_${index}`,
      title:
        index === 0
          ? '文章 https://private.example/path?key=secret'
          : `文章 ${index}`,
      author: index === 0 ? '妈妈部落畅聊阁 wrk-hidden' : '妈妈部落畅聊阁',
      publisher: '公众号线索',
      publishTime: 1780000000,
      updateTime: 1780100000,
    },
  }));
  const code = await run({
    mode: 'search',
    env: { WEREAD_API_KEY: key },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return json({
        hasMore: 1,
        results: [
          {
            title: '文章',
            scope: 4,
            scopeCount: 200,
            currentCount: 23,
            books,
          },
        ],
      });
    },
    log: (line) => lines.push(JSON.parse(line)),
  });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://i.weread.qq.com/api/agent/gateway');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.redirect, 'manual');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    api_name: '/store/search',
    keyword: '妈妈部落畅聊阁',
    scope: 4,
    skill_version: '1.0.4',
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].groupCount, 1);
  assert.equal(lines[0].returnedItemCount, 23);
  assert.equal(lines[0].hasMore, true);
  assert.equal(lines[0].printedCount, 20);
  assert.equal(lines[0].groups[0].reportedScopeCount, 200);
  assert.equal(lines[0].subscriptionVerified, false);
  assert.match(lines[0].identityMeaning, /not verified account identity/);
  assert.match(lines[0].timeMeaning, /do not verify article publication time/);
  assert.equal(
    lines[0].results[0].timeFieldEvidence[0].calendarDate,
    '2026-05-28',
  );
  assert.match(lines[0].results[0].bookIdSha256_16, /^[a-f0-9]{16}$/);
  assert.doesNotMatch(
    JSON.stringify(lines),
    /private\.example|key=secret|wrk-hidden|MP_TEST_/,
  );
});

test('search mode accepts a zero-result page without calling another endpoint', async () => {
  let requests = 0;
  const lines = [];
  const code = await run({
    mode: 'search',
    env: { WEREAD_API_KEY: key },
    fetchImpl: async () => {
      requests++;
      return json({ hasMore: 0, results: [] });
    },
    log: (line) => lines.push(JSON.parse(line)),
  });
  assert.equal(code, 0);
  assert.equal(requests, 1);
  assert.equal(lines[0].returnedItemCount, 0);
  assert.equal(lines[0].hasMore, false);
  assert.equal(lines[0].subscriptionVerified, false);
});

test('search mode stops on a business error and never prints its detail', async () => {
  let requests = 0;
  const lines = [];
  const code = await run({
    mode: 'search',
    env: { WEREAD_API_KEY: key },
    fetchImpl: async () => {
      requests++;
      return json({ errcode: -2041, errmsg: 'private search detail' });
    },
    log: (line) => lines.push(line),
  });
  assert.equal(code, 1);
  assert.equal(requests, 1);
  assert.equal(JSON.parse(lines[0]).errorCode, -2041);
  assert.doesNotMatch(lines.join(''), /private search detail|wrk-test-only/);
});

test('search mode with no key or invalid mode sends zero requests', async () => {
  for (const options of [
    { mode: 'search', env: {}, loadPrivateKey: async () => null },
    { mode: 'invalid', env: { WEREAD_API_KEY: key } },
  ]) {
    let requests = 0;
    const code = await run({
      ...options,
      fetchImpl: async () => {
        requests++;
        throw new Error('must not run');
      },
      log: () => {},
    });
    assert.equal(code, 2);
    assert.equal(requests, 0);
  }
});
