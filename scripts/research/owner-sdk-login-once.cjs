'use strict';

// Research-only reuse of normal owner SDK authorization. No production writes.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const {
  safePrivateRoot,
  within,
  sqliteApi,
} = require('./probe-mobile-refresh-preflight.cjs');
const { environmentGate } = require('./probe-refreshed-mobile-web-health.cjs');
const { snapshot } = require('./probe-recent-account-discovery.cjs');
const { verifyCache, COMMIT } = require('./prepare-owner-sdk-cache.cjs');
const hash = (v) => createHash('sha256').update(v).digest('hex');

function publish(root, name, value) {
  fs.writeFileSync(path.join(root, name), JSON.stringify(value), {
    flag: 'wx',
    mode: 0o600,
  });
}

function boundedFetch(fetchImpl, deviceId, audit, onResponse = () => {}) {
  const counts = { ticket: 0, qr: 0, poll: 0, exchange: 0 };
  const addresses = {
    'https://i.weread.qq.com/wxticket': 'ticket',
    'https://open.weixin.qq.com/connect/sdk/qrconnect': 'qr',
    'https://long.open.weixin.qq.com/connect/l/qrconnect': 'poll',
    'https://i.weread.qq.com/login': 'exchange',
  };
  return async (input, init) => {
    if (init.signal?.aborted) throw Error('aborted');
    const url = new URL(input);
    const phase = addresses[url.origin + url.pathname];
    if (
      !phase ||
      url.username ||
      url.password ||
      url.port ||
      init.redirect !== 'error'
    )
      throw Error('endpoint_gate');
    if (++counts[phase] > (phase === 'poll' ? 40 : 1))
      throw Error('request_budget_gate');
    if (phase === 'ticket' && url.searchParams.get('nonceStr') !== 'weread')
      throw Error('ticket_gate');
    if (phase !== 'ticket' && counts.ticket !== 1) throw Error('sequence_gate');
    if (phase === 'exchange') {
      const body = JSON.parse(init.body);
      if (
        counts.qr !== 1 ||
        !counts.poll ||
        init.method !== 'POST' ||
        body.deviceId !== deviceId ||
        body.isAutoLogout !== 0 ||
        'refreshToken' in body ||
        'accessToken' in body
      )
        throw Error('exchange_gate');
    } else if (init.method && init.method !== 'GET') throw Error('method_gate');
    const response = await fetchImpl(input, init);
    // Audit only categories/counts: no UUID, wx_code, request headers or tokens.
    const entry = {
      phase,
      httpStatus: response.status,
      attempt: counts[phase],
      outcome: 'reading',
    };
    audit.push(entry);
    const reader = response.body?.getReader();
    const chunks = [];
    let bytes = 0;
    // Grounded in weread-omni src/api/response-body.js (MAX_JSON_RESPONSE_BYTES = 16 MiB).
    const maxBytes = phase === 'qr' ? 16 * 1024 * 1024 : 65536;
    try {
      if (!reader) throw Error('response_gate');
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.length;
        if (bytes > maxBytes) {
          entry.outcome = 'body_too_large';
          void reader.cancel().catch(() => {});
          throw Error('response_size_gate');
        }
        chunks.push(next.value);
      }
    } finally {
      reader?.releaseLock();
    }
    const raw = Buffer.concat(chunks);
    entry.bytes = raw.length;
    entry.outcome = 'saving_evidence';
    // Private bytes only, before interpretation; never replay to recover evidence.
    await onResponse(phase, counts[phase], raw);
    if (response.status !== 200) {
      entry.outcome = 'http_rejected';
      throw Error('upstream_rejected');
    }
    entry.outcome = 'parsing_json';
    const data = JSON.parse(raw.toString('utf8'));
    entry.outcome = 'checking_business';
    for (const key of ['errCode', 'errcode'])
      if (Number.isSafeInteger(data?.[key]))
        (entry.businessCodes ??= {})[key] = data[key];
    if (
      !data ||
      typeof data !== 'object' ||
      Array.isArray(data) ||
      ['errCode', 'errcode'].some((key) => key in data && data[key] !== 0) ||
      [data.errMsg, data.errmsg, data.message].some(
        (v) =>
          typeof v === 'string' &&
          /captcha|验证码|频繁|安全验证|环境异常/i.test(v),
      )
    ) {
      entry.outcome = 'business_rejected';
      throw Error('upstream_business_rejected');
    }
    entry.outcome = 'accepted_by_guard';
    return new Response(raw, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

async function runLogin({
  sdk,
  fetchImpl,
  root,
  expectedVid,
  deviceId,
  accountId,
  takeSnapshot,
  onQr,
  onStatus,
  signal,
}) {
  const before = takeSnapshot();
  publish(root, 'attempt.json', {
    source: 'owner-sdk-normal-login',
    commit: COMMIT,
    startedAt: new Date().toISOString(),
    ownerHash: hash(expectedVid),
    deviceHash: hash(deviceId),
    before,
  });
  const audit = [];
  let stage = 'ticket';
  try {
    const guarded = boundedFetch(
      fetchImpl,
      deviceId,
      audit,
      (phase, n, raw) => {
        fs.writeFileSync(path.join(root, `response-${phase}-${n}.bin`), raw, {
          flag: 'wx',
          mode: 0o600,
        });
      },
    );
    const options = {
      signal,
      timeoutMs: 20000,
      deadlineMs: 300000,
      pollTimeoutMs: 45000,
      pollDelayMs: 2000,
      onStatus,
    };
    const qr = await sdk.requestQr(guarded, options);
    if (
      !/^https:\/\/open\.weixin\.qq\.com\/connect\/confirm\?uuid=[A-Za-z0-9_%~-]{1,300}$/.test(
        qr.confirmUrl,
      )
    )
      throw Error('qr_url_gate');
    await onQr(qr.confirmUrl);
    stage = 'poll';
    const code = await sdk.pollForCode(qr.uuid, guarded, options);
    stage = 'exchange';
    const mobile = await sdk.exchange(code, deviceId, guarded, options);
    if (
      String(mobile.vid) !== expectedVid ||
      mobile.deviceId !== deviceId ||
      !['accessToken', 'refreshToken'].every(
        (k) =>
          typeof mobile[k] === 'string' &&
          mobile[k].length > 0 &&
          mobile[k].length <= 8192 &&
          !/[\s\x00-\x1f\x7f]/.test(mobile[k]),
      )
    )
      throw Error('identity_gate');
    const after = takeSnapshot();
    assert.deepEqual(after, before, 'production_changed');
    publish(root, 'mobile-session.json', {
      formatVersion: 1,
      source: 'owner-confirmed-eink-sdk-login',
      capturedAt: new Date().toISOString(),
      accountId,
      mobile,
    });
    publish(root, 'result.json', {
      success: true,
      audit,
      productionUnchanged: true,
      after,
    });
    return { state: 'completed' };
  } catch {
    // requestQr performs both ticket and qr requests; don't mislabel qr as ticket.
    if (stage === 'ticket' && audit.length) stage = audit.at(-1).phase;
    const after = takeSnapshot();
    publish(root, 'result.json', {
      success: false,
      stage,
      audit,
      productionUnchanged: JSON.stringify(after) === JSON.stringify(before),
    });
    return { state: 'stopped', stage };
  }
}

function page(nonce) {
  return `<!doctype html><meta charset="utf-8"><title>文章解析验证：正常微信授权</title>
<style>body{font-family:system-ui;max-width:620px;margin:70px auto;padding:24px;line-height:1.7}button{padding:12px 22px}img{display:block;margin:24px 0}img[hidden]{display:none}</style>
<h2>文章解析验证：正常微信授权</h2><p>这次扫码提供文章链接解析所需的移动会话。刚才原账号页取得的是 Web 会话。此研究入口只保存本机私有凭据，不写项目账号或文章。</p>
<p>使用刚才同一个微信读书账号。在手机微信中查看并确认官方授权。</p>
<button id="start">生成本次二维码</button><p id="status">尚未向腾讯发起请求</p><img id="qr" width="260" height="260" hidden>
<script nonce="${nonce}">const b=document.getElementById('start'),s=document.getElementById('status'),q=document.getElementById('qr');
b.onclick=async()=>{b.disabled=true;await fetch('/start',{method:'POST',headers:{'X-Owner-Start':'${nonce}'}});check()};
async function check(){try{const r=await(await fetch('/status',{cache:'no-store'})).json();s.textContent={starting:'生成二维码中',waiting:'请微信扫码并确认',scanned:'已扫码，请在手机上确认',confirmed:'确认完成，正在保存',completed:'SDK 登录已完成，可返回对话继续验证',stopped:'本次已停止，请返回对话查看诊断'}[r.state]||r.state;q.hidden=!r.hasQr;if(r.hasQr&&!q.getAttribute('src'))q.src='/qr.svg';if(!['completed','stopped'].includes(r.state))setTimeout(check,2000)}catch{s.textContent='入口已关闭，请返回对话'}}
</script>`;
}

async function serve({ sdkRoot, root, configFile, recoveryFile, dbFile }) {
  environmentGate(process.env);
  root = safePrivateRoot(root);
  if (
    !within(path.resolve(__dirname, '../../private-data'), root) ||
    fs.existsSync(path.join(root, 'attempt.json'))
  )
    throw Error('private_attempt_gate');
  const cache = verifyCache(sdkRoot);
  const config = JSON.parse(fs.readFileSync(configFile)).feeds
    .MP_WXS_3895431412;
  const old = JSON.parse(fs.readFileSync(recoveryFile)).proposedMobile;
  const expectedVid = String(config.ownerVid);
  if (
    !old ||
    String(old.vid) !== expectedVid ||
    !/^[A-Za-z0-9_-]{1,120}$/.test(old.deviceId)
  )
    throw Error('owner_device_gate');
  const { DatabaseSync } = sqliteApi();
  const db = new DatabaseSync(dbFile, { readOnly: true });
  let accountId;
  try {
    db.exec('PRAGMA query_only=ON');
    const accounts = db.prepare('SELECT id FROM accounts LIMIT 2').all();
    if (accounts.length !== 1) throw Error('account_gate');
    accountId = accounts[0].id;
  } finally {
    db.close();
  }
  const sdk = require(path.join(cache, 'src/auth/qrlogin.js'));
  // Existing local frontend QR implementation; no third-party image service.
  const req = createRequire(
    path.resolve(__dirname, '../../apps/web/package.json'),
  );
  const React = req('react');
  const { renderToStaticMarkup } = req('react-dom/server');
  const { QRCodeSVG } = req('qrcode.react');
  const nonce = randomBytes(24).toString('hex');
  const controller = new AbortController();
  let state = { state: 'idle' },
    qrSvg = '',
    started = false,
    base;
  const server = http.createServer((request, response) => {
    if (
      request.headers.host !== new URL(base).host ||
      (request.headers.origin && request.headers.origin !== base)
    ) {
      response.writeHead(403);
      response.end();
      return;
    }
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'`,
    );
    if (request.method === 'GET' && request.url === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(page(nonce));
    } else if (request.method === 'GET' && request.url === '/status') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ ...state, hasQr: !!qrSvg }));
    } else if (request.method === 'GET' && request.url === '/qr.svg' && qrSvg) {
      response.setHeader('Content-Type', 'image/svg+xml');
      response.end(qrSvg);
    } else if (
      request.method === 'POST' &&
      request.url === '/start' &&
      request.headers['x-owner-start'] === nonce &&
      !started
    ) {
      started = true;
      state = { state: 'starting' };
      response.writeHead(202);
      response.end();
      runLogin({
        sdk,
        fetchImpl: fetch,
        root,
        expectedVid,
        deviceId: old.deviceId,
        accountId,
        takeSnapshot: () => snapshot(dbFile),
        signal: controller.signal,
        onQr: (url) => {
          qrSvg = renderToStaticMarkup(
            React.createElement(QRCodeSVG, { value: url, size: 260 }),
          );
          state = { state: 'waiting' };
        },
        onStatus: (next) => {
          state = { state: next };
        },
      })
        .then((result) => {
          qrSvg = '';
          state = result;
          console.log(JSON.stringify(result));
          setTimeout(() => server.close(), 120000).unref();
        })
        .catch(() => {
          qrSvg = '';
          state = { state: 'stopped' };
          console.log(JSON.stringify(state));
        });
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  server.on('close', () => controller.abort());
  process.once('SIGINT', () => {
    controller.abort();
    server.close();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  publish(root, 'listener.json', {
    base,
    pid: process.pid,
    sdkCommit: COMMIT,
    state: 'idle',
  });
  console.log(
    JSON.stringify({
      base,
      pid: process.pid,
      state: 'idle',
      upstreamRequests: 0,
    }),
  );
  setTimeout(() => {
    controller.abort();
    server.close();
  }, 15 * 60000).unref();
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === '--plan')
    console.log(
      JSON.stringify({
        purpose: 'normal-owner-sdk-login-for-unrequested-resolver',
        productionWrites: 0,
        refresh: false,
        regeneration: false,
        ownerQrRequired: true,
        sdkCommit: COMMIT,
      }),
    );
  else if (
    argv.length === 6 &&
    argv[0] === '--serve' &&
    argv.slice(1).every(path.isAbsolute)
  )
    serve({
      sdkRoot: argv[1],
      root: argv[2],
      configFile: argv[3],
      recoveryFile: argv[4],
      dbFile: argv[5],
    }).catch(() => {
      console.log(JSON.stringify({ state: 'setup_stopped' }));
      process.exitCode = 1;
    });
  else {
    console.log(JSON.stringify({ state: 'usage_stopped' }));
    process.exitCode = 1;
  }
}
module.exports = { boundedFetch, runLogin, page };
