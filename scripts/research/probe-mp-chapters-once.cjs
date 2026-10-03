'use strict';

// Official EInk 2.1.2 ds MpService.syncChapters -> MpRemoteService.syncChapters
// EInk StoryDetail UI still uses the separate legacy MPListService path.
// URLBuilder: GET https://i.weread.qq.com/mp/chapters?bookId={bookId}&count={count}
// Source parameter chain:
//   MpService.syncChapters(bookId: String) calls
//   MpRemoteService.INSTANCE.syncChapters(bookId, count=50) [classes10.dex: const/16 v3, 50].
//   Ktor URLBuilder: /mp/chapters, addParam("bookId", bookId), addParam("count", count).
//   This method does not explicitly add synckey or offset. The official sync-client
//   GET pipeline can append synckey from local SyncKeyService state, including 0.
//   The existing probe below does not reproduce that pipeline; it is not a complete
//   wire-contract replica and has no account-local sync-state store.
//   This correction does not authorize changing parameters or retrying stopped calls.
// Response DTO: MpChapterList { data: List<MpChapterItem>, synckey: Long, clearAll: Boolean }
// MpChapterItem { reviewId: String, createTime: Long, mpInfo: SimpleMpInfo { title, picUrl, payType } }
// Strictly bound to owner-09-reader-scope session with verified raw mps=1.
// No production SQLite writes, no automatic retries, bounded body, timeout, no redirects.

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const {
  TARGET_BOOK_ID,
  assertSafePath,
  validateCredentials,
  loadProfile,
  buildHeaders,
} = require('./discovery-eink-storyfeed.cjs');
const {
  boundedBody,
  publish,
} = require('./probe-owner-review-single-once.cjs');
const { environmentGate } = require('./probe-refreshed-mobile-web-health.cjs');

const ROOT = path.resolve(__dirname, '../..');
const PRIVATE_ROOT = path.join(ROOT, 'private-data');
const DISCOVERY_ROOT = path.join(PRIVATE_ROOT, 'list-discovery-20261002');
const OWNER09_ROOT = path.join(
  DISCOVERY_ROOT,
  'sdk-login-owner-09-reader-scope',
);
const OWNER07_ROOT = path.join(DISCOVERY_ROOT, 'sdk-login-owner-07');
const CHAPTERS_ENDPOINT = 'https://i.weread.qq.com/mp/chapters';
const MAX_BYTES = 2 * 1024 * 1024; // 2 MiB
const OFFICIAL_READER_SCOPE = 'snsapi_userinfo,snsapi_friend,snsapi_favorites';

const PATHS = {
  session: path.join(OWNER09_ROOT, 'mobile-session.json'),
  loginResult: path.join(OWNER09_ROOT, 'result.json'),
  loginAttempt: path.join(OWNER09_ROOT, 'attempt.json'),
  scopeEvidence: path.join(OWNER09_ROOT, 'mp-scope', 'evidence.json'),
  scopeSummary: path.join(OWNER09_ROOT, 'mp-scope', 'summary.json'),
  scopeRaw: path.join(OWNER09_ROOT, 'mp-scope', 'raw-response.bin'),
  baselineSession: path.join(OWNER07_ROOT, 'mobile-session.json'),
  baselineResult: path.join(OWNER07_ROOT, 'result.json'),
  cache: path.join(DISCOVERY_ROOT, 'sdk-cache'),
  chaptersMarker: path.join(DISCOVERY_ROOT, 'mp-chapters-owner09-attempt.json'),
  chaptersOutput: path.join(OWNER09_ROOT, 'mp-chapters'),
};

const digest = (value) => createHash('sha256').update(value).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

const unverified = {
  publicationVerified: false,
  bodyVerified: false,
  subscriptionRecovered: false,
  productionWrites: 0,
};

function stop(phase, status, reason, requests = 0) {
  return { phase, status, reason, requests, ...unverified };
}

function sanitizeLocalReason(err) {
  const msg = err && err.message ? String(err.message) : '';
  if (msg.includes('environment_gate')) return 'ENVIRONMENT_GATE_BLOCKED';
  if (msg.includes('invalid_book_id')) return 'INVALID_BOOK_ID';
  if (msg.includes('count_out_of_range')) return 'COUNT_OUT_OF_RANGE_1_TO_5';
  if (msg.includes('offset_not_permitted')) return 'FIRST_PAGE_ONLY_NO_OFFSET';
  if (msg.includes('scope_evidence_missing')) return 'SCOPE_EVIDENCE_MISSING';
  if (msg.includes('scope_evidence_mismatch')) return 'SCOPE_EVIDENCE_MISMATCH';
  if (msg.includes('scope_hash_mismatch')) return 'SCOPE_HASH_MISMATCH';
  if (msg.includes('mp_scope_not_granted')) return 'MP_SCOPE_NOT_GRANTED';
  if (msg.includes('attempt_scope_')) return 'ATTEMPT_SCOPE_MISMATCH';
  if (msg.includes('requested_scope_mismatch'))
    return 'REQUESTED_SCOPE_MISMATCH';
  if (msg.includes('baseline_missing')) return 'BASELINE_MISSING';
  if (msg.includes('baseline_result_not_verified'))
    return 'BASELINE_RESULT_NOT_VERIFIED';
  if (msg.includes('baseline_account_mismatch'))
    return 'BASELINE_ACCOUNT_MISMATCH';
  if (msg.includes('baseline_vid_mismatch')) return 'BASELINE_VID_MISMATCH';
  if (msg.includes('baseline_device_mismatch'))
    return 'BASELINE_DEVICE_MISMATCH';
  if (msg.includes('baseline_token_not_new')) return 'BASELINE_TOKEN_NOT_NEW';
  if (msg.includes('baseline_captured_not_later'))
    return 'BASELINE_CAPTURED_NOT_LATER';
  if (msg.includes('login_source_not_verified'))
    return 'LOGIN_SOURCE_NOT_VERIFIED';
  if (msg.includes('escapes boundary')) return 'PATH_ESCAPE_DETECTED';
  if (msg.includes('invalid_profile')) return 'INVALID_PROFILE';
  return 'LOCAL_GATE_FAILED';
}

function buildChaptersUrl(bookId, count) {
  if (bookId !== TARGET_BOOK_ID) {
    throw Error('invalid_book_id');
  }
  if (!Number.isInteger(count) || count < 1 || count > 5) {
    throw Error('count_out_of_range');
  }
  const url = new URL(CHAPTERS_ENDPOINT);
  url.searchParams.set('bookId', bookId);
  url.searchParams.set('count', String(count));
  return url.toString();
}

function classifyUpstream(status, data) {
  if (status === 401 || status === 403) return ['auth_stop', `HTTP_${status}`];
  if (status === 429) return ['limit_stop', 'HTTP_429'];
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const code = data.errCode ?? data.errcode ?? data.code;
    if (code === -2012 || code === -2013)
      return ['auth_stop', `ERRCODE_${code}`];
    if (code === -2041) return ['limit_stop', 'ERRCODE_-2041'];
  }
  if (status !== 200) return ['upstream_stop', `HTTP_${status}`];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return ['shape_stop', 'INVALID_JSON_OBJECT'];
  }
  const code = data.errCode ?? data.errcode ?? data.code;
  if (code !== undefined) {
    if (typeof code !== 'number' || !Number.isFinite(code)) {
      return ['shape_stop', 'INVALID_CODE_TYPE'];
    }
    if (code !== 0) return ['upstream_stop', `UPSTREAM_NONZERO_CODE_${code}`];
  }
  const message = data.errMsg ?? data.errmsg ?? data.message ?? data.msg;
  if (
    typeof message === 'string' &&
    /captcha|challenge|frequency|rate.?limit|too many|频率|验证码|请完成验证|安全验证|限制|频繁|限流|限频/i.test(
      message,
    )
  ) {
    return ['limit_stop', 'CHALLENGE_OR_RATE_LIMIT'];
  }
  return null;
}

function parseChapters(data, targetBookId) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw Error('invalid_chapters_shape');
  }
  if (!Array.isArray(data.data)) {
    throw Error('missing_data_array');
  }
  const synckey =
    data.synckey !== undefined && Number.isFinite(Number(data.synckey))
      ? Number(data.synckey)
      : null;
  const clearAll =
    typeof data.clearAll === 'boolean'
      ? data.clearAll
      : data.clearAll === 0 || data.clearAll === 1
        ? data.clearAll === 1
        : null;

  const seen = new Set();
  const articles = [];
  for (const item of data.data) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw Error('invalid_chapter_item_shape');
    }
    const reviewId = item.reviewId;
    if (
      typeof reviewId !== 'string' ||
      !reviewId ||
      reviewId.length > 200 ||
      /[\x00-\x20\x7f]/.test(reviewId)
    ) {
      throw Error('invalid_review_id');
    }

    // Strict target validation: reject rows not belonging to target account
    if (!reviewId.startsWith(`${targetBookId}_`)) {
      throw Error('wrong_target_row_detected');
    }

    const createTime = item.createTime;
    if (
      typeof createTime !== 'number' ||
      !Number.isFinite(createTime) ||
      createTime <= 0
    ) {
      throw Error('invalid_create_time');
    }
    const mpInfo = item.mpInfo;
    if (!mpInfo || typeof mpInfo !== 'object' || Array.isArray(mpInfo)) {
      throw Error('invalid_mp_info_shape');
    }
    const title = mpInfo.title;
    if (typeof title !== 'string') {
      throw Error('invalid_title');
    }
    const picUrl =
      typeof mpInfo.picUrl === 'string' && mpInfo.picUrl ? mpInfo.picUrl : null;
    const payType = Number.isInteger(mpInfo.payType) ? mpInfo.payType : 0;

    if (seen.has(reviewId)) continue;
    seen.add(reviewId);

    // Notice: createTime is retained as upstreamCreateTime. It is NOT mapped to
    // publishedTime because representative review times have differed from
    // the official page ct by 1 second.
    articles.push({
      accountId: targetBookId,
      reviewId,
      title: title
        .slice(0, 500)
        .replace(/[\x00-\x1f\x7f]/g, '')
        .trim(),
      upstreamCreateTime: createTime,
      picUrl,
      payType,
    });
  }

  return {
    synckey,
    clearAll,
    totalReceived: data.data.length,
    targetArticleCount: articles.length,
    articles,
    first5: articles.slice(0, 5),
  };
}

function verifyOwner09ScopeEvidence(paths, session, binding) {
  // 1. Verify requestedScope provenance in login attempt
  if (!fs.existsSync(paths.loginAttempt)) {
    throw Error('attempt_scope_missing');
  }
  const attempt = readJson(paths.loginAttempt);
  if (attempt.requestedScope !== OFFICIAL_READER_SCOPE) {
    throw Error('attempt_scope_mismatch');
  }

  // 2. Verify requestedScope provenance in session
  if (session.requestedScope !== OFFICIAL_READER_SCOPE) {
    throw Error('requested_scope_mismatch');
  }

  // 3. Mandatory baseline proof against owner-07 session and result
  if (
    !fs.existsSync(paths.baselineSession) ||
    !fs.existsSync(paths.baselineResult)
  ) {
    throw Error('baseline_missing');
  }
  const baseline = readJson(paths.baselineSession);
  const baselineRes = readJson(paths.baselineResult);
  if (
    baselineRes.success !== true ||
    baselineRes.productionUnchanged !== true
  ) {
    throw Error('baseline_result_not_verified');
  }
  if (String(baseline.accountId) !== String(session.accountId)) {
    throw Error('baseline_account_mismatch');
  }
  if (
    !baseline.mobile ||
    !session.mobile ||
    String(baseline.mobile.vid) !== String(session.mobile.vid)
  ) {
    throw Error('baseline_vid_mismatch');
  }
  if (
    typeof baseline.mobile.deviceId !== 'string' ||
    !baseline.mobile.deviceId ||
    baseline.mobile.deviceId !== session.mobile.deviceId
  ) {
    throw Error('baseline_device_mismatch');
  }
  if (baseline.mobile.accessToken === session.mobile.accessToken) {
    throw Error('baseline_token_not_new');
  }

  const tBase = new Date(baseline.capturedAt).getTime();
  const tSession = new Date(session.capturedAt).getTime();
  if (
    !Number.isFinite(tBase) ||
    !Number.isFinite(tSession) ||
    tSession <= tBase
  ) {
    throw Error('baseline_captured_not_later');
  }

  // 3. Verify scope evidence files existence
  if (
    !fs.existsSync(paths.scopeEvidence) ||
    !fs.existsSync(paths.scopeSummary) ||
    !fs.existsSync(paths.scopeRaw)
  ) {
    throw Error('scope_evidence_missing');
  }

  // 4. Verify scope evidence binding and hash
  const evidence = readJson(paths.scopeEvidence);
  const summary = readJson(paths.scopeSummary);
  const rawBytes = fs.readFileSync(paths.scopeRaw);

  if (
    evidence.phase !== 'scope' ||
    evidence.httpStatus !== 200 ||
    evidence.requests !== 1 ||
    evidence.responseBodyComplete !== true ||
    evidence.sessionBinding !== binding
  ) {
    throw Error('scope_evidence_mismatch');
  }

  if (digest(rawBytes) !== evidence.responseSha256) {
    throw Error('scope_hash_mismatch');
  }

  if (
    summary.phase !== 'scope' ||
    summary.status !== 'success' ||
    summary.weChatMpGranted !== true
  ) {
    throw Error('mp_scope_not_granted');
  }

  // 5. Verify parsed raw response
  const rawJson = JSON.parse(rawBytes.toString('utf8'));
  if (rawJson.mps !== 1 || rawJson.fris !== 1) {
    throw Error('mp_scope_not_granted');
  }
  if (rawJson.scope !== OFFICIAL_READER_SCOPE) {
    throw Error('raw_scope_content_mismatch');
  }
}

function context(options = {}) {
  const paths = { ...PATHS, ...options.paths };
  const rootDir = options.rootDir || PRIVATE_ROOT;
  for (const value of Object.values(paths)) assertSafePath(value, rootDir);

  const result = readJson(paths.loginResult);
  const rawSession = readJson(paths.session);
  const validated = validateCredentials(rawSession, result);
  const session = { ...rawSession, ...validated };
  if (result.productionUnchanged !== true) {
    throw Error('login_source_not_verified');
  }

  const binding = digest(`${session.accountId}:${session.mobile.accessToken}`);

  // Substantive verification of owner09 reader scope and raw mps=1
  verifyOwner09ScopeEvidence(paths, session, binding);

  const profile = options.profile || loadProfile(ROOT, paths.cache);
  if (!profile || typeof profile.authHeaders !== 'function') {
    throw Error('invalid_profile');
  }

  return {
    paths,
    session,
    headers: buildHeaders(profile, session.mobile),
    binding,
  };
}

async function runPreflight(options = {}) {
  let ctx;
  try {
    environmentGate(options.env || process.env);
    ctx = context(options);
  } catch (error) {
    return {
      status: 'preflight_failed',
      reason: sanitizeLocalReason(error),
      requests: 0,
      markerWritten: false,
      credentialValid: false,
      profileValid: false,
      chaptersReady: false,
      ...unverified,
    };
  }

  const markerExists = fs.existsSync(ctx.paths.chaptersMarker);
  const outputExists = fs.existsSync(ctx.paths.chaptersOutput);

  return {
    status: 'preflight_ok',
    requests: 0,
    markerWritten: false,
    credentialValid: true,
    profileValid: true,
    chaptersReady: !markerExists && !outputExists,
    targetBookId: TARGET_BOOK_ID,
    sessionBinding: ctx.binding,
    ...unverified,
  };
}

async function runChaptersProbe(options = {}) {
  const phase = 'chapters';

  // Strict environment gate inside exported runner
  try {
    environmentGate(options.env || process.env);
  } catch (err) {
    return stop(phase, 'local_gate_stop', sanitizeLocalReason(err));
  }

  if (options.approvedOnline !== true) {
    return stop(phase, 'local_gate_stop', 'EXPLICIT_STAGE_APPROVAL_REQUIRED');
  }

  // Reject offset or unknown options
  if (options.offset !== undefined) {
    return stop(phase, 'local_gate_stop', 'FIRST_PAGE_ONLY_NO_OFFSET');
  }

  const paths = { ...PATHS, ...options.paths };
  const rootDir = options.rootDir || PRIVATE_ROOT;
  try {
    for (const value of Object.values(paths)) assertSafePath(value, rootDir);
  } catch (err) {
    return stop(phase, 'local_gate_stop', sanitizeLocalReason(err));
  }

  if (fs.existsSync(paths.chaptersMarker)) {
    return stop(phase, 'marker_exists_stop', 'MARKER_EXISTS');
  }
  if (fs.existsSync(paths.chaptersOutput)) {
    return stop(phase, 'local_gate_stop', 'OUTPUT_EXISTS');
  }

  let ctx;
  try {
    ctx = context(options);
  } catch (error) {
    return stop(phase, 'local_gate_stop', sanitizeLocalReason(error));
  }

  const count = options.count !== undefined ? options.count : 5;
  let url;
  try {
    url = buildChaptersUrl(TARGET_BOOK_ID, count);
  } catch (err) {
    return stop(phase, 'local_gate_stop', sanitizeLocalReason(err));
  }

  const requestParams = {
    bookId: TARGET_BOOK_ID,
    count,
  };

  try {
    publish(paths.chaptersMarker, {
      kind: 'official-eink-mp-chapters-once',
      phase,
      endpoint: CHAPTERS_ENDPOINT,
      url,
      params: requestParams,
      attemptedAt: new Date().toISOString(),
      sessionBinding: ctx.binding,
    });
  } catch (error) {
    if (error.code === 'EEXIST') {
      return stop(phase, 'marker_exists_stop', 'MARKER_EXISTS');
    }
    throw error;
  }

  fs.mkdirSync(paths.chaptersOutput, { mode: 0o700 });
  publish(
    path.join(paths.chaptersOutput, 'request-params.json'),
    requestParams,
  );

  let status = 0;
  let raw = Buffer.alloc(0);
  let bodyComplete = false;
  let result;

  try {
    const response = await (options.fetchFn || globalThis.fetch)(url, {
      method: 'GET',
      headers: ctx.headers,
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });
    status = response.status;
    raw = await boundedBody(response, MAX_BYTES);
    bodyComplete = true;
  } catch (error) {
    result = stop(
      phase,
      error.message === 'response_body_limit'
        ? 'response_limit_stop'
        : 'transport_stop',
      error.message === 'response_body_limit'
        ? 'RESPONSE_BODY_LIMIT'
        : 'TRANSPORT_FAILED',
      1,
    );
  }

  fs.writeFileSync(path.join(paths.chaptersOutput, 'raw-response.bin'), raw, {
    flag: 'wx',
    mode: 0o600,
  });

  publish(path.join(paths.chaptersOutput, 'evidence.json'), {
    phase,
    httpStatus: status,
    requests: 1,
    responseBodyComplete: bodyComplete,
    responseSha256: digest(raw),
    sessionBinding: ctx.binding,
  });

  if (!result) {
    let data;
    try {
      data = JSON.parse(raw.toString('utf8'));
    } catch {
      /* Classified below. */
    }
    const rejected = classifyUpstream(status, data);
    if (rejected) {
      result = stop(phase, ...rejected, 1);
    } else {
      try {
        const parsed = parseChapters(data, TARGET_BOOK_ID);
        if (parsed.articles.length === 0) {
          result = stop(phase, 'empty_list_stop', 'NO_VERIFIED_ARTICLES', 1);
        } else {
          result = {
            ...stop(phase, 'success', 'CHAPTERS_LIST_PARSED', 1),
            // Publication verified remains strictly false until true original
            // publication timestamp is proven.
            publicationVerified: false,
            ...parsed,
          };
        }
      } catch (err) {
        if (err.message === 'wrong_target_row_detected') {
          result = stop(phase, 'shape_stop', 'WRONG_TARGET_ROW_DETECTED', 1);
        } else {
          result = stop(phase, 'shape_stop', 'INVALID_CHAPTERS_DTO', 1);
        }
      }
    }
  }

  const summary = {
    ...result,
    httpStatus: status,
    bytesReceived: raw.length,
    responseBodyComplete: bodyComplete,
  };

  publish(path.join(paths.chaptersOutput, 'summary.json'), summary);
  return summary;
}

function parseCliArgs(argv) {
  if (argv.length === 1 && argv[0] === '--preflight') {
    return { mode: 'preflight' };
  }
  if (
    argv.length === 2 &&
    argv[0] === '--chapters' &&
    argv[1] === '--approved-online'
  ) {
    return { mode: 'execute', count: 5 };
  }
  if (
    argv.length === 4 &&
    argv[0] === '--chapters' &&
    argv[1] === '--approved-online' &&
    argv[2] === '--count'
  ) {
    if (!/^[1-5]$/.test(argv[3])) {
      throw Error('count_out_of_range');
    }
    return { mode: 'execute', count: parseInt(argv[3], 10) };
  }
  throw Error('usage_gate');
}

async function main() {
  const parsed = parseCliArgs(process.argv.slice(2));
  environmentGate(process.env);

  const result =
    parsed.mode === 'preflight'
      ? await runPreflight()
      : await runChaptersProbe({ approvedOnline: true, count: parsed.count });

  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.log(
      JSON.stringify(
        stop('local', 'local_gate_stop', sanitizeLocalReason(err)),
      ),
    );
    process.exitCode = 1;
  });
}

module.exports = {
  PATHS,
  CHAPTERS_ENDPOINT,
  TARGET_BOOK_ID,
  MAX_BYTES,
  OFFICIAL_READER_SCOPE,
  sanitizeLocalReason,
  buildChaptersUrl,
  classifyUpstream,
  parseChapters,
  verifyOwner09ScopeEvidence,
  parseCliArgs,
  runPreflight,
  runChaptersProbe,
};
