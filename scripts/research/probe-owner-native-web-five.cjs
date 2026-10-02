#!/usr/bin/env node
'use strict';

// Isolated owner-operated Web QR -> renewal -> one MP first-page experiment.
// The local UI binds only 127.0.0.1. No production database writes or retries.
// A successful first page is still only a five-item sample, never full history.
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { createRequire } = require('node:module');
const { environmentGate } = require('./probe-refreshed-mobile-web-health.cjs');

const ROOT = path.resolve(__dirname, '../..');
const PRIVATE_ROOT = path.join(ROOT, 'private-data');
const BOOK_ID = 'MP_WXS_3895431412';
const NAME = '妈妈部落畅聊阁';
const LIST_URL = `https://weread.qq.com/web/mp/articles?bookId=${BOOK_ID}&maxIdx=0&count=5`;
// A fresh QR experiment for a successful renewal without a ticket. Preserve
// the earlier ticket-required attempt and its private evidence unchanged.
const GLOBAL_MARKER = 'owner-native-web-five-optional-ticket-attempt.json';
const BODY_GLOBAL_MARKER =
  'owner-native-web-five-optional-ticket-body-attempt.json';
const MAX_LIST_BYTES = 2 * 1024 * 1024;
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const sha = (value) => createHash('sha256').update(value).digest('hex');

class ProbeStop extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function safeStop(error, fallback) {
  if (error instanceof ProbeStop) return error.code;
  if (error?.message === 'environment_gate') return 'ENVIRONMENT_GATE';
  if (/^WEB_RENEWAL_[A-Z_]+$/.test(error?.message || '')) return error.message;
  return fallback;
}

function writeOnce(file, value) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(
      fd,
      Buffer.isBuffer(value) ? value : JSON.stringify(value),
    );
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function privateDirectory(runDir, create = false) {
  if (
    !path.isAbsolute(runDir) ||
    path.dirname(runDir) !== PRIVATE_ROOT ||
    !/^native-web-five-[a-z0-9-]{4,64}$/.test(path.basename(runDir)) ||
    !fs.existsSync(PRIVATE_ROOT) ||
    fs.lstatSync(PRIVATE_ROOT).isSymbolicLink() ||
    fs.realpathSync(PRIVATE_ROOT) !== PRIVATE_ROOT ||
    !fs
      .readFileSync(path.join(ROOT, '.gitignore'), 'utf8')
      .split(/\r?\n/)
      .includes('private-data/')
  ) {
    throw new ProbeStop('PRIVATE_DIRECTORY_INVALID');
  }
  if (!create) {
    if (fs.existsSync(runDir)) throw new ProbeStop('RUN_DIRECTORY_EXISTS');
    return runDir;
  }
  fs.mkdirSync(runDir, { mode: 0o700 });
  if (
    fs.lstatSync(runDir).isSymbolicLink() ||
    fs.realpathSync(runDir) !== runDir
  )
    throw new ProbeStop('PRIVATE_DIRECTORY_INVALID');
  return runDir;
}

function ownerVidFromPrivateConfig() {
  const file = path.join(
    PRIVATE_ROOT,
    'update-fix-20260930/source-config.json',
  );
  const feed = JSON.parse(fs.readFileSync(file, 'utf8')).feeds?.[BOOK_ID];
  if (
    feed?.mpId !== BOOK_ID ||
    feed?.name !== NAME ||
    !/^\d+$/.test(String(feed?.ownerVid || ''))
  )
    throw new ProbeStop('OWNER_IDENTITY_CONFIG_INVALID');
  return String(feed.ownerVid);
}

async function boundedBody(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) throw new ProbeStop('MISSING_RESPONSE_BODY');
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new ProbeStop('RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

function rejectUpstream(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new ProbeStop('LIST_RESPONSE_SHAPE');
  const code = data.errCode ?? data.errcode;
  if (code !== undefined && code !== 0) {
    if (code === -2041) throw new ProbeStop('LIST_VERIFICATION_REQUIRED');
    if (code === -2012) throw new ProbeStop('LIST_AUTH_EXPIRED');
    throw new ProbeStop('LIST_BUSINESS_REJECTED');
  }
  if (
    [data.errMsg, data.msg, data.message].some(
      (v) =>
        typeof v === 'string' &&
        /captcha|验证码|验证|频繁|限流|环境异常|rate.?limit/i.test(v),
    )
  )
    throw new ProbeStop('LIST_VERIFICATION_OR_RATE_LIMIT');
  if (data.bookId !== undefined && data.bookId !== BOOK_ID)
    throw new ProbeStop('LIST_BOOK_ID_MISMATCH');
  if (!Array.isArray(data.reviews) || data.reviews.length > 50)
    throw new ProbeStop('LIST_REVIEWS_SHAPE');
}

/** Only project fields actually returned by Tencent; no guessed publication time. */
function firstFive(data) {
  rejectUpstream(data);
  const found = [];
  const seen = new Set();
  for (const row of data.reviews) {
    if (!row || typeof row !== 'object' || Array.isArray(row))
      throw new ProbeStop('LIST_ROW_SHAPE');
    const members = Array.isArray(row.subReviews) ? row.subReviews : [row];
    if (members.length > 50) throw new ProbeStop('LIST_ROW_SHAPE');
    for (const member of members) {
      const review = member?.review || member;
      const info = review?.mpInfo;
      if (!info || typeof info !== 'object' || Array.isArray(info))
        throw new ProbeStop('LIST_ARTICLE_IDENTITY_MISSING');
      const identities = [member?.reviewId, review?.reviewId].filter(Boolean);
      if (new Set(identities).size > 1)
        throw new ProbeStop('LIST_REVIEW_ID_CONFLICT');
      const reviewId = identities[0] || row.reviewId;
      if (
        typeof reviewId !== 'string' ||
        reviewId.length > 300 ||
        !/^MP_WXS_3895431412_[A-Za-z0-9_~-]+$/.test(reviewId) ||
        (review.bookId !== undefined && review.bookId !== BOOK_ID) ||
        info.mp_name !== NAME ||
        typeof info.title !== 'string' ||
        !info.title.trim() ||
        info.title.length > 500
      )
        throw new ProbeStop('LIST_ARTICLE_IDENTITY_MISMATCH');
      const time = info.time;
      if (
        !Number.isSafeInteger(time) ||
        time < 1262304000 ||
        time > Math.floor(Date.now() / 1000) + 86400
      )
        throw new ProbeStop('LIST_ARTICLE_TIME_MISSING');
      if (seen.has(reviewId)) continue;
      seen.add(reviewId);
      found.push({
        reviewId,
        title: info.title.trim(),
        sourceTime: time,
        sourceTimeField: 'review.mpInfo.time',
        accountName: info.mp_name,
      });
      if (found.length === 5) return found;
    }
  }
  return found;
}

function redactedSample(items) {
  return items.map((item) => ({
    reviewIdSha256: sha(item.reviewId).slice(0, 16),
    titlePreview: `${item.title.slice(0, 2)}…`,
    titleLength: item.title.length,
    sourceTime: item.sourceTime,
  }));
}

/** One fixed first-page GET, only after the caller's successful fresh renewal. */
async function firstPageOnce({
  runDir,
  session,
  ownerVid,
  ticket,
  wrpa,
  ownerSessionCookie,
  fetchImpl = fetch,
}) {
  const cookie = ownerSessionCookie(session, ownerVid);
  writeOnce(path.join(runDir, 'list-attempt.json'), {
    endpoint: '/web/mp/articles',
    bookId: BOOK_ID,
    maxIdx: 0,
    count: 5,
    at: new Date().toISOString(),
  });
  const response = await fetchImpl(LIST_URL, {
    method: 'GET',
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(20000),
    headers: {
      Cookie: cookie,
      ...(ticket ? { 'x-wr-ticket': ticket } : {}),
      ...(wrpa ? { 'x-wrpa-0': wrpa } : {}),
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://weread.qq.com/',
      'User-Agent': 'Mozilla/5.0',
    },
  });
  const raw = await boundedBody(response, MAX_LIST_BYTES);
  writeOnce(path.join(runDir, 'list-response.bin'), raw);
  if (response.status !== 200) throw new ProbeStop('LIST_HTTP_REJECTED');
  let data;
  try {
    data = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new ProbeStop('LIST_NON_JSON_OR_CHALLENGE');
  }
  const articles = firstFive(data);
  writeOnce(path.join(runDir, 'list-first-five-private.json'), articles);
  const result = {
    state:
      articles.length === 5 ? 'five_identity_samples' : 'partial_first_page',
    httpStatus: response.status,
    rawBytes: raw.length,
    firstPageOnly: true,
    articleCount: articles.length,
    articles: redactedSample(articles),
    bodyVerified: false,
    paginationVerified: false,
    subscriptionRestored: false,
  };
  writeOnce(path.join(runDir, 'result.json'), result);
  return { result, articles };
}

/** Prepared follow-up only. Never called by the first-page flow. */
async function fetchOneBodyOnce({
  runDir,
  session,
  ownerVid,
  ticket,
  wrpa,
  reviewId,
  allowedReviewIds,
  ownerSessionCookie,
  fetchImpl = fetch,
}) {
  if (
    !Array.isArray(allowedReviewIds) ||
    !allowedReviewIds.includes(reviewId) ||
    !/^MP_WXS_3895431412_[A-Za-z0-9_~-]+$/.test(reviewId)
  )
    throw new ProbeStop('BODY_NOT_APPROVED_FROM_FIRST_PAGE');
  for (const name of ['body-attempt.json', 'body-axios-attempt.json']) {
    const old = path.join(PRIVATE_ROOT, 'list-discovery-20261002', name);
    if (
      fs.existsSync(old) &&
      JSON.parse(fs.readFileSync(old, 'utf8')).reviewId === reviewId
    )
      throw new ProbeStop('BODY_PREVIOUS_ZERO_BYTE_ID');
  }
  const cookie = ownerSessionCookie(session, ownerVid);
  writeOnce(
    path.join(PRIVATE_ROOT, BODY_GLOBAL_MARKER),
    {
      endpoint: '/web/mp/content',
      reviewIdSha256: sha(reviewId),
      at: new Date().toISOString(),
    },
  );
  const url = `https://weread.qq.com/web/mp/content?reviewId=${encodeURIComponent(reviewId)}`;
  const response = await fetchImpl(url, {
    method: 'GET',
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(20000),
    headers: {
      Cookie: cookie,
      ...(ticket ? { 'x-wr-ticket': ticket } : {}),
      ...(wrpa ? { 'x-wrpa-0': wrpa } : {}),
      Accept: 'text/html,application/xhtml+xml,*/*',
      Referer: 'https://weread.qq.com/',
      'User-Agent': 'Mozilla/5.0',
    },
  });
  const raw = await boundedBody(response, MAX_BODY_BYTES);
  writeOnce(path.join(runDir, 'body-response.bin'), raw);
  if (
    response.status !== 200 ||
    raw.length === 0 ||
    /captcha|验证码|安全验证|环境异常|访问过于频繁/i.test(
      raw.toString('utf8', 0, Math.min(raw.length, 2048)),
    )
  )
    throw new ProbeStop('BODY_REJECTED_OR_EMPTY');
  const result = {
    httpStatus: response.status,
    bytes: raw.length,
    reviewIdSha256: sha(reviewId).slice(0, 16),
    fullArticleVerified: false,
  };
  writeOnce(path.join(runDir, 'body-result.json'), result);
  return result;
}

function html(text) {
  return String(text).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
}

function qrSvg(scanUrl) {
  const fromWeb = createRequire(path.join(ROOT, 'apps/web/package.json'));
  const react = fromWeb('react');
  const { renderToStaticMarkup } = fromWeb('react-dom/server');
  const { QRCodeSVG } = fromWeb('qrcode.react');
  return renderToStaticMarkup(
    react.createElement(QRCodeSVG, {
      value: scanUrl,
      size: 240,
      includeMargin: true,
    }),
  );
}

function page(content, refresh = false) {
  return (
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">` +
    (refresh ? '<meta http-equiv="refresh" content="4">' : '') +
    '<meta name="referrer" content="no-referrer"><title>微信读书本人验证</title>' +
    '<style>body{font:16px system-ui;max-width:580px;margin:36px auto;padding:0 16px}' +
    'button{padding:10px 18px;font-size:16px}svg{display:block;margin:20px 0}</style></head>' +
    `<body><h1>本人微信读书验证</h1>${content}</body></html>`
  );
}

function send(res, status, content) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'",
  });
  res.end(content);
}

function loadNativeModules() {
  process.env.TS_NODE_PROJECT = path.join(ROOT, 'apps/server/tsconfig.json');
  const fromServer = createRequire(path.join(ROOT, 'apps/server/package.json'));
  fromServer('ts-node/register');
  return {
    NativeWebLogin: require(
      path.join(ROOT, 'apps/server/src/weread/native-web-login.ts'),
    ).NativeWebLogin,
    renewDirectWebTicket: require(
      path.join(ROOT, 'apps/server/src/weread/native-web-ticket.ts'),
    ).renewDirectWebTicket,
    ownerSessionCookie: require(
      path.join(ROOT, 'apps/server/src/collection/owner-web-search.ts'),
    ).ownerSessionCookie,
  };
}

async function checkLoopback() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  await new Promise((resolve) => socket.close(resolve));
}

/** Check all local dependencies before reserving the one-shot marker. */
async function preflight(runDir) {
  environmentGate(process.env);
  privateDirectory(runDir);
  if (fs.existsSync(path.join(PRIVATE_ROOT, GLOBAL_MARKER)))
    throw new ProbeStop('ALREADY_ATTEMPTED');
  ownerVidFromPrivateConfig();
  loadNativeModules();
  if (
    !qrSvg(
      'https://weread.qq.com/web/confirm?uid=synthetic-preflight',
    ).startsWith('<svg')
  )
    throw new ProbeStop('QR_RENDER_INVALID');
  await checkLoopback();
  return {
    state: 'preflight_ready',
    networkRequests: 0,
    markerWritten: false,
    loopbackOnly: true,
  };
}

async function serveOnce(runDir) {
  await preflight(runDir);
  privateDirectory(runDir, true);
  const ownerVid = ownerVidFromPrivateConfig();
  writeOnce(path.join(PRIVATE_ROOT, GLOBAL_MARKER), {
    kind: 'owner-native-web-five-optional-ticket',
    at: new Date().toISOString(),
    endpoints: [
      '/api/auth/getLoginUid',
      '/api/auth/getLoginInfo',
      '/web/login/renewal',
      '/web/mp/articles',
    ],
  });
  // NativeWebLogin uses this absolute filename only to locate its private
  // stop/diagnostic directory. The config file is not read or created.
  process.env.OWNER_SEARCH_CONFIG_FILE = path.join(
    runDir,
    'source-config.json',
  );
  const { NativeWebLogin, renewDirectWebTicket, ownerSessionCookie } =
    loadNativeModules();
  const login = new NativeWebLogin();
  const qr = await login.create();
  const secretPath = randomBytes(24).toString('hex');
  let loginResult,
    pollPending,
    verifyStarted = false,
    verified,
    held;
  let bodyStarted = false;
  let loginStopped = false;
  let closeSoon;
  const closeServer = () => {
    if (server.listening) server.close();
  };
  const scheduleClose = (delay) => {
    if (closeSoon) clearTimeout(closeSoon);
    closeSoon = setTimeout(closeServer, delay);
    closeSoon.unref();
  };
  const server = http.createServer(async (req, res) => {
    if (
      req.socket.remoteAddress !== '127.0.0.1' ||
      req.headers.host !== `127.0.0.1:${server.address().port}`
    ) {
      send(res, 403, page('<p>访问受限。</p>'));
      return;
    }
    if (req.method === 'GET' && req.url === `/${secretPath}`) {
      if (verified) {
        send(
          res,
          200,
          page(
            `<p>首屏验证结束：${html(verified.state)}，样本 ${verified.articleCount} 篇。</p>` +
              '<p>仅首屏样本；正文与连续更新尚未验证。结果已存私有目录。</p>',
          ),
        );
        return;
      }
      if (!loginResult?.terminal) {
        if (!pollPending) {
          pollPending = login
            .poll(qr.uuid)
            .then((answer) => {
              loginResult = answer;
            })
            .catch(() => {
              loginResult = { terminal: true, message: '登录轮询停止。' };
            })
            .finally(() => {
              pollPending = undefined;
            });
        }
      }
      if (!loginResult?.terminal) {
        send(
          res,
          200,
          page(
            '<p>请本人扫码并在微信中确认。</p>' +
              qrSvg(qr.scanUrl) +
              `<p>${html(loginResult?.message || '等待扫码')}</p>`,
            true,
          ),
        );
        return;
      }
      if (!loginResult.webSession || String(loginResult.vid) !== ownerVid) {
        if (!loginStopped) {
          writeOnce(path.join(runDir, 'stop.json'), {
            state: 'LOGIN_STOP_OR_IDENTITY_MISMATCH',
          });
          loginStopped = true;
          scheduleClose(15000);
        }
        send(res, 200, page('<p>登录未完成或账号不匹配，已停止。</p>'));
        return;
      }
      send(
        res,
        200,
        page(
          '<p>本人账号已确认。点击一次验证新票据与目标号首屏。</p>' +
            `<form method="post" action="/${secretPath}/verify"><button>验证首屏一次</button></form>`,
        ),
      );
      return;
    }
    if (
      req.method === 'POST' &&
      req.url === `/${secretPath}/verify` &&
      loginResult?.webSession &&
      String(loginResult.vid) === ownerVid &&
      !verifyStarted &&
      Number(req.headers['content-length'] || 0) === 0 &&
      !req.headers['transfer-encoding']
    ) {
      verifyStarted = true;
      try {
        writeOnce(path.join(runDir, 'renewal-list-attempt.json'), {
          at: new Date().toISOString(),
          ownerVidSha256: sha(ownerVid),
        });
        const renewal = await renewDirectWebTicket(
          loginResult.webSession,
          ownerVid,
        );
        held = {
          session: renewal.session,
          ticket: renewal.ticket,
          wrpa: renewal.wrpa,
        };
        const answer = await firstPageOnce({
          runDir,
          ...held,
          ownerVid,
          ownerSessionCookie,
        });
        held.allowedReviewIds = answer.articles.map((item) => item.reviewId);
        verified = answer.result;
        // A short grace period permits explicit single-body review. No body
        // request is made by the first-page flow.
        scheduleClose(5 * 60 * 1000);
      } catch (error) {
        const code = safeStop(error, 'TRANSPORT_OR_RENEWAL_STOP');
        verified = {
          state: code,
          articleCount: 0,
          firstPageOnly: true,
          subscriptionRestored: false,
        };
        writeOnce(path.join(runDir, 'stop.json'), verified);
        held = undefined;
        scheduleClose(15000);
      }
      send(
        res,
        200,
        page(
          `<p>首屏验证结束：${html(verified.state)}，样本 ${verified.articleCount} 篇。</p>` +
            '<p>结果和原始回包仅在私有目录；没有写入生产库。</p>',
        ),
      );
      return;
    }
    const bodyRoute = req.url?.match(
      new RegExp(`^/${secretPath}/body/([0-4])$`),
    );
    if (
      req.method === 'POST' &&
      bodyRoute &&
      req.headers['x-reviewed-list'] === 'yes' &&
      Number(req.headers['content-length'] || 0) === 0 &&
      !req.headers['transfer-encoding'] &&
      verified?.articleCount > 0 &&
      held?.allowedReviewIds?.[Number(bodyRoute[1])] &&
      !bodyStarted
    ) {
      // No button is displayed. The owner must explicitly select an index
      // after reading list-first-five-private.json and send the review header.
      bodyStarted = true;
      try {
        const result = await fetchOneBodyOnce({
          runDir,
          ...held,
          ownerVid,
          ownerSessionCookie,
          reviewId: held.allowedReviewIds[Number(bodyRoute[1])],
          allowedReviewIds: held.allowedReviewIds,
        });
        send(
          res,
          200,
          page(`<p>单篇正文回包 ${result.bytes} 字节，完整性尚待核实。</p>`),
        );
      } catch (error) {
        const code = safeStop(error, 'BODY_TRANSPORT_STOP');
        writeOnce(path.join(runDir, 'body-stop.json'), { state: code });
        send(res, 200, page(`<p>单篇正文验证已停止：${html(code)}。</p>`));
      }
      held = undefined;
      scheduleClose(15000);
      return;
    }
    send(res, 404, page('<p>无此操作。</p>'));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const maxLifetime = setTimeout(closeServer, 15 * 60 * 1000);
  maxLifetime.unref();
  const localUrl = `http://127.0.0.1:${server.address().port}/${secretPath}`;
  console.log(
    JSON.stringify({
      localUrl,
      runDir,
      requestsSoFar: 1,
      target: BOOK_ID,
      listBudget: 1,
      productionWrites: 0,
    }),
  );
  return { server, localUrl };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === '--plan') {
    console.log(
      JSON.stringify({
        endpoint: '/web/mp/articles',
        query: { bookId: BOOK_ID, maxIdx: 0, count: 5 },
        loopbackOnly: true,
        oneShot: true,
        networkRequests: 0,
        productionWrites: 0,
        bodyRequestAutomatic: false,
      }),
    );
  } else if (
    argv.length === 3 &&
    argv[0] === '--preflight' &&
    argv[1] === '--run-dir' &&
    path.isAbsolute(argv[2])
  ) {
    preflight(argv[2])
      .then((result) => console.log(JSON.stringify(result)))
      .catch((error) => {
        console.error(
          JSON.stringify({
            state: 'preflight_stopped',
            reason: safeStop(error, 'LOCAL_PREFLIGHT_STOP'),
          }),
        );
        process.exitCode = 1;
      });
  } else if (
    argv.length === 4 &&
    argv[0] === '--execute' &&
    argv[1] === '--run-dir' &&
    path.isAbsolute(argv[2]) &&
    argv[3] === '--approved-online'
  ) {
    serveOnce(argv[2]).catch((error) => {
      console.error(
        JSON.stringify({
          state: 'stopped',
          reason: safeStop(error, 'LOCAL_START_STOP'),
        }),
      );
      process.exitCode = 1;
    });
  } else {
    console.error(
      'usage: --plan | --preflight --run-dir <absolute private-data child> | --execute --run-dir <absolute private-data child> --approved-online',
    );
    process.exitCode = 1;
  }
}

module.exports = {
  BOOK_ID,
  LIST_URL,
  ProbeStop,
  privateDirectory,
  firstFive,
  redactedSample,
  firstPageOnce,
  fetchOneBodyOnce,
  preflight,
  serveOnce,
};
