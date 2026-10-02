'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomBytes } = require('node:crypto');
const { createRequire } = require('node:module');
const {
  ENDPOINT,
  DEFAULT_BODY_LIMIT,
  validatePrerequisites,
  parseBodyHtml,
  probe,
} = require('./probe-owner-body-once.cjs');
const serverRequire = createRequire(
  path.join(__dirname, '../../apps/server/package.json'),
);

const hash = (v) => createHash('sha256').update(v).digest('hex');

// Strictly synthetic mock candidate, reviewId, and feed data
const syntheticNumber = '1234567890';
const syntheticBiz = Buffer.from(syntheticNumber).toString('base64'); // 'MTIzNDU2Nzg5MA=='
const syntheticMid = '999999';
const syntheticIdx = '1';
const syntheticSn = '0123456789abcdef0123456789abcdef';

const candidate = {
  id: `WX_${syntheticNumber}_${syntheticMid}_${syntheticIdx}`,
  mpId: `MP_WXS_${syntheticNumber}`,
  title: '纯离线模拟测试文章标题样本',
  url: `https://mp.weixin.qq.com/s?__biz=${encodeURIComponent(syntheticBiz)}&mid=${syntheticMid}&idx=${syntheticIdx}&sn=${syntheticSn}`,
};

const feed = {
  mpId: `MP_WXS_${syntheticNumber}`,
  name: '纯离线模拟公众号',
  ownerVid: '123456789',
};

const reviewId = `MP_WXS_${syntheticNumber}_mockSyntheticReviewIdSecretNone`;
const cookieHeader = 'wr_skey=mockSyntheticSkey; wr_vid=123456789';

const sampleHtml = `<!DOCTYPE html>
<html>
<head>
  <meta property="og:url" content="https://mp.weixin.qq.com/s?__biz=${syntheticBiz}&mid=${syntheticMid}&idx=${syntheticIdx}&sn=${syntheticSn}">
</head>
<body>
  <h1 id="activity-name">纯离线模拟测试文章标题样本</h1>
  <a id="js_name">纯离线模拟公众号</a>
  <div id="js_content"><p>这是纯离线测试的模拟正文内容。</p></div>
  <script>
    var biz = "${syntheticBiz}";
    var mid = "${syntheticMid}";
    var idx = "${syntheticIdx}";
    var sn = "${syntheticSn}";
    var ct = 1700000000;
  </script>
</body>
</html>`;

async function fixture(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-body-mock-'));
  try {
    await callback(root);
  } finally {
    const resolved = fs.realpathSync(root);
    const parent = fs.realpathSync(os.tmpdir());
    assert(
      path.dirname(resolved).toLowerCase() === parent.toLowerCase() &&
        path.basename(resolved).startsWith('wewe-body-mock-'),
    );
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

function options(root, changed = {}) {
  return {
    candidate,
    feed,
    reviewId,
    cookieHeader,
    marker: path.join(root, 'body-axios-attempt.json'),
    output: root,
    axiosImpl: {
      get: async (url, config) => ({
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-length': String(Buffer.byteLength(sampleHtml, 'utf8')),
          server: 'test-upstream',
        },
        data: sampleHtml,
        config,
      }),
    },
    takeSnapshot: () => ({ db: 'mock_unchanged' }),
    protectedHashes: ['mock_hash_1'],
    bodyLimit: DEFAULT_BODY_LIMIT,
    ...changed,
  };
}

test('validatePrerequisites requires valid resolution, matching candidate, feed and Web session', () => {
  const resolution = {
    candidateId: candidate.id,
    mpId: candidate.mpId,
    reviewId,
    requestedUrl: 'http://mp.weixin.qq.com/s?mock',
    originalVerified: false,
  };
  const resolverResult = {
    success: true,
    stage: 'parsed',
    status: 200,
    requests: 1,
    productionUnchanged: true,
    candidateId: candidate.id,
    originalVerified: false,
  };
  const loginResult = { success: true, productionUnchanged: true };
  const mobileSession = {
    source: 'owner-confirmed-eink-sdk-login',
    accountId: '123456789',
    mobile: {
      vid: '123456789',
      accessToken: 'mock_token',
      deviceId: 'mock_dev',
    },
  };
  const tmpStop = path.join(os.tmpdir(), `mock-stop-${Date.now()}.json`);
  fs.writeFileSync(tmpStop, 'stop');
  try {
    const feedWithStop = {
      ...feed,
      originalStopFiles: [tmpStop],
    };
    const webSession = {
      source: 'owner-confirmed-native-web-login',
      capturedAt: new Date().toISOString(),
      ownerVid: '123456789',
      cookies: [
        {
          name: 'wr_vid',
          value: '123456789',
          domain: '.weread.qq.com',
          path: '/',
          secure: true,
          expires: -1,
        },
        {
          name: 'wr_skey',
          value: 'mockSyntheticSkey',
          domain: '.weread.qq.com',
          path: '/',
          secure: true,
          expires: -1,
        },
      ],
    };

    const validated = validatePrerequisites({
      resolution,
      resolverResult,
      loginResult,
      mobileSession,
      feed: feedWithStop,
      candidate,
      webSession,
    });
    assert(validated.cookieHeader.includes('wr_skey=mockSyntheticSkey'));
    assert(validated.cookieHeader.includes('wr_vid=123456789'));

    // Rejection on reviewId mpId mismatch
    assert.throws(
      () =>
        validatePrerequisites({
          resolution: { ...resolution, reviewId: 'MP_OTHER_123_abc' },
          resolverResult,
          loginResult,
          mobileSession,
          feed: feedWithStop,
          candidate,
          webSession,
        }),
      /invalid_resolution_reviewId/,
    );

    // Rejection on resolver failure
    assert.throws(
      () =>
        validatePrerequisites({
          resolution,
          resolverResult: { ...resolverResult, success: false },
          loginResult,
          mobileSession,
          feed: feedWithStop,
          candidate,
          webSession,
        }),
      /resolver_result_mismatch/,
    );

    // Rejection on candidate mismatch
    assert.throws(
      () =>
        validatePrerequisites({
          resolution,
          resolverResult,
          loginResult,
          mobileSession,
          feed: feedWithStop,
          candidate: { ...candidate, id: 'WX_OTHER_1_1' },
          webSession,
        }),
      /candidate_mismatch/,
    );
  } finally {
    fs.rmSync(tmpStop, { force: true });
  }
});

test('one exact body request writes marker first, retains raw HTML, saves sanitized headers, and extracts article with true publishTime', async () =>
  fixture(async (root) => {
    let calls = 0;
    const opts = options(root, {
      axiosImpl: {
        get: async (url, init) => {
          calls++;
          // Exclusive pre-fetch marker MUST exist before network call.
          assert(fs.existsSync(path.join(root, 'body-axios-attempt.json')));
          const parsedUrl = new URL(url);
          assert.equal(
            `${parsedUrl.origin}${parsedUrl.pathname}`,
            'https://weread.qq.com/web/mp/content',
          );
          assert.equal(parsedUrl.searchParams.get('reviewId'), reviewId);
          assert.equal(init.proxy, false);
          assert.equal(init.maxRedirects, 0);
          assert.equal(init.responseType, 'text');
          assert.equal(init.headers.Cookie, cookieHeader);
          assert.equal(init.headers.Referer, 'https://weread.qq.com/');
          assert.equal(init.headers.Origin, 'https://weread.qq.com');
          assert.equal(init.headers['User-Agent'], 'Mozilla/5.0');
          assert.equal(
            init.headers.Accept,
            'text/html,application/xhtml+xml,*/*',
          );
          return {
            status: 200,
            headers: {
              'content-type': 'text/html; charset=utf-8',
              'content-length': String(Buffer.byteLength(sampleHtml, 'utf8')),
              server: 'test-upstream',
              'set-cookie': 'secret_cookie=leak_forbidden',
            },
            data: sampleHtml,
          };
        },
      },
    });

    const result = await probe(opts);
    assert.equal(calls, 1);
    assert.equal(result.success, true);
    assert.equal(result.stage, 'parsed');
    assert.equal(result.status, 200);
    assert.equal(result.requests, 1);
    assert.equal(result.candidateId, candidate.id);
    assert.equal(result.publishTime, 1700000000);
    assert.equal(result.productionUnchanged, true);

    // Marker file was written and contains hash, not plain cookie
    const markerContent = fs.readFileSync(
      path.join(root, 'body-axios-attempt.json'),
      'utf8',
    );
    assert(markerContent.includes(hash(cookieHeader)));
    assert(!markerContent.includes('mockSyntheticSkey'));

    // Raw response was saved privately before parsing
    assert(fs.existsSync(path.join(root, 'response-body.html')));
    const rawSaved = fs.readFileSync(
      path.join(root, 'response-body.html'),
      'utf8',
    );
    assert.equal(rawSaved, sampleHtml);

    // Metadata saved with sanitized headers (set-cookie omitted)
    const meta = JSON.parse(
      fs.readFileSync(path.join(root, 'response-metadata.json'), 'utf8'),
    );
    assert.equal(meta.status, 200);
    assert.equal(meta.bytes, Buffer.byteLength(sampleHtml, 'utf8'));
    assert.equal(meta.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(meta.headers.server, 'test-upstream');
    assert.equal(meta.headers['set-cookie'], undefined);

    // Article published
    assert(fs.existsSync(path.join(root, 'article.json')));
    const article = JSON.parse(
      fs.readFileSync(path.join(root, 'article.json'), 'utf8'),
    );
    assert.equal(article.candidateId, candidate.id);
    assert.equal(article.mpId, candidate.mpId);
    assert.equal(article.reviewId, reviewId);
    assert.equal(article.title, candidate.title);
    assert.equal(article.accountName, feed.name);
    assert.equal(article.publishTime, 1700000000);
    assert.equal(article.verified, true);
    assert(article.contentBytes > 0);

    // Second execution with existing marker must reject immediately without new calls
    await assert.rejects(probe(opts));
    assert.equal(calls, 1);
  }));

test('HTTP 401, 500, and captcha pages abort and retain raw body without publishing article', async () => {
  const captchaHtml = `<!DOCTYPE html><html><head><title>安全验证</title></head><body><div class="weui_msg"><p>请完成验证后继续访问</p></div><iframe src="https://captcha.gtimg.com/1"></iframe></body></html>`;

  for (const [status, bodyText, expectedStage] of [
    [401, '{"errCode":-2012}', 'response'],
    [500, 'Internal Server Error', 'response'],
    [200, captchaHtml, 'parsing'],
  ]) {
    await fixture(async (root) => {
      let calls = 0;
      const opts = options(root, {
        axiosImpl: {
          get: async () => {
            calls++;
            return {
              status,
              headers: {
                'content-type':
                  status === 401 ? 'application/json' : 'text/html',
              },
              data: bodyText,
            };
          },
        },
      });

      const result = await probe(opts);
      assert.equal(calls, 1);
      assert.equal(result.success, false);
      assert.equal(result.stage, expectedStage);
      assert.equal(result.status, status);
      assert(fs.existsSync(path.join(root, 'response-body.html')));
      assert.equal(
        fs.readFileSync(path.join(root, 'response-body.html'), 'utf8'),
        bodyText,
      );
      assert(!fs.existsSync(path.join(root, 'article.json')));
    });
  }
});

test('identity, title, account name, publishTime or content mismatch stops without publishing article', async () => {
  const mismatchedCases = [
    // Wrong title
    sampleHtml.replace(
      '纯离线模拟测试文章标题样本',
      '完全不相关的其他文章标题',
    ),
    // Wrong account name
    sampleHtml.replace('纯离线模拟公众号', '另一个公众号名称'),
    // Missing publishTime
    sampleHtml.replace('var ct = 1700000000;', 'var ct = 0;'),
    // Empty content
    sampleHtml.replace(
      '<div id="js_content"><p>这是纯离线测试的模拟正文内容。</p></div>',
      '<div id="js_content"></div>',
    ),
    // Missing #js_content entirely
    '<!DOCTYPE html><html><body><h1>标题</h1></body></html>',
  ];

  for (const html of mismatchedCases) {
    await fixture(async (root) => {
      let calls = 0;
      const opts = options(root, {
        axiosImpl: {
          get: async () => {
            calls++;
            return {
              status: 200,
              headers: { 'content-type': 'text/html' },
              data: html,
            };
          },
        },
      });

      const result = await probe(opts);
      assert.equal(calls, 1);
      assert.equal(result.success, false);
      assert.equal(result.stage, 'parsing');
      assert(fs.existsSync(path.join(root, 'response-body.html')));
      assert(!fs.existsSync(path.join(root, 'article.json')));
    });
  }
});

test('oversize response and changed production snapshot block article publication', async () => {
  // Oversize response test
  await fixture(async (root) => {
    let calls = 0;
    const opts = options(root, {
      bodyLimit: 100, // Small limit for test
      axiosImpl: {
        get: async () => {
          calls++;
          return {
            status: 200,
            headers: { 'content-type': 'text/html' },
            data: 'x'.repeat(150),
          };
        },
      },
    });

    const result = await probe(opts);
    assert.equal(calls, 1);
    assert.equal(result.success, false);
    assert(!fs.existsSync(path.join(root, 'response-body.html')));
    assert(!fs.existsSync(path.join(root, 'article.json')));
  });

  // Changed production snapshot test
  await fixture(async (root) => {
    let snapshots = 0;
    const opts = options(root, {
      takeSnapshot: () => ({ db_checksum: ++snapshots }),
    });

    const result = await probe(opts);
    assert.equal(result.success, false);
    assert.equal(result.productionUnchanged, false);
    assert(!fs.existsSync(path.join(root, 'article.json')));
  });
});

test('Axios reads a localhost-only chunked/gzip multi-megabyte text response', async () => {
  const http = require('node:http');
  const zlib = require('node:zlib');

  const uncompressedBuffer = Buffer.from(
    randomBytes(2304 * 1024).toString('base64'),
    'utf8',
  );
  const payloadSize = uncompressedBuffer.length; // 3 MiB of UTF-8 ASCII
  const compressedGzip = zlib.gzipSync(uncompressedBuffer);

  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Encoding': 'gzip',
      'Transfer-Encoding': 'chunked',
    });
    const chunkSize = 64 * 1024;
    let offset = 0;
    const timer = setInterval(() => {
      if (offset >= compressedGzip.length) {
        clearInterval(timer);
        res.end();
        return;
      }
      res.write(compressedGzip.subarray(offset, offset + chunkSize));
      offset += chunkSize;
    }, 1);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const response = await serverRequire('axios').get(
      `http://127.0.0.1:${port}`,
      {
        proxy: false,
        maxRedirects: 0,
        timeout: 20000,
        maxContentLength: 8 * 1024 * 1024,
        responseType: 'text',
        transformResponse: [(v) => v],
        validateStatus: () => true,
      },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(Buffer.byteLength(response.data, 'utf8'), payloadSize);
    assert.equal(response.data, uncompressedBuffer.toString('utf8'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
