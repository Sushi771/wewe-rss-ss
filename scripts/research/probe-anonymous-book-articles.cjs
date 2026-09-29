#!/usr/bin/env node
'use strict';

// One anonymous request matching the old extension's first-page URL shape.
// Keep the response in memory and emit only bounded structural evidence.
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const BOOK_ID = 'MP_WXS_3895431412';
const URL_TEXT = `https://i.weread.qq.com/book/articles?bookId=${BOOK_ID}&count=10&offset=0`;
const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 12000;
const MARKER = path.join(
  os.tmpdir(),
  `wewe-anon-book-articles-${crypto.createHash('sha256').update(URL_TEXT).digest('hex').slice(0, 16)}.attempted`,
);

function integer(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d{1,9}$/.test(value))
    return Number(value);
  return null;
}

function classify(status, type, body) {
  const result = { http: status, type, decision: 'stop_unknown' };
  if (status >= 300 && status < 400)
    return { ...result, decision: 'stop_redirect' };
  if (status === 401 || status === 403)
    return { ...result, decision: 'stop_authentication_rejected' };
  if (status === 429) return { ...result, decision: 'stop_rate_limit' };
  if (!body) return { ...result, decision: 'stop_empty_body' };
  if (
    /验证码|captcha|人机验证|安全验证|请完成验证|请求频繁|访问频繁/i.test(body)
  )
    return { ...result, decision: 'stop_verification_or_limit' };
  if (status !== 200) return { ...result, decision: 'stop_http_status' };
  if (type !== 'json') return { ...result, decision: 'stop_non_json' };
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return { ...result, decision: 'stop_invalid_json' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    return { ...result, decision: 'stop_response_shape' };
  const code = integer(data.errCode);
  result.hasErrCode = Object.hasOwn(data, 'errCode');
  result.errCode = code;
  if (result.hasErrCode && code === null)
    return { ...result, decision: 'stop_uninterpretable_code' };
  if (code === -2012)
    return { ...result, decision: 'stop_auth_expired_candidate' };
  if (code === -2010)
    return { ...result, decision: 'stop_business_code_minus_2010' };
  if (code !== null && code !== 0)
    return { ...result, decision: 'stop_business_error' };
  result.hasReviews = Array.isArray(data.reviews);
  result.reviewCount = result.hasReviews ? data.reviews.length : 0;
  result.hasSyncKey = Object.hasOwn(data, 'synckey');
  if (!result.hasReviews)
    return { ...result, decision: 'stop_no_reviews_array' };
  result.reviewObjectCount = data.reviews.filter(
    (item) => item && typeof item === 'object' && !Array.isArray(item),
  ).length;
  result.reviewIdentityFieldCount = data.reviews.filter((item) =>
    Boolean(item?.review?.reviewId || item?.review?.review_id),
  ).length;
  result.mpInfoFieldCount = data.reviews.filter((item) =>
    Boolean(item?.review?.mpInfo && typeof item.review.mpInfo === 'object'),
  ).length;
  return { ...result, decision: 'first_page_shape_observed' };
}

function requestOnce() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const req = https.request(
      URL_TEXT,
      {
        method: 'GET',
        timeout: TIMEOUT_MS,
        headers: {
          Accept: '*/*',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        },
      },
      (res) => {
        const status = res.statusCode || 0;
        const rawType = String(res.headers['content-type'] || '');
        const type = /\bjson\b/i.test(rawType)
          ? 'json'
          : /\bhtml\b/i.test(rawType)
            ? 'html'
            : 'other_or_missing';
        let size = 0;
        const chunks = [];
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            req.destroy();
            finish({ http: status, type, decision: 'stop_body_limit' });
          } else chunks.push(chunk);
        });
        res.on('end', () =>
          finish(
            classify(status, type, Buffer.concat(chunks).toString('utf8')),
          ),
        );
        res.on('error', () =>
          finish({ http: status, type, decision: 'stop_transport' }),
        );
      },
    );
    req.on('timeout', () => {
      req.destroy();
      finish({ decision: 'stop_timeout' });
    });
    req.on('error', () => finish({ decision: 'stop_transport' }));
    req.end();
  });
}

function selfTest() {
  const valid = classify(
    200,
    'json',
    JSON.stringify({
      reviews: [{ review: { reviewId: 'SECRET_REVIEW', mpInfo: {} } }],
      synckey: 1,
    }),
  );
  const expired = classify(200, 'json', JSON.stringify({ errCode: -2012 }));
  const redirect = classify(302, 'html', '<html>moved</html>');
  const verify = classify(200, 'html', '<html>请完成验证</html>');
  const absent = classify(200, 'json', '{}');
  if (
    valid.decision !== 'first_page_shape_observed' ||
    valid.reviewCount !== 1 ||
    expired.decision !== 'stop_auth_expired_candidate' ||
    redirect.decision !== 'stop_redirect' ||
    verify.decision !== 'stop_verification_or_limit' ||
    absent.decision !== 'stop_no_reviews_array' ||
    JSON.stringify(valid).includes('SECRET_REVIEW')
  )
    throw Error('self_test');
  return { selfTest: 'passed', cases: 5, networkRequests: 0 };
}

async function main() {
  const [mode, approval] = process.argv.slice(2);
  if (mode === '--plan' && !approval)
    return {
      decision: 'offline_plan',
      endpoint: '/book/articles',
      credentialSource: 'none',
      requestMax: 1,
      redirects: false,
      retries: false,
      timeoutMs: TIMEOUT_MS,
      bodyLimitBytes: MAX_BYTES,
      attempted: fs.existsSync(MARKER),
    };
  if (mode === '--self-test' && !approval) return selfTest();
  if (mode !== '--execute' || approval !== '--approved-online')
    return { decision: 'stop_usage', requestCount: 0 };
  if (
    [
      'NODE_USE_ENV_PROXY',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'DEBUG',
      'NODE_DEBUG',
    ].some((name) => Boolean(process.env[name]))
  )
    return { decision: 'stop_unsafe_environment', requestCount: 0 };
  try {
    const fd = fs.openSync(MARKER, 'wx');
    try {
      fs.writeSync(fd, 'attempted\n');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return {
      decision: 'stop_already_attempted_or_marker_error',
      requestCount: 0,
    };
  }
  return { requestCount: 1, ...(await requestOnce()) };
}

main()
  .then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.decision?.startsWith('stop_') || result.selfTest === 'failed')
      process.exitCode = 1;
  })
  .catch(() => {
    process.stdout.write('{"decision":"stop_unexpected"}\n');
    process.exitCode = 1;
  });
