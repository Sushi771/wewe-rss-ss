'use strict';

// Official EInk 2.1.2 classes3 StoryFeedService.syncSubscribedMP first reads
// getFeedTags(default type=1), selects items.id=103, and derives id/type/channel
// from its weread:// schema. This isolated probe performs only one explicit
// stage at a time. Returned reviewId prefixes are candidates, not verified
// publisher/article identities, publication times, or article bodies.
// No SQLite calls, SDK refresh, QR, pagination, retry, image or product writes.
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
const OWNER_ROOT = path.join(DISCOVERY_ROOT, 'sdk-login-owner-07');
const TAGS_URL = 'https://i.weread.qq.com/storyfeed/tags?type=1';
const FEED_ENDPOINT = 'https://i.weread.qq.com/storyfeed/getCardArticles';
const MAX_BYTES = 2 * 1024 * 1024;
const PATHS = {
  session: path.join(OWNER_ROOT, 'mobile-session.json'),
  loginResult: path.join(OWNER_ROOT, 'result.json'),
  cache: path.join(DISCOVERY_ROOT, 'sdk-cache'),
  tagsMarker: path.join(
    DISCOVERY_ROOT,
    'subscribed-mp-tags-owner07-attempt.json',
  ),
  feedMarker: path.join(
    DISCOVERY_ROOT,
    'subscribed-mp-feed-owner07-attempt.json',
  ),
  tagsOutput: path.join(OWNER_ROOT, 'subscribed-mp-tags'),
  feedOutput: path.join(OWNER_ROOT, 'subscribed-mp-feed'),
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

// WebViewUrlParamsParser.Companion.parseParameters stores raw substrings and
// overwrites duplicate keys. It does not turn '+' into a space or decode '%'.
function rawQuery(query) {
  const values = new Map();
  for (const part of query.split('&')) {
    const equal = part.indexOf('=');
    if (equal >= 0) values.set(part.slice(0, equal), part.slice(equal + 1));
  }
  return values;
}
function querySegment(value) {
  return value.split('?')[1] || '';
}
function parseInt32(value, fallback) {
  if (value === undefined) return fallback;
  if (!/^[+-]?\d+$/.test(value)) throw Error('invalid_schema_integer');
  const number = Number(value);
  if (
    !Number.isSafeInteger(number) ||
    number < -2147483648 ||
    number > 2147483647
  ) {
    throw Error('invalid_schema_integer');
  }
  return number;
}
function deriveFeedParameters(schema) {
  if (
    typeof schema !== 'string' ||
    schema.length > 65536 ||
    !schema.startsWith('weread://')
  ) {
    throw Error('invalid_tag_schema');
  }
  const outer = rawQuery(querySegment(schema.slice('weread://'.length)));
  // WRScheme.getQueryParameter invokes Android Uri.decode exactly once. Only
  // extract query data; neither this nested URL nor its host is ever requested.
  const nested = decodeURIComponent(outer.get('url') || '');
  const inner = rawQuery(querySegment(nested));
  const id = inner.has('id') ? inner.get('id') : '0';
  if (id.length > 200 || /[\x00-\x20\x7f]/.test(id))
    throw Error('invalid_schema_id');
  return {
    id,
    type: parseInt32(inner.get('type'), 0),
    channel: parseInt32(inner.get('channel'), 901301),
    count: 20,
  };
}
function parseTags(data) {
  if (!data || !Array.isArray(data.items)) throw Error('missing_items_array');
  const tag = data.items.find(
    (item) => item && typeof item === 'object' && item.id === 103,
  );
  if (!tag) return { tagCount: data.items.length, tag103: null, params: null };
  return {
    tagCount: data.items.length,
    tag103: tag,
    params: deriveFeedParameters(tag.schema),
  };
}
function buildFeedUrl(params) {
  const url = new URL(FEED_ENDPOINT);
  for (const key of ['id', 'type', 'channel', 'count'])
    url.searchParams.set(key, String(params[key]));
  return url.toString();
}
function classifyUpstream(status, data) {
  if (status === 401 || status === 403) return ['auth_stop', `HTTP_${status}`];
  if (status === 429) return ['limit_stop', 'HTTP_429'];
  if (status !== 200) return ['upstream_stop', `HTTP_${status}`];
  if (!data || typeof data !== 'object' || Array.isArray(data))
    return ['shape_stop', 'INVALID_JSON_OBJECT'];
  const code = data.errCode ?? data.errcode ?? data.code;
  if (code !== undefined) {
    if (typeof code !== 'number' || !Number.isFinite(code))
      return ['shape_stop', 'INVALID_CODE_TYPE'];
    if (code === -2012 || code === -2013)
      return ['auth_stop', `ERRCODE_${code}`];
    if (code === -2041) return ['limit_stop', 'ERRCODE_-2041'];
    if (code !== 0) return ['upstream_stop', 'UPSTREAM_NONZERO_CODE'];
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
function parseFeed(data) {
  // The saved owner-07 response uses numeric 0 on the wire despite the DEX
  // DTO's boolean field. Normalize only exact 0/1 and actual booleans.
  const hasMore =
    typeof data.hasMore === 'boolean'
      ? data.hasMore
      : data.hasMore === 0 || data.hasMore === 1
        ? data.hasMore === 1
        : null;
  if (!Array.isArray(data.articles) || hasMore === null)
    throw Error('invalid_feed_shape');
  if (data.kkOffset !== undefined && !Number.isInteger(data.kkOffset))
    throw Error('invalid_cursor_shape');
  if (data.kkSearchId !== undefined && typeof data.kkSearchId !== 'string')
    throw Error('invalid_cursor_shape');
  const seen = new Set();
  const first5 = [];
  for (const item of data.articles) {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      typeof item.reviewId !== 'string' ||
      !item.reviewId ||
      item.reviewId.length > 200 ||
      /[\x00-\x20\x7f]/.test(item.reviewId) ||
      typeof item.title !== 'string' ||
      (item.author !== undefined && typeof item.author !== 'string') ||
      (item.pic_url !== undefined && typeof item.pic_url !== 'string')
    ) {
      throw Error('invalid_candidate_shape');
    }
    if (
      !item.reviewId.startsWith(`${TARGET_BOOK_ID}_`) ||
      seen.has(item.reviewId)
    )
      continue;
    seen.add(item.reviewId);
    if (first5.length < 5)
      first5.push({
        reviewId: item.reviewId,
        title: item.title
          .slice(0, 500)
          .replace(/[\x00-\x1f\x7f]/g, '')
          .trim(),
      });
  }
  return {
    total: data.articles.length,
    targetPrefixCandidateCount: seen.size,
    first5,
    hasMore,
    cursorPresence:
      data.kkOffset !== undefined || data.kkSearchId !== undefined,
  };
}
function context(options) {
  const paths = { ...PATHS, ...options.paths };
  const rootDir = options.rootDir || PRIVATE_ROOT;
  for (const value of Object.values(paths)) assertSafePath(value, rootDir);
  const result = readJson(paths.loginResult);
  const session = validateCredentials(readJson(paths.session), result);
  if (result.productionUnchanged !== true)
    throw Error('login_source_not_verified');
  const profile = options.profile || loadProfile(ROOT, paths.cache);
  if (!profile || typeof profile.authHeaders !== 'function')
    throw Error('invalid_profile');
  return {
    paths,
    session,
    headers: buildHeaders(profile, session.mobile),
    binding: digest(`${session.accountId}:${session.mobile.accessToken}`),
  };
}
function savedTagParameters(ctx) {
  const { paths, binding } = ctx;
  for (const name of ['raw-response.bin', 'evidence.json', 'summary.json']) {
    assertSafePath(path.join(paths.tagsOutput, name), paths.tagsOutput);
  }
  const marker = readJson(paths.tagsMarker);
  const evidence = readJson(path.join(paths.tagsOutput, 'evidence.json'));
  const summary = readJson(path.join(paths.tagsOutput, 'summary.json'));
  const raw = fs.readFileSync(path.join(paths.tagsOutput, 'raw-response.bin'));
  if (
    marker.phase !== 'tags' ||
    marker.endpoint !== TAGS_URL ||
    marker.sessionBinding !== binding ||
    evidence.phase !== 'tags' ||
    evidence.httpStatus !== 200 ||
    evidence.requests !== 1 ||
    evidence.sessionBinding !== binding ||
    evidence.responseSha256 !== digest(raw) ||
    summary.phase !== 'tags' ||
    summary.status !== 'success' ||
    summary.requests !== 1
  ) {
    throw Error('tags_evidence_mismatch');
  }
  const data = JSON.parse(raw.toString('utf8'));
  if (classifyUpstream(200, data)) throw Error('tags_upstream_stop');
  const parsed = parseTags(data);
  if (!parsed.tag103) throw Error('missing_tag103');
  return parsed.params;
}
async function runPreflight(options = {}) {
  const ctx = context(options);
  let feedReady = false;
  try {
    savedTagParameters(ctx);
    feedReady = true;
  } catch {
    /* Zero-network readiness only. */
  }
  return {
    status: 'preflight_ok',
    requests: 0,
    markerWritten: false,
    credentialValid: true,
    profileValid: true,
    tagsReady:
      !fs.existsSync(ctx.paths.tagsMarker) &&
      !fs.existsSync(ctx.paths.tagsOutput),
    feedReady:
      feedReady &&
      !fs.existsSync(ctx.paths.feedMarker) &&
      !fs.existsSync(ctx.paths.feedOutput),
    ...unverified,
  };
}
async function runStage(phase, options = {}) {
  if (!['tags', 'feed'].includes(phase) || options.approvedOnline !== true) {
    return stop(phase, 'local_gate_stop', 'EXPLICIT_STAGE_APPROVAL_REQUIRED');
  }
  const paths = { ...PATHS, ...options.paths };
  const rootDir = options.rootDir || PRIVATE_ROOT;
  for (const value of Object.values(paths)) assertSafePath(value, rootDir);
  const marker = paths[`${phase}Marker`];
  const output = paths[`${phase}Output`];
  if (fs.existsSync(marker))
    return stop(phase, 'marker_exists_stop', 'MARKER_EXISTS');
  if (fs.existsSync(output))
    return stop(phase, 'local_gate_stop', 'OUTPUT_EXISTS');
  let ctx, params;
  try {
    ctx = context(options);
    params = phase === 'tags' ? { type: 1 } : savedTagParameters(ctx);
  } catch {
    return stop(
      phase,
      'local_gate_stop',
      phase === 'feed' ? 'SAVED_TAG103_REQUIRED' : 'INVALID_LOCAL_SOURCE',
    );
  }
  const url = phase === 'tags' ? TAGS_URL : buildFeedUrl(params);
  try {
    publish(marker, {
      kind: 'official-eink-subscribed-mp-once',
      phase,
      endpoint: phase === 'tags' ? TAGS_URL : FEED_ENDPOINT,
      attemptedAt: new Date().toISOString(),
      sessionBinding: ctx.binding,
    });
  } catch (error) {
    if (error.code === 'EEXIST')
      return stop(phase, 'marker_exists_stop', 'MARKER_EXISTS');
    throw error;
  }
  fs.mkdirSync(output, { mode: 0o700 });
  publish(path.join(output, 'request-params.json'), params);
  let status = 0,
    raw = Buffer.alloc(0),
    bodyComplete = false,
    result;
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
  fs.writeFileSync(path.join(output, 'raw-response.bin'), raw, {
    flag: 'wx',
    mode: 0o600,
  });
  publish(path.join(output, 'evidence.json'), {
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
    if (rejected) result = stop(phase, ...rejected, 1);
    else {
      try {
        if (phase === 'tags') {
          const parsed = parseTags(data);
          result = {
            ...stop(
              phase,
              parsed.tag103 ? 'success' : 'tags_missing_stop',
              parsed.tag103 ? 'TAG103_READY' : 'MISSING_TAG103',
              1,
            ),
            tagCount: parsed.tagCount,
            tag103Found: Boolean(parsed.tag103),
          };
        } else {
          result = {
            ...stop(phase, 'success', 'PREFIX_CANDIDATES_ONLY', 1),
            ...parseFeed(data),
          };
        }
      } catch {
        result = stop(phase, 'shape_stop', 'INVALID_STAGE_DTO', 1);
      }
    }
  }
  const summary = {
    ...result,
    httpStatus: status,
    bytesReceived: raw.length,
    responseBodyComplete: bodyComplete,
  };
  publish(path.join(output, 'summary.json'), summary);
  return summary;
}

async function main() {
  const args = process.argv.slice(2);
  const preflight = args.length === 1 && args[0] === '--preflight';
  const phase =
    args.length === 2 &&
    args[1] === '--approved-online' &&
    ['--tags', '--feed'].includes(args[0])
      ? args[0].slice(2)
      : null;
  if (!preflight && !phase) throw Error('usage');
  environmentGate(process.env);
  const result = preflight
    ? await runPreflight()
    : await runStage(phase, { approvedOnline: true });
  console.log(JSON.stringify(result));
}
if (require.main === module)
  main().catch(() => {
    console.log(
      JSON.stringify(
        stop('local', 'local_gate_stop', 'LOCAL_PREFLIGHT_FAILED'),
      ),
    );
    process.exitCode = 1;
  });
module.exports = {
  PATHS,
  TAGS_URL,
  FEED_ENDPOINT,
  MAX_BYTES,
  rawQuery,
  deriveFeedParameters,
  parseTags,
  buildFeedUrl,
  classifyUpstream,
  parseFeed,
  runPreflight,
  runStage,
};
