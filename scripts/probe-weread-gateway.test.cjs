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
  assert.equal(lines[0].chapters[0].title, '[redacted-label]');
  assert.equal(lines[1].author, '[redacted-label]');
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
  assert.equal(lines[0].printedGroupCount, 1);
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

test('search keeps aggregate counts but bounds printed group labels', async () => {
  const lines = [];
  const code = await run({
    mode: 'search',
    env: { WEREAD_API_KEY: key },
    fetchImpl: async () =>
      json({
        results: Array.from({ length: 100 }, (_, index) => ({
          title: `Group ${index}`,
          books: [
            {
              bookInfo: {
                bookId: `MP_TEST_${index}`,
                title: `Article ${index}`,
              },
            },
          ],
        })),
      }),
    log: (line) => lines.push(JSON.parse(line)),
  });
  assert.equal(code, 0);
  assert.equal(lines[0].groupCount, 100);
  assert.equal(lines[0].printedGroupCount, 20);
  assert.equal(lines[0].groups.length, 20);
  assert.equal(lines[0].returnedItemCount, 100);
  assert.equal(lines[0].printedCount, 20);
  assert.doesNotMatch(JSON.stringify(lines), /Group 99|Article 99/);
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

test('HTTP JSON errors retain status and a classified, redacted business explanation', async () => {
  const lines = [];
  const code = await run({
    mode: 'search',
    env: { WEREAD_API_KEY: key },
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          errcode: -2041,
          errmsg:
            '认证失败 Authorization: Bearer wrk-hidden Cookie: sid=secret https://example.test/?key=secret',
        }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      ),
    log: (line) => lines.push(JSON.parse(line)),
  });
  assert.equal(code, 1);
  assert.equal(lines[0].reason, 'http-error');
  assert.equal(lines[0].httpStatus, 403);
  assert.equal(lines[0].responseFormat, 'json');
  assert.equal(lines[0].errorCode, -2041);
  assert.equal(lines[0].errorMessage, 'authentication-or-permission-rejected');
  assert.doesNotMatch(
    JSON.stringify(lines),
    /Authorization|Cookie|wrk-hidden|sid=secret|example\.test|key=secret/,
  );
});

test('HTTP HTML error pages are classified without printing the page', async () => {
  const lines = [];
  const code = await run({
    mode: 'search',
    env: { WEREAD_API_KEY: key },
    fetchImpl: async () =>
      new Response('<html>wrk-hidden Cookie: sid=secret</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
    log: (line) => lines.push(JSON.parse(line)),
  });
  assert.equal(code, 1);
  assert.equal(lines[0].reason, 'http-error');
  assert.equal(lines[0].httpStatus, 502);
  assert.equal(lines[0].responseFormat, 'non-json');
  assert.equal(lines[0].errorCode, null);
  assert.doesNotMatch(
    JSON.stringify(lines),
    /html|wrk-hidden|Cookie|sid=secret/,
  );
});

test('a 200 business error is distinct from HTTP and transport errors', async () => {
  const lines = [];
  const code = await run({
    mode: 'search',
    env: { WEREAD_API_KEY: key },
    fetchImpl: async () =>
      json({ errcode: 429, errmsg: '请求过于频繁，请稍后再试' }),
    log: (line) => lines.push(JSON.parse(line)),
  });
  assert.equal(code, 1);
  assert.equal(lines[0].reason, 'business-error');
  assert.equal(lines[0].httpStatus, 200);
  assert.equal(lines[0].responseFormat, 'json');
  assert.equal(lines[0].errorCode, 429);
  assert.equal(lines[0].errorMessage, 'rate-limited');
});

test('nested verification warning outranks a generic outer message', async () => {
  const lines = [];
  const code = await run({
    mode: 'search',
    env: { WEREAD_API_KEY: key },
    fetchImpl: async () =>
      json({
        message: 'request failed',
        data: { errcode: 403, errmsg: 'captcha required' },
      }),
    log: (line) => lines.push(JSON.parse(line)),
  });
  assert.equal(code, 1);
  assert.equal(lines[0].reason, 'business-error');
  assert.equal(lines[0].errorCode, 403);
  assert.equal(lines[0].errorMessage, 'verification-required');
});

test('search labels suppress credential-like header text', async () => {
  const lines = [];
  const code = await run({
    mode: 'search',
    env: { WEREAD_API_KEY: key },
    fetchImpl: async () =>
      json({
        results: [
          {
            title: 'Authorization: Bearer DEMO Cookie: sid=demo Key: demo',
            books: [
              {
                bookInfo: {
                  bookId: 'MP_TEST',
                  title: 'Cookie: sid=demo',
                  author: 'Bearer DEMO',
                },
              },
            ],
          },
        ],
      }),
    log: (line) => lines.push(JSON.parse(line)),
  });
  assert.equal(code, 0);
  assert.equal(lines[0].groups[0].title, '[redacted-label]');
  assert.equal(lines[0].results[0].title, '[redacted-label]');
  assert.equal(lines[0].results[0].authorLabel, '[redacted-label]');
  assert.doesNotMatch(
    JSON.stringify(lines),
    /Authorization|Cookie|Bearer|sid=demo|DEMO/,
  );
});

test('empty or zero business codes do not turn successful JSON into errors', async () => {
  for (const errcode of [null, '', '00', 0]) {
    const lines = [];
    const code = await run({
      mode: 'search',
      env: { WEREAD_API_KEY: key },
      fetchImpl: async () => json({ errcode, results: [] }),
      log: (line) => lines.push(JSON.parse(line)),
    });
    assert.equal(code, 0);
    assert.equal(lines[0].kind, 'keyword-search-sample');
  }
});

test('upgrade hints expose only a validated version, never raw instructions', async () => {
  const lines = [];
  const code = await run({
    mode: 'list',
    env: { WEREAD_API_KEY: key },
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          errcode: 426,
          upgrade_info: {
            latest_version: '1.0.5',
            message:
              '更新 https://example.test/?key=secret; Cookie: sid=secret',
          },
        }),
        { status: 426, headers: { 'content-type': 'application/json' } },
      ),
    log: (line) => lines.push(JSON.parse(line)),
  });
  assert.equal(code, 1);
  assert.equal(lines[0].reason, 'http-error');
  assert.equal(lines[0].httpStatus, 426);
  assert.equal(lines[0].errorCode, 426);
  assert.equal(lines[0].upgradeRequired, true);
  assert.equal(lines[0].suggestedSkillVersion, '1.0.5');
  assert.doesNotMatch(JSON.stringify(lines), /example\.test|Cookie|sid=secret/);
});

test('error body reading is bounded even without content-length', async () => {
  const lines = [];
  const code = await run({
    mode: 'search',
    env: { WEREAD_API_KEY: key },
    fetchImpl: async () =>
      new Response('x'.repeat(70 * 1024), {
        status: 413,
        headers: { 'content-type': 'application/json' },
      }),
    log: (line) => lines.push(JSON.parse(line)),
  });
  assert.equal(code, 1);
  assert.equal(lines[0].reason, 'response-too-large');
  assert.equal(lines[0].httpStatus, 413);
  assert.doesNotMatch(JSON.stringify(lines), /x{100}/);
});

test('transport failures never expose exception content', async () => {
  const lines = [];
  const code = await run({
    mode: 'search',
    env: { WEREAD_API_KEY: key },
    fetchImpl: async () => {
      throw new Error(
        'connect failed for https://example.test/?key=secret using wrk-hidden',
      );
    },
    log: (line) => lines.push(JSON.parse(line)),
  });
  assert.equal(code, 1);
  assert.equal(lines[0].reason, 'transport-failure');
  assert.equal(lines[0].httpStatus, null);
  assert.doesNotMatch(
    JSON.stringify(lines),
    /example\.test|key=secret|wrk-hidden/,
  );
});

test('list mode calls only the documented discovery operation and prints distinct names', async () => {
  const calls = [];
  const lines = [];
  const code = await run({
    mode: 'list',
    env: { WEREAD_API_KEY: key },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return json({
        apis: [
          { api_name: '/book/info', params: { token: 'wrk-hidden' } },
          { api_name: '/book/info' },
          { api_name: '/store/search' },
          { api_name: '/book/wrk-hidden-secret' },
          { api_name: 'https://example.test/?key=secret' },
        ],
      });
    },
    log: (line) => lines.push(JSON.parse(line)),
  });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://i.weread.qq.com/api/agent/gateway');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    api_name: '/_list',
    skill_version: '1.0.4',
  });
  assert.deepEqual(lines[0], {
    kind: 'gateway-capabilities',
    count: 2,
    sourceEntryCount: 5,
    unrecognizedEntryCount: 2,
    complete: false,
    apiNames: ['/book/info', '/store/search'],
  });
  assert.doesNotMatch(
    JSON.stringify(lines),
    /token|wrk-hidden|example\.test|key=secret/,
  );
});

test('mixed discovery entries never appear to be a complete capability list', async () => {
  const lines = [];
  const code = await run({
    mode: 'list',
    env: { WEREAD_API_KEY: key },
    fetchImpl: async () =>
      json({
        apis: [{ api_name: '/store/search' }, { name: '/book/articles' }],
      }),
    log: (line) => lines.push(JSON.parse(line)),
  });
  assert.equal(code, 0);
  assert.equal(lines[0].count, 1);
  assert.equal(lines[0].sourceEntryCount, 2);
  assert.equal(lines[0].unrecognizedEntryCount, 1);
  assert.equal(lines[0].complete, false);
});

test('unknown discovery response shape reports only a key count', async () => {
  const lines = [];
  const code = await run({
    mode: 'list',
    env: { WEREAD_API_KEY: key },
    fetchImpl: async () =>
      json({
        strange: { secret: 'wrk-hidden' },
        'https://example.test/?key=secret': [],
        sk_live_secret123: {},
      }),
    log: (line) => lines.push(JSON.parse(line)),
  });
  assert.equal(code, 1);
  assert.equal(lines[0].kind, 'stopped');
  assert.equal(lines[0].reason, 'unknown-list-shape');
  assert.equal(lines[0].responseShape, 'object');
  assert.equal(lines[0].topLevelKeyCount, 3);
  assert.doesNotMatch(
    JSON.stringify(lines),
    /wrk-hidden|example\.test|key=secret|sk_live_secret123|strange/,
  );
});

test('a discovery array with no valid interface names is not treated as an empty list', async () => {
  const lines = [];
  const code = await run({
    mode: 'list',
    env: { WEREAD_API_KEY: key },
    fetchImpl: async () => json({ apis: [{ name: '/book/info' }] }),
    log: (line) => lines.push(JSON.parse(line)),
  });
  assert.equal(code, 1);
  assert.equal(lines[0].reason, 'unknown-list-shape');
  assert.equal(lines[0].topLevelKeyCount, 1);
});
