#!/usr/bin/env node
'use strict';

// Isolated owner QR session: skills page -> UID -> login -> userInfo ->
// apikeyGet -> renewal. One fixed MP list GET is gated on a fresh ticket.
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { createRequire } = require('node:module');
const { environmentGate } = require('./probe-refreshed-mobile-web-health.cjs');
const {
  BOOK_ID,
  LIST_URL,
  firstFive,
  redactedSample,
} = require('./probe-owner-native-web-five.cjs');
const { SkillsSession, SessionStop } = require('./owner-skills-session.cjs');

const ROOT = path.resolve(__dirname, '../..');
const PRIVATE_ROOT = path.join(ROOT, 'private-data');
const NAME = '妈妈部落畅聊阁';
const GLOBAL_MARKER = 'owner-skills-session-five-attempt.json';
const BODY_GLOBAL_MARKER = 'owner-skills-session-five-body-attempt.json';
const sha = (value) => createHash('sha256').update(value).digest('hex');

function stopCode(error) {
  if (error instanceof SessionStop) return error.code;
  if (/^[A-Z][A-Z0-9_]{2,80}$/.test(error?.code || '')) return error.code;
  if (/^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message || '')) return error.message;
  if (error?.message === 'environment_gate') return 'ENVIRONMENT_GATE';
  return 'PROTOCOL_STOP';
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
    !/^skills-session-five-[a-z0-9-]{4,64}$/.test(path.basename(runDir)) ||
    !fs.existsSync(PRIVATE_ROOT) ||
    fs.lstatSync(PRIVATE_ROOT).isSymbolicLink() ||
    fs.realpathSync(PRIVATE_ROOT) !== PRIVATE_ROOT ||
    !fs
      .readFileSync(path.join(ROOT, '.gitignore'), 'utf8')
      .split(/\r?\n/)
      .includes('private-data/') ||
    fs.existsSync(runDir)
  )
    throw new Error('PRIVATE_DIRECTORY_INVALID');
  if (create) fs.mkdirSync(runDir, { mode: 0o700 });
}

function ownerVid() {
  const file = path.join(
    PRIVATE_ROOT,
    'update-fix-20260930/source-config.json',
  );
  const feed = JSON.parse(fs.readFileSync(file, 'utf8')).feeds?.[BOOK_ID];
  if (
    feed?.mpId !== BOOK_ID ||
    feed?.name !== NAME ||
    !/^\d+$/.test(String(feed.ownerVid || ''))
  )
    throw new Error('OWNER_IDENTITY_CONFIG_INVALID');
  return String(feed.ownerVid);
}

function selectBodyReviewId(articles, index, previousZeroByteIds = []) {
  if (
    !Array.isArray(articles) ||
    !Number.isInteger(index) ||
    index < 0 ||
    index > 4 ||
    !articles[index] ||
    typeof articles[index].reviewId !== 'string' ||
    !/^MP_WXS_3895431412_[A-Za-z0-9_~-]+$/.test(articles[index].reviewId)
  )
    throw new Error('BODY_NOT_APPROVED_FROM_FIRST_PAGE');
  const reviewId = articles[index].reviewId;
  if (previousZeroByteIds.includes(reviewId))
    throw new Error('BODY_PREVIOUS_ZERO_BYTE_ID');
  return reviewId;
}

function previousZeroByteIds() {
  const result = [];
  for (const name of ['body-attempt.json', 'body-axios-attempt.json']) {
    const file = path.join(PRIVATE_ROOT, 'list-discovery-20261002', name);
    if (!fs.existsSync(file)) continue;
    const prior = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof prior.reviewId === 'string') result.push(prior.reviewId);
  }
  return result;
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

function html(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
}

function page(content, refresh = false) {
  return (
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
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

async function checkLoopback() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  await new Promise((resolve) => server.close(resolve));
}

async function preflight(runDir) {
  environmentGate(process.env);
  privateDirectory(runDir);
  if (fs.existsSync(path.join(PRIVATE_ROOT, GLOBAL_MARKER)))
    throw new Error('ALREADY_ATTEMPTED');
  ownerVid();
  if (
    !qrSvg(
      'https://weread.qq.com/web/confirm?uid=synthetic-preflight',
    ).startsWith('<svg')
  )
    throw new Error('QR_RENDER_INVALID');
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
  const expectedVid = ownerVid();
  writeOnce(path.join(PRIVATE_ROOT, GLOBAL_MARKER), {
    kind: 'owner-skills-session-five',
    at: new Date().toISOString(),
    endpoints: [
      '/r/weread-skills',
      '/api/auth/getLoginUid',
      '/api/auth/getLoginInfo',
      '/api/userInfo',
      '/api/skills/apikeyGet',
      '/web/login/renewal',
      '/web/mp/articles',
    ],
  });
  const session = new SkillsSession();
  let scanUrl;
  try {
    scanUrl = await session.begin();
  } catch (error) {
    writeOnce(path.join(runDir, 'stop.json'), {
      state: stopCode(error),
      cookieNamesByStage: session.stageNames,
    });
    throw new Error('LOGIN_BEGIN_STOP');
  }
  const secret = randomBytes(24).toString('hex');
  let login,
    pending,
    stopped,
    verified,
    held,
    verifyStarted = false,
    bodyStarted = false;
  let closeTimer;
  const scheduleClose = (delay) => {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      held = undefined;
      if (server.listening) server.close();
    }, delay);
    closeTimer.unref();
  };
  const server = http.createServer(async (req, res) => {
    if (
      req.socket.remoteAddress !== '127.0.0.1' ||
      req.headers.host !== `127.0.0.1:${server.address().port}`
    ) {
      send(res, 403, page('<p>访问受限。</p>'));
      return;
    }
    if (req.method === 'GET' && req.url === `/${secret}`) {
      if (stopped || verified) {
        send(
          res,
          200,
          page(`<p>首屏验证结束：${html((stopped || verified).state)}。</p>`),
        );
        return;
      }
      if (!login?.ready && !pending) {
        pending = session
          .poll()
          .then((answer) => {
            login = answer;
          })
          .catch((error) => {
            stopped = {
              state: stopCode(error),
              cookieNamesByStage: session.stageNames,
            };
            writeOnce(path.join(runDir, 'stop.json'), stopped);
            scheduleClose(15000);
          })
          .finally(() => {
            pending = undefined;
          });
      }
      if (!login?.ready) {
        send(
          res,
          200,
          page('<p>请本人扫码并在微信读书中确认。</p>' + qrSvg(scanUrl), true),
        );
        return;
      }
      if (login.vid !== expectedVid) {
        stopped = {
          state: 'OWNER_IDENTITY_MISMATCH',
          cookieNamesByStage: session.stageNames,
        };
        writeOnce(path.join(runDir, 'stop.json'), stopped);
        scheduleClose(15000);
        send(res, 200, page('<p>账号身份不符，已停止。</p>'));
        return;
      }
      send(
        res,
        200,
        page(
          '<p>本人账号已确认。点击一次核验账号、官方 API key、新票据和目标号首屏。</p>' +
            `<form method="post" action="/${secret}/verify"><button>验证首屏一次</button></form>`,
        ),
      );
      return;
    }
    if (
      req.method === 'POST' &&
      req.url === `/${secret}/verify` &&
      login?.ready &&
      login.vid === expectedVid &&
      !verifyStarted &&
      Number(req.headers['content-length'] || 0) === 0 &&
      !req.headers['transfer-encoding']
    ) {
      verifyStarted = true;
      try {
        writeOnce(path.join(runDir, 'verification-attempt.json'), {
          at: new Date().toISOString(),
          ownerVidSha256: sha(expectedVid),
        });
        const { ticket, wrpa } = await session.verifyAndRenew(expectedVid);
        writeOnce(path.join(runDir, 'list-attempt.json'), {
          at: new Date().toISOString(),
          endpoint: '/web/mp/articles',
          bookId: BOOK_ID,
          maxIdx: 0,
          count: 5,
          ticketPresent: true,
        });
        const raw = await session.listOnce(LIST_URL, ticket, wrpa);
        writeOnce(path.join(runDir, 'list-response.bin'), Buffer.from(raw));
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          throw new Error('LIST_NON_JSON_OR_CHALLENGE');
        }
        const articles = firstFive(data);
        writeOnce(path.join(runDir, 'list-first-five-private.json'), articles);
        verified = {
          state:
            articles.length === 5
              ? 'five_identity_samples'
              : 'partial_first_page',
          articleCount: articles.length,
          articles: redactedSample(articles),
          cookieNamesByStage: session.stageNames,
          ticketPresent: true,
          wrpaPresent: Boolean(wrpa),
          bodyVerified: false,
          subscriptionRestored: false,
        };
        writeOnce(path.join(runDir, 'result.json'), verified);
        if (articles.length > 0) {
          held = { ticket, wrpa, articles };
          // Only an explicit reviewed-list request may consume this jar.
          scheduleClose(5 * 60 * 1000);
        } else {
          scheduleClose(15000);
        }
      } catch (error) {
        stopped = {
          state: stopCode(error),
          articleCount: 0,
          cookieNamesByStage: session.stageNames,
          ticketPresent: false,
          subscriptionRestored: false,
        };
        writeOnce(path.join(runDir, 'stop.json'), stopped);
        scheduleClose(15000);
      }
      send(
        res,
        200,
        page(
          `<p>首屏验证结束：${html((verified || stopped).state)}。</p><p>结果仅存私有目录，未写生产库。</p>`,
        ),
      );
      return;
    }
    const bodyRoute = req.url?.match(new RegExp(`^/${secret}/body/([0-4])$`));
    if (
      req.method === 'POST' &&
      bodyRoute &&
      req.headers['x-reviewed-list'] === 'yes' &&
      Number(req.headers['content-length'] || 0) === 0 &&
      !req.headers['transfer-encoding'] &&
      verified?.articleCount > 0 &&
      held &&
      !bodyStarted
    ) {
      bodyStarted = true;
      try {
        const reviewId = selectBodyReviewId(
          held.articles,
          Number(bodyRoute[1]),
          previousZeroByteIds(),
        );
        writeOnce(path.join(PRIVATE_ROOT, BODY_GLOBAL_MARKER), {
          endpoint: '/web/mp/content',
          reviewIdSha256: sha(reviewId),
          at: new Date().toISOString(),
        });
        const raw = await session.bodyOnce(reviewId, held.ticket, held.wrpa);
        writeOnce(path.join(runDir, 'body-response.bin'), raw);
        if (
          raw.length === 0 ||
          /captcha|验证码|安全验证|环境异常|访问过于频繁/i.test(
            raw.toString('utf8', 0, Math.min(raw.length, 2048)),
          )
        )
          throw new Error('BODY_REJECTED_OR_EMPTY');
        let bodyBusinessCode;
        if (
          raw
            .toString('utf8', 0, Math.min(raw.length, 64))
            .trimStart()
            .startsWith('{')
        ) {
          try {
            const parsed = JSON.parse(raw.toString('utf8'));
            bodyBusinessCode = parsed?.errCode ?? parsed?.errcode;
          } catch {
            // An HTML or encrypted article body need not be JSON.
          }
        }
        if (bodyBusinessCode !== undefined && bodyBusinessCode !== 0)
          throw new Error('BODY_BUSINESS_REJECTED');
        writeOnce(path.join(runDir, 'body-result.json'), {
          bytes: raw.length,
          reviewIdSha256: sha(reviewId).slice(0, 16),
          fullArticleVerified: false,
          subscriptionRestored: false,
        });
        send(
          res,
          200,
          page(`<p>单篇正文回包 ${raw.length} 字节，完整性尚待核实。</p>`),
        );
      } catch (error) {
        const state = stopCode(error);
        writeOnce(path.join(runDir, 'body-stop.json'), { state });
        send(res, 200, page(`<p>单篇正文验证已停止：${html(state)}。</p>`));
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
  setTimeout(
    () => {
      held = undefined;
      if (server.listening) server.close();
    },
    15 * 60 * 1000,
  ).unref();
  const localUrl = `http://127.0.0.1:${server.address().port}/${secret}`;
  console.log(
    JSON.stringify({
      localUrl,
      runDir,
      target: BOOK_ID,
      listBudget: 1,
      productionWrites: 0,
    }),
  );
  return { server, localUrl };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (
    args.length === 3 &&
    args[0] === '--preflight' &&
    args[1] === '--run-dir' &&
    path.isAbsolute(args[2])
  ) {
    preflight(args[2])
      .then((value) => console.log(JSON.stringify(value)))
      .catch((error) => {
        console.error(
          JSON.stringify({
            state: 'preflight_stopped',
            reason: stopCode(error),
          }),
        );
        process.exitCode = 1;
      });
  } else if (
    args.length === 4 &&
    args[0] === '--execute' &&
    args[1] === '--run-dir' &&
    path.isAbsolute(args[2]) &&
    args[3] === '--approved-online'
  ) {
    serveOnce(args[2]).catch((error) => {
      console.error(
        JSON.stringify({ state: 'stopped', reason: stopCode(error) }),
      );
      process.exitCode = 1;
    });
  } else {
    console.error(
      'usage: --preflight --run-dir <absolute private-data child> | --execute --run-dir <absolute private-data child> --approved-online',
    );
    process.exitCode = 1;
  }
}

module.exports = {
  preflight,
  serveOnce,
  stopCode,
  selectBodyReviewId,
  GLOBAL_MARKER,
  BODY_GLOBAL_MARKER,
};
