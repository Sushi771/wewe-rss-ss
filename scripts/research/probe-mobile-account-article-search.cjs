#!/usr/bin/env node
'use strict';

// Independent hypothesis: direct mobile /store/search, not Agent Gateway or
// Web broker. One GET only; no SDK auth refresh/replay and no inferred cursor.
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const {
  VERSION_HEADERS,
  safePrivateRoot,
} = require('./probe-mobile-refresh-preflight.cjs');
const {
  recoveryGate,
  environmentGate,
  numericCode,
  hint,
  statusStop,
} = require('./probe-refreshed-mobile-web-health.cjs');
const { durable, snapshot } = require('./probe-recent-account-discovery.cjs');
const MARKER = 'mobile-account-article-search-attempt.json';
const SOURCE =
  '9ae54e22ea52c28246ff443cf945ae35b43f894f356c7d54d51a9c302d1d5442';
const LIMIT = 1024 * 1024;

function latestMobile(dbPath, runDir) {
  recoveryGate(dbPath, runDir, 'present');
  const record = JSON.parse(
    fs.readFileSync(path.join(runDir, 'mobile-login-skey-response.json')),
  );
  const marker = JSON.parse(
    fs.readFileSync(path.join(runDir, 'mobile-login-skey-attempt.json')),
  );
  const recovery = JSON.parse(
    fs.readFileSync(path.join(runDir, 'mobile-refresh-recovery.json')),
  );
  if (
    record.formatVersion !== 1 ||
    record.kind !== 'mobile-login-skey-field-response' ||
    record.httpStatus !== 200 ||
    record.decision !== 'skey_candidate_identity_matched' ||
    record.bodyTruncated ||
    record.bodyReadError ||
    marker.kind !== 'mobile-login-skey-field-once' ||
    Date.now() - Date.parse(record.capturedAt) > 24 * 3600000 ||
    !Number.isFinite(Date.parse(record.capturedAt)) ||
    JSON.stringify(record.priorMobile) !==
      JSON.stringify(recovery.proposedMobile)
  )
    throw Error('latest_login_gate');
  const body = JSON.parse(record.responseBody);
  if (
    String(body.vid) !== record.priorMobile.vid ||
    body.errCode ||
    typeof body.accessToken !== 'string' ||
    !/^[\x21-\x7e]+$/.test(body.accessToken)
  )
    throw Error('latest_identity_gate');
  return { vid: String(body.vid), accessToken: body.accessToken };
}

function requestOnce(name, mobile) {
  const url = new URL('https://i.weread.qq.com/store/search');
  // Exact fixed resource defaults plus the documented article scope. No date,
  // article title, known URL, account ID or speculative filter is sent.
  url.search = new URLSearchParams({
    keyword: name,
    scope: '4',
    count: '20',
    maxIdx: '0',
  }).toString();
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'GET',
        agent: false,
        signal: AbortSignal.timeout(15000),
        maxHeaderSize: 16384,
        headers: {
          ...VERSION_HEADERS,
          vid: mobile.vid,
          accessToken: mobile.accessToken,
        },
      },
      resolve,
    );
    req.once('error', reject);
    req.end();
  });
}

async function observe(name, mobile, request = requestOnce) {
  const result = {
    kind: 'direct-mobile-account-article-search',
    requestCount: 1,
    endpoint: '/store/search',
    scope: 4,
    articleRequests: 0,
    productionWrites: 0,
  };
  let response;
  try {
    response = await request(name, mobile);
    result.http = response.statusCode;
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response) {
      bytes += chunk.length;
      if (bytes > LIMIT) {
        response.destroy();
        return { result: { ...result, decision: 'stop_body_limit' } };
      }
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { result: { ...result, decision: hint(text) ?? 'stop_non_json' } };
    }
    result.businessCode = numericCode(
      data?.errCode ?? data?.errcode ?? data?.ret,
    );
    const risk = hint(data?.errMsg ?? data?.errmsg ?? data?.msg);
    if (risk) return { result: { ...result, decision: risk } };
    if (result.http !== 200)
      return { result: { ...result, decision: statusStop(result.http) } };
    if (!data || typeof data !== 'object' || Array.isArray(data))
      return { result: { ...result, decision: 'stop_response_shape' } };
    if (
      ['errCode', 'errcode', 'ret'].some(
        (k) => Object.hasOwn(data, k) && numericCode(data[k]) !== 0,
      )
    )
      return { result: { ...result, decision: 'stop_business_error' } };
    result.topLevelFields = Object.keys(data).filter((k) =>
      /^[A-Za-z_]{1,40}$/.test(k),
    );
    result.booksCount = Array.isArray(data.books) ? data.books.length : null;
    result.partsCount = Array.isArray(data.parts) ? data.parts.length : null;
    result.decision = 'mobile_search_response_preserved';
    return { result, data };
  } catch {
    return { result: { ...result, decision: 'stop_transport' } };
  } finally {
    response?.destroy();
  }
}

async function selfTest() {
  const { Readable } = require('node:stream');
  let calls = 0;
  const fake = (data) => async () => {
    calls++;
    return Object.assign(Readable.from([Buffer.from(JSON.stringify(data))]), {
      statusCode: 200,
    });
  };
  assert.equal(
    (await observe('account', {}, fake({ errCode: -2012 }))).result.decision,
    'stop_business_error',
  );
  assert.equal(calls, 1);
  assert.equal(
    (await observe('account', {}, fake({ errCode: -2041, errMsg: '验证码' })))
      .result.decision,
    'stop_verification',
  );
  assert.equal(calls, 2);
  assert.equal(
    (await observe('account', {}, fake({ books: [], parts: [] }))).result
      .decision,
    'mobile_search_response_preserved',
  );
  console.log(
    JSON.stringify({ decision: 'self_test_passed', realNetworkRequests: 0 }),
  );
}

async function main() {
  if (process.argv.length === 3 && process.argv[2] === '--self-test')
    return selfTest();
  const a = process.argv.slice(2);
  const fields = ['--db', '--run-dir', '--evidence-dir', '--config'];
  if (
    !['--preflight', '--execute'].includes(a[0]) ||
    a.length !== 9 ||
    fields.some((f, i) => a[1 + 2 * i] !== f || !path.isAbsolute(a[2 + 2 * i]))
  )
    throw Error('usage_gate');
  const [dbPath, runDir, evidenceDir, configFile] = fields.map(
    (_, i) => a[2 + 2 * i],
  );
  environmentGate(process.env);
  safePrivateRoot(evidenceDir);
  const config = JSON.parse(fs.readFileSync(configFile));
  if (
    Object.keys(config).sort().join(',') !== 'biz,name' ||
    typeof config.name !== 'string' ||
    !config.name.trim() ||
    config.name.length > 100
  )
    throw Error('config_gate');
  const source = fs.readFileSync(
    path.join(evidenceDir, 'mobile-source/src__api__resources__search.ts'),
  );
  if (createHash('sha256').update(source).digest('hex') !== SOURCE)
    throw Error('source_gate');
  const mobile = latestMobile(dbPath, runDir);
  const before = snapshot(dbPath);
  if (
    fs.existsSync(path.join(evidenceDir, MARKER)) ||
    fs.existsSync(path.join(evidenceDir, MARKER + '.pending'))
  )
    throw Error('already_attempted');
  if (a[0] === '--preflight')
    return console.log(
      JSON.stringify({
        decision: 'preflight_ready',
        requestCount: 0,
        credentialSource: 'later_normal_mobile_login_accessToken',
        sourceSha256: SOURCE,
        production: before,
      }),
    );
  durable(path.join(evidenceDir, MARKER), {
    kind: 'direct-mobile-account-article-search',
    attemptedAt: new Date().toISOString(),
    endpoint: '/store/search',
    requestMax: 1,
    credentialSource: 'later_normal_mobile_login_accessToken',
    sourceSha256: SOURCE,
  });
  const { result, data } = await observe(config.name, mobile);
  result.capturedAt = new Date().toISOString();
  if (data)
    durable(path.join(evidenceDir, 'mobile-search-response.json'), data);
  result.productionUnchanged =
    JSON.stringify(before) === JSON.stringify(snapshot(dbPath));
  durable(path.join(evidenceDir, 'mobile-search-result.json'), result);
  console.log(JSON.stringify(result));
  if (
    result.decision !== 'mobile_search_response_preserved' ||
    !result.productionUnchanged
  )
    process.exitCode = 1;
}
if (require.main === module)
  main().catch(() => {
    console.log(JSON.stringify({ decision: 'preflight_or_local_gate_failed' }));
    process.exitCode = 1;
  });
module.exports = { observe, latestMobile };
